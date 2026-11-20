// Desk with a watcher account (#12, review of PR 13): challenge delivery
// recovers from a transient RPC failure while the chain view is unchanged.
import test from 'node:test';
import assert from 'node:assert/strict';
import { deskFixture, OPERATOR } from './fixture.mjs';

test('snapshot with a watcher: a failed challenge is retried on an unchanged view and stops when the batch is rejected', async (t) => {
  const { snapshot, deps, watching, view, batch } = await deskFixture(t, { watcher: true });
  assert.equal(watching, true);
  let clock = 1_800_000_100_000;
  const sent = [];
  deps.now = () => clock;
  deps.challenge = async (watcher, index, proofHex) => {
    sent.push({ from: watcher.cosmos, index, proofHex });
    if (sent.length === 1) throw new Error('fetch failed');
    return { hash: 'D'.repeat(64), code: 0, height: 25 };
  };
  deps.txResult = async () => assert.fail('no unknown broadcast in this run');
  const b0 = view.batches[0];
  const forged = batch(1, 2, 4, { stateRoot: 'ee'.repeat(32) });
  view.set([b0, forged], 4);

  let s = await snapshot();
  assert.equal(s.payee.rows[0].status, 'disputed');
  assert.deepEqual([s.incidents[0].ours.state, s.incidents[0].ours.attempts], ['retrying', 1]);
  assert.notEqual(sent[0].from, OPERATOR);
  assert.match(sent[0].proofHex, /^[0-9a-f]+$/);

  clock += 1000;
  s = await snapshot();           // same view, inside the backoff
  assert.equal(sent.length, 1);
  clock += 5000;
  s = await snapshot();           // same view: the retry does not wait for a new block
  assert.equal(sent.length, 2);
  assert.deepEqual([s.incidents[0].ours.state, s.incidents[0].ours.hash], ['included', 'D'.repeat(64)]);
  assert.equal(s.payee.rows[0].status, 'disputed', 'until the chain view shows the rejection');

  view.set([b0, { ...forged, status: 'rejected' }], 2);
  clock += 3000;
  s = await snapshot();
  assert.equal(s.payee.rows[0].status, 'determined');
  assert.equal(s.incidents[0].status, 'rejected');
  clock += 120_000;
  await snapshot();
  assert.equal(sent.length, 2);
});
