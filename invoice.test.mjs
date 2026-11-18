import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { open, seal, sealKeysFromSeed, recipientOf } from '@qorechain/qoreseal';
import {
  encodeQledgerTx,
  qledgerKeypairFromSeed,
  signQledgerTx,
} from '@qorechain/rdk';
import {
  env,
  chainId,
  rollupId,
  makePayment,
  readInvoice,
  hash,
  hex,
} from './invoice.mjs';

test('only the two readers can open the signed invoice for this exact transfer', () => {
  const sender = randomBytes(32),
    payee = randomBytes(32);
  const readers = [randomBytes(32), randomBytes(32)];
  const { transfer, envelope } = makePayment(sender, payee, readers);
  const invoice = readInvoice(envelope, transfer, readers[0]);
  assert.deepEqual(invoice, readInvoice(envelope, transfer, readers[1]));
  assert.throws(() => readInvoice(envelope, transfer, randomBytes(32)));
  // A second correctly signed transfer with the same parties and amount must
  // not authenticate a memo from the first payment.
  const otherPayment = encodeQledgerTx(
    signQledgerTx({
      ...env,
      ...qledgerKeypairFromSeed(sender),
      to: qledgerKeypairFromSeed(payee).accountId,
      nonce: 1,
      amount: 250000n,
    }),
  );
  assert.throws(() => readInvoice(envelope, otherPayment, readers[1]));

  // A reader can seal to these same public keys. A new, well-formed envelope
  // with altered invoice bytes must fail the independent payer-signature check.
  const keys = readers.map(sealKeysFromSeed);
  const purpose = 'veil-invoice-v1';
  const aad = Buffer.from(
    JSON.stringify([purpose, chainId, rollupId, hex(hash(transfer))]),
  );
  const body = open({ chainId, purpose, aad, keys: keys[0], envelope });
  const changed = { ...invoice, description: 'Changed description' };
  const replacement = seal({
    chainId,
    purpose,
    aad,
    recipients: keys.map(recipientOf),
    mode: 'mlkem',
    plaintext: Buffer.concat([
      body.subarray(0, 2420),
      Buffer.from(JSON.stringify(changed)),
    ]),
  });
  assert.throws(
    () => readInvoice(replacement, transfer, readers[1]),
    /invoice signer/,
  );
});
