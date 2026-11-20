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
  // 5. Finalized: settled for both readers. The receipt is verified once and reused on later reads.
  let verifications = 0;
  deps.verifyBatch = async (b) => { verifications += 1; return { valid: true, checks: { batchStateRoot: true }, batch: b.batchIndex }; };
  view.set([b0, batch(1, 2, 4, { status: 'finalized', finalizedAt: 60 })], 4);
  s = await snapshot();
  assert.deepEqual([s.payee.rows[0].status, s.auditor.rows[0].status], ['settled', 'settled']);
  assert.equal(settling(), false);
  view.set([b0, batch(1, 2, 4, { status: 'finalized', finalizedAt: 60 }), batch(2, 4, 4)], 4);
  s = await snapshot();   // a new batch forces the rows to be rebuilt
  assert.equal(s.payee.rows[0].status, 'settled');
  assert.equal(verifications, 1);

  report = await finalityReport();
  assert.equal(report.measurements[0].handedToNodeAt, clickAt + 1700);
  assert.equal(report.measurements[0].tx, PAY_TX);
  assert.equal(report.measurements[0].payee.determined, first.payee, 'later state changes do not move it');
  assert.equal(report.measurements[0].committed.height, '12');
});
