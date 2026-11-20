import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { qledgerKeypairFromSeed } from '@qorechain/rdk';
import { sealKeysFromSeed } from '@qorechain/qoreseal';
import { rollupId, hex, discoverReaderKeys, replayExecutions, kemFingerprint } from '../veil.mjs';
import { watchBatches, incidentsFrom, PENDING } from '../finality.mjs';
import { client, getJson, inboxEntries, batches, payeeKeys, registryKey, verifyBatch, readInvoices,
  challengeOutcomes, challenge, mnemonicAccount } from './chain.mjs';
import { classifyEntry } from './model.mjs';

export const auditorAddress = process.env.VEIL_AUDITOR || 'qor1kc6lwdz77q6f32vcfae35yu3k84l58t5xrsy3l';
const payeeDir = process.env.VEIL_PAYEE_DIR || '.private/clients/payee';
const auditorDir = process.env.VEIL_AUDITOR_DIR || '.private/clients/auditor';
const watcherFile = process.env.VEIL_WATCHER_MNEMONIC;
const times = new Map();
let lastKey, lastState, lastBatches, keys, watcher, outcomes, outcomesKey;

// Wall-clock observations for the finality measurement (#12).
const clicks = new Map();      // tx hash -> { clickAt, sentAt, height }
const observed = new Map();    // `${reader}:${sequence}:${status}` -> first ms this reader produced it
const incidents = new Map();   // `${index}:${stateRoot}` -> divergence record

/** Called by the server when a Desk payment is clicked and when it is committed. */
export function notePayment(hash, clickAt, height) {
  clicks.set(hash, { clickAt, sentAt: Date.now(), height: String(height) });
}
export const measuring = () => [...clicks.keys()].some(hash => !observed.has(`auditor:${hash}:settled`));

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
async function withTimes(rows, reader) {
  const now = Date.now();
  for (const row of rows) {
    row.time = await blockTime(row.height);
    for (const status of ['determined', 'settled']) {
      const reached = status === 'determined' ? ['determined', 'settled'].includes(row.status) : row.status === 'settled';
      const key = `${reader}:${row.sequence}:${status}`;
      if (reached && !observed.has(key)) observed.set(key, now);
      // A Desk payment is measured by its tx hash as well, for the export.
      if (reached && clicks.has(row.tx) && !observed.has(`${reader}:${row.tx}:${status}`)) observed.set(`${reader}:${row.tx}:${status}`, now);
    }
    row.observed = { determined: observed.get(`${reader}:${row.sequence}:determined`) ?? null,
      settled: observed.get(`${reader}:${row.sequence}:settled`) ?? null };
    row.clickAt = clicks.get(row.tx)?.clickAt ?? null;
  }
  return rows.reverse();
}

/** Track every divergence through its window, and our challenge if we sent one. */
async function trackIncidents(watch, windowSecs, roll) {
  const now = Date.now();
  const current = new Map(incidentsFrom(watch).map(i => [i.key, i]));
  for (const [key, i] of current) {
    const known = incidents.get(key);
    incidents.set(key, { ...known, ...i, firstSeen: known?.firstSeen ?? now,
      deadline: i.submittedTime ? i.submittedTime + windowSecs : null });
  }
  for (const [key, i] of incidents) {
    if (!current.has(key) && PENDING.has(i.status)) incidents.set(key, { ...i, status: 'replaced or rejected', closedAt: now });
  }
  if (watcherFile) {
    for (const v of watch.verdicts) {
      const key = `${v.index}:${v.stateRoot}`;
      const i = incidents.get(key);
      if (v.verdict !== 'diverged' || v.status !== 'submitted' || !i || i.ours) continue;
      watcher ??= await mnemonicAccount(watcherFile);
      if (watcher.cosmos === roll.creator) { i.ours = { error: 'watcher must not be the rollup creator' }; continue; }
      i.ours = { pending: true };
      i.ours = await challenge(watcher, v.index, v.proofHex);
    }
  }
  // The chain's own verdict, whoever won the race.
  const key = JSON.stringify([...incidents.values()].map(i => [i.key, i.status]));
  if (!outcomes || key !== outcomesKey) { outcomes = await challengeOutcomes(); outcomesKey = key; }
  const list = [...incidents.values()].map(i => ({ ...i, upheld: outcomes.find(o => o.index === i.index && o.height >= (i.submittedAt ?? 0)) ?? null }));
  const past = outcomes.filter(o => !list.some(i => i.upheld?.hash === o.hash)).map(o => ({ index: o.index, status: 'rejected', verdict: 'diverged', upheld: o }));
  return [...list, ...past].sort((a, b) => b.index - a.index || (b.upheld?.height ?? 0) - (a.upheld?.height ?? 0));
}

export async function snapshot() {
  const id = identities();
  const [roll, inbox, latest, registered] = await Promise.all([
    client.rest.getRollup(rollupId), client.rest.getInbox(rollupId),
    client.rest.getLatestBatch(rollupId), registryKey(auditorAddress),
  ]);
  const bond = await client.rest.getSubmitterBond(rollupId, roll.creator);
  const auditorKey = registered && kemFingerprint(registered.key);
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
  const key = JSON.stringify([inbox, all, bond, auditorKey, roll.challengeWindowSec]);
  if (lastKey === key) {
    // Nothing moved: the last check still holds, and the watcher is current.
    lastState.watch.checkedAt = Date.now();
    return lastState;
  }
  const { entries } = await inboxEntries(inbox);
  const windowSecs = roll.challengeWindowSec ?? (await client.rest.getParams()).defaultChallengeWindow;
  const watch = watchBatches({ entries, batches: all });
  const verdictOf = index => watch.verdicts.find(v => v.index === index);
  const batchList = all.map(b => ({ index: b.batchIndex, status: b.status, start: b.inboxStart, end: b.inboxEnd,
    height: b.status === 'finalized' ? b.finalizedAt : b.submittedAt, submittedAt: b.submittedAt,
    submittedTime: b.submittedTime ?? null, finalizedAt: b.finalizedAt || null, verdict: verdictOf(b.batchIndex)?.verdict,
    deadline: b.submittedTime ? b.submittedTime + windowSecs : null,
    deadlineHeight: b.submittedTime ? null : b.submittedAt + Math.floor(windowSecs / 1.427) }));
  const { bindings, events } = discoverReaderKeys(entries);
  const { ledger, executions, withdrawals } = replayExecutions(entries);
  const paymentsBySequence = new Map([...executions, ...withdrawals].map(tx => [tx.sequence, tx]));
  const receipts = new Map();
  const receiptFor = batch => {
    if (!receipts.has(batch.batchIndex)) receipts.set(batch.batchIndex, verifyBatch(batch));
    return receipts.get(batch.batchIndex);
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
    watch: { checkedAt: Date.now(), pending: pending.length, diverged: pending.filter(v => v.verdict !== 'ok').map(v => v.index),
      fault: watch.fault?.index ?? null, challenging: Boolean(watcherFile) },
    incidents: await trackIncidents(watch, windowSecs, roll),
    entries: entries.map(e => ({ sequence: e.sequence, height: String(e.height), poster: e.poster, tx: e.tx.hash,
      batch: batchList.find(b => b.status !== 'rejected' && b.start < e.sequence && e.sequence <= b.end)?.index,
      ...classifyEntry(e, paymentsBySequence.get(e.sequence), events.find(x => x.sequence === e.sequence)) })).reverse(),
    payee: { ...payee, account: id.payeeId, fingerprint: bound?.fingerprint, ownKey, sequence: bound?.sequence },
    auditor: { ...auditor, address: auditorAddress, fingerprint: auditorKey } };
  lastBatches = all;
  lastState = state;
  lastKey = key;
  return state;
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
    out.push({ tx: hash, sequence: row?.sequence ?? null, clickAt: c.clickAt, broadcastReturnedAt: c.sentAt,
      committed: { height: c.height, time: committedTime }, payee: reader('payee'), auditor: reader('auditor'),
      batch: batch ? { index: batch.index, submittedAt: batch.submittedAt, submittedTime: batch.submittedTime,
        finalizedAt: batch.finalizedAt, finalizedTime } : null });
  }
  return { rollup: rollupId, measurements: out };
}
