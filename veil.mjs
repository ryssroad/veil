// Veil v1: sealed invoices for qledger-v1 payments, frozen scope of issues #1 and #2.
//
// Invoice (body version 2)
//   - Sealed with QoreSeal (ML-KEM-1024, anonymous) to exactly two readers: the
//     beneficiary and one auditor. AAD binds purpose, chain, rollup and
//     sha256(transfer bytes).
//   - Plaintext = payer ML-DSA-44 signature (2420 B) || canonical JSON body.
//   - The body names the auditor by `auditorKey` = sha256(auditor ML-KEM-1024 key).
//     This is the payer's declaration of the intended auditor; a reader cannot
//     prove that the second slot really opens with that key.
//   - The transfer and its envelope are co-posted in one L1 transaction, so the
//     envelope is the inbox entry right after the transfer, same height and poster.
//
// Reader key statement ("VRK1", binary)
//   - Binds an L2 account to its ML-KEM-1024 reader key, signed by the account's
//     ML-DSA-44 key under context `veil-reader-key-v1`.
//   - The first valid statement per account in inbox order is the binding; later
//     ones, including re-posts of the original, are ignored. Rotation is future work.
import { createHash } from 'node:crypto';
import { ml_dsa44 } from '@noble/post-quantum/ml-dsa.js';
import { seal, open, parseEnvelope, envelopeSize, validateMlkemPublicKey } from '@qorechain/qoreseal';
import {
  decodeQledgerTx,
  encodeQledgerTx,
  executeQledger,
  qledgerAccountId,
  signQledgerTx,
  verifyQledgerTx,
  QledgerLedger,
  QLEDGER_KIND_TRANSFER,
  QLEDGER_KIND_WITHDRAW,
  QLEDGER_MAX_POST_BYTES,
} from '@qorechain/rdk';

export const chainId = 'qorechain-diana';
export const rollupId = 'veil-pay-1';
export const env = { chainId, rollupId };
export const hex = (b) => Buffer.from(b).toString('hex');
export const sha256 = (b) => createHash('sha256').update(b).digest();

export const PURPOSE = 'veil-invoice-v1';
const INVOICE_CONTEXT = Buffer.from(PURPOSE);
export const SIG = 2420;
export const READERS = 2;
export const BODY_VERSION = 2;
export const DESCRIPTION_MAX_BYTES = 128;
// 56 + 2 * 1632 + 2420 = 5740 B of envelope before the body.
export const MAX_BODY_BYTES = QLEDGER_MAX_POST_BYTES - envelopeSize({ mode: 'mlkem', recipients: READERS, plaintextLength: SIG });

const HEX32 = /^[0-9a-f]{32}$/;
const HEX64 = /^[0-9a-f]{64}$/;
const DECIMAL = /^(0|[1-9][0-9]{0,19})$/;
// Printable text without `"` or `\`, so the canonical JSON never escapes it and
// the worst-case body stays under MAX_BODY_BYTES.
const DESCRIPTION = /^[^\u0000-\u001f\u007f"\\]*$/u;
const BODY_KEYS = ['version', 'id', 'description', 'amountUqor', 'beneficiary', 'auditorKey'];

export class VeilError extends Error {
  constructor(code, message) {
    super(`${code}: ${message}`);
    this.code = code;
  }
}
const fail = (code, message) => { throw new VeilError(code, message); };
const check = (ok, code, message) => { if (!ok) fail(code, message); };

/** ML-KEM-1024 encapsulation key as bytes; rejects hex strings and other shapes. */
export function kemKeyBytes(key) {
  check(key instanceof Uint8Array, 'key', `an ML-KEM-1024 key must be bytes, got ${typeof key}`);
  check(key.length === 1568, 'key', `an ML-KEM-1024 key is 1568 bytes, got ${key.length}`);
  try {
    validateMlkemPublicKey(key);
  } catch {
    fail('key', 'invalid ML-KEM-1024 key');
  }
  return Buffer.from(key);
}

/** The key from an RDK registry view (`getKemKey`), whose publicKey is a hex string. */
export function kemKeyFromRegistry(view) {
  check(view && typeof view.publicKey === 'string' && /^[0-9a-fA-F]{3136}$/.test(view.publicKey), 'key',
    'registry view has no 1568-byte hex public key');
  check(view.algorithmId === 2, 'key', `registry key algorithm ${view.algorithmId} is not ML-KEM-1024`);
  return kemKeyBytes(Buffer.from(view.publicKey, 'hex'));
}

export function kemFingerprint(kemPublicKey) {
  return hex(sha256(kemKeyBytes(kemPublicKey)));
}

function aadFor(transfer) {
  return Buffer.from(JSON.stringify([PURPOSE, chainId, rollupId, hex(sha256(transfer))]));
}
function invoiceMessage(aad, body) {
  return sha256(Buffer.concat([aad, Buffer.from([0]), body]));
}

/** Canonical body bytes, or a VeilError naming the first violation. */
export function encodeBody(invoice) {
  check(invoice && typeof invoice === 'object' && !Array.isArray(invoice), 'schema', 'body is not an object');
  const keys = Object.keys(invoice);
  check(keys.length === BODY_KEYS.length && BODY_KEYS.every((k) => keys.includes(k)), 'schema',
    `body keys must be exactly ${BODY_KEYS.join(', ')}`);
  check(invoice.version === BODY_VERSION, 'schema', 'version must be 2');
  check(typeof invoice.id === 'string' && HEX32.test(invoice.id), 'schema', 'id must be 32 lowercase hex');
  check(typeof invoice.description === 'string' && DESCRIPTION.test(invoice.description), 'schema',
    'description must be printable text without quotes, backslashes or control characters');
  check(Buffer.byteLength(invoice.description, 'utf8') <= DESCRIPTION_MAX_BYTES, 'schema',
    `description is longer than ${DESCRIPTION_MAX_BYTES} bytes`);
  check(typeof invoice.amountUqor === 'string' && DECIMAL.test(invoice.amountUqor) && invoice.amountUqor !== '0'
    && BigInt(invoice.amountUqor) < 1n << 64n, 'schema', 'amountUqor must be a positive decimal u64 without leading zeros');
  check(typeof invoice.beneficiary === 'string' && HEX64.test(invoice.beneficiary), 'schema', 'beneficiary must be 64 lowercase hex');
  check(typeof invoice.auditorKey === 'string' && HEX64.test(invoice.auditorKey), 'schema', 'auditorKey must be 64 lowercase hex');
  const body = Buffer.from(JSON.stringify(Object.fromEntries(BODY_KEYS.map((k) => [k, invoice[k]]))));
  check(body.length <= MAX_BODY_BYTES, 'size', `body is ${body.length} B, limit ${MAX_BODY_BYTES}`);
  return body;
}

/** Strictly parse body bytes: must be exactly the canonical encoding. */
export function decodeBody(body) {
  check(body.length <= MAX_BODY_BYTES, 'size', `body is ${body.length} B, limit ${MAX_BODY_BYTES}`);
  let invoice;
  try {
    invoice = JSON.parse(Buffer.from(body).toString('utf8'));
  } catch {
    fail('schema', 'body is not JSON');
  }
  check(encodeBody(invoice).equals(Buffer.from(body)), 'schema', 'body is not canonical');
  return invoice;
}

/**
 * Payer side. Signs a qledger transfer and seals the invoice to the beneficiary's
 * reader key and the auditor's registered key. Validates everything, including
 * the serialized envelope size, before sealing.
 */
export function createInvoicePayment({ payer, nonce, beneficiary, amount, beneficiaryKem, auditorKem, id, description }) {
  beneficiaryKem = kemKeyBytes(beneficiaryKem);
  auditorKem = kemKeyBytes(auditorKem);
  const transfer = encodeQledgerTx(signQledgerTx({ ...env, ...payer, to: beneficiary, amount: BigInt(amount), nonce: BigInt(nonce) }));
  const body = encodeBody({
    version: BODY_VERSION,
    id,
    description,
    amountUqor: String(amount),
    beneficiary: hex(beneficiary),
    auditorKey: kemFingerprint(auditorKem),
  });
  const size = envelopeSize({ mode: 'mlkem', recipients: READERS, plaintextLength: SIG + body.length });
  check(size <= QLEDGER_MAX_POST_BYTES, 'size', `envelope would be ${size} B, limit ${QLEDGER_MAX_POST_BYTES}`);
  const aad = aadFor(transfer);
  const signature = ml_dsa44.sign(invoiceMessage(aad, body), payer.secretKey, { context: INVOICE_CONTEXT });
  const envelope = seal({
    chainId, purpose: PURPOSE, aad, mode: 'mlkem', anonymous: true,
    recipients: [{ mlkemPublicKey: beneficiaryKem }, { mlkemPublicKey: auditorKem }],
    plaintext: Buffer.concat([signature, body]),
  });
  check(envelope.length === size, 'size', 'envelope size differs from the computed size');
  return { transfer, envelope, body };
}

/**
 * Reader side, cryptographic part of the acceptance rule (#1 items 1-3):
 * opens the envelope, checks the payer signature, the strict body, amount,
 * beneficiary, exactly two slots and the declared auditor key.
 */
export function openInvoice({ transfer, envelope, sealKeys, auditorKey }) {
  const tx = decodeQledgerTx(transfer);
  check(tx && tx.kind === QLEDGER_KIND_TRANSFER && verifyQledgerTx(tx, chainId, rollupId), 'transfer', 'not a valid signed qledger transfer');
  let parsed;
  try {
    parsed = parseEnvelope(envelope);
  } catch {
    fail('envelope', 'not a QoreSeal envelope');
  }
  check(parsed.mode === 'mlkem', 'envelope', 'mode must be mlkem');
  check(parsed.entries.length === READERS, 'readers', `envelope has ${parsed.entries.length} slots, expected ${READERS}`);
  const aad = aadFor(transfer);
  let plain;
  try {
    plain = open({ chainId, purpose: PURPOSE, aad, envelope, keys: sealKeys });
  } catch {
    fail('open', 'this key cannot open the envelope for this transfer');
  }
  check(plain.length > SIG, 'schema', 'plaintext has no body');
  const body = plain.subarray(SIG);
  check(ml_dsa44.verify(plain.subarray(0, SIG), invoiceMessage(aad, body), tx.publicKey, { context: INVOICE_CONTEXT }),
    'signature', 'invoice is not signed by the payer of the transfer');
  const invoice = decodeBody(body);
  check(invoice.amountUqor === tx.amount.toString(), 'amount', 'amount differs from the transfer');
  check(invoice.beneficiary === hex(tx.to), 'beneficiary', 'beneficiary differs from the transfer');
  check(invoice.auditorKey === auditorKey, 'auditor', 'invoice declares a different auditor key');
  return {
    invoice,
    payer: hex(qledgerAccountId(tx.publicKey)),
    nonce: tx.nonce,
    transferDigest: hex(sha256(transfer)),
    envelopeDigest: hex(sha256(envelope)),
  };
}

// ---------------------------------------------------------------- reader keys (#2)

const VRK_MAGIC = Buffer.from('VRK1');
const VRK_CONTEXT = Buffer.from('veil-reader-key-v1');
const PK = 1312;
const KEM = 1568;
const u32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32BE(n); return b; };
const lp = (s) => { const b = Buffer.from(s, 'utf8'); return Buffer.concat([u32(b.length), b]); };

/** A statement signed by the L2 account key; anyone may post it to the inbox. */
export function encodeReaderStatement({ keypair, kemPublicKey, account = qledgerAccountId(keypair.publicKey), chain = chainId, rollup = rollupId }) {
  kemPublicKey = kemKeyBytes(kemPublicKey);
  const unsigned = Buffer.concat([VRK_MAGIC, lp(chain), lp(rollup), Buffer.from(account), Buffer.from(keypair.publicKey), Buffer.from(kemPublicKey)]);
  const signature = ml_dsa44.sign(sha256(unsigned), keypair.secretKey, { context: VRK_CONTEXT });
  const out = Buffer.concat([unsigned, signature]);
  check(out.length <= QLEDGER_MAX_POST_BYTES, 'size', `statement is ${out.length} B`);
  return out;
}

/** Parse and verify a statement; returns undefined for payloads that are not statements. */
export function decodeReaderStatement(payload) {
  const b = Buffer.from(payload);
  if (b.length < 4 || !b.subarray(0, 4).equals(VRK_MAGIC)) return undefined;
  let p = 4;
  const str = () => {
    check(b.length >= p + 4, 'statement', 'truncated');
    const n = b.readUInt32BE(p); p += 4;
    check(n <= 64 && b.length >= p + n, 'statement', 'truncated');
    const s = b.subarray(p, p + n).toString('utf8'); p += n;
    return s;
  };
  const chain = str();
  const rollup = str();
  check(b.length === p + 32 + PK + KEM + SIG, 'statement', 'wrong length');
  const account = b.subarray(p, p + 32); p += 32;
  const publicKey = b.subarray(p, p + PK); p += PK;
  const kemPublicKey = b.subarray(p, p + KEM); p += KEM;
  const signature = b.subarray(p);
  check(chain === chainId && rollup === rollupId, 'statement', 'for another chain or rollup');
  check(hex(qledgerAccountId(publicKey)) === hex(account), 'statement', 'account is not the hash of the signing key');
  check(ml_dsa44.verify(signature, sha256(b.subarray(0, b.length - SIG)), publicKey, { context: VRK_CONTEXT }), 'statement', 'bad signature');
  try {
    validateMlkemPublicKey(kemPublicKey);
  } catch {
    fail('statement', 'invalid ML-KEM-1024 key');
  }
  return { account: hex(account), kemPublicKey: Buffer.from(kemPublicKey), fingerprint: kemFingerprint(kemPublicKey), digest: hex(sha256(b)) };
}

/**
 * First valid statement per account wins. `entries` are inbox entries in order,
 * each { sequence, payload }. Returns the bindings and every statement-shaped
 * entry that was rejected or ignored, with the reason.
 */
export function discoverReaderKeys(entries) {
  const bindings = new Map();
  const events = [];
  for (const e of entries) {
    let s;
    try {
      s = decodeReaderStatement(e.payload);
    } catch (err) {
      events.push({ sequence: e.sequence, result: 'rejected', reason: err.message });
      continue;
    }
    if (!s) continue;
    const first = bindings.get(s.account);
    if (first) {
      events.push({ sequence: e.sequence, account: s.account, result: 'ignored',
        reason: s.digest === first.digest ? 're-post of the binding statement' : 'account already bound by an earlier statement' });
      continue;
    }
    bindings.set(s.account, { ...s, sequence: e.sequence });
    events.push({ sequence: e.sequence, account: s.account, result: 'bound', fingerprint: s.fingerprint });
  }
  return { bindings, events };
}

// ------------------------------------------------------------ execution and import

/**
 * Replays inbox entries one at a time from a parent ledger and records, for each
 * qledger transfer, whether those exact bytes executed (advanced the payer nonce
 * and moved the amount). Withdrawal verdicts come from the RDK withdrawal emitted
 * for that entry and are kept separate from the invoice reader’s transfers.
 */
export function replayExecutions(entries, ledger = new QledgerLedger()) {
  const out = [];
  const withdrawals = [];
  for (const e of entries) {
    const tx = decodeQledgerTx(e.payload);
    const from = tx ? qledgerAccountId(tx.publicKey) : undefined;
    const before = from ? ledger.get(from) : undefined;
    const toBefore = tx?.to ? ledger.get(tx.to) : undefined;
    const result = executeQledger(env, ledger, [e]);
    if (tx?.kind === QLEDGER_KIND_WITHDRAW) {
      withdrawals.push({ kind: 'withdrawal', sequence: e.sequence, payer: hex(from), to: tx.recipient,
        nonce: tx.nonce, amount: tx.amount, executed: result.withdrawals.length === 1 });
      continue;
    }
    if (!tx || tx.kind !== QLEDGER_KIND_TRANSFER) continue;
    const after = ledger.get(from);
    const toAfter = ledger.get(tx.to);
    const executed = after.nonce === before.nonce + 1n && tx.nonce === before.nonce
      && (hex(from) === hex(tx.to) || (before.balance - after.balance === tx.amount && toAfter.balance - toBefore.balance === tx.amount));
    out.push({ sequence: e.sequence, digest: hex(sha256(e.payload)), payer: hex(from), nonce: tx.nonce,
      to: hex(tx.to), amount: tx.amount, executed });
  }
  return { executions: out, withdrawals, ledger };
}

/** The co-posted envelope of a transfer: the next entry, same height and poster. */
export function coPostedEnvelope(entries, transferSequence) {
  const i = entries.findIndex((e) => e.sequence === transferSequence);
  const t = entries[i];
  const n = entries[i + 1];
  if (!t || !n || n.sequence !== t.sequence + 1 || BigInt(n.height) !== BigInt(t.height) || n.poster !== t.poster) return undefined;
  return n;
}

/**
 * Deduplicating importer (#1 item 6). Payment key: chain/rollup/payer/executed
 * nonce. Invoice key: chain/rollup/payer/invoice id. An exact re-import is
 * idempotent; a different association for either key is a conflict.
 */
export class InvoiceImporter {
  constructor(state = { payments: {}, invoices: {}, conflicts: [] }) {
    this.state = state;
  }
  import(record) {
    const base = `${chainId}/${rollupId}/${record.payer}`;
    const paymentKey = `${base}/${record.nonce}`;
    const invoiceKey = `${base}/${record.invoice.id}`;
    const value = { transferDigest: record.transferDigest, invoiceId: record.invoice.id, body: JSON.stringify(record.invoice) };
    const p = this.state.payments[paymentKey];
    const i = this.state.invoices[invoiceKey];
    const same = (x) => x && x.transferDigest === value.transferDigest && x.body === value.body;
    if (p || i) {
      if (same(p) && same(i)) return { result: 'duplicate', paymentKey };
      const conflict = { paymentKey, invoiceKey, existing: p ?? i, incoming: value };
      this.state.conflicts.push(conflict);
      return { result: 'conflict', ...conflict };
    }
    this.state.payments[paymentKey] = value;
    this.state.invoices[invoiceKey] = value;
    return { result: 'imported', paymentKey };
  }
}
