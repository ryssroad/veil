// Live Veil v1 run on veil-pay-1 (QoreChain Diana): reader-key discovery (#2)
// and a sealed, auditor-declared invoice payment (#1), read back by two clients
// that share nothing but the chain.
//
//   new-payee        <dir>                         L2 key + reader key, in their own directory
//   new-auditor      <dir>                         qor1 account + reader key, in their own directory
//   fund-auditor     <operator.mnemonic> <dir>     5 QOR for the auditor's fees
//   register-auditor <dir>                         ML-DSA-87 key, then ML-KEM-1024 key in the chain registry
//   post-statement   <operator.mnemonic> <dir>     the payee's signed reader-key statement
//   post-negatives   <operator.mnemonic> <dir>     substituted key, second statement, re-post (one tx)
//   pay              <operator.mnemonic> <payee-account-hex> <auditor-qor1>   transfer + envelope, one tx
//   batch            <operator.mnemonic>           honest batch over all pending entries
//   read             <dir> <payee|auditor> <auditor-qor1>
//   status
//
// Mnemonics and seeds stay in their directories. Evidence goes to evidence/v1/.
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { sealKeysFromSeed } from '@qorechain/qoreseal';
import {
  createRdkClient,
  createRdkRegistry,
  EMPTY_INBOX_ACC,
  fetchQledgerEntries,
  executeQledger,
  QledgerLedger,
  qledgerKeypairFromSeed,
  planQledgerBatch,
  postRollupDataMsg,
  submitBatchMsg,
  anchorSignBytesForBatch,
  registerKemKeyMsg,
  buildSettlementReceipt,
  verifySettlementReceipt,
  isRestNotFound,
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
import {
  env, chainId, rollupId, hex, sha256, kemFingerprint,
  kemKeyFromRegistry, createInvoicePayment, openInvoice, encodeReaderStatement, discoverReaderKeys,
  replayExecutions, coPostedEnvelope, InvoiceImporter,
} from './veil.mjs';

const STEPS = ['new-payee', 'new-auditor', 'fund-auditor', 'register-auditor', 'post-statement',
  'post-negatives', 'pay', 'batch', 'read', 'status'];
const [step, ...args] = process.argv.slice(2);
assert.ok(STEPS.includes(step), 'step: ' + STEPS.join(' | '));
const option = (name, fallback) => {
  const i = process.argv.indexOf('--' + name);
  return i > 0 ? process.argv[i + 1] : fallback;
};

const EVIDENCE = 'evidence/v1/';
mkdirSync(EVIDENCE, { recursive: true });
const json = (v) => JSON.stringify(v, (_, x) => (typeof x === 'bigint' ? String(x) : x), 2) + '\n';
const record = (name, v) => writeFileSync(EVIDENCE + name + '.json', json(v));
const now = () => new Date().toISOString();

const client = createRdkClient({ network: 'testnet' });
const rest = client.network.endpoints.rest;
const roll = await client.rest.getRollup(rollupId);

async function getJson(route) {
  const res = await fetch(rest + route);
  assert.ok(res.ok, route + ' HTTP ' + res.status);
  return res.json();
}
const mnemonicAccount = (file) => {
  assert.ok(file && existsSync(file), 'mnemonic file not found: ' + file);
  return deriveUnifiedAccount(readFileSync(file, 'utf8').trim());
};
async function operator(file) {
  const op = await mnemonicAccount(file);
  assert.equal(op.cosmos, roll.creator, 'operator mnemonic required');
  return op;
}
function secretFile(dir, name, make) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = join(dir, name);
  assert.ok(!existsSync(path), path + ' exists, refusing to overwrite');
  writeFileSync(path, make(), { mode: 0o600 });
  chmodSync(path, 0o600);
}
const payeeKeys = (dir) => ({
  l2: qledgerKeypairFromSeed(readFileSync(join(dir, 'l2.seed'))),
  seal: sealKeysFromSeed(readFileSync(join(dir, 'seal.seed'))),
});

async function broadcast(account, messages, name, { mode = 'hybrid', registry = createRdkRegistry() } = {}) {
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
    assert.equal(tx.code, 0);
    return out;
  } finally {
    transport.disconnect();
  }
}

/** An address's ML-KEM-1024 key from the chain registry, as bytes, or undefined. */
async function registryKey(address) {
  const view = await client.rest.getKemKey(address);
  return view ? { key: kemKeyFromRegistry(view), registeredHeight: view.registeredHeight } : undefined;
}

/** Every inbox entry 1..head, checked against the chain's accumulator, with sequence numbers. */
async function inboxEntries() {
  const inbox = await client.rest.getInbox(rollupId);
  const head = Number(inbox.headSequence);
  const rows = await fetchQledgerEntries(client.rest, { ...env, from: 0, to: head, accFrom: EMPTY_INBOX_ACC });
  assert.equal(rows.length, head);
  return { inbox, entries: rows.map((e, i) => ({ ...e, sequence: i + 1 })) };
}
async function batches() {
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

if (step === 'new-payee') {
  const [dir] = args;
  secretFile(dir, 'l2.seed', () => randomBytes(32));
  secretFile(dir, 'seal.seed', () => randomBytes(32));
  const k = payeeKeys(dir);
  console.log({ payeeAccount: hex(k.l2.accountId), readerKey: kemFingerprint(k.seal.mlkemPublicKey) });
} else if (step === 'new-auditor') {
  const [dir] = args;
  secretFile(dir, 'account.mnemonic', () => generateMnemonic(256) + '\n');
  secretFile(dir, 'seal.seed', () => randomBytes(32));
  const a = await mnemonicAccount(join(dir, 'account.mnemonic'));
  console.log({ auditor: a.cosmos, readerKey: kemFingerprint(sealKeysFromSeed(readFileSync(join(dir, 'seal.seed'))).mlkemPublicKey) });
} else if (step === 'fund-auditor') {
  const [opFile, dir] = args;
  const op = await operator(opFile);
  const a = await mnemonicAccount(join(dir, 'account.mnemonic'));
  record('fund-auditor', await broadcast(op, [{
    typeUrl: '/cosmos.bank.v1beta1.MsgSend',
    value: { fromAddress: op.cosmos, toAddress: a.cosmos, amount: [{ denom: 'uqor', amount: '5000000' }] },
  }], 'fund-auditor'));
} else if (step === 'register-auditor') {
  const [dir] = args;
  const a = await mnemonicAccount(join(dir, 'account.mnemonic'));
  const kem = sealKeysFromSeed(readFileSync(join(dir, 'seal.seed'))).mlkemPublicKey;
  const out = { auditor: a.cosmos, readerKey: kemFingerprint(kem) };
  const pqc = await fetchPqcStatus({ rest, address: a.cosmos });
  if (!pqc.registered) {
    const proofOfPossession = signProofOfPossession({ chainId, account: a.cosmos, keypair: a.pqc });
    out.pqc = await broadcast(a, [buildRegisterPqcKeyMsg(a.cosmos, { pqcKeypair: a.pqc, proofOfPossession })],
      'register-auditor-pqc', { mode: 'classical', registry: null });
  }
  const current = await registryKey(a.cosmos);
  if (current) {
    assert.equal(kemFingerprint(current.key), out.readerKey, 'the registry holds a different key for this auditor');
  } else {
    out.kem = await broadcast(a, [registerKemKeyMsg({ sender: a.cosmos, publicKey: kem })], 'register-auditor-kem');
  }
  const after = await registryKey(a.cosmos);
  assert.ok(after && kemFingerprint(after.key) === out.readerKey);
  out.registeredHeight = after.registeredHeight;
  record('auditor', out);
} else if (step === 'post-statement') {
  const [opFile, dir] = args;
  const op = await operator(opFile);
  const k = payeeKeys(dir);
  const statement = encodeReaderStatement({ keypair: k.l2, kemPublicKey: k.seal.mlkemPublicKey });
  const tx = await broadcast(op, [postRollupDataMsg({ rollupId, poster: op.cosmos, data: statement })], 'post-statement');
  record('statement', { ...tx, payeeAccount: hex(k.l2.accountId), readerKey: kemFingerprint(k.seal.mlkemPublicKey),
    bytes: statement.length, statementHex: hex(statement) });
} else if (step === 'post-negatives') {
  const [opFile, dir] = args;
  const op = await operator(opFile);
  const k = payeeKeys(dir);
  const original = Buffer.from(JSON.parse(readFileSync(EVIDENCE + 'statement.json')).statementHex, 'hex');
  const attacker = qledgerKeypairFromSeed(randomBytes(32));
  const substituted = encodeReaderStatement({ keypair: attacker, account: k.l2.accountId,
    kemPublicKey: sealKeysFromSeed(randomBytes(32)).mlkemPublicKey });
  const second = encodeReaderStatement({ keypair: k.l2, kemPublicKey: sealKeysFromSeed(randomBytes(32)).mlkemPublicKey });
  const posts = [substituted, second, original];
  const tx = await broadcast(op, posts.map((data) => postRollupDataMsg({ rollupId, poster: op.cosmos, data })), 'post-negatives');
  record('negatives', { ...tx, order: ['substituted key claiming the payee account', 'second valid statement by the payee', 're-post of the original'],
    digests: posts.map((p) => hex(sha256(p))) });
} else if (step === 'pay') {
  const [opFile, payeeAccount, auditorAddress] = args;
  const op = await operator(opFile);
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
  const amount = BigInt(option('amount', '300000'));
  assert.ok(state.balance >= amount, `payer holds ${state.balance} uqor`);
  const { transfer, envelope, body } = createInvoicePayment({
    payer, nonce: state.nonce, beneficiary: Buffer.from(payeeAccount, 'hex'), amount,
    beneficiaryKem: payee.kemPublicKey, auditorKem: auditor.key,
    id: randomBytes(16).toString('hex'), description: option('description', 'Veil v1 live invoice'),
  });
  const tx = await broadcast(op, [
    postRollupDataMsg({ rollupId, poster: op.cosmos, data: transfer }),
    postRollupDataMsg({ rollupId, poster: op.cosmos, data: envelope }),
  ], 'pay');
  record('payment', { ...tx, payer: hex(payer.accountId), nonce: state.nonce, payeeAccount, amount,
    payeeBinding: { sequence: payee.sequence, readerKey: payee.fingerprint }, auditor: auditorAddress,
    auditorKey: kemFingerprint(auditor.key), discovery: events,
    transferDigest: hex(sha256(transfer)), envelopeDigest: hex(sha256(envelope)),
    envelopeBytes: envelope.length, bodyBytes: body.length });
} else if (step === 'batch') {
  const [opFile] = args;
  const op = await operator(opFile);
  const { inbox, entries } = await inboxEntries();
  const latest = await client.rest.getLatestBatch(rollupId);
  const ledger = consumedLedger(entries, Number(inbox.consumedSequence), latest);
  const plan = await planQledgerBatch(client.rest, { ...env, submitter: op.cosmos, ledger });
  const anchor = anchorSignBytesForBatch({ chainId, layerId: roll.layerId, ...plan.input });
  const tx = await broadcast(op, [submitBatchMsg({ ...plan.input, sequencer: op.cosmos, anchorSignature: pqcSign(op.pqc.secretKey, anchor) })], 'batch');
  record('batch-' + plan.input.batchIndex, { ...tx, batchIndex: plan.input.batchIndex, range: [inbox.consumedSequence, plan.input.inboxEnd],
    stateRoot: hex(plan.input.stateRoot), withdrawalsRoot: hex(plan.input.withdrawalsRoot) });
} else if (step === 'read') {
  const [dir, role, auditorAddress] = args;
  assert.ok(['payee', 'auditor'].includes(role));
  const sealKeys = sealKeysFromSeed(readFileSync(join(dir, 'seal.seed')));
  const mine = role === 'payee' ? hex(payeeKeys(dir).l2.accountId) : undefined;
  const auditor = await registryKey(auditorAddress);
  assert.ok(auditor, 'auditor has no key in the chain registry');
  const auditorKey = kemFingerprint(auditor.key);
  if (role === 'auditor') assert.equal(auditorKey, kemFingerprint(sealKeys.mlkemPublicKey), 'this directory is not the registered auditor');
  const { entries } = await inboxEntries();
  const all = await batches();
  const batchOf = (seq) => all.find((b) => b.inboxStart < seq && seq <= b.inboxEnd);
  const { bindings, events } = discoverReaderKeys(entries);
  if (mine) assert.equal(bindings.get(mine)?.fingerprint, kemFingerprint(sealKeys.mlkemPublicKey), 'my statement is not the binding one');
  const { executions } = replayExecutions(entries);
  const storePath = join(dir, 'imports.json');
  const importer = new InvoiceImporter(existsSync(storePath) ? JSON.parse(readFileSync(storePath)) : undefined);
  const accepted = [];
  const skipped = [];
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
    if (why) {
      skipped.push({ sequence: x.sequence, invoiceId: opened.invoice.id, reason: why });
      continue;
    }
    const receipt = await buildSettlementReceipt(client, rollupId, batch.batchIndex);
    const verified = await verifySettlementReceipt(receipt, { client });
    if (!verified.valid) {
      skipped.push({ sequence: x.sequence, invoiceId: opened.invoice.id, reason: 'receipt: ' + verified.reason });
      continue;
    }
    const imported = importer.import({ ...opened, nonce: x.nonce });
    accepted.push({ sequence: x.sequence, envelopeSequence: envelopeEntry.sequence, batch: batch.batchIndex,
      receiptChecks: verified.checks, import: imported.result, ...opened });
  }
  writeFileSync(storePath, json(importer.state), { mode: 0o600 });
  const report = { role, at: now(), auditor: auditorAddress, auditorKey, readerKeyEvents: events, accepted, skipped };
  record('read-' + role, report);
  console.log(json({ role, accepted: accepted.map((a) => ({ sequence: a.sequence, batch: a.batch, import: a.import, invoice: a.invoice })), skipped }));
} else if (step === 'status') {
  const { inbox, entries } = await inboxEntries();
  const { events } = discoverReaderKeys(entries);
  const bond = await client.rest.getSubmitterBond(rollupId, roll.creator);
  console.log(json({
    inbox: { head: inbox.headSequence, consumed: inbox.consumedSequence },
    bond: { amount: bond.amount, pending: bond.pending },
    batches: (await batches()).map((b) => ({ index: b.batchIndex, status: b.status, range: [b.inboxStart, b.inboxEnd], stateRoot: b.stateRoot })),
    readerKeyEvents: events,
  }));
}
