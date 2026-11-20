import assert from 'node:assert/strict';
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { sealKeysFromSeed } from '@qorechain/qoreseal';
import {
  createRdkClient, createRdkRegistry, EMPTY_INBOX_ACC, fetchQledgerEntries, executeQledger,
  QledgerLedger, qledgerKeypairFromSeed, planQledgerBatch, postRollupDataMsg, submitBatchMsg,
  anchorSignBytesForBatch, buildSettlementReceipt, verifySettlementReceipt, isRestNotFound, challengeBatchMsg,
} from '@qorechain/rdk';
import { deriveUnifiedAccount, EthNativeSigner, pqcSign } from '@qorechain/sdk';
import { StargateClient } from '@cosmjs/stargate';
import {
  env, chainId, rollupId, hex, sha256, kemFingerprint, kemKeyFromRegistry, createInvoicePayment,
  openInvoice, discoverReaderKeys, replayExecutions, coPostedEnvelope, coPostedInTx, InvoiceImporter,
} from '../veil.mjs';
import { entriesFromTxs, accumulate, watchBatches, dispute } from '../finality.mjs';

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

/** Inbox entries `from + 1 .. to` with their L1 transactions, from the node's tx index. */
async function fetchEntries(from, to, minHeight) {
  const q = (type) => `${type}.rollup_id='${rollupId}'` + (minHeight ? ` AND tx.height>=${minHeight}` : '');
  const [posts, deposits] = await Promise.all([client.rest.searchTxs(q('rdk_data_posted')), client.rest.searchTxs(q('rdk_rollup_deposit'))]);
  return entriesFromTxs({ rollupId, posts, deposits, from, to });
}
let inboxCache;
/**
 * Every inbox entry 1..head with sequence numbers and the L1 transaction that
 * carried it, checked against the chain's accumulator. After the first read,
 * only entries posted since the last head are fetched; any mismatch falls back
 * to a full read.
 */
export async function inboxEntries(inbox) {
  inbox ??= await client.rest.getInbox(rollupId);
  const head = Number(inbox.headSequence);
  const want = inbox.headAcc.replace(/^0x/, '').toLowerCase();
  const c = inboxCache;
  if (c?.head === head && c.acc === want) return { inbox, entries: c.entries };
  let entries;
  if (c && c.head < head) {
    try {
      const added = await fetchEntries(c.head, head, c.entries.at(-1)?.height);
      if (accumulate(added, c.head, c.acc) === want) entries = [...c.entries, ...added];
    } catch { /* full read below */ }
  }
  if (!entries) {
    entries = await fetchEntries(0, head);
    assert.equal(accumulate(entries), want, 'inbox entries do not match the chain accumulator');
  }
  assert.equal(entries.length, head);
  inboxCache = { head, acc: want, entries };
  return { inbox, entries };
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

/**
 * The reader. Per invoice, in order of strength:
 *  - `no-op`: the transfer bytes are in the inbox but did not execute;
 *  - `disputed`: a pending batch the entry depends on, or a finalized one,
 *    diverges from the replay;
 *  - `determined`: executed, co-posted in one successful L1 transaction, opened,
 *    and no divergent dependency. The outcome is fixed at the entry's block;
 *  - `settled`: in a finalized batch whose ML-DSA-87 receipt verifies (`unverified`
 *    when it does not). Only settled invoices are imported.
 */
export async function readInvoices({ dir, mine, sealKeys, auditorKey, entries, all, executions, watch,
  dedupeConflicts = false, receiptFor = verifyBatch }) {
  watch ??= watchBatches({ entries, batches: all });
  const live = all.filter(b => b.status !== 'rejected');
  const batchOf = seq => live.find(b => b.inboxStart < seq && seq <= b.inboxEnd);
  const storePath = join(dir, 'imports.json');
  const importer = new InvoiceImporter(existsSync(storePath) ? JSON.parse(readFileSync(storePath)) : undefined);
  const accepted = [];
  const skipped = [];
  const rows = [];
  for (const x of executions) {
    if (mine && x.to !== mine) continue;
    const envelopeEntry = coPostedInTx(entries, x.sequence);
    if (!envelopeEntry) {
      if (coPostedEnvelope(entries, x.sequence)) skipped.push({ sequence: x.sequence, reason: 'envelope is not in the transfer\u2019s transaction' });
      continue;
    }
    const entry = entries.find((e) => e.sequence === x.sequence);
    let opened;
    try {
      opened = openInvoice({ transfer: entry.payload, envelope: envelopeEntry.payload, sealKeys, auditorKey });
    } catch (err) {
      skipped.push({ sequence: x.sequence, reason: err.message });
      continue;
    }
    const batch = batchOf(x.sequence);
    const disputed = x.executed ? dispute(watch, x.sequence) : undefined;
    const row = { sequence: x.sequence, height: String(entry.height), tx: entry.tx.hash,
      envelopeSequence: envelopeEntry.sequence, batch: batch?.batchIndex, batchStatus: batch?.status, ...opened };
    const hold = (status, reason, extra = {}) => {
      rows.push({ ...row, status, reason, ...extra });
      skipped.push({ sequence: x.sequence, invoiceId: opened.invoice.id, reason });
    };
    if (!x.executed) { hold('no-op', 'transfer bytes did not execute'); continue; }
    if (disputed) { hold('disputed', disputed.reason, { disputedBatch: disputed.batch }); continue; }
    if (batch?.status !== 'finalized') {
      hold('determined', batch ? `batch ${batch.batchIndex} is ${batch.status}` : 'not in a batch yet');
      continue;
    }
    const verified = await receiptFor(batch);
    if (!verified.valid) { hold('unverified', 'receipt: ' + verified.reason); continue; }
    const imported = importer.import({ ...opened, nonce: x.nonce });
    rows.push({ ...row, status: imported.result === 'conflict' ? 'conflict' : 'settled',
      settledHeight: batch.finalizedAt, receiptChecks: verified.checks, import: imported.result });
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
  return { accepted, skipped, rows, conflicts: importer.state.conflicts, watch };
}

/** Every upheld fraud challenge on this rollup, from the chain's own events. */
export async function challengeOutcomes() {
  const txs = await client.rest.searchTxs(`rdk_fraud_upheld.rollup_id='${rollupId}'`);
  const out = [];
  for (const tx of txs) {
    for (const ev of tx.events ?? []) {
      if (ev.type !== 'rdk_fraud_upheld') continue;
      const a = Object.fromEntries((ev.attributes ?? []).map(x => [String(x.key), String(x.value ?? '')]));
      if (a.rollup_id !== rollupId) continue;
      out.push({ index: Number(a.batch_index), hash: tx.txhash, height: Number(tx.height), challenger: a.challenger,
        submitter: a.submitter, slashed: a.slashed, reward: a.challenger_reward });
    }
  }
  return out;
}

/** Submit a fraud challenge from the reader's watcher account. A lost race is a result, not an error. */
export async function challenge(watcher, batchIndex, proofHex) {
  try {
    return await broadcast(watcher, [challengeBatchMsg({ challenger: watcher.cosmos, rollupId, batchIndex,
      proof: Buffer.from(proofHex, 'hex') })], 'challenge');
  } catch (err) {
    if (err.tx) return err.tx;
    const message = String(err?.message ?? err);
    return { step: 'challenge', hash: message.match(/\(tx ([0-9A-F]{64})\)/)?.[1], code: Number(message.match(/code (\d+)/)?.[1]) || -1,
      error: message.slice(0, 300), at: now() };
  }
}
