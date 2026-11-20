// Divergent batches through their window (#12, review of PR 13): challenge
// delivery with retries, terminal chain outcomes, third-party verdicts.
import test from 'node:test';
import assert from 'node:assert/strict';
import { TimeoutError, BroadcastTxError } from '@cosmjs/stargate';
import { createIncidentTracker } from './incidents.mjs';
import { challenge, broadcastFailure } from './chain.mjs';

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
  const step = async (ms, watch, changed = false, height) => { t += ms; return tracker.update({ watch, windowSecs: WINDOW, changed, height }); };
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

// ------------------------------------------------- second review of PR 13

test('a CosmJS timeout keeps the submitted hash: it is looked up, and nothing is broadcast twice', async () => {
  const H = 'AB'.repeat(32);
  let broadcasts = 0;
  const transport = async (account, messages, name) => {
    broadcasts += 1;
    assert.equal(account.cosmos, 'qor1watcher');
    assert.deepEqual([messages.length, name], [1, 'challenge']);
    throw new TimeoutError(`Transaction with ID ${H} was submitted but was not yet found on the chain.`, H);
  };
  const lookups = [];
  const h = harness({
    // The real adapter, with only the transport replaced.
    send: (n, index, proofHex) => challenge({ cosmos: 'qor1watcher' }, index, proofHex, { send: transport }),
    lookupTx: (n, hash) => { lookups.push(hash); return { code: 0, height: 103 }; },
  });
  let [i] = await h.step(0, view(forged()), true);
  assert.deepEqual([i.ours.state, i.ours.hash, i.ours.code], ['sent', H, null]);
  [i] = await h.step(6000, view(forged()));
  assert.deepEqual([i.ours.state, i.ours.code, i.ours.height], ['included', 0, 103]);
  assert.deepEqual(lookups, [H]);
  await h.step(60_000, view(forged()));
  assert.equal(broadcasts, 1);
});

test('broadcast failures are read from the error fields, never from its text', () => {
  const H = 'cd'.repeat(32);
  // SDK QoreTxError: included and failed, e.g. another watcher already won.
  const delivered = Object.assign(new Error('batch 2 is rejected'), { name: 'QoreTxError', code: 9, codespace: 'rdk', txHash: H });
  assert.deepEqual([broadcastFailure(delivered).hash, broadcastFailure(delivered).code], [H.toUpperCase(), 9]);
  // CheckTx refusal: nothing entered the mempool, so there is no hash to wait for.
  const refused = broadcastFailure(new BroadcastTxError(32, 'sdk', 'account sequence mismatch'));
  assert.deepEqual([refused.hash, refused.code], [null, null]);
  // A socket error carries a string code and a message that merely mentions a hash.
  const socket = broadcastFailure(Object.assign(new Error(`reset after code 0 (tx ${H})`), { code: 'ECONNRESET' }));
  assert.deepEqual([socket.hash, socket.code], [null, null]);
  const timeout = broadcastFailure(new TimeoutError('not yet found', H));
  assert.deepEqual([timeout.hash, timeout.code], [H.toUpperCase(), null]);
});

test('each submission is its own incident: a resubmission at the same index and root gets a fresh challenge', async () => {
  let events = [];
  const h = harness({ send: (n) => ({ hash: (n === 1 ? 'A' : 'B').repeat(64), code: 0, height: n === 1 ? 102 : 302 }), outcomes: () => events });
  await h.step(0, view(forged()), true);
  events = [upheld];
  await h.step(3000, view(forged({ status: 'rejected', verdict: 'rolled-back' })), true);
  assert.equal(h.calls.send, 1);
  // The same claim again, submitted later.
  const again = forged({ submittedAt: 300, submittedTime: 1600 });
  let list = await h.step(600_000, view(again), true);
  assert.equal(h.calls.send, 2, 'the replacement is challenged');
  assert.equal(list.length, 2);
  const [second, first] = list;
  assert.deepEqual([first.submittedAt, first.status, first.ours.hash, first.ours.state, first.upheld.hash],
    [100, 'rejected', 'A'.repeat(64), 'included', upheld.hash]);
  assert.ok(first.closedAt);
  assert.deepEqual([second.submittedAt, second.status, second.closedAt, second.ours.hash, second.ours.attempts, second.upheld],
    [300, 'submitted', undefined, 'B'.repeat(64), 1, null]);
  // Its own verdict, when it comes, goes to the second submission only.
  events = [upheld, { ...upheld, hash: 'F'.repeat(64), height: 302 }];
  list = await h.step(3000, view(forged({ ...again, status: 'rejected', verdict: 'rolled-back' })), true);
  assert.deepEqual(list.map((i) => [i.submittedAt, i.upheld.hash]), [[300, 'F'.repeat(64)], [100, upheld.hash]]);
  assert.equal(list.length, 2);
});

// -------------------------------------------------- third review of PR 13

const hashes = (list) => list.map((i) => i.upheld?.hash).filter(Boolean);

for (const heights of [true, false]) {
  test(`a verdict and a resubmission in one block: the verdict stays with the first submission (${heights ? 'view heights known' : 'height lookup failing'})`, async () => {
    const event = { ...upheld, height: 105 };
    let events = [];
    const h = harness({ send: (n) => (n === 1 ? { hash: 'A'.repeat(64), code: 9 } : { hash: 'B'.repeat(64), code: null }), outcomes: () => events });
    const at = (height) => (heights ? height : undefined);
    // Height 100: Desk observes divergent submission A at index 2.
    await h.step(0, view(forged({ submittedAt: 100 })), true, at(100));
    // Block 105: a challenge against A is upheld, then B is accepted at index 2 with the same root.
    events = [event];
    const b = forged({ submittedAt: 105, submittedTime: 1010 });
    let list = await h.step(8000, view(b), true, at(106));
    assert.equal(list.length, 2);
    const [second, first] = list;
    assert.deepEqual([first.submittedAt, first.status, first.upheld?.hash], [100, 'rejected', event.hash]);
    assert.deepEqual([second.submittedAt, second.status, second.upheld, second.ours.attempts, second.ours.hash],
      [105, 'submitted', null, 1, 'B'.repeat(64)]);
    assert.deepEqual(hashes(list), [event.hash], 'the event appears exactly once');
    // B's own verdict later goes to B, and A keeps its own.
    events = [event, { ...upheld, hash: 'F'.repeat(64), height: 112 }];
    list = await h.step(8000, view(forged({ ...b, status: 'rejected', verdict: 'rolled-back' })), true, at(113));
    assert.deepEqual(list.map((i) => [i.submittedAt, i.upheld.hash]), [[105, 'F'.repeat(64)], [100, event.hash]]);
  });
}

test('a verdict against a submission Desk never saw is not given to the resubmission from the same block', async () => {
  // Block 105: an unseen submission is upheld against, then B is accepted. Desk first reads at 106.
  const event = { ...upheld, height: 105 };
  let events = [event];
  const h = harness({ outcomes: () => events });
  const b = forged({ submittedAt: 105, submittedTime: 1010 });
  let list = await h.step(0, view(b), true, 106);
  assert.deepEqual(list.map((i) => [i.status, i.submittedAt ?? null, i.upheld?.hash ?? null]),
    [[`submitted`, 105, null], ['rejected', null, event.hash]]);
  // B is rejected at 112 by its own verdict. The earlier event still is not B's.
  events = [event, { ...upheld, hash: 'F'.repeat(64), height: 112 }];
  list = await h.step(8000, view(forged({ ...b, status: 'rejected', verdict: 'rolled-back' })), true, 113);
  assert.deepEqual(list.find((i) => i.submittedAt === 105).upheld.hash, 'F'.repeat(64));
  assert.deepEqual(hashes(list).sort(), [event.hash, 'F'.repeat(64)].sort());
});

test('a submission still pending never owns a verdict, with or without a view height', async () => {
  const event = { ...upheld, height: 105 };
  const h = harness({ outcomes: () => [event] });
  const list = await h.step(0, view(forged({ submittedAt: 105, submittedTime: 1010 })), true);
  assert.deepEqual(list.map((i) => [i.status, i.upheld?.hash ?? null]), [['submitted', null], ['rejected', event.hash]]);
});
