#!/usr/bin/env node
'use strict';

const http = require('http');
const crypto = require('crypto');
const { URLSearchParams } = require('url');

const DEFAULT_PORT = 3000;
const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_MAX_BODY_BYTES = 48 * 1024 * 1024;
const DEFAULT_POLL_TIMEOUT_MS = 25_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 75_000;
const DEFAULT_OFFLINE_AFTER_MS = 45_000;

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

function numberEnv(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function normalizeHost(value = '') {
  return String(value || '').trim().toLowerCase().replace(/:\d+$/, '');
}

function normalizeSlug(value = '') {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48) || 'device';
}

function normalizeId(value = '') {
  return String(value || '')
    .trim()
    .replace(/[^a-zA-Z0-9._:-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 96);
}

function htmlEscape(value = '') {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function parseCookies(header = '') {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const index = part.indexOf('=');
    if (index < 0) continue;
    const key = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    if (!key) continue;
    try {
      out[key] = decodeURIComponent(value);
    } catch {
      out[key] = value;
    }
  }
  return out;
}

function readBody(req, maxBytes = DEFAULT_MAX_BODY_BYTES) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', chunk => {
      size += chunk.length;
      if (size > maxBytes) {
        reject(Object.assign(new Error('Request body too large'), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function readJson(req, maxBytes) {
  const body = await readBody(req, maxBytes);
  if (!body.length) return {};
  return JSON.parse(body.toString('utf8'));
}

function writeJson(res, status, data, extraHeaders = {}) {
  const body = Buffer.from(JSON.stringify(data));
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': body.length,
    ...extraHeaders,
  });
  res.end(body);
}

function writeHtml(res, status, body, extraHeaders = {}) {
  const buffer = Buffer.from(body);
  res.writeHead(status, {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': buffer.length,
    ...extraHeaders,
  });
  res.end(buffer);
}

function sanitizeForwardRequestHeaders(headers = {}) {
  const out = {};
  for (const [rawKey, rawValue] of Object.entries(headers)) {
    const key = rawKey.toLowerCase();
    if (HOP_BY_HOP_HEADERS.has(key)) continue;
    if (key === 'host' || key === 'content-length') continue;
    if (key === 'cookie') continue;
    if (key === 'authorization') continue;
    if (key === 'x-codex-relay-admin') continue;
    if (rawValue === undefined) continue;
    out[key] = Array.isArray(rawValue) ? rawValue.join(', ') : String(rawValue);
  }
  return out;
}

function sanitizeForwardResponseHeaders(headers = {}) {
  const out = {};
  for (const [rawKey, rawValue] of Object.entries(headers)) {
    const key = rawKey.toLowerCase();
    if (HOP_BY_HOP_HEADERS.has(key)) continue;
    if (key === 'content-length') continue;
    if (key === 'set-cookie') continue;
    if (rawValue === undefined) continue;
    out[key] = Array.isArray(rawValue) ? rawValue.join(', ') : String(rawValue);
  }
  return out;
}

function createAdminCookie(value, domain = '') {
  const parts = [
    `codexRelayAdmin=${encodeURIComponent(value)}`,
    'Path=/',
    'Max-Age=2592000',
    'HttpOnly',
    'SameSite=Lax',
  ];
  if (domain) parts.push(`Domain=${domain}`);
  return parts.join('; ');
}

function shouldDefaultCookieDomain(baseDomain = '') {
  const host = normalizeHost(baseDomain);
  return host && host.includes('.') && host !== 'localhost' && !/^\d+\.\d+\.\d+\.\d+$/.test(host);
}

function createHub(options = {}) {
  const optionValue = (key, envName, fallback) => (
    Object.prototype.hasOwnProperty.call(options, key) ? options[key] : process.env[envName] || fallback
  );
  const config = {
    host: options.host || process.env.HUB_HOST || DEFAULT_HOST,
    port: Number(optionValue('port', 'HUB_PORT', DEFAULT_PORT)),
    agentSecret: options.agentSecret ?? process.env.HUB_AGENT_SECRET ?? '',
    adminToken: options.adminToken ?? process.env.HUB_ADMIN_TOKEN ?? '',
    baseDomain: normalizeHost(options.baseDomain ?? process.env.HUB_BASE_DOMAIN ?? ''),
    dashboardTitle: options.dashboardTitle || process.env.HUB_TITLE || 'Codex Relay',
    maxBodyBytes: Number(optionValue('maxBodyBytes', 'HUB_MAX_BODY_BYTES', DEFAULT_MAX_BODY_BYTES)),
    pollTimeoutMs: Number(optionValue('pollTimeoutMs', 'HUB_AGENT_POLL_TIMEOUT_MS', DEFAULT_POLL_TIMEOUT_MS)),
    requestTimeoutMs: Number(optionValue('requestTimeoutMs', 'HUB_REQUEST_TIMEOUT_MS', DEFAULT_REQUEST_TIMEOUT_MS)),
    offlineAfterMs: Number(optionValue('offlineAfterMs', 'HUB_OFFLINE_AFTER_MS', DEFAULT_OFFLINE_AFTER_MS)),
  };
  config.cookieDomain = options.cookieDomain ?? process.env.HUB_COOKIE_DOMAIN ?? (
    shouldDefaultCookieDomain(config.baseDomain) ? `.${config.baseDomain}` : ''
  );

  const devices = new Map();
  const waitingResponses = new Map();

  function nowIso() {
    return new Date().toISOString();
  }

  function getDevicePublicHost(device) {
    if (device.publicHost) return normalizeHost(device.publicHost);
    return config.baseDomain ? `${device.slug}.${config.baseDomain}` : '';
  }

  function getDevicePublicUrl(device, req) {
    const publicHost = getDevicePublicHost(device);
    if (!publicHost) return `/hub/open/${encodeURIComponent(device.id)}`;
    const proto = String(req.headers['x-forwarded-proto'] || '').split(',')[0] || 'https';
    return `${proto}://${publicHost}/`;
  }

  function isOnline(device) {
    return Boolean(device && Date.now() - device.lastSeenAt <= config.offlineAfterMs);
  }

  function serializeDevice(device, req = null) {
    const online = isOnline(device);
    return {
      id: device.id,
      name: device.name,
      slug: device.slug,
      os: device.os,
      publicHost: getDevicePublicHost(device),
      publicUrl: req ? getDevicePublicUrl(device, req) : '',
      online,
      connectedAt: device.connectedAt,
      lastSeenAt: device.lastSeen,
      pendingRequests: device.pendingRequests.length,
      activeRequests: [...waitingResponses.values()].filter(item => item.deviceId === device.id).length,
      handledRequests: device.handledRequests,
      failedRequests: device.failedRequests,
    };
  }

  function upsertDevice(meta = {}) {
    const id = normalizeId(meta.id);
    if (!id) throw Object.assign(new Error('Missing device id'), { status: 400 });
    const previous = devices.get(id);
    const slug = normalizeSlug(meta.slug || previous?.slug || id);
    const device = previous || {
      id,
      connectedAt: nowIso(),
      pollWaiters: [],
      pendingRequests: [],
      handledRequests: 0,
      failedRequests: 0,
    };
    device.name = String(meta.name || previous?.name || id).trim().slice(0, 120);
    device.slug = slug;
    device.os = String(meta.os || previous?.os || '').trim().slice(0, 80);
    device.publicHost = normalizeHost(meta.publicHost || previous?.publicHost || '');
    device.agentVersion = String(meta.agentVersion || previous?.agentVersion || '').trim().slice(0, 40);
    device.lastSeen = nowIso();
    device.lastSeenAt = Date.now();
    devices.set(id, device);
    return device;
  }

  function removePollWaiter(device, waiter) {
    const index = device.pollWaiters.indexOf(waiter);
    if (index >= 0) device.pollWaiters.splice(index, 1);
  }

  function deliverRequest(device, task) {
    const waiter = device.pollWaiters.shift();
    if (waiter) {
      clearTimeout(waiter.timer);
      waiter.closed = true;
      return writeJson(waiter.res, 200, { ok: true, request: task });
    }
    device.pendingRequests.push(task);
  }

  function removePendingRequest(device, requestId) {
    device.pendingRequests = device.pendingRequests.filter(item => item.id !== requestId);
  }

  function agentAuthorized(req) {
    if (!config.agentSecret) return true;
    const expected = `Bearer ${config.agentSecret}`;
    return req.headers.authorization === expected || req.headers['x-codex-relay-secret'] === config.agentSecret;
  }

  function adminAuthorized(req) {
    if (!config.adminToken) return true;
    const parsed = new URLSearchParams(String(req.url || '').split('?')[1] || '');
    const queryToken = parsed.get('admin') || parsed.get('token') || '';
    const cookies = parseCookies(req.headers.cookie || '');
    return queryToken === config.adminToken ||
      cookies.codexRelayAdmin === config.adminToken ||
      req.headers['x-codex-relay-admin'] === config.adminToken;
  }

  function adminCookieForRequest(req) {
    if (!config.adminToken) return '';
    const parsed = new URLSearchParams(String(req.url || '').split('?')[1] || '');
    const queryToken = parsed.get('admin') || parsed.get('token') || '';
    if (queryToken !== config.adminToken) return '';
    return createAdminCookie(config.adminToken, config.cookieDomain);
  }

  function authHeadersForRequest(req) {
    const cookie = adminCookieForRequest(req);
    return cookie ? { 'set-cookie': cookie } : {};
  }

  function renderLogin(req, res) {
    const parsed = new URLSearchParams(String(req.url || '').split('?')[1] || '');
    const next = parsed.get('next') || req.url || '/';
    const body = `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${htmlEscape(config.dashboardTitle)} 登录</title>
  <style>
    body { margin: 0; min-height: 100vh; display: grid; place-items: center; color: #111827; background: radial-gradient(circle at top left, #dbeafe, transparent 34rem), linear-gradient(135deg, #f8fafc, #eef2ff); font-family: ui-rounded, "SF Pro Rounded", "PingFang SC", sans-serif; }
    form { width: min(360px, calc(100vw - 36px)); padding: 28px; border: 1px solid rgba(15,23,42,.08); border-radius: 28px; background: rgba(255,255,255,.78); box-shadow: 0 24px 80px rgba(15,23,42,.14); backdrop-filter: blur(18px); }
    h1 { margin: 0 0 8px; font-size: 28px; letter-spacing: -.04em; }
    p { margin: 0 0 22px; color: #64748b; font-size: 14px; }
    input, button { width: 100%; height: 46px; border-radius: 999px; font: inherit; box-sizing: border-box; }
    input { border: 1px solid #cbd5e1; padding: 0 16px; background: white; outline: none; }
    button { margin-top: 12px; border: 0; color: white; background: #0f172a; font-weight: 800; cursor: pointer; }
  </style>
</head>
<body>
  <form method="post" action="/hub/login">
    <h1>${htmlEscape(config.dashboardTitle)}</h1>
    <p>输入 Hub 管理口令后继续访问设备。</p>
    <input type="hidden" name="next" value="${htmlEscape(next)}" />
    <input name="token" type="password" autocomplete="current-password" autofocus placeholder="HUB_ADMIN_TOKEN" />
    <button type="submit">进入</button>
  </form>
</body>
</html>`;
    writeHtml(res, 401, body);
  }

  async function handleLogin(req, res) {
    if (req.method !== 'POST') return renderLogin(req, res);
    const body = await readBody(req, 16 * 1024);
    const form = new URLSearchParams(body.toString('utf8'));
    const token = form.get('token') || '';
    const next = form.get('next') || '/';
    if (!config.adminToken || token === config.adminToken) {
      res.writeHead(302, {
        location: next.startsWith('/') ? next : '/',
        'set-cookie': createAdminCookie(token, config.cookieDomain),
      });
      return res.end();
    }
    return renderLogin(req, res);
  }

  function resolveDeviceByHost(hostHeader = '') {
    const host = normalizeHost(hostHeader);
    if (!host) return null;
    for (const device of devices.values()) {
      const publicHost = getDevicePublicHost(device);
      if (publicHost && host === publicHost) return device;
    }
    return null;
  }

  function renderDashboard(req, res) {
    const rows = [...devices.values()]
      .sort((a, b) => Number(isOnline(b)) - Number(isOnline(a)) || String(a.name).localeCompare(String(b.name)))
      .map(device => {
        const data = serializeDevice(device, req);
        const statusClass = data.online ? 'online' : 'offline';
        const statusText = data.online ? '在线' : '离线';
        const openHref = `/hub/open/${encodeURIComponent(device.id)}`;
        return `<article class="device ${statusClass}">
  <div>
    <span class="pill">${statusText}</span>
    <h2>${htmlEscape(data.name)}</h2>
    <p>${htmlEscape(data.publicHost || '未配置公网 Host')}</p>
  </div>
  <dl>
    <dt>系统</dt><dd>${htmlEscape(data.os || 'unknown')}</dd>
    <dt>最后心跳</dt><dd>${htmlEscape(data.lastSeenAt || '-')}</dd>
    <dt>处理中</dt><dd>${data.activeRequests}</dd>
  </dl>
  ${data.online && data.publicHost ? `<a class="open" href="${htmlEscape(openHref)}">接管 Codex</a>` : '<button class="open" disabled>不可用</button>'}
</article>`;
      }).join('\n') || '<section class="empty">还没有设备连接。先在 Mac / Windows 上启动 <code>relay-agent.js</code>。</section>';

    const body = `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${htmlEscape(config.dashboardTitle)}</title>
  <style>
    :root { color-scheme: light; --ink: #111827; --muted: #667085; --line: rgba(17,24,39,.10); --card: rgba(255,255,255,.76); --green: #059669; --red: #e11d48; }
    * { box-sizing: border-box; }
    body { margin: 0; min-height: 100vh; color: var(--ink); background: radial-gradient(circle at 12% 0%, #bbf7d0 0, transparent 28rem), radial-gradient(circle at 94% 10%, #bae6fd 0, transparent 30rem), linear-gradient(135deg, #f8fafc, #eef2f7 58%, #fff7ed); font-family: ui-rounded, "SF Pro Rounded", "PingFang SC", "Microsoft YaHei", sans-serif; }
    main { width: min(980px, calc(100vw - 32px)); margin: 0 auto; padding: 42px 0 80px; }
    header { display: flex; align-items: flex-end; justify-content: space-between; gap: 18px; margin-bottom: 24px; }
    h1 { margin: 0; font-size: clamp(34px, 7vw, 74px); line-height: .9; letter-spacing: -.07em; }
    .sub { margin: 12px 0 0; color: var(--muted); max-width: 560px; }
    .hint { padding: 10px 14px; border: 1px solid var(--line); border-radius: 999px; background: rgba(255,255,255,.62); color: var(--muted); font-size: 13px; white-space: nowrap; }
    .grid { display: grid; gap: 14px; }
    .device, .empty { display: grid; grid-template-columns: minmax(0, 1fr) auto auto; gap: 18px; align-items: center; padding: 18px; border: 1px solid var(--line); border-radius: 28px; background: var(--card); box-shadow: 0 18px 60px rgba(15,23,42,.10); backdrop-filter: blur(18px); }
    .device h2 { margin: 8px 0 4px; font-size: 24px; letter-spacing: -.04em; }
    .device p { margin: 0; color: var(--muted); font-size: 13px; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
    .pill { display: inline-flex; align-items: center; gap: 7px; padding: 5px 10px; border-radius: 999px; font-size: 12px; font-weight: 800; }
    .pill::before { content: ""; width: 7px; height: 7px; border-radius: 999px; background: currentColor; }
    .online .pill { color: var(--green); background: rgba(5,150,105,.10); }
    .offline .pill { color: var(--red); background: rgba(225,29,72,.10); }
    dl { display: grid; grid-template-columns: auto auto; gap: 4px 10px; margin: 0; color: var(--muted); font-size: 12px; }
    dt { text-align: right; opacity: .7; }
    dd { margin: 0; color: var(--ink); font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
    .open { appearance: none; border: 0; display: inline-grid; place-items: center; min-width: 112px; height: 44px; border-radius: 999px; text-decoration: none; color: white; background: #0f172a; font-weight: 850; cursor: pointer; }
    .open:disabled { color: #94a3b8; background: #e2e8f0; cursor: not-allowed; }
    .empty { display: block; color: var(--muted); }
    code { color: #0f172a; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
    @media (max-width: 720px) {
      header, .device { display: block; }
      .hint { display: inline-block; margin-top: 16px; white-space: normal; }
      dl { margin-top: 16px; }
      .open { margin-top: 16px; width: 100%; }
    }
  </style>
</head>
<body>
  <main>
    <header>
      <div>
        <h1>${htmlEscape(config.dashboardTitle)}</h1>
        <p class="sub">在线设备会显示在这里。点击设备后，请求会经由 Hub 转发到对应电脑上的 Codex Mini。</p>
      </div>
      <div class="hint">每 5 秒自动刷新</div>
    </header>
    <section class="grid">${rows}</section>
  </main>
  <script>setTimeout(() => location.reload(), 5000);</script>
</body>
</html>`;
    writeHtml(res, 200, body, authHeadersForRequest(req));
  }

  function handleOpenDevice(req, res, deviceId) {
    const device = devices.get(deviceId);
    if (!device) return writeHtml(res, 404, 'Device not found');
    if (!isOnline(device)) return writeHtml(res, 503, 'Device is offline');
    const publicUrl = getDevicePublicUrl(device, req);
    const needsQueryToken = Boolean(config.adminToken && !config.cookieDomain);
    const location = needsQueryToken ? `${publicUrl}?admin=${encodeURIComponent(config.adminToken)}` : publicUrl;
    res.writeHead(302, { location, ...authHeadersForRequest(req) });
    res.end();
  }

  async function proxyToDevice(req, res, device) {
    if (!isOnline(device)) {
      return writeJson(res, 503, { ok: false, code: 'DEVICE_OFFLINE', message: '设备离线或 Agent 心跳超时。' });
    }

    const body = await readBody(req, config.maxBodyBytes);
    const requestId = crypto.randomUUID();
    let settled = false;

    const task = {
      id: requestId,
      method: req.method,
      path: req.url || '/',
      headers: sanitizeForwardRequestHeaders(req.headers),
      bodyBase64: body.length ? body.toString('base64') : '',
      timeoutMs: config.requestTimeoutMs,
      createdAt: nowIso(),
    };

    const responsePromise = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        waitingResponses.delete(requestId);
        removePendingRequest(device, requestId);
        reject(Object.assign(new Error('Device request timed out'), { status: 504 }));
      }, config.requestTimeoutMs);
      waitingResponses.set(requestId, {
        deviceId: device.id,
        resolve,
        reject,
        timer,
      });
    });

    res.on('close', () => {
      if (settled) return;
      const waiting = waitingResponses.get(requestId);
      if (waiting) {
        clearTimeout(waiting.timer);
        waitingResponses.delete(requestId);
      }
      removePendingRequest(device, requestId);
    });

    deliverRequest(device, task);

    try {
      const agentResponse = await responsePromise;
      settled = true;
      const status = Math.max(100, Math.min(599, Number(agentResponse.status) || 502));
      const headers = sanitizeForwardResponseHeaders(agentResponse.headers || {});
      const cookie = adminCookieForRequest(req);
      if (cookie) headers['set-cookie'] = cookie;
      const responseBody = Buffer.from(agentResponse.bodyBase64 || '', 'base64');
      headers['content-length'] = responseBody.length;
      res.writeHead(status, headers);
      res.end(req.method === 'HEAD' ? undefined : responseBody);
      device.handledRequests += 1;
    } catch (error) {
      settled = true;
      device.failedRequests += 1;
      writeJson(res, error.status || 502, {
        ok: false,
        code: error.status === 504 ? 'DEVICE_TIMEOUT' : 'DEVICE_PROXY_FAILED',
        message: error.message || '设备请求失败。',
      });
    }
  }

  async function handleAgentRegister(req, res) {
    if (!agentAuthorized(req)) return writeJson(res, 401, { ok: false, code: 'UNAUTHORIZED' });
    const payload = await readJson(req, 256 * 1024);
    const device = upsertDevice(payload);
    return writeJson(res, 200, { ok: true, device: serializeDevice(device, req) });
  }

  async function handleAgentPoll(req, res) {
    if (!agentAuthorized(req)) return writeJson(res, 401, { ok: false, code: 'UNAUTHORIZED' });
    const payload = await readJson(req, 256 * 1024);
    const device = upsertDevice(payload);
    const next = device.pendingRequests.shift();
    if (next) return writeJson(res, 200, { ok: true, request: next });

    const waiter = { res, closed: false, timer: null };
    waiter.timer = setTimeout(() => {
      if (waiter.closed) return;
      waiter.closed = true;
      removePollWaiter(device, waiter);
      writeJson(res, 200, { ok: true, request: null });
    }, config.pollTimeoutMs);
    device.pollWaiters.push(waiter);
    req.on('close', () => {
      if (waiter.closed) return;
      waiter.closed = true;
      clearTimeout(waiter.timer);
      removePollWaiter(device, waiter);
    });
  }

  async function handleAgentRespond(req, res) {
    if (!agentAuthorized(req)) return writeJson(res, 401, { ok: false, code: 'UNAUTHORIZED' });
    const payload = await readJson(req, config.maxBodyBytes + 8 * 1024 * 1024);
    const device = upsertDevice(payload);
    const requestId = String(payload.requestId || '');
    const waiting = waitingResponses.get(requestId);
    if (!waiting) return writeJson(res, 404, { ok: false, code: 'REQUEST_NOT_FOUND' });
    if (waiting.deviceId !== device.id) return writeJson(res, 409, { ok: false, code: 'DEVICE_MISMATCH' });
    clearTimeout(waiting.timer);
    waitingResponses.delete(requestId);
    waiting.resolve(payload.response || {});
    return writeJson(res, 200, { ok: true });
  }

  async function handleHubRoute(req, res) {
    if (req.url.startsWith('/hub/login')) return handleLogin(req, res);
    if (!adminAuthorized(req)) return renderLogin(req, res);

    if (req.url.startsWith('/hub/devices')) {
      return writeJson(res, 200, {
        ok: true,
        devices: [...devices.values()].map(device => serializeDevice(device, req)),
      }, authHeadersForRequest(req));
    }
    const openMatch = req.url.match(/^\/hub\/open\/([^/?#]+)/);
    if (openMatch) return handleOpenDevice(req, res, decodeURIComponent(openMatch[1]));
    if (req.url.startsWith('/hub/logout')) {
      res.writeHead(302, {
        location: '/',
        'set-cookie': 'codexRelayAdmin=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax',
      });
      return res.end();
    }
    return renderDashboard(req, res);
  }

  const server = http.createServer(async (req, res) => {
    try {
      if (req.url.startsWith('/agent/register')) return await handleAgentRegister(req, res);
      if (req.url.startsWith('/agent/poll')) return await handleAgentPoll(req, res);
      if (req.url.startsWith('/agent/respond')) return await handleAgentRespond(req, res);
      if (req.url.startsWith('/hub/')) return await handleHubRoute(req, res);

      const device = resolveDeviceByHost(req.headers.host || '');
      if (device) {
        if (!adminAuthorized(req)) return renderLogin(req, res);
        return await proxyToDevice(req, res, device);
      }

      if (!adminAuthorized(req)) return renderLogin(req, res);
      return renderDashboard(req, res);
    } catch (error) {
      const status = error.status || 500;
      return writeJson(res, status, {
        ok: false,
        code: status === 413 ? 'REQUEST_TOO_LARGE' : 'HUB_ERROR',
        message: error.message || 'Hub request failed',
      });
    }
  });

  return {
    server,
    config,
    devices,
    listen(callback) {
      return server.listen(config.port, config.host, callback);
    },
    close(callback) {
      for (const waiting of waitingResponses.values()) clearTimeout(waiting.timer);
      waitingResponses.clear();
      for (const device of devices.values()) {
        for (const waiter of device.pollWaiters) {
          clearTimeout(waiter.timer);
          if (!waiter.closed) {
            waiter.closed = true;
            try { writeJson(waiter.res, 503, { ok: false, code: 'HUB_CLOSING' }); } catch {}
          }
        }
      }
      return server.close(callback);
    },
  };
}

if (require.main === module) {
  const hub = createHub({
    host: process.env.HUB_HOST || DEFAULT_HOST,
    port: numberEnv('HUB_PORT', DEFAULT_PORT),
    maxBodyBytes: numberEnv('HUB_MAX_BODY_BYTES', DEFAULT_MAX_BODY_BYTES),
    pollTimeoutMs: numberEnv('HUB_AGENT_POLL_TIMEOUT_MS', DEFAULT_POLL_TIMEOUT_MS),
    requestTimeoutMs: numberEnv('HUB_REQUEST_TIMEOUT_MS', DEFAULT_REQUEST_TIMEOUT_MS),
    offlineAfterMs: numberEnv('HUB_OFFLINE_AFTER_MS', DEFAULT_OFFLINE_AFTER_MS),
  });

  if (!hub.config.agentSecret) {
    console.warn('Warning: HUB_AGENT_SECRET is empty. Set it before exposing this Hub.');
  }
  if (!hub.config.adminToken) {
    console.warn('Warning: HUB_ADMIN_TOKEN is empty. Dashboard and devices are not password protected.');
  }

  hub.listen(() => {
    console.log(`Codex Relay Hub listening on http://${hub.config.host}:${hub.config.port}`);
    if (hub.config.baseDomain) console.log(`Base domain: ${hub.config.baseDomain}`);
  });
}

module.exports = { createHub };
