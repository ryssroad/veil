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
import { qledgerKeypairFromSeed, postRollupDataMsg, registerKemKeyMsg } from '@qorechain/rdk';
import { generateMnemonic, buildRegisterPqcKeyMsg, signProofOfPossession, fetchPqcStatus } from '@qorechain/sdk';
import { chainId, rollupId, hex, sha256, kemFingerprint, encodeReaderStatement, discoverReaderKeys, replayExecutions } from './veil.mjs';
import { client, mnemonicAccount, operator, payeeKeys, broadcast, registryKey, inboxEntries,
  batches, pay, submitBatch, readInvoices, json } from './desk/chain.mjs';

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
const record = (name, v) => writeFileSync(EVIDENCE + name + '.json', json(v));
const now = () => new Date().toISOString();

const rest = client.network.endpoints.rest;
const roll = await client.rest.getRollup(rollupId);

function secretFile(dir, name, make) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = join(dir, name);
  assert.ok(!existsSync(path), path + ' exists, refusing to overwrite');
  writeFileSync(path, make(), { mode: 0o600 });
  chmodSync(path, 0o600);
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
  const op = await operator(opFile, roll);
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
  const op = await operator(opFile, roll);
  const k = payeeKeys(dir);
  const statement = encodeReaderStatement({ keypair: k.l2, kemPublicKey: k.seal.mlkemPublicKey });
  const tx = await broadcast(op, [postRollupDataMsg({ rollupId, poster: op.cosmos, data: statement })], 'post-statement');
  record('statement', { ...tx, payeeAccount: hex(k.l2.accountId), readerKey: kemFingerprint(k.seal.mlkemPublicKey),
    bytes: statement.length, statementHex: hex(statement) });
} else if (step === 'post-negatives') {
  const [opFile, dir] = args;
  const op = await operator(opFile, roll);
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
  const op = await operator(opFile, roll);
  const result = await pay(op, payeeAccount, auditorAddress, BigInt(option('amount', '300000')), option('description', 'Veil v1 live invoice'));
  record('payment', result);
} else if (step === 'batch') {
  const result = await submitBatch(await operator(args[0], roll), roll);
  record('batch-' + result.batchIndex, result);
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
  const { bindings, events } = discoverReaderKeys(entries);
  if (mine) assert.equal(bindings.get(mine)?.fingerprint, kemFingerprint(sealKeys.mlkemPublicKey), 'my statement is not the binding one');
  const { executions } = replayExecutions(entries);
  const { accepted, skipped } = await readInvoices({ dir, mine, sealKeys, auditorKey, entries, all, executions });
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
