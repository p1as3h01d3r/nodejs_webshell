'use strict';

const http = require('node:http');
const { spawn } = require('node:child_process');

const MAX_BODY_BYTES = 16 * 1024;

function sendJson(response, status, body, headers = {}) {
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    ...headers,
  });
  response.end(JSON.stringify(body));
}

function readJson(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;

    request.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject({ status: 413, message: 'Request body exceeds 16 KiB' });
        return;
      }
      chunks.push(chunk);
    });

    request.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject({ status: 400, message: 'Invalid JSON' });
      }
    });
    request.on('error', reject);
  });
}

function executeCommand(command, { timeoutMs, maxOutputBytes }) {
  return new Promise((resolve) => {
    const child = spawn('/bin/sh', ['-c', command], {
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const stdout = [];
    const stderr = [];
    let outputBytes = 0;
    let error = null;

    function stop(reason) {
      if (error) return;
      error = reason;
      if (!child.pid) return;

      try {
        // Stop the shell and its process group, not just the parent shell.
        process.kill(-child.pid, 'SIGKILL');
      } catch (killError) {
        if (killError.code !== 'ESRCH') child.kill('SIGKILL');
      }
    }

    function collect(target, chunk) {
      const remaining = Math.max(0, maxOutputBytes - outputBytes);
      target.push(chunk.subarray(0, remaining));
      outputBytes += chunk.length;
      if (outputBytes > maxOutputBytes) stop('OUTPUT_LIMIT');
    }

    const timer = setTimeout(() => stop('TIMEOUT'), timeoutMs);
    timer.unref();
    child.stdout.on('data', (chunk) => collect(stdout, chunk));
    child.stderr.on('data', (chunk) => collect(stderr, chunk));
    child.once('error', () => {
      error = 'SPAWN_ERROR';
    });
    child.once('close', (exitCode, signal) => {
      clearTimeout(timer);
      resolve({
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
        exitCode,
        signal,
        error,
      });
    });
  });
}

function createShellServer({ timeoutMs = 5000, maxOutputBytes = 1024 * 1024 } = {}) {
  const server = http.createServer(async (request, response) => {
    try {
      const pathname = new URL(request.url, 'http://localhost').pathname;

      if (pathname === '/health' && request.method === 'GET') {
        sendJson(response, 200, { status: 'ok' });
        return;
      }
      if (pathname !== '/shell') {
        sendJson(response, 404, { error: 'Not found' });
        return;
      }
      if (request.method !== 'POST') {
        sendJson(response, 405, { error: 'Use POST /shell' }, { Allow: 'POST' });
        return;
      }
      const contentType = request.headers['content-type']?.split(';')[0].trim().toLowerCase();
      if (contentType !== 'application/json') {
        sendJson(response, 415, { error: 'Content-Type must be application/json' });
        return;
      }

      const body = await readJson(request);
      if (
        !body ||
        Array.isArray(body) ||
        typeof body.command !== 'string' ||
        !body.command.trim() ||
        body.command.includes('\0')
      ) {
        sendJson(response, 400, { error: 'command must be a non-empty string without NUL bytes' });
        return;
      }

      const result = await executeCommand(body.command, { timeoutMs, maxOutputBytes });
      sendJson(response, 200, result);
    } catch (error) {
      sendJson(response, error.status || 500, {
        error: error.status ? error.message : 'Internal server error',
      });
    }
  });

  server.requestTimeout = 10_000;
  server.headersTimeout = 5000;
  return server;
}

if (require.main === module) {
  const host = process.env.HOST || '0.0.0.0';
  const port = Number(process.env.PORT || 3000);
  const server = createShellServer();
  let shuttingDown = false;

  function shutdown() {
    if (shuttingDown) return;
    shuttingDown = true;

    const deadline = setTimeout(() => process.exit(1), 10_000);
    deadline.unref();
    server.close(() => {
      clearTimeout(deadline);
      process.exit(0);
    });
  }

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
  server.listen(port, host, () => {
    console.log(`Webshell lab listening on http://${host}:${server.address().port}`);
  });
}

module.exports = { createShellServer };
