// Divergent batches through their window (#12, review of PR 13): challenge
// delivery with retries, terminal chain outcomes, third-party verdicts.
import test from 'node:test';
import assert from 'node:assert/strict';
import { TimeoutError, BroadcastTxError } from '@cosmjs/stargate';
import { createIncidentTracker } from './incidents.mjs';
import { challenge, broadcastFailure, quickInclusion } from './chain.mjs';

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
  // `before` and `after` are the chain heights read around the view; omit them for a failing height lookup.
  const step = async (ms, watch, changed = false, before, after = before) => {
    t += ms;
    return tracker.update({ watch, windowSecs: WINDOW, changed, heightBefore: before, heightAfter: after });
  };
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
  let [i] = await h.step(0, view(forged()), true, 100);
  assert.deepEqual([i.ours.state, i.ours.code, i.upheld], ['retrying', 9, null]);
  events = [upheld];
  [i] = await h.step(3000, view(forged({ status: 'rejected', verdict: 'rolled-back' })), true, 103);
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
  await h.step(0, view(forged()), true, 100);
  events = [upheld];
  await h.step(3000, view(forged({ status: 'rejected', verdict: 'rolled-back' })), true, 103);
  assert.equal(h.calls.send, 1);
  // The same claim again, submitted later.
  const again = forged({ submittedAt: 300, submittedTime: 1600 });
  let list = await h.step(600_000, view(again), true, 301);
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
  list = await h.step(3000, view(forged({ ...again, status: 'rejected', verdict: 'rolled-back' })), true, 303);
  assert.deepEqual(list.map((i) => [i.submittedAt, i.upheld.hash]), [[300, 'F'.repeat(64)], [100, upheld.hash]]);
  assert.equal(list.length, 2);
});

// -------------------------------------- third to fifth reviews of PR 13
//
// A verdict is linked to a submission only when the observations and the
// chain's events identify what rejected it. Each standalone entry keeps the
// event's hash, height and batch index.

const HA = 'A1'.repeat(32), HB = 'B1'.repeat(32), HC = 'C1'.repeat(32);
const event = (hash, height, index = 2) => ({ index, hash, height, challenger: 'qor1thirdparty' });
const gone = (b) => forged({ ...b, status: 'rejected', verdict: 'rolled-back' });
/** [submittedAt or null for a standalone event, status, linked or standalone hash] per entry. */
const shape = (list) => list.map((i) => [i.submittedAt ?? null, i.status, i.submittedAt === undefined ? i.upheld.hash : i.upheld?.hash ?? null]);
const once = (list, ...hashes) => assert.deepEqual(list.map((i) => i.upheld?.hash).filter(Boolean).sort(), [...hashes].sort());

test('a verdict and a resubmission in one block, both submissions observed: the verdict stays with the first', async () => {
  let events = [];
  const h = harness({ send: (n) => (n === 1 ? { hash: 'A'.repeat(64), code: 9 } : { hash: 'B'.repeat(64), code: null }), outcomes: () => events });
  // Height 100: Desk observes divergent submission A at index 2.
  await h.step(0, view(forged({ submittedAt: 100 })), true, 100);
  // Block 105: a challenge against A is upheld, then B is accepted at index 2 with the same root.
  events = [event(HA, 105)];
  const b = { submittedAt: 105, submittedTime: 1010 };
  let list = await h.step(8000, view(forged(b)), true, 106);
  assert.deepEqual(shape(list), [[105, 'submitted', null], [100, 'rejected', HA]]);
  assert.deepEqual([list[0].ours.attempts, list[0].ours.hash], [1, 'B'.repeat(64)], 'B gets a fresh attempt');
  once(list, HA);
  events = [event(HA, 105), event(HB, 112)];
  list = await h.step(8000, view(gone(b)), true, 113);
  assert.deepEqual(shape(list), [[105, 'rejected', HB], [100, 'rejected', HA]]);
  once(list, HA, HB);
});

test('the height read and the batch read straddle a block: seeing B pending proves it survived its own block', async () => {
  // Desk missed A. Height read: 104. Block 105: A is rejected (HA), B is submitted. The batch read already shows B.
  let events = [event(HA, 105)];
  const h = harness({ outcomes: () => events });
  const b = { submittedAt: 105, submittedTime: 1010 };
  let list = await h.step(0, view(forged(b)), true, 104, 105);
  assert.deepEqual(shape(list), [[105, 'submitted', null], [null, 'rejected', HA]]);
  // Next poll after B is rejected at 112 (HB).
  events = [event(HA, 105), event(HB, 112)];
  list = await h.step(8000, view(gone(b)), true, 113);
  assert.deepEqual(shape(list), [[105, 'rejected', HB], [null, 'rejected', HA]]);
  once(list, HA, HB);
  const alone = list.find((i) => i.submittedAt === undefined);
  assert.deepEqual([alone.index, alone.upheld.height, alone.upheld.hash], [2, 105, HA]);
});

test('a later verdict is not given to a submission already seen rejected', async () => {
  let events = [];
  const h = harness({ outcomes: () => events });
  const s = { index: 3, submittedAt: 100 };
  await h.step(0, view(forged(s)), true, 100);
  // The snapshot at 105 shows it rejected, with no verdict at index 3 (rolled back with its parent).
  let list = await h.step(8000, view(gone(s)), true, 105);
  assert.deepEqual(shape(list), [[100, 'rejected', null]]);
  assert.equal(list[0].rejectedBy, 105);
  // Desk misses the replacement. At 112 a verdict for it arrives at index 3.
  events = [event(HC, 112, 3)];
  list = await h.step(8000, view(), true, 113);
  assert.deepEqual(shape(list), [[null, 'rejected', HC], [100, 'rejected', null]]);
  once(list, HC);
  const alone = list.find((i) => i.submittedAt === undefined);
  assert.deepEqual([alone.index, alone.upheld.height], [3, 112]);
});

test('a missed replacement: its verdict is not shown on the earlier submission that fell with its parent', async () => {
  const HP = 'D1'.repeat(32);
  let events = [];
  const h = harness({ outcomes: () => events });
  // Height 100: Desk observes divergent submission A at index 3.
  const a = { index: 3, submittedAt: 100 };
  await h.step(0, view(forged(a)), true, 100);
  // 105: a challenge to its parent at index 2 is upheld, and A is rolled back with it.
  // Between polls B is submitted at index 3 and a challenge against B is upheld at 112.
  events = [event(HP, 105, 2), event(HB, 112, 3)];
  const list = await h.step(8000, view(), true, 120);
  assert.deepEqual(shape(list), [[null, 'rejected', HB], [100, 'rejected', null], [null, 'rejected', HP]]);
  once(list, HB, HP);
  const [b, , parent] = list;
  assert.deepEqual([b.index, b.upheld.height, parent.index, parent.upheld.height], [3, 112, 2, 105]);
});

test('the first event that could reject a submission decides: later verdicts at its index are another submission\u2019s', async () => {
  // Sparse polls: pending at 100, gone by 120, verdicts at the index at 105 and 112.
  // It was pending until the first of them, so that one is its own; the second rejected a replacement Desk missed.
  const h = harness({ outcomes: () => [event(HA, 105), event(HB, 112)] });
  await h.step(0, view(forged({ submittedAt: 100 })), true, 100);
  const list = await h.step(8000, view(), true, 120);
  assert.deepEqual(shape(list), [[null, 'rejected', HB], [100, 'rejected', HA]]);
  once(list, HA, HB);
});

test('no unique owner, no link: a tie inside one block, or one verdict claimed by two submissions', async () => {
  // A verdict at the index and one against the parent in the same block: their order is unknown.
  const HP = 'D1'.repeat(32);
  let events = [event(HP, 105, 2), event(HC, 105, 3)];
  let h = harness({ outcomes: () => events });
  await h.step(0, view(forged({ index: 3, submittedAt: 100 })), true, 100);
  let list = await h.step(8000, view(), true, 120);
  assert.deepEqual(list.find((i) => i.submittedAt === 100).upheld, null);
  once(list, HC, HP);
  // Two submissions whose bounds overlap: the height before the second view was not read.
  events = [event(HA, 105)];
  h = harness({ outcomes: () => events });
  const b = { submittedAt: 103, submittedTime: 1010 };
  await h.step(0, view(forged({ submittedAt: 100 })), true, 100);
  await h.step(8000, view(forged(b)), true, undefined, 106);
  list = await h.step(8000, view(gone(b)), true, 120);
  assert.deepEqual(shape(list), [[null, 'rejected', HA], [103, 'rejected', null], [100, 'rejected', null]]);
  once(list, HA);
});

test('without any height read nothing is linked, and every verdict stays visible once', async () => {
  let events = [];
  const h = harness({ outcomes: () => events });
  await h.step(0, view(forged({ submittedAt: 100 })), true);
  events = [event(HA, 105)];
  const b = { submittedAt: 105, submittedTime: 1010 };
  let list = await h.step(8000, view(forged(b)), true);
  assert.deepEqual(shape(list), [[105, 'submitted', null], [null, 'rejected', HA], [100, 'rejected', null]]);
  // A height read succeeds later: it bounds the first rejection, and the verdict finds its owner.
  list = await h.step(8000, view(forged(b)), false, 107);
  assert.deepEqual(shape(list), [[105, 'submitted', null], [100, 'rejected', HA]]);
  once(list, HA);
});

// ------------------------------------------------- run 1 on Diana (PR 14)

test('inclusion is looked up at once and then on a short poll, not after a fixed 3 s', async () => {
  let clock = 1000;
  const sleeps = [];
  const lookups = [];
  const found = { code: 0, height: 10458203, txIndex: 0, events: [], rawLog: '', msgResponses: [], gasUsed: 1n, gasWanted: 2n };
  const transport = quickInclusion({
    broadcastTxSync: async (tx) => { assert.deepEqual([...tx], [1, 2, 3]); clock += 20; return 'AB'.repeat(32); },
    getTx: async (id) => { lookups.push([id, clock]); return lookups.length < 3 ? null : found; },
  }, { pollMs: 400, now: () => clock, sleep: async (ms) => { sleeps.push(ms); clock += ms; } });
  const res = await transport.broadcastTx(Uint8Array.of(1, 2, 3));
  assert.equal(transport.handedAt, 1020, 'the moment the node accepted it');
  assert.deepEqual(lookups.map(([, at]) => at - 1020), [0, 400, 800], 'first lookup with no wait');
  assert.deepEqual(sleeps, [400, 400]);
  assert.deepEqual([res.transactionHash, res.code, res.height], ['AB'.repeat(32), 0, 10458203]);

  // Never found: the timeout carries the hash, so a challenge is reconciled instead of resent.
  const lost = quickInclusion({ broadcastTxSync: async () => 'CD'.repeat(32), getTx: async () => null },
    { pollMs: 400, now: () => clock, sleep: async (ms) => { clock += ms; } });
  const err = await lost.broadcastTx(Uint8Array.of(1), 2000).catch((e) => e);
  assert.ok(err instanceof TimeoutError);
  assert.deepEqual([broadcastFailure(err).hash, broadcastFailure(err).code], ['CD'.repeat(32), null]);
});
