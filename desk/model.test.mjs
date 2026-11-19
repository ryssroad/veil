import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { encodeQledgerDeposit, qledgerKeypairFromSeed } from '@qorechain/rdk';
import { seal, sealKeysFromSeed } from '@qorechain/qoreseal';
import { classifyEntry, invoicesCsv, parseQor } from './model.mjs';
import { readInvoices } from './chain.mjs';
import { chainId, createInvoicePayment, kemFingerprint, replayExecutions } from '../veil.mjs';

const account = 'ab'.repeat(32);
test('only the RDK deposit poster credits a deposit-shaped payload', () => {
  const payload = encodeQledgerDeposit(account, 2000000);
  assert.deepEqual(classifyEntry({ payload, poster: 'deposit:qor1test' }), { kind: 'deposit', amount: '2000000', account });
  assert.equal(classifyEntry({ payload, poster: 'qor1test' }).kind, 'other');
});
test('classification retains the replay verdict for transfers and discovery failures', () => {
  const entry = { payload: Buffer.from('example'), poster: 'qor1test' };
  const execution = { payer: account, to: account, nonce: 0n, amount: 1n, executed: false };
  assert.deepEqual(classifyEntry(entry, execution), { kind: 'transfer', from: account, to: account,
    amount: '1', nonce: '0', executed: false });
  const event = { sequence: 8, result: 'rejected', reason: 'statement: truncated' };
  assert.equal(classifyEntry(entry, undefined, event).reason, event.reason);
});
test('public envelope rows contain only opaque metadata', () => {
  const keys = sealKeysFromSeed(Buffer.alloc(32, 1));
  const payload = seal({ chainId, purpose: 'test', mode: 'mlkem', anonymous: true,
    recipients: [{ mlkemPublicKey: keys.mlkemPublicKey }], plaintext: Buffer.from('private invoice') });
  assert.deepEqual(classifyEntry({ payload, poster: 'qor1test' }), { kind: 'envelope', bytes: payload.length, slots: 1 });
});
test('unknown bytes have a bounded printable preview', () => {
  const row = classifyEntry({ poster: 'qor1test', payload: Buffer.from('probe\x01' + 'a'.repeat(100)) });
  assert.equal(row.preview.length, 72);
  assert.ok(row.preview.startsWith('probe·'));
});
test('CSV includes only verified invoices, supports batch zero and quotes text', () => {
  const row = { time: '2026-11-18', payer: 'payer', batch: 0, status: 'verified',
    invoice: { beneficiary: 'payee', amountUqor: '300000', description: '=SUM(3,4) "test"', id: 'id' } };
  const rows = [row, { ...row, batch: 1 }, ...['conflict','pending','submitted','unverified'].map(status => ({ ...row, status }))];
  assert.equal(invoicesCsv(rows, '0').trimEnd().split('\r\n').length, 2);
  assert.equal(invoicesCsv(rows).trimEnd().split('\r\n').length, 3);
  assert.ok(invoicesCsv(rows, '0').includes(`"'=SUM(3,4) ""test"""`));
  assert.equal(invoicesCsv([], null).trimEnd().split('\r\n').length, 1);
});
test('QOR parsing is exact and bounded by the qledger uint64', () => {
  assert.equal(parseQor('0.000001'), 1n);
  assert.equal(parseQor('2'), 2000000n);
  assert.equal(parseQor('18446744073709.551615'), 2n ** 64n - 1n);
  for (const v of ['0','-1','+1','0.0000001','1e3','18446744073709.551616', null]) assert.throws(() => parseQor(v));
});

test('reader keeps the invoice visible through finality and imports only a valid finalized receipt', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'veil-reader-'));
  t.after(() => rmSync(dir, { recursive: true }));
  const payer = qledgerKeypairFromSeed(Buffer.alloc(32, 4));
  const auditor = sealKeysFromSeed(Buffer.alloc(32, 5));
  const receiver = sealKeysFromSeed(Buffer.alloc(32, 6));
  const { transfer, envelope } = createInvoicePayment({ payer, nonce: 0, amount: 10n,
    beneficiary: Buffer.from(account, 'hex'), beneficiaryKem: receiver.mlkemPublicKey,
    auditorKem: auditor.mlkemPublicKey, id: 'f'.repeat(32), description: 'Services' });
  const entries = [
    { sequence: 1, height: 1, poster: 'deposit:demo', payload: encodeQledgerDeposit(payer.accountId, 10n) },
    { sequence: 2, height: 2, poster: 'demo', payload: transfer },
    { sequence: 3, height: 2, poster: 'demo', payload: envelope },
  ];
  const params = { dir, entries, executions: replayExecutions(entries).executions,
    mine: account, sealKeys: receiver, auditorKey: kemFingerprint(auditor.mlkemPublicKey) };
  const batch = { batchIndex: 0, inboxStart: 0, inboxEnd: 3, status: 'submitted' };
  const withoutReceipt = () => assert.fail('premature receipt lookup');
  for (const [all, status] of [[[], 'pending'], [[batch], 'submitted']]) {
    const report = await readInvoices({ ...params, all, receiptFor: withoutReceipt });
    assert.equal(report.rows[0].status, status);
    assert.equal(report.rows[0].invoice.description, 'Services');
    assert.equal(report.accepted.length, 0);
  }
  batch.status = 'finalized';
  const scan = valid => readInvoices({ ...params, all: [batch], receiptFor: () => ({ valid, checks: {}, reason: 'test' }) });
  assert.equal((await scan(false)).rows[0].status, 'unverified');
  assert.equal((await scan(true)).rows[0].import, 'imported');
  assert.equal((await scan(true)).rows[0].import, 'duplicate');
});
