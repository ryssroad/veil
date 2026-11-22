// A Desk payment the node accepted whose result never came back (#12, second
// review of PR 15): the payer is told its hash, and the measurement survives.
import test from 'node:test';
import assert from 'node:assert/strict';
import { TimeoutError } from '@cosmjs/stargate';
import { deskFixture, PAY_TX } from './fixture.mjs';
import { actionFailure } from './model.mjs';
import { quickInclusion } from './chain.mjs';

test('an accepted Pay that times out is answered with its hash and stays in the finality report', async (t) => {
  const { snapshot, beginPayment, measuredPay, measuring, settling, finalityReport } = await deskFixture(t);
  const clickAt = Date.now() - 100;
  const end = beginPayment(clickAt);
  let broadcasts = 0;
  // The transport accepts the transaction and then never learns its result.
  const send = async () => {
    broadcasts += 1;
    throw Object.assign(new TimeoutError(`Transaction with ID ${PAY_TX} was submitted but was not yet found on the chain.`, PAY_TX),
      { handedAt: clickAt + 1700 });
  };
  const err = await measuredPay(clickAt, send).catch((e) => e);
  end();
  assert.ok(err instanceof TimeoutError);
  assert.deepEqual(actionFailure(err), { status: 502,
    result: { hash: PAY_TX, error: 'Transaction submitted; its result is not known yet. Check the inbox before retrying.' } });

  // Registered at once, before any reader has seen it.
  let report = await finalityReport();
  assert.equal(report.measurements.length, 1);
  assert.deepEqual([report.measurements[0].tx, report.measurements[0].clickAt, report.measurements[0].committed.height,
    report.measurements[0].payee.determined], [PAY_TX, clickAt, null, null]);
  assert.equal(measuring(), true);

  // Desk then observes the transaction in a committed block.
  let s = await snapshot();
  assert.deepEqual([s.payee.rows[0].tx, s.payee.rows[0].status, s.auditor.rows[0].status], [PAY_TX, 'determined', 'determined']);
  assert.equal(s.payee.rows[0].clickAt, clickAt);
  const first = { payee: s.payee.rows[0].observed.determined, auditor: s.auditor.rows[0].observed.determined };
  assert.ok(first.payee && first.auditor);
  report = await finalityReport();
  assert.equal(report.measurements.length, 1);
  const m = report.measurements[0];
  assert.deepEqual([m.tx, m.clickAt, m.handedToNodeAt, m.committed.height, m.payee.determined, m.auditor.determined],
    [PAY_TX, clickAt, clickAt + 1700, '12', first.payee, first.auditor]);
  assert.equal(measuring(), false);
  assert.equal(settling(), true, 'still followed to settlement');

  // Another poll: one measurement, the same timestamps, one broadcast.
  await new Promise((r) => setTimeout(r, 15));
  s = await snapshot();
  report = await finalityReport();
  assert.equal(report.measurements.length, 1);
  assert.deepEqual([report.measurements[0].payee.determined, report.measurements[0].auditor.determined], [first.payee, first.auditor]);
  assert.equal(broadcasts, 1);

  // A payment the chain rejected is reported with its code and is not a measurement.
  const rejected = Object.assign(new Error('insufficient fee'), { name: 'QoreTxError', txHash: '7'.repeat(64), code: 13 });
  const again = await measuredPay(Date.now(), async () => { throw rejected; }).catch((e) => e);
  assert.deepEqual(actionFailure(again), { status: 502,
    result: { hash: '7'.repeat(64), code: 13, height: undefined, error: 'Transaction rejected.' } });
  assert.equal((await finalityReport()).measurements.length, 1);
});

test('action failures: input errors, and failures with no transaction', () => {
  assert.deepEqual(actionFailure(new Error('Invalid payee account.'), { input: true }), { status: 400, result: { error: 'Invalid payee account.' } });
  const none = actionFailure(Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }));
  assert.equal(none.status, 502);
  assert.equal(none.result.hash, undefined);
  assert.match(none.result.error, /^Action failed/);
});

test('a Pay the node never confirmed receiving is answered with its hash, asks to check the inbox, and keeps handedToNodeAt null', async (t) => {
  const { beginPayment, measuredPay, finalityReport } = await deskFixture(t);
  const signed = Uint8Array.of(9, 9, 9);
  // sha256(09 09 09), derived outside this code.
  const hash = 'E740A6FAF2DB65F5853148D75D9A335D7C4B94AB106FE5F237BC34FDCFC74584';
  let sent = 0;
  const transport = quickInclusion({ broadcastTxSync: () => { sent += 1; return new Promise(() => {}); }, getTx: async () => null },
    { submitTimeoutMs: 30 });
  // What broadcast() does around the transport: a confirmed hand-over time, when there is one, travels with the error.
  const send = async () => {
    try { return await transport.broadcastTx(signed); } catch (err) {
      if (transport.handedAt !== undefined) err.handedAt ??= transport.handedAt;
      throw err;
    }
  };
  const clickAt = Date.now();
  const end = beginPayment(clickAt);
  let guard;
  const err = await Promise.race([measuredPay(clickAt, send).catch((e) => e),
    new Promise((_, reject) => { guard = setTimeout(() => reject(new Error('Pay is still waiting after 1000 ms')), 1000); })])
    .finally(() => { clearTimeout(guard); end(); });
  assert.deepEqual(actionFailure(err), { status: 502, result: { hash,
    error: 'Transaction sent, but the node did not confirm receiving it; its result is not known yet. Check the inbox before retrying.' } });
  const m = (await finalityReport()).measurements.find((x) => x.tx === hash);
  assert.ok(m, 'registered under its hash, so the report does not lose it if it lands');
  assert.deepEqual([m.clickAt, m.handedToNodeAt, m.committed.height], [clickAt, null, null]);
  assert.equal(sent, 1);
});
