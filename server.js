import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from './src/db.js';
import * as S from './src/services.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(ROOT, 'public');
const PORT = Number(process.env.PORT) || 3000;
const DB_FILE = process.env.DB_FILE || path.join(ROOT, 'data', 'fraudquest.db');

const db = openDb(DB_FILE, { reset: process.argv.includes('--reset') });

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };
const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Content-Security-Policy': "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:",
};

function send(res, status, body, headers = {}) {
  res.writeHead(status, { ...SECURITY_HEADERS, ...headers });
  res.end(body);
}
const json = (res, status, obj, headers = {}) =>
  send(res, status, JSON.stringify(obj), { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers });

function cookies(req) {
  return Object.fromEntries((req.headers.cookie ?? '').split(';').map((c) => c.trim().split('=')).filter(([k]) => k));
}

async function readJson(req) {
  if (!String(req.headers['content-type'] ?? '').includes('application/json')) {
    throw new S.ApiError(415, 'Content-Type must be application/json'); // also blocks simple-form CSRF
  }
  let size = 0;
  const chunks = [];
  for await (const c of req) {
    size += c.length;
    if (size > 64 * 1024) throw new S.ApiError(413, 'Body too large');
    chunks.push(c);
  }
  try {
    return chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
  } catch {
    throw new S.ApiError(400, 'Invalid JSON');
  }
}

const needAnalyst = (user) => {
  if (user.role !== 'analyst') throw new S.ApiError(403, 'Analyst access required');
};

// [method, path, handler, { public }]
const routes = {
  'POST /api/login': [async (req, res) => {
    const { username, password } = await readJson(req);
    const token = S.login(db, username, password);
    json(res, 200, S.getMe(db, S.userForToken(db, token)), {
      'Set-Cookie': `sid=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${60 * 60 * 8}`,
    });
  }, { public: true }],
  'POST /api/logout': [async (req, res, { token }) => {
    S.logout(db, token);
    json(res, 200, { ok: true }, { 'Set-Cookie': 'sid=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0' });
  }],
  'GET /api/me': [(req, res, { user }) => json(res, 200, S.getMe(db, user))],
  'GET /api/queue': [(req, res, { user }) => json(res, 200, S.getQueue(db, user))],
  'POST /api/reviews': [async (req, res, { user }) => json(res, 200, S.submitReview(db, user, await readJson(req)))],
  'GET /api/rewards': [(req, res, { user }) => json(res, 200, S.listRewards(db, user))],
  'POST /api/rewards/redeem': [async (req, res, { user }) => {
    const { rewardId } = await readJson(req);
    json(res, 200, S.redeem(db, user, rewardId));
  }],
  'GET /api/leaderboard': [(req, res, { user, url }) =>
    json(res, 200, S.leaderboard(db, user, url.searchParams.get('period') === 'all' ? 'all' : 'week'))],
  'GET /api/activity': [(req, res, { user }) => json(res, 200, S.activity(db, user))],
  'GET /api/admin/stats': [(req, res, { user }) => { needAnalyst(user); json(res, 200, S.adminStats(db)); }],
  'POST /api/admin/retrain': [async (req, res, { user }) => { needAnalyst(user); await readJson(req); json(res, 200, S.retrain(db)); }],
  'GET /api/admin/export': [(req, res, { user, url }) => {
    needAnalyst(user);
    const format = url.searchParams.get('format') === 'csv' ? 'csv' : 'jsonl';
    send(res, 200, S.exportTrainingData(db, format), {
      'Content-Type': format === 'csv' ? 'text/csv; charset=utf-8' : 'application/x-ndjson; charset=utf-8',
      'Content-Disposition': `attachment; filename="fraud-labels-${new Date().toISOString().slice(0, 10)}.${format}"`,
    });
  }],
};

function serveStatic(req, res, url) {
  const rel = decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname);
  const file = path.normalize(path.join(PUBLIC, rel));
  if (!file.startsWith(PUBLIC + path.sep)) return send(res, 403, 'Forbidden');
  fs.readFile(file, (err, data) => {
    if (err) {
      // SPA fallback
      return fs.readFile(path.join(PUBLIC, 'index.html'), (e2, html) =>
        e2 ? send(res, 404, 'Not found') : send(res, 200, html, { 'Content-Type': MIME['.html'] }));
    }
    send(res, 200, data, { 'Content-Type': MIME[path.extname(file)] ?? 'application/octet-stream' });
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  try {
    if (!url.pathname.startsWith('/api/')) {
      if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'Method not allowed');
      return serveStatic(req, res, url);
    }
    const route = routes[`${req.method} ${url.pathname}`];
    if (!route) throw new S.ApiError(404, 'Not found');
    const [handler, opts = {}] = route;
    const token = cookies(req).sid;
    const user = S.userForToken(db, token);
    if (!opts.public && !user) throw new S.ApiError(401, 'Please sign in');
    await handler(req, res, { user, token, url });
  } catch (err) {
    if (!(err instanceof S.ApiError)) console.error(err);
    json(res, err.status ?? 500, { error: err instanceof S.ApiError ? err.message : 'Internal error' });
  }
});

server.listen(PORT, () => {
  console.log(`FraudQuest PoC running at http://localhost:${PORT}`);
  console.log('Demo logins (password "demo"): alice, bob (consumer) · acme (business) · analyst (fraud ops)');
});
