// Desk state assembly against a stubbed Diana (#12): inbox read with L1
// transactions, watcher verdicts, incidents and the finality measurement.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { sealKeysFromSeed } from '@qorechain/qoreseal';
import {
  EMPTY_INBOX_ACC, QledgerLedger, RestError, encodeQledgerDeposit, executeQledger, inboxRangeHash,
  qledgerAccumulate, qledgerKeypairFromSeed,
} from '@qorechain/rdk';
import { env, hex, sha256, createInvoicePayment, encodeReaderStatement } from '../veil.mjs';
import { POST_TYPE } from '../finality.mjs';

const OPERATOR = 'qor1a5j8wjpxpqc6f7htyv92042nrt7gaegpezdhx4';
const AUDITOR = 'qor1kc6lwdz77q6f32vcfae35yu3k84l58t5xrsy3l';

test('snapshot: determined, disputed while a forgery is pending, determined again, with a measured Desk payment', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'veil-desk-'));
  t.after(() => rmSync(root, { recursive: true }));
  const seeds = { payer: randomBytes(32), payeeL2: randomBytes(32), payeeSeal: randomBytes(32), auditorSeal: randomBytes(32) };
  mkdirSync(join(root, '.private/clients/payee'), { recursive: true });
  mkdirSync(join(root, '.private/clients/auditor'), { recursive: true });
  writeFileSync(join(root, '.private/payer-l2.seed'), seeds.payer);
  writeFileSync(join(root, '.private/clients/payee/l2.seed'), seeds.payeeL2);
  writeFileSync(join(root, '.private/clients/payee/seal.seed'), seeds.payeeSeal);
  writeFileSync(join(root, '.private/clients/auditor/seal.seed'), seeds.auditorSeal);
  const payer = qledgerKeypairFromSeed(seeds.payer);
  const payee = qledgerKeypairFromSeed(seeds.payeeL2);
  const payeeSeal = sealKeysFromSeed(seeds.payeeSeal);
  const auditorSeal = sealKeysFromSeed(seeds.auditorSeal);

  // Inbox: deposit (1), payee reader key (2), transfer + envelope in one tx (3, 4).
  const statement = encodeReaderStatement({ keypair: payee, kemPublicKey: payeeSeal.mlkemPublicKey });
  const { transfer, envelope } = createInvoicePayment({ payer, nonce: 0, beneficiary: payee.accountId, amount: 10n,
    beneficiaryKem: payeeSeal.mlkemPublicKey, auditorKem: auditorSeal.mlkemPublicKey, id: 'a'.repeat(32), description: 'Services' });
  const PAY_TX = 'C'.repeat(64);
  const msg = (data) => ({ '@type': POST_TYPE, poster: OPERATOR, rollup_id: env.rollupId, data: Buffer.from(data).toString('base64') });
  const posted = (sequence, data, msgIndex) => ({ type: 'rdk_data_posted', attributes: [
    { key: 'rollup_id', value: env.rollupId }, { key: 'sequence', value: String(sequence) }, { key: 'poster', value: OPERATOR },
    { key: 'data_hash', value: hex(sha256(data)) }, { key: 'msg_index', value: String(msgIndex) }] });
  const posts = [
    { txhash: 'B'.repeat(64), code: 0, height: '11', tx: { body: { messages: [msg(statement)] } }, events: [posted(2, statement, 0)] },
    { txhash: PAY_TX, code: 0, height: '12', tx: { body: { messages: [msg(transfer), msg(envelope)] } },
      events: [posted(3, transfer, 0), posted(4, envelope, 1)] },
  ];
  const deposits = [{ txhash: 'A'.repeat(64), code: 0, height: '10', events: [{ type: 'rdk_rollup_deposit', attributes: [
    { key: 'rollup_id', value: env.rollupId }, { key: 'sequence', value: '1' }, { key: 'depositor', value: OPERATOR },
    { key: 'account', value: hex(payer.accountId) }, { key: 'amount', value: '10uqor' }] }] }];
  const entries = [
    { height: 10n, poster: 'deposit:' + OPERATOR, payload: encodeQledgerDeposit(payer.accountId, 10n) },
    { height: 11n, poster: OPERATOR, payload: statement },
    { height: 12n, poster: OPERATOR, payload: transfer },
    { height: 12n, poster: OPERATOR, payload: envelope },
  ];
  const acc = (n) => qledgerAccumulate({ ...env, from: 0, accFrom: EMPTY_INBOX_ACC, entries: entries.slice(0, n) });
  const batch = (index, start, end, extra = {}) => {
    const ledger = new QledgerLedger();
    executeQledger(env, ledger, entries.slice(0, start));
    const prevStateRoot = hex(ledger.root());
    const result = executeQledger(env, ledger, entries.slice(start, end));
    return { batchIndex: index, inboxStart: start, inboxEnd: end, prevStateRoot, status: 'submitted',
      dataHash: hex(inboxRangeHash({ ...env, from: start, to: end, accFrom: start ? acc(start) : EMPTY_INBOX_ACC, accTo: acc(end) })),
      stateRoot: hex(result.stateRoot), withdrawalsRoot: hex(result.withdrawalsRoot),
      submittedAt: 20 + index, submittedTime: 1_800_000_000 + index, finalizedAt: 0, ...extra };
  };
  // Batch 0 covers the deposit and the statement and is finalized; the invoice is unbatched.
  let chain = { batches: [batch(0, 0, 2, { status: 'finalized', finalizedAt: 30 })], consumed: 2 };

  process.env.VEIL_PAYEE_DIR = '.private/clients/payee';
  process.env.VEIL_AUDITOR_DIR = '.private/clients/auditor';
  process.env.VEIL_AUDITOR = AUDITOR;
  delete process.env.VEIL_WATCHER_MNEMONIC;
  process.chdir(root);
  const { client } = await import('./chain.mjs');
  const { snapshot, notePayment, finalityReport } = await import('./state.mjs');
  const searches = [];
  Object.assign(client.rest, {
    getRollup: async () => ({ creator: OPERATOR, challengeWindowSec: 3600 }),
    getInbox: async () => ({ headSequence: 4, headAcc: hex(acc(4)), consumedSequence: chain.consumed }),
    getLatestBatch: async () => chain.batches.at(-1),
    getBatch: async (_, i) => { if (!chain.batches[i]) throw new RestError('not found', 404); return chain.batches[i]; },
    getKemKey: async (address) => (assert.equal(address, AUDITOR),
      { publicKey: hex(auditorSeal.mlkemPublicKey), algorithmId: 2, registeredHeight: 5 }),
    getSubmitterBond: async () => ({ amount: '1000000000' }),
    getParams: async () => ({ defaultChallengeWindow: 3600 }),
    searchTxs: async (query) => {
      searches.push(query);
      if (query.startsWith('rdk_data_posted')) return posts;
      if (query.startsWith('rdk_rollup_deposit')) return deposits;
      return [];
    },
  });
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ block: { header: { time: '2026-11-21T00:00:12Z' } } }) });
  t.after(() => { globalThis.fetch = realFetch; });

  // 1. Determined before any batch covers it.
  notePayment(PAY_TX, Date.now() - 2000, 12);
  let s = await snapshot();
  assert.equal(s.payee.warning, null);
  assert.equal(s.payee.rows[0].status, 'determined');
  assert.equal(s.payee.rows[0].tx, PAY_TX);
  assert.equal(s.auditor.rows[0].status, 'determined');
  assert.ok(s.payee.rows[0].observed.determined >= s.payee.rows[0].clickAt);
  assert.deepEqual(s.watch.diverged, []);
  assert.equal(s.incidents.length, 0);
  assert.equal(s.entries.find((e) => e.sequence === 3).tx, PAY_TX);

  // 2. A forged batch over the invoice: disputed, one open incident.
  const forged = batch(1, 2, 4, { stateRoot: 'ee'.repeat(32) });
  chain = { batches: [chain.batches[0], forged], consumed: 4 };
  s = await snapshot();
  assert.equal(s.payee.rows[0].status, 'disputed');
  assert.deepEqual(s.watch.diverged, [1]);
  assert.equal(s.incidents[0].status, 'submitted');
  assert.equal(s.incidents[0].deadline, forged.submittedTime + 3600);

  // 3. Rejected and rolled back: determined again; the incident is closed.
  chain = { batches: [chain.batches[0], { ...forged, status: 'rejected' }], consumed: 2 };
  s = await snapshot();
  assert.equal(s.payee.rows[0].status, 'determined');
  assert.equal(s.incidents[0].status, 'replaced or rejected');

  // 4. Honest replacement pending.
  chain = { batches: [chain.batches[0], batch(1, 2, 4)], consumed: 4 };
  s = await snapshot();
  assert.equal(s.payee.rows[0].status, 'determined');
  assert.equal(s.payee.rows[0].batchStatus, 'submitted');
  assert.equal(s.batches[1].verdict, 'ok');

  // The inbox was read once in full, never again while its head did not move.
  assert.equal(searches.filter((q) => q.startsWith('rdk_data_posted')).length, 1);
  const report = await finalityReport();
  assert.equal(report.measurements[0].tx, PAY_TX);
  assert.ok(report.measurements[0].payee.determined && report.measurements[0].auditor.determined);
  assert.equal(report.measurements[0].committed.height, '12');
});
