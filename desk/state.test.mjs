// Desk state assembly against a stubbed Diana (#12): inbox read with L1
// transactions, watcher verdicts, incidents and the finality measurement.
import test from 'node:test';
import assert from 'node:assert/strict';
import { deskFixture, PAY_TX } from './fixture.mjs';

test('snapshot: determined, disputed while a forgery is pending, determined again, with a measured Desk payment', async (t) => {
  const { snapshot, beginPayment, notePayment, measuring, settling, finalityReport, deps, view, batch, searches } = await deskFixture(t);
  const b0 = view.batches[0];

  // 1. Determined before any batch covers it. From the click the readers read
  // every block, and a poll sees the committed payment before its broadcast
  // returns to the server.
  assert.equal(measuring(), false);
  const end = beginPayment();
  assert.equal(measuring(), true, 'fast reads start at the click');
  let s = await snapshot();
  assert.equal(s.payee.warning, null);
  assert.equal(s.payee.rows[0].status, 'determined');
  assert.equal(s.payee.rows[0].tx, PAY_TX);
  assert.equal(s.auditor.rows[0].status, 'determined');
  assert.equal(s.payee.rows[0].clickAt, null);
  const first = { payee: s.payee.rows[0].observed.determined, auditor: s.auditor.rows[0].observed.determined };
  assert.ok(first.payee && first.auditor);
  const clickAt = first.payee - 2000;
  notePayment(PAY_TX, clickAt, 12, clickAt + 1700);
  end();
  end();
  assert.equal(measuring(), false, 'both readers have determined it: back to the slow cadence');
  assert.equal(settling(), true, 'and it is still read until it settles');
  await new Promise((r) => setTimeout(r, 15));
  s = await snapshot(); // unchanged view
  assert.equal(s.payee.rows[0].clickAt, clickAt);
  assert.equal(s.payee.rows[0].observed.determined, first.payee, 'the first observation survives the broadcast race');
  let report = await finalityReport();
  assert.deepEqual([report.measurements[0].payee.determined, report.measurements[0].auditor.determined], [first.payee, first.auditor]);
  assert.deepEqual(s.watch.diverged, []);
  assert.equal(s.incidents.length, 0);
  assert.equal(s.entries.find((e) => e.sequence === 3).tx, PAY_TX);

  // 2. A forged batch over the invoice: disputed, one open incident.
  const forged = batch(1, 2, 4, { stateRoot: 'ee'.repeat(32) });
  view.set([b0, forged], 4);
  s = await snapshot();
  assert.equal(s.payee.rows[0].status, 'disputed');
  assert.deepEqual(s.watch.diverged, [1]);
  assert.equal(s.incidents[0].status, 'submitted');
  assert.equal(s.incidents[0].deadline, forged.submittedTime + 3600);

  // 3. Rejected and rolled back: determined again; the incident is closed.
  view.set([b0, { ...forged, status: 'rejected' }], 2);
  s = await snapshot();
  assert.equal(s.payee.rows[0].status, 'determined');
  assert.equal(s.incidents[0].status, 'rejected');
  assert.equal(s.incidents[0].proofHex, undefined, 'proofs stay server-side');

  // 4. Honest replacement pending.
  view.set([b0, batch(1, 2, 4)], 4);
  s = await snapshot();
  assert.equal(s.payee.rows[0].status, 'determined');
  assert.equal(s.payee.rows[0].batchStatus, 'submitted');
  assert.equal(s.batches[1].verdict, 'ok');

  // The inbox was read once in full, never again while its head did not move.
  assert.equal(searches.filter((q) => q.startsWith('rdk_data_posted')).length, 1);
  // 5. Finalized. The first receipt check fails in transit: both readers are unverified, and on
  // the same chain view the check is made again after a short wait, not left as it fell.
  let verifications = 0;
  let clock = Date.now();
  deps.now = () => clock;
  deps.verifyBatch = async (b) => {
    verifications += 1;
    return verifications === 1 ? { valid: false, reason: 'anchor lookup failed' } : { valid: true, checks: { batchStateRoot: true }, batch: b.batchIndex };
  };
  view.set([b0, batch(1, 2, 4, { status: 'finalized', finalizedAt: 60 })], 4);
  s = await snapshot();
  assert.deepEqual([s.payee.rows[0].status, s.auditor.rows[0].status], ['unverified', 'unverified']);
  clock += 1000;
  s = await snapshot();
  assert.equal(verifications, 1, 'not on every read');
  clock += 5000;
  s = await snapshot();   // unchanged chain view
  assert.equal(verifications, 2);
  assert.deepEqual([s.payee.rows[0].status, s.auditor.rows[0].status], ['settled', 'settled']);
  assert.equal(settling(), false);
  // A pass is kept: later reads, changed or not, do not verify again.
  clock += 60_000;
  await snapshot();
  view.set([b0, batch(1, 2, 4, { status: 'finalized', finalizedAt: 60 }), batch(2, 4, 4)], 4);
  s = await snapshot();   // a new batch forces the rows to be rebuilt
  assert.equal(s.payee.rows[0].status, 'settled');
  assert.equal(verifications, 2);

  report = await finalityReport();
  assert.equal(report.measurements[0].handedToNodeAt, clickAt + 1700);
  assert.equal(report.measurements[0].tx, PAY_TX);
  assert.equal(report.measurements[0].payee.determined, first.payee, 'later state changes do not move it');
  assert.equal(report.measurements[0].committed.height, '12');
});

test('per-tick reads start at the Pay click and end 60 s after it, whatever the broadcast does', async (t) => {
  const { beginPayment, notePayment, measuring, deps } = await import('./state.mjs');
  let clock = 5_000_000_000_000;
  const real = deps.now;
  deps.now = () => clock;
  t.after(() => { deps.now = real; });
  const clickAt = clock;
  assert.equal(measuring(), false);
  // Still in flight (a slow broadcast): the deadline holds anyway.
  const end = beginPayment(clickAt);
  assert.equal(measuring(), true);
  clock = clickAt + 59_000;
  assert.equal(measuring(), true);
  clock = clickAt + 61_000;
  assert.equal(measuring(), false, 'in flight for more than 60 s');
  end();
  // The broadcast returns 50 s after the click and no reader has determined the payment.
  const next = clock = clickAt + 200_000;
  const endNext = beginPayment(next);
  clock = next + 50_000;
  notePayment('9'.repeat(64), next, 12, next + 1700);
  endNext();
  assert.equal(measuring(), true);
  clock = next + 59_000;
  assert.equal(measuring(), true);
  clock = next + 61_000;
  assert.equal(measuring(), false, 'the count runs from the click, not from the broadcast\u2019s return');
});
