'use strict';

/*
 * DSH Web auth gateway.
 *
 * External chain:  <your-domain> (TLS, OpenResty) -> <LAN-IP>:3080
 *                  -> netsh portproxy -> 127.0.0.1:3099 (this process)
 *                  -> HTTP Basic auth -> 127.0.0.1:3081 (DSH web, reserve)
 *
 * DSH itself requires a launch-token/signed-cookie pair.  The launch token is
 * only printed once at startup, so this gateway mints a DSH session cookie from
 * the durable browser-session secret in %USERPROFILE%\.dsh\.credentials.yaml.
 * The DSH listener always sees Host 127.0.0.1:3081 and its own signed cookie;
 * the browser only ever talks to this gateway.
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const HOME = process.env.USERPROFILE || process.env.HOME;
const DSH_HOME = process.env.DSH_HOME || path.join(HOME, '.dsh');
const LOG_FILE = path.join(DSH_HOME, 'web-auth-proxy.log');
const SECRET_FILE = path.join(DSH_HOME, 'web-auth-proxy.secret');
const CREDENTIALS_FILE = path.join(DSH_HOME, '.credentials.yaml');

const LISTEN = { host: '127.0.0.1', port: 3099 };
const UPSTREAM = { host: '127.0.0.1', port: 3081, authority: '127.0.0.1:3081' };

const AUTH_FILE = path.join(DSH_HOME, 'web-auth-proxy.auth.json');

/*
 * Safe fallback used only when web-auth-proxy.auth.json is absent: admin /
 * change-me.  The installer and set-password.ps1 write the real credentials
 * into that JSON file, which never belongs in Git.
 */
const DEFAULT_AUTH = {
  user: 'admin',
  salt: Buffer.from('7dEauU2a8qBrx-OzX_eLzQ', 'base64url'),
  hash: Buffer.from('K6GSKT8m99ZE8XEeAWJ3daWFF6CeCNX3mvDVyac9hcA', 'base64url'),
  scrypt: { N: 16384, r: 8, p: 1 },
};

let authCache = { value: DEFAULT_AUTH, mtime: -1, checkedAt: 0 };

function parseAuth(value) {
  if (!value || typeof value !== 'object') throw new Error('auth record must be an object');
  const user = typeof value.user === 'string' ? value.user.trim() : '';
  if (!user) throw new Error('auth.user is empty');
  const salt = Buffer.from(String(value.salt || ''), 'base64url');
  const hash = Buffer.from(String(value.hash || ''), 'base64url');
  if (salt.length < 8 || hash.length < 16) throw new Error('auth salt/hash is invalid');
  const scrypt = value.scrypt || {};
  return {
    user,
    salt,
    hash,
    scrypt: {
      N: Number(scrypt.N) || 16384,
      r: Number(scrypt.r) || 8,
      p: Number(scrypt.p) || 1,
    },
  };
}

function auth() {
  const now = Date.now();
  if (now - authCache.checkedAt < 5000) return authCache.value;
  authCache.checkedAt = now;
  let stat;
  try {
    stat = fs.statSync(AUTH_FILE);
  } catch {
    authCache.value = DEFAULT_AUTH;
    authCache.mtime = -1;
    return authCache.value;
  }
  if (stat.mtimeMs === authCache.mtime) return authCache.value;
  try {
    const parsed = parseAuth(JSON.parse(fs.readFileSync(AUTH_FILE, 'utf8')));
    authCache = { value: parsed, mtime: stat.mtimeMs, checkedAt: now };
    verifiedBasicCache.clear();
    log(`auth loaded from ${AUTH_FILE} (user ${parsed.user})`);
    return parsed;
  } catch (error) {
    log(`auth file ignored: ${error.message}`);
    authCache = { value: DEFAULT_AUTH, mtime: stat.mtimeMs, checkedAt: now };
    return authCache.value;
  }
}

const GATE_COOKIE = 'dsh-gate';
const GATE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const DSH_COOKIE_TTL_MS = 24 * 60 * 60 * 1000;

function log(message) {
  const line = `${new Date().toISOString()} ${message}\n`;
  try {
    if (fs.existsSync(LOG_FILE) && fs.statSync(LOG_FILE).size > 5 * 1024 * 1024) {
      fs.renameSync(LOG_FILE, LOG_FILE + '.1');
    }
    fs.appendFileSync(LOG_FILE, line);
  } catch {
    /* logging must never break the proxy */
  }
  if (process.env.DSH_GATE_LOG_STDOUT === '1') process.stdout.write(line);
}

/* ------------------------------------------------------------------ */
/* Gateway session cookie (protects the external Basic-auth exchange)  */
/* ------------------------------------------------------------------ */

let gateSecret;
try {
  gateSecret = fs.readFileSync(SECRET_FILE);
  if (gateSecret.length < 16) throw new Error('too short');
} catch {
  gateSecret = crypto.randomBytes(32);
  try {
    fs.writeFileSync(SECRET_FILE, gateSecret, { mode: 0o600 });
  } catch {
    /* keep the in-memory secret even if the file cannot be written */
  }
}

function b64url(buf) {
  return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function gateToken(username) {
  const exp = Date.now() + GATE_TTL_MS;
  const body = `${username}|${exp}`;
  const sig = crypto.createHmac('sha256', gateSecret).update(body).digest();
  return `v1.${exp}.${b64url(sig)}`;
}

function verifyGateToken(token) {
  const parts = String(token || '').split('.');
  if (parts.length !== 3 || parts[0] !== 'v1') return false;
  const exp = Number(parts[1]);
  if (!Number.isSafeInteger(exp) || exp <= Date.now()) return false;
  const expected = crypto.createHmac('sha256', gateSecret).update(`${auth().user}|${exp}`).digest();
  let actual;
  try {
    actual = Buffer.from(parts[2].replace(/-/g, '+').replace(/_/g, '/'), 'base64');
  } catch {
    return false;
  }
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

function readCookies(header) {
  const out = {};
  if (!header) return out;
  for (const segment of String(header).split(';')) {
    const at = segment.indexOf('=');
    if (at < 0) continue;
    out[segment.slice(0, at).trim()] = segment.slice(at + 1).trim();
  }
  return out;
}

function safeEqualText(a, b) {
  const ab = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
}

const verifiedBasicCache = new Map(); // authorization header -> expiry

function verifyBasic(header) {
  const match = /^Basic\s+([A-Za-z0-9+/=_-]+)$/i.exec(String(header || '').trim());
  if (!match) return false;
  const cached = verifiedBasicCache.get(header);
  if (cached && cached > Date.now()) return true;
  let decoded;
  try {
    decoded = Buffer.from(match[1], 'base64').toString('utf8');
  } catch {
    return false;
  }
  const at = decoded.indexOf(':');
  if (at < 0) return false;
  const user = decoded.slice(0, at);
  const password = decoded.slice(at + 1);
  const cfg = auth();
  if (!safeEqualText(user, cfg.user)) return false;
  let derived;
  try {
    derived = crypto.scryptSync(password, cfg.salt, cfg.hash.length, cfg.scrypt);
  } catch {
    return false;
  }
  if (!crypto.timingSafeEqual(derived, cfg.hash)) return false;
  if (verifiedBasicCache.size > 32) verifiedBasicCache.clear();
  verifiedBasicCache.set(header, Date.now() + 5 * 60 * 1000);
  return true;
}

function isAuthenticated(req) {
  const cookies = readCookies(req.headers.cookie);
  if (cookies[GATE_COOKIE] && verifyGateToken(cookies[GATE_COOKIE])) return true;
  return verifyBasic(req.headers.authorization);
}
function gateCookieHeader(req) {
  const proto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim();
  const secure = proto === 'https';
  return `${GATE_COOKIE}=${gateToken(auth().user)}; Path=/; Max-Age=${Math.floor(GATE_TTL_MS / 1000)}; HttpOnly; SameSite=Lax${secure ? '; Secure' : ''}`;
}

function unauthorized(req, res) {
  const proto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim();
  const headers = {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
  };
  if (req.headers.authorization === undefined) {
    headers['WWW-Authenticate'] = 'Basic realm="DeepSeek Harness", charset="UTF-8"';
  } else {
    headers['WWW-Authenticate'] = 'Basic realm="DeepSeek Harness", charset="UTF-8"';
  }
  if (req.method !== 'HEAD') {
    headers['Set-Cookie'] = `${GATE_COOKIE}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax`;
  }
  res.writeHead(401, headers);
  if (req.method === 'HEAD') return res.end();
  res.end(`<!doctype html><html lang="ru"><head><meta charset="utf-8"><title>Требуется вход</title>
<style>body{font-family:Segoe UI,Arial,sans-serif;background:#151517;color:#e8e8ea;display:flex;min-height:100vh;align-items:center;justify-content:center;margin:0}
.box{max-width:460px;padding:28px 32px;background:#1e1e21;border:1px solid #333;border-radius:12px}
h1{font-size:20px;margin:0 0 10px}p{color:#a9a9b3;line-height:1.5;margin:0}</style></head>
<body><div class="box"><h1>Требуется авторизация</h1>
<p>Для доступа к DeepSeek Harness введите логин и пароль.</p></div></body></html>`);
}

/* ------------------------------------------------------------------ */
/* DSH signed cookie (minted from the durable browser-session secret)  */
/* ------------------------------------------------------------------ */

let dshSecretCache = { mtime: -1, secret: null };
let dshCookieCache = { value: null, issuedAt: 0 };

function loadDshSecret() {
  let stat;
  try {
    stat = fs.statSync(CREDENTIALS_FILE);
  } catch (error) {
    throw new Error(`cannot read ${CREDENTIALS_FILE}: ${error.message}`);
  }
  if (dshSecretCache.secret && dshSecretCache.mtime === stat.mtimeMs) return dshSecretCache.secret;
  const text = fs.readFileSync(CREDENTIALS_FILE, 'utf8');
  const block = /client-connection\/browser-session:[\s\S]*?secret:\s*([A-Za-z0-9_-]+)/.exec(text);
  if (!block) throw new Error('browser-session secret not found in credentials');
  const secret = Buffer.from(block[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64');
  if (secret.length !== 32) throw new Error('browser-session secret has an unexpected size');
  dshSecretCache = { mtime: stat.mtimeMs, secret };
  return secret;
}

function dshCookie() {
  const now = Date.now();
  if (dshCookieCache.value && now - dshCookieCache.issuedAt < 10 * 60 * 1000) return dshCookieCache.value;
  const secret = loadDshSecret();
  const issuedAt = now - 60 * 1000;
  const expiresAt = now + DSH_COOKIE_TTL_MS;
  const payload = { version: 1, authority: UPSTREAM.authority, issuedAt, expiresAt };
  const body = b64url(JSON.stringify(payload));
  const sig = crypto.createHmac('sha256', secret).update(body).digest();
  const name = 'dsh-auth-' + b64url(crypto.createHash('sha256').update(UPSTREAM.authority).digest());
  const value = `${name}=v1.${body}.${b64url(sig)}`;
  dshCookieCache = { value, issuedAt: now };
  return value;
}

/* ------------------------------------------------------------------ */
/* HTTP proxy                                                          */
/* ------------------------------------------------------------------ */

const HOP_BY_HOP = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'proxy-connection', 'te', 'trailer', 'transfer-encoding', 'upgrade',
]);

function externalOrigin(req) {
  const proto = String(req.headers['x-forwarded-proto'] || 'http').split(',')[0].trim() || 'http';
  const host = String(req.headers['x-forwarded-host'] || req.headers.host || '').split(',')[0].trim();
  return host ? `${proto}://${host}` : '';
}

function rewriteLocation(location, req) {
  if (typeof location !== 'string' || location === '') return location;
  const upstreamOrigins = [
    `http://${UPSTREAM.authority}`,
    `https://${UPSTREAM.authority}`,
    'http://127.0.0.1:3081',
    'https://127.0.0.1:3081',
  ];
  for (const origin of upstreamOrigins) {
    if (location === origin || location.startsWith(origin + '/') || location.startsWith(origin + '?')) {
      const rest = location.slice(origin.length) || '/';
      return rest.startsWith('/') ? rest : '/' + rest;
    }
  }
  return location;
}

function upstreamHeaders(req) {
  const headers = {};
  for (const [name, value] of Object.entries(req.headers)) {
    const lower = name.toLowerCase();
    if (lower === 'host' || lower === 'cookie' || lower === 'authorization' || lower === 'origin' || lower === 'referer') continue;
    if (HOP_BY_HOP.has(lower)) continue;
    if (lower.startsWith('sec-websocket-')) continue;
    headers[lower] = value;
  }
  headers.host = UPSTREAM.authority;
  headers.cookie = dshCookie();
  if (req.headers.origin !== undefined) headers.origin = 'http://' + UPSTREAM.authority;
  if (req.headers.referer !== undefined) headers.referer = 'http://' + UPSTREAM.authority + '/';
  headers['x-forwarded-host'] = String(req.headers['x-forwarded-host'] || req.headers.host || '');
  headers['x-forwarded-proto'] = String(req.headers['x-forwarded-proto'] || 'http').split(',')[0].trim();
  headers['x-forwarded-for'] = String(req.socket.remoteAddress || '');
  return headers;
}

function proxyRequest(req, res, retried = false) {
  let options;
  try {
    options = {
      host: UPSTREAM.host,
      port: UPSTREAM.port,
      method: req.method,
      path: req.url,
      headers: upstreamHeaders(req),
      agent: false,
    };
  } catch (error) {
    log(`upstream setup failed: ${error.message}`);
    return fail(res, 502, 'Не удалось подключиться к DSH.');
  }

  const upstream = http.request(options, (upstreamRes) => {
    if (upstreamRes.statusCode === 401 && !retried) {
      dshCookieCache = { value: null, issuedAt: 0 };
      dshSecretCache = { mtime: -1, secret: null };
      upstreamRes.resume();
      log('upstream returned 401; refreshing DSH cookie and retrying once');
      return proxyRequest(req, res, true);
    }
    const headers = {};
    for (const [name, value] of Object.entries(upstreamRes.headers)) {
      const lower = name.toLowerCase();
      if (lower === 'set-cookie' || lower === 'connection' || lower === 'keep-alive' || lower === 'transfer-encoding') continue;
      headers[name] = value;
    }
    if (headers.location !== undefined) headers.location = rewriteLocation(headers.location, req);
    res.writeHead(upstreamRes.statusCode || 502, headers);
    upstreamRes.pipe(res);
  });

  upstream.on('error', (error) => {
    log(`upstream error: ${error.code || ''} ${error.message}`);
    if (!res.headersSent) fail(res, 502, 'DSH временно недоступен. Попробуйте обновить страницу.');
    else res.destroy();
  });

  req.on('aborted', () => upstream.destroy());
  req.pipe(upstream);
}

function fail(res, status, message) {
  if (res.headersSent) {
    res.destroy();
    return;
  }
  res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(`<!doctype html><html lang="ru"><head><meta charset="utf-8"><title>Ошибка</title>
<style>body{font-family:Segoe UI,Arial,sans-serif;background:#151517;color:#e8e8ea;display:flex;min-height:100vh;align-items:center;justify-content:center;margin:0}
.box{max-width:460px;padding:28px 32px;background:#1e1e21;border:1px solid #333;border-radius:12px}h1{font-size:20px;margin:0 0 10px}p{color:#a9a9b3}</style></head>
<body><div class="box"><h1>DSH недоступен</h1><p>${message}</p></div></body></html>`);
}

/* ------------------------------------------------------------------ */
/* WebSocket proxy                                                     */
/* ------------------------------------------------------------------ */

function rejectUpgrade(socket, status, message) {
  const body = Buffer.from(message, 'utf8');
  socket.write(
    `HTTP/1.1 ${status} ${status === 401 ? 'Unauthorized' : 'Bad Gateway'}\r\n` +
    'Content-Type: text/plain; charset=utf-8\r\n' +
    `Content-Length: ${body.length}\r\n` +
    'Connection: close\r\n' +
    (status === 401 ? 'WWW-Authenticate: Basic realm="DeepSeek Harness", charset="UTF-8"\r\n' : '') +
    '\r\n'
  );
  socket.end(body);
}

function proxyUpgrade(req, socket, head, setCookie) {
  const headers = upstreamHeaders(req);
  headers.connection = 'Upgrade';
  headers.upgrade = 'websocket';
  for (const [name, value] of Object.entries(req.headers)) {
    if (name.toLowerCase().startsWith('sec-websocket-')) headers[name.toLowerCase()] = value;
  }
  headers.origin = 'http://' + UPSTREAM.authority;

  const upstream = http.request({
    host: UPSTREAM.host,
    port: UPSTREAM.port,
    method: 'GET',
    path: req.url,
    headers,
    agent: false,
  });

  const timer = setTimeout(() => {
    upstream.destroy();
    try { socket.destroy(); } catch {}
  }, 15000);

  upstream.on('upgrade', (upstreamRes, upstreamSocket, upstreamHead) => {
    clearTimeout(timer);
    const lines = [`HTTP/1.1 101 Switching Protocols`];
    for (let i = 0; i < upstreamRes.rawHeaders.length; i += 2) {
      lines.push(`${upstreamRes.rawHeaders[i]}: ${upstreamRes.rawHeaders[i + 1]}`);
    }
    if (setCookie) lines.push(`Set-Cookie: ${setCookie}`);
    socket.write(lines.join('\r\n') + '\r\n\r\n');
    if (upstreamHead && upstreamHead.length) socket.write(upstreamHead);
    if (head && head.length) upstreamSocket.write(head);
    upstreamSocket.pipe(socket);
    socket.pipe(upstreamSocket);
    const close = () => { try { upstreamSocket.destroy(); } catch {} try { socket.destroy(); } catch {} };
    upstreamSocket.on('error', close);
    socket.on('error', close);
    upstreamSocket.on('close', close);
    socket.on('close', close);
  });

  upstream.on('response', (upstreamRes) => {
    // Not an upgrade; relay the status and end.
    clearTimeout(timer);
    socket.write(`HTTP/1.1 ${upstreamRes.statusCode} ${upstreamRes.statusMessage}\r\n`);
    for (let i = 0; i < upstreamRes.rawHeaders.length; i += 2) {
      socket.write(`${upstreamRes.rawHeaders[i]}: ${upstreamRes.rawHeaders[i + 1]}\r\n`);
    }
    socket.write('\r\n');
    upstreamRes.pipe(socket);
  });

  upstream.on('error', (error) => {
    clearTimeout(timer);
    log(`websocket upstream error: ${error.message}`);
    try { rejectUpgrade(socket, 502, 'DSH websocket unavailable'); } catch {}
  });

  socket.on('error', () => { clearTimeout(timer); upstream.destroy(); });
  upstream.end();
}

/* ------------------------------------------------------------------ */
/* Server                                                              */
/* ------------------------------------------------------------------ */

const server = http.createServer((req, res) => {
  const url = req.url || '/';

  if (url === '/__gate/health') {
    const remote = req.socket.remoteAddress || '';
    if (remote !== '127.0.0.1' && remote !== '::1' && remote !== '::ffff:127.0.0.1') {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      return res.end('not found');
    }
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    return res.end(JSON.stringify({ ok: true, upstream: UPSTREAM.authority, time: new Date().toISOString() }));
  }

  const cookies = readCookies(req.headers.cookie);
  const cookieOk = cookies[GATE_COOKIE] !== undefined && verifyGateToken(cookies[GATE_COOKIE]);
  const basicOk = !cookieOk && verifyBasic(req.headers.authorization);
  if (!cookieOk && !basicOk) {
    req.resume();
    return unauthorized(req, res);
  }
  if (!cookieOk && basicOk) res.setHeader('Set-Cookie', gateCookieHeader(req));

  proxyRequest(req, res);
});

server.on('upgrade', (req, socket, head) => {
  const cookies = readCookies(req.headers.cookie);
  const cookieOk = cookies[GATE_COOKIE] !== undefined && verifyGateToken(cookies[GATE_COOKIE]);
  const basicOk = !cookieOk && verifyBasic(req.headers.authorization);
  if (!cookieOk && !basicOk) {
    return rejectUpgrade(socket, 401, 'Authorization required');
  }
  proxyUpgrade(req, socket, head, !cookieOk && basicOk ? gateCookieHeader(req) : null);
});

server.on('clientError', (error, socket) => {
  try { socket.end('HTTP/1.1 400 Bad Request\r\n\r\n'); } catch {}
});

server.listen(LISTEN.port, LISTEN.host, () => {
  log(`gateway listening on http://${LISTEN.host}:${LISTEN.port} -> http://${UPSTREAM.authority}`);
  const cfg = auth();
  log(`basic auth user: ${cfg.user}` + (authCache.mtime === -1 ? ' (default admin/change-me - run set-password.ps1)' : ''));
  // Fail fast at startup if the DSH secret is unreadable, but keep listening:
  // the supervisor restarts DSH and the credentials file may appear later.
  try {
    loadDshSecret();
  } catch (error) {
    log(`warning: ${error.message}`);
  }
});

process.on('SIGTERM', () => server.close(() => process.exit(0)));
process.on('SIGINT', () => server.close(() => process.exit(0)));
process.on('uncaughtException', (error) => log(`uncaught: ${error.stack || error.message}`));
process.on('unhandledRejection', (error) => log(`unhandled rejection: ${error && error.stack ? error.stack : error}`));
