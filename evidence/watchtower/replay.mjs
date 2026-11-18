import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import {
  buildQledgerFraudProof, checkQledgerFraud, EMPTY_INBOX_ACC,
  executeQledger, inboxRangeHash, QledgerLedger, qledgerAccumulate,
} from '@qorechain/rdk';

// Check the watcher's decision on archived Veil data, without a wallet or RPC.
const transcript = readFileSync(new URL('../withdrawal/transcript.jsonl', import.meta.url));
const records = transcript.toString().trim().split('\n').map(line => JSON.parse(line));
assert.equal(records.length, 2);
const env = { chainId: 'qorechain-diana', rollupId: 'veil-pay-1' };
const ledger = new QledgerLedger();
const hex = bytes => Buffer.from(bytes).toString('hex');
let acc = EMPTY_INBOX_ACC;
let cursor = 0;
for (const [index, record] of records.entries()) {
  const { batch } = record;
  assert.deepEqual([record.chainId, batch.rollupId, batch.batchIndex, batch.status],
    [env.chainId, env.rollupId, index, 'finalized']);
  assert.equal(batch.prevStateRoot, hex(ledger.root()));
  assert.equal(batch.inboxStart, cursor);
  assert.equal(record.accFrom, hex(acc));
  const range = { ...env, from: cursor, to: batch.inboxEnd, accFrom: acc };
  const entries = record.entries.map(e => ({
    payload: Buffer.from(e.payloadHex, 'hex'), poster: e.poster, height: BigInt(e.height),
  }));
  assert.equal(entries.length, batch.inboxEnd - cursor);
  acc = qledgerAccumulate({ ...range, entries });
  assert.equal(hex(acc), record.accTo);
  assert.equal(hex(inboxRangeHash({ ...range, accTo: acc })), batch.dataHash);
  if (index === 1) {
    const { proof } = buildQledgerFraudProof(env, ledger, range.accFrom, entries);
    const actual = checkQledgerFraud(env, batch, proof);
    const stale = checkQledgerFraud(env, { ...batch, stateRoot: batch.prevStateRoot }, proof);
    assert.deepEqual([actual, stale], [false, true]);
    console.log(JSON.stringify({
      chainId: env.chainId, rollupId: env.rollupId, batchIndex: index,
      actualStateRoot: batch.stateRoot, offlineControlStateRoot: batch.prevStateRoot,
      actualFlagged: actual, offlineControlFlagged: stale, proofBytes: proof.length,
      proofSha256: createHash('sha256').update(proof).digest('hex'),
      transcriptSha256: createHash('sha256').update(transcript).digest('hex'),
    }, null, 2));
  }
  const result = executeQledger(env, ledger, entries);
  assert.equal(hex(result.stateRoot), batch.stateRoot);
  assert.equal(hex(result.withdrawalsRoot), batch.withdrawalsRoot);
  cursor = batch.inboxEnd;
}
