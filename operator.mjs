import { readFileSync, writeFileSync, mkdirSync, renameSync } from 'node:fs';
import assert from 'node:assert/strict';
import {
  createRdkClient,
  createRdkRegistry,
  createRollupMsg,
  bondRollupSubmitterMsg,
  depositToRollupMsg,
  postRollupDataMsg,
  submitBatchMsg,
  anchorSignBytesForBatch,
  QledgerLedger,
  planQledgerBatch,
} from '@qorechain/rdk';
import {
  deriveUnifiedAccount,
  EthNativeSigner,
  fetchPqcStatus,
  isRegisteredPqcKey,
  signProofOfPossession,
  buildRegisterPqcKeyMsg,
  pqcSign,
} from '@qorechain/sdk';
import { StargateClient } from '@cosmjs/stargate';
import { env, chainId, rollupId, hex } from './invoice.mjs';

// One-shot genesis experiment. The intent file survives ambiguous broadcast outcomes.
// Reconcile any existing intent with the network before attempting that step again.
const [step, path] = process.argv.slice(2);
assert.ok(
  [
    'check',
    'register',
    'create',
    'bond',
    'deposit',
    'payment',
    'batch',
  ].includes(step),
);
const account = await deriveUnifiedAccount(readFileSync(path, 'utf8').trim());
const address = account.cosmos;
assert.equal(address, 'qor1a5j8wjpxpqc6f7htyv92042nrt7gaegpezdhx4');
const client = createRdkClient({ network: 'testnet' });
async function get(route) {
  const response = await fetch(client.network.endpoints.rest + route);
  const data = await response.json();
  if (response.status === 404 && data.code === 5) return null;
  assert.ok(response.ok, 'REST ' + response.status);
  return data;
}
const node = await get('/cosmos/base/tendermint/v1beta1/node_info');
assert.equal(node.default_node_info.network, chainId);
const balance = await get(
  '/cosmos/bank/v1beta1/balances/' + address + '/by_denom?denom=uqor',
);
const params = await client.params();
const roll = (await get('/qorechain/rdk/v1/rollup/' + rollupId))?.rollup;
console.log({
  step,
  address,
  uqor: balance.balance.amount,
  rollup: roll?.status ?? 'absent',
});
if (step === 'check') process.exit(0);
const payment = JSON.parse(readFileSync('.private/payment.json'));
assert.equal(params.minStakeForRollup, '10000000000');
assert.equal(params.minSubmitterBond, '1000000000');
const data = { rollupId };
if (step === 'create' || step === 'register') {
  assert.ok(!roll);
  assert.ok(BigInt(balance.balance.amount) >= 12002000000n);
} else {
  assert.equal(roll.creator, address);
  assert.equal(roll.status, 'active');
  assert.equal(roll.execution_vm, 'qledger-v1');
  if (step === 'bond') {
    const result = await get(
      '/qorechain/rdk/v1/submitter_bond/' + rollupId + '/' + address,
    );
    assert.equal(BigInt(result === null ? 0 : result.amount), 0n);
  }
  const inbox = await client.rest.getInbox(rollupId);
  const expectedHead = { bond: 0, deposit: 0, payment: 1, batch: 3 };
  assert.equal(Number(inbox.headSequence), expectedHead[step]);
  assert.equal(Number(inbox.consumedSequence), 0);
}
const rest = client.network.endpoints.rest;
const status = await fetchPqcStatus({ rest, address });
if (step === 'register' && status.registered) {
  assert.equal(isRegisteredPqcKey(status, account.pqc.publicKey), true);
  console.log('Existing operator key confirmed');
  process.exit(0);
}
if (step !== 'register')
  assert.equal(isRegisteredPqcKey(status, account.pqc.publicKey), true);
const actions = {
  register: () => [
    buildRegisterPqcKeyMsg(address, {
      pqcKeypair: account.pqc,
      proofOfPossession: signProofOfPossession({
        chainId,
        account: address,
        keypair: account.pqc,
      }),
    }),
  ],
  create: () => [
    createRollupMsg({
      ...data,
      creator: address,
      profile: 'nft',
      vmType: 'cosmwasm',
      stakeAmount: '10000000000',
      executionVm: 'qledger-v1',
      sequencing: 'based',
    }),
  ],
  bond: () => [
    bondRollupSubmitterMsg({
      ...data,
      submitter: address,
      amount: '1000000000',
    }),
  ],
  deposit: () => [
    depositToRollupMsg({
      ...data,
      depositor: address,
      account: Buffer.from(payment.payer, 'hex'),
      amount: '1000000',
    }),
  ],
  payment: () =>
    [payment.transfer, payment.envelope].map((value) =>
      postRollupDataMsg({
        ...data,
        poster: address,
        data: Buffer.from(value, 'hex'),
      }),
    ),
  batch: async () => {
    const plan = await planQledgerBatch(client.rest, {
      ...env,
      submitter: address,
      ledger: new QledgerLedger(),
    });
    assert.equal(plan.input.batchIndex, 0n);
    assert.equal(plan.entries.length, 3);
    assert.equal(hex(plan.entries[1].payload), payment.transfer);
    assert.equal(hex(plan.entries[2].payload), payment.envelope);
    assert.equal(
      plan.ledger.get(Buffer.from(payment.payer, 'hex')).balance,
      750000n,
    );
    const message = anchorSignBytesForBatch({
      chainId,
      layerId: roll.layer_id,
      ...plan.input,
    });
    return [
      submitBatchMsg({
        ...plan.input,
        sequencer: address,
        anchorSignature: pqcSign(account.pqc.secretKey, message),
      }),
    ];
  },
};
const messages = await actions[step]();
const signer = new EthNativeSigner(account, {
  rest,
  signMode: step === 'register' ? 'classical' : 'hybrid',
  registry: step === 'register' ? undefined : createRdkRegistry(),
});
const transport = await StargateClient.connect(client.network.endpoints.rpc);
assert.equal(await transport.getChainId(), chainId);
const auth = (await get('/cosmos/auth/v1beta1/accounts/' + address)).account;
const { account_number: accountNumber, sequence } = auth.base_account ?? auth;
assert.ok(accountNumber && sequence);
mkdirSync('evidence', { recursive: true });
const intent = '.private/' + step + '.intent';
writeFileSync(intent, new Date().toISOString(), { flag: 'wx', mode: 0o600 });
const result = await signer.signAndBroadcast(transport, {
  chainId,
  messages,
  accountNumber: BigInt(accountNumber),
  sequence: BigInt(sequence),
  fee: { amount: [{ denom: 'uqor', amount: '270000' }], gas: '1800000' },
});
transport.disconnect();
const record = {
  step,
  chainId,
  rollupId,
  hash: result.transactionHash,
  height: result.height,
  code: result.code,
};
console.log(record);
assert.equal(
  result.code,
  0,
  'Transaction refused. Check its hash before retrying.',
);
writeFileSync(
  'evidence/' + step + '.json',
  JSON.stringify(record, null, 2) + '\n',
  { flag: 'wx' },
);
renameSync(intent, intent + '.done');
