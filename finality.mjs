// Fast finality for Veil readers (#12).
//
// qledger-v1 execution is a deterministic function of the ordered inbox, and
// Diana commits each block once. A payment's outcome is therefore fixed in the
// block that posts it; a batch only attests to it, and the challenge window
// only decides when L1 will pay withdrawals. A reader who replays the inbox and
// watches every pending batch can treat the payment as determined at its first
// committed block, and as settled when its batch finalizes with a valid receipt.
//
// The guarantee needs one honest watcher during each window: an unchallenged
// divergent batch would finalize on L1 and withdrawals would follow it.
import { Buffer } from 'node:buffer';
import {
  EMPTY_INBOX_ACC,
  QLEDGER_DEPOSIT_POSTER_PREFIX,
  QledgerLedger,
  buildQledgerFraudProof,
  checkQledgerFraud,
  encodeQledgerDeposit,
  executeQledger,
  inboxRangeHash,
  qledgerAccumulate,
} from '@qorechain/rdk';
import { env, hex, sha256 } from './veil.mjs';

export const POST_TYPE = '/qorechain.rdk.v1.MsgPostRollupData';
export const PENDING = new Set(['submitted', 'challenged']);

const attrs = (ev) => Object.fromEntries((ev.attributes ?? []).map((a) => [String(a.key), String(a.value ?? '')]));

/**
 * Inbox entries `from + 1 .. to` with the L1 transaction that carried each one,
 * from raw `tx_responses` of the `rdk_data_posted` and `rdk_rollup_deposit`
 * searches. Same reading as RDK `fetchQledgerEntries`, plus `tx`: the hash,
 * result code and message index. The caller checks the accumulator.
 */
export function entriesFromTxs({ rollupId = env.rollupId, posts = [], deposits = [], from, to }) {
  from = Number(from);
  to = Number(to);
  const bySeq = new Map();
  const put = (seq, entry) => {
    const known = bySeq.get(seq);
    if (known && known.tx.hash !== entry.tx.hash) throw new Error(`inbox entry ${seq} appears in two transactions`);
    bySeq.set(seq, entry);
  };
  for (const tx of posts) {
    const messages = tx.tx?.body?.messages ?? [];
    const used = new Set();
    for (const ev of tx.events ?? []) {
      if (ev.type !== 'rdk_data_posted') continue;
      const a = attrs(ev);
      if (a.rollup_id !== rollupId) continue;
      const seq = Number(a.sequence);
      if (!(seq > from && seq <= to)) continue;
      const fits = (m, i) => m['@type'] === POST_TYPE && !used.has(i) && m.rollup_id === rollupId
        && String(m.poster) === a.poster && hex(sha256(Buffer.from(String(m.data ?? ''), 'base64'))) === a.data_hash;
      const hinted = a.msg_index !== undefined && a.msg_index !== '' ? Number(a.msg_index) : undefined;
      const msgIndex = hinted !== undefined && messages[hinted] && fits(messages[hinted], hinted)
        ? hinted : messages.findIndex(fits);
      if (msgIndex < 0) throw new Error(`post ${seq} is in transaction ${tx.txhash} but its payload could not be matched`);
      used.add(msgIndex);
      put(seq, {
        sequence: seq, height: BigInt(String(tx.height)), poster: a.poster,
        payload: Buffer.from(String(messages[msgIndex].data), 'base64'),
        tx: { hash: String(tx.txhash).toUpperCase(), code: Number(tx.code ?? 0), msgIndex },
      });
    }
  }
  for (const tx of deposits) {
    for (const ev of tx.events ?? []) {
      if (ev.type !== 'rdk_rollup_deposit') continue;
      const a = attrs(ev);
      if (a.rollup_id !== rollupId) continue;
      const seq = Number(a.sequence);
      if (!(seq > from && seq <= to)) continue;
      put(seq, {
        sequence: seq, height: BigInt(String(tx.height)), poster: QLEDGER_DEPOSIT_POSTER_PREFIX + a.depositor,
        payload: encodeQledgerDeposit(Buffer.from(a.account, 'hex'), BigInt(a.amount.replace(/uqor$/, ''))),
        tx: { hash: String(tx.txhash).toUpperCase(), code: Number(tx.code ?? 0), msgIndex: null },
      });
    }
  }
  const entries = [];
  for (let s = from + 1; s <= to; s++) {
    const e = bySeq.get(s);
    if (!e) throw new Error(`inbox entry ${s} was not found in the node's transaction index`);
    entries.push(e);
  }
  return entries;
}

/** The inbox accumulator after `entries`, from `accFrom` at sequence `from`, as hex. */
export function accumulate(entries, from = 0, accFrom = EMPTY_INBOX_ACC) {
  return hex(qledgerAccumulate({ ...env, from, accFrom, entries }));
}

/**
 * The reader's watcher. Replays the whole inbox from genesis and checks every
 * current batch in order: its range and data hash against the inbox, its parent
 * root against the replay, and its state and withdrawals roots with the chain's
 * own fraud rule. Each finalized batch is a checkpoint the replay must match.
 *
 * `entries` is the full inbox 1..head in order; `batches` is the current batch
 * at each index (a rejected one is rolled back and skipped). Throws when the
 * view itself is inconsistent (a range gap or a data hash the chain would not
 * have admitted): the caller retries rather than drawing a verdict from it.
 *
 * Verdicts: `ok`, `diverged` (with the fraud proof), `diverged-parent` (extends
 * a divergent batch, so it falls with it), `rolled-back`, `unchecked` (after a
 * fault). `fault` is the first finalized batch that diverges: L1 settled a state
 * the replay does not reach, so nothing after it can be determined.
 */
export function watchBatches({ entries, batches }) {
  const ledger = new QledgerLedger();
  let acc = EMPTY_INBOX_ACC;
  let cursor = 0;
  let fault = null;
  const verdicts = [];
  for (const b of [...batches].sort((x, y) => x.batchIndex - y.batchIndex)) {
    const base = { index: b.batchIndex, status: b.status, start: b.inboxStart, end: b.inboxEnd, stateRoot: b.stateRoot,
      submittedAt: b.submittedAt, submittedTime: b.submittedTime, finalizedAt: b.finalizedAt };
    if (b.status === 'rejected') { verdicts.push({ ...base, verdict: 'rolled-back' }); continue; }
    if (fault) { verdicts.push({ ...base, verdict: 'unchecked' }); continue; }
    if (b.inboxStart !== cursor) throw new Error(`batch ${b.batchIndex} starts at ${b.inboxStart}, the replay is at ${cursor}`);
    if (b.inboxEnd > entries.length) throw new Error(`batch ${b.batchIndex} ends at ${b.inboxEnd}, the inbox read has ${entries.length}`);
    const slice = entries.slice(b.inboxStart, b.inboxEnd);
    const range = { ...env, from: b.inboxStart, to: b.inboxEnd, accFrom: acc };
    const accTo = qledgerAccumulate({ ...range, entries: slice });
    if (hex(inboxRangeHash({ ...range, accTo })) !== b.dataHash) throw new Error(`batch ${b.batchIndex} data hash does not match the inbox read`);
    const verdict = { ...base };
    if (b.prevStateRoot !== hex(ledger.root())) {
      verdict.verdict = 'diverged-parent';
    } else {
      const { proof, honest } = buildQledgerFraudProof(env, ledger, acc, slice);
      const fraud = checkQledgerFraud(env, b, proof);
      Object.assign(verdict, {
        verdict: fraud ? 'diverged' : 'ok',
        expected: { stateRoot: hex(honest.stateRoot), withdrawalsRoot: hex(honest.withdrawalsRoot) },
        ...(fraud ? { proofHex: hex(proof), proofSha256: hex(sha256(proof)) } : {}),
      });
    }
    // The replay always continues with the honest execution.
    executeQledger(env, ledger, slice);
    acc = accTo;
    cursor = b.inboxEnd;
    if (verdict.verdict !== 'ok' && b.status === 'finalized') fault = verdict;
    verdicts.push(verdict);
  }
  return { verdicts, fault, consumed: cursor, root: hex(ledger.root()) };
}

/**
 * What stands between an executed entry and `determined`: the finality fault,
 * or the first pending batch that diverges and starts before the entry. A
 * divergent ancestor counts even when it ends before the entry, because its
 * rollback re-opens everything after it.
 */
export function dispute(watch, sequence) {
  if (watch.fault && watch.fault.start < sequence) {
    return { batch: watch.fault.index, reason: `finalized batch ${watch.fault.index} diverges from the replay` };
  }
  const bad = watch.verdicts.find((v) => PENDING.has(v.status) && v.start < sequence && v.verdict !== 'ok');
  return bad ? { batch: bad.index, reason: `batch ${bad.index} (${bad.status}) diverges from the replay` } : undefined;
}

/**
 * Divergent submissions. The key names one submission (index, claimed root and
 * submission height): after a rejection the same index, even the same root, can
 * be submitted again, and that is a new incident.
 */
export function incidentsFrom(watch) {
  return watch.verdicts.filter((v) => v.verdict === 'diverged' || v.verdict === 'diverged-parent')
    .map((v) => ({ key: `${v.index}:${v.stateRoot}:${v.submittedAt}`, index: v.index, stateRoot: v.stateRoot, status: v.status,
      verdict: v.verdict, submittedAt: v.submittedAt, submittedTime: v.submittedTime, proofSha256: v.proofSha256,
      proofHex: v.proofHex, expected: v.expected }));
}
