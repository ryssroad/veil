// Divergent batches through their window (#12, review of PR 13): challenge
// delivery with retries, terminal chain outcomes, third-party verdicts.
import test from 'node:test';
import assert from 'node:assert/strict';
import { TimeoutError, BroadcastTxError, StargateClient } from '@cosmjs/stargate';
import { createIncidentTracker } from './incidents.mjs';
import { challenge, broadcastFailure, quickInclusion, boundedFetch, broadcast } from './chain.mjs';
import { actionFailure } from './model.mjs';
import { deriveUnifiedAccount, EthNativeSigner, generateMnemonic, HYBRID_SIGN_BYTES_REJECTION_LOG } from '@qorechain/sdk';
import { createRdkRegistry, postRollupDataMsg } from '@qorechain/rdk';
import { createHash } from 'node:crypto';

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

// ----------------------------------------------------- review of PR 15

test('a lookup that fails after the node accepted the transaction does not lose its hash', async () => {
  const H = 'EF'.repeat(32);
  let accepted = 0;
  let lookups = 0;
  const transportFor = () => quickInclusion({
    broadcastTxSync: async () => { accepted += 1; return H; },
    getTx: async () => { lookups += 1; if (lookups === 1) throw new Error('HTTP 503'); return { code: 0, height: 103 }; },
  }, { pollMs: 400, sleep: async () => {} });
  // Through the real challenge adapter and the tracker: the first lookup fails, the second confirms.
  const h = harness({
    send: (n, index, proofHex) => challenge({ cosmos: 'qor1watcher' }, index, proofHex,
      { send: async () => { const tx = await transportFor().broadcastTx(Uint8Array.of(1)); return { hash: tx.transactionHash, code: tx.code, height: tx.height }; } }),
    lookupTx: () => assert.fail('the transport already confirmed it'),
  });
  const [i] = await h.step(0, view(forged()), true);
  assert.deepEqual([i.ours.state, i.ours.hash, i.ours.code, i.ours.attempts], ['included', H, 0, 1]);
  await h.step(60_000, view(forged()));
  assert.deepEqual([accepted, lookups], [1, 2], 'sent exactly once');

  // Every lookup fails until the timeout: the error still carries the hash, so the tracker reconciles instead of resending.
  let clock = 0;
  const down = quickInclusion({ broadcastTxSync: async () => H, getTx: async () => { throw new Error('HTTP 503'); } },
    { pollMs: 400, now: () => clock, sleep: async (ms) => { clock += ms; } });
  const err = await down.broadcastTx(Uint8Array.of(1), 2000).catch((e) => e);
  assert.ok(err instanceof TimeoutError);
  assert.equal(err.cause?.message, 'HTTP 503', 'the last lookup error is kept for diagnosis');
  assert.doesNotMatch(err.message, /HTTP 503/, 'but not in the message, which the SDK reads to decide on a resend');
  assert.deepEqual([broadcastFailure(err).hash, broadcastFailure(err).code], [H, null]);
});

// ------------------------------------------------ second review of PR 15

test('the inclusion deadline ends a lookup that is still pending', async () => {
  const H = 'FA'.repeat(32);
  let accepted = 0;
  let lookups = 0;
  const transport = quickInclusion({
    broadcastTxSync: async () => { accepted += 1; return H; },
    getTx: () => { lookups += 1; return new Promise(() => {}); },   // the node stops answering
  });
  const started = Date.now();
  const err = await transport.broadcastTx(Uint8Array.of(1), 20).catch((e) => e);
  assert.ok(Date.now() - started < 1000, 'the caller is released at the deadline');
  assert.ok(err instanceof TimeoutError);
  assert.equal(err.txId, H);
  assert.deepEqual([broadcastFailure(err).hash, broadcastFailure(err).code], [H, null]);
  assert.deepEqual([accepted, lookups], [1, 1], 'one broadcast, and no second lookup behind the pending one');
});

for (const clockType of ['virtual clock', 'real timer']) {
  test(`an empty lookup at a short deadline does not trigger a second lookup (${clockType})`, async () => {
    const hash = 'AB'.repeat(32);
    const options = { pollMs: 80 };
    let elapsed = 0;
    if (clockType === 'virtual clock') {
      options.now = () => elapsed;
      options.sleep = async (ms) => { elapsed += ms; };
    }
    let broadcasts = 0;
    let lookups = 0;
    const transport = quickInclusion({
      broadcastTxSync: async () => { broadcasts += 1; return hash; },
      getTx: async () => {
        lookups += 1;
        return lookups === 1 ? null : { code: 0, height: 12 };
      },
    }, options);

    await assert.rejects(transport.broadcastTx(Uint8Array.of(1), 20),
      (err) => err instanceof TimeoutError && err.txId === hash);
    assert.equal(broadcasts, 1);
    assert.equal(lookups, 1);
    if (clockType === 'virtual clock') assert.equal(elapsed, 20);
  });
}

test('a REST read that never answers is abandoned after its time limit', async (t) => {
  const real = globalThis.fetch;
  t.after(() => { globalThis.fetch = real; });
  let seen;
  globalThis.fetch = (url, init) => new Promise((resolve, reject) => {
    seen = { url, accept: init.headers?.accept };
    init.signal.addEventListener('abort', () => reject(init.signal.reason));
  });
  // The time limit's own timer does not keep the process alive; a real socket would.
  const alive = setTimeout(() => {}, 5000);
  t.after(() => clearTimeout(alive));
  const started = Date.now();
  const err = await boundedFetch(20)('https://diana.invalid/x', { headers: { accept: 'application/json' } }).catch((e) => e);
  assert.equal(err.name, 'TimeoutError');
  assert.ok(Date.now() - started < 1000);
  assert.deepEqual(seen, { url: 'https://diana.invalid/x', accept: 'application/json' });
});

// ------------------------------------------- review finding 1: the submission itself

// sha256(01 02 03), derived outside this code.
const SIGNED_123_HASH = '039058C6F2C0CB492C533B0A4D14EF77CC0F78ABCCCED5287D84A1A2011CFB81';
// The test's own watchdog: a call that hangs fails with this message instead of stalling the run.
const within = (ms, promise) => Promise.race([promise,
  new Promise((_, reject) => setTimeout(() => reject(new Error(`still pending after ${ms} ms`)), ms))]);
const tick = () => new Promise((r) => setImmediate(r));

test('a submission the node never answers releases the caller at the submission deadline, with the hash of the signed bytes', async () => {
  let broadcasts = 0;
  let lookups = 0;
  const transport = quickInclusion({
    broadcastTxSync: () => { broadcasts += 1; return new Promise(() => {}); },
    getTx: async () => { lookups += 1; return null; },
  }, { submitTimeoutMs: 30 });
  const err = await within(1000, transport.broadcastTx(Uint8Array.of(1, 2, 3), 60_000).catch((e) => e));
  assert.ok(err instanceof TimeoutError, String(err));
  assert.equal(err.txId, SIGNED_123_HASH);
  assert.deepEqual([broadcastFailure(err).hash, broadcastFailure(err).code], [SIGNED_123_HASH, null]);
  assert.equal(transport.handedAt, undefined, 'the node never confirmed it');
  assert.deepEqual([broadcasts, lookups], [1, 0], 'sent once, and no inclusion lookup for an unconfirmed hash');
});

test('the submission deadline never outlasts the caller’s own timeout', async () => {
  const transport = quickInclusion({ broadcastTxSync: () => new Promise(() => {}), getTx: async () => null });
  const err = await within(1000, transport.broadcastTx(Uint8Array.of(1, 2, 3), 30).catch((e) => e));
  assert.ok(err instanceof TimeoutError, String(err));
  assert.equal(err.txId, SIGNED_123_HASH);
});

test('a connection that breaks during submission is uncertain: the hash is kept and Desk says to check before retrying', async () => {
  const broken = Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' });
  let broadcasts = 0;
  const transport = quickInclusion({ broadcastTxSync: async () => { broadcasts += 1; throw broken; }, getTx: async () => null });
  const err = await within(1000, transport.broadcastTx(Uint8Array.of(1, 2, 3)).catch((e) => e));
  assert.ok(err instanceof TimeoutError, String(err));
  assert.equal(err.txId, SIGNED_123_HASH);
  assert.equal(err.cause, broken, 'the network error is kept for diagnosis');
  assert.equal(transport.handedAt, undefined);
  assert.equal(broadcasts, 1);
  assert.deepEqual(actionFailure(err), { status: 502, result: { hash: SIGNED_123_HASH,
    error: 'Transaction sent, but the node did not confirm receiving it; its result is not known yet. Check the inbox before retrying.' } });
});

test('a CheckTx refusal stays a definitive refusal, not an uncertain submission', async () => {
  const refused = new BroadcastTxError(5, 'sdk', 'insufficient funds');
  const transport = quickInclusion({ broadcastTxSync: async () => { throw refused; }, getTx: async () => assert.fail('nothing to look up') });
  const err = await within(1000, transport.broadcastTx(Uint8Array.of(1, 2, 3)).catch((e) => e));
  assert.equal(err, refused);
  assert.equal(broadcastFailure(err).hash, null, 'nothing reached the mempool');
  assert.equal(transport.handedAt, undefined);
});

test('an answer that arrives after the submission deadline does not change the finished call', async () => {
  let answer;
  let lookups = 0;
  const transport = quickInclusion({
    broadcastTxSync: () => new Promise((resolve) => { answer = resolve; }),
    getTx: async () => { lookups += 1; return { code: 0, height: 9 }; },
  }, { submitTimeoutMs: 30 });
  const err = await within(1000, transport.broadcastTx(Uint8Array.of(1, 2, 3), 60_000).catch((e) => e));
  assert.ok(err instanceof TimeoutError, String(err));
  answer(SIGNED_123_HASH);           // the node answers late
  await tick(); await tick();
  assert.equal(transport.handedAt, undefined, 'a late answer is not a confirmed hand-over of the finished call');
  assert.equal(lookups, 0, 'and starts no lookup behind the caller’s back');
});

test('an unconfirmed submission is not credited with an earlier acceptance on the same transport', async () => {
  // The SDK re-signs and sends again on the same transport after a hybrid sign-bytes rejection at delivery.
  let call = 0;
  let clock = 5000;
  const transport = quickInclusion({
    broadcastTxSync: () => { call += 1; return call === 1 ? Promise.resolve('AB'.repeat(32)) : new Promise(() => {}); },
    getTx: async () => ({ code: 21, codespace: 'pqc', height: 7 }),
  }, { submitTimeoutMs: 30, now: () => clock });
  const first = await within(1000, transport.broadcastTx(Uint8Array.of(9)));
  assert.equal(first.code, 21);
  assert.equal(transport.handedAt, 5000);
  clock = 6000;
  const err = await within(1000, transport.broadcastTx(Uint8Array.of(1, 2, 3)).catch((e) => e));
  assert.equal(err.txId, SIGNED_123_HASH);
  assert.equal(transport.handedAt, undefined, 'the first transaction’s acceptance must not be reported for the second');
});

// The SDK signer Desk uses, offline: a chain id outside the legacy list signs v2 without asking REST.
let signerReady;
const realSigner = () => signerReady ??= (async () => {
  const account = await deriveUnifiedAccount(generateMnemonic());
  return { account, signer: new EthNativeSigner(account, { rest: 'http://rest.invalid', signMode: 'hybrid', registry: createRdkRegistry() }) };
})();
const signParams = (account) => ({ chainId: 'veil-test', accountNumber: 1n, sequence: 0n,
  messages: [postRollupDataMsg({ rollupId: 'veil-test', poster: account.cosmos, data: Uint8Array.of(1, 2, 3) })],
  fee: { amount: [{ denom: 'uqor', amount: '270000' }], gas: '1800000' } });
/** A node whose answer to the n-th submission is `answer(tx, n)`; it records what it was sent. */
const rpcNode = (answer, getTx = async () => null) => {
  const sent = [];
  return { sent, broadcastTxSync: (tx) => { sent.push(tx); return answer(tx, sent.length); }, getTx };
};
/** The signer calls `broadcastTx(bytes)` with CosmJS's 60 s default; the tests shorten it. */
const withDeadline = (transport, ms) => { const send = transport.broadcastTx; transport.broadcastTx = (tx) => send(tx, ms); return transport; };
const txHashOf = (bytes) => createHash('sha256').update(bytes).digest('hex').toUpperCase();

test('through the real SDK signer, an unconfirmed submission is sent once and leaves the user its hash', async () => {
  const { account, signer } = await realSigner();
  const answers = {
    'no answer': () => new Promise(() => {}),
    'connection dropped': async () => { throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNRESET' } }); },
    // A transport error whose text echoes the hybrid sign-bytes rejection: the SDK re-signs and resends on that text.
    'error echoing the rejection log': async () => { throw new Error('upstream: ' + HYBRID_SIGN_BYTES_REJECTION_LOG); },
    'late answer': () => new Promise((r) => setTimeout(() => r('AB'.repeat(32)), 80)),
  };
  for (const [name, answer] of Object.entries(answers)) {
    const node = rpcNode(answer);
    const err = await within(1000, signer.signAndBroadcast(withDeadline(quickInclusion(node, { submitTimeoutMs: 30 }), 60_000),
      signParams(account)).catch((e) => e));
    await new Promise((r) => setTimeout(r, 120));
    assert.equal(node.sent.length, 1, name + ': sent exactly once');
    assert.deepEqual([broadcastFailure(err).hash, broadcastFailure(err).code], [txHashOf(node.sent[0]), null], name);
  }
  // The harness does see a resend when there is one: the SDK signs again after a hybrid sign-bytes refusal at CheckTx.
  const refusing = rpcNode(async (tx, n) => {
    if (n === 1) throw new BroadcastTxError(21, 'pqc', HYBRID_SIGN_BYTES_REJECTION_LOG);
    return txHashOf(tx);
  }, async () => ({ code: 0, height: 12, txIndex: 0, events: [], rawLog: '' }));
  await within(1000, signer.signAndBroadcast(withDeadline(quickInclusion(refusing, { pollMs: 1 }), 2000), signParams(account)));
  assert.equal(refusing.sent.length, 2);
});

test('a Diana RPC that never answers the connection does not hold the action, and nothing is signed or sent', async (t) => {
  const real = globalThis.fetch;
  t.after(() => { globalThis.fetch = real; });
  const asked = [];
  globalThis.fetch = (url, init) => { asked.push(JSON.parse(init.body).method); return new Promise(() => {}); };
  const err = await within(1000, broadcast({ cosmos: 'qor1operator' }, [], 'pay', { rpcWaitMs: 30 }).catch((e) => e));
  assert.ok(err instanceof Error, String(err));
  assert.deepEqual(asked, ['status'], 'stopped while connecting, before anything was signed');
  assert.deepEqual([broadcastFailure(err).hash, broadcastFailure(err).code], [null, null], 'nothing to look up');
});

test('a Diana RPC that connects but never answers the chain id does not hold the action either', async (t) => {
  const real = globalThis.fetch;
  t.after(() => { globalThis.fetch = real; });
  // A CometBFT 0.37 status, as the node sends it; the client keeps the 0.37 connection it opened.
  const status = { node_info: { protocol_version: { p2p: '8', block: '11', app: '0' }, id: 'ab'.repeat(20), listen_addr: 'tcp://0.0.0.0:26656',
    network: 'qorechain-diana', version: '0.37.4', channels: '40', moniker: 'diana', other: { tx_index: 'on', rpc_address: 'tcp://0.0.0.0:26657' } },
  sync_info: { latest_block_hash: 'AB'.repeat(32), latest_app_hash: 'CD'.repeat(32), latest_block_height: '100',
    latest_block_time: '2026-11-22T10:00:00.000000000Z', catching_up: false },
  validator_info: { address: 'EF'.repeat(20), pub_key: { type: 'tendermint/PubKeyEd25519', value: Buffer.alloc(32, 1).toString('base64') }, voting_power: '0' } };
  const asked = [];
  globalThis.fetch = async (url, init) => {
    const { id, method } = JSON.parse(init.body);
    asked.push(method);
    if (asked.length > 1) return new Promise(() => {});      // the chain id is never answered
    return new Response(JSON.stringify({ jsonrpc: '2.0', id, result: status }), { headers: { 'content-type': 'application/json' } });
  };
  const err = await within(1000, broadcast({ cosmos: 'qor1operator' }, [], 'pay', { rpcWaitMs: 30 }).catch((e) => e));
  assert.ok(err instanceof Error, String(err));
  assert.deepEqual(asked, ['status', 'status'], 'connected, then stopped waiting for the chain id; nothing signed');
  assert.deepEqual([broadcastFailure(err).hash, broadcastFailure(err).code], [null, null]);
});

test('through the real SDK signer, a lookup that keeps failing after the node accepted the transaction leaves the user its hash and sends it once', async () => {
  const { account, signer } = await realSigner();
  // The node accepts it; every lookup fails with a text that echoes the hybrid sign-bytes rejection.
  const node = rpcNode(async (tx) => txHashOf(tx), async () => { throw new Error('rpc: ' + HYBRID_SIGN_BYTES_REJECTION_LOG); });
  const transport = withDeadline(quickInclusion(node, { pollMs: 10 }), 100);
  const err = await within(2000, signer.signAndBroadcast(transport, signParams(account)).catch((e) => e));
  assert.ok(err instanceof TimeoutError, String(err));
  assert.equal(node.sent.length, 1, 'an accepted transaction is never re-signed and sent again');
  assert.deepEqual([broadcastFailure(err).hash, broadcastFailure(err).code], [txHashOf(node.sent[0]), null]);
});

// A controlled RPC client in place of StargateClient.connect: when it connects, and whether it answers the chain id.
// Nothing past the connection may reach the network: any request is recorded in `calls.network` and fails.
const controlledRpc = (t, { connectAfterMs = 0, chainIdAnswers = true } = {}) => {
  const real = { connect: StargateClient.connect, fetch: globalThis.fetch };
  t.after(() => { StargateClient.connect = real.connect; globalThis.fetch = real.fetch; });
  const calls = { getChainId: 0, disconnect: 0, network: [] };
  globalThis.fetch = async (url) => { calls.network.push(String(url)); throw new Error('no network in this test'); };
  const rpc = {
    getChainId: () => { calls.getChainId += 1; return chainIdAnswers ? Promise.resolve('never-checked') : new Promise(() => {}); },
    disconnect: () => { calls.disconnect += 1; },
  };
  StargateClient.connect = () => new Promise((r) => setTimeout(() => r(rpc), connectAfterMs));
  return calls;
};

test('a connection that completes after the RPC time limit is closed at once, and no chain id is asked of it', async (t) => {
  const calls = controlledRpc(t, { connectAfterMs: 60 });
  const err = await within(1000, broadcast({ cosmos: 'qor1operator' }, [], 'pay', { rpcWaitMs: 20 }).catch((e) => e));
  assert.match(String(err?.message), /did not answer within/);
  await new Promise((r) => setTimeout(r, 120));      // the connection completes late
  assert.deepEqual(calls, { getChainId: 0, disconnect: 1, network: [] });
});

test('a connection whose chain id is still pending at the RPC time limit is closed at the limit', async (t) => {
  const calls = controlledRpc(t, { chainIdAnswers: false });
  const err = await within(1000, broadcast({ cosmos: 'qor1operator' }, [], 'pay', { rpcWaitMs: 20 }).catch((e) => e));
  assert.match(String(err?.message), /did not answer within/);
  assert.deepEqual(calls, { getChainId: 1, disconnect: 1, network: [] }, 'closed when the caller was released');
});

test('a node on another chain is refused before anything is signed, and its connection is closed', async (t) => {
  const calls = controlledRpc(t);                    // answers a chain id that is not Diana's
  const err = await within(1000, broadcast({ cosmos: 'qor1operator' }, [], 'pay', { rpcWaitMs: 1000 }).catch((e) => e));
  assert.match(String(err?.message), /never-checked/, 'refused for its chain id');
  assert.deepEqual(calls, { getChainId: 1, disconnect: 1, network: [] }, 'and nothing after it was asked');
});
