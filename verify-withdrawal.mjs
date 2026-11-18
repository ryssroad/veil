// Read-only verification against Diana. Balances are read at the two block
// heights bordering the successful claim, so later account activity is harmless.
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { createRdkClient, verifySettlementReceipt } from '@qorechain/rdk';
import { chainId, rollupId } from './invoice.mjs';

const dir = 'evidence/withdrawal/';
const claim = JSON.parse(readFileSync(dir + 'claim.json'));
const receipt = JSON.parse(readFileSync(dir + 'receipt.json'));
const { destination, operator, hash, height } = claim;
const client = createRdkClient({ network: 'testnet' });
async function read(path, at) {
  const response = await fetch(
    client.network.endpoints.rest + path,
    at ? { headers: { 'x-cosmos-block-height': String(at) } } : {},
  );
  assert.ok(response.ok, path + ' HTTP ' + response.status);
  if (at)
    assert.equal(response.headers.get('x-cosmos-block-height'), String(at));
  return response.json();
}
async function snapshot(at) {
  const [bank, rdk] = await Promise.all([
    read(
      '/cosmos/bank/v1beta1/balances/' + destination + '/by_denom?denom=uqor',
      at,
    ),
    read('/qorechain/rdk/v1/rollup/' + rollupId, at),
  ]);
  assert.equal(bank.balance.denom, 'uqor');
  return {
    height: at,
    recipientUqor: bank.balance.amount,
    poolUqor: rdk.rollup.deposit_pool,
  };
}
const [before, after, tx, batch, checked] = await Promise.all([
  snapshot(height - 1),
  snapshot(height),
  read('/cosmos/tx/v1beta1/txs/' + hash),
  client.rest.getBatch(rollupId, 1),
  verifySettlementReceipt(receipt, { client }),
]);
assert.equal(before.recipientUqor, '0');
assert.equal(after.recipientUqor, '250000');
assert.equal(before.poolUqor, '1000000');
assert.equal(after.poolUqor, '750000');
assert.equal(batch.status, 'finalized');
assert.ok(batch.finalizedAt > batch.submittedAt && batch.finalizedAt < height);
assert.equal(receipt.chainId, chainId);
assert.equal(receipt.rollupId, rollupId);
assert.equal(receipt.batchIndex, 1);
assert.equal(receipt.batchStateRoot, batch.stateRoot);
assert.equal(receipt.algorithm, 'ML-DSA-87');
assert.ok(checked.valid);
assert.equal(tx.tx_response.code, 0);
assert.equal(Number(tx.tx_response.height), height);
assert.equal(tx.tx_response.txhash, hash);
assert.equal(tx.tx.body.messages.length, 1);
const [msg] = tx.tx.body.messages;
assert.equal(msg['@type'], '/qorechain.rdk.v1.MsgExecuteWithdrawal');
assert.equal(msg.submitter, operator);
assert.equal(msg.rollup_id, rollupId);
assert.equal(msg.batch_index, '1');
assert.equal(msg.withdrawal_index, '0');
assert.equal(msg.recipient, destination);
assert.equal(msg.amount, '250000');
assert.equal(msg.denom, 'uqor');
assert.deepEqual(msg.proof ?? [], []);
const events = tx.tx_response.events.map((e) => ({
  type: e.type,
  ...Object.fromEntries(e.attributes.map((a) => [a.key, a.value])),
}));
const paid = events.find(
  (e) =>
    e.type === 'transfer' &&
    e.recipient === destination &&
    e.amount === '250000uqor',
);
const executed = events.find(
  (e) =>
    e.type === 'rdk_withdrawal_executed' &&
    e.rollup_id === rollupId &&
    e.batch_index === '1' &&
    e.withdrawal_index === '0' &&
    e.recipient === destination &&
    e.amount === '250000uqor',
);
assert.ok(paid && executed);
const result = {
  chainId,
  rollupId,
  recipient: destination,
  feePayer: operator,
  claimHash: hash,
  claimTime: tx.tx_response.timestamp,
  before,
  after,
  bankTransfer: paid,
  withdrawalEvent: executed,
  batchStatus: batch.status,
  finalizedAt: batch.finalizedAt,
  receiptValid: checked.valid,
  checks: checked.checks,
};
if (process.argv.includes('--save'))
  writeFileSync(
    dir + 'verification.json',
    JSON.stringify(result, null, 2) + '\n',
    { flag: 'wx' },
  );
console.log(JSON.stringify(result, null, 2));
