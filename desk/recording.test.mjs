import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { Readable } from 'node:stream';
import test from 'node:test';

let instance = 0;
async function desk(t, failAt) {
  const lines = [];
  let payments = 0;
  let handler, tick;
  const originalCwd = process.cwd();
  const originalArgv = process.argv;
  const originalInterval = globalThis.setInterval;
  const originalMnemonic = process.env.VEIL_OPERATOR_MNEMONIC;
  t.after(() => {
    process.chdir(originalCwd);
    process.argv = originalArgv;
    globalThis.setInterval = originalInterval;
    if (originalMnemonic === undefined) delete process.env.VEIL_OPERATOR_MNEMONIC;
    else process.env.VEIL_OPERATOR_MNEMONIC = originalMnemonic;
    delete globalThis.recordingTest;
  });

  const hash = 'A'.repeat(64);
  globalThis.recordingTest = {
    createServer: fn => { handler = fn; return { listen() {} }; },
    appendFileSync: (_, line) => {
      const event = JSON.parse(line);
      if (event.type === failAt) throw Object.assign(new Error('disk full'), { code: 'ENOSPC' });
      lines.push(event);
    },
    client: { rest: { getRollup: async () => ({}) } },
    pay: async () => { payments++; return { hash, code: 0, height: 42 }; },
  };
  const modules = {
    'node:http': 'export const { createServer } = globalThis.recordingTest;',
    'node:fs': `export const { appendFileSync } = globalThis.recordingTest;
      export const mkdirSync = () => {}, writeFileSync = () => {}, readFileSync = () => Buffer.from('Desk');`,
    './chain.mjs': `export const { client, pay } = globalThis.recordingTest;
      export const operator = async () => ({}), broadcast = pay, submitBatch = pay;`,
    './state.mjs': `export const auditorAddress = '', watching = false,
      snapshot = async () => ({ watch: { checkedAt: 0 } }),
      beginPayment = () => () => {}, measuredPay = (_, send) => send(),
      measuring = () => false, settling = () => false, finalityReport = () => ({});`,
  };
  process.argv = ['node', 'desk/server.mjs', '--record', 'test'];
  process.env.VEIL_OPERATOR_MNEMONIC = 'test-path';
  globalThis.setInterval = fn => { tick = fn; return { unref() {} }; };
  const hooks = registerHooks({
    resolve(specifier, context, nextResolve) {
      if (context.parentURL?.includes('/desk/server.mjs?recording-test=') && Object.hasOwn(modules, specifier)) {
        return { url: 'data:text/javascript,' + encodeURIComponent(modules[specifier]) + '#' + instance, shortCircuit: true };
      }
      return nextResolve(specifier, context);
    },
  });
  try {
    await import('./server.mjs?recording-test=' + ++instance);
  } finally {
    hooks.deregister();
    globalThis.setInterval = originalInterval;
  }
  async function request(url, body) {
    const req = Object.assign(Readable.from(body ? [Buffer.from(JSON.stringify(body))] : []), {
      url, method: body ? 'POST' : 'GET',
      headers: { host: '127.0.0.1:8788', 'x-veil': '1', 'content-type': 'application/json' },
    });
    const reply = {};
    await handler(req, {
      setHeader() {},
      writeHead(status) { reply.status = status; },
      end(text) { reply.body = JSON.parse(text); },
    });
    return reply;
  }
  return {
    lines, tick, hash, payments: () => payments,
    pay: () => request('/api/action', { action: 'pay', amount: '1', payee: 'b'.repeat(64), description: 'Test' }),
    mark: () => request('/api/action', { action: 'mark', label: 'Scene' }),
    state: () => request('/api/state'),
  };
}

test('a healthy recording logs actions, ticks and scene marks', async t => {
  const app = await desk(t);
  app.tick();
  assert.equal((await app.pay()).status, 200);
  assert.equal((await app.mark()).status, 200);
  assert.equal((await app.state()).body.recording, true);
  assert.deepEqual(app.lines.map(event => event.type), ['meta', 'tick', 'action-start', 'action-end', 'action-start', 'mark', 'action-end', 'state']);
});

for (const event of ['action-start', 'action-end']) {
  test('a recording failure at ' + event + ' preserves the payment result', async t => {
    const app = await desk(t, event);
    assert.deepEqual(await app.pay(), { status: 200, body: { hash: app.hash, code: 0, height: 42 } });
    assert.equal(app.payments(), 1);
    const { body } = await app.state();
    assert.equal(body.recording, false);
    assert.match(body.recordingError, /recording stopped/i);
    assert.equal(body.busy, null);
    assert.equal((await app.pay()).status, 200);
    assert.equal(app.payments(), 2);
  });
}

test('a failed tick does not escape and later requests still work', async t => {
  const app = await desk(t, 'tick');
  assert.doesNotThrow(app.tick);
  const response = await app.state();
  assert.equal(response.status, 200);
  assert.equal(response.body.recording, false);
  assert.equal((await app.pay()).status, 200);
});

test('a failed mark reports that the scene was not saved', async t => {
  const app = await desk(t, 'mark');
  const response = await app.mark();
  assert.equal(response.status, 503);
  assert.match(response.body.error, /scene was not saved/i);
  assert.equal((await app.state()).body.recording, false);
});

test('a failed state write is reflected in that same response', async t => {
  const app = await desk(t, 'state');
  const response = await app.state();
  assert.equal(response.status, 200);
  assert.equal(response.body.recording, false);
  assert.match(response.body.recordingError, /recording stopped/i);
});

test('a failed recording header leaves Desk available without recording', async t => {
  const app = await desk(t, 'meta');
  assert.equal(app.tick, undefined);
  assert.equal((await app.state()).body.recording, false);
  assert.equal((await app.pay()).status, 200);
});
