// Divergent batches through their window (#12, review of PR 13): challenge
// delivery with retries, terminal chain outcomes, third-party verdicts.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createIncidentTracker } from './incidents.mjs';

const WINDOW = 3600;
const forged = (over = {}) => ({ index: 2, status: 'submitted', start: 4, end: 5, stateRoot: 'ab'.repeat(32), verdict: 'diverged',
  proofHex: 'c0ffee', proofSha256: 'f'.repeat(64), submittedAt: 100, submittedTime: 1000, expected: { stateRoot: 'cd'.repeat(32) }, ...over });
const view = (...verdicts) => ({ verdicts, fault: null });
const upheld = { index: 2, hash: 'E'.repeat(64), height: 102, challenger: 'qor1thirdparty' };

function harness({ send, lookupTx = async () => null, outcomes = () => [] } = {}) {
  const calls = { send: 0, lookup: 0, outcomes: [] };
  let t = 1_000_000;
  const tracker = createIncidentTracker({
    send: send && (async (...a) => { calls.send += 1; return send(calls.send, ...a); }),
    lookupTx: async (hash) => { calls.lookup += 1; return lookupTx(calls.lookup, hash); },
    fetchOutcomes: async (minHeight) => { calls.outcomes.push(minHeight); return outcomes(); },
    now: () => t,
  });
  const step = async (ms, watch, changed = false) => { t += ms; return tracker.update({ watch, windowSecs: WINDOW, changed }); };
  return { calls, step };
}

test('a transport failure is retried with backoff while the batch is unchanged', async () => {
  const h = harness({ send: (n, index, proofHex) => {
    assert.deepEqual([index, proofHex], [2, 'c0ffee']);
    if (n === 1) throw new Error('ECONNRESET');
    return { hash: 'A'.repeat(64), code: 0, height: 103 };
  } });
  let [i] = await h.step(0, view(forged()), true);
  assert.deepEqual([i.ours.state, i.ours.attempts, i.ours.hash], ['retrying', 1, null]);
  assert.match(i.ours.error, /ECONNRESET/);
  [i] = await h.step(2000, view(forged()));
  assert.equal(h.calls.send, 1, 'not before the backoff');
  [i] = await h.step(3000, view(forged()));
  assert.deepEqual([i.ours.state, i.ours.attempts, i.ours.code], ['included', 2, 0]);
  await h.step(60_000, view(forged()));
  assert.equal(h.calls.send, 2, 'nothing after inclusion');
  assert.equal(i.proofHex, undefined);
});

test('a broadcast with an unknown result is reconciled by its hash before any resend', async () => {
  const h = harness({
    send: () => ({ hash: 'A'.repeat(64), code: null, error: 'timeout waiting for the transaction' }),
    lookupTx: (n) => { if (n === 1) throw new Error('503'); return n === 2 ? null : { code: 0, height: 103 }; },
  });
  let [i] = await h.step(0, view(forged()), true);
  assert.equal(i.ours.state, 'sent');
  await h.step(6000, view(forged()));   // lookup fails: cannot tell, do not resend
  await h.step(6000, view(forged()));   // not indexed yet
  assert.equal(h.calls.send, 1);
  [i] = await h.step(6000, view(forged()));
  assert.deepEqual([i.ours.state, i.ours.code, i.ours.height, h.calls.send], ['included', 0, 103, 1]);
});

test('a broadcast the chain never saw is sent again', async () => {
  const h = harness({ send: (n) => (n === 1 ? { hash: 'A'.repeat(64), code: null } : { hash: 'B'.repeat(64), code: 0 }) });
  await h.step(0, view(forged()), true);
  await h.step(20_000, view(forged()));
  assert.equal(h.calls.send, 1, 'still within the confirmation wait');
  const [i] = await h.step(15_000, view(forged()));
  assert.deepEqual([h.calls.send, i.ours.hash, i.ours.state], [2, 'B'.repeat(64), 'included']);
});

test('another watcher wins: our failed challenge stops and the chain outcome is recorded', async () => {
  let events = [];
  const h = harness({ send: () => ({ hash: 'A'.repeat(64), code: 9 }), outcomes: () => events });
  let [i] = await h.step(0, view(forged()), true);
  assert.deepEqual([i.ours.state, i.ours.code, i.upheld], ['retrying', 9, null]);
  events = [upheld];
  [i] = await h.step(3000, view(forged({ status: 'rejected', verdict: 'rolled-back' })), true);
  assert.equal(i.status, 'rejected');
  assert.deepEqual([i.ours.state, i.ours.reason], ['stopped', 'batch is rejected']);
  assert.equal(i.upheld.challenger, 'qor1thirdparty');
  // The honest replacement at the same index does not reopen it.
  const list = await h.step(60_000, view(forged({ stateRoot: 'cd'.repeat(32), verdict: 'ok' })), true);
  assert.equal(list.length, 1);
  assert.equal(h.calls.send, 1);
});

test('no challenge after the window closes, and none for a finalized fault', async () => {
  const late = harness({ send: () => assert.fail('window is closed') });
  let [i] = await late.step((1000 + WINDOW) * 1000, view(forged()), true);
  assert.equal(i.ours.state, 'expired');
  const fault = harness({ send: () => assert.fail('finalized') });
  [i] = await fault.step(0, view(forged({ status: 'finalized' })), true);
  assert.deepEqual([i.ours.state, i.ours.reason], ['stopped', 'batch is finalized']);
});

test('a configuration error is not retried', async () => {
  const h = harness({ send: () => ({ fatal: 'the watcher must not be the rollup creator' }) });
  await h.step(0, view(forged()), true);
  const [i] = await h.step(120_000, view(forged()));
  assert.deepEqual([h.calls.send, i.ours.state], [1, 'stopped']);
});

test('a reader without a watcher account tracks the incident and sends nothing', async () => {
  const h = harness();
  const [i] = await h.step(0, view(forged()), true);
  assert.deepEqual([i.status, i.ours, i.deadline], ['submitted', undefined, 1000 + WINDOW]);
});

test('a third-party challenge Desk never saw is still reported, from an event cursor of its own', async () => {
  let events = [];
  const h = harness({ outcomes: () => events });
  const honest = view(forged({ verdict: 'ok', stateRoot: 'cd'.repeat(32) }));
  assert.deepEqual(await h.step(0, view(), true), []);
  // Between two reads: forged batch 2 submitted, challenged by a third party, replaced.
  events = [upheld];
  let list = await h.step(3000, honest, true);
  assert.deepEqual(list.map((i) => [i.index, i.status, i.upheld.hash]), [[2, 'rejected', upheld.hash]]);
  assert.deepEqual(h.calls.outcomes, [0, 0]);
  // With no local change at all, the cursor still advances on a timer, from the last event height.
  const quiet = harness({ outcomes: () => events });
  events = [];
  await quiet.step(0, view(), true);
  await quiet.step(3000, view());
  assert.equal(quiet.calls.outcomes.length, 1, 'throttled');
  events = [upheld];
  list = await quiet.step(10_000, view());
  assert.equal(list[0].upheld.hash, upheld.hash);
  events = [upheld, { ...upheld, index: 7, hash: 'F'.repeat(64), height: 500 }];
  list = await quiet.step(10_000, view());
  assert.deepEqual(quiet.calls.outcomes, [0, 0, 102]);
  assert.deepEqual(list.map((i) => i.index), [7, 2], 'no duplicate for the event at the cursor height');
});
