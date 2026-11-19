import { parseEnvelope } from '@qorechain/qoreseal';
import { decodeQledgerDeposit, QLEDGER_DEPOSIT_POSTER_PREFIX } from '@qorechain/rdk';
import { chainId, rollupId, decodeReaderStatement, hex, sha256 } from '../veil.mjs';

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
  if (execution) return { kind: 'transfer', from: execution.payer, to: execution.to,
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
  const data = rows.filter(r => r.status === 'verified' && (batch == null || String(r.batch) === String(batch)));
  return [['time', 'payer', 'payee', 'amount_uqor', 'description', 'batch', 'status', 'invoice_id'],
    ...data.map(r => [r.time, r.payer, r.invoice.beneficiary, r.invoice.amountUqor, r.invoice.description,
      r.batch, r.status, r.invoice.id])].map(row => row.map(escape).join(',')).join('\r\n') + '\r\n';
}
