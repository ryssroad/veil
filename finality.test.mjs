// Fast finality (#12): same-transaction binding, the reader's watcher and the
// determined -> disputed -> determined -> settled lifecycle.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { sealKeysFromSeed } from '@qorechain/qoreseal';
import {
  EMPTY_INBOX_ACC, QledgerLedger, encodeQledgerDeposit, encodeQledgerTx, executeQledger, inboxRangeHash,
  qledgerAccumulate, qledgerKeypairFromSeed, signQledgerTx,
} from '@qorechain/rdk';
import { env, hex, sha256, createInvoicePayment, kemFingerprint, replayExecutions, coPostedInTx } from './veil.mjs';
import { entriesFromTxs, accumulate, watchBatches, dispute, incidentsFrom, POST_TYPE } from './finality.mjs';
import { readInvoices } from './desk/chain.mjs';
import { invoicesCsv } from './desk/model.mjs';

const OPERATOR = 'qor1a5j8wjpxpqc6f7htyv92042nrt7gaegpezdhx4';
const txHash = (n) => n.toString(16).toUpperCase().padStart(64, '0');
const tx = (n, msgIndex, code = 0) => ({ hash: txHash(n), code, msgIndex });

// ------------------------------------------------------------------ fixtures

function parties() {
  return {
    payer: qledgerKeypairFromSeed(randomBytes(32)),
    payee: qledgerKeypairFromSeed(randomBytes(32)),
    payeeSeal: sealKeysFromSeed(randomBytes(32)),
    auditorSeal: sealKeysFromSeed(randomBytes(32)),
  };
}
function invoice(p, { nonce = 0, amount = 10n, id = randomBytes(16).toString('hex') } = {}) {
  return createInvoicePayment({ payer: p.payer, nonce, beneficiary: p.payee.accountId, amount,
    beneficiaryKem: p.payeeSeal.mlkemPublicKey, auditorKem: p.auditorSeal.mlkemPublicKey, id, description: 'Services' });
}
const deposit = (account, amount, sequence, height = 1n) => ({ sequence, height, poster: 'deposit:' + OPERATOR,
  payload: encodeQledgerDeposit(account, amount), tx: tx(1000 + sequence, null) });
/** A transfer and its envelope as two messages of one L1 transaction. */
const coPost = (transfer, envelope, sequence, height, n, codes = [0, 0]) => [
  { sequence, height, poster: OPERATOR, payload: transfer, tx: tx(n, 0, codes[0]) },
  { sequence: sequence + 1, height, poster: OPERATOR, payload: envelope, tx: tx(n, 1, codes[1]) },
];

/** A batch over entries (start, end] from `parent`; `forge` replaces its state root. */
function batchOver(entries, index, start, end, { status = 'submitted', forge } = {}) {
  const parent = new QledgerLedger();
  executeQledger(env, parent, entries.slice(0, start));
  const accFrom = start ? qledgerAccumulate({ ...env, from: 0, accFrom: EMPTY_INBOX_ACC, entries: entries.slice(0, start) }) : EMPTY_INBOX_ACC;
  const slice = entries.slice(start, end);
  const accTo = qledgerAccumulate({ ...env, from: start, accFrom, entries: slice });
  const prevStateRoot = hex(parent.root());
  const result = executeQledger(env, parent, slice);
  return { batchIndex: index, status, inboxStart: start, inboxEnd: end, prevStateRoot,
    dataHash: hex(inboxRangeHash({ ...env, from: start, to: end, accFrom, accTo })),
    stateRoot: forge ?? hex(result.stateRoot), withdrawalsRoot: hex(result.withdrawalsRoot),
    submittedAt: 100 + index, submittedTime: 1_800_000_000 + index, finalizedAt: status === 'finalized' ? 200 + index : 0 };
}

function reader(t, p, entries) {
  const dir = mkdtempSync(join(tmpdir(), 'veil-finality-'));
  t.after(() => rmSync(dir, { recursive: true }));
  const { executions } = replayExecutions(entries);
  const read = (all, receipt = { valid: true, checks: { batchStateRoot: true } }) => readInvoices({
    dir, entries, all, executions, mine: hex(p.payee.accountId), sealKeys: p.payeeSeal,
    auditorKey: kemFingerprint(p.auditorSeal.mlkemPublicKey), receiptFor: () => receipt,
  });
  read.imports = () => JSON.parse(readFileSync(join(dir, 'imports.json'), 'utf8'));
  return read;
}

// ----------------------------------------------------- same-transaction binding

test('the envelope must be the next message of the same successful L1 transaction', () => {
  const p = parties();
  const { transfer, envelope } = invoice(p);
  const pair = coPost(transfer, envelope, 2, 5n, 7);
  assert.equal(coPostedInTx(pair, 2), pair[1]);
  const variant = (change) => { const [a, b] = structuredClone(pair); change(a, b); return [a, b]; };
  // Two transactions in one block share height and poster; adjacency alone is not enough.
  assert.equal(coPostedInTx(variant((a, b) => { b.tx.hash = txHash(8); }), 2), undefined);
  assert.equal(coPostedInTx(variant((a, b) => { b.tx.code = 5; }), 2), undefined);
  assert.equal(coPostedInTx(variant((a) => { a.tx.code = 5; }), 2), undefined);
  assert.equal(coPostedInTx(variant((a, b) => { b.tx.msgIndex = 2; }), 2), undefined);
  assert.equal(coPostedInTx(variant((a, b) => { delete b.tx; }), 2), undefined);
  assert.equal(coPostedInTx(variant((a, b) => { b.poster = 'qor1other'; }), 2), undefined);
});

test('entries keep their L1 transaction; payloads are matched by hash and message index', () => {
  const data = [Buffer.from('first'), Buffer.from('second'), Buffer.from('other rollup')];
  const msg = (d, rollup = env.rollupId) => ({ '@type': POST_TYPE, poster: OPERATOR, rollup_id: rollup, data: d.toString('base64') });
  const posted = (sequence, d, extra = []) => ({ type: 'rdk_data_posted', attributes: [
    { key: 'rollup_id', value: env.rollupId }, { key: 'sequence', value: String(sequence) },
    { key: 'poster', value: OPERATOR }, { key: 'data_hash', value: hex(sha256(d)) }, ...extra] });
  const posts = [
    // One transaction: a post for another rollup, then our two posts. No msg_index attribute.
    { txhash: 'ab'.repeat(32), code: 0, height: '50', tx: { body: { messages: [msg(data[2], 'x-rollup'), msg(data[0]), msg(data[1])] } },
      events: [posted(2, data[0]), posted(3, data[1])] },
  ];
  const deposits = [{ txhash: 'cd'.repeat(32), code: 0, height: '49', events: [{ type: 'rdk_rollup_deposit', attributes: [
    { key: 'rollup_id', value: env.rollupId }, { key: 'sequence', value: '1' }, { key: 'depositor', value: OPERATOR },
    { key: 'account', value: 'ee'.repeat(32) }, { key: 'amount', value: '5uqor' }] }] }];
  const entries = entriesFromTxs({ posts, deposits, from: 0, to: 3 });
  assert.deepEqual(entries.map((e) => [e.sequence, e.tx.hash, e.tx.msgIndex]),
    [[1, 'CD'.repeat(32), null], [2, 'AB'.repeat(32), 1], [3, 'AB'.repeat(32), 2]]);
  assert.equal(coPostedInTx(entries, 2), entries[2]);
  assert.equal(accumulate(entries), hex(qledgerAccumulate({ ...env, from: 0, accFrom: EMPTY_INBOX_ACC, entries })));
  // Incremental read: only the range after `from`.
  assert.deepEqual(entriesFromTxs({ posts, deposits, from: 2, to: 3 }).map((e) => e.sequence), [3]);
  assert.throws(() => entriesFromTxs({ posts, deposits, from: 0, to: 4 }), /entry 4 was not found/);
  const tampered = structuredClone(posts);
  tampered[0].tx.body.messages[2].data = Buffer.from('changed').toString('base64');
  assert.throws(() => entriesFromTxs({ posts: tampered, deposits, from: 0, to: 3 }), /could not be matched/);
});

// ------------------------------------------------------ determined is refused

test('determined is refused when the co-posting transaction does not hold', async (t) => {
  const p = parties();
  const { transfer, envelope } = invoice(p);
  const base = [deposit(p.payer.accountId, 10n, 1)];
  // Adjacent, same block and poster, but two different transactions.
  const split = [...base, { ...coPost(transfer, envelope, 2, 5n, 7)[0] }, { ...coPost(transfer, envelope, 2, 5n, 8)[1] }];
  const r = await reader(t, p, split)([]);
  assert.equal(r.rows.length, 0);
  assert.match(r.skipped[0].reason, /not in the transfer.s transaction/);
  // A failed transaction (defensive: the chain does not keep its posts).
  const failed = await reader(t, p, [...base, ...coPost(transfer, envelope, 2, 5n, 7, [0, 11])])([]);
  assert.equal(failed.rows.length, 0);
});

test('determined is refused when the exact transfer bytes did not execute', async (t) => {
  const p = parties();
  const cases = {
    'wrong nonce': [deposit(p.payer.accountId, 10n, 1), ...coPost(...Object.values(invoice(p, { nonce: 5 })).slice(0, 2), 2, 5n, 7)],
    'insufficient balance': [deposit(p.payer.accountId, 5n, 1), ...coPost(...Object.values(invoice(p)).slice(0, 2), 2, 5n, 7)],
  };
  for (const [name, entries] of Object.entries(cases)) {
    const r = await reader(t, p, entries)([]);
    assert.equal(r.rows[0].status, 'no-op', name);
    assert.equal(r.accepted.length, 0, name);
  }
});

test('an earlier entry changes the outcome: the same invoice bytes become a no-op', async (t) => {
  const p = parties();
  const { transfer, envelope } = invoice(p);
  const alone = [deposit(p.payer.accountId, 10n, 1), ...coPost(transfer, envelope, 2, 5n, 7)];
  assert.equal((await reader(t, p, alone)([])).rows[0].status, 'determined');
  // Another nonce-0 transfer from the payer, posted first, drains the account.
  const drain = encodeQledgerTx(signQledgerTx({ ...env, ...p.payer, to: randomBytes(32), amount: 10n, nonce: 0n }));
  const raced = [deposit(p.payer.accountId, 10n, 1), { sequence: 2, height: 4n, poster: OPERATOR, payload: drain, tx: tx(6, 0) },
    ...coPost(transfer, envelope, 3, 5n, 7)];
  assert.equal((await reader(t, p, raced)([])).rows[0].status, 'no-op');
});

test('a divergent pending ancestor disputes later entries, even when it ends before them', async (t) => {
  const p = parties();
  const { transfer, envelope } = invoice(p);
  const entries = [deposit(p.payer.accountId, 10n, 1), ...coPost(transfer, envelope, 2, 5n, 7)];
  const read = reader(t, p, entries);
  const forgedDeposit = batchOver(entries, 0, 0, 1, { forge: 'ff'.repeat(32) });
  const r = await read([forgedDeposit]);
  assert.equal(r.rows[0].status, 'disputed');
  assert.equal(r.rows[0].disputedBatch, 0);
  // The same batch, honest: the invoice is determined though no batch covers it yet.
  const honest = await read([batchOver(entries, 0, 0, 1)]);
  assert.equal(honest.rows[0].status, 'determined');
  assert.equal(honest.rows[0].batch, undefined);
});

test('rule 6 before determination: a second executed transfer that reuses an invoice id is never determined', async (t) => {
  const p = parties();
  const id = 'd'.repeat(32);
  const a = invoice(p, { nonce: 0, id });
  const b = invoice(p, { nonce: 1, id });
  const entries = [deposit(p.payer.accountId, 20n, 1), ...coPost(a.transfer, a.envelope, 2, 5n, 7), ...coPost(b.transfer, b.envelope, 4, 6n, 8)];
  const { executions } = replayExecutions(entries);
  assert.deepEqual(executions.map((x) => x.executed), [true, true], 'both transfers moved funds');
  const read = reader(t, p, entries);
  const statuses = (r) => r.rows.map((x) => x.status);
  // Both pending: the conflict is with an earlier invoice of this replay, and nothing is persisted.
  let r = await read([]);
  assert.deepEqual(statuses(r), ['determined', 'conflict']);
  assert.deepEqual(read.imports(), { payments: {}, invoices: {}, conflicts: [] });
  // In a divergent pending batch it is still a conflict, not a dispute to wait out.
  r = await read([batchOver(entries, 0, 0, 5, { forge: 'ab'.repeat(32) })]);
  assert.deepEqual(statuses(r), ['disputed', 'conflict']);
  // The first settled: the conflict is now with a persisted association; the pending one stays out of the import.
  const first = batchOver(entries, 0, 0, 3, { status: 'finalized' });
  r = await read([first]);
  assert.deepEqual(statuses(r), ['settled', 'conflict']);
  assert.equal(Object.keys(read.imports().payments).length, 1);
  assert.equal(read.imports().conflicts.length, 0);
  assert.equal(invoicesCsv(r.rows).trimEnd().split('\r\n').length, 2);
  // Both settled: the same verdict, now recorded by the importer as before.
  r = await read([first, batchOver(entries, 1, 3, 5, { status: 'finalized' })]);
  assert.deepEqual(statuses(r), ['settled', 'conflict']);
  assert.equal(read.imports().conflicts.length, 1);
  assert.equal(invoicesCsv(r.rows).trimEnd().split('\r\n').length, 2);
});

// ------------------------------------------------- invoice lifecycle fixture

test('lifecycle: determined -> disputed -> determined -> settled, exported exactly once', async (t) => {
  const p = parties();
  const { transfer, envelope } = invoice(p, { amount: 10n });
  const entries = [deposit(p.payer.accountId, 10n, 1), ...coPost(transfer, envelope, 2, 5n, 7)];
  const read = reader(t, p, entries);
  const step = async (all, receipt) => {
    const r = await read(all, receipt);
    assert.equal(r.rows.length, 1);
    return r;
  };
  // 1. In a committed block, no batch yet.
  let r = await step([]);
  assert.equal(r.rows[0].status, 'determined');
  assert.equal(r.rows[0].tx, txHash(7));
  assert.equal(r.rows[0].height, '5');
  assert.equal(invoicesCsv(r.rows).trimEnd().split('\r\n').length, 1, 'determined is not exported');
  // 2. The operator submits a batch that moves the funds elsewhere.
  const forged = batchOver(entries, 0, 0, 3, { forge: 'ab'.repeat(32) });
  r = await step([forged]);
  assert.equal(r.rows[0].status, 'disputed');
  assert.equal(r.watch.verdicts[0].verdict, 'diverged');
  assert.equal(incidentsFrom(r.watch).length, 1);
  r = await step([{ ...forged, status: 'challenged' }]);
  assert.equal(r.rows[0].status, 'disputed');
  // 3. The challenge is upheld: the batch is rolled back.
  r = await step([{ ...forged, status: 'rejected' }]);
  assert.equal(r.rows[0].status, 'determined');
  assert.equal(r.rows[0].batch, undefined);
  // 4. Honest replacement at the same index.
  const honest = batchOver(entries, 0, 0, 3);
  r = await step([honest]);
  assert.equal(r.rows[0].status, 'determined');
  assert.equal(r.rows[0].batchStatus, 'submitted');
  // 5. Finalized, but the receipt fails: not settled, not imported.
  const final = { ...honest, status: 'finalized', finalizedAt: 300 };
  r = await step([final], { valid: false, reason: 'anchor missing' });
  assert.equal(r.rows[0].status, 'unverified');
  assert.equal(r.accepted.length, 0);
  // 6. Settled with a verified receipt: imported once, exported once, then idempotent.
  r = await step([final]);
  assert.equal(r.rows[0].status, 'settled');
  assert.equal(r.rows[0].settledHeight, 300);
  assert.equal(r.rows[0].import, 'imported');
  const csv = invoicesCsv(r.rows).trimEnd().split('\r\n');
  assert.equal(csv.length, 2);
  assert.match(csv[1], /"settled"/);
  r = await step([final]);
  assert.equal(r.rows[0].import, 'duplicate');
  assert.equal(invoicesCsv(r.rows).trimEnd().split('\r\n').length, 2);
});

// ------------------------------------------ historical fixture: batch 2 on Diana

function diana() {
  const records = readFileSync(new URL('./evidence/withdrawal/transcript.jsonl', import.meta.url), 'utf8').trim().split('\n').map(JSON.parse);
  const evidence = (f) => JSON.parse(readFileSync(new URL('./evidence/fraud/' + f, import.meta.url)));
  const marker = evidence('marker.json');
  const post = evidence('post.json');
  const payload = Buffer.from(marker.payloadUtf8);
  assert.equal(hex(sha256(payload)), marker.sha256);
  const entries = records.flatMap((r) => r.entries.map((e) => ({ height: BigInt(e.height), poster: e.poster, payload: Buffer.from(e.payloadHex, 'hex') })));
  entries.push({ height: BigInt(post.height), poster: post.sender, payload });
  entries.forEach((e, i) => { e.sequence = i + 1; });
  const forgery = evidence('forgery.json');
  const [b0, b1] = records.map((r) => r.batch);
  const accFrom = records[1].accTo;
  const accTo = qledgerAccumulate({ ...env, from: 4, accFrom, entries: entries.slice(4) });
  const claim = { batchIndex: 2, inboxStart: 4, inboxEnd: 5, prevStateRoot: b1.stateRoot,
    dataHash: hex(inboxRangeHash({ ...env, from: 4, to: 5, accFrom, accTo })), submittedAt: 10320164 };
  const forged = { ...claim, status: 'submitted', stateRoot: forgery.forged.stateRoot, withdrawalsRoot: forgery.forged.withdrawalsRoot };
  const honest = { ...claim, status: 'submitted', submittedAt: 10320478, stateRoot: forgery.honest.stateRoot, withdrawalsRoot: forgery.honest.withdrawalsRoot };
  return { entries, b0, b1, forged, honest, forgery };
}

test('Diana batch 2: the watcher flags the forgery with the proof the chain upheld, then accepts the replacement', () => {
  const { entries, b0, b1, forged, honest, forgery } = diana();
  // While the forged batch is pending.
  let w = watchBatches({ entries, batches: [b0, b1, forged] });
  assert.deepEqual(w.verdicts.map((v) => v.verdict), ['ok', 'ok', 'diverged']);
  // Byte-identical to both challenges included at 10320166 (evidence/fraud/RESULT.md).
  assert.equal(w.verdicts[2].proofSha256, 'ef5f485b9ed9f437d0488af1a317e8dc0c4f85df3da8859a2e0827b3af20b28c');
  assert.equal(w.verdicts[2].proofSha256, forgery.proofSha256);
  assert.equal(w.verdicts[2].expected.stateRoot, forgery.honest.stateRoot);
  assert.equal(w.fault, null);
  assert.equal(dispute(w, 4), undefined, 'entry 4 is in finalized batch 1, before the forgery');
  assert.equal(dispute(w, 5).batch, 2);
  assert.equal(dispute(w, 6).batch, 2, 'later entries depend on the divergent batch too');
  // Upheld: rejected and rolled back, inbox consumed back to 4.
  w = watchBatches({ entries, batches: [b0, b1, { ...forged, status: 'rejected' }] });
  assert.equal(w.verdicts[2].verdict, 'rolled-back');
  assert.equal(w.consumed, 4);
  assert.equal(dispute(w, 5), undefined);
  // Honest replacement at index 2, then finalized at 10323001.
  w = watchBatches({ entries, batches: [b0, b1, honest] });
  assert.equal(w.verdicts[2].verdict, 'ok');
  w = watchBatches({ entries, batches: [b0, b1, { ...honest, status: 'finalized', finalizedAt: 10323001 }] });
  assert.deepEqual(w.verdicts.map((v) => v.verdict), ['ok', 'ok', 'ok']);
  assert.equal(w.root, forgery.honest.stateRoot);
});

test('Diana batch 2, counterfactual: had the forgery finalized unchallenged, nothing after it is determined', () => {
  const { entries, b0, b1, forged } = diana();
  const w = watchBatches({ entries, batches: [b0, b1, { ...forged, status: 'finalized' }] });
  assert.equal(w.fault.index, 2);
  assert.match(dispute(w, 5).reason, /finalized batch 2 diverges/);
  assert.equal(dispute(w, 4), undefined);
});

test('an inconsistent view is an error, not a verdict', () => {
  const { entries, b0, b1, forged } = diana();
  assert.throws(() => watchBatches({ entries, batches: [b0, forged] }), /starts at 4, the replay is at 3/);
  assert.throws(() => watchBatches({ entries: entries.slice(0, 4), batches: [b0, b1, forged] }), /ends at 5/);
  assert.throws(() => watchBatches({ entries, batches: [b0, b1, { ...forged, dataHash: '00'.repeat(32) }] }), /data hash/);
});
