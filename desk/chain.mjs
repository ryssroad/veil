import assert from 'node:assert/strict';
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { sealKeysFromSeed } from '@qorechain/qoreseal';
import {
  createRdkClient, createRdkRegistry, EMPTY_INBOX_ACC, fetchQledgerEntries, executeQledger,
  QledgerLedger, qledgerKeypairFromSeed, planQledgerBatch, postRollupDataMsg, submitBatchMsg,
  anchorSignBytesForBatch, buildSettlementReceipt, verifySettlementReceipt, isRestNotFound,
} from '@qorechain/rdk';
import { deriveUnifiedAccount, EthNativeSigner, pqcSign } from '@qorechain/sdk';
import { StargateClient } from '@cosmjs/stargate';
import {
  env, chainId, rollupId, hex, sha256, kemFingerprint, kemKeyFromRegistry, createInvoicePayment,
  openInvoice, discoverReaderKeys, replayExecutions, coPostedEnvelope, InvoiceImporter,
} from '../veil.mjs';

export const json = (v) => JSON.stringify(v, (_, x) => (typeof x === 'bigint' ? String(x) : x), 2) + '\n';
const now = () => new Date().toISOString();

export const client = createRdkClient({ network: 'testnet' });
const rest = client.network.endpoints.rest;

export async function getJson(route) {
  const res = await fetch(rest + route);
  assert.ok(res.ok, route + ' HTTP ' + res.status);
  return res.json();
}
export const mnemonicAccount = (file) => {
  assert.ok(file && existsSync(file), 'mnemonic file not found: ' + file);
  return deriveUnifiedAccount(readFileSync(file, 'utf8').trim());
};
export async function operator(file, roll) {
  const op = await mnemonicAccount(file);
  assert.equal(op.cosmos, roll.creator, 'operator mnemonic required');
  return op;
}
export const payeeKeys = (dir) => ({
  l2: qledgerKeypairFromSeed(readFileSync(join(dir, 'l2.seed'))),
  seal: sealKeysFromSeed(readFileSync(join(dir, 'seal.seed'))),
});

export async function broadcast(account, messages, name, { mode = 'hybrid', registry = createRdkRegistry() } = {}) {
  const transport = await StargateClient.connect(client.network.endpoints.rpc);
  try {
    assert.equal(await transport.getChainId(), chainId);
    const { account: auth } = await getJson('/cosmos/auth/v1beta1/accounts/' + account.cosmos);
    const base = auth.base_account ?? auth;
    const signer = new EthNativeSigner(account, { rest, signMode: mode, ...(registry ? { registry } : {}) });
    const n = messages.length;
    const tx = await signer.signAndBroadcast(transport, {
      chainId, messages,
      accountNumber: BigInt(base.account_number),
      sequence: BigInt(base.sequence),
      fee: { amount: [{ denom: 'uqor', amount: String(270000 * n) }], gas: String(1800000 * n) },
    });
    const out = { step: name, hash: tx.transactionHash, height: tx.height, code: tx.code, sender: account.cosmos, at: now() };
    console.log(out);
    if (tx.code !== 0) throw Object.assign(new Error('Transaction failed with code ' + tx.code), { tx: out });
    return out;
  } finally {
    transport.disconnect();
  }
}

/** An address's ML-KEM-1024 key from the chain registry, as bytes, or undefined. */
export async function registryKey(address) {
  const view = await client.rest.getKemKey(address);
  return view ? { key: kemKeyFromRegistry(view), registeredHeight: view.registeredHeight } : undefined;
}

/** Every inbox entry 1..head, checked against the chain's accumulator, with sequence numbers. */
export async function inboxEntries(inbox) {
  inbox ??= await client.rest.getInbox(rollupId);
  const head = Number(inbox.headSequence);
  const rows = await fetchQledgerEntries(client.rest, { ...env, from: 0, to: head, accFrom: EMPTY_INBOX_ACC });
  assert.equal(rows.length, head);
  return { inbox, entries: rows.map((e, i) => ({ ...e, sequence: i + 1 })) };
}
export async function batches() {
  const out = [];
  for (let i = 0; ; i++) {
    try {
      out.push(await client.rest.getBatch(rollupId, i));
    } catch (err) {
      if (isRestNotFound(err)) return out;
      throw err;
    }
  }
}
/** Parent ledger over the consumed entries, checked against the latest batch root. */
function consumedLedger(entries, consumed, latest) {
  const ledger = new QledgerLedger();
  executeQledger(env, ledger, entries.slice(0, consumed));
  assert.equal(hex(ledger.root()), latest.stateRoot, 'replayed ledger does not match the latest batch');
  return ledger;
}

export async function pay(op, payeeAccount, auditorAddress, amount, description) {
  const payer = qledgerKeypairFromSeed(readFileSync('.private/payer-l2.seed'));
  const { entries } = await inboxEntries();
  // Reader keys from public sources only: the inbox and the chain registry.
  const { bindings, events } = discoverReaderKeys(entries);
  const payee = bindings.get(payeeAccount);
  assert.ok(payee, 'no reader-key statement bound for ' + payeeAccount);
  const auditor = await registryKey(auditorAddress);
  assert.ok(auditor, 'auditor has no key in the chain registry');
  const { ledger } = replayExecutions(entries);
  const state = ledger.get(payer.accountId);
  assert.ok(state.balance >= amount, `payer holds ${state.balance} uqor`);
  const { transfer, envelope, body } = createInvoicePayment({
    payer, nonce: state.nonce, beneficiary: Buffer.from(payeeAccount, 'hex'), amount,
    beneficiaryKem: payee.kemPublicKey, auditorKem: auditor.key,
    id: randomBytes(16).toString('hex'), description,
  });
  const tx = await broadcast(op, [
    postRollupDataMsg({ rollupId, poster: op.cosmos, data: transfer }),
    postRollupDataMsg({ rollupId, poster: op.cosmos, data: envelope }),
  ], 'pay');
  return { ...tx, payer: hex(payer.accountId), nonce: state.nonce, payeeAccount, amount,
    payeeBinding: { sequence: payee.sequence, readerKey: payee.fingerprint }, auditor: auditorAddress,
    auditorKey: kemFingerprint(auditor.key), discovery: events,
    transferDigest: hex(sha256(transfer)), envelopeDigest: hex(sha256(envelope)),
    envelopeBytes: envelope.length, bodyBytes: body.length };
}

export async function submitBatch(op, roll) {
  const { inbox, entries } = await inboxEntries();
  const latest = await client.rest.getLatestBatch(rollupId);
  const ledger = consumedLedger(entries, Number(inbox.consumedSequence), latest);
  const plan = await planQledgerBatch(client.rest, { ...env, submitter: op.cosmos, ledger });
  const anchor = anchorSignBytesForBatch({ chainId, layerId: roll.layerId, ...plan.input });
  const tx = await broadcast(op, [submitBatchMsg({ ...plan.input, sequencer: op.cosmos, anchorSignature: pqcSign(op.pqc.secretKey, anchor) })], 'batch');
  return { ...tx, batchIndex: plan.input.batchIndex, range: [inbox.consumedSequence, plan.input.inboxEnd],
    stateRoot: hex(plan.input.stateRoot), withdrawalsRoot: hex(plan.input.withdrawalsRoot) };
}

export async function verifyBatch(batch) {
  const receipt = await buildSettlementReceipt(client, rollupId, batch.batchIndex);
  return verifySettlementReceipt(receipt, { client });
}

export async function readInvoices({ dir, mine, sealKeys, auditorKey, entries, all, executions, dedupeConflicts = false, receiptFor = verifyBatch }) {
  const batchOf = seq => all.find(b => b.inboxStart < seq && seq <= b.inboxEnd);
  const storePath = join(dir, 'imports.json');
  const importer = new InvoiceImporter(existsSync(storePath) ? JSON.parse(readFileSync(storePath)) : undefined);
  const accepted = [];
  const skipped = [];
  const rows = [];
  for (const x of executions) {
    if (mine && x.to !== mine) continue;
    const envelopeEntry = coPostedEnvelope(entries, x.sequence);
    if (!envelopeEntry) continue;
    const transfer = entries.find((e) => e.sequence === x.sequence).payload;
    let opened;
    try {
      opened = openInvoice({ transfer, envelope: envelopeEntry.payload, sealKeys, auditorKey });
    } catch (err) {
      skipped.push({ sequence: x.sequence, reason: err.message });
      continue;
    }
    const batch = batchOf(x.sequence);
    const why = !x.executed ? 'transfer bytes did not execute'
      : !batch ? 'not in a batch yet'
      : batch.status !== 'finalized' ? `batch ${batch.batchIndex} is ${batch.status}` : undefined;
    const row = { sequence: x.sequence, height: String(entries.find(e => e.sequence === x.sequence).height),
      envelopeSequence: envelopeEntry.sequence, batch: batch?.batchIndex, ...opened };
    if (why) {
      rows.push({ ...row, status: !x.executed ? 'no-op' : batch?.status ?? 'pending', reason: why });
      skipped.push({ sequence: x.sequence, invoiceId: opened.invoice.id, reason: why });
      continue;
    }
    const verified = await receiptFor(batch);
    if (!verified.valid) {
      rows.push({ ...row, status: 'unverified', reason: verified.reason });
      skipped.push({ sequence: x.sequence, invoiceId: opened.invoice.id, reason: 'receipt: ' + verified.reason });
      continue;
    }
    const imported = importer.import({ ...opened, nonce: x.nonce });
    rows.push({ ...row, status: imported.result === 'conflict' ? 'conflict' : 'verified',
      receiptChecks: verified.checks, import: imported.result });
    accepted.push({ sequence: x.sequence, envelopeSequence: envelopeEntry.sequence, batch: batch.batchIndex,
      receiptChecks: verified.checks, import: imported.result, ...opened });
  }
  // A repeated scan of the same conflicting payment is one incident.
  if (dedupeConflicts) importer.state.conflicts = [...new Map(importer.state.conflicts.map(c => [json(c), c])).values()];
  const serialized = json(importer.state);
  if (!existsSync(storePath) || readFileSync(storePath, 'utf8') !== serialized) {
    const temp = storePath + '.' + randomBytes(8).toString('hex');
    writeFileSync(temp, serialized, { mode: 0o600, flag: 'wx' });
    renameSync(temp, storePath);
  }
  return { accepted, skipped, rows, conflicts: importer.state.conflicts };
}
