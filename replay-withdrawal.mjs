// Offline replay of the first two Veil batches. --capture reads raw entries
// and the finalized batches from Diana to build the JSONL transcript.
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import {
  createRdkClient,
  fetchQledgerEntries,
  EMPTY_INBOX_ACC,
  QledgerLedger,
  qledgerAccumulate,
  inboxRangeHash,
  executeQledger,
  qledgerWithdrawalProof,
  decodeQledgerTx,
  verifyQledgerTx,
  qledgerAccountId,
  QLEDGER_KIND_WITHDRAW,
} from '@qorechain/rdk';
import { env, hex } from './invoice.mjs';

const directory = 'evidence/withdrawal/';
const file = directory + 'transcript.jsonl';
const capture = process.argv.includes('--capture');
const records = capture
  ? []
  : readFileSync(file, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
if (!capture) assert.equal(records.length, 2);
const client = capture ? createRdkClient({ network: 'testnet' }) : undefined;
let accFrom = EMPTY_INBOX_ACC,
  consumed = 0;
const ledger = new QledgerLedger();
const payee = JSON.parse(readFileSync('evidence/public-audit.json')).payee;
const post = JSON.parse(readFileSync(directory + 'post.json'));
const batchTx = JSON.parse(readFileSync(directory + 'batch.json'));
const genesisTx = JSON.parse(readFileSync('evidence/batch.json'));
for (let index = 0; index <= 1; index++) {
  const batch = capture
    ? await client.rest.getBatch(env.rollupId, index)
    : records[index].batch;
  assert.equal(batch.rollupId, env.rollupId);
  assert.equal(batch.batchIndex, index);
  assert.equal(batch.status, 'finalized');
  assert.equal(batch.inboxStart, consumed);
  assert.equal(batch.inboxEnd, index === 0 ? 3 : 4);
  const range = { ...env, from: consumed, to: batch.inboxEnd, accFrom };
  const entries = capture
    ? await fetchQledgerEntries(client.rest, range)
    : records[index].entries.map(({ height, poster, payloadHex }) => ({
        height: BigInt(height),
        poster,
        payload: Buffer.from(payloadHex, 'hex'),
      }));
  assert.equal(entries.length, batch.inboxEnd - consumed);
  assert.equal(entries.length, batch.txCount);
  assert.equal(hex(ledger.root()), batch.prevStateRoot);
  const accTo = qledgerAccumulate({ ...range, entries });
  assert.equal(hex(inboxRangeHash({ ...range, accTo })), batch.dataHash);
  const accountId = Buffer.from(payee, 'hex');
  const before = ledger.get(accountId);
  const result = executeQledger(env, ledger, entries);
  assert.equal(hex(result.stateRoot), batch.stateRoot);
  assert.equal(hex(result.withdrawalsRoot), batch.withdrawalsRoot);
  if (index === 1) {
    assert.equal(entries[0].poster, post.operator);
    assert.equal(BigInt(entries[0].height), BigInt(post.height));
    const tx = decodeQledgerTx(entries[0].payload);
    assert.ok(
      tx &&
        tx.kind === QLEDGER_KIND_WITHDRAW &&
        verifyQledgerTx(tx, env.chainId, env.rollupId),
    );
    assert.equal(hex(qledgerAccountId(tx.publicKey)), payee);
    assert.equal(tx.recipient, post.destination);
    assert.equal(tx.nonce, before.nonce);
    assert.equal(tx.amount, 250000n);
    assert.equal(before.balance, 250000n);
    const after = ledger.get(accountId);
    assert.equal(after.balance, 0n);
    assert.equal(after.nonce, before.nonce + 1n);
    assert.deepEqual(result.withdrawals, [
      { index: 0n, recipient: post.destination, amount: tx.amount },
    ]);
    assert.deepEqual(
      qledgerWithdrawalProof(env.chainId, env.rollupId, result.withdrawals, 0),
      [],
    );
  }
  const record = {
    chainId: env.chainId,
    batch,
    submitTx: index === 0 ? genesisTx.hash : batchTx.hash,
    accFrom: hex(accFrom),
    accTo: hex(accTo),
    withdrawals: result.withdrawals.map((w) => ({
      ...w,
      index: String(w.index),
      amount: String(w.amount),
    })),
    entries: entries.map((e) => ({
      height: String(e.height),
      poster: e.poster,
      payloadHex: hex(e.payload),
    })),
  };
  if (capture) records.push(record);
  else assert.deepEqual(record, records[index]);
  console.log(
    'Verified batch',
    index,
    'state root',
    batch.stateRoot,
    'withdrawals root',
    batch.withdrawalsRoot || '(empty)',
  );
  accFrom = accTo;
  consumed = batch.inboxEnd;
}
if (capture)
  writeFileSync(file, records.map((r) => JSON.stringify(r)).join('\n') + '\n', {
    flag: 'wx',
  });
