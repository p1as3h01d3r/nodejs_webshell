'use strict';

const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const http = require('node:http');
const path = require('node:path');
const { createInterface } = require('node:readline');
const { test } = require('node:test');

for (const signal of ['SIGTERM', 'SIGINT']) {
  test(`drains an active request on ${signal}`, { timeout: 5000 }, async (t) => {
    const child = spawn(process.execPath, [path.join(__dirname, '../server.js')], {
      env: { ...process.env, HOST: '127.0.0.1', PORT: '0' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const exited = once(child, 'exit');
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    t.after(async () => {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      await exited;
    });

    const lines = createInterface({ input: child.stdout });
    t.after(() => lines.close());
    const [line] = await once(lines, 'line', { signal: AbortSignal.timeout(2000) });
    const match = /^Webshell lab listening on (http:\/\/127\.0\.0\.1:\d+)$/.exec(line);
    assert.ok(match, `Unexpected startup output: ${line}; ${stderr}`);

    const body = JSON.stringify({ command: "printf 'drained'" });
    const request = http.request(`${match[1]}/shell`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        Connection: 'close',
        Expect: '100-continue',
      },
      signal: AbortSignal.timeout(3000),
    });
    t.after(() => request.destroy());
    const continued = once(request, 'continue');
    const responded = once(request, 'response');
    request.flushHeaders();

    // The server has accepted the request, but is still waiting for its body.
    await continued;
    child.kill(signal);
    request.end(body);

    const [response] = await responded;
    let result = '';
    for await (const chunk of response) result += chunk;
    const output = JSON.parse(result);
    assert.equal(response.statusCode, 200);
    assert.equal(output.stdout, 'drained');
    assert.equal(output.exitCode, 0);

    const [exitCode, exitSignal] = await exited;
    assert.equal(exitCode, 0, stderr);
    assert.equal(exitSignal, null);
  });
}
