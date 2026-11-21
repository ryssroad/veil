import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { qledgerKeypairFromSeed } from '@qorechain/rdk';
import { sealKeysFromSeed } from '@qorechain/qoreseal';
import { rollupId, hex, discoverReaderKeys, replayExecutions, kemFingerprint } from '../veil.mjs';
import { watchBatches, PENDING } from '../finality.mjs';
import { client, getJson, inboxEntries, batches, payeeKeys, registryKey, verifyBatch, readInvoices,
  challengeOutcomes, challenge, txResult, mnemonicAccount } from './chain.mjs';
import { batchDeadline, classifyEntry } from './model.mjs';
import { createIncidentTracker } from './incidents.mjs';

export const auditorAddress = process.env.VEIL_AUDITOR || 'qor1kc6lwdz77q6f32vcfae35yu3k84l58t5xrsy3l';
const payeeDir = process.env.VEIL_PAYEE_DIR || '.private/clients/payee';
const auditorDir = process.env.VEIL_AUDITOR_DIR || '.private/clients/auditor';
const watcherFile = process.env.VEIL_WATCHER_MNEMONIC;
export const watching = Boolean(watcherFile);
const times = new Map();
let lastKey, lastState, lastBatches, last, keys, watcher, creator;

// Wall-clock observations for the finality measurement (#12).
const clicks = new Map();      // tx hash -> { clickAt, handedAt, sentAt, height }
const inFlight = new Set();    // { clickAt } per Desk payment between the click and the broadcast's return
const FAST_READS_MS = 60_000;  // per-tick reads last at most this long after the Pay click
const RECHECK_MS = 5_000;      // an unverified receipt is verified again this long after it failed
const receipts = new Map();    // `${batchIndex}:${stateRoot}` -> a receipt verification that passed
const observed = new Map();    // `${reader}:${tx hash}:${status}` -> first ms this reader produced it

/** Chain access the incident tracker uses; tests replace these. */
export const deps = { challenge, txResult, challengeOutcomes, verifyBatch, now: () => Date.now() };
const tracker = createIncidentTracker({
  send: watching ? async (index, proofHex) => {
    watcher ??= await mnemonicAccount(watcherFile);
    if (watcher.cosmos === creator) return { fatal: 'the watcher must not be the rollup creator' };
    return deps.challenge(watcher, index, proofHex);
  } : null,
  lookupTx: hash => deps.txResult(hash),
  fetchOutcomes: minHeight => deps.challengeOutcomes(minHeight),
  now: () => deps.now(),
});

/**
 * Called by the server the moment Pay arrives, with that moment. The readers
 * then read Diana on every tick: a reader's result must not wait for the
 * payer's client to learn that its own transaction was included. Returns the
 * function that ends the in-flight phase.
 */
export function beginPayment(clickAt = deps.now()) {
  const payment = { clickAt };
  inFlight.add(payment);
  return () => { inFlight.delete(payment); };
}
/**
 * Called by the server when a Desk payment's broadcast returns. The readers may
 * already have seen it. `handedAt` is when the node accepted the transaction.
 */
export function notePayment(hash, clickAt, height, handedAt) {
  clicks.set(hash, { clickAt, handedAt: handedAt ?? null, sentAt: Date.now(), height: String(height) });
}
const reader = (name, hash, status) => observed.has(`${name}:${hash}:${status}`);
const fast = clickAt => deps.now() - clickAt < FAST_READS_MS;
/**
 * Read on every tick: within 60 s of a Pay click, while that payment is in
 * flight or committed and not yet determined by both readers. The one deadline
 * runs from the click, whatever the broadcast does.
 */
export const measuring = () => [...inFlight].some(p => fast(p.clickAt))
  || [...clicks].some(([hash, c]) => fast(c.clickAt) && !(reader('payee', hash, 'determined') && reader('auditor', hash, 'determined')));
/** Keep reading at the slow cadence: a measured payment has not settled for both readers. */
export const settling = () => [...clicks.keys()].some(hash => !(reader('payee', hash, 'settled') && reader('auditor', hash, 'settled')));

function identities() {
  if (keys) return keys;
  const payer = qledgerKeypairFromSeed(readFileSync('.private/payer-l2.seed'));
  const payee = payeeKeys(payeeDir);
  const auditor = sealKeysFromSeed(readFileSync(join(auditorDir, 'seal.seed')));
  keys = { payerId: payer.accountId, payeeId: hex(payee.l2.accountId), payee: payee.seal, auditor };
  return keys;
}
async function blockTime(height) {
  if (!times.has(height)) {
    const b = await getJson('/cosmos/base/tendermint/v1beta1/blocks/' + height);
    times.set(height, (b.block ?? b.sdk_block).header.time);
  }
  return times.get(height);
}
const reached = { determined: r => r.status === 'determined' || r.status === 'settled', settled: r => r.status === 'settled' };
/**
 * Record the first time each reader produced each status, by transaction hash,
 * whether or not the Pay click is registered yet: a poll can see the committed
 * payment before its broadcast returns.
 */
async function withTimes(rows, reader) {
  const now = Date.now();
  for (const row of rows) {
    row.time = await blockTime(row.height);
    for (const status of ['determined', 'settled']) {
      const key = `${reader}:${row.tx}:${status}`;
      if (reached[status](row) && !observed.has(key)) observed.set(key, now);
    }
  }
  return rows.reverse();
}
/** Join the observations and the click to the rows. Runs on every read, changed or not. */
function decorate(state) {
  for (const reader of ['payee', 'auditor']) {
    for (const row of state[reader].rows) {
      row.observed = { determined: observed.get(`${reader}:${row.tx}:determined`) ?? null,
        settled: observed.get(`${reader}:${row.tx}:settled`) ?? null };
      row.clickAt = clicks.get(row.tx)?.clickAt ?? null;
    }
  }
  return state;
}

/**
 * The watcher's part of a read: the chain view, the batch replay and incident
 * handling. Nothing a reader displays (keys, registry, bond, block times,
 * receipts) comes before it, so an outage of display data cannot hold back a
 * challenge.
 */
async function watchChain() {
  // Chain heights read before and after the view bound when a batch was rejected. Only verdict attribution uses them.
  const tip = () => client.rest.getLatestHeight().catch(() => undefined);
  const heightBefore = await tip();
  const [roll, inbox, latest] = await Promise.all([
    client.rest.getRollup(rollupId), client.rest.getInbox(rollupId), client.rest.getLatestBatch(rollupId),
  ]);
  creator = roll.creator;
  let all;
  if (lastBatches?.at(-1)?.batchIndex === latest.batchIndex) {
    all = await Promise.all(lastBatches.map(b => {
      if (b.batchIndex === latest.batchIndex) return latest;
      return b.status === 'finalized' ? b : client.rest.getBatch(rollupId, b.batchIndex);
    }));
  } else {
    all = await batches();
  }
  // Reads can straddle a new block. Retry on the next poll instead of mixing ranges.
  const lastLive = all.filter(b => b.status !== 'rejected').at(-1);
  if (Number(lastLive?.inboxEnd ?? 0) !== Number(inbox.consumedSequence)) throw new Error('Inbox moved during refresh');
  const key = JSON.stringify([inbox, all, roll.challengeWindowSec]);
  const changed = key !== last?.key;
  let view = last;
  if (changed) {
    const { entries } = await inboxEntries(inbox);
    const windowSecs = roll.challengeWindowSec ?? (await client.rest.getParams()).defaultChallengeWindow;
    view = { key, roll, inbox, all, entries, windowSecs, watch: watchBatches({ entries, batches: all }) };
  }
  const incidents = await tracker.update({ watch: view.watch, windowSecs: view.windowSecs, changed, heightBefore, heightAfter: await tip() });
  // The replay held: this view is the base for the next read, whatever fails after it.
  last = view;
  lastBatches = all;
  return { ...view, incidents, checkedAt: Date.now() };
}

export async function snapshot() {
  const { key: chainKey, roll, inbox, all, entries, windowSecs, watch, incidents, checkedAt } = await watchChain();
  const id = identities();
  const [registered, bond] = await Promise.all([registryKey(auditorAddress), client.rest.getSubmitterBond(rollupId, roll.creator)]);
  const auditorKey = registered && kemFingerprint(registered.key);
  const key = JSON.stringify([chainKey, bond, auditorKey]);
  // A receipt check that failed may have failed in transit: verify again on an unchanged chain.
  const recheck = lastState?.recheckAt != null && deps.now() >= lastState.recheckAt;
  if (lastKey === key && !recheck) {
    // Nothing moved: the last rows still hold, and the watcher is current.
    lastState.watch.checkedAt = checkedAt;
    lastState.incidents = incidents;
    return decorate(lastState);
  }
  const verdictOf = index => watch.verdicts.find(v => v.index === index);
  const batchList = all.map(b => ({ index: b.batchIndex, status: b.status, start: b.inboxStart, end: b.inboxEnd,
    height: b.status === 'finalized' ? b.finalizedAt : b.submittedAt, submittedAt: b.submittedAt,
    submittedTime: b.submittedTime ?? null, finalizedAt: b.finalizedAt || null, verdict: verdictOf(b.batchIndex)?.verdict,
    ...batchDeadline(b, windowSecs) }));
  const { bindings, events } = discoverReaderKeys(entries);
  const { ledger, executions, withdrawals } = replayExecutions(entries);
  const paymentsBySequence = new Map([...executions, ...withdrawals].map(tx => [tx.sequence, tx]));
  // A finalized batch's receipt does not change: verify it once per root and reuse a pass. A failure is asked again.
  const asked = new Map();
  const receiptFor = batch => {
    const id = `${batch.batchIndex}:${batch.stateRoot}`;
    if (receipts.has(id)) return receipts.get(id);
    if (!asked.has(id)) asked.set(id, deps.verifyBatch(batch).then(r => { if (r.valid) receipts.set(id, r); return r; }));
    return asked.get(id);
  };
  const bound = bindings.get(id.payeeId);
  const ownKey = kemFingerprint(id.payee.mlkemPublicKey);
  const payeeWarning = bound?.fingerprint !== ownKey ? 'The bound statement does not match this reader.' : null;
  const auditorWarning = !auditorKey || auditorKey !== kemFingerprint(id.auditor.mlkemPublicKey)
    ? 'The local reader key does not match the auditor registry.' : null;
  async function reader(name, dir, sealKeys, mine, warning) {
    if (warning || !auditorKey) return { rows: [], skipped: [], conflicts: [], warning: warning || 'Auditor key unavailable.' };
    const r = await readInvoices({ dir, sealKeys, mine, auditorKey, entries, all, executions, watch, receiptFor, dedupeConflicts: true });
    return { rows: await withTimes(r.rows, name), skipped: r.skipped.filter(s => !r.rows.some(x => x.sequence === s.sequence)),
      conflicts: r.conflicts, warning };
  }
  const payee = await reader('payee', payeeDir, id.payee, id.payeeId, payeeWarning);
  const auditor = await reader('auditor', auditorDir, id.auditor, undefined, auditorWarning);
  const balance = ledger.get(id.payerId);
  const pending = watch.verdicts.filter(v => PENDING.has(v.status));
  const state = { rollup: rollupId, payer: { account: hex(id.payerId), balance: String(balance.balance), nonce: String(balance.nonce) },
    signing: Boolean(process.env.VEIL_OPERATOR_MNEMONIC), inbox: { head: inbox.headSequence, consumed: inbox.consumedSequence },
    bond: String(bond.amount), batches: batchList, windowSecs,
    watch: { checkedAt, pending: pending.length, diverged: pending.filter(v => v.verdict !== 'ok').map(v => v.index),
      fault: watch.fault?.index ?? null, challenging: Boolean(watcherFile) },
    incidents,
    entries: entries.map(e => ({ sequence: e.sequence, height: String(e.height), poster: e.poster, tx: e.tx.hash,
      batch: batchList.find(b => b.status !== 'rejected' && b.start < e.sequence && e.sequence <= b.end)?.index,
      ...classifyEntry(e, paymentsBySequence.get(e.sequence), events.find(x => x.sequence === e.sequence)) })).reverse(),
    payee: { ...payee, account: id.payeeId, fingerprint: bound?.fingerprint, ownKey, sequence: bound?.sequence },
    auditor: { ...auditor, address: auditorAddress, fingerprint: auditorKey } };
  state.recheckAt = [...payee.rows, ...auditor.rows].some(r => r.status === 'unverified') ? deps.now() + RECHECK_MS : null;
  lastState = state;
  lastKey = key;
  return decorate(state);
}

/**
 * The finality measurement for Desk payments: Pay click, committed block,
 * first determination and settlement per reader, batch submission and
 * finalization. Times are epoch milliseconds; block times are the headers'.
 */
export async function finalityReport() {
  const s = lastState;
  const out = [];
  for (const [hash, c] of clicks) {
    const row = s?.auditor.rows.find(r => r.tx === hash) ?? s?.payee.rows.find(r => r.tx === hash);
    const batch = row && s.batches.find(b => b.index === row.batch);
    const committedTime = await blockTime(c.height).catch(() => null);
    const finalizedTime = batch?.finalizedAt ? await blockTime(batch.finalizedAt).catch(() => null) : null;
    const reader = name => ({ determined: observed.get(`${name}:${hash}:determined`) ?? null, settled: observed.get(`${name}:${hash}:settled`) ?? null });
    out.push({ tx: hash, sequence: row?.sequence ?? null, clickAt: c.clickAt, handedToNodeAt: c.handedAt, broadcastReturnedAt: c.sentAt,
      committed: { height: c.height, time: committedTime }, payee: reader('payee'), auditor: reader('auditor'),
      batch: batch ? { index: batch.index, submittedAt: batch.submittedAt, submittedTime: batch.submittedTime,
        finalizedAt: batch.finalizedAt, finalizedTime } : null });
  }
  return { rollup: rollupId, measurements: out };
}
