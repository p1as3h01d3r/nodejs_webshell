'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { createShellServer } = require('../server');

async function startServer(t, options) {
  const server = createShellServer(options);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const url = `http://127.0.0.1:${server.address().port}`;

  return {
    url,
    post: (body) => fetch(`${url}/shell`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
  };
}

test('returns stdout, stderr and exit code', async (t) => {
  const { post } = await startServer(t);
  const response = await post({ command: "printf 'hello'; printf 'warning' >&2" });

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    stdout: 'hello',
    stderr: 'warning',
    exitCode: 0,
    signal: null,
    error: null,
  });
});

test('supports shell pipelines', async (t) => {
  const { post } = await startServer(t);
  const response = await post({ command: "printf 'one\ntwo\n' | wc -l" });
  const body = await response.json();

  assert.equal(body.stdout.trim(), '2');
  assert.equal(body.exitCode, 0);
});

test('returns nonzero command exit codes without an HTTP error', async (t) => {
  const { post } = await startServer(t);
  const response = await post({ command: "printf 'failed' >&2; exit 7" });
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.exitCode, 7);
  assert.equal(body.stderr, 'failed');
  assert.equal(body.error, null);
});

test('validates the command field', async (t) => {
  const { post } = await startServer(t);

  for (const body of [null, [], {}, { command: 1 }, { command: '  ' }, { command: '\0' }]) {
    const response = await post(body);
    assert.equal(response.status, 400);
    assert.equal(typeof (await response.json()).error, 'string');
  }
});

test('rejects malformed JSON and incorrect content types', async (t) => {
  const { url } = await startServer(t);
  const malformed = await fetch(`${url}/shell`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{',
  });
  const wrongType = await fetch(`${url}/shell`, {
    method: 'POST',
    body: JSON.stringify({ command: 'id' }),
  });

  assert.equal(malformed.status, 400);
  assert.equal(wrongType.status, 415);
});

test('rejects oversized request bodies', async (t) => {
  const { post } = await startServer(t);
  const response = await post({ command: 'x'.repeat(17 * 1024) });

  assert.equal(response.status, 413);
  assert.match((await response.json()).error, /16 KiB/);
});

test('checks health, methods and unknown routes', async (t) => {
  const { url } = await startServer(t);
  const health = await fetch(`${url}/health`);
  const wrongMethod = await fetch(`${url}/shell`);
  const missing = await fetch(`${url}/missing`);

  assert.deepEqual(await health.json(), { status: 'ok' });
  assert.equal(wrongMethod.status, 405);
  assert.equal(wrongMethod.headers.get('allow'), 'POST');
  assert.equal(missing.status, 404);
});

test('kills timed-out commands and their shell subprocesses', { timeout: 3000 }, async (t) => {
  const { post } = await startServer(t, { timeoutMs: 100 });
  const response = await post({ command: "sleep 10; printf 'too late'" });
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.error, 'TIMEOUT');
  assert.equal(body.signal, 'SIGKILL');
  assert.equal(body.exitCode, null);
  assert.equal(body.stdout, '');
});

test('limits combined stdout and stderr', { timeout: 3000 }, async (t) => {
  const { post } = await startServer(t, { maxOutputBytes: 64 });
  const response = await post({ command: "while :; do printf '0123456789'; printf 'error' >&2; done" });
  const body = await response.json();

  assert.equal(body.error, 'OUTPUT_LIMIT');
  assert.equal(body.signal, 'SIGKILL');
  assert.equal(Buffer.byteLength(body.stdout) + Buffer.byteLength(body.stderr), 64);
});
