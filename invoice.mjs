import { createHash, randomBytes } from 'node:crypto';
import assert from 'node:assert/strict';
import { ml_dsa44 } from '@noble/post-quantum/ml-dsa.js';
import { seal, open, recipientOf, sealKeysFromSeed } from '@qorechain/qoreseal';
import {
  decodeQledgerTx,
  encodeQledgerTx,
  qledgerKeypairFromSeed,
  signQledgerTx,
  verifyQledgerTx,
  QLEDGER_MAX_POST_BYTES,
  QLEDGER_KIND_TRANSFER,
} from '@qorechain/rdk';

export const chainId = 'qorechain-diana';
export const rollupId = 'veil-pay-1';
export const env = { chainId, rollupId };
export const hex = (bytes) => Buffer.from(bytes).toString('hex');
export const hash = (bytes) => createHash('sha256').update(bytes).digest();
const purpose = 'veil-invoice-v1';
const context = Buffer.from(purpose);
const signatureSize = 2420;
function binding(transfer) {
  return Buffer.from(
    JSON.stringify([purpose, chainId, rollupId, hex(hash(transfer))]),
  );
}
function message(aad, body) {
  return hash(Buffer.concat([aad, Buffer.from([0]), body]));
}

export function makePayment(senderSeed, payeeSeed, recipients) {
  const payer = qledgerKeypairFromSeed(senderSeed);
  const payee = qledgerKeypairFromSeed(payeeSeed);
  const amount = 250000n;
  const transfer = encodeQledgerTx(
    signQledgerTx({
      ...env,
      ...payer,
      to: payee.accountId,
      amount,
      nonce: 0,
    }),
  );
  const aad = binding(transfer);
  const invoice = {
    version: 1,
    id: randomBytes(16).toString('hex'),
    description: 'Test service invoice',
    amountUqor: String(amount),
    beneficiary: hex(payee.accountId),
  };
  const body = Buffer.from(JSON.stringify(invoice));
  const signature = ml_dsa44.sign(message(aad, body), payer.secretKey, {
    context,
  });
  const envelope = seal({
    chainId,
    purpose,
    aad,
    mode: 'mlkem',
    anonymous: true,
    recipients: recipients.map((seed) => recipientOf(sealKeysFromSeed(seed))),
    plaintext: Buffer.concat([signature, body]),
  });
  assert.ok(envelope.length <= QLEDGER_MAX_POST_BYTES);
  return { transfer, envelope, payer: payer.accountId };
}

export function readInvoice(envelope, transfer, roleSeed) {
  const tx = decodeQledgerTx(transfer);
  assert.ok(
    tx &&
      tx.kind === QLEDGER_KIND_TRANSFER &&
      verifyQledgerTx(tx, chainId, rollupId),
    'transfer signature',
  );
  const aad = binding(transfer);
  const plain = open({
    chainId,
    purpose,
    aad,
    envelope,
    keys: sealKeysFromSeed(roleSeed),
  });
  const body = plain.subarray(signatureSize);
  assert.ok(
    ml_dsa44.verify(
      plain.subarray(0, signatureSize),
      message(aad, body),
      tx.publicKey,
      { context },
    ),
    'invoice signer must equal payer',
  );
  const invoice = JSON.parse(Buffer.from(body).toString());
  assert.equal(invoice.version, 1);
  assert.equal(invoice.amountUqor, tx.amount.toString());
  assert.equal(invoice.beneficiary, hex(tx.to));
  return invoice;
}
