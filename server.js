const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = __dirname;
const PUBLIC = path.join(ROOT, 'public');
const configuredDbFile = String(process.env.NEXIVO_DB_FILE || '').trim();
// Render Free does not provide /var/data unless a paid Persistent Disk is attached.
// Keep a local cache under the app directory and persist the authoritative state in Supabase when configured.
const DB_FILE = configuredDbFile && !configuredDbFile.startsWith('/var/data')
  ? configuredDbFile
  : path.join(ROOT, 'data', 'db.json');

function loadDotEnv() {
  const file = path.join(ROOT, '.env');
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const i = t.indexOf('=');
    if (i <= 0) continue;
    const k = t.slice(0, i).trim();
    const v = t.slice(i + 1).trim().replace(/^["']|["']$/g, '');
    if (process.env[k] === undefined) process.env[k] = v;
  }
}
loadDotEnv();

const PORT = Number(process.env.PORT || 3000);
const OPERATOR_USER = process.env.NEXIVO_OPERATOR_USER || '0nTop';
const OPERATOR_PASSWORD = process.env.NEXIVO_OPERATOR_PASSWORD || '';
const BOT_BRIDGE_SECRET = process.env.NEXIVO_BOT_BRIDGE_SECRET || '';
const BOT_WORKER_SECRET = String(process.env.NEXIVO_BOT_WORKER_SECRET || '').trim();
const LICENSE_ISSUE_SECRET = process.env.NEXIVO_LICENSE_ISSUE_SECRET || '';
const BOT_CLIENT_ID = String(process.env.NEXIVO_BOT_CLIENT_ID || '').trim();
const BOT_INVITE_URL = String(process.env.NEXIVO_BOT_INVITE_URL || '').trim();
const BOT_DISPLAY_NAME = String(process.env.NEXIVO_BOT_DISPLAY_NAME || 'NEXIVO HUB Bot').trim();
const COOKIE_SECURE = String(process.env.COOKIE_SECURE || 'false') === 'true';
const SESSION_DAYS = Math.max(1, Number(process.env.NEXIVO_SESSION_DAYS || 30));
const OWNER_USER_ID = 'owner';
const OWNER_LICENSE_KEY = String(process.env.NEXIVO_OWNER_LICENSE_KEY || '').trim().toUpperCase();
const OWNER_DISCORD_ID = String(process.env.NEXIVO_OWNER_DISCORD_ID || '').trim();
const DISCORD_CLIENT_ID = String(process.env.NEXIVO_DISCORD_CLIENT_ID || BOT_CLIENT_ID || '').trim();
const DISCORD_CLIENT_SECRET = String(process.env.NEXIVO_DISCORD_CLIENT_SECRET || '').trim();
const DISCORD_REDIRECT_URI = String(process.env.NEXIVO_DISCORD_REDIRECT_URI || '').trim();
const DISCORD_AUTH_REDIRECT_URI = String(process.env.NEXIVO_DISCORD_AUTH_REDIRECT_URI || '').trim();
const GOOGLE_CLIENT_ID = String(process.env.NEXIVO_GOOGLE_CLIENT_ID || '').trim();
const GOOGLE_CLIENT_SECRET = String(process.env.NEXIVO_GOOGLE_CLIENT_SECRET || '').trim();
const GOOGLE_AUTH_REDIRECT_URI = String(process.env.NEXIVO_GOOGLE_AUTH_REDIRECT_URI || '').trim();
const IP_LOG_RETENTION_DAYS = Math.max(1, Number(process.env.NEXIVO_IP_LOG_RETENTION_DAYS || 30));
const PORTONE_API_SECRET = String(process.env.NEXIVO_PORTONE_API_SECRET || '').trim();
const PORTONE_STORE_ID = String(process.env.NEXIVO_PORTONE_STORE_ID || '').trim();
const PORTONE_CHANNEL_KEY = String(process.env.NEXIVO_PORTONE_CHANNEL_KEY || '').trim();
const PORTONE_BILLING_METHOD = String(process.env.NEXIVO_PORTONE_BILLING_METHOD || 'CARD').trim().toUpperCase();
const STORE_DISCORD_INVITE_URL = String(process.env.NEXIVO_STORE_DISCORD_INVITE_URL || process.env.NEXIVO_BOT_INVITE_URL || '').trim();
const STORE_BANK_INFO = String(process.env.NEXIVO_STORE_BANK_INFO || '').trim();
const SUPABASE_URL = String(process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || '').trim().replace(/\/$/, '');
const SUPABASE_SECRET_KEY = String(process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || '').trim();
const SUPABASE_STATE_TABLE = String(process.env.SUPABASE_STATE_TABLE || 'nexivo_state').trim();
const SUPABASE_STATE_ID = 'main';
const SUPABASE_ENABLED = Boolean(SUPABASE_URL && SUPABASE_SECRET_KEY);
let remoteDbReady = false;
let remoteSyncChain = Promise.resolve();
let remoteSyncErrorLogged = false;


const PLAN_META = {
  BASIC: { label: 'Basic', prefix: 'VEX-BSC', level: 1, botFamily: 'BASIC', features: ['products', 'orders', 'license', 'settings'] },
  BASIC_PREMIUM: { label: 'Basic Premium', prefix: 'VEX-BSP', level: 2, botFamily: 'BASIC', features: ['products', 'orders', 'license', 'settings', 'notice'] },
  PRO: { label: 'Pro', prefix: 'VEX-PRO', level: 3, botFamily: 'PRO', features: ['products', 'orders', 'license', 'settings', 'notice', 'grades', 'reports'] },
  PRO_PREMIUM: { label: 'Pro Premium', prefix: 'VEX-PRP', level: 4, botFamily: 'PRO', features: ['products', 'orders', 'license', 'settings', 'notice', 'grades', 'reports', 'customers', 'audit'] }
};

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml', '.ico': 'image/x-icon'
};

function baseDb() {
  return { users: [], licenses: [], sessions: [], products: [], productKeys: [], orders: [], reviews: [], settings: {}, audit: [], securityLogs: [], verifyStates: [], oauthStates: [], events: [], bots: [], botCredentials: [], botConfig: {}, topupRequests: [], walletLedger: [], meta: { nextEventId: 1 } };
}
function loadDb() {
  try { return { ...baseDb(), ...JSON.parse(fs.readFileSync(DB_FILE, 'utf8')) }; } catch { return baseDb(); }
}
let db = loadDb();
if (!Array.isArray(db.users)) db.users = [];
if (!Array.isArray(db.licenses)) db.licenses = [];
if (!Array.isArray(db.sessions)) db.sessions = [];
if (!Array.isArray(db.products)) db.products = [];
if (!Array.isArray(db.productKeys)) db.productKeys = [];
if (!Array.isArray(db.orders)) db.orders = [];
if (!Array.isArray(db.reviews)) db.reviews = [];
if (!db.settings || typeof db.settings !== 'object') db.settings = {};
if (!Array.isArray(db.audit)) db.audit = [];
if (!Array.isArray(db.securityLogs)) db.securityLogs = [];
if (!Array.isArray(db.verifyStates)) db.verifyStates = [];
if (!Array.isArray(db.oauthStates)) db.oauthStates = [];
if (!Array.isArray(db.events)) db.events = [];
if (!Array.isArray(db.bots)) db.bots = [];
if (!Array.isArray(db.botCredentials)) db.botCredentials = [];
if (!db.botConfig || typeof db.botConfig !== 'object') db.botConfig = {};
if (!Array.isArray(db.topupRequests)) db.topupRequests = [];
if (!Array.isArray(db.walletLedger)) db.walletLedger = [];
if (db.botCredentials.length) { db.botCredentials = []; saveDb(); }
if (!db.meta || typeof db.meta !== 'object') db.meta = { nextEventId: 1 };
if (!Number.isInteger(db.meta.nextEventId) || db.meta.nextEventId < 1) {
  const maxEventId = db.events.reduce((m, e) => Math.max(m, Number(e?.id) || 0), 0);
  db.meta.nextEventId = maxEventId + 1;
}

function ensureOwnerAccount() {
  if (!OPERATOR_PASSWORD) {
    console.warn('[NEXIVO HUB] NEXIVO_OPERATOR_PASSWORD is not set; owner login is disabled until a secret password is configured.');
    return;
  }
  let changed = false;
  let user = db.users.find(u => u.id === OWNER_USER_ID || u.role === 'OWNER');
  if (!user) {
    user = {
      id: OWNER_USER_ID,
      username: OPERATOR_USER,
      passwordHash: hashPassword(OPERATOR_PASSWORD),
      plan: 'PRO_PREMIUM',
      role: 'OWNER',
      licenseId: null,
      createdAt: now()
    };
    db.users.push(user);
    changed = true;
  } else {
    if (user.id !== OWNER_USER_ID) { user.id = OWNER_USER_ID; changed = true; }
    if (user.username !== OPERATOR_USER) { user.username = OPERATOR_USER; changed = true; }
    if (!user.passwordHash || !verifyPassword(OPERATOR_PASSWORD, user.passwordHash)) { user.passwordHash = hashPassword(OPERATOR_PASSWORD); changed = true; }
    if (user.plan !== 'PRO_PREMIUM') { user.plan = 'PRO_PREMIUM'; changed = true; }
    if (user.role !== 'OWNER') { user.role = 'OWNER'; changed = true; }
  }

  // OWNER PRO PREMIUM is a real license, not a role-only bypass.
  // The key is provided once through the server secret NEXIVO_OWNER_LICENSE_KEY.
  let license = db.licenses.find(l => l.owner === true && l.userId === OWNER_USER_ID);
  if (!license && OWNER_LICENSE_KEY) license = db.licenses.find(l => l.key === OWNER_LICENSE_KEY);
  const ownerKey = license?.key || (OWNER_LICENSE_KEY || keygen('PRO_PREMIUM'));
  if (!license) {
    license = {
      id: rid('lic'), key: ownerKey, plan: 'PRO_PREMIUM', status: 'ACTIVE', userId: OWNER_USER_ID,
      createdAt: now(), activatedAt: now(), expiresAt: null, durationDays: 0,
      discordUserId: OWNER_DISCORD_ID || null, orderId: null, issuerUserId: OWNER_USER_ID, issuerUsername: OPERATOR_USER,
      botSecret: `vh_${randomText(24)}`, bot: null, owner: true
    };
    db.licenses.unshift(license);
    changed = true;
  } else {
    if (OWNER_LICENSE_KEY && license.key !== OWNER_LICENSE_KEY) { license.key = OWNER_LICENSE_KEY; changed = true; }
    if (license.userId !== OWNER_USER_ID) { license.userId = OWNER_USER_ID; changed = true; }
    if (license.plan !== 'PRO_PREMIUM') { license.plan = 'PRO_PREMIUM'; changed = true; }
    if (license.durationDays !== 0) { license.durationDays = 0; changed = true; }
    if (license.expiresAt !== null) { license.expiresAt = null; changed = true; }
    if (license.discordUserId !== (OWNER_DISCORD_ID || null)) { license.discordUserId = OWNER_DISCORD_ID || null; changed = true; }
    if (!license.botSecret) { license.botSecret = `vh_${randomText(24)}`; changed = true; }
    if (license.owner !== true) { license.owner = true; changed = true; }
    if (license.issuerUserId !== OWNER_USER_ID) { license.issuerUserId = OWNER_USER_ID; changed = true; }
    if (license.issuerUsername !== OPERATOR_USER) { license.issuerUsername = OPERATOR_USER; changed = true; }
    // Do not silently restore a suspended/revoked owner license; the license must be ACTIVE to log in.
  }
  if (user.licenseId !== license.id) { user.licenseId = license.id; changed = true; }
  if (!db.settings[OWNER_USER_ID]) { db.settings[OWNER_USER_ID] = {}; changed = true; }
  if (changed) saveDb();
}
async function supabaseFetch(pathname, options = {}) {
  if (!SUPABASE_ENABLED) return null;
  const url = `${SUPABASE_URL}/rest/v1/${SUPABASE_STATE_TABLE}${pathname}`;
  const headers = {
    apikey: SUPABASE_SECRET_KEY,
    Authorization: `Bearer ${SUPABASE_SECRET_KEY}`,
    'Content-Type': 'application/json',
    ...options.headers
  };
  const res = await fetch(url, { ...options, headers });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Supabase ${res.status}: ${body.slice(0, 500)}`);
  }
  return res;
}

async function hydrateFromSupabase() {
  if (!SUPABASE_ENABLED) return false;
  try {
    const res = await supabaseFetch(`?id=eq.${encodeURIComponent(SUPABASE_STATE_ID)}&select=state&limit=1`, {
      method: 'GET',
      headers: { Accept: 'application/json' }
    });
    const rows = await res.json();
    if (Array.isArray(rows) && rows[0] && rows[0].state && typeof rows[0].state === 'object') {
      db = { ...baseDb(), ...rows[0].state };
      remoteDbReady = true;
      return true;
    }
    remoteDbReady = true;
    return false;
  } catch (err) {
    console.error(`[NEXIVO HUB] Supabase load failed: ${err.message}`);
    remoteDbReady = false;
    return false;
  }
}

function scheduleRemoteSync() {
  if (!SUPABASE_ENABLED || !remoteDbReady) return;
  const snapshot = JSON.parse(JSON.stringify(db));
  remoteSyncChain = remoteSyncChain.then(async () => {
    try {
      await supabaseFetch(`?on_conflict=id`, {
        method: 'POST',
        headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
        body: JSON.stringify([{ id: SUPABASE_STATE_ID, state: snapshot, updated_at: now() }])
      });
      remoteSyncErrorLogged = false;
    } catch (err) {
      if (!remoteSyncErrorLogged) {
        console.error(`[NEXIVO HUB] Supabase save failed: ${err.message}`);
        remoteSyncErrorLogged = true;
      }
    }
  });
}

function saveDb() {
  const cutoff = Date.now() - IP_LOG_RETENTION_DAYS * 86400000;
  db.securityLogs = (db.securityLogs || []).filter(x => { const t = new Date(x.at || 0).getTime(); return !t || t >= cutoff; }).slice(0, 2000);
  db.verifyStates = (db.verifyStates || []).filter(x => Date.now() - new Date(x.createdAt || 0).getTime() < 10 * 60 * 1000).slice(-500);
  db.oauthStates = (db.oauthStates || []).filter(x => Date.now() - new Date(x.createdAt || 0).getTime() < 10 * 60 * 1000).slice(-500);
  fs.mkdirSync(path.dirname(DB_FILE), { recursive: true });
  const tmp = DB_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(db, null, 2), 'utf8');
  fs.renameSync(tmp, DB_FILE);
  scheduleRemoteSync();
}
function now() { return new Date().toISOString(); }
function rid(prefix) { return `${prefix}_${crypto.randomBytes(9).toString('hex')}`; }
function clientIp(req) {
  const forwarded = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  const real = String(req.headers['x-real-ip'] || '').trim();
  const socket = String(req.socket?.remoteAddress || '').trim();
  return forwarded || real || socket || 'unknown';
}
function recordSecurityLog(entry) {
  const clean = {
    id: rid('sec'), at: now(), ip: String(entry.ip || 'unknown').slice(0, 128),
    userAgent: String(entry.userAgent || '').slice(0, 500), discordUserId: entry.discordUserId ? String(entry.discordUserId).slice(0, 40) : null,
    discordUsername: entry.discordUsername ? String(entry.discordUsername).slice(0, 120) : null,
    guildId: entry.guildId ? String(entry.guildId).slice(0, 40) : null, action: String(entry.action || 'VERIFY').slice(0, 80),
    result: String(entry.result || 'success').slice(0, 40)
  };
  db.securityLogs.unshift(clean); db.securityLogs = db.securityLogs.slice(0, 2000);
  return clean;
}

function randomText(bytes = 18) { return crypto.randomBytes(bytes).toString('base64url'); }
function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(password), salt, 64).toString('hex');
  return `${salt}:${hash}`;
}
function verifyPassword(password, stored) {
  const [salt, expected] = String(stored || '').split(':');
  if (!salt || !expected) return false;
  const actual = crypto.scryptSync(String(password), salt, 64).toString('hex');
  if (actual.length !== expected.length) return false;
  return crypto.timingSafeEqual(Buffer.from(actual, 'hex'), Buffer.from(expected, 'hex'));
}
function tokenCryptoKey() {
  if (!BOT_WORKER_SECRET) throw new Error('NEXIVO_BOT_WORKER_SECRET가 필요합니다.');
  return crypto.scryptSync(BOT_WORKER_SECRET, 'nexivo-discord-token-v1', 32);
}
function encryptBotToken(token) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', tokenCryptoKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(String(token), 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return { v: 1, alg: 'aes-256-gcm', iv: iv.toString('base64url'), tag: authTag.toString('base64url'), data: ciphertext.toString('base64url') };
}
function decryptBotToken(payload) {
  if (!payload || payload.v !== 1 || payload.alg !== 'aes-256-gcm') return '';
  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', tokenCryptoKey(), Buffer.from(String(payload.iv || ''), 'base64url'));
    decipher.setAuthTag(Buffer.from(String(payload.tag || ''), 'base64url'));
    return Buffer.concat([decipher.update(Buffer.from(String(payload.data || ''), 'base64url')), decipher.final()]).toString('utf8');
  } catch {
    return '';
  }
}

function normalizePlan(v) { const p = String(v || '').toUpperCase(); return PLAN_META[p] ? p : 'BASIC'; }
function planLabel(v) { return PLAN_META[normalizePlan(v)].label; }
function planFamily(v) { return PLAN_META[normalizePlan(v)].botFamily; }
function isPremium(v) { return normalizePlan(v).endsWith('_PREMIUM'); }
function keygen(plan) {
  const meta = PLAN_META[plan];
  const a = () => crypto.randomBytes(3).toString('hex').toUpperCase();
  return `${meta.prefix}-${a()}-${a()}-${a()}`;
}
function expiresFor(activatedAt, days) {
  const d = Number(days);
  if (!Number.isFinite(d) || d <= 0 || !activatedAt) return null;
  return new Date(new Date(activatedAt).getTime() + Math.floor(d) * 86400000).toISOString();
}
function licenseExpired(l) { return Boolean(l.expiresAt && new Date(l.expiresAt).getTime() <= Date.now()); }
function remainingDays(l) {
  if (!l.expiresAt) return null;
  return Math.max(0, Math.ceil((new Date(l.expiresAt).getTime() - Date.now()) / 86400000));
}
function effectiveStatus(l) {
  if (l.status === 'REVOKED') return 'REVOKED';
  if (l.status === 'SUSPENDED') return 'SUSPENDED';
  if (licenseExpired(l)) return 'EXPIRED';
  return l.status || 'UNUSED';
}
function stable(v) { return JSON.stringify(v, (k, value) => { if (value && typeof value === 'object' && !Array.isArray(value)) return Object.keys(value).sort().reduce((o, key) => { o[key] = value[key]; return o; }, {}); return value; }); }
function cookie(req, name) {
  const raw = req.headers.cookie || '';
  const pair = raw.split(';').map(x => x.trim()).find(x => x.startsWith(name + '='));
  return pair ? decodeURIComponent(pair.slice(name.length + 1)) : null;
}
function setCookie(res, name, val, maxAge = SESSION_DAYS * 86400) {
  let v = `${name}=${encodeURIComponent(val)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}`;
  if (COOKIE_SECURE) v += '; Secure';
  res.setHeader('Set-Cookie', v);
}
function clearCookie(res, name) { setCookie(res, name, '', 0); }
function json(res, status, data, headers = {}) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...headers });
  res.end(JSON.stringify(data));
}
function text(res, status, data, headers = {}) { res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8', ...headers }); res.end(data); }
function parseBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', c => { raw += c; if (raw.length > 4 * 1024 * 1024) { req.destroy(); reject(new Error('body too large')); } });
    req.on('end', () => {
      if (!raw) return resolve({});
      try { resolve(JSON.parse(raw)); } catch { resolve(Object.fromEntries(new URLSearchParams(raw))); }
    });
    req.on('error', reject);
  });
}
function audit(actor, action, target, detail) {
  db.audit.unshift({ id: rid('aud'), at: now(), actor, action, target, detail: String(detail || '') });
  db.audit = db.audit.slice(0, 800);
}

const sseClients = new Set();
function broadcastEvent(e) {
  for (const client of [...sseClients]) {
    const ownerId = e?.payload?.ownerId;
    const licenseId = e?.payload?.licenseId;
    if (client.kind !== 'worker') {
      if (ownerId && ownerId !== client.userId && licenseId !== client.licenseId) continue;
      if (!ownerId && !licenseId) continue;
    }
    try {
      client.res.write(`event: sync\ndata: ${JSON.stringify(e)}\n\n`);
    } catch {
      sseClients.delete(client);
    }
  }
}

function requestBotSync(userId, reason = 'data_changed') {
  const u = db.users.find(x => x.id === userId);
  if (!u) return false;
  const settings = userSettings(userId);
  if (!settings.guildId) return false;
  pushEvent('bot.inventory_sync_requested', { ownerId: userId, reason, guildId: settings.guildId });
  return true;
}
function pushEvent(type, payload) {
  const e = { id: db.meta.nextEventId++, type, at: now(), payload };
  db.events.push(e);
  db.events = db.events.slice(-2000);
  broadcastEvent(e);
  return e;
}

function walletDefaults() {
  return { balance: 0, autoTopup: { enabled: false, threshold: 5000, amount: 10000, provider: null, configured: false }, billingMethod: null };
}
function ensureWallet(user) {
  if (!user) return walletDefaults();
  if (!Number.isFinite(Number(user.walletBalance))) user.walletBalance = 0;
  if (!user.autoTopup || typeof user.autoTopup !== 'object') user.autoTopup = { enabled: false, threshold: 5000, amount: 10000, provider: null, configured: false };
  user.autoTopup.enabled = Boolean(user.autoTopup.enabled);
  user.autoTopup.threshold = Math.max(1000, Math.min(1000000, Math.floor(Number(user.autoTopup.threshold) || 5000)));
  user.autoTopup.amount = Math.max(1000, Math.min(1000000, Math.floor(Number(user.autoTopup.amount) || 10000)));
  user.autoTopup.provider = user.autoTopup.provider || null;
  user.autoTopup.configured = Boolean(user.billingKeyEncrypted);
  return { balance: Math.max(0, Math.floor(Number(user.walletBalance) || 0)), autoTopup: { ...user.autoTopup }, billingMethod: user.billingMethod || null };
}
function publicWallet(user) {
  const w = ensureWallet(user);
  return {
    balance: w.balance,
    autoTopup: { enabled: w.autoTopup.enabled, threshold: w.autoTopup.threshold, amount: w.autoTopup.amount, provider: w.autoTopup.provider, configured: Boolean(user?.billingKeyEncrypted), billingMethod: user?.billingMethod || null },
    ledger: db.walletLedger.filter(x => x.userId === user?.id).slice(0, 50).map(x => ({ id:x.id, type:x.type, amount:x.amount, balanceAfter:x.balanceAfter, reason:x.reason, orderId:x.orderId || null, createdAt:x.createdAt }))
  };
}
function walletChange(user, delta, type, reason, meta = {}) {
  ensureWallet(user);
  const n = Math.trunc(Number(delta));
  if (!Number.isInteger(n) || n === 0) return false;
  const next = Math.floor(Number(user.walletBalance || 0)) + n;
  if (next < 0) return false;
  user.walletBalance = next;
  db.walletLedger.unshift({ id: rid('wal'), userId: user.id, type, amount: n, balanceAfter: next, reason: String(reason || '').slice(0, 200), orderId: meta.orderId || null, createdAt: now() });
  db.walletLedger = db.walletLedger.slice(0, 5000);
  return true;
}
function creditWallet(user, amount, reason, meta = {}) { return walletChange(user, Math.abs(Math.trunc(Number(amount))), 'CREDIT', reason, meta); }
function debitWallet(user, amount, reason, meta = {}) { return walletChange(user, -Math.abs(Math.trunc(Number(amount))), 'DEBIT', reason, meta); }
function portOneReady() { return Boolean(PORTONE_API_SECRET); }
function billingConfigured(user) { return Boolean(user?.billingKeyEncrypted && PORTONE_API_SECRET && PORTONE_STORE_ID && PORTONE_CHANNEL_KEY); }
async function portOneCharge(user, amount, reason='NEXIVO 자동충전') {
  if (!billingConfigured(user)) return { ok: false, error: '자동충전 결제수단이 설정되지 않았습니다.' };
  const billingKey = decryptBotToken(user.billingKeyEncrypted);
  if (!billingKey) return { ok: false, error: '저장된 결제수단을 복호화할 수 없습니다.' };
  const paymentId = `nexivo-topup-${Date.now()}-${randomText(5)}`;
  try {
    const r = await fetch(`https://api.portone.io/payments/${encodeURIComponent(paymentId)}/billing-key`, {
      method: 'POST',
      headers: { Authorization: `PortOne ${PORTONE_API_SECRET}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ storeId: PORTONE_STORE_ID, channelKey: PORTONE_CHANNEL_KEY, billingKey, amount: { total: Math.max(1000, Math.floor(Number(amount) || 0)) }, currency: 'KRW', orderName: reason, customer: { id: String(user.id), name: String(user.username || user.id), email: String(user.email || '') || undefined } })
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) return { ok: false, error: data?.message || data?.detail || `자동충전 결제 실패 (${r.status})`, paymentId };
    return { ok: true, paymentId, data };
  } catch (e) {
    return { ok: false, error: `자동충전 요청 실패: ${e?.message || e}` };
  }
}
async function maybeAutoTopup(user, reason='구매 후 자동충전') {
  ensureWallet(user);
  if (!user.autoTopup?.enabled || !billingConfigured(user)) return { triggered: false, ok: true };
  const threshold = Number(user.autoTopup.threshold) || 5000;
  const amount = Number(user.autoTopup.amount) || 10000;
  if (Number(user.walletBalance || 0) > threshold) return { triggered: false, ok: true };
  if (user.autoTopup.lastAttemptAt && Date.now() - new Date(user.autoTopup.lastAttemptAt).getTime() < 5 * 60 * 1000) return { triggered: false, ok: true, skipped: true };
  user.autoTopup.lastAttemptAt = now();
  const charge = await portOneCharge(user, amount, reason);
  if (!charge.ok) {
    user.autoTopup.lastError = charge.error;
    saveDb();
    return { triggered: true, ok: false, error: charge.error };
  }
  creditWallet(user, amount, `자동충전: ${reason}`, { orderId: charge.paymentId });
  user.autoTopup.lastSuccessAt = now();
  user.autoTopup.lastError = null;
  db.topupRequests.unshift({ id: charge.paymentId, userId: user.id, username: user.username, amount, method: 'PORTONE_BILLING', status: '완료', createdAt: now(), approvedAt: now(), paymentId: charge.paymentId, reason });
  audit('SYSTEM', 'WALLET_AUTO_TOPUP', user.id, `${amount}원 / ${charge.paymentId}`);
  saveDb();
  return { triggered: true, ok: true, paymentId: charge.paymentId, amount };
}
function createDiscordShadowUser(discordUserId, discordUsername='Discord 사용자') {
  const did = String(discordUserId || '').trim();
  if (!did) return null;
  let u = db.users.find(x => String(x.discordUserId || '') === did || String(x.authProviders?.discordId || '') === did);
  if (u) return u;
  let base = String(discordUsername || `discord_${did}`).replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 28) || `discord_${did}`;
  let username = base;
  let n = 1;
  while (db.users.some(x => String(x.username || '').toLowerCase() === username.toLowerCase())) username = `${base.slice(0, 24)}_${n++}`;
  u = { id: rid('usr'), username, passwordHash: null, plan: 'BASIC', role: 'CUSTOMER', licenseId: null, email: null, authProviders: { discordId: did }, discordUserId: did, createdAt: now(), walletBalance: 0, autoTopup: { enabled: false, threshold: 5000, amount: 10000, provider: null, configured: false } };
  db.users.push(u);
  ensureWallet(u);
  return u;
}
function bindLicenseToGuild(license, user, guildId) {
  const gid = String(guildId || '').trim();
  if (!license || !user || !/^\d{15,25}$/.test(gid)) return false;
  const settings = userSettings(user.id);
  if (settings.guildId && settings.guildId !== gid) return false;
  db.settings[user.id] = normalizeSettings({ ...settings, guildId: gid }, settings);
  license.discordUserId = license.discordUserId || user.discordUserId || user.authProviders?.discordId || null;
  license.guildId = gid;
  touchBot(license, { status: 'CONNECTED', guildId: gid });
  return true;
}

function createLicense(rawPlan, meta = {}) {
  const plan = normalizePlan(rawPlan);
  let key; do { key = keygen(plan); } while (db.licenses.some(x => x.key === key));
  const d = Number(meta.durationDays);
  const durationDays = Number.isFinite(d) ? Math.max(0, Math.floor(d)) : 30;
  const l = {
    id: rid('lic'), key, plan, status: 'UNUSED', userId: null,
    createdAt: now(), activatedAt: null, expiresAt: null,
    durationDays, discordUserId: meta.discordUserId || null, discordUsername: meta.discordUsername || null, guildId: meta.guildId || null, orderId: meta.orderId || null,
    issuerUserId: meta.issuerUserId || null, issuerUsername: meta.issuerUsername || null,
    botSecret: `vh_${randomText(24)}`, bot: null
  };
  db.licenses.unshift(l);
  pushEvent('license.created', { licenseId: l.id, plan: l.plan, status: l.status, durationDays: l.durationDays });
  audit(meta.actor || 'SYSTEM', 'LICENSE_CREATE', l.id, `${planLabel(l.plan)} / ${l.key} / ${durationDays ? durationDays + '일' : '무기한'}`);
  saveDb();
  return l;
}
function operatorOK(req) {
  const h = String(req.headers.authorization || '');
  return h === 'Basic ' + Buffer.from(`${OPERATOR_USER}:${OPERATOR_PASSWORD}`).toString('base64');
}
function botOK(req, license) {
  const bridge = String(req.headers['x-nexivo-bridge-secret'] || '');
  const licenseMatch = String(req.headers['x-nexivo-license'] || '') === String(license?.key || '');
  const secretMatch = String(req.headers['x-nexivo-bot-secret'] || '') === String(license?.botSecret || '');
  if (!licenseMatch || !secretMatch) return false;
  // Per-license bot secrets are sufficient for customer bots. The shared bridge
  // secret remains supported for older integrations, but is no longer required.
  return !bridge || bridge === BOT_BRIDGE_SECRET;
}
function session(res, user) {
  const token = randomText(32);
  db.sessions.push({ token, userId: user.id, createdAt: now(), expiresAt: new Date(Date.now() + SESSION_DAYS * 86400000).toISOString() });
  db.sessions = db.sessions.filter(s => new Date(s.expiresAt).getTime() > Date.now()).slice(-500);
  saveDb();
  setCookie(res, 'nexivo_session', token);
}
function publicBotConfig() {
  return {
    clientId: String(db.botConfig.clientId || BOT_CLIENT_ID || ''),
    inviteUrl: String(db.botConfig.inviteUrl || BOT_INVITE_URL || ''),
    displayName: String(db.botConfig.displayName || BOT_DISPLAY_NAME || 'NEXIVO HUB Bot'),
    tokenConfigured: db.botConfig.tokenConfigured === true,
    tokenSource: db.botConfig.tokenConfigured === true ? 'secure_server_storage' : 'not_configured',
    tokenMasked: db.botConfig.tokenConfigured === true ? '••••••••••••••••' : ''
  };
}

function publicLicense(l, includeSecret = false) {
  const meta = PLAN_META[normalizePlan(l.plan)];
  const out = {
    id: l.id, key: l.key, plan: l.plan, planLabel: meta.label, status: effectiveStatus(l),
    createdAt: l.createdAt, activatedAt: l.activatedAt, expiresAt: l.expiresAt,
    durationDays: l.durationDays, remainingDays: remainingDays(l), discordUserId: l.discordUserId || null, discordUsername: l.discordUsername || null, guildId: l.guildId || null,
    orderId: l.orderId || null, issuerUserId: l.issuerUserId || null, issuerUsername: l.issuerUsername || null, owner: l.owner === true, bot: l.bot || null
  };
  if (includeSecret) out.botSecret = l.botSecret;
  return out;
}
function publicUser(u) {
  const l = u?.licenseId ? db.licenses.find(x => x.id === u.licenseId) : null;
  const access = accountDashboardAccess(u);
  return {
    id: u.id, username: u.username, email: u.email || null, role: u.role || 'CUSTOMER', plan: u.plan || 'BASIC', planLabel: planLabel(u.plan),
    licenseKey: l?.key || null, licenseStatus: l ? effectiveStatus(l) : 'UNKNOWN',
    expiresAt: l?.expiresAt || null, remainingDays: l ? remainingDays(l) : null,
    features: PLAN_META[normalizePlan(u.plan)].features, license: l ? publicLicense(l, false) : null,
    settings: db.settings[u.id] || {}, wallet: publicWallet(u), discordUserId: u.discordUserId || null, dashboardAccess: access.allowed, authProviders: Object.keys(providerMap(u)).filter(k => /Id$/.test(k)).map(k => k.slice(0,-2))
  };
}
function identity(req) {
  const t = cookie(req, 'nexivo_session');
  if (!t) return { user: null, license: null, reason: 'NO_SESSION' };
  const s = db.sessions.find(x => x.token === t && new Date(x.expiresAt).getTime() > Date.now());
  if (!s) return { user: null, license: null, reason: 'SESSION_EXPIRED' };
  const user = db.users.find(x => x.id === s.userId);
  if (!user) return { user: null, license: null, reason: 'USER_NOT_FOUND' };
  const license = db.licenses.find(x => x.id === user.licenseId);
  if (!license) return { user, license: null, reason: 'LICENSE_NOT_FOUND' };
  return { user, license, reason: effectiveStatus(license) === 'ACTIVE' ? null : effectiveStatus(license) };
}
function featureOK(user, feature) { return Boolean(user && PLAN_META[normalizePlan(user.plan)].features.includes(feature)); }
function activeGate(license, res) {
  const status = effectiveStatus(license);
  if (status === 'EXPIRED') return json(res, 403, { error: '라이선스 기간이 만료되었습니다. 새로운 라이선스 키를 구매해주세요!', code: 'LICENSE_EXPIRED', expiresAt: license.expiresAt });
  if (status === 'SUSPENDED') return json(res, 403, { error: '라이선스가 일시 정지되었습니다.', code: 'LICENSE_SUSPENDED' });
  if (status === 'REVOKED') return json(res, 403, { error: '취소된 라이선스입니다.', code: 'LICENSE_REVOKED' });
  if (status !== 'ACTIVE') return json(res, 403, { error: '활성 라이선스가 필요합니다.', code: 'LICENSE_INACTIVE' });
  return null;
}
function sanitizeProduct(p, ownerId, fallbackId) {
  const stock = Number(p?.stock);
  return {
    id: String(p?.id || fallbackId || rid('prd')).slice(0, 80), ownerId,
    name: String(p?.name || '상품').slice(0, 120), price: Math.max(0, Number(p?.price) || 0),
    stock: Number.isFinite(stock) ? Math.max(-1, Math.floor(stock)) : -1,
    category: String(p?.category || '기본').slice(0, 80),
    description: String(p?.description || '').slice(0, 600),
    features: Array.isArray(p?.features) ? p.features.map(x => String(x).slice(0, 160)).slice(0, 40) : [],
    image_url: String(p?.image_url || p?.imageUrl || '').slice(0, 1000),
    active: p?.active !== false, deliveryType: normalizeDeliveryType(p?.deliveryType), licensePlan: normalizePlan(p?.licensePlan || 'BASIC'), licenseDurationDays: Math.max(1, Math.min(3650, Math.floor(Number(p?.licenseDurationDays) || 30))),
    createdAt: p?.createdAt || now(), updatedAt: p?.updatedAt || now()
  };
}
function sanitizeOrder(o, ownerId) {
  return { ...o, id: String(o?.id || rid('ord')).slice(0, 100), ownerId, user: String(o?.user || '').slice(0, 120), amount: Number(o?.amount || o?.total || 0) || 0, status: String(o?.status || '주문접수').slice(0, 40), updatedAt: o?.updatedAt || now(), createdAt: o?.createdAt || o?.created_at || now() };
}
function normalizeSettings(raw, base = {}) {
  raw = raw && typeof raw === 'object' ? raw : {};
  base = base && typeof base === 'object' ? base : {};
  const pick = (key, legacyKey, fallback = '') => raw[key] !== undefined ? raw[key] : (raw[legacyKey] !== undefined ? raw[legacyKey] : base[key] ?? fallback);
  const pickBool = (key, legacyKey, fallback = true) => {
    const value = raw[key] !== undefined ? raw[key] : (raw[legacyKey] !== undefined ? raw[legacyKey] : base[key]);
    if (value === undefined) return fallback;
    return value === true || value === 'true' || value === 1 || value === '1';
  };
  return {
    bankInfo: String(pick('bankInfo', 'bank_info', STORE_BANK_INFO)).slice(0, 500),
    guildId: String(pick('guildId', 'guild_id')).slice(0, 80),
    orderCategoryId: String(pick('orderCategoryId', 'order_category_id')).slice(0, 80),
    logChannelId: String(pick('logChannelId', 'log_channel_id')).slice(0, 80),
    buyerRoleId: String(pick('buyerRoleId', 'buyer_role_id')).slice(0, 80),
    orderCategoryName: String(pick('orderCategoryName', 'order_category_name')).slice(0, 120),
    stockChannelId: String(pick('stockChannelId', 'stock_channel_id')).slice(0, 80),
    stockMessageId: String(pick('stockMessageId', 'stock_message_id')).slice(0, 80),
    stockSyncEnabled: pickBool('stockSyncEnabled', 'stock_sync_enabled', true),
  };
}
function userSettings(ownerId) {
  return normalizeSettings(db.settings[ownerId]);
}
function botByLicense(l) { return l.bot || null; }
function touchBot(l, info) {
  l.bot = { ...(l.bot || {}), ...info, lastSeenAt: now() };
  const idx = db.bots.findIndex(b => b.licenseId === l.id);
  const record = { licenseId: l.id, userId: l.userId, ...(l.bot || {}) };
  if (idx >= 0) db.bots[idx] = record; else db.bots.unshift(record);
}

function hasActiveLicense(user) {
  if (!user) return null;
  const l = user.licenseId ? db.licenses.find(x => x.id === user.licenseId) : null;
  return l && effectiveStatus(l) === 'ACTIVE' ? l : null;
}
function shopOwnerId() {
  if (db.users.some(u => u.id === OWNER_USER_ID)) return OWNER_USER_ID;
  const owner = db.users.find(u => u.role === 'OWNER');
  return owner?.id || null;
}
function normalizeDeliveryType(v) {
  const t = String(v || 'PLATFORM_LICENSE').toUpperCase();
  return ['PLATFORM_LICENSE', 'LICENSE_KEY'].includes(t) ? t : 'PLATFORM_LICENSE';
}
function deliveryLabel(p) {
  return normalizeDeliveryType(p?.deliveryType) === 'LICENSE_KEY' ? '라이선스 키' : `${planLabel(p?.licensePlan || 'BASIC')} 자동 발급`;
}
function availableLicenseKeyCount(productId) {
  return db.productKeys.filter(k => k.productId === productId && k.status === 'UNUSED').length;
}
function productAvailable(product) {
  if (!product || product.active === false) return false;
  if (normalizeDeliveryType(product.deliveryType) === 'LICENSE_KEY') return availableLicenseKeyCount(product.id) > 0;
  return Number(product.stock) === -1 || Number(product.stock) > 0;
}
function uniqueUsername(base) {
  const raw = String(base || 'user').trim().replace(/[^A-Za-z0-9._-]/g, '').slice(0, 24) || 'user';
  let candidate = raw, n = 1;
  while (db.users.some(u => String(u.username || '').toLowerCase() === candidate.toLowerCase())) candidate = `${raw.slice(0, 20)}${n++}`;
  return candidate;
}
function providerMap(user) {
  return user?.authProviders && typeof user.authProviders === 'object' ? user.authProviders : {};
}
function accountDashboardAccess(user) {
  const l = hasActiveLicense(user);
  return { allowed: Boolean(l), licenseStatus: user?.licenseId ? effectiveStatus(db.licenses.find(x => x.id === user.licenseId) || { status: 'UNKNOWN' }) : 'NONE', license: l ? publicLicense(l, false) : null };
}
function safeRedirectTarget(target) { return target === 'dashboard' ? 'dashboard' : 'shop'; }
function oauthState(provider, target='shop') {
  const state = randomText(24);
  db.oauthStates.push({ state, provider, target: safeRedirectTarget(target), createdAt: now() });
  saveDb();
  return state;
}
async function finishOAuthLogin(req, res, provider, profile, target='shop') {
  const p = providerMap({ authProviders: {} });
  const providerId = String(profile?.id || '').trim();
  const email = String(profile?.email || '').trim().toLowerCase();
  if (!providerId) return text(res, 400, 'OAuth 계정 정보를 확인할 수 없습니다.');
  let u = db.users.find(x => String(providerMap(x)[provider + 'Id'] || '') === providerId);
  if (!u && provider === 'discord' && OWNER_DISCORD_ID && providerId === OWNER_DISCORD_ID) u = db.users.find(x => x.id === OWNER_USER_ID || x.role === 'OWNER');
  if (!u && email) u = db.users.find(x => String(x.email || '').toLowerCase() === email);
  if (!u) {
    const base = provider === 'google' ? String((email.split('@')[0] || profile?.name || 'google')).trim() : String(profile?.username || profile?.global_name || `discord_${providerId.slice(-6)}`);
    u = { id: rid('usr'), username: uniqueUsername(base), passwordHash: null, plan: 'BASIC', role: 'CUSTOMER', licenseId: null, email: email || null, authProviders: {}, createdAt: now() };
    db.users.push(u);
  }
  u.authProviders = { ...providerMap(u), [`${provider}Id`]: providerId };
  if (email) u.email = email;
  u.lastLoginAt = now();
  if (provider === 'discord') {
    u.discordUserId = providerId;
    u.discordUsername = String(profile?.username || profile?.global_name || '').slice(0, 120) || u.discordUsername || null;

    // Link Discord purchases made before the customer created/logged into the web account.
    let linkedOrders = 0;
    for (const order of db.orders) {
      if (String(order.buyerDiscordId || '') === providerId && !order.buyerUserId) {
        order.buyerUserId = u.id;
        order.updatedAt = now();
        linkedOrders++;
      }
    }
    // A PLATFORM_LICENSE purchase made through Discord can be attached to the
    // customer's account on first Discord login, so the Dashboard unlocks automatically.
    if (!hasActiveLicense(u)) {
      const candidate = db.licenses
        .filter(l => String(l.discordUserId || '') === providerId && !l.userId && effectiveStatus(l) === 'ACTIVE')
        .sort((a, b) => new Date(b.activatedAt || b.createdAt || 0) - new Date(a.activatedAt || a.createdAt || 0))[0];
      if (candidate) {
        candidate.userId = u.id;
        u.licenseId = candidate.id;
        u.plan = candidate.plan;
      }
    }
    // A customer may have bought a platform license while using username/password first.
    // On their first Discord login, claim the unbound platform license on the same account.
    const ownLicense = u.licenseId ? db.licenses.find(x => x.id === u.licenseId) : null;
    if (ownLicense && effectiveStatus(ownLicense) === 'ACTIVE' && !ownLicense.discordUserId) ownLicense.discordUserId = providerId;
    if (linkedOrders || u.licenseId || ownLicense?.discordUserId) saveDb();
  }
  if (provider === 'google') u.googleEmail = email || u.googleEmail || null;
  audit(u.username, `${provider.toUpperCase()}_LOGIN`, u.id, 'OAuth 로그인');
  saveDb(); session(res, u);
  const q = new URLSearchParams({ area: safeRedirectTarget(target), oauth: 'success' });
  res.writeHead(302, { Location: `/?${q.toString()}`, 'Cache-Control': 'no-store' });
  res.end();
}
function publicShopProduct(x) {
  const deliveryType = normalizeDeliveryType(x.deliveryType);
  const stock = deliveryType === 'LICENSE_KEY' ? availableLicenseKeyCount(x.id) : Number(x.stock);
  return {
    id: x.id, name: x.name, price: Number(x.price) || 0, category: x.category || '기본', description: x.description || '',
    features: Array.isArray(x.features) ? x.features.slice(0, 20) : [], image_url: x.image_url || '',
    active: x.active !== false, deliveryType, deliveryLabel: deliveryLabel(x), licensePlan: x.licensePlan || 'BASIC',
    licenseDurationDays: Number(x.licenseDurationDays) || 30, stock: Number.isFinite(stock) ? stock : -1,
    unlimited: deliveryType !== 'LICENSE_KEY' && Number(stock) === -1
  };
}
function shopOrderPublic(o, includeKey=false) {
  return {
    id: o.id, productId: o.productId, productName: o.productName, amount: Number(o.amount || 0), quantity: Number(o.quantity || 1),
    status: o.status, createdAt: o.createdAt, updatedAt: o.updatedAt || o.createdAt, deliveredAt: o.deliveredAt || null,
    deliveryType: o.deliveryType || null, deliveryKey: includeKey ? (o.deliveryKey || null) : null,
    paymentInfo: o.paymentInfo || '', buyerUserId: o.buyerUserId || null,
    review: (() => { const r = db.reviews.find(x => x.orderId === o.id); return r ? publicReview(r) : null; })()
  };
}
function publicReview(r) {
  return {
    id: r.id, orderId: r.orderId, productId: r.productId, productName: r.productName,
    rating: Number(r.rating) || 0, content: String(r.content || ''), username: r.username || '구매자',
    discordUserId: r.discordUserId || null, createdAt: r.createdAt, source: r.source || 'WEB'
  };
}
function addReview({ order, buyerUserId, discordUserId, username, rating, content, source='WEB' }) {
  const existing = db.reviews.find(x => x.orderId === order.id);
  if (existing) return { ok: false, error: '이 주문은 이미 후기를 작성했습니다.', review: existing };
  const r = {
    id: rid('rev'), orderId: order.id, ownerId: order.ownerId, productId: order.productId, productName: order.productName,
    buyerUserId: buyerUserId || order.buyerUserId || null, discordUserId: discordUserId || order.buyerDiscordId || null,
    username: String(username || order.user || '구매자').slice(0, 120), rating: Math.max(1, Math.min(5, Math.floor(Number(rating) || 0))),
    content: String(content || '').trim().slice(0, 1000), source, createdAt: now()
  };
  db.reviews.unshift(r);
  db.reviews = db.reviews.slice(0, 10000);
  pushEvent('review.created', {
    ownerId: order.ownerId, guildId: order.guildId || null, review: publicReview(r),
    order: { id: order.id, productId: order.productId, productName: order.productName, buyerDiscordId: order.buyerDiscordId || r.discordUserId || null }
  });
  audit(username || 'SYSTEM', 'REVIEW_CREATE', order.id, `${order.productName} / ${r.rating}점`);
  saveDb();
  return { ok: true, review: r };
}

function createShopOrder({ sellerId, buyerUserId=null, buyerDiscordId=null, buyerName='', product, source='WEB', guildId=null }) {
  const id = rid('shop');
  return {
    id, ownerId: sellerId, buyerUserId, buyerDiscordId: buyerDiscordId || null, guildId: guildId || null, user: String(buyerName || '고객').slice(0, 120),
    productId: product.id, productName: product.name, amount: Number(product.price) || 0, total: Number(product.price) || 0, quantity: 1,
    status: '입금대기', source, deliveryType: normalizeDeliveryType(product.deliveryType), createdAt: now(), updatedAt: now(), deliveredAt: null,
    deliveryKey: null, deliveryLicenseId: null, paymentInfo: String(userSettings(sellerId).bankInfo || STORE_BANK_INFO || '판매자가 설정한 결제 안내가 없습니다.').slice(0, 500)
  };
}
function fulfillShopOrder(order, actor='SYSTEM') {
  if (!order) return { ok: false, error: '주문을 찾을 수 없습니다.' };
  if (order.status === '완료' && order.deliveryKey) return { ok: true, key: order.deliveryKey };
  const seller = db.users.find(u => u.id === order.ownerId);
  const product = db.products.find(p => p.id === order.productId && p.ownerId === order.ownerId);
  if (!seller || !product) return { ok: false, error: '상품을 찾을 수 없습니다.' };
  if (!productAvailable(product) && order.status !== '완료') return { ok: false, error: '상품 지급 재고가 없습니다.' };
  const deliveryType = normalizeDeliveryType(product.deliveryType);
  let key = '';
  if (deliveryType === 'LICENSE_KEY') {
    const row = db.productKeys.find(k => k.productId === product.id && k.status === 'UNUSED');
    if (!row) return { ok: false, error: '사용 가능한 라이선스 키 재고가 없습니다.' };
    row.status = 'USED'; row.orderId = order.id; row.buyerUserId = order.buyerUserId || null; row.buyerDiscordId = order.buyerDiscordId || null; row.usedAt = now();
    key = String(row.key);
    if (Number(product.stock) >= 0) product.stock = Math.max(0, Number(product.stock) - 1);
  } else {
    let buyer = order.buyerUserId ? db.users.find(u => u.id === order.buyerUserId) : null;
    if (!buyer && order.buyerDiscordId) buyer = createDiscordShadowUser(order.buyerDiscordId, order.user || 'Discord 구매자');
    if (buyer && order.buyerDiscordId) { buyer.discordUserId = String(order.buyerDiscordId); buyer.authProviders = { ...(buyer.authProviders || {}), discordId: String(order.buyerDiscordId) }; }
    const l = createLicense(product.licensePlan || 'BASIC', { actor, discordUserId: order.buyerDiscordId || buyer?.discordUserId || null, discordUsername: order.user || buyer?.username || null, guildId: order.guildId || null, orderId: order.id, durationDays: Number(product.licenseDurationDays) || 30, issuerUserId: seller.id, issuerUsername: seller.username });
    if (buyer && !hasActiveLicense(buyer)) {
      l.userId = buyer.id; l.status = 'ACTIVE'; l.activatedAt = now(); l.expiresAt = expiresFor(l.activatedAt, l.durationDays); buyer.licenseId = l.id; buyer.plan = l.plan;
      if (order.guildId) bindLicenseToGuild(l, buyer, order.guildId);
    }
    key = l.key; order.deliveryLicenseId = l.id;
    if (Number(product.stock) > 0) product.stock = Math.max(0, Number(product.stock) - 1);
  }
  order.deliveryKey = key; order.status = '완료'; order.deliveredAt = now(); order.updatedAt = now();
  pushEvent('shop.order.fulfilled', { ownerId: order.ownerId, buyerUserId: order.buyerUserId, orderId: order.id, productId: order.productId });
  audit(actor, 'SHOP_ORDER_FULFILL', order.id, `${order.productName} / ${order.deliveryType}`);
  return { ok: true, key };
}

function botContext(req) {
  const key = String(req.headers['x-nexivo-license'] || '').trim().toUpperCase();
  const l = db.licenses.find(x => x.key.toUpperCase() === key);
  if (!l || !botOK(req, l)) return { ok: false, status: 401, error: '봇 연결 인증 정보가 올바르지 않습니다.' };
  const st = effectiveStatus(l);
  if (st !== 'ACTIVE') return { ok: false, status: 403, error: st === 'EXPIRED' ? '라이선스 기간이 만료되었습니다. 새로운 라이선스 키를 구매해주세요!' : `라이선스 상태: ${st}`, code: st === 'EXPIRED' ? 'LICENSE_EXPIRED' : `LICENSE_${st}` };
  const user = db.users.find(x => x.id === l.userId);
  if (!user) return { ok: false, status: 409, error: '라이선스에 연결된 계정이 없습니다.' };
  return { ok: true, license: l, user };
}


async function api(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const p = url.pathname; const method = req.method;
  if (p === '/api/health') return json(res, 200, { ok: true, service: 'NEXIVO HUB', at: now() });

  // OAuth login
  if (p === '/auth/discord' && method === 'GET') {
    const redirect = DISCORD_AUTH_REDIRECT_URI || (DISCORD_CLIENT_ID ? `http://${req.headers.host || 'localhost'}/auth/discord/callback` : '');
    if (!DISCORD_CLIENT_ID || !DISCORD_CLIENT_SECRET || !redirect) return text(res, 503, 'Discord 로그인 설정이 완료되지 않았습니다.');
    const state = oauthState('discord', url.searchParams.get('return') || 'shop');
    const params = new URLSearchParams({ client_id: DISCORD_CLIENT_ID, redirect_uri: redirect, response_type: 'code', scope: 'identify email', state });
    res.writeHead(302, { Location: `https://discord.com/oauth2/authorize?${params}` }); return res.end();
  }
  if (p === '/auth/discord/callback' && method === 'GET') {
    const state = String(url.searchParams.get('state') || ''); const code = String(url.searchParams.get('code') || '');
    const row = db.oauthStates.find(x => x.state === state && x.provider === 'discord'); db.oauthStates = db.oauthStates.filter(x => x.state !== state);
    if (!row || !code) return text(res, 400, 'Discord 로그인에 실패했습니다. 다시 시도해주세요.');
    try {
      const redirect = DISCORD_AUTH_REDIRECT_URI || `http://${req.headers.host || 'localhost'}/auth/discord/callback`;
      const body = new URLSearchParams({ client_id: DISCORD_CLIENT_ID, client_secret: DISCORD_CLIENT_SECRET, grant_type: 'authorization_code', code, redirect_uri: redirect });
      const tokenResp = await fetch('https://discord.com/api/oauth2/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body });
      if (!tokenResp.ok) throw new Error(`Discord token exchange ${tokenResp.status}`);
      const tokenJson = await tokenResp.json();
      const meResp = await fetch('https://discord.com/api/users/@me', { headers: { Authorization: `Bearer ${tokenJson.access_token}` } });
      if (!meResp.ok) throw new Error(`Discord identity ${meResp.status}`);
      const me = await meResp.json();
      return finishOAuthLogin(req, res, 'discord', me, row.target);
    } catch (err) { console.error('[NEXIVO HUB] Discord OAuth:', err); return text(res, 502, 'Discord 로그인 처리에 실패했습니다.'); }
  }
  if (p === '/auth/google' && method === 'GET') {
    const redirect = GOOGLE_AUTH_REDIRECT_URI || `http://${req.headers.host || 'localhost'}/auth/google/callback`;
    if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET) return text(res, 503, 'Google 로그인 설정이 완료되지 않았습니다.');
    const state = oauthState('google', url.searchParams.get('return') || 'shop');
    const params = new URLSearchParams({ client_id: GOOGLE_CLIENT_ID, redirect_uri: redirect, response_type: 'code', scope: 'openid email profile', state, access_type: 'online', prompt: 'select_account' });
    res.writeHead(302, { Location: `https://accounts.google.com/o/oauth2/v2/auth?${params}` }); return res.end();
  }
  if (p === '/auth/google/callback' && method === 'GET') {
    const state = String(url.searchParams.get('state') || ''); const code = String(url.searchParams.get('code') || '');
    const row = db.oauthStates.find(x => x.state === state && x.provider === 'google'); db.oauthStates = db.oauthStates.filter(x => x.state !== state);
    if (!row || !code) return text(res, 400, 'Google 로그인에 실패했습니다. 다시 시도해주세요.');
    try {
      const redirect = GOOGLE_AUTH_REDIRECT_URI || `http://${req.headers.host || 'localhost'}/auth/google/callback`;
      const body = new URLSearchParams({ client_id: GOOGLE_CLIENT_ID, client_secret: GOOGLE_CLIENT_SECRET, code, grant_type: 'authorization_code', redirect_uri: redirect });
      const tokenResp = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body });
      if (!tokenResp.ok) throw new Error(`Google token exchange ${tokenResp.status}`);
      const tokenJson = await tokenResp.json();
      const meResp = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', { headers: { Authorization: `Bearer ${tokenJson.access_token}` } });
      if (!meResp.ok) throw new Error(`Google identity ${meResp.status}`);
      const me = await meResp.json();
      return finishOAuthLogin(req, res, 'google', { ...me, id: me.sub, name: me.name || me.email }, row.target);
    } catch (err) { console.error('[NEXIVO HUB] Google OAuth:', err); return text(res, 502, 'Google 로그인 처리에 실패했습니다.'); }
  }

  // Web Discord verification. This records the IP of the browser request for defensive
  // security/audit purposes only; Discord itself does not expose member IP addresses to bots.
  if (p === '/verify' && method === 'GET') {
    if (!DISCORD_CLIENT_ID || !DISCORD_CLIENT_SECRET || !DISCORD_REDIRECT_URI) {
      return text(res, 503, 'NEXIVO HUB 인증 설정이 아직 완료되지 않았습니다.');
    }
    const state = randomText(24);
    const guildId = String(url.searchParams.get('guild') || '').trim();
    db.verifyStates.push({ state, guildId, createdAt: now(), ip: clientIp(req), userAgent: String(req.headers['user-agent'] || '').slice(0, 500) });
    saveDb();
    const params = new URLSearchParams({ client_id: DISCORD_CLIENT_ID, redirect_uri: DISCORD_REDIRECT_URI, response_type: 'code', scope: 'identify', state });
    res.writeHead(302, { Location: `https://discord.com/oauth2/authorize?${params.toString()}` }); return res.end();
  }
  if (p === '/verify/callback' && method === 'GET') {
    const state = String(url.searchParams.get('state') || '');
    const code = String(url.searchParams.get('code') || '');
    const fail = url.searchParams.get('error');
    const stateRow = db.verifyStates.find(x => x.state === state);
    db.verifyStates = db.verifyStates.filter(x => x.state !== state);
    if (fail || !stateRow || !code) { saveDb(); return text(res, 400, 'Discord 인증에 실패했습니다. 다시 시도해주세요.'); }
    try {
      const body = new URLSearchParams({ client_id: DISCORD_CLIENT_ID, client_secret: DISCORD_CLIENT_SECRET, grant_type: 'authorization_code', code, redirect_uri: DISCORD_REDIRECT_URI });
      const tokenResp = await fetch('https://discord.com/api/oauth2/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body });
      if (!tokenResp.ok) throw new Error(`token exchange ${tokenResp.status}`);
      const tokenJson = await tokenResp.json();
      const meResp = await fetch('https://discord.com/api/users/@me', { headers: { Authorization: `Bearer ${tokenJson.access_token}` } });
      if (!meResp.ok) throw new Error(`identity ${meResp.status}`);
      const me = await meResp.json();
      const log = recordSecurityLog({ ip: stateRow.ip || clientIp(req), userAgent: stateRow.userAgent || req.headers['user-agent'], discordUserId: me.id, discordUsername: me.username, guildId: stateRow.guildId, action: 'DISCORD_WEB_VERIFY', result: 'success' });
      if (stateRow.guildId) pushEvent('verification.completed', { guildId: stateRow.guildId, discordUserId: String(me.id), securityLogId: log.id, at: log.at });
      saveDb();
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      return res.end(`<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>NEXIVO HUB 인증 완료</title><style>body{margin:0;background:#050b16;color:#eef6ff;font-family:system-ui,-apple-system,Segoe UI,sans-serif;display:grid;place-items:center;min-height:100vh}.card{width:min(520px,calc(100% - 40px));padding:36px;border:1px solid #1b5d8f;border-radius:24px;background:#081321;box-shadow:0 18px 60px rgba(0,0,0,.45);text-align:center}.ok{font-size:52px}.muted{color:#7d9ab3;line-height:1.6}.pill{display:inline-block;margin-top:18px;padding:9px 14px;border-radius:999px;background:#0b3350;color:#8dd7ff;font-size:13px}</style></head><body><div class="card"><div class="ok">✓</div><h1>Discord 인증 완료</h1><p>인증이 정상적으로 확인되었습니다.</p><p class="muted">서버로 돌아가면 NEXIVO HUB 인증 역할이 자동으로 적용될 수 있습니다.</p><div class="pill">보안 기록 저장됨 · ${IP_LOG_RETENTION_DAYS}일 보관</div></div></body></html>`);
    } catch (e) {
      recordSecurityLog({ ip: stateRow.ip || clientIp(req), userAgent: stateRow.userAgent || req.headers['user-agent'], guildId: stateRow.guildId, action: 'DISCORD_WEB_VERIFY', result: 'failed' }); saveDb();
      return text(res, 502, 'Discord 인증 처리 중 오류가 발생했습니다. 잠시 후 다시 시도해주세요.');
    }
  }

  // Shared Discord bot worker API. The worker is trusted and the Discord bot token is
  // intentionally never accepted from the browser or returned by any response.
  const workerAuth = String(req.headers['x-nexivo-worker-secret'] || '').trim();
  const workerOK = () => {
    if (!BOT_WORKER_SECRET || !workerAuth) return false;
    const a = Buffer.from(workerAuth, 'utf8');
    const b = Buffer.from(BOT_WORKER_SECRET, 'utf8');
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  };
  if (p === '/api/bot/secret-token' && method === 'GET') {
    if (!workerOK()) return json(res, 401, { error: '봇 워커 인증이 필요합니다.' });
    const token = decryptBotToken(db.botConfig.encryptedToken);
    if (!token) return json(res, 404, { error: '저장된 Discord Bot Token이 없습니다.' });
    return json(res, 200, { ok: true, token });
  }

  if (p === '/api/bot/security-logs' && method === 'GET') {
    if (!workerOK()) return json(res, 401, { error: '봇 워커 인증이 필요합니다.' });
    const gid = String(url.searchParams.get('guildId') || '').trim();
    const logs = db.securityLogs.filter(x => !gid || String(x.guildId || '') === gid).slice(0, 200);
    return json(res, 200, { logs, retentionDays: IP_LOG_RETENTION_DAYS });
  }
  if (p === '/api/bot/resolve-tenant' && method === 'POST') {
    if (!workerOK()) return json(res, 401, { error: '봇 워커 인증이 필요합니다.' });
    const b = await parseBody(req);
    const guildId = String(b.guildId || '').trim();
    const discordUserId = String(b.discordUserId || '').trim();
    const discordUsername = String(b.discordUsername || 'Discord 사용자').trim();
    if (!/^\d{15,25}$/.test(guildId) || !/^\d{15,25}$/.test(discordUserId)) return json(res, 400, { error: 'Discord 사용자/서버 ID가 올바르지 않습니다.' });
    let u = db.users.find(x => String(x.discordUserId || '') === discordUserId || String(x.authProviders?.discordId || '') === discordUserId);
    if (!u) return json(res, 404, { error: '이 Discord 계정에 연결된 활성 라이선스가 없습니다. 상점에서 라이선스를 구매해주세요.', code: 'LICENSE_REQUIRED' });
    const l = hasActiveLicense(u);
    if (!l) return json(res, 404, { error: '이 Discord 계정에 연결된 활성 라이선스가 없습니다. 상점에서 라이선스를 구매해주세요.', code: 'LICENSE_REQUIRED' });
    if (l.discordUserId && String(l.discordUserId) !== discordUserId) return json(res, 403, { error: '이 라이선스는 다른 Discord 계정에 연결되어 있습니다.', code: 'DISCORD_MISMATCH' });
    if (l.guildId && String(l.guildId) !== guildId) return json(res, 409, { error: '이 라이선스는 다른 Discord 서버에 이미 연결되어 있습니다.', code: 'GUILD_MISMATCH', guildId: l.guildId });
    u.discordUserId = discordUserId; u.authProviders = { ...(u.authProviders || {}), discordId: discordUserId };
    if (!l.discordUserId) l.discordUserId = discordUserId;
    if (!l.discordUsername) l.discordUsername = discordUsername;
    bindLicenseToGuild(l, u, guildId);
    saveDb();
    const st = userSettings(u.id);
    return json(res, 200, { ok: true, tenant: { userId:u.id, username:u.username, role:u.role || 'CUSTOMER', licenseId:l.id, discordUserId:l.discordUserId, plan:l.plan, planLabel:planLabel(l.plan), botFamily:planFamily(l.plan), features:PLAN_META[normalizePlan(l.plan)].features, guildId:st.guildId, settings:st, products:db.products.filter(x=>x.ownerId===u.id), orders:db.orders.filter(x=>x.ownerId===u.id).sort((a,b)=>String(b.createdAt).localeCompare(String(a.createdAt))) } });
  }
  if (p === '/api/bot/wallet' && method === 'GET') {
    if (!workerOK()) return json(res, 401, { error: '봇 워커 인증이 필요합니다.' });
    const discordUserId = String(url.searchParams.get('discordUserId') || '').trim();
    if (!discordUserId) return json(res, 400, { error: 'Discord User ID가 필요합니다.' });
    const u = db.users.find(x => String(x.discordUserId || '') === discordUserId || String(x.authProviders?.discordId || '') === discordUserId);
    if (!u) return json(res, 404, { error: '웹사이트 계정이 없습니다.', wallet: null });
    return json(res, 200, { ok:true, wallet:publicWallet(u), username:u.username });
  }
  if (p === '/api/bot/wallet/topup-request' && method === 'POST') {
    if (!workerOK()) return json(res, 401, { error: '봇 워커 인증이 필요합니다.' });
    const b = await parseBody(req);
    const discordUserId = String(b.discordUserId || '').trim();
    const discordUsername = String(b.discordUsername || 'Discord 사용자').trim();
    const guildId = String(b.guildId || '').trim();
    const amount = Math.floor(Number(b.amount) || 0);
    if (!/^\d{15,25}$/.test(discordUserId) || !/^\d{15,25}$/.test(guildId)) return json(res, 400, { error: 'Discord ID가 올바르지 않습니다.' });
    if (amount < 1000 || amount > 10000000) return json(res, 400, { error: '충전 금액은 1,000원 이상 10,000,000원 이하로 입력해주세요.' });
    const user = createDiscordShadowUser(discordUserId, discordUsername);
    if (!user) return json(res, 400, { error: '웹사이트 계정을 생성할 수 없습니다.' });
    const existing = db.topupRequests.find(x => x.discordUserId === discordUserId && x.status === '대기');
    if (existing) return json(res, 409, { error: `이미 대기 중인 충전 신청이 있습니다. 신청번호: ${existing.id}`, topup: existing });
    const row = { id: rid('top'), userId: user.id, username: user.username, discordUserId, discordUsername, guildId, amount, method: 'BANK_TRANSFER', status: '대기', createdAt: now(), paymentInfo: String(userSettings(shopOwnerId()).bankInfo || STORE_BANK_INFO || '판매자 계좌 정보가 설정되지 않았습니다.').slice(0,500) };
    db.topupRequests.unshift(row);
    pushEvent('wallet.topup.requested', { ownerId: shopOwnerId(), topupId: row.id, discordUserId, guildId, amount });
    audit(discordUsername, 'WALLET_TOPUP_REQUEST', row.id, `${amount}원`);
    saveDb();
    return json(res, 200, { ok: true, topup: row, wallet: publicWallet(user) });
  }
  if (p === '/api/bot/wallet/topups/pending' && method === 'GET') {
    if (!workerOK()) return json(res, 401, { error: '봇 워커 인증이 필요합니다.' });
    return json(res, 200, { topups: db.topupRequests.filter(x => x.status === '대기').slice(0, 200) });
  }
  const botTopupMatch = p.match(/^\/api\/bot\/wallet\/topups\/([^/]+)\/(approve|reject)$/);
  if (botTopupMatch && method === 'POST') {
    if (!workerOK()) return json(res, 401, { error: '봇 워커 인증이 필요합니다.' });
    const row = db.topupRequests.find(x => x.id === botTopupMatch[1]);
    if (!row) return json(res, 404, { error: '충전 신청을 찾을 수 없습니다.' });
    if (row.status !== '대기') return json(res, 409, { error: `이미 처리된 충전 신청입니다. 상태: ${row.status}`, topup: row });
    const b = await parseBody(req);
    if (botTopupMatch[2] === 'approve') {
      const user = db.users.find(x => x.id === row.userId);
      if (!user) return json(res, 404, { error: '충전 대상 계정을 찾을 수 없습니다.' });
      if (!creditWallet(user, row.amount, `계좌이체 충전 승인: ${row.id}`, { orderId: row.id })) return json(res, 409, { error: '지갑 반영에 실패했습니다.' });
      row.status = '완료'; row.approvedAt = now(); row.approvedBy = String(b.approvedBy || 'NEXIVO OWNER');
      pushEvent('wallet.topup.approved', { ownerId: shopOwnerId(), topupId: row.id, userId: row.userId, discordUserId: row.discordUserId, guildId: row.guildId, amount: row.amount });
      audit(row.username || 'SYSTEM', 'WALLET_TOPUP_APPROVE', row.id, `${row.amount}원`);
      saveDb();
      return json(res, 200, { ok: true, topup: row, wallet: publicWallet(user) });
    }
    row.status = '거절'; row.rejectedAt = now(); row.rejectedBy = String(b.approvedBy || 'NEXIVO OWNER');
    pushEvent('wallet.topup.rejected', { ownerId: shopOwnerId(), topupId: row.id, discordUserId: row.discordUserId, guildId: row.guildId, amount: row.amount });
    audit(row.username || 'SYSTEM', 'WALLET_TOPUP_REJECT', row.id, `${row.amount}원`);
    saveDb();
    return json(res, 200, { ok: true, topup: row });
  }
  if (p === '/api/bot/reviews' && method === 'POST') {
    if (!workerOK()) return json(res, 401, { error: '봇 워커 인증이 필요합니다.' });
    const b = await parseBody(req);
    const orderId = String(b.orderId || '').trim();
    const discordUserId = String(b.discordUserId || '').trim();
    const order = db.orders.find(x => x.id === orderId && x.status === '완료' && String(x.buyerDiscordId || '') === discordUserId);
    if (!order) return json(res, 404, { error: '후기를 작성할 구매완료 주문을 찾을 수 없습니다.' });
    const result = addReview({ order, buyerUserId: order.buyerUserId, discordUserId, username: String(b.discordUsername || order.user || 'Discord 구매자'), rating: b.rating, content: b.content, source: 'DISCORD' });
    if (!result.ok) return json(res, 409, { error: result.error });
    return json(res, 200, { ok: true, review: publicReview(result.review) });
  }

  if (p === '/api/bot/wallet/purchase' && method === 'POST') {
    if (!workerOK()) return json(res, 401, { error: '봇 워커 인증이 필요합니다.' });
    const b = await parseBody(req);
    const guildId = String(b.guildId || '').trim(); const productId = String(b.productId || '').trim(); const discordUserId = String(b.discordUserId || '').trim(); const discordUsername = String(b.discordUsername || 'Discord 구매자').trim();
    const tenant = db.licenses.map(l => ({ l, u: db.users.find(x => x.id === l.userId) })).find(x => x.u && userSettings(x.u.id).guildId === guildId && effectiveStatus(x.l) === 'ACTIVE');
    if (!tenant) return json(res, 404, { error: '활성 자판기 테넌트를 찾을 수 없습니다.' });
    const product = db.products.find(x => x.ownerId === tenant.u.id && x.id === productId && x.active !== false);
    if (!product) return json(res, 404, { error: '상품을 찾을 수 없습니다.' });
    if (!productAvailable(product)) return json(res, 409, { error: '현재 구매 가능한 재고가 없습니다.' });
    const buyer = createDiscordShadowUser(discordUserId, discordUsername);
    if (!buyer) return json(res, 400, { error: 'Discord 계정을 확인할 수 없습니다.' });
    const total = Math.max(0, Math.floor(Number(product.price) || 0));
    ensureWallet(buyer);
    if (Number(buyer.walletBalance || 0) < total) {
      const auto = await maybeAutoTopup(buyer, `${product.name} 구매 전 자동충전`);
      if (!auto.ok || Number(buyer.walletBalance || 0) < total) return json(res, 402, { error: auto.error || `잔액이 부족합니다. 현재 ${Number(buyer.walletBalance||0).toLocaleString()}원`, wallet:publicWallet(buyer), code:'INSUFFICIENT_WALLET' });
    }
    if (!debitWallet(buyer, total, `Discord 상품 구매: ${product.name}`, {})) return json(res, 409, { error: '잔액 차감에 실패했습니다.' });
    const order = createShopOrder({ sellerId: tenant.u.id, buyerUserId: buyer.id, buyerDiscordId: discordUserId, buyerName: discordUsername, product, source: 'DISCORD', guildId });
    order.status = '결제완료';
    const result = fulfillShopOrder(order, 'DISCORD_BOT');
    if (!result.ok) { creditWallet(buyer, total, `구매 실패 환불: ${product.name}`, {}); return json(res, 409, { error: result.error }); }
    db.orders.unshift(order); saveDb(); requestBotSync(tenant.u.id, 'shop_purchase');
    const auto = await maybeAutoTopup(buyer, `상품 구매 후 잔액 기준 충전: ${product.name}`);
    return json(res, 200, { ok:true, order:shopOrderPublic(order,true), licenseKey:result.key, wallet:publicWallet(buyer), autoTopup:auto });
  }

  if (p === '/api/bot/tenants' && method === 'GET') {
    if (!workerOK()) return json(res, 401, { error: '봇 워커 인증이 필요합니다.' });
    const tenants = db.licenses
      .filter(l => effectiveStatus(l) === 'ACTIVE' && l.userId)
      .map(l => {
        const u = db.users.find(x => x.id === l.userId);
        if (!u) return null;
        const st = userSettings(u.id);
        if (!st.guildId) return null;
        return {
          userId: u.id, username: u.username, role: u.role || 'CUSTOMER',
          licenseId: l.id, discordUserId: l.discordUserId || null, plan: l.plan, planLabel: planLabel(l.plan),
          botFamily: planFamily(l.plan), features: PLAN_META[normalizePlan(l.plan)].features,
          guildId: st.guildId, stockChannelId: st.stockChannelId, stockMessageId: st.stockMessageId,
          stockSyncEnabled: st.stockSyncEnabled !== false, settings: st,
          products: db.products.filter(x => x.ownerId === u.id),
          orders: db.orders.filter(x => x.ownerId === u.id).sort((a,b) => String(b.createdAt).localeCompare(String(a.createdAt)))
        };
      }).filter(Boolean);
    return json(res, 200, { at: now(), tenants });
  }
  if (p === '/api/bot/heartbeat' && method === 'POST') {
    if (!workerOK()) return json(res, 401, { error: '봇 워커 인증이 필요합니다.' });
    const b = await parseBody(req);
    const guildId = String(b.guildId || '').trim();
    const tenant = db.licenses.map(l => ({ l, u: db.users.find(x => x.id === l.userId) })).find(x => x.u && userSettings(x.u.id).guildId === guildId && effectiveStatus(x.l) === 'ACTIVE');
    if (!tenant) return json(res, 404, { error: '연결된 라이선스 테넌트를 찾을 수 없습니다.' });
    touchBot(tenant.l, {
      status: 'CONNECTED', guildId, botUserId: b.botUserId || tenant.l.bot?.botUserId || null,
      botUsername: b.botUsername || tenant.l.bot?.botUsername || null,
      workerSeenAt: now(), stockSyncError: b.stockSyncError || null, stockSyncedAt: b.stockSyncedAt || tenant.l.bot?.stockSyncedAt || null, stockMessageId: b.stockMessageId || tenant.l.bot?.stockMessageId || null
    });
    if (b.tokenConfigured === true) { db.botConfig.tokenConfigured = true; db.botConfig.tokenLastVerifiedAt = now(); }
    if (b.stockMessageId || b.stockSyncedAt) {
      const st = userSettings(tenant.u.id);
      db.settings[tenant.u.id] = normalizeSettings({ ...st, stockMessageId: b.stockMessageId || st.stockMessageId }, st);
    }
    saveDb();
    return json(res, 200, { ok: true, licenseId: tenant.l.id, ownerId: tenant.u.id, bot: tenant.l.bot });
  }
  if (p === '/api/bot/stream' && method === 'GET' && workerOK()) {
    res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache, no-transform', 'Connection': 'keep-alive', 'X-Accel-Buffering': 'no' });
    const tenants = db.licenses
      .filter(l => effectiveStatus(l) === 'ACTIVE' && l.userId)
      .map(l => {
        const u = db.users.find(x => x.id === l.userId);
        if (!u) return null;
        const st = userSettings(u.id);
        if (!st.guildId) return null;
        return { ownerId: u.id, licenseId: l.id, guildId: st.guildId, plan: l.plan, features: PLAN_META[normalizePlan(l.plan)].features, settings: st, products: db.products.filter(x => x.ownerId === u.id) };
      }).filter(Boolean);
    res.write(`event: ready\ndata: ${JSON.stringify({ ok: true, at: now(), tenants })}\n\n`);
    const client = { res, kind: 'worker' };
    sseClients.add(client);
    const heartbeat = setInterval(() => { try { res.write(`: worker-heartbeat ${Date.now()}\n\n`); } catch {} }, 25000);
    req.on('close', () => { clearInterval(heartbeat); sseClients.delete(client); });
    return;
  }

  // Auth
  if (p === '/api/auth/providers' && method === 'GET') {
    return json(res, 200, { discord: Boolean(DISCORD_CLIENT_ID && DISCORD_CLIENT_SECRET && (DISCORD_AUTH_REDIRECT_URI || req.headers.host)), google: Boolean(GOOGLE_CLIENT_ID && GOOGLE_CLIENT_SECRET) });
  }
  if (p === '/api/auth/register' && method === 'POST') {
    const b = await parseBody(req); const username = String(b.username || '').trim(); const password = String(b.password || ''); const email = String(b.email || '').trim().toLowerCase();
    if (!/^[A-Za-z0-9._-]{3,32}$/.test(username) || password.length < 6) return json(res, 400, { error: '아이디는 3~32자의 영문/숫자/._- 조합, 비밀번호는 6자 이상이어야 합니다.' });
    if (username.toLowerCase() === OPERATOR_USER.toLowerCase()) return json(res, 409, { error: '사용할 수 없는 아이디입니다.' });
    if (db.users.some(u => String(u.username || '').toLowerCase() === username.toLowerCase())) return json(res, 409, { error: '이미 사용 중인 아이디입니다.' });
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return json(res, 400, { error: '이메일 형식이 올바르지 않습니다.' });
    if (email && db.users.some(u => String(u.email || '').toLowerCase() === email)) return json(res, 409, { error: '이미 사용 중인 이메일입니다.' });
    const u = { id: rid('usr'), username, passwordHash: hashPassword(password), plan: 'BASIC', role: 'CUSTOMER', licenseId: null, email: email || null, authProviders: {}, createdAt: now(), walletBalance: 0, autoTopup: { enabled:false, threshold:5000, amount:10000, provider:null, configured:false } };
    db.users.push(u); saveDb(); session(res, u); return json(res, 200, { ok: true, user: publicUser(u) });
  }
  if (p === '/api/auth/activate' && method === 'POST') {
    const b = await parseBody(req); const username = String(b.username || '').trim(); const password = String(b.password || ''); const key = String(b.licenseKey || '').trim().toUpperCase();
    const current = identity(req).user;
    if (!key) return json(res, 400, { error: '라이선스 키를 입력해주세요.' });
    const l = db.licenses.find(x => x.key.toUpperCase() === key);
    if (!l) return json(res, 400, { error: '존재하지 않는 라이선스 키입니다.' });
    if (effectiveStatus(l) === 'EXPIRED') return json(res, 400, { error: '이 라이선스는 이미 만료되었습니다. 새로운 라이선스 키를 구매해주세요!', code: 'LICENSE_EXPIRED' });
    if (l.status !== 'UNUSED') return json(res, 400, { error: '이미 활성화되었거나 사용할 수 없는 라이선스입니다.' });
    let u = current;
    if (!u) {
      if (!/^[A-Za-z0-9._-]{3,32}$/.test(username) || password.length < 6) return json(res, 400, { error: '아이디(3~32자), 비밀번호(6자 이상), 라이선스 키를 입력해주세요.' });
      if (db.users.some(x => String(x.username || '').toLowerCase() === username.toLowerCase())) return json(res, 409, { error: '이미 사용 중인 아이디입니다.' });
      u = { id: rid('usr'), username, passwordHash: hashPassword(password), plan: l.plan, role: 'CUSTOMER', licenseId: l.id, createdAt: now(), authProviders: {} };
      db.users.push(u);
    } else {
      if (u.role !== 'OWNER' && hasActiveLicense(u)) return json(res, 409, { error: '이 계정에는 이미 활성 라이선스가 연결되어 있습니다.' });
      u.licenseId = l.id; u.plan = l.plan;
    }
    l.userId = u.id; l.status = 'ACTIVE'; l.activatedAt = now(); l.expiresAt = expiresFor(l.activatedAt, l.durationDays); l.bot = { status: 'DISCONNECTED' };
    pushEvent('license.activated', { ownerId: u.id, licenseId: l.id, plan: l.plan }); audit(u.username, 'LICENSE_ACTIVATE', l.id, l.key); saveDb(); session(res, u);
    return json(res, 200, { ok: true, user: publicUser(u) });
  }
  if (p === '/api/auth/link-license' && method === 'POST') {
    const idn = identity(req); if (!idn.user) return json(res, 401, { error: '로그인이 필요합니다.' });
    const b = await parseBody(req); const key = String(b.licenseKey || '').trim().toUpperCase(); if (!key) return json(res, 400, { error: '라이선스 키를 입력해주세요.' });
    if (idn.user.role !== 'OWNER' && hasActiveLicense(idn.user)) return json(res, 409, { error: '이미 활성 라이선스가 연결되어 있습니다.' });
    const l = db.licenses.find(x => x.key.toUpperCase() === key); if (!l) return json(res, 404, { error: '존재하지 않는 라이선스 키입니다.' });
    if (l.status !== 'UNUSED') return json(res, 400, { error: '이미 활성화되었거나 사용할 수 없는 라이선스입니다.' });
    l.userId = idn.user.id; l.status = 'ACTIVE'; l.activatedAt = now(); l.expiresAt = expiresFor(l.activatedAt, l.durationDays); l.bot = { status: 'DISCONNECTED' }; idn.user.licenseId = l.id; idn.user.plan = l.plan;
    pushEvent('license.activated', { ownerId: idn.user.id, licenseId: l.id, plan: l.plan }); audit(idn.user.username, 'LICENSE_LINK', l.id, l.key); saveDb();
    return json(res, 200, { ok: true, user: publicUser(idn.user) });
  }
  if (p === '/api/auth/login' && method === 'POST') {
    const b = await parseBody(req); const username = String(b.username || '').trim(); const password = String(b.password || ''); const key = String(b.licenseKey || '').trim().toUpperCase();
    if (OPERATOR_PASSWORD && username.toLowerCase() === OPERATOR_USER.toLowerCase() && password === OPERATOR_PASSWORD) {
      ensureOwnerAccount(); const owner = db.users.find(x => x.id === OWNER_USER_ID); const ownerLicense = owner ? db.licenses.find(x => x.id === owner.licenseId && x.owner === true) : null;
      if (!ownerLicense) return json(res, 503, { error: '오너 보안 라이선스를 생성하지 못했습니다.' });
      const g = activeGate(ownerLicense, res); if (g) return; session(res, owner); return json(res, 200, { ok: true, user: publicUser(owner) });
    }
    const u = db.users.find(x => String(x.username || '').toLowerCase() === username.toLowerCase() || (String(x.email || '').toLowerCase() === username.toLowerCase() && username.includes('@')));
    if (!u || !u.passwordHash || !verifyPassword(password, u.passwordHash)) return json(res, 401, { error: '아이디 또는 비밀번호가 올바르지 않습니다.' });
    if (key) { const l = db.licenses.find(x => x.id === u.licenseId); if (!l || l.key.toUpperCase() !== key) return json(res, 401, { error: '연결된 라이선스 키가 올바르지 않습니다.' }); }
    u.lastLoginAt = now(); saveDb(); session(res, u); return json(res, 200, { ok: true, user: publicUser(u) });
  }
  if (p === '/api/auth/logout' && method === 'POST') { db.sessions = db.sessions.filter(s => s.token !== cookie(req, 'nexivo_session')); saveDb(); clearCookie(res, 'nexivo_session'); return json(res, 200, { ok: true }); }

  // Bot bridge - authenticate using platform bridge secret + license key + per-license bot secret.
  if (p === '/api/bot/license/issue' && method === 'POST') {
    if (String(req.headers['x-nexivo-issue-secret'] || '') !== LICENSE_ISSUE_SECRET) return json(res, 401, { error: '라이선스 발급 브리지 인증이 필요합니다.' });
    const b = await parseBody(req); const d = b.durationDays === undefined ? 30 : Number(b.durationDays); const l = createLicense(b.plan, { actor: 'DISCORD_BOT', discordUserId: b.discordUserId, orderId: b.orderId, durationDays: d });
    return json(res, 200, { ok: true, license: publicLicense(l, true) });
  }
  if (p === '/api/bot/license/activate' && method === 'POST') {
    if (!workerOK()) return json(res, 401, { error: '봇 워커 인증이 필요합니다.' });
    const b = await parseBody(req);
    const key = String(b.licenseKey || '').trim().toUpperCase();
    const guildId = String(b.guildId || '').trim();
    const discordUserId = String(b.discordUserId || '').trim();
    if (!key || !guildId || !discordUserId) return json(res, 400, { error: '라이선스 키, Discord 서버 ID, Discord 사용자 ID가 필요합니다.' });
    const l = db.licenses.find(x => String(x.key || '').toUpperCase() === key);
    if (!l) return json(res, 404, { error: '존재하지 않는 라이선스 키입니다.' });
    if (effectiveStatus(l) !== 'ACTIVE') {
      const status = effectiveStatus(l);
      return json(res, 403, { error: status === 'EXPIRED' ? '라이선스 기간이 만료되었습니다. 새로운 라이선스 키를 구매해주세요!' : `라이선스 상태: ${status}`, code: `LICENSE_${status}` });
    }
    if (!l.userId) return json(res, 409, { error: '먼저 웹사이트에서 라이선스를 활성화해주세요.' });
    if (String(l.discordUserId || '').trim() !== discordUserId) return json(res, 403, { error: '이 라이선스에 등록된 Discord 사용자 ID와 일치하지 않습니다.' });
    const user = db.users.find(x => x.id === l.userId);
    if (!user) return json(res, 409, { error: '라이선스에 연결된 계정을 찾을 수 없습니다.' });

    const currentSettings = userSettings(user.id);
    const conflicting = db.licenses.find(x => x.id !== l.id && effectiveStatus(x) === 'ACTIVE' && x.userId && userSettings(x.userId).guildId === guildId);
    if (conflicting) return json(res, 409, { error: '이 Discord 서버에는 이미 다른 활성 라이선스가 연결되어 있습니다.' });
    if (currentSettings.guildId && currentSettings.guildId !== guildId) return json(res, 409, { error: '이 라이선스는 이미 다른 Discord 서버에 연결되어 있습니다.' });

    currentSettings.guildId = guildId;
    db.settings[user.id] = currentSettings;
    l.bot = { ...(l.bot || {}), status: 'CONNECTED', guildId, discordUserId, lastSeenAt: now() };
    touchBot(l, { status: 'CONNECTED', guildId, botUserId: b.botUserId || null, botUsername: b.botUsername || null });
    pushEvent('license.discord_activated', { ownerId: user.id, licenseId: l.id, guildId, plan: l.plan });
    audit(user.username, 'LICENSE_DISCORD_ACTIVATE', l.id, `${discordUserId} / ${guildId}`);
    saveDb();
    return json(res, 200, {
      ok: true,
      code: 'LICENSE_VERIFIED',
      message: `${planLabel(l.plan)} 라이선스가 확인되었습니다. 이 서버에서 NEXIVO HUB 명령어를 사용할 수 있습니다.`,
      license: publicLicense(l, false),
      plan: l.plan, planLabel: planLabel(l.plan), features: PLAN_META[normalizePlan(l.plan)].features,
      guildId, discordUserId
    });
  }

  if (p === '/api/bot/register' && method === 'POST') {
    const b = await parseBody(req); const lkey = String(b.licenseKey || req.headers['x-nexivo-license'] || '').trim().toUpperCase();
    const l = db.licenses.find(x => x.key.toUpperCase() === lkey);
    if (!l || !botOK(req, l)) return json(res, 401, { error: '봇 연결 인증 정보가 올바르지 않습니다.' });
    const g = activeGate(l, res); if (g) return;
    const user = db.users.find(x => x.id === l.userId); if (!user) return json(res, 409, { error: '라이선스 계정이 아직 활성화되지 않았습니다.' });
    const tier = String(b.botTier || planFamily(l.plan)).toUpperCase(); if (user.role !== 'OWNER' && tier !== planFamily(l.plan)) return json(res, 400, { error: `이 라이선스는 ${planFamily(l.plan)} 봇에 연결해야 합니다.` });
    const snapshot = b.snapshot || {};
    let products = db.products.filter(x => x.ownerId === user.id);
    let orders = db.orders.filter(x => x.ownerId === user.id);
    let settings = userSettings(user.id);
    if (!products.length && Array.isArray(snapshot.products) && snapshot.products.length) {
      products = snapshot.products.map((x, i) => sanitizeProduct(x, user.id, `P-${String(i + 1).padStart(4, '0')}`));
      db.products = db.products.filter(x => x.ownerId !== user.id).concat(products);
      pushEvent('product.bootstrap', { ownerId: user.id });
    }
    if (!orders.length && snapshot.orders && typeof snapshot.orders === 'object') {
      const arr = Array.isArray(snapshot.orders) ? snapshot.orders : Object.values(snapshot.orders);
      orders = arr.map(x => sanitizeOrder(x, user.id));
      db.orders = db.orders.filter(x => x.ownerId !== user.id).concat(orders);
      pushEvent('order.bootstrap', { ownerId: user.id });
    }
    if ((!settings.bankInfo && !settings.guildId && !settings.orderCategoryId) && snapshot.settings && typeof snapshot.settings === 'object') {
      settings = normalizeSettings(snapshot.settings, settings); db.settings[user.id] = settings; pushEvent('settings.bootstrap', { ownerId: user.id, settings });
    }
    touchBot(l, { status: 'CONNECTED', instanceId: String(b.instanceId || ''), tier, botUserId: b.botUserId || null, botUsername: b.botUsername || null });
    audit(user.username, 'BOT_REGISTER', l.id, `${tier} / ${b.botUsername || b.instanceId || 'bot'}`); saveDb();
    const cursor = db.events.length ? db.events[db.events.length - 1].id : 0;
    return json(res, 200, { ok: true, cursor, plan: l.plan, planLabel: planLabel(l.plan), products, orders, settings, license: publicLicense(l, false), bot: l.bot });
  }
  if (p === '/api/bot/products' && method === 'GET') {
    const ctx = botContext(req); if (!ctx.ok) return json(res, ctx.status, { error: ctx.error, code: ctx.code });
    return json(res, 200, { products: db.products.filter(x => x.ownerId === ctx.user.id) });
  }
  if (p === '/api/bot/orders' && method === 'GET') {
    const ctx = botContext(req); if (!ctx.ok) return json(res, ctx.status, { error: ctx.error, code: ctx.code });
    return json(res, 200, { orders: db.orders.filter(x => x.ownerId === ctx.user.id).sort((a,b)=>String(b.createdAt).localeCompare(String(a.createdAt))) });
  }
  if (p === '/api/bot/settings' && method === 'GET') {
    const ctx = botContext(req); if (!ctx.ok) return json(res, ctx.status, { error: ctx.error, code: ctx.code });
    return json(res, 200, { settings: userSettings(ctx.user.id) });
  }

  if (p === '/api/bot/stream' && method === 'GET') {
    const isWorkerStream = workerOK();
    let l = null; let botUser = null;
    if (!isWorkerStream) {
      const ctx = botContext(req); if (!ctx.ok) return json(res, ctx.status, { error: ctx.error, code: ctx.code });
      l = ctx.license; botUser = ctx.user;
    }
    res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache, no-transform', 'Connection': 'keep-alive', 'X-Accel-Buffering': 'no' });
    res.write(`event: ready\ndata: ${JSON.stringify({ ok: true, at: now(), ownerId: botUser?.id || null, scope: isWorkerStream ? 'worker' : 'license' })}\n\n`);
    if (!isWorkerStream && l && botUser) {
      const snapshot = db.products.filter(x => x.ownerId === botUser.id);
      res.write(`event: sync\ndata: ${JSON.stringify({ id: 0, type: 'product.snapshot', at: now(), payload: { ownerId: botUser.id, licenseId: l.id, products: snapshot } })}\n\n`);
      touchBot(l, { status: 'CONNECTED' });
      saveDb();
    }
    const client = { res, userId: botUser?.id || null, licenseId: l?.id || null, kind: isWorkerStream ? 'worker' : 'bot' };
    sseClients.add(client);
    const heartbeat = setInterval(() => {
      try {
        if (l) { touchBot(l, { status: 'CONNECTED' }); saveDb(); }
        res.write(`: bot-heartbeat ${Date.now()}\n\n`);
      } catch {}
    }, 25000);
    req.on('close', () => { clearInterval(heartbeat); sseClients.delete(client); });
    return;
  }
  if (p === '/api/bot/sync' && method === 'GET') {
    const ctx = botContext(req); if (!ctx.ok) return json(res, ctx.status, { error: ctx.error, code: ctx.code });
    const { license: l, user } = ctx; const since = Number(url.searchParams.get('since') || 0);
    touchBot(l, { status: 'CONNECTED' });
    const events = db.events.filter(e => e.id > since && (
      e.payload?.ownerId === user.id || e.payload?.licenseId === l.id
    ));
    saveDb();
    return json(res, 200, { ok: true, cursor: db.events.length ? db.events[db.events.length - 1].id : since, events });
  }
  if (p === '/api/bot/stock-adjust' && method === 'POST') {
    if (!workerOK()) return json(res, 401, { error: '봇 워커 인증이 필요합니다.' });
    const b = await parseBody(req);
    const guildId = String(b.guildId || '').trim();
    const productId = String(b.productId || '').trim();
    const delta = Math.trunc(Number(b.delta));
    if (!/^\d{15,25}$/.test(guildId) || !productId || !Number.isInteger(delta) || delta === 0 || Math.abs(delta) > 1000) return json(res, 400, { error: '재고 조정 값이 올바르지 않습니다.' });
    const tenant = db.licenses.map(l => ({ l, u: db.users.find(x => x.id === l.userId) })).find(x => x.u && userSettings(x.u.id).guildId === guildId && effectiveStatus(x.l) === 'ACTIVE');
    if (!tenant) return json(res, 404, { error: '활성 라이선스 테넌트를 찾을 수 없습니다.' });
    const product = db.products.find(x => x.id === productId && x.ownerId === tenant.u.id);
    if (!product) return json(res, 404, { error: '상품을 찾을 수 없습니다.' });
    const current = Number(product.stock);
    if (!Number.isFinite(current)) return json(res, 409, { error: '상품 재고 값이 올바르지 않습니다.' });
    if (current < 0 && delta < 0) {
      product.updatedAt = now();
    } else {
      const next = current + delta;
      if (next < 0) return json(res, 409, { error: '재고가 부족합니다.', available: current });
      product.stock = next; product.updatedAt = now();
    }
    pushEvent('product.updated', { ownerId: tenant.u.id, licenseId: tenant.l.id, product });
    audit(tenant.u.username, 'BOT_STOCK_ADJUST', product.id, `Discord 구매/환불 재고 ${delta > 0 ? '+' : ''}${delta}`);
    saveDb();
    return json(res, 200, { ok: true, product });
  }
  if (p === '/api/bot/worker-state' && method === 'POST') {
    if (!workerOK()) return json(res, 401, { error: '봇 워커 인증이 필요합니다.' });
    const b = await parseBody(req);
    const guildId = String(b.guildId || '').trim();
    const tenant = db.licenses.map(l => ({ l, u: db.users.find(x => x.id === l.userId) })).find(x => x.u && userSettings(x.u.id).guildId === guildId && effectiveStatus(x.l) === 'ACTIVE');
    if (!tenant) return json(res, 404, { error: '활성 라이선스 테넌트를 찾을 수 없습니다.' });
    const { l, u } = tenant;
    let changed = false;
    if (Array.isArray(b.orders)) {
      const incoming = b.orders.map(x => sanitizeOrder(x, u.id));
      const current = db.orders.filter(x => x.ownerId === u.id);
      const preserved = current.filter(x => String(x.source || 'WEB') !== 'DISCORD' && !incoming.some(y => y.id === x.id));
      const merged = preserved.concat(incoming);
      if (stable(current) !== stable(merged)) { db.orders = db.orders.filter(x => x.ownerId !== u.id).concat(merged); pushEvent('order.snapshot', { ownerId: u.id, orders: incoming }); changed = true; }
    }
    if (b.settings && typeof b.settings === 'object') {
      const incoming = normalizeSettings(b.settings, userSettings(u.id));
      if (stable(userSettings(u.id)) !== stable(incoming)) { db.settings[u.id] = incoming; pushEvent('settings.snapshot', { ownerId: u.id, settings: incoming }); changed = true; }
    }
    touchBot(l, { status: 'CONNECTED', guildId, botUserId: b.botUserId || null, botUsername: b.botUsername || null, stockSyncError: b.stockSyncError || null });
    if (changed) audit(u.username, 'BOT_STATE_PUSH', l.id, '공용 봇 데이터 → 웹 동기화');
    saveDb();
    return json(res, 200, { ok: true, changed, ownerId: u.id, licenseId: l.id, plan: l.plan, features: PLAN_META[normalizePlan(l.plan)].features });
  }
  if (p === '/api/bot/state' && method === 'POST') {
    const ctx = botContext(req); if (!ctx.ok) return json(res, ctx.status, { error: ctx.error, code: ctx.code });
    const { license: l, user } = ctx; const b = await parseBody(req);
    let changed = false;
    if (Array.isArray(b.products)) {
      const incoming = b.products.map((x, i) => sanitizeProduct(x, user.id, `P-${String(i + 1).padStart(4, '0')}`));
      const current = db.products.filter(x => x.ownerId === user.id);
      if (stable(current) !== stable(incoming)) { db.products = db.products.filter(x => x.ownerId !== user.id).concat(incoming); pushEvent('product.snapshot', { ownerId: user.id, products: incoming }); changed = true; }
    }
    if (b.orders && (Array.isArray(b.orders) || typeof b.orders === 'object')) {
      const arr = Array.isArray(b.orders) ? b.orders : Object.values(b.orders);
      const incoming = arr.map(x => sanitizeOrder(x, user.id));
      const current = db.orders.filter(x => x.ownerId === user.id);
      const preserved = current.filter(x => String(x.source || 'WEB') !== 'DISCORD' && !incoming.some(y => y.id === x.id));
      const merged = preserved.concat(incoming);
      if (stable(current) !== stable(merged)) { db.orders = db.orders.filter(x => x.ownerId !== user.id).concat(merged); pushEvent('order.snapshot', { ownerId: user.id, orders: incoming }); changed = true; }
    }
    if (b.settings && typeof b.settings === 'object') {
      const incoming = normalizeSettings(b.settings, userSettings(user.id));
      if (stable(userSettings(user.id)) !== stable(incoming)) { db.settings[user.id] = incoming; pushEvent('settings.snapshot', { ownerId: user.id, settings: incoming }); changed = true; }
    }
    touchBot(l, { status: 'CONNECTED', instanceId: String(b.instanceId || l.bot?.instanceId || ''), tier: String(b.botTier || l.bot?.tier || planFamily(l.plan)).toUpperCase(), botUserId: b.botUserId || l.bot?.botUserId || null, botUsername: b.botUsername || l.bot?.botUsername || null });
    if (changed) audit(user.username, 'BOT_STATE_PUSH', l.id, '봇 데이터 → 웹 동기화');
    saveDb(); if (changed && Array.isArray(b.products)) requestBotSync(user.id, 'data_changed'); return json(res, 200, { ok: true, changed, cursor: db.events.length ? db.events[db.events.length - 1].id : 0 });
  }

  // Logged-in customer
  const idn = identity(req);
  if (p === '/api/me' && method === 'GET') {
    if (!idn.user) return json(res, 401, { error: '로그인이 필요합니다.' });
    return json(res, 200, { user: publicUser(idn.user) });
  }

  // Store is account-authenticated but NOT license-gated. Dashboard/bot management remains license-gated below.
  // Wallet / recharge APIs. Store access only requires an account, not a platform license.
  if (p === '/api/wallet' && method === 'GET') {
    if (!idn.user) return json(res, 401, { error: '로그인이 필요합니다.' });
    ensureWallet(idn.user); saveDb();
    return json(res, 200, { ok:true, wallet:publicWallet(idn.user) });
  }
  if (p === '/api/wallet/topups' && method === 'GET') {
    if (!idn.user) return json(res, 401, { error: '로그인이 필요합니다.' });
    const rows = db.topupRequests.filter(x => x.userId === idn.user.id).slice(0, 50);
    return json(res, 200, { topups:rows });
  }
  if (p === '/api/wallet/topups' && method === 'POST') {
    if (!idn.user) return json(res, 401, { error: '로그인이 필요합니다.' });
    const b = await parseBody(req); const amount = Math.floor(Number(b.amount) || 0);
    if (amount < 1000 || amount > 10000000) return json(res, 400, { error: '충전 금액은 1,000원 이상 10,000,000원 이하로 입력해주세요.' });
    const row = { id:rid('top'), userId:idn.user.id, username:idn.user.username, amount, method:String(b.method||'BANK_TRANSFER'), status:'대기', createdAt:now(), note:String(b.note||'').slice(0,500) };
    db.topupRequests.unshift(row); saveDb(); audit(idn.user.username, 'WALLET_TOPUP_REQUEST', row.id, `${amount}원`); return json(res, 200, { ok:true, topup:row, wallet:publicWallet(idn.user) });
  }
  if (p === '/api/wallet/auto-topup' && method === 'PATCH') {
    if (!idn.user) return json(res, 401, { error: '로그인이 필요합니다.' });
    const b = await parseBody(req); ensureWallet(idn.user);
    idn.user.autoTopup.enabled = Boolean(b.enabled);
    if (b.threshold !== undefined) idn.user.autoTopup.threshold = Math.max(1000, Math.min(1000000, Math.floor(Number(b.threshold)||5000)));
    if (b.amount !== undefined) idn.user.autoTopup.amount = Math.max(1000, Math.min(1000000, Math.floor(Number(b.amount)||10000)));
    if (idn.user.autoTopup.enabled && !billingConfigured(idn.user)) return json(res, 400, { error: '먼저 자동충전 결제수단을 등록해주세요.', code:'BILLING_KEY_REQUIRED' });
    saveDb(); return json(res, 200, { ok:true, wallet:publicWallet(idn.user) });
  }
  if (p === '/api/wallet/billing/config' && method === 'GET') {
    if (!idn.user) return json(res, 401, { error: '로그인이 필요합니다.' });
    return json(res, 200, { enabled:Boolean(PORTONE_STORE_ID && PORTONE_CHANNEL_KEY), storeId:PORTONE_STORE_ID, channelKey:PORTONE_CHANNEL_KEY, billingKeyMethod:PORTONE_BILLING_METHOD });
  }
  if (p === '/api/wallet/billing-key' && method === 'POST') {
    if (!idn.user) return json(res, 401, { error: '로그인이 필요합니다.' });
    if (!PORTONE_STORE_ID || !PORTONE_CHANNEL_KEY || !PORTONE_API_SECRET) return json(res, 503, { error: '자동충전 결제 연동이 아직 설정되지 않았습니다.' });
    const b = await parseBody(req); const billingKey = String(b.billingKey || '').trim(); const methodName = String(b.billingMethod || PORTONE_BILLING_METHOD).trim().toUpperCase();
    if (!billingKey || billingKey.length < 10) return json(res, 400, { error: '유효한 빌링키가 필요합니다.' });
    idn.user.billingKeyEncrypted = encryptBotToken(billingKey); idn.user.billingMethod = methodName; idn.user.autoTopup = { ...(idn.user.autoTopup || {}), provider:'PORTONE', configured:true };
    saveDb(); audit(idn.user.username, 'WALLET_BILLING_KEY_SET', idn.user.id, methodName);
    return json(res, 200, { ok:true, wallet:publicWallet(idn.user) });
  }
  if (p === '/api/wallet/billing-key' && method === 'DELETE') {
    if (!idn.user) return json(res, 401, { error: '로그인이 필요합니다.' });
    idn.user.billingKeyEncrypted = null; idn.user.billingMethod = null; idn.user.autoTopup = { ...(idn.user.autoTopup || {}), enabled:false, configured:false, provider:null }; saveDb(); audit(idn.user.username, 'WALLET_BILLING_KEY_REMOVE', idn.user.id, '자동충전 결제수단 제거'); return json(res, 200, { ok:true, wallet:publicWallet(idn.user) });
  }
  if (p === '/api/wallet/topups/pending' && method === 'GET') {
    if (!idn.user || idn.user.role !== 'OWNER') return json(res, 403, { error: '오너 전용 기능입니다.' });
    return json(res, 200, { topups:db.topupRequests.filter(x => x.status === '대기').slice(0, 200) });
  }
  let topupMatch = p.match(/^\/api\/wallet\/topups\/([^/]+)\/(approve|reject)$/);
  if (topupMatch && method === 'POST') {
    if (!idn.user || idn.user.role !== 'OWNER') return json(res, 403, { error: '오너 전용 기능입니다.' });
    const row = db.topupRequests.find(x => x.id === topupMatch[1]); if (!row) return json(res,404,{error:'충전 신청을 찾을 수 없습니다.'});
    if (row.status !== '대기') return json(res,409,{error:'이미 처리된 신청입니다.'});
    const target = db.users.find(x => x.id === row.userId); if (!target) return json(res,404,{error:'사용자를 찾을 수 없습니다.'});
    if (topupMatch[2] === 'approve') { creditWallet(target, row.amount, `수동 충전 승인: ${row.id}`, {orderId:row.id}); row.status='완료'; row.approvedAt=now(); }
    else { row.status='거절'; row.rejectedAt=now(); }
    saveDb(); return json(res,200,{ok:true,topup:row,wallet:publicWallet(target)});
  }

  if (p === '/api/store/config' && method === 'GET') {
    const ownerId = shopOwnerId();
    const ownerSettings = ownerId ? userSettings(ownerId) : {};
    return json(res, 200, { bankInfo: String(ownerSettings.bankInfo || STORE_BANK_INFO || '판매자 계좌 정보가 아직 설정되지 않았습니다.'), discordInviteUrl: STORE_DISCORD_INVITE_URL });
  }
  if (p === '/api/shop/products' && method === 'GET') {
    if (!idn.user) return json(res, 401, { error: '로그인이 필요합니다.' });
    const ownerId = shopOwnerId();
    const products = ownerId ? db.products.filter(x => x.ownerId === ownerId && x.active !== false).map(publicShopProduct) : [];
    return json(res, 200, { products });
  }
  if (p === '/api/shop/reviews' && method === 'GET') {
    const productId = String(url.searchParams.get('productId') || '').trim();
    const ownerId = shopOwnerId();
    let rows = db.reviews.filter(x => !ownerId || x.ownerId === ownerId);
    if (productId) rows = rows.filter(x => x.productId === productId);
    return json(res, 200, { reviews: rows.slice(0, 50).map(publicReview) });
  }
  if (p === '/api/shop/reviews' && method === 'POST') {
    const idn = identity(req, res); if (!idn) return;
    const b = await parseBody(req);
    const orderId = String(b.orderId || '').trim();
    const order = db.orders.find(x => x.id === orderId && x.buyerUserId === idn.user.id && x.status === '완료');
    if (!order) return json(res, 404, { error: '본인의 지급 완료 주문에서만 후기를 작성할 수 있습니다.' });
    const result = addReview({ order, buyerUserId: idn.user.id, discordUserId: idn.user.discordUserId || order.buyerDiscordId || null, username: idn.user.username, rating: b.rating, content: b.content, source: 'WEB' });
    if (!result.ok) return json(res, 409, { error: result.error });
    return json(res, 200, { ok: true, review: publicReview(result.review) });
  }
  if (p === '/api/shop/orders' && method === 'GET') {
    if (!idn.user) return json(res, 401, { error: '로그인이 필요합니다.' });
    return json(res, 200, { orders: db.orders.filter(x => x.buyerUserId === idn.user.id).sort((a,b)=>String(b.createdAt).localeCompare(String(a.createdAt))).map(x=>shopOrderPublic(x, true)) });
  }
  if (p === '/api/shop/orders' && method === 'POST') {
    if (!idn.user) return json(res, 401, { error: '로그인이 필요합니다.' });
    const b = await parseBody(req); const ownerId = shopOwnerId(); const productId = String(b.productId || '').trim();
    const product = db.products.find(x => x.ownerId === ownerId && x.id === productId && x.active !== false);
    if (!product) return json(res, 404, { error: '상품을 찾을 수 없습니다.' });
    if (!productAvailable(product)) return json(res, 409, { error: '현재 구매 가능한 재고가 없습니다.' });
    ensureWallet(idn.user); const total = Math.max(0, Math.floor(Number(product.price)||0));
    if (Number(idn.user.walletBalance||0) < total) {
      return json(res, 402, { error: `잔액이 부족합니다. 현재 ${Number(idn.user.walletBalance||0).toLocaleString()}원입니다. Discord 자판기에서 계좌이체 충전을 신청해주세요.`, wallet:publicWallet(idn.user), code:'INSUFFICIENT_WALLET' });
    }
    const order = createShopOrder({ sellerId: ownerId, buyerUserId: idn.user.id, buyerDiscordId: idn.user.discordUserId || null, buyerName: idn.user.username, product, source: 'WEB', guildId: String(b.guildId||'').trim() || null });
    order.status = '결제완료';
    if (!debitWallet(idn.user, total, `웹 상점 구매: ${product.name}`, { orderId:order.id })) return json(res,409,{error:'잔액 차감에 실패했습니다.'});
    const result = fulfillShopOrder(order, idn.user.username);
    if (!result.ok) { creditWallet(idn.user,total,`구매 실패 환불: ${product.name}`,{orderId:order.id}); return json(res,409,{error:result.error}); }
    db.orders.unshift(order); pushEvent('shop.order.fulfilled', { ownerId, buyerUserId: idn.user.id, orderId: order.id, productId }); audit(idn.user.username, 'SHOP_ORDER_PURCHASE', order.id, `${product.name} / ${product.price}`); saveDb();
    return json(res, 200, { ok: true, order: shopOrderPublic(order, true), wallet:publicWallet(idn.user), autoTopup:{ enabled:false, triggered:false, reason:'wallet_only' } });
  }
  if (p === '/api/shop/orders/latest' && method === 'GET') {
    if (!idn.user) return json(res, 401, { error: '로그인이 필요합니다.' });
    const order = db.orders.filter(x => x.buyerUserId === idn.user.id).sort((a,b)=>String(b.createdAt).localeCompare(String(a.createdAt)))[0] || null;
    return json(res, 200, { order: order ? shopOrderPublic(order, true) : null });
  }
  if (p === '/api/shop/orders/cancel' && method === 'POST') {
    if (!idn.user) return json(res, 401, { error: '로그인이 필요합니다.' });
    const b = await parseBody(req); const order = db.orders.find(x => x.id === String(b.orderId || '') && x.buyerUserId === idn.user.id);
    if (!order) return json(res, 404, { error: '주문을 찾을 수 없습니다.' });
    if (!['입금대기','주문접수'].includes(String(order.status))) return json(res, 409, { error: '현재 상태에서는 주문을 취소할 수 없습니다.' });
    order.status = '취소'; order.updatedAt = now(); pushEvent('shop.order.cancelled', { ownerId: order.ownerId, buyerUserId: idn.user.id, orderId: order.id }); audit(idn.user.username, 'SHOP_ORDER_CANCEL', order.id, order.productName); saveDb();
    return json(res, 200, { ok: true, order: shopOrderPublic(order, true) });
  }
  if (p === '/api/bot/shop/purchase' && method === 'POST') {
    // Keep the legacy endpoint working, but route it through the website wallet.
    if (!workerOK()) return json(res, 401, { error: '봇 워커 인증이 필요합니다.' });
    const b = await parseBody(req); const guildId = String(b.guildId || '').trim(); const productId = String(b.productId || '').trim(); const discordUserId = String(b.discordUserId || '').trim(); const discordUsername = String(b.discordUsername || 'Discord 구매자').trim();
    const tenant = db.licenses.map(l => ({ l, u: db.users.find(x => x.id === l.userId) })).find(x => x.u && userSettings(x.u.id).guildId === guildId && effectiveStatus(x.l) === 'ACTIVE');
    if (!tenant) return json(res, 404, { error: '활성 자판기 테넌트를 찾을 수 없습니다.' });
    const product = db.products.find(x => x.ownerId === tenant.u.id && x.id === productId && x.active !== false);
    if (!product) return json(res, 404, { error: '상품을 찾을 수 없습니다.' });
    const buyer = createDiscordShadowUser(discordUserId, discordUsername); if (!buyer) return json(res,400,{error:'Discord 계정을 확인할 수 없습니다.'});
    ensureWallet(buyer); const total = Math.max(0,Math.floor(Number(product.price)||0));
    if (Number(buyer.walletBalance||0) < total) { return json(res,402,{error:`잔액이 부족합니다. 현재 ${Number(buyer.walletBalance||0).toLocaleString()}원입니다. Discord 자판기에서 충전을 신청해주세요.`,wallet:publicWallet(buyer),code:'INSUFFICIENT_WALLET'}); }
    const order = createShopOrder({ sellerId:tenant.u.id, buyerUserId:buyer.id, buyerDiscordId:discordUserId, buyerName:discordUsername, product, source:'DISCORD', guildId }); order.status='결제완료';
    if(!debitWallet(buyer,total,`Discord 상품 구매: ${product.name}`,{orderId:order.id})) return json(res,409,{error:'잔액 차감에 실패했습니다.'});
    const result=fulfillShopOrder(order,'DISCORD_BOT'); if(!result.ok){creditWallet(buyer,total,`구매 실패 환불: ${product.name}`,{orderId:order.id});return json(res,409,{error:result.error});}
    db.orders.unshift(order);saveDb();requestBotSync(tenant.u.id,'shop_purchase');
    return json(res,200,{ok:true,order:shopOrderPublic(order,true),licenseKey:result.key,wallet:publicWallet(buyer),autoTopup:{ enabled:false, triggered:false, reason:'wallet_only' }});
  }

  if (p === '/api/stream' && method === 'GET') {
    if (!idn.user) return json(res, 401, { error: '로그인이 필요합니다.' });
    const gate = activeGate(idn.license, res); if (gate) return;
    res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache, no-transform', 'Connection': 'keep-alive', 'X-Accel-Buffering': 'no' });
    res.write(`event: ready\ndata: ${JSON.stringify({ ok: true, at: now() })}\n\n`);
    const client = { res, userId: idn.user.id, licenseId: idn.license.id };
    sseClients.add(client);
    const heartbeat = setInterval(() => { try { res.write(`: keepalive ${Date.now()}\n\n`); } catch {} }, 25000);
    req.on('close', () => { clearInterval(heartbeat); sseClients.delete(client); });
    return;
  }
  if (!idn.user && p.startsWith('/api/')) return json(res, 401, { error: '로그인이 필요합니다.' });
  const user = idn.user; const license = idn.license;
  if (!license || effectiveStatus(license) !== 'ACTIVE') {
    if (p === '/api/dashboard' && method === 'GET') return json(res, 403, { error: '대시보드/봇 관리에는 활성 NEXIVO HUB 라이선스가 필요합니다.', code: 'DASHBOARD_LICENSE_REQUIRED' });
    if (p.startsWith('/api/products') || p.startsWith('/api/orders') || p.startsWith('/api/reports') || p.startsWith('/api/settings') || p.startsWith('/api/bot/')) return json(res, 403, { error: '대시보드/봇 관리에는 활성 NEXIVO HUB 라이선스가 필요합니다.', code: 'DASHBOARD_LICENSE_REQUIRED' });
  }
  const gate = license ? activeGate(license, res) : null; if (gate && (p !== '/api/me')) return;

  if (p === '/api/dashboard' && method === 'GET') {
    const products = db.products.filter(x => x.ownerId === user.id); const orders = db.orders.filter(x => x.ownerId === user.id);
    const lowStock = products.filter(x => x.stock >= 0 && x.stock < 10).length;
    const pendingOrders = orders.filter(x => !['완료', '취소', '마감'].includes(String(x.status))).length;
    const connected = license.bot && license.bot.status === 'CONNECTED' && license.bot.lastSeenAt && Date.now() - new Date(license.bot.lastSeenAt).getTime() < 30000;
    return json(res, 200, { user: publicUser(user), stats: { products: products.length, orders: orders.length, lowStock, pendingOrders, planLabel: planLabel(user.plan), remainingDays: remainingDays(license) }, bot: { connected, ...(license.bot || {}) }, settings: userSettings(user.id), products, orders });
  }
  if (p === '/api/products' && method === 'GET') return json(res, 200, db.products.filter(x => x.ownerId === user.id));
  if (p === '/api/products' && method === 'POST') {
    const b = await parseBody(req); if (!String(b.name || '').trim()) return json(res, 400, { error: '상품명을 입력해주세요.' });
    const x = sanitizeProduct({ name: b.name, category: b.category, price: b.price, stock: b.stock, description: b.description, features: b.features, image_url: b.image_url, active: b.active, deliveryType: b.deliveryType, licensePlan: b.licensePlan, licenseDurationDays: b.licenseDurationDays }, user.id, rid('prd'));
    db.products.unshift(x); pushEvent('product.created', { ownerId: user.id, product: x }); audit(user.username, 'PRODUCT_CREATE', x.id, x.name); saveDb(); requestBotSync(user.id, 'data_changed'); return json(res, 200, x);
  }
  let pm = p.match(/^\/api\/products\/([^/]+)$/);
  if (pm && method === 'PATCH') {
    const x = db.products.find(z => z.id === pm[1] && z.ownerId === user.id); if (!x) return json(res, 404, { error: '상품을 찾을 수 없습니다.' });
    const b = await parseBody(req);
    for (const k of ['name', 'category', 'description', 'image_url']) if (b[k] !== undefined) x[k] = String(b[k] || '').slice(0, k === 'description' ? 600 : 1000);
    if (b.active !== undefined) x.active = Boolean(b.active);
    if (b.deliveryType !== undefined) x.deliveryType = normalizeDeliveryType(b.deliveryType);
    if (b.licensePlan !== undefined) x.licensePlan = normalizePlan(b.licensePlan);
    if (b.licenseDurationDays !== undefined) x.licenseDurationDays = Math.max(1, Math.min(3650, Math.floor(Number(b.licenseDurationDays) || 30)));
    if (b.price !== undefined) x.price = Math.max(0, Number(b.price) || 0);
    if (b.stock !== undefined) x.stock = Math.max(-1, Math.floor(Number(b.stock) || 0));
    if (b.features !== undefined) x.features = Array.isArray(b.features) ? b.features.map(v => String(v).slice(0, 160)).slice(0, 40) : String(b.features || '').split(/\r?\n/).map(v => v.trim()).filter(Boolean).slice(0, 40);
    x.updatedAt = now(); pushEvent('product.updated', { ownerId: user.id, product: x }); audit(user.username, 'PRODUCT_UPDATE', x.id, `${x.name} / 재고 ${x.stock}`); saveDb(); requestBotSync(user.id, 'data_changed'); return json(res, 200, x);
  }

  const pk = p.match(/^\/api\/products\/([^/]+)\/license-keys$/);
  if (pk && method === 'GET') {
    const product = db.products.find(z => z.id === pk[1] && z.ownerId === user.id); if (!product) return json(res, 404, { error: '상품을 찾을 수 없습니다.' });
    return json(res, 200, { keys: db.productKeys.filter(k => k.productId === product.id).map(k => ({ id:k.id, key:k.key, status:k.status, orderId:k.orderId || null, createdAt:k.createdAt, usedAt:k.usedAt || null })) });
  }
  if (pk && method === 'POST') {
    const product = db.products.find(z => z.id === pk[1] && z.ownerId === user.id); if (!product) return json(res, 404, { error: '상품을 찾을 수 없습니다.' });
    if (normalizeDeliveryType(product.deliveryType) !== 'LICENSE_KEY') return json(res, 400, { error: '이 상품은 자동 라이선스 발급 방식입니다.' });
    const b = await parseBody(req); const raw = Array.isArray(b.keys) ? b.keys : String(b.text || '').split(/\r?\n/); const keys = [...new Set(raw.map(x=>String(x||'').trim()).filter(Boolean))].slice(0, 1000);
    if (!keys.length) return json(res, 400, { error: '추가할 라이선스 키가 없습니다.' });
    let added=0;
    for (const key of keys) { if (db.productKeys.some(k=>k.productId===product.id && k.key===key)) continue; db.productKeys.push({ id: rid('pkey'), productId: product.id, key, status:'UNUSED', orderId:null, buyerUserId:null, buyerDiscordId:null, createdAt:now(), usedAt:null }); added++; }
    product.stock = db.productKeys.filter(k => k.productId===product.id && k.status==='UNUSED').length; product.updatedAt=now(); audit(user.username,'PRODUCT_KEYS_ADD',product.id,`${added}개 키 추가`); pushEvent('product.keys.updated',{ownerId:user.id,productId:product.id,count:product.stock}); saveDb(); requestBotSync(user.id,'data_changed');
    return json(res,200,{ok:true,added,stock:product.stock});
  }
  if (pm && method === 'DELETE') {
    const x = db.products.find(z => z.id === pm[1] && z.ownerId === user.id); if (!x) return json(res, 404, { error: '상품을 찾을 수 없습니다.' });
    db.products = db.products.filter(z => z.id !== x.id); pushEvent('product.deleted', { ownerId: user.id, productId: x.id }); audit(user.username, 'PRODUCT_DELETE', x.id, x.name); saveDb(); requestBotSync(user.id, 'data_changed'); return json(res, 200, { ok: true });
  }
  if (p === '/api/orders' && method === 'GET') return json(res, 200, db.orders.filter(x => x.ownerId === user.id).sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt))));
  const om = p.match(/^\/api\/orders\/([^/]+)$/);
  if (om && method === 'PATCH') {
    const x = db.orders.find(z => z.id === om[1] && z.ownerId === user.id); if (!x) return json(res, 404, { error: '주문을 찾을 수 없습니다.' });
    const b = await parseBody(req);
    if (b.status !== undefined) {
      const nextStatus = String(b.status).slice(0, 40);
      if (nextStatus === '완료' && x.status !== '완료') { const out = fulfillShopOrder(x, user.username); if (!out.ok) return json(res, 409, { error: out.error }); } else x.status = nextStatus;
    }
    x.updatedAt = now(); pushEvent('order.updated', { ownerId: user.id, order: x }); audit(user.username, 'ORDER_UPDATE', x.id, x.status); saveDb(); return json(res, 200, x);
  }
  if (p === '/api/reports' && method === 'GET') {
    if (!featureOK(user, 'reports')) return json(res, 403, { error: 'Pro 이상 라이선스가 필요합니다.' });
    const orders = db.orders.filter(x => x.ownerId === user.id);
    const done = orders.filter(x => String(x.status) === '완료');
    const totalRevenue = done.reduce((s, x) => s + (Number(x.amount || x.total) || 0), 0);
    const sold = done.reduce((s, x) => s + (Number(x.quantity) || 1), 0);
    const days = 14;
    const start = new Date(); start.setHours(0,0,0,0); start.setDate(start.getDate() - (days - 1));
    const series = Array.from({ length: days }, (_, i) => {
      const d = new Date(start); d.setDate(start.getDate() + i);
      const key = d.toISOString().slice(0, 10);
      const dayOrders = done.filter(o => String(o.createdAt || '').slice(0,10) === key);
      return { date: d.toISOString(), revenue: dayOrders.reduce((sum,o) => sum + (Number(o.amount || o.total) || 0), 0), orders: dayOrders.length };
    });
    return json(res, 200, { totalRevenue, completed: done.length, totalOrders: orders.length, sold, series });
  }
  if (p === '/api/bot/config' && method === 'GET') {
    if (user.role !== 'OWNER') return json(res, 403, { error: '오너 전용 기능입니다.' });
    return json(res, 200, publicBotConfig());
  }
  if (p === '/api/bot/config' && method === 'PATCH') {
    if (user.role !== 'OWNER') return json(res, 403, { error: '오너 전용 기능입니다.' });
    const b = await parseBody(req);
    const clientId = String(b.clientId || '').trim().slice(0, 80);
    const inviteUrl = String(b.inviteUrl || '').trim().slice(0, 1000);
    const displayName = String(b.displayName || '').trim().slice(0, 100);
    const suppliedToken = String(b.botToken || '').trim();
    if (inviteUrl && !/^https?:\/\//i.test(inviteUrl)) return json(res, 400, { error: '봇 초대 링크는 http:// 또는 https:// 링크여야 합니다.' });
    let encryptedToken = db.botConfig.encryptedToken || null;
    let tokenConfigured = db.botConfig.tokenConfigured === true;
    if (suppliedToken) {
      if (!BOT_WORKER_SECRET) return json(res, 500, { error: '봇 토큰 저장을 위한 서버 보안 시크릿(NEXIVO_BOT_WORKER_SECRET)이 설정되지 않았습니다.' });
      if (suppliedToken.length < 20 || suppliedToken.length > 256) return json(res, 400, { error: 'Discord Bot Token 형식이 올바르지 않습니다.' });
      encryptedToken = encryptBotToken(suppliedToken);
      tokenConfigured = true;
    }
    db.botConfig = { ...db.botConfig, clientId, inviteUrl, displayName: displayName || 'NEXIVO HUB Bot', encryptedToken, tokenConfigured, tokenUpdatedAt: suppliedToken ? now() : (db.botConfig.tokenUpdatedAt || null), updatedAt: now() };
    audit(user.username, 'BOT_CONFIG_UPDATE', user.id, `공용 봇 정보 수정 / 토큰 ${tokenConfigured ? '등록됨' : '미등록'}`);
    pushEvent('bot.config.updated', { ownerId: user.id, botConfig: publicBotConfig() });
    saveDb();
    return json(res, 200, publicBotConfig());
  }
  if (p === '/api/settings' && method === 'GET') return json(res, 200, userSettings(user.id));
  if (p === '/api/settings' && method === 'PATCH') {
    const b = await parseBody(req); const next = normalizeSettings(b, userSettings(user.id));
    db.settings[user.id] = next; pushEvent('settings.updated', { ownerId: user.id, settings: next }); audit(user.username, 'SETTINGS_UPDATE', user.id, '판매/Discord 설정 변경'); saveDb(); if (next.stockSyncEnabled && next.stockChannelId) requestBotSync(user.id, 'settings_changed'); return json(res, 200, next);
  }
  if (p === '/api/bot/status' && method === 'GET') {
    const botSeen = license.bot?.lastSeenAt ? Date.now() - new Date(license.bot.lastSeenAt).getTime() : Infinity;
    const connected = Boolean(license.bot && license.bot.status === 'CONNECTED' && botSeen < 120000);
    return json(res, 200, {
      connected, sharedBot: true, tokenValidated: false,
      bot: license.bot || { status: 'DISCONNECTED' },
      planFamily: planFamily(user.plan), plan: user.plan, planLabel: planLabel(user.plan),
      settings: userSettings(user.id),
      binding: { discordUserId: license.discordUserId || null, guildId: userSettings(user.id).guildId || null },
      botConfig: publicBotConfig(),
      security: { tokenClientVisible: false, sharedTokenServerOnly: true }
    });
  }
  if (p === '/api/bot/connect' && method === 'POST') {
    const b = await parseBody(req);
    const current = userSettings(user.id);
    const guildId = String(b.guildId || current.guildId || '').trim();
    const stockChannelId = String(b.stockChannelId || current.stockChannelId || '').trim();
    if (!/^\d{15,25}$/.test(guildId)) return json(res, 400, { error: '올바른 Discord 서버 ID를 입력해주세요.' });
    if (user.role !== 'OWNER' && !String(license.discordUserId || '').trim()) return json(res, 403, { error: '이 라이선스는 아직 Discord 사용자 ID에 연결되지 않았습니다. 오너에게 라이선스 발급 시 Discord User ID 등록을 요청해주세요.' });
    const conflict = db.licenses.find(x => x.id !== license.id && effectiveStatus(x) === 'ACTIVE' && x.userId && userSettings(x.userId).guildId === guildId);
    if (conflict) return json(res, 409, { error: '이미 다른 활성 라이선스에 연결된 Discord 서버입니다.' });
    if (stockChannelId && !/^\d{15,25}$/.test(stockChannelId)) return json(res, 400, { error: '올바른 재고 채널 ID를 입력해주세요.' });
    db.settings[user.id] = normalizeSettings({ ...current, guildId, stockChannelId, stockSyncEnabled: b.stockSyncEnabled === undefined ? true : Boolean(b.stockSyncEnabled) }, current);
    touchBot(license, { status: 'WAITING', guildId, stockChannelId });
    pushEvent('bot.binding_updated', { ownerId: user.id, licenseId: license.id, guildId, stockChannelId });
    audit(user.username, 'BOT_BIND', license.id, `Discord 서버 ${guildId} 연결 정보 저장`);
    saveDb();
    return json(res, 200, { ok: true, connected: false, sharedBot: true, automaticBinding: true, bot: license.bot, settings: userSettings(user.id) });
  }
  if (p === '/api/bot/disconnect' && method === 'POST') {
    const current = userSettings(user.id);
    db.settings[user.id] = normalizeSettings({ ...current, guildId: '', stockChannelId: '', stockMessageId: '' }, current);
    touchBot(license, { status: 'DISCONNECTED', guildId: '', stockChannelId: '' });
    pushEvent('bot.binding_removed', { ownerId: user.id, licenseId: license.id });
    audit(user.username, 'BOT_UNBIND', license.id, 'Discord 서버 연결 해제');
    saveDb();
    return json(res, 200, { ok: true, connected: false, sharedBot: true, bot: license.bot, settings: userSettings(user.id) });
  }
  if (p === '/api/bot/sync-stock' && method === 'POST') {
    const settings = userSettings(user.id);
    if (!settings.guildId) return json(res, 400, { error: '먼저 Discord 서버를 연결해주세요.' });
    pushEvent('bot.inventory_sync_requested', { ownerId: user.id, licenseId: license.id, guildId: settings.guildId, reason: 'manual' });
    saveDb();
    return json(res, 202, { ok: true, queued: true, sharedBot: true, count: db.products.filter(x => x.ownerId === user.id).length });
  }
  // Owner-only license issuance center. Normal purchaser accounts must never see or call this.
  if (p.startsWith('/api/licenses')) {
    if (user.role !== 'OWNER') return json(res, 403, { error: '오너 전용 기능입니다.' });
  }
  if (p === '/api/licenses' && method === 'GET') {
    return json(res, 200, db.licenses.filter(l => l.issuerUserId === user.id || (l.owner === true && l.userId === user.id)).map(l => publicLicense(l, false)));
  }
  if (p === '/api/licenses' && method === 'POST') {
    const b = await parseBody(req); const plan = normalizePlan(b.plan); const d = b.durationDays === undefined ? 30 : Number(b.durationDays);
    const discordUserId = b.discordUserId === undefined || b.discordUserId === null ? null : String(b.discordUserId).trim();
    if (discordUserId && !/^\d{15,25}$/.test(discordUserId)) return json(res, 400, { error: 'Discord User ID는 15~25자리 숫자로 입력해주세요.' });
    if (!Number.isInteger(d) || d < 0 || d > 3650) return json(res, 400, { error: '기간은 0~3650일 사이의 정수로 입력해주세요.' });
    if (PLAN_META[plan].level > PLAN_META.PRO_PREMIUM.level) return json(res, 403, { error: '지원하지 않는 라이선스 등급입니다.' });
    const l = createLicense(plan, { actor: user.username, issuerUserId: user.id, issuerUsername: user.username, discordUserId, orderId: b.orderId, durationDays: d });
    audit(user.username, 'LICENSE_ISSUE', l.id, `${planLabel(l.plan)} / ${l.key}`); saveDb();
    return json(res, 200, { ok: true, license: publicLicense(l, true) });
  }
  let ownLic = p.match(/^\/api\/licenses\/([^/]+)\/(revoke|suspend|resume|extend|rotate-secret)$/);
  if (ownLic && method === 'POST') {
    const l = db.licenses.find(x => x.id === ownLic[1] && x.issuerUserId === user.id); if (!l) return json(res, 404, { error: '발급한 라이선스를 찾을 수 없습니다.' });
    if (l.owner === true) return json(res, 403, { error: 'OWNER PRO PREMIUM 기본 라이선스는 별도 보안 계층으로 보호됩니다.' });
    const action = ownLic[2];
    if (action === 'revoke') { l.status = 'REVOKED'; pushEvent('license.revoked', { licenseId: l.id, ownerId: l.userId, issuerUserId: user.id }); audit(user.username, 'LICENSE_REVOKE', l.id, l.key); }
    if (action === 'suspend') { l.status = 'SUSPENDED'; pushEvent('license.suspended', { licenseId: l.id, ownerId: l.userId, issuerUserId: user.id }); audit(user.username, 'LICENSE_SUSPEND', l.id, l.key); }
    if (action === 'resume') { if (l.status === 'REVOKED') return json(res, 400, { error: '취소된 라이선스는 복구할 수 없습니다.' }); if (licenseExpired(l)) return json(res, 400, { error: '만료된 라이선스는 기간 연장 후 재개해주세요.' }); l.status = l.userId ? 'ACTIVE' : 'UNUSED'; pushEvent('license.resumed', { licenseId: l.id, ownerId: l.userId, issuerUserId: user.id }); audit(user.username, 'LICENSE_RESUME', l.id, l.key); }
    if (action === 'extend') {
      const b = await parseBody(req); const add = Math.floor(Number(b.days)); if (!Number.isInteger(add) || add < 1 || add > 3650) return json(res, 400, { error: '연장 기간은 1~3650일로 입력해주세요.' });
      l.durationDays = (l.durationDays || 0) + add;
      if (l.activatedAt) { const base = l.expiresAt && new Date(l.expiresAt) > new Date() ? new Date(l.expiresAt).getTime() : Date.now(); l.expiresAt = new Date(base + add * 86400000).toISOString(); if (l.status === 'EXPIRED') l.status = l.userId ? 'ACTIVE' : 'UNUSED'; }
      pushEvent('license.extended', { licenseId: l.id, ownerId: l.userId, issuerUserId: user.id, addDays: add, expiresAt: l.expiresAt }); audit(user.username, 'LICENSE_EXTEND', l.id, `${add}일`);
    }
    if (action === 'rotate-secret') { l.botSecret = `vh_${randomText(24)}`; audit(user.username, 'BOT_SECRET_ROTATE', l.id, l.key); pushEvent('bot.secret_rotated', { licenseId: l.id, ownerId: l.userId, issuerUserId: user.id }); }
    saveDb(); return json(res, 200, { ok: true, license: publicLicense(l, false) });
  }
  if (p === '/api/license/rotate-secret' && method === 'POST') { license.botSecret = `vh_${randomText(24)}`; pushEvent('bot.secret_rotated', { ownerId: user.id, licenseId: license.id }); audit(user.username, 'BOT_SECRET_ROTATE', license.id, '봇 연결 시크릿 재발급'); saveDb(); return json(res, 200, { ok: true, license: publicLicense(license, false) }); }
  if (p === '/api/notice' && method === 'GET') { if (!featureOK(user, 'notice')) return json(res, 403, { error: 'Basic Premium 이상 라이선스가 필요합니다.' }); return json(res, 200, { items: [] }); }
  if (p === '/api/grades' && method === 'GET') { if (!featureOK(user, 'grades')) return json(res, 403, { error: 'Pro 이상 라이선스가 필요합니다.' }); return json(res, 200, { items: [] }); }
  if (p === '/api/customers' && method === 'GET') { if (!featureOK(user, 'customers')) return json(res, 403, { error: 'Pro Premium 전용 기능입니다.' }); return json(res, 200, db.users.filter(x => x.id !== user.id).map(publicUser)); }
  if (p === '/api/audit' && method === 'GET') { if (!featureOK(user, 'audit')) return json(res, 403, { error: 'Pro Premium 전용 기능입니다.' }); return json(res, 200, db.audit.filter(a => a.actor === user.username).slice(0, 150)); }
  return json(res, 404, { error: 'Not Found' });
}

function staticFile(req, res) {
  let u = decodeURIComponent(new URL(req.url, `http://${req.headers.host || 'localhost'}`).pathname);
  if (u === '/') u = '/index.html';
  u = path.posix.normalize(u); const safe = u.replace(/^\/+/, ''); const f = path.join(PUBLIC, safe);
  if (!f.startsWith(PUBLIC)) return text(res, 403, 'Forbidden');
  fs.readFile(f, (err, data) => { if (err) return text(res, 404, 'Not Found'); res.writeHead(200, { 'Content-Type': MIME[path.extname(f)] || 'application/octet-stream', 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff' }); res.end(data); });
}
async function bootstrap() {
  // Load authoritative state from Supabase before creating the owner account.
  await hydrateFromSupabase();
  const defaults = baseDb();
  for (const key of Object.keys(defaults)) {
    if (Array.isArray(defaults[key]) && !Array.isArray(db[key])) db[key] = [];
    if (key === 'settings' && (!db.settings || typeof db.settings !== 'object')) db.settings = {};
    if (key === 'botConfig' && (!db.botConfig || typeof db.botConfig !== 'object')) db.botConfig = {};
    if (key === 'meta' && (!db.meta || typeof db.meta !== 'object')) db.meta = { nextEventId: 1 };
  }
  if (!Number.isInteger(db.meta.nextEventId) || db.meta.nextEventId < 1) {
    const maxEventId = db.events.reduce((m, e) => Math.max(m, Number(e?.id) || 0), 0);
    db.meta.nextEventId = maxEventId + 1;
  }
  ensureOwnerAccount();
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === 'OPTIONS') return json(res, 204, {}, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-NEXIVO-Bridge-Secret, X-NEXIVO-Issue-Secret, X-NEXIVO-License, X-NEXIVO-Bot-Secret, X-NEXIVO-Worker-Secret', 'Access-Control-Allow-Methods': 'GET,POST,PATCH,DELETE,OPTIONS' });
    if (req.url.startsWith('/api/') || req.url.startsWith('/auth/') || req.url === '/verify' || req.url.startsWith('/verify?') || req.url.startsWith('/verify/callback')) {
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-NEXIVO-Bridge-Secret, X-NEXIVO-Issue-Secret, X-NEXIVO-License, X-NEXIVO-Bot-Secret, X-NEXIVO-Worker-Secret');
      res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PATCH,DELETE,OPTIONS');
      await api(req, res);
    } else staticFile(req, res);
  } catch (err) { console.error(err); json(res, 500, { error: '서버 오류가 발생했습니다.' }); }
});
server.on('error', err => { console.error(`NEXIVO HUB server error: ${err.message}`); process.exitCode = 1; });
// Website top-up is intentionally wallet-only.
// Balance is credited from Discord account-transfer requests after owner approval.

bootstrap().then(() => {
  server.listen(PORT, '0.0.0.0', () => { console.log(`NEXIVO HUB running on port ${PORT}`); });
}).catch(err => {
  console.error('[NEXIVO HUB] bootstrap failed:', err);
  process.exit(1);
});
