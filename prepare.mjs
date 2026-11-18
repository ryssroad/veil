import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import assert from 'node:assert/strict';
import { makePayment, readInvoice, hex } from './invoice.mjs';

mkdirSync('.private', { recursive: true, mode: 0o700 });
function role(name) {
  const path = '.private/' + name + '.seed';
  try {
    writeFileSync(path, randomBytes(32), { flag: 'wx', mode: 0o600 });
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
  }
  return readFileSync(path);
}
const members = [role('recipient'), role('auditor')];
const { transfer, envelope, payer } = makePayment(
  role('payer-l2'),
  role('payee-l2'),
  members,
);
const invoice = readInvoice(envelope, transfer, members[0]);
assert.deepEqual(invoice, readInvoice(envelope, transfer, members[1]));
assert.throws(() => readInvoice(envelope, transfer, randomBytes(32)));
writeFileSync(
  '.private/payment.json',
  JSON.stringify({
    transfer: hex(transfer),
    envelope: hex(envelope),
    payer: hex(payer),
  }),
  { flag: 'wx', mode: 0o600 },
);
console.log('Prepared two-reader envelope:', envelope.length, 'bytes');
