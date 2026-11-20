// Divergent batches through their challenge window (#12): the reader's own
// challenge, delivered with retries, and the chain's verdict whoever won.
import { incidentsFrom, PENDING } from '../finality.mjs';

const BACKOFF_MS = [5_000, 10_000, 20_000, 40_000, 60_000];
/** How long a broadcast hash may stay unknown to the node before it is sent again. */
const CONFIRM_MS = 30_000;
const DONE = new Set(['included', 'stopped', 'expired']);

/**
 * `send(index, proofHex)` submits a challenge and resolves to { hash, code },
 * with `code: null` when the outcome is unknown, or { fatal } when it must not
 * be retried; omit it for a reader that only watches. `lookupTx(hash)` resolves
 * to { code, height }, or null when the node does not know the hash.
 * `fetchOutcomes(minHeight)` resolves to the upheld challenges from that height.
 */
export function createIncidentTracker({ send, lookupTx, fetchOutcomes, now = Date.now, refreshMs = 10_000 }) {
  const incidents = new Map();
  const outcomes = new Map();
  let cursor = 0;
  let refreshedAt;

  /** One step of our challenge for a divergent batch. Never throws. */
  async function deliver(i, t) {
    const c = (i.ours ??= { state: 'idle', attempts: 0 });
    if (DONE.has(c.state)) return;
    if (c.hash && c.code == null) {
      // A broadcast whose result we never saw: ask the chain before sending again.
      let found;
      try { found = await lookupTx(c.hash); } catch { return; }
      if (found) Object.assign(c, { code: found.code, height: found.height });
      else if (t - c.lastAttemptAt < CONFIRM_MS) return;
      else c.hash = null;
    }
    if (c.hash && c.code === 0) { c.state = 'included'; return; }
    // Terminal chain outcomes, including another watcher's win.
    if (i.status === 'challenged') return; // someone's challenge is being decided
    if (i.status !== 'submitted') { Object.assign(c, { state: 'stopped', reason: `batch is ${i.status}` }); return; }
    if (i.deadline && t >= i.deadline * 1000) { c.state = 'expired'; return; }
    if (t < (c.nextAttemptAt ?? 0)) return;
    c.attempts += 1;
    c.lastAttemptAt = t;
    c.nextAttemptAt = t + BACKOFF_MS[Math.min(c.attempts, BACKOFF_MS.length) - 1];
    let res;
    try { res = await send(i.index, i.proofHex); } catch (err) { res = { error: String(err?.message ?? err).slice(0, 300) }; }
    if (res.fatal) { Object.assign(c, { state: 'stopped', reason: res.fatal }); return; }
    Object.assign(c, { hash: res.hash ?? null, code: res.hash ? res.code ?? null : null, height: res.height, error: res.error });
    c.state = c.hash && c.code === 0 ? 'included' : c.hash && c.code == null ? 'sent' : 'retrying';
  }

  /**
   * `watch` is the current result of `watchBatches`; `changed` says the batch
   * list moved since the last call. Call it on every read, changed or not:
   * retries and third-party outcomes do not depend on a new view. `height` is
   * a chain height read before the view, when known: the view is at least that
   * recent, so a submission it shows pending was not rejected at or below it.
   */
  async function update({ watch, windowSecs, changed = true, height }) {
    const t = now();
    const current = new Map(incidentsFrom(watch).map(i => [i.key, i]));
    for (const [key, i] of current) {
      const known = incidents.get(key);
      const pendingAt = PENDING.has(i.status) && height !== undefined ? Math.max(known?.pendingAt ?? 0, height) : known?.pendingAt;
      incidents.set(key, { ...known, ...i, firstSeen: known?.firstSeen ?? t, pendingAt,
        deadline: i.submittedTime ? i.submittedTime + windowSecs : null });
    }
    for (const [key, i] of incidents) {
      // A divergent batch leaves the view only by rejection (the chain may then replace it at the same index).
      if (!current.has(key) && !i.closedAt) incidents.set(key, { ...i, status: 'rejected', closedAt: t });
    }
    const open = [...incidents.values()].filter(i => !i.closedAt);
    if (send) {
      for (const i of incidents.values()) {
        if (i.verdict === 'diverged' && i.proofHex && (i.ours || !i.closedAt)) await deliver(i, t);
      }
    }
    // The chain's verdicts, on their own cursor: a third party can win between two reads.
    if (fetchOutcomes && (changed || open.length || refreshedAt === undefined || t - refreshedAt >= refreshMs)) {
      try {
        for (const o of await fetchOutcomes(cursor)) {
          outcomes.set(`${o.hash}:${o.index}`, o);
          cursor = Math.max(cursor, o.height);
        }
        refreshedAt = t;
      } catch { /* keep what we know; the next read asks again */ }
    }
    // A verdict belongs to the one submission it rejected. Heights alone cannot
    // order a verdict and a resubmission inside one block, so the rule uses what
    // the views showed: the owner is a submission that has left the view, was
    // submitted at or before the verdict, and was not seen pending at or after
    // the verdict's height. Verdicts are taken in height order and each goes to
    // the earliest such submission without one; a submission still pending owns none.
    const owner = new Map();
    const past = [];
    for (const o of [...outcomes.values()].sort((a, b) => a.height - b.height)) {
      const own = [...incidents.values()]
        .filter(i => i.closedAt && i.verdict === 'diverged' && i.index === o.index && !owner.has(i.key)
          && i.submittedAt <= o.height && !(i.pendingAt >= o.height))
        .sort((a, b) => a.submittedAt - b.submittedAt)[0];
      if (own) owner.set(own.key, o);
      else past.push({ index: o.index, status: 'rejected', verdict: 'diverged', upheld: o });
    }
    const list = [...incidents.values()].map(({ proofHex, ...i }) => ({ ...i, upheld: owner.get(i.key) ?? null }));
    return [...list, ...past].sort((a, b) => b.index - a.index
      || (b.submittedAt ?? b.upheld?.height ?? 0) - (a.submittedAt ?? a.upheld?.height ?? 0));
  }
  return { update };
}
