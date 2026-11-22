import { parseEnvelope } from '@qorechain/qoreseal';
import { batchChallengeWindow, decodeQledgerDeposit, QLEDGER_DEPOSIT_POSTER_PREFIX } from '@qorechain/rdk';
import { chainId, rollupId, decodeReaderStatement, hex, sha256 } from '../veil.mjs';
import { broadcastFailure } from './chain.mjs';

// For a rejected VRK1, display the claimed identity separately from verified bindings.
function claimedIdentity(bytes) {
  const b = Buffer.from(bytes);
  let offset = 4;
  if (b.toString('ascii', 0, offset) !== 'VRK1') return {};
  for (const expected of [chainId, rollupId]) {
    if (offset + 4 > b.length) return {};
    const n = b.readUInt32BE(offset);
    offset += 4;
    if (n !== Buffer.byteLength(expected) || b.toString('utf8', offset, offset + n) !== expected) return {};
    offset += n;
  }
  if (b.length !== offset + 32 + 1312 + 1568 + 2420) return {};
  return { account: hex(b.subarray(offset, offset + 32)),
    fingerprint: hex(sha256(b.subarray(offset + 32 + 1312, offset + 32 + 1312 + 1568))) };
}

export function classifyEntry(entry, execution, event) {
  const { payload, poster } = entry;
  if (execution) return { kind: execution.kind ?? 'transfer', from: execution.payer, to: execution.to,
    amount: String(execution.amount), nonce: String(execution.nonce), executed: execution.executed };
  if (poster.startsWith(QLEDGER_DEPOSIT_POSTER_PREFIX)) {
    const dep = decodeQledgerDeposit(payload);
    if (dep) return { kind: 'deposit', account: hex(dep.account), amount: String(dep.amount) };
  }
  if (event) {
    const statement = event.result === 'rejected' ? claimedIdentity(payload) : decodeReaderStatement(payload);
    return { kind: 'reader key', ...event, account: statement?.account, fingerprint: statement?.fingerprint };
  }
  try {
    const envelope = parseEnvelope(payload);
    return { kind: 'envelope', bytes: payload.length, slots: envelope.entries.length };
  } catch {
    return { kind: 'other', bytes: payload.length,
      preview: Buffer.from(payload.subarray(0, 72)).toString('utf8').replace(/[^\x20-\x7e]/g, '·') };
  }
}

export function parseQor(value) {
  if (typeof value !== 'string' || !/^(0|[1-9]\d{0,13})(\.\d{1,6})?$/.test(value)) throw new Error('Invalid QOR amount');
  const [whole, fraction = ''] = value.split('.');
  const n = BigInt(whole) * 1000000n + BigInt(fraction.padEnd(6, '0'));
  if (n <= 0n || n >= 2n ** 64n) throw new Error('Amount outside the supported range');
  return n;
}

export function invoicesCsv(rows, batch) {
  const escape = value => {
    const text = String(value ?? '');
    // Keep untrusted invoice text literal in spreadsheet applications.
    const literal = /^\s*[=+@-]|^[\t\r\n]/.test(text) ? "'" + text : text;
    return '"' + literal.replaceAll('"', '""') + '"';
  };
  // Accounting export: settled invoices only (finalized batch, verified receipt).
  const data = rows.filter(r => r.status === 'settled' && (batch == null || String(r.batch) === String(batch)));
  return [['time', 'payer', 'payee', 'amount_uqor', 'description', 'batch', 'status', 'invoice_id'],
    ...data.map(r => [r.time, r.payer, r.invoice.beneficiary, r.invoice.amountUqor, r.invoice.description,
      r.batch, r.status, r.invoice.id])].map(row => row.map(escape).join(',')).join('\r\n') + '\r\n';
}

/**
 * When a batch's challenge window closes, by the chain's own rule (RDK
 * `batchChallengeWindow`): Unix seconds for a batch with a submission time, a
 * block height (`floor(windowSecs / 6)` blocks) for one without.
 */
export function batchDeadline(batch, windowSecs) {
  const w = batchChallengeWindow(batch, windowSecs, { height: batch.submittedAt, timeSecs: batch.submittedTime ?? 0 });
  return { deadline: w.deadlineSecs ?? null, deadlineHeight: w.deadlineHeight ?? null };
}

/**
 * The server's own reads of Diana, with no browser asking. A configured
 * watcher polls for as long as the server runs: a challenge window can pass
 * entirely while no tab is open. A Desk payment is read on every tick until
 * both readers determine it, then at the slow cadence until it settles.
 * `read` must not throw.
 */
export function startPolling({ read, measuring, settling = () => false, watching, recording, everyMs = 1000 }) {
  let tick = 0;
  const isRecording = typeof recording === 'function' ? recording : () => recording;
  if (watching || isRecording()) void read();
  return setInterval(() => {
    tick += 1;
    if (measuring() || ((watching || isRecording() || settling()) && tick % 3 === 0)) void read();
  }, everyMs);
}

/**
 * What Desk answers when an action fails. A transaction the node accepted is
 * always reported with its hash: rejected with its code, or submitted with an
 * unknown result, so the user checks the inbox instead of paying again. One
 * the node never confirmed receiving says so, with its hash all the same.
 */
export function actionFailure(err, { input = false } = {}) {
  if (input) return { status: 400, result: { error: err.message } };
  const failed = broadcastFailure(err);
  if (failed.hash && failed.code != null) {
    return { status: 502, result: { hash: failed.hash, code: failed.code, height: failed.height, error: 'Transaction rejected.' } };
  }
  if (failed.hash && err?.unconfirmed) {
    return { status: 502, result: { hash: failed.hash,
      error: 'Transaction sent, but the node did not confirm receiving it; its result is not known yet. Check the inbox before retrying.' } };
  }
  if (failed.hash) {
    return { status: 502, result: { hash: failed.hash, error: 'Transaction submitted; its result is not known yet. Check the inbox before retrying.' } };
  }
  return { status: 502, result: { error: 'Action failed. Check the operator, payer balance and reader binding before retrying.' } };
}
