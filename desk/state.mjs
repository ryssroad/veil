import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { qledgerKeypairFromSeed } from '@qorechain/rdk';
import { sealKeysFromSeed } from '@qorechain/qoreseal';
import { rollupId, hex, discoverReaderKeys, replayExecutions, kemFingerprint } from '../veil.mjs';
import { client, getJson, inboxEntries, batches, payeeKeys, registryKey, verifyBatch, readInvoices } from './chain.mjs';
import { classifyEntry } from './model.mjs';

export const auditorAddress = process.env.VEIL_AUDITOR || 'qor1kc6lwdz77q6f32vcfae35yu3k84l58t5xrsy3l';
const payeeDir = process.env.VEIL_PAYEE_DIR || '.private/clients/payee';
const auditorDir = process.env.VEIL_AUDITOR_DIR || '.private/clients/auditor';
const times = new Map();
let lastKey, lastState, lastBatches, checkedInbox, keys;

function identities() {
  if (keys) return keys;
  const payer = qledgerKeypairFromSeed(readFileSync('.private/payer-l2.seed'));
  const payee = payeeKeys(payeeDir);
  const auditor = sealKeysFromSeed(readFileSync(join(auditorDir, 'seal.seed')));
  keys = { payerId: payer.accountId, payeeId: hex(payee.l2.accountId), payee: payee.seal, auditor };
  return keys;
}
async function withTimes(rows) {
  for (const row of rows) {
    if (!times.has(row.height)) {
      const b = await getJson('/cosmos/base/tendermint/v1beta1/blocks/' + row.height);
      times.set(row.height, (b.block ?? b.sdk_block).header.time);
    }
    row.time = times.get(row.height);
  }
  return rows.reverse();
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
  if (Number(all.at(-1)?.inboxEnd ?? 0) !== Number(inbox.consumedSequence)) throw new Error('Inbox moved during refresh');
  const key = JSON.stringify([inbox, all, bond, auditorKey, roll.challengeWindowSec]);
  if (lastKey === key) return lastState;
  if (checkedInbox?.inbox.headAcc !== inbox.headAcc) checkedInbox = await inboxEntries(inbox);
  const { entries } = checkedInbox;
  const windowSecs = roll.challengeWindowSec ?? (await client.rest.getParams()).defaultChallengeWindow;
  const batchList = all.map(b => ({ index: b.batchIndex, status: b.status, start: b.inboxStart, end: b.inboxEnd,
    height: b.status === 'finalized' ? b.finalizedAt : b.submittedAt,
    deadline: b.submittedTime ? b.submittedTime + windowSecs : null,
    deadlineHeight: b.submittedTime ? null : b.submittedAt + Math.floor(windowSecs / 6) }));
  const { bindings, events } = discoverReaderKeys(entries);
  const { ledger, executions } = replayExecutions(entries);
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
  async function reader(dir, sealKeys, mine, warning) {
    if (warning || !auditorKey) return { rows: [], skipped: [], conflicts: [], warning: warning || 'Auditor key unavailable.' };
    const r = await readInvoices({ dir, sealKeys, mine, auditorKey, entries, all, executions, receiptFor, dedupeConflicts: true });
    return { rows: await withTimes(r.rows), skipped: r.skipped.filter(s => !r.rows.some(x => x.sequence === s.sequence)),
      conflicts: r.conflicts, warning };
  }
  const payee = await reader(payeeDir, id.payee, id.payeeId, payeeWarning);
  const auditor = await reader(auditorDir, id.auditor, undefined, auditorWarning);
  const balance = ledger.get(id.payerId);
  const state = { rollup: rollupId, payer: { account: hex(id.payerId), balance: String(balance.balance), nonce: String(balance.nonce) },
    signing: Boolean(process.env.VEIL_OPERATOR_MNEMONIC), inbox: { head: inbox.headSequence, consumed: inbox.consumedSequence },
    bond: String(bond.amount), batches: batchList,
    entries: entries.map(e => ({ sequence: e.sequence, height: String(e.height), poster: e.poster,
      batch: batchList.find(b => b.start < e.sequence && e.sequence <= b.end)?.index,
      ...classifyEntry(e, executions.find(x => x.sequence === e.sequence), events.find(x => x.sequence === e.sequence)) })).reverse(),
    payee: { ...payee, account: id.payeeId, fingerprint: bound?.fingerprint, ownKey, sequence: bound?.sequence },
    auditor: { ...auditor, address: auditorAddress, fingerprint: auditorKey } };
  lastBatches = all;
  lastState = state;
  lastKey = key;
  return state;
}
