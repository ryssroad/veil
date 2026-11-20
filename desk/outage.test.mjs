// Desk with a watcher account (#12, second review of PR 13): a challenge is
// delivered as soon as the batch replay succeeds, whatever happens to the data
// the readers display.
import test from 'node:test';
import assert from 'node:assert/strict';
import { deskFixture } from './fixture.mjs';

test('a block-header outage fails the reader rows but not the challenge', async (t) => {
  const { snapshot, deps, view, batch } = await deskFixture(t, { watcher: true });
  const sent = [];
  deps.challenge = async (watcher, index) => { sent.push(index); return { hash: 'D'.repeat(64), code: 0, height: 25 }; };
  deps.txResult = async () => assert.fail('the result is known');
  const b0 = view.batches[0];
  const forged = batch(1, 2, 4, { stateRoot: 'ee'.repeat(32) });
  view.set([b0, forged], 4);

  // Only the header lookup that timestamps an invoice is down.
  const headers = globalThis.fetch;
  let headerCalls = 0;
  globalThis.fetch = async (url) => {
    assert.match(String(url), /\/blocks\/\d+$/);
    headerCalls += 1;
    return { ok: false, status: 503, json: async () => ({}) };
  };
  await assert.rejects(snapshot(), /HTTP 503/);
  assert.deepEqual(sent, [1], 'challenged on the first poll');
  await assert.rejects(snapshot(), /HTTP 503/);
  assert.deepEqual(sent, [1], 'not duplicated on the second');
  assert.ok(headerCalls >= 2);

  // Headers back: the rows appear, with the challenge already delivered.
  globalThis.fetch = headers;
  const s = await snapshot();
  assert.equal(s.payee.rows[0].status, 'disputed');
  assert.deepEqual([s.incidents[0].ours.state, s.incidents[0].ours.attempts], ['included', 1]);
  assert.deepEqual(sent, [1]);
});
