// One-time Diana withdrawal from the payee of the genesis payment.
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import {
  createRdkClient,
  createRdkRegistry,
  fetchQledgerEntries,
  EMPTY_INBOX_ACC,
  qledgerAccumulate,
  inboxRangeHash,
  executeQledger,
  QledgerLedger,
  qledgerKeypairFromSeed,
  signQledgerTx,
  encodeQledgerTx,
  postRollupDataMsg,
  planQledgerBatch,
  submitBatchMsg,
  anchorSignBytesForBatch,
  qledgerWithdrawalProof,
  executeWithdrawalMsg,
  buildSettlementReceipt,
  verifySettlementReceipt,
} from '@qorechain/rdk';
import { deriveUnifiedAccount, EthNativeSigner, pqcSign } from '@qorechain/sdk';
import { StargateClient } from '@cosmjs/stargate';
import { env, chainId, rollupId, hex } from './invoice.mjs';

const [step, keyFile] = process.argv.slice(2);
assert.ok(['post', 'batch', 'claim'].includes(step));
const directory = 'evidence/withdrawal/';
const json = (value) =>
  JSON.stringify(value, (_, v) => (typeof v === 'bigint' ? String(v) : v), 2) +
  '\n';
const save = (name, value) =>
  writeFileSync(directory + name + '.json', json(value), { flag: 'wx' });
const account = await deriveUnifiedAccount(
  readFileSync(keyFile, 'utf8').trim(),
);
const destination = (
  await deriveUnifiedAccount(
    readFileSync('.private/withdrawal-recipient.mnemonic', 'utf8').trim(),
  )
).cosmos;
const client = createRdkClient({ network: 'testnet' });
const rest = client.network.endpoints.rest;
const parent = await client.rest.getBatch(rollupId, 0);
const roll = await client.rest.getRollup(rollupId);
assert.equal(roll.creator, account.cosmos);
assert.equal(roll.executionVm, 'qledger-v1');
assert.notEqual(destination, account.cosmos);
assert.equal(parent.status, 'finalized');
assert.deepEqual([parent.inboxStart, parent.inboxEnd], [0, 3]);
const range = { ...env, from: 0, to: 3, accFrom: EMPTY_INBOX_ACC };
const entries = await fetchQledgerEntries(client.rest, range);
const accFrom = qledgerAccumulate({ ...range, entries });
assert.equal(
  hex(inboxRangeHash({ ...range, accTo: accFrom })),
  parent.dataHash,
);
const ledger = new QledgerLedger();
assert.equal(hex(ledger.root()), parent.prevStateRoot);
assert.equal(
  hex(executeQledger(env, ledger, entries).stateRoot),
  parent.stateRoot,
);
const key = qledgerKeypairFromSeed(readFileSync('.private/payee-l2.seed'));
assert.equal(
  hex(key.accountId),
  JSON.parse(readFileSync('evidence/public-audit.json')).payee,
);
const start = ledger.get(key.accountId);
const amount = 250000n;
assert.equal(start.balance, amount);
const payload = encodeQledgerTx(
  signQledgerTx({
    ...env,
    ...key,
    nonce: start.nonce,
    amount,
    recipient: destination,
  }),
);
const inbox = await client.rest.getInbox(rollupId);
const latest = await client.rest.getLatestBatch(rollupId);
const expected = { post: [0, 3, 3], batch: [0, 4, 3], claim: [1, 4, 4] }[step];
assert.deepEqual(
  [
    latest.batchIndex,
    Number(inbox.headSequence),
    Number(inbox.consumedSequence),
  ],
  expected,
);
async function get(route) {
  const res = await fetch(rest + route);
  assert.ok(res.ok, route + ' HTTP ' + res.status);
  return res.json();
}
async function funds() {
  const data = await get(
    '/cosmos/bank/v1beta1/balances/' + destination + '/by_denom?denom=uqor',
  );
  return data.balance.amount;
}
let message;
if (step === 'post') {
  assert.equal(await funds(), '0');
  message = postRollupDataMsg({
    rollupId,
    poster: account.cosmos,
    data: payload,
  });
} else {
  const currentRange = { ...env, from: 3, to: 4, accFrom };
  const rows = await fetchQledgerEntries(client.rest, currentRange);
  assert.equal(hex(rows[0].payload), hex(payload));
  const copy = ledger.clone();
  const result = executeQledger(env, copy, rows);
  assert.deepEqual(result.withdrawals, [
    { index: 0n, recipient: destination, amount },
  ]);
  assert.equal(copy.get(key.accountId).balance, 0n);
  if (step === 'batch') {
    const plan = await planQledgerBatch(client.rest, {
      ...env,
      submitter: account.cosmos,
      ledger,
    });
    assert.equal(plan.input.batchIndex, 1n);
    assert.equal(plan.input.inboxEnd, 4n);
    assert.equal(hex(plan.input.stateRoot), hex(result.stateRoot));
    assert.equal(hex(plan.input.withdrawalsRoot), hex(result.withdrawalsRoot));
    const anchor = anchorSignBytesForBatch({
      chainId,
      layerId: roll.layerId,
      ...plan.input,
    });
    message = submitBatchMsg({
      ...plan.input,
      sequencer: account.cosmos,
      anchorSignature: pqcSign(account.pqc.secretKey, anchor),
    });
  } else {
    assert.equal(latest.status, 'finalized');
    assert.equal(latest.prevStateRoot, parent.stateRoot);
    assert.equal(latest.stateRoot, hex(result.stateRoot));
    assert.equal(latest.withdrawalsRoot, hex(result.withdrawalsRoot));
    assert.equal(
      latest.dataHash,
      hex(
        inboxRangeHash({
          ...currentRange,
          accTo: qledgerAccumulate({ ...currentRange, entries: rows }),
        }),
      ),
    );
    const receipt = await buildSettlementReceipt(client, rollupId, 1);
    const verified = await verifySettlementReceipt(receipt, { client });
    assert.ok(verified.valid && receipt.batchStateRoot === latest.stateRoot);
    const proof = qledgerWithdrawalProof(
      chainId,
      rollupId,
      result.withdrawals,
      0,
    );
    assert.deepEqual(proof, []);
    assert.equal(await funds(), '0');
    assert.equal(roll.depositPool, '1000000');
    save('receipt', receipt);
    save('before-claim', {
      destination,
      balanceUqor: '0',
      poolUqor: roll.depositPool,
      batch: latest,
      checks: verified.checks,
      proof,
    });
    message = executeWithdrawalMsg({
      rollupId,
      batchIndex: 1,
      withdrawalIndex: 0,
      submitter: account.cosmos,
      recipient: destination,
      amount,
      denom: 'uqor',
      proof,
    });
  }
}
assert.ok(!existsSync(directory + step + '.json'));
const transport = await StargateClient.connect(client.network.endpoints.rpc);
try {
  assert.equal(await transport.getChainId(), chainId);
  const { account: auth } = await get(
    '/cosmos/auth/v1beta1/accounts/' + account.cosmos,
  );
  const base = auth.base_account ?? auth;
  const signer = new EthNativeSigner(account, {
    rest,
    signMode: 'hybrid',
    registry: createRdkRegistry(),
  });
  writeFileSync(
    '.private/withdraw-' + step + '.intent',
    new Date().toISOString(),
    { flag: 'wx', mode: 0o600 },
  );
  const tx = await signer.signAndBroadcast(transport, {
    chainId,
    messages: [message],
    accountNumber: BigInt(base.account_number),
    sequence: BigInt(base.sequence),
    fee: { amount: [{ denom: 'uqor', amount: '270000' }], gas: '1800000' },
  });
  console.log({
    step,
    hash: tx.transactionHash,
    height: tx.height,
    code: tx.code,
    destination,
  });
  assert.equal(tx.code, 0);
  save(step, {
    step,
    hash: tx.transactionHash,
    height: tx.height,
    code: tx.code,
    destination,
    operator: account.cosmos,
    amountUqor: String(amount),
  });
} finally {
  transport.disconnect();
}
