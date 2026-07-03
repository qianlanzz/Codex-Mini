#!/usr/bin/env node
'use strict';

const assert = require('assert');
const http = require('http');
const { createHub } = require('../relay-hub');
const { createAgent } = require('../relay-agent');

function listen(server, host = '127.0.0.1') {
  return new Promise(resolve => server.listen(0, host, () => resolve(server.address().port)));
}

function close(server) {
  return new Promise(resolve => server.close(() => resolve()));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function request(port, options = {}) {
  const body = options.body === undefined ? undefined : Buffer.from(options.body);
  const headers = {
    host: options.host || 'codex.test',
    ...(options.headers || {}),
  };
  if (body) headers['content-length'] = body.length;

  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1',
      port,
      method: options.method || 'GET',
      path: options.path || '/',
      headers,
    }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve({
        status: res.statusCode,
        headers: res.headers,
        body: Buffer.concat(chunks),
      }));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

async function waitFor(fn, timeoutMs = 6000) {
  const started = Date.now();
  let lastError = null;
  while (Date.now() - started < timeoutMs) {
    try {
      const value = await fn();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await new Promise(resolve => setTimeout(resolve, 120));
  }
  throw lastError || new Error('Timed out waiting for condition');
}

function json(res, status, data) {
  const body = Buffer.from(JSON.stringify(data));
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': body.length,
  });
  res.end(body);
}

async function main() {
  const localToken = 'local-test-token';
  const adminToken = 'admin-test-token';
  const agentSecret = 'agent-test-secret';
  const deviceHost = 'mac.codex.test';

  const localServer = http.createServer(async (req, res) => {
    const authorized = req.headers['x-mobile-typer-token'] === localToken;
    if (req.url.startsWith('/codex/health')) {
      return json(res, authorized ? 200 : 401, authorized ? { ok: true, service: 'fake-codex' } : { ok: false });
    }
    if (req.url === '/' && req.method === 'GET') {
      const body = Buffer.from('<!doctype html><title>Fake Codex Mini</title><h1>Fake Codex Mini</h1>');
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'content-length': body.length });
      return res.end(body);
    }
    if (req.url.startsWith('/send') && req.method === 'POST') {
      const body = await readBody(req);
      return json(res, authorized ? 200 : 401, {
        ok: authorized,
        received: JSON.parse(body.toString('utf8')),
      });
    }
    res.writeHead(404);
    res.end('not found');
  });

  const localPort = await listen(localServer);
  const hub = createHub({
    host: '127.0.0.1',
    port: 0,
    agentSecret,
    adminToken,
    baseDomain: 'codex.test',
    cookieDomain: '',
    pollTimeoutMs: 1000,
    requestTimeoutMs: 5000,
    offlineAfterMs: 5000,
  });
  await new Promise(resolve => hub.listen(resolve));
  const hubPort = hub.server.address().port;

  const agent = createAgent({
    hubUrl: `http://127.0.0.1:${hubPort}`,
    agentSecret,
    id: 'macbook',
    name: 'MacBook Test',
    slug: 'mac',
    os: 'macos',
    publicHost: deviceHost,
    localBase: `http://127.0.0.1:${localPort}`,
    localToken,
    pollConcurrency: 2,
    retryMs: 100,
    registerIntervalMs: 1000,
    log: { log() {}, warn() {}, error() {} },
  });
  await agent.start();

  try {
    await waitFor(async () => {
      const res = await request(hubPort, {
        path: '/hub/devices',
        headers: { 'x-codex-relay-admin': adminToken },
      });
      assert.strictEqual(res.status, 200);
      const data = JSON.parse(res.body.toString('utf8'));
      return data.devices.find(item => item.id === 'macbook' && item.online);
    });

    const dashboard = await request(hubPort, {
      path: '/',
      headers: { 'x-codex-relay-admin': adminToken },
    });
    assert.strictEqual(dashboard.status, 200);
    assert.match(dashboard.body.toString('utf8'), /MacBook Test/);

    const health = await request(hubPort, {
      host: deviceHost,
      path: '/codex/health',
      headers: { 'x-codex-relay-admin': adminToken },
    });
    assert.strictEqual(health.status, 200);
    assert.deepStrictEqual(JSON.parse(health.body.toString('utf8')).ok, true);

    const page = await request(hubPort, {
      host: deviceHost,
      path: '/',
      headers: { 'x-codex-relay-admin': adminToken },
    });
    assert.strictEqual(page.status, 200);
    assert.match(page.body.toString('utf8'), /Fake Codex Mini/);

    const pathPage = await request(hubPort, {
      host: 'codex.test',
      path: '/device/macbook/',
      headers: { 'x-codex-relay-admin': adminToken },
    });
    assert.strictEqual(pathPage.status, 200);
    assert.match(pathPage.body.toString('utf8'), /Fake Codex Mini/);

    const send = await request(hubPort, {
      host: deviceHost,
      method: 'POST',
      path: '/send',
      headers: {
        'content-type': 'application/json',
        'x-codex-relay-admin': adminToken,
      },
      body: JSON.stringify({ text: 'hello from relay' }),
    });
    assert.strictEqual(send.status, 200);
    const sendData = JSON.parse(send.body.toString('utf8'));
    assert.strictEqual(sendData.ok, true);
    assert.strictEqual(sendData.received.text, 'hello from relay');

    const pathSend = await request(hubPort, {
      host: 'codex.test',
      method: 'POST',
      path: '/device/macbook/send',
      headers: {
        'content-type': 'application/json',
        'x-codex-relay-admin': adminToken,
      },
      body: JSON.stringify({ text: 'hello from path relay' }),
    });
    assert.strictEqual(pathSend.status, 200);
    const pathSendData = JSON.parse(pathSend.body.toString('utf8'));
    assert.strictEqual(pathSendData.ok, true);
    assert.strictEqual(pathSendData.received.text, 'hello from path relay');

    console.log('relay integration test passed');
  } finally {
    agent.stop();
    await new Promise(resolve => hub.close(resolve));
    await close(localServer);
  }
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
