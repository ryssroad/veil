import { createServer } from 'node:http';
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { depositToRollupMsg } from '@qorechain/rdk';
import { rollupId, chainId } from '../veil.mjs';
import { client, operator, broadcast, pay, submitBatch } from './chain.mjs';
import { auditorAddress, snapshot } from './state.mjs';
import { invoicesCsv, parseQor } from './model.mjs';

process.chdir(fileURLToPath(new URL('../', import.meta.url)));
const address = '127.0.0.1:8788';
const origin = 'http://' + address;
const page = readFileSync(new URL('./index.html', import.meta.url));
const args = process.argv.slice(2);
if (args.length && !(args.length === 2 && args[0] === '--record' && /^[\w-]{1,60}$/.test(args[1]))) {
  throw new Error('Usage: node desk/server.mjs [--record name]');
}
const started = new Date().toISOString();
const session = args.length && 'video/sessions/' + started.replace(/[:.]/g, '-') + '-' + args[1] + '.jsonl';
const encode = v => JSON.stringify(v, (_, x) => typeof x === 'bigint' ? String(x) : x);
function record(kind, data = {}) {
  if (session) appendFileSync(session, encode({ t: Date.now(), type: kind, kind, ...data }) + '\n');
}
if (session) {
  mkdirSync('video/sessions', { recursive: true, mode: 0o700 });
  writeFileSync(session, '', { flag: 'wx', mode: 0o600 });
  record('meta', { page: 'desk', started, name: args[1], chainId, rollupId });
  setInterval(() => record('tick', { now: Math.floor(Date.now() / 1000) }), 1000).unref();
}
let busy = null, loading, lastRecord, cached, lastRead = 0;
async function state() {
  if (!cached || Date.now() - lastRead > 2400) {
    loading ??= snapshot().then(s => { cached = s; lastRead = Date.now(); }).finally(() => { loading = undefined; });
    await loading;
  }
  const result = { ...cached, busy, recording: Boolean(session) };
  if (session) {
    const serial = encode(result);
    if (serial !== lastRecord) { record('state', { state: result }); lastRecord = serial; }
  }
  return result;
}
class InputError extends Error {}
async function action(body) {
  if (body.action === 'mark') {
    if (!session || typeof body.label !== 'string' || !body.label.trim() || body.label.length > 100) throw new InputError('Enter a scene label (1–100 characters).');
    record('mark', { label: body.label.trim() });
    return { message: 'Scene marked' };
  }
  if (!['pay', 'top-up', 'batch'].includes(body.action)) throw new InputError('Unknown action.');
  if (!process.env.VEIL_OPERATOR_MNEMONIC) throw new InputError('Set VEIL_OPERATOR_MNEMONIC on the server to enable signing.');
  let amount;
  if (body.action !== 'batch') {
    try { amount = parseQor(body.amount); } catch { throw new InputError('Enter a positive QOR amount with up to six decimals.'); }
  }
  if (body.action === 'pay') {
    if (typeof body.payee !== 'string' || !/^[0-9a-f]{64}$/.test(body.payee)) throw new InputError('Invalid payee account.');
    if (typeof body.description !== 'string' || Buffer.byteLength(body.description) > 128 || /["\\\x00-\x1f\x7f]/u.test(body.description)) {
      throw new InputError('Description must be at most 128 bytes and contain printable text without quotes or backslashes.');
    }
  }
  const roll = await client.rest.getRollup(rollupId);
  const op = await operator(process.env.VEIL_OPERATOR_MNEMONIC, roll);
  let tx;
  if (body.action === 'pay') tx = await pay(op, body.payee, auditorAddress, amount, body.description);
  if (body.action === 'batch') tx = await submitBatch(op, roll);
  if (body.action === 'top-up') {
    const s = await state();
    tx = await broadcast(op, [depositToRollupMsg({ rollupId, depositor: op.cosmos,
      account: Buffer.from(s.payer.account, 'hex'), amount: String(amount) })], 'top-up');
  }
  return { hash: tx.hash, code: tx.code, height: tx.height };
}
async function readBody(req) {
  const chunks = [];
  let bytes = 0;
  for await (const part of req) {
    bytes += part.length;
    if (bytes > 2048) throw new InputError('Action body is too large.');
    chunks.push(part);
  }
  try {
    const body = JSON.parse(Buffer.concat(chunks));
    if (!body || typeof body.action !== 'string') throw new Error();
    return body;
  } catch { throw new InputError('Expected a JSON action.'); }
}
createServer(async (req, res) => {
  const send = (code, value, mime = 'application/json; charset=utf-8') => {
    res.writeHead(code, { 'content-type': mime });
    res.end(mime.startsWith('application/json') ? encode(value) : value);
  };
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'; form-action 'none'; base-uri 'none'");
  if (req.headers.host !== address || (req.headers.origin && req.headers.origin !== origin)) return send(403, { error: 'Local requests only.' });
  try {
    const url = new URL(req.url, origin);
    if (req.method === 'GET' && url.pathname === '/') return send(200, page, 'text/html; charset=utf-8');
    if (req.method === 'GET' && url.pathname === '/api/state') return send(200, await state());
    if (req.method === 'GET' && url.pathname === '/api/invoices.csv') {
      const s = await state();
      res.setHeader('Content-Disposition', 'attachment; filename="veil-invoices.csv"');
      return send(200, invoicesCsv(s.auditor.rows, url.searchParams.get('batch')), 'text/csv; charset=utf-8');
    }
    if (req.method !== 'POST' || url.pathname !== '/api/action') return send(404, { error: 'Unknown route.' });
    if (req.headers['x-veil'] !== '1' || req.headers['content-type']?.split(';')[0] !== 'application/json') return send(403, { error: 'Expected a Desk JSON action.' });
    if (busy) return send(409, { error: 'An action is in progress.' });
    const body = await readBody(req);
    if (busy) return send(409, { error: 'An action is in progress.' });
    if (!['pay', 'top-up', 'batch', 'mark'].includes(body.action)) throw new InputError('Unknown action.');
    busy = body.action;
    record('action-start', { action: busy });
    try {
      const result = await action(body);
      record('action-end', { action: busy, result });
      send(200, result);
    } catch (err) {
      const result = err.tx ? { hash: err.tx.hash, code: err.tx.code, height: err.tx.height, error: 'Transaction rejected.' }
        : { error: err instanceof InputError ? err.message : 'Action failed. Check the operator, payer balance and reader binding before retrying.' };
      record('action-end', { action: busy, result });
      send(err instanceof InputError ? 400 : 502, result);
    } finally { busy = null; lastRead = 0; }
  } catch (err) {
    send(err instanceof InputError ? 400 : 503, { error: err instanceof InputError ? err.message : 'Unable to read Diana or the local reader files. Retry to refresh.' });
  }
}).listen(8788, '127.0.0.1', () => {
  console.log('Veil Desk at ' + origin + (session ? ' · recording ' + session : ''));
  if (session) {
    const poll = () => state().catch(() => {});
    void poll();
    setInterval(poll, 3000).unref();
  }
});
