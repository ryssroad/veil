import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { seal, sealKeysFromSeed } from '@qorechain/qoreseal';
import { encodeQledgerDeposit, encodeQledgerTx, qledgerKeypairFromSeed, signQledgerTx, qledgerSigningMessage, qledgerTxUnsigned, QledgerLedger } from '@qorechain/rdk';
import { ml_dsa44 } from '@noble/post-quantum/ml-dsa.js';
import {
  env, chainId, rollupId, hex, sha256,
  PURPOSE, MAX_BODY_BYTES, DESCRIPTION_MAX_BYTES,
  encodeBody, decodeBody, kemFingerprint, createInvoicePayment, openInvoice,
  encodeReaderStatement, decodeReaderStatement, discoverReaderKeys,
  replayExecutions, coPostedEnvelope, InvoiceImporter, VeilError,
} from './veil.mjs';

const OPERATOR = 'qor1a5j8wjpxpqc6f7htyv92042nrt7gaegpezdhx4';
const code = (c) => (err) => err instanceof VeilError && err.code === c;

function parties() {
  const payer = qledgerKeypairFromSeed(randomBytes(32));
  const payee = qledgerKeypairFromSeed(randomBytes(32));
  const payeeSeal = sealKeysFromSeed(randomBytes(32));
  const auditorSeal = sealKeysFromSeed(randomBytes(32));
  return { payer, payee, payeeSeal, auditorSeal };
}
function pay(p, over = {}) {
  return createInvoicePayment({
    payer: p.payer, nonce: 0, beneficiary: p.payee.accountId, amount: 300000n,
    beneficiaryKem: p.payeeSeal.mlkemPublicKey, auditorKem: p.auditorSeal.mlkemPublicKey,
    id: randomBytes(16).toString('hex'), description: 'Consulting, November', ...over,
  });
}
const auditorKey = (p) => kemFingerprint(p.auditorSeal.mlkemPublicKey);

test('both readers open the invoice; outsiders and other transfers cannot', () => {
  const p = parties();
  const { transfer, envelope } = pay(p);
  const a = openInvoice({ transfer, envelope, sealKeys: p.payeeSeal, auditorKey: auditorKey(p) });
  const b = openInvoice({ transfer, envelope, sealKeys: p.auditorSeal, auditorKey: auditorKey(p) });
  assert.deepEqual(a, b);
  assert.equal(a.invoice.auditorKey, auditorKey(p));
  assert.equal(a.payer, hex(p.payer.accountId));
  assert.throws(() => openInvoice({ transfer, envelope, sealKeys: sealKeysFromSeed(randomBytes(32)), auditorKey: auditorKey(p) }), code('open'));
  const other = encodeQledgerTx(signQledgerTx({ ...env, ...p.payer, to: p.payee.accountId, amount: 300000n, nonce: 1n }));
  assert.throws(() => openInvoice({ transfer: other, envelope, sealKeys: p.payeeSeal, auditorKey: auditorKey(p) }), code('open'));
});

test('strict body schema, checked before sealing', () => {
  const p = parties();
  const good = { version: 2, id: 'a'.repeat(32), description: 'x', amountUqor: '1', beneficiary: 'b'.repeat(64), auditorKey: 'c'.repeat(64) };
  encodeBody(good);
  const bad = [
    { ...good, extra: 1 },
    { ...good, version: 1 },
    { ...good, id: 'A'.repeat(32) },
    { ...good, amountUqor: '0100' },
    { ...good, amountUqor: '0' },
    { ...good, amountUqor: '18446744073709551616' },
    { ...good, beneficiary: 'b'.repeat(63) },
    { ...good, description: 'quote " inside' },
    { ...good, description: 'line\nbreak' },
    { ...good, description: 'd'.repeat(DESCRIPTION_MAX_BYTES + 1) },
  ];
  for (const b of bad) assert.throws(() => encodeBody(b), code('schema'), JSON.stringify(b).slice(0, 60));
  assert.throws(() => pay(p, { description: 'd'.repeat(DESCRIPTION_MAX_BYTES + 1) }), code('schema'));
  // Non-canonical bytes (whitespace, key order) are rejected on import.
  assert.throws(() => decodeBody(Buffer.from(JSON.stringify(good, null, 1))), code('schema'));
  const reordered = { id: good.id, version: 2, description: 'x', amountUqor: '1', beneficiary: good.beneficiary, auditorKey: good.auditorKey };
  assert.throws(() => decodeBody(Buffer.from(JSON.stringify(reordered))), code('schema'));
});

test('worst-case body fits the 6,144-byte post limit', () => {
  const p = parties();
  const longest = 'é'.repeat(DESCRIPTION_MAX_BYTES / 2); // 128 UTF-8 bytes
  const { envelope, body } = pay(p, { amount: 18446744073709551615n, description: longest });
  assert.ok(body.length <= MAX_BODY_BYTES);
  assert.ok(envelope.length <= 6144);
  console.log(`max envelope ${envelope.length} B (body ${body.length} of ${MAX_BODY_BYTES} B)`);
});

test('auditor declaration and slot count are enforced', () => {
  const p = parties();
  const { transfer, envelope } = pay(p);
  assert.throws(() => openInvoice({ transfer, envelope, sealKeys: p.payeeSeal, auditorKey: 'f'.repeat(64) }), code('auditor'));
  // A payer who seals to the recipient alone, or adds a third reader, is rejected.
  const aad = Buffer.from(JSON.stringify([PURPOSE, chainId, rollupId, hex(sha256(transfer))]));
  const signedPlain = Buffer.alloc(2421, 1);
  for (const recipients of [[p.payeeSeal], [p.payeeSeal, p.auditorSeal, sealKeysFromSeed(randomBytes(32))]]) {
    const e = seal({ chainId, purpose: PURPOSE, aad, mode: 'mlkem', anonymous: true,
      recipients: recipients.map((k) => ({ mlkemPublicKey: k.mlkemPublicKey })), plaintext: signedPlain });
    assert.throws(() => openInvoice({ transfer, envelope: e, sealKeys: p.payeeSeal, auditorKey: auditorKey(p) }), code('readers'));
  }
  // Exactly the signature and no body.
  const empty = seal({ chainId, purpose: PURPOSE, aad, mode: 'mlkem', anonymous: true,
    recipients: [p.payeeSeal, p.auditorSeal].map((k) => ({ mlkemPublicKey: k.mlkemPublicKey })), plaintext: Buffer.alloc(2420) });
  assert.throws(() => openInvoice({ transfer, envelope: empty, sealKeys: p.payeeSeal, auditorKey: auditorKey(p) }), code('schema'));
});

test('reader statements: size, substitution, first valid wins, re-post ignored', () => {
  const a = qledgerKeypairFromSeed(randomBytes(32));
  const b = qledgerKeypairFromSeed(randomBytes(32));
  const kemA = sealKeysFromSeed(randomBytes(32)).mlkemPublicKey;
  const kemA2 = sealKeysFromSeed(randomBytes(32)).mlkemPublicKey;
  const kemB = sealKeysFromSeed(randomBytes(32)).mlkemPublicKey;
  const sA = encodeReaderStatement({ keypair: a, kemPublicKey: kemA });
  console.log(`reader statement ${sA.length} B`);
  assert.ok(sA.length <= 6144);
  assert.equal(decodeReaderStatement(sA).account, hex(a.accountId));
  // B signs a statement that claims A's account: rejected.
  const forged = encodeReaderStatement({ keypair: b, kemPublicKey: kemB, account: a.accountId });
  assert.throws(() => decodeReaderStatement(forged), /not the hash of the signing key/);
  // Tampered KEM key: bad signature.
  const tampered = Buffer.from(sA); tampered[tampered.length - 2420 - 10] ^= 1;
  assert.throws(() => decodeReaderStatement(tampered), /bad signature|invalid ML-KEM/);
  // Another rollup.
  assert.throws(() => decodeReaderStatement(encodeReaderStatement({ keypair: a, kemPublicKey: kemA, rollup: 'other' })), /another chain or rollup/);
  // A second valid statement for A (a "rotation") and a re-post of the original change nothing.
  const sA2 = encodeReaderStatement({ keypair: a, kemPublicKey: kemA2 });
  const sB = encodeReaderStatement({ keypair: b, kemPublicKey: kemB });
  const transfer = encodeQledgerTx(signQledgerTx({ ...env, ...a, to: b.accountId, amount: 1n, nonce: 0n }));
  const entries = [sA, forged, transfer, sA2, sB, sA].map((payload, i) => ({ sequence: i + 1, payload }));
  const { bindings, events } = discoverReaderKeys(entries);
  assert.equal(bindings.size, 2);
  assert.equal(bindings.get(hex(a.accountId)).fingerprint, kemFingerprint(kemA));
  assert.equal(bindings.get(hex(b.accountId)).fingerprint, kemFingerprint(kemB));
  assert.deepEqual(events.map((e) => [e.sequence, e.result]), [[1, 'bound'], [2, 'rejected'], [4, 'ignored'], [5, 'bound'], [6, 'ignored']]);
  assert.match(events.find((e) => e.sequence === 6).reason, /re-post/);
});

test('only the exact transfer bytes that executed count; hedged duplicates do not', () => {
  const p = parties();
  const ledger = new QledgerLedger();
  const deposit = { sequence: 1, height: 10n, poster: 'deposit:' + OPERATOR, payload: encodeQledgerDeposit(p.payer.accountId, 1000000n) };
  const { transfer, envelope } = pay(p);
  // Same (nonce, to, amount), different signature bytes. The RDK signer is
  // deterministic, but the chain accepts any valid ML-DSA-44 signature, and a
  // hedged (randomized) signer produces a second valid encoding.
  const fields = { scheme: 1, publicKey: p.payer.publicKey, kind: 1, nonce: 0n, to: p.payee.accountId, amount: 300000n };
  const unsigned = qledgerTxUnsigned(fields);
  const hedged = ml_dsa44.sign(qledgerSigningMessage(chainId, rollupId, unsigned), p.payer.secretKey, { context: Buffer.from('qledger/v1') });
  const twin = encodeQledgerTx({ ...fields, signature: hedged });
  assert.notEqual(hex(twin), hex(transfer));
  const entries = [
    deposit,
    { sequence: 2, height: 11n, poster: OPERATOR, payload: twin },
    { sequence: 3, height: 12n, poster: OPERATOR, payload: transfer },
    { sequence: 4, height: 12n, poster: OPERATOR, payload: envelope },
  ];
  const { executions } = replayExecutions(entries, ledger);
  const byDigest = Object.fromEntries(executions.map((x) => [x.digest, x]));
  assert.equal(byDigest[hex(sha256(twin))].executed, true);
  assert.equal(byDigest[hex(sha256(transfer))].executed, false, 'the invoice-bound transfer was a no-op');
  assert.equal(coPostedEnvelope(entries, 3), entries[3]);
  assert.equal(coPostedEnvelope(entries, 2), undefined);
});

test('importer deduplicates by executed (payer, nonce) and by (payer, invoice id)', () => {
  const imp = new InvoiceImporter();
  const rec = { payer: 'aa', nonce: 1n, transferDigest: 't1', invoice: { id: 'i1', amountUqor: '5' } };
  assert.equal(imp.import(rec).result, 'imported');
  assert.equal(imp.import(rec).result, 'duplicate');
  assert.equal(imp.import({ ...rec, invoice: { id: 'i2', amountUqor: '5' } }).result, 'conflict');
  assert.equal(imp.import({ ...rec, nonce: 2n, transferDigest: 't2' }).result, 'conflict');
  assert.equal(imp.import({ ...rec, payer: 'bb' }).result, 'imported');
  assert.equal(imp.state.conflicts.length, 2);
});

test('two clients in separate directories: payer discovers both keys without local key sharing', () => {
  // Client A (payee) and client B (auditor) each keep their own seeds on disk.
  const dirA = mkdtempSync(join(tmpdir(), 'veil-payee-'));
  const dirB = mkdtempSync(join(tmpdir(), 'veil-auditor-'));
  writeFileSync(join(dirA, 'l2.seed'), randomBytes(32));
  writeFileSync(join(dirA, 'seal.seed'), randomBytes(32));
  writeFileSync(join(dirB, 'seal.seed'), randomBytes(32));
  const payeeKey = qledgerKeypairFromSeed(readFileSync(join(dirA, 'l2.seed')));
  const payeeSeal = sealKeysFromSeed(readFileSync(join(dirA, 'seal.seed')));
  const auditorSeal = sealKeysFromSeed(readFileSync(join(dirB, 'seal.seed')));
  // Public channels only: A posts a statement to the inbox, B registers on chain
  // (simulated here as a public map from its qor1 address to its key).
  const inbox = [{ sequence: 1, payload: encodeReaderStatement({ keypair: payeeKey, kemPublicKey: payeeSeal.mlkemPublicKey }) }];
  const registry = new Map([['qor1auditor', Buffer.from(auditorSeal.mlkemPublicKey)]]);
  const payer = qledgerKeypairFromSeed(randomBytes(32));
  const found = discoverReaderKeys(inbox).bindings.get(hex(payeeKey.accountId));
  const { transfer, envelope } = createInvoicePayment({
    payer, nonce: 0, beneficiary: payeeKey.accountId, amount: 1000n,
    beneficiaryKem: found.kemPublicKey, auditorKem: registry.get('qor1auditor'),
    id: randomBytes(16).toString('hex'), description: 'Two-client test',
  });
  const key = kemFingerprint(registry.get('qor1auditor'));
  const a = openInvoice({ transfer, envelope, sealKeys: sealKeysFromSeed(readFileSync(join(dirA, 'seal.seed'))), auditorKey: key });
  const b = openInvoice({ transfer, envelope, sealKeys: sealKeysFromSeed(readFileSync(join(dirB, 'seal.seed'))), auditorKey: key });
  assert.deepEqual(a.invoice, b.invoice);
});
