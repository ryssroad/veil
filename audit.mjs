// Independent verifier for Veil's first Diana batch. Only a reader's local
// decryption seed is needed to check the invoice; the chain checks are public.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import {
  createRdkClient,
  QledgerLedger,
  executeQledger,
  fetchQledgerEntries,
  qledgerAccumulate,
  inboxRangeHash,
  EMPTY_INBOX_ACC,
  decodeQledgerTx,
  qledgerAccountId,
  verifyQledgerTx,
  QLEDGER_KIND_TRANSFER,
  buildSettlementReceipt,
  verifySettlementReceipt,
} from '@qorechain/rdk';
import { env, rollupId, chainId, hash, hex, readInvoice } from './invoice.mjs';

const args = process.argv.slice(2);
const role = args[0] ?? 'public';
assert.ok(
  ['public', 'recipient', 'auditor'].includes(role),
  'role must be public, recipient or auditor',
);
const allowPending = args.includes('--allow-pending');
const client = createRdkClient({ network: 'testnet' });
const rest = client.network.endpoints.rest;
const payment = JSON.parse(
  readFileSync(new URL('./evidence/payment.json', import.meta.url)),
);
const [batch, rollup, txResponse] = await Promise.all([
  client.rest.getBatch(rollupId, 0),
  client.rest.getRollup(rollupId),
  fetch(rest + '/cosmos/tx/v1beta1/txs/' + payment.hash),
]);
assert.ok(txResponse.ok);
const { tx, tx_response: l1 } = await txResponse.json();
assert.equal(l1.code, 0);
assert.equal(l1.txhash, payment.hash);
assert.equal(batch.batchIndex, 0);
assert.equal(batch.rollupId, rollupId);
assert.equal(rollup.executionVm, 'qledger-v1');
assert.equal(rollup.sequencing, 'based');
assert.deepEqual([batch.inboxStart, batch.inboxEnd, batch.txCount], [0, 3, 3]);
assert.ok(
  batch.status === 'finalized' ||
    (allowPending && batch.status === 'submitted'),
);
const range = { ...env, from: 0, to: 3, accFrom: EMPTY_INBOX_ACC };
const entries = await fetchQledgerEntries(client.rest, range);
const accTo = qledgerAccumulate({ ...range, entries });
assert.equal(hex(inboxRangeHash({ ...range, accTo })), batch.dataHash);
const [, transferEntry, invoiceEntry] = entries;
assert.equal(tx.body.messages.length, 2);
for (const [i, entry] of [transferEntry, invoiceEntry].entries()) {
  const msg = tx.body.messages[i];
  assert.equal(msg['@type'], '/qorechain.rdk.v1.MsgPostRollupData');
  assert.equal(msg.rollup_id, rollupId);
  assert.equal(msg.poster, entry.poster);
  assert.equal(BigInt(l1.height), entry.height);
  assert.equal(msg.data, Buffer.from(entry.payload).toString('base64'));
}
const transfer = transferEntry.payload,
  envelope = invoiceEntry.payload;
const l2 = decodeQledgerTx(transfer);
assert.ok(
  l2?.kind === QLEDGER_KIND_TRANSFER && verifyQledgerTx(l2, chainId, rollupId),
);
const payer = qledgerAccountId(l2.publicKey);
assert.notEqual(hex(payer), hex(l2.to));
const ledger = new QledgerLedger();
assert.equal(hex(ledger.root()), batch.prevStateRoot);
executeQledger(env, ledger, [entries[0]]);
const beforePayer = ledger.get(payer),
  beforePayee = ledger.get(l2.to);
executeQledger(env, ledger, [transferEntry]);
const afterPayer = ledger.get(payer),
  afterPayee = ledger.get(l2.to);
assert.equal(l2.amount, 250000n);
assert.equal(afterPayer.balance, beforePayer.balance - l2.amount);
assert.equal(afterPayer.nonce, beforePayer.nonce + 1n);
assert.equal(afterPayee.balance, beforePayee.balance + l2.amount);
const paidRoot = hex(ledger.root());
const result = executeQledger(env, ledger, [invoiceEntry]);
assert.equal(hex(result.stateRoot), paidRoot);
assert.equal(paidRoot, batch.stateRoot);
assert.equal(hex(result.withdrawalsRoot), batch.withdrawalsRoot);
let invoiceChecks, invoice;
if (role !== 'public') {
  const keyPath = args[1];
  assert.ok(
    keyPath && !keyPath.startsWith('--'),
    'supply only this reader’s seed path',
  );
  const seed = readFileSync(keyPath);
  assert.equal(seed.length, 32);
  invoice = readInvoice(envelope, transfer, seed);
  assert.throws(() => readInvoice(envelope, transfer, randomBytes(32)));
  const modified = Buffer.from(envelope);
  modified[modified.length - 1] ^= 1;
  assert.throws(() => readInvoice(modified, transfer, seed));
  invoiceChecks = {
    decrypted: true,
    invoiceSignedByPayer: true,
    amountAndRecipientMatched: true,
    outsiderRejected: true,
    modifiedEnvelopeRejected: true,
  };
}
const receiptFlag = args.indexOf('--receipt');
let receipt;
if (receiptFlag >= 0) {
  assert.ok(args[receiptFlag + 1], 'supply a receipt JSON file');
  receipt = JSON.parse(readFileSync(args[receiptFlag + 1], 'utf8'));
} else {
  receipt = await buildSettlementReceipt(client, rollupId, 0);
}
assert.equal(receipt.rollupId, rollupId);
assert.equal(receipt.batchIndex, 0);
const checked = await verifySettlementReceipt(receipt, { client });
assert.ok(
  checked.valid && receipt.version === 2 && receipt.chainId === chainId,
);
assert.equal(receipt.batchStateRoot, paidRoot);
const tampered = await verifySettlementReceipt(
  { ...receipt, batchStateRoot: '00'.repeat(32) },
  { client },
);
assert.equal(tampered.valid, false);
const snapshot = {
  chainId,
  rollupId,
  role,
  status: batch.status,
  submittedHeight: batch.submittedAt,
  finalizedHeight: batch.finalizedAt,
  submittedTime: batch.submittedTime,
  challengeWindow: rollup.challengeWindowSec,
  paymentTx: payment.hash,
  transferDigest: hex(hash(transfer)),
  envelopeDigest: hex(hash(envelope)),
  envelopeBytes: envelope.length,
  amountUqor: l2.amount.toString(),
  payer: hex(payer),
  payee: hex(l2.to),
  balancesUqor: {
    payerBefore: String(beforePayer.balance),
    payerAfter: String(afterPayer.balance),
    payeeBefore: String(beforePayee.balance),
    payeeAfter: String(afterPayee.balance),
  },
  batchRoot: paidRoot,
  dataHash: batch.dataHash,
  invoiceChecks,
  receiptValid: checked.valid,
  receiptChecks: checked.checks,
  tamperedReceiptRejected: true,
};
if (args.includes('--save')) {
  assert.equal(batch.status, 'finalized', 'save evidence after finality');
  writeFileSync(
    'evidence/receipt.json',
    JSON.stringify(receipt, null, 2) + '\n',
  );
  writeFileSync(
    'evidence/' + role + '-audit.json',
    JSON.stringify(snapshot, null, 2) + '\n',
  );
  if (invoice) {
    mkdirSync('.private', { recursive: true, mode: 0o700 });
    writeFileSync(
      '.private/' + role + '-invoice.json',
      JSON.stringify(invoice, null, 2) + '\n',
      { mode: 0o600 },
    );
  }
}
console.log(JSON.stringify(snapshot, null, 2));
