#!/usr/bin/env node
'use strict';

const os = require('os');

const DEFAULT_LOCAL_CODEX_BASE = 'http://127.0.0.1:8787';
const DEFAULT_POLL_CONCURRENCY = 4;
const DEFAULT_RETRY_MS = 1500;
const DEFAULT_REGISTER_INTERVAL_MS = 30_000;

const HOP_BY_HOP_HEADERS = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function numberEnv(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function normalizeBaseUrl(value = '') {
  return String(value || '').trim().replace(/\/+$/, '');
}

function normalizeSlug(value = '') {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48) || 'device';
}

function defaultDeviceId() {
  return `${os.hostname()}-${os.platform()}`.replace(/[^a-zA-Z0-9._:-]+/g, '-');
}

function sanitizeLocalRequestHeaders(headers = {}) {
  const out = {};
  for (const [rawKey, rawValue] of Object.entries(headers)) {
    const key = rawKey.toLowerCase();
    if (HOP_BY_HOP_HEADERS.has(key)) continue;
    if (key === 'host' || key === 'content-length') continue;
    if (rawValue === undefined) continue;
    out[key] = Array.isArray(rawValue) ? rawValue.join(', ') : String(rawValue);
  }
  return out;
}

function sanitizeResponseHeaders(headers) {
  const out = {};
  headers.forEach((value, key) => {
    const lower = key.toLowerCase();
    if (HOP_BY_HOP_HEADERS.has(lower)) return;
    if (lower === 'content-length') return;
    out[lower] = value;
  });
  return out;
}

function createAgent(options = {}) {
  const config = {
    hubUrl: normalizeBaseUrl(options.hubUrl || process.env.RELAY_HUB_URL || ''),
    agentSecret: options.agentSecret ?? process.env.RELAY_AGENT_SECRET ?? process.env.HUB_AGENT_SECRET ?? '',
    id: options.id || process.env.RELAY_DEVICE_ID || defaultDeviceId(),
    name: options.name || process.env.RELAY_DEVICE_NAME || `${os.hostname()} (${os.platform()})`,
    slug: normalizeSlug(options.slug || process.env.RELAY_DEVICE_SLUG || os.hostname()),
    os: options.os || process.env.RELAY_DEVICE_OS || os.platform(),
    publicHost: options.publicHost || process.env.RELAY_DEVICE_PUBLIC_HOST || '',
    localBase: normalizeBaseUrl(options.localBase || process.env.LOCAL_CODEX_BASE || DEFAULT_LOCAL_CODEX_BASE),
    localToken: options.localToken ?? process.env.LOCAL_CODEX_TOKEN ?? process.env.MOBILE_TYPER_TOKEN ?? '',
    pollConcurrency: Number(options.pollConcurrency || process.env.RELAY_POLL_CONCURRENCY || DEFAULT_POLL_CONCURRENCY),
    retryMs: Number(options.retryMs || process.env.RELAY_RETRY_MS || DEFAULT_RETRY_MS),
    registerIntervalMs: Number(options.registerIntervalMs || process.env.RELAY_REGISTER_INTERVAL_MS || DEFAULT_REGISTER_INTERVAL_MS),
    log: options.log || console,
  };

  if (!config.hubUrl) throw new Error('RELAY_HUB_URL is required');

  let stopped = false;
  let registerTimer = null;

  function meta() {
    return {
      id: config.id,
      name: config.name,
      slug: config.slug,
      os: config.os,
      publicHost: config.publicHost,
      agentVersion: '1',
    };
  }

  async function postJson(path, payload, timeoutMs = 35_000) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(`${config.hubUrl}${path}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: config.agentSecret ? `Bearer ${config.agentSecret}` : '',
        },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || data.ok === false) {
        throw new Error(data.message || data.code || `Hub returned ${response.status}`);
      }
      return data;
    } finally {
      clearTimeout(timer);
    }
  }

  async function register() {
    return postJson('/agent/register', meta(), 15_000);
  }

  async function respond(requestId, response) {
    return postJson('/agent/respond', {
      ...meta(),
      requestId,
      response,
    }, 35_000);
  }

  async function handleRequest(request) {
    const requestId = String(request.id || '');
    if (!requestId) return;

    try {
      const url = new URL(request.path || '/', `${config.localBase}/`);
      const headers = sanitizeLocalRequestHeaders(request.headers || {});
      if (config.localToken) headers['x-mobile-typer-token'] = config.localToken;
      const method = String(request.method || 'GET').toUpperCase();
      const body = request.bodyBase64 ? Buffer.from(request.bodyBase64, 'base64') : undefined;

      const localResponse = await fetch(url, {
        method,
        headers,
        body: method === 'GET' || method === 'HEAD' ? undefined : body,
        redirect: 'manual',
      });
      const responseBuffer = Buffer.from(await localResponse.arrayBuffer());
      await respond(requestId, {
        status: localResponse.status,
        headers: sanitizeResponseHeaders(localResponse.headers),
        bodyBase64: responseBuffer.toString('base64'),
      });
    } catch (error) {
      const text = `Codex relay agent failed: ${error.message || error}`;
      await respond(requestId, {
        status: 502,
        headers: { 'content-type': 'text/plain; charset=utf-8' },
        bodyBase64: Buffer.from(text).toString('base64'),
      }).catch(() => {});
    }
  }

  async function pollLoop(index) {
    while (!stopped) {
      try {
        const data = await postJson('/agent/poll', meta(), 45_000);
        if (data.request) {
          handleRequest(data.request).catch(error => {
            config.log.warn?.(`relay-agent worker ${index} request failed: ${error.message || error}`);
          });
        }
      } catch (error) {
        if (!stopped) {
          config.log.warn?.(`relay-agent worker ${index} poll failed: ${error.message || error}`);
          await delay(config.retryMs);
        }
      }
    }
  }

  async function start() {
    stopped = false;
    await register();
    registerTimer = setInterval(() => {
      register().catch(error => config.log.warn?.(`relay-agent register failed: ${error.message || error}`));
    }, config.registerIntervalMs);
    for (let index = 0; index < Math.max(1, config.pollConcurrency); index += 1) {
      pollLoop(index + 1).catch(error => config.log.error?.(`relay-agent worker crashed: ${error.message || error}`));
    }
    config.log.log?.(`Codex relay agent connected to ${config.hubUrl} as ${config.id}`);
  }

  function stop() {
    stopped = true;
    if (registerTimer) clearInterval(registerTimer);
    registerTimer = null;
  }

  return {
    config,
    start,
    stop,
    register,
  };
}

if (require.main === module) {
  const agent = createAgent({
    pollConcurrency: numberEnv('RELAY_POLL_CONCURRENCY', DEFAULT_POLL_CONCURRENCY),
    retryMs: numberEnv('RELAY_RETRY_MS', DEFAULT_RETRY_MS),
    registerIntervalMs: numberEnv('RELAY_REGISTER_INTERVAL_MS', DEFAULT_REGISTER_INTERVAL_MS),
  });

  if (!agent.config.agentSecret) {
    console.warn('Warning: RELAY_AGENT_SECRET/HUB_AGENT_SECRET is empty. Set it before exposing this Agent.');
  }
  if (!agent.config.localToken) {
    console.warn('Warning: LOCAL_CODEX_TOKEN/MOBILE_TYPER_TOKEN is empty. Local Codex Mini requests may be unauthorized.');
  }

  agent.start().catch(error => {
    console.error(error);
    process.exit(1);
  });

  process.on('SIGINT', () => {
    agent.stop();
    process.exit(130);
  });
  process.on('SIGTERM', () => {
    agent.stop();
    process.exit(143);
  });
}

module.exports = { createAgent };
