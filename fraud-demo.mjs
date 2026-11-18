// Deliberate fraud demo on Veil's own testnet rollup (veil-pay-1, Diana only).
//
// The operator submits batch 2 with a forged state: it moves the payer's
// remaining 750,000 uqor into a withdrawal to the operator without the payer's
// signature. The inbox entry it consumes is a public marker that qledger
// ignores, so the honest root equals the parent root. A watchtower re-executes
// the batch, finds the mismatch and challenges it; Diana then slashes the
// operator's 1,000 QOR bond (500 burned, 500 to the challenger), rejects the
// batch and rolls the inbox cursor back. Only the team's own funds are at stake.
//
//   node fraud-demo.mjs post      <operator.mnemonic> --i-accept-bond-loss
//   node fraud-demo.mjs bad-batch <operator.mnemonic> --i-accept-bond-loss --watcher-running
//   node fraud-demo.mjs challenge <watcher.mnemonic>      (fallback only)
//
// Start the watchtower before `bad-batch`. The challenge window is 1 hour;
// if the forged batch finalizes, its withdrawal becomes claimable.
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import {
  createRdkClient,
  createRdkRegistry,
  executeQledger,
  QledgerLedger,
  planQledgerBatch,
  postRollupDataMsg,
  submitBatchMsg,
  challengeBatchMsg,
  anchorSignBytesForBatch,
  buildQledgerFraudProof,
  checkQledgerFraud,
  qledgerWithdrawalsRoot,
  QLEDGER_WITHDRAWAL_COUNTER_ID,
} from '@qorechain/rdk';
import { deriveUnifiedAccount, EthNativeSigner, pqcSign } from '@qorechain/sdk';
import { StargateClient } from '@cosmjs/stargate';
import { env, chainId, rollupId, hex } from './invoice.mjs';

const [step, keyFile] = process.argv.slice(2);
assert.ok(['post', 'bad-batch', 'challenge'].includes(step), 'step: post | bad-batch | challenge');
assert.ok(keyFile && existsSync(keyFile), 'key file required');
assert.equal(chainId, 'qorechain-diana', 'testnet only');
assert.equal(rollupId, 'veil-pay-1', 'Veil demo rollup only');
if (step !== 'challenge') {
  assert.ok(process.argv.includes('--i-accept-bond-loss'), 'pass --i-accept-bond-loss');
}
if (step === 'bad-batch') {
  assert.ok(process.argv.includes('--watcher-running'), 'start the watchtower first, then pass --watcher-running');
}

const dir = 'evidence/fraud/';
mkdirSync(dir, { recursive: true });
const json = (v) => JSON.stringify(v, (_, x) => (typeof x === 'bigint' ? String(x) : x), 2) + '\n';
const save = (name, v) => writeFileSync(dir + name + '.json', json(v), { flag: 'wx' });
const load = (name) => JSON.parse(readFileSync(dir + name + '.json', 'utf8'));
const sha = (b) => createHash('sha256').update(b).digest('hex');

const account = await deriveUnifiedAccount(readFileSync(keyFile, 'utf8').trim());
const client = createRdkClient({ network: 'testnet' });
const rest = client.network.endpoints.rest;
const roll = await client.rest.getRollup(rollupId);
const inbox = await client.rest.getInbox(rollupId);
const latest = await client.rest.getLatestBatch(rollupId);
const status = {
  latestBatch: latest.batchIndex,
  latestStatus: latest.status,
  head: Number(inbox.headSequence),
  consumed: Number(inbox.consumedSequence),
};
console.log(status);

// Parent ledger after batch 1, from the transcript replayed and verified in #3.
function parentLedger() {
  const records = readFileSync('evidence/withdrawal/transcript.jsonl', 'utf8')
    .trim().split('\n').map((l) => JSON.parse(l));
  const ledger = new QledgerLedger();
  for (const r of records) {
    const entries = r.entries.map((e) => ({
      height: BigInt(e.height), poster: e.poster, payload: Buffer.from(e.payloadHex, 'hex'),
    }));
    assert.equal(hex(executeQledger(env, ledger, entries).stateRoot), r.batch.stateRoot);
  }
  assert.equal(hex(ledger.root()), latest.stateRoot, 'transcript ledger is not the chain latest');
  return ledger;
}

let message;
if (step === 'post') {
  assert.equal(roll.creator, account.cosmos);
  assert.deepEqual(
    [latest.batchIndex, latest.status, status.head, status.consumed],
    [1, 'finalized', 4, 4],
  );
  const bond = await client.rest.getSubmitterBond(rollupId, account.cosmos);
  assert.equal(String(bond.amount), '1000000000', 'expected exactly 1,000 QOR bonded');
  assert.equal(Number(bond.pending), 0);
  const marker = Buffer.from(
    'veil/fraud-demo/v1: public marker for a deliberately forged batch; qledger ignores it. ' +
      new Date().toISOString(),
  );
  message = postRollupDataMsg({ rollupId, poster: account.cosmos, data: marker });
  save('marker', { payloadUtf8: marker.toString(), sha256: sha(marker) });
} else if (step === 'bad-batch') {
  assert.equal(roll.creator, account.cosmos);
  assert.deepEqual(
    [latest.batchIndex, latest.status, status.head, status.consumed],
    [1, 'finalized', 5, 4],
  );
  const marker = load('marker');
  const ledger = parentLedger();
  const plan = await planQledgerBatch(client.rest, { ...env, submitter: account.cosmos, ledger });
  assert.equal(plan.input.batchIndex, 2n);
  assert.equal(plan.input.inboxEnd, 5n);
  assert.equal(plan.entries.length, 1);
  assert.equal(sha(plan.entries[0].payload), marker.sha256, 'entry 5 is not our marker');
  assert.equal(hex(plan.input.stateRoot), latest.stateRoot, 'marker must not change state');
  assert.equal(hex(plan.input.withdrawalsRoot), '');

  // Forge: drain the payer's L2 balance into a withdrawal to the operator.
  const forged = ledger.clone();
  const payer = ledger.accounts().find(
    (a) => hex(a.id) !== hex(QLEDGER_WITHDRAWAL_COUNTER_ID) && a.balance === 750000n,
  );
  assert.ok(payer, 'payer with 750,000 uqor not found');
  const next = forged.get(QLEDGER_WITHDRAWAL_COUNTER_ID).balance;
  forged.set(payer.id, 0n, payer.nonce);
  forged.set(QLEDGER_WITHDRAWAL_COUNTER_ID, next + 1n, 0n);
  const fakeWithdrawals = [{ index: next, recipient: account.cosmos, amount: payer.balance }];
  const input = {
    ...plan.input,
    stateRoot: forged.root(),
    withdrawalsRoot: qledgerWithdrawalsRoot(chainId, rollupId, fakeWithdrawals),
  };

  // The forgery must be provable before it is submitted.
  const { proof } = buildQledgerFraudProof(env, ledger, inbox.consumedAcc, plan.entries);
  const claim = (i) => ({
    inboxStart: 4, inboxEnd: 5, dataHash: hex(i.dataHash),
    prevStateRoot: hex(i.prevStateRoot), stateRoot: hex(i.stateRoot),
    withdrawalsRoot: hex(i.withdrawalsRoot),
  });
  assert.equal(checkQledgerFraud(env, claim(plan.input), proof), false);
  assert.equal(checkQledgerFraud(env, claim(input), proof), true);

  const anchor = anchorSignBytesForBatch({ chainId, layerId: roll.layerId, ...input });
  message = submitBatchMsg({
    ...input,
    sequencer: account.cosmos,
    anchorSignature: pqcSign(account.pqc.secretKey, anchor),
  });
  save('forgery', {
    batchIndex: 2,
    range: [4, 5],
    payerAccount: hex(payer.id),
    honest: { stateRoot: hex(plan.input.stateRoot), withdrawalsRoot: '' },
    forged: {
      stateRoot: hex(input.stateRoot),
      withdrawalsRoot: hex(input.withdrawalsRoot),
      withdrawals: fakeWithdrawals,
    },
    proofHex: hex(proof),
    proofSha256: sha(proof),
  });
} else {
  // Fallback: challenge from a separate watcher account with the saved proof.
  assert.notEqual(account.cosmos, roll.creator, 'challenge from a separate account');
  const forgery = load('forgery');
  const batch = await client.rest.getBatch(rollupId, 2);
  assert.equal(batch.status, 'submitted');
  assert.equal(batch.stateRoot, forgery.forged.stateRoot);
  message = challengeBatchMsg({
    challenger: account.cosmos, rollupId, batchIndex: 2, proof: Buffer.from(forgery.proofHex, 'hex'),
  });
}

assert.ok(!existsSync(dir + step + '.json'), step + ' already recorded');
const transport = await StargateClient.connect(client.network.endpoints.rpc);
try {
  assert.equal(await transport.getChainId(), chainId);
  const res = await fetch(rest + '/cosmos/auth/v1beta1/accounts/' + account.cosmos);
  assert.ok(res.ok);
  const auth = (await res.json()).account;
  const base = auth.base_account ?? auth;
  const signer = new EthNativeSigner(account, { rest, signMode: 'hybrid', registry: createRdkRegistry() });
  writeFileSync('.private/fraud-' + step + '.intent', new Date().toISOString(), { flag: 'wx', mode: 0o600 });
  const tx = await signer.signAndBroadcast(transport, {
    chainId,
    messages: [message],
    accountNumber: BigInt(base.account_number),
    sequence: BigInt(base.sequence),
    fee: { amount: [{ denom: 'uqor', amount: '270000' }], gas: '1800000' },
  });
  console.log({ step, hash: tx.transactionHash, height: tx.height, code: tx.code });
  assert.equal(tx.code, 0);
  save(step, { step, hash: tx.transactionHash, height: tx.height, code: tx.code, sender: account.cosmos });
} finally {
  transport.disconnect();
}
