// Live fraud demo on Veil's own testnet rollup (veil-pay-1, QoreChain Diana only).
//
// The operator submits batch 2 with a forged state: the payer's remaining
// 750,000 uqor moves into a withdrawal to the operator, with no payer signature.
// The consumed inbox entry is a public marker that qledger ignores, so the
// honest root equals the parent root. A watchtower on a separate account
// re-executes the batch from chain data, proves the mismatch and challenges.
// Diana then slashes the operator's 1,000 QOR bond (500 burned, 500 to the
// challenger), rejects the batch and rolls the inbox cursor back. The operator
// re-bonds and submits the honest replacement. Only the team's funds are at stake.
//
// Steps (run from the repository root; mnemonic files never leave this machine):
//   new-watcher                                  create .private/watcher.mnemonic
//   fund-watcher    <operator.mnemonic>          send 5 QOR to the watcher
//   register-watcher                             register the watcher's ML-DSA-87 key
//   post            <operator.mnemonic> --i-accept-bond-loss
//   watch                                        long-running watchtower (separate terminal)
//   bad-batch       <operator.mnemonic> --i-accept-bond-loss --watcher-running
//   challenge                                    fallback if `watch` did not challenge
//   rebond          <operator.mnemonic>
//   replace         <operator.mnemonic>
//   status
import assert from 'node:assert/strict';
import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import {
  createRdkClient,
  createRdkRegistry,
  executeQledger,
  fetchQledgerEntries,
  inboxRangeHash,
  qledgerAccumulate,
  QledgerLedger,
  planQledgerBatch,
  postRollupDataMsg,
  submitBatchMsg,
  challengeBatchMsg,
  bondRollupSubmitterMsg,
  anchorSignBytesForBatch,
  buildQledgerFraudProof,
  checkQledgerFraud,
  qledgerWithdrawalsRoot,
  isRestNotFound,
  QLEDGER_WITHDRAWAL_COUNTER_ID,
} from '@qorechain/rdk';
import {
  deriveUnifiedAccount,
  EthNativeSigner,
  pqcSign,
  generateMnemonic,
  buildRegisterPqcKeyMsg,
  signProofOfPossession,
  fetchPqcStatus,
} from '@qorechain/sdk';
import { StargateClient } from '@cosmjs/stargate';
import { env, chainId, rollupId, hex } from './invoice.mjs';

const STEPS = ['new-watcher', 'fund-watcher', 'register-watcher', 'post', 'watch', 'bad-batch',
  'challenge', 'rebond', 'replace', 'status'];
const [step, keyFile] = process.argv.slice(2);
assert.ok(STEPS.includes(step), 'step: ' + STEPS.join(' | '));
assert.equal(chainId, 'qorechain-diana', 'testnet only');
assert.equal(rollupId, 'veil-pay-1', 'Veil demo rollup only');
const flag = (f) => process.argv.includes(f);
if (['post', 'bad-batch'].includes(step)) assert.ok(flag('--i-accept-bond-loss'), 'pass --i-accept-bond-loss');
if (step === 'bad-batch') assert.ok(flag('--watcher-running'), 'start `watch` first, then pass --watcher-running');

const WATCHER = '.private/watcher.mnemonic';
const BOND = 1_000_000_000n;
const dir = 'evidence/fraud/';
mkdirSync(dir, { recursive: true });
mkdirSync('.private', { recursive: true, mode: 0o700 });
const json = (v) => JSON.stringify(v, (_, x) => (typeof x === 'bigint' ? String(x) : x), 2) + '\n';
const save = (name, v) => writeFileSync(dir + name + '.json', json(v), { flag: 'wx' });
const put = (name, v) => writeFileSync(dir + name + '.json', json(v));
const load = (name) => JSON.parse(readFileSync(dir + name + '.json', 'utf8'));
const sha = (b) => createHash('sha256').update(b).digest('hex');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const now = () => new Date().toISOString();

const client = createRdkClient({ network: 'testnet' });
const rest = client.network.endpoints.rest;
const accountFrom = async (file) => {
  assert.ok(file && existsSync(file), 'mnemonic file not found: ' + file);
  return deriveUnifiedAccount(readFileSync(file, 'utf8').trim());
};
async function getJson(route) {
  const res = await fetch(rest + route);
  assert.ok(res.ok, route + ' HTTP ' + res.status);
  return res.json();
}
async function balance(address) {
  const d = await getJson('/cosmos/bank/v1beta1/balances/' + address + '/by_denom?denom=uqor');
  return BigInt(d.balance.amount);
}
async function batchOrNull(index) {
  try {
    return await client.rest.getBatch(rollupId, index);
  } catch (err) {
    if (isRestNotFound(err)) return null;
    throw err;
  }
}

async function broadcast(account, messages, { mode = 'hybrid', registry = createRdkRegistry(), record } = {}) {
  const transport = await StargateClient.connect(client.network.endpoints.rpc);
  try {
    assert.equal(await transport.getChainId(), chainId);
    const { account: auth } = await getJson('/cosmos/auth/v1beta1/accounts/' + account.cosmos);
    const base = auth.base_account ?? auth;
    const signer = new EthNativeSigner(account, { rest, signMode: mode, ...(registry ? { registry } : {}) });
    const tx = await signer.signAndBroadcast(transport, {
      chainId,
      messages,
      accountNumber: BigInt(base.account_number),
      sequence: BigInt(base.sequence),
      fee: { amount: [{ denom: 'uqor', amount: '270000' }], gas: '1800000' },
    });
    const out = { step: record, hash: tx.transactionHash, height: tx.height, code: tx.code, sender: account.cosmos, at: now() };
    console.log(out);
    if (record && tx.code === 0) save(record, out);
    return out;
  } finally {
    transport.disconnect();
  }
}

// Verified parent state after batch 1, from the transcript replayed in #3.
function transcriptParent() {
  const records = readFileSync('evidence/withdrawal/transcript.jsonl', 'utf8')
    .trim().split('\n').map((l) => JSON.parse(l));
  const ledger = new QledgerLedger();
  for (const r of records) {
    const entries = r.entries.map((e) => ({
      height: BigInt(e.height), poster: e.poster, payload: Buffer.from(e.payloadHex, 'hex'),
    }));
    assert.equal(hex(executeQledger(env, ledger, entries).stateRoot), r.batch.stateRoot);
  }
  return { ledger, acc: records.at(-1).accTo, nextIndex: records.length };
}

const roll = await client.rest.getRollup(rollupId);

if (step === 'new-watcher') {
  assert.ok(!existsSync(WATCHER), WATCHER + ' exists, refusing to overwrite');
  writeFileSync(WATCHER, generateMnemonic(256) + '\n', { mode: 0o600 });
  chmodSync(WATCHER, 0o600);
  const w = await accountFrom(WATCHER);
  console.log({ watcher: w.cosmos, file: WATCHER });
} else if (step === 'fund-watcher') {
  const op = await accountFrom(keyFile);
  const w = await accountFrom(WATCHER);
  assert.equal(op.cosmos, roll.creator, 'first argument must be the operator mnemonic');
  assert.notEqual(w.cosmos, op.cosmos);
  await broadcast(op, [{
    typeUrl: '/cosmos.bank.v1beta1.MsgSend',
    value: { fromAddress: op.cosmos, toAddress: w.cosmos, amount: [{ denom: 'uqor', amount: '5000000' }] },
  }], { record: 'fund-watcher' });
} else if (step === 'register-watcher') {
  const w = await accountFrom(WATCHER);
  const pqc = await fetchPqcStatus({ rest, address: w.cosmos });
  if (pqc.registered) {
    console.log({ watcher: w.cosmos, registered: true, possessionProven: pqc.possessionProven });
  } else {
    const proofOfPossession = signProofOfPossession({ chainId, account: w.cosmos, keypair: w.pqc });
    await broadcast(w, [buildRegisterPqcKeyMsg(w.cosmos, { pqcKeypair: w.pqc, proofOfPossession })],
      { mode: 'classical', registry: null, record: 'register-watcher' });
  }
} else if (step === 'post') {
  const op = await accountFrom(keyFile);
  assert.equal(roll.creator, op.cosmos, 'operator mnemonic required');
  const inbox = await client.rest.getInbox(rollupId);
  const latest = await client.rest.getLatestBatch(rollupId);
  assert.deepEqual(
    [latest.batchIndex, latest.status, Number(inbox.headSequence), Number(inbox.consumedSequence)],
    [1, 'finalized', 4, 4],
  );
  const bond = await client.rest.getSubmitterBond(rollupId, op.cosmos);
  assert.equal(BigInt(bond.amount), BOND, 'expected exactly 1,000 QOR bonded');
  assert.equal(Number(bond.pending), 0);
  const marker = Buffer.from(
    'veil/fraud-demo/v1: public marker for a deliberately forged batch; qledger ignores it. ' + now(),
  );
  put('marker', { payloadUtf8: marker.toString(), sha256: sha(marker) });
  await broadcast(op, [postRollupDataMsg({ rollupId, poster: op.cosmos, data: marker })], { record: 'post' });
} else if (step === 'bad-batch') {
  const op = await accountFrom(keyFile);
  assert.equal(roll.creator, op.cosmos, 'operator mnemonic required');
  const inbox = await client.rest.getInbox(rollupId);
  const latest = await client.rest.getLatestBatch(rollupId);
  assert.deepEqual(
    [latest.batchIndex, latest.status, Number(inbox.headSequence), Number(inbox.consumedSequence)],
    [1, 'finalized', 5, 4],
  );
  const marker = load('marker');
  const { ledger } = transcriptParent();
  assert.equal(hex(ledger.root()), latest.stateRoot);
  const plan = await planQledgerBatch(client.rest, { ...env, submitter: op.cosmos, ledger });
  assert.equal(plan.input.batchIndex, 2n);
  assert.equal(plan.input.inboxEnd, 5n);
  assert.equal(plan.entries.length, 1);
  assert.equal(sha(plan.entries[0].payload), marker.sha256, 'entry 5 is not our marker');
  assert.equal(hex(plan.input.stateRoot), latest.stateRoot, 'marker must not change state');
  assert.equal(hex(plan.input.withdrawalsRoot), '');

  // Forgery: drain the payer's L2 balance into a withdrawal to the operator.
  const forged = ledger.clone();
  const payer = ledger.accounts().find(
    (a) => hex(a.id) !== hex(QLEDGER_WITHDRAWAL_COUNTER_ID) && a.balance === 750000n,
  );
  assert.ok(payer, 'payer with 750,000 uqor not found');
  const next = forged.get(QLEDGER_WITHDRAWAL_COUNTER_ID).balance;
  forged.set(payer.id, 0n, payer.nonce);
  forged.set(QLEDGER_WITHDRAWAL_COUNTER_ID, next + 1n, 0n);
  const fakeWithdrawals = [{ index: next, recipient: op.cosmos, amount: payer.balance }];
  const input = {
    ...plan.input,
    stateRoot: forged.root(),
    withdrawalsRoot: qledgerWithdrawalsRoot(chainId, rollupId, fakeWithdrawals),
  };

  // Refuse to submit unless the forgery is provable.
  const { proof } = buildQledgerFraudProof(env, ledger, inbox.consumedAcc, plan.entries);
  const claim = (i) => ({
    inboxStart: 4, inboxEnd: 5, dataHash: hex(i.dataHash), prevStateRoot: hex(i.prevStateRoot),
    stateRoot: hex(i.stateRoot), withdrawalsRoot: hex(i.withdrawalsRoot),
  });
  assert.equal(checkQledgerFraud(env, claim(plan.input), proof), false);
  assert.equal(checkQledgerFraud(env, claim(input), proof), true);
  put('forgery', {
    batchIndex: 2, range: [4, 5], payerAccount: hex(payer.id),
    honest: { stateRoot: hex(plan.input.stateRoot), withdrawalsRoot: '' },
    forged: { stateRoot: hex(input.stateRoot), withdrawalsRoot: hex(input.withdrawalsRoot), withdrawals: fakeWithdrawals },
    proofHex: hex(proof), proofSha256: sha(proof),
  });
  const anchor = anchorSignBytesForBatch({ chainId, layerId: roll.layerId, ...input });
  await broadcast(op, [submitBatchMsg({
    ...input, sequencer: op.cosmos, anchorSignature: pqcSign(op.pqc.secretKey, anchor),
  })], { record: 'bad-batch' });
} else if (step === 'watch') {
  // Watchtower: knows nothing about the forgery; re-executes every new batch
  // from chain data and challenges any batch whose roots do not follow.
  const w = await accountFrom(WATCHER);
  assert.notEqual(w.cosmos, roll.creator, 'the watcher must be a separate account');
  const pqc = await fetchPqcStatus({ rest, address: w.cosmos });
  assert.ok(pqc.registered && pqc.possessionProven, 'run register-watcher first');
  const log = (event) => {
    const line = { at: now(), ...event };
    console.log(JSON.stringify(line));
    appendFileSync(dir + 'watch.jsonl', JSON.stringify(line) + '\n');
  };
  let { ledger, acc, nextIndex } = transcriptParent();
  const b1 = await client.rest.getBatch(rollupId, nextIndex - 1);
  assert.equal(hex(ledger.root()), b1.stateRoot, 'transcript parent is not batch ' + (nextIndex - 1));
  log({ event: 'start', watcher: w.cosmos, balanceUqor: String(await balance(w.cosmos)), parentBatch: nextIndex - 1, parentRoot: b1.stateRoot });
  const seen = new Set();
  let challenged = false;
  for (;;) {
    try {
      const batch = await batchOrNull(nextIndex);
      const key = batch && `${batch.batchIndex}:${batch.stateRoot}:${batch.status}`;
      if (batch && !seen.has(key)) {
        seen.add(key);
        if (batch.status === 'submitted' || batch.status === 'finalized') {
          assert.equal(batch.prevStateRoot, hex(ledger.root()), 'batch does not extend the verified parent');
          const range = { ...env, from: batch.inboxStart, to: batch.inboxEnd, accFrom: acc };
          const entries = await fetchQledgerEntries(client.rest, range);
          const accTo = qledgerAccumulate({ ...range, entries });
          assert.equal(hex(inboxRangeHash({ ...range, accTo })), batch.dataHash, 'entries do not match dataHash');
          const { proof } = buildQledgerFraudProof(env, ledger, acc, entries);
          const fraud = checkQledgerFraud(env, batch, proof);
          log({ event: 'batch', index: batch.batchIndex, status: batch.status, stateRoot: batch.stateRoot,
            withdrawalsRoot: batch.withdrawalsRoot, range: [batch.inboxStart, batch.inboxEnd], fraud,
            proofSha256: sha(proof) });
          if (fraud && batch.status === 'submitted') {
            let res;
            try {
              res = await broadcast(w, [challengeBatchMsg({
                challenger: w.cosmos, rollupId, batchIndex: batch.batchIndex, proof,
              })], { record: challenged ? undefined : 'challenge' });
            } catch (err) {
              // A lost race is a result, not an error: record the included tx and its code.
              const message = String(err?.message ?? err);
              res = { hash: message.match(/\(tx ([0-9A-F]{64})\)/)?.[1], code: Number(message.match(/code (\d+)/)?.[1]), message };
            }
            log({ event: 'challenge', index: batch.batchIndex, ...res, proofHex: hex(proof) });
            challenged = challenged || res.code === 0;
          } else if (!fraud && batch.status === 'finalized') {
            executeQledger(env, ledger, entries);
            assert.equal(hex(ledger.root()), batch.stateRoot);
            acc = hex(accTo);
            log({ event: 'advance', parentBatch: batch.batchIndex, parentRoot: batch.stateRoot });
            nextIndex += 1;
          } else if (!fraud && challenged) {
            log({ event: 'replacement-verified', index: batch.batchIndex, stateRoot: batch.stateRoot });
            if (!flag('--keep-running')) process.exit(0);
          }
        } else {
          log({ event: 'batch', index: batch.batchIndex, status: batch.status, stateRoot: batch.stateRoot });
        }
      }
    } catch (err) {
      log({ event: 'error', message: String(err?.message ?? err) });
    }
    await sleep(2000);
  }
} else if (step === 'challenge') {
  const w = await accountFrom(WATCHER);
  assert.notEqual(w.cosmos, roll.creator, 'challenge from a separate account');
  const forgery = load('forgery');
  const batch = await client.rest.getBatch(rollupId, 2);
  assert.equal(batch.status, 'submitted');
  assert.equal(batch.stateRoot, forgery.forged.stateRoot);
  await broadcast(w, [challengeBatchMsg({
    challenger: w.cosmos, rollupId, batchIndex: 2, proof: Buffer.from(forgery.proofHex, 'hex'),
  })], { record: 'challenge-fallback' });
} else if (step === 'rebond') {
  const op = await accountFrom(keyFile);
  assert.equal(roll.creator, op.cosmos, 'operator mnemonic required');
  const bond = await client.rest.getSubmitterBond(rollupId, op.cosmos);
  const missing = BOND - BigInt(bond.amount);
  assert.ok(missing > 0n, 'bond is already ' + bond.amount);
  await broadcast(op, [bondRollupSubmitterMsg({ submitter: op.cosmos, rollupId, amount: missing })], { record: 'rebond' });
} else if (step === 'replace') {
  const op = await accountFrom(keyFile);
  assert.equal(roll.creator, op.cosmos, 'operator mnemonic required');
  const { ledger } = transcriptParent();
  const latest = await client.rest.getLatestBatch(rollupId);
  assert.deepEqual([latest.batchIndex, latest.status, latest.stateRoot], [1, 'finalized', hex(ledger.root())]);
  const plan = await planQledgerBatch(client.rest, { ...env, submitter: op.cosmos, ledger });
  assert.equal(plan.input.batchIndex, 2n);
  assert.equal(plan.input.inboxEnd, 5n);
  assert.equal(hex(plan.input.stateRoot), latest.stateRoot);
  assert.equal(hex(plan.input.withdrawalsRoot), '');
  const anchor = anchorSignBytesForBatch({ chainId, layerId: roll.layerId, ...plan.input });
  await broadcast(op, [submitBatchMsg({
    ...plan.input, sequencer: op.cosmos, anchorSignature: pqcSign(op.pqc.secretKey, anchor),
  })], { record: 'replace' });
} else if (step === 'status') {
  const inbox = await client.rest.getInbox(rollupId);
  const bond = await client.rest.getSubmitterBond(rollupId, roll.creator);
  const out = {
    inbox: { head: inbox.headSequence, consumed: inbox.consumedSequence },
    operator: { address: roll.creator, bondUqor: String(bond.amount), pending: String(bond.pending), balanceUqor: String(await balance(roll.creator)) },
    batch1: await batchOrNull(1),
    batch2: await batchOrNull(2),
  };
  if (existsSync(WATCHER)) {
    const w = await accountFrom(WATCHER);
    out.watcher = { address: w.cosmos, balanceUqor: String(await balance(w.cosmos)) };
  }
  console.log(json(out));
}
