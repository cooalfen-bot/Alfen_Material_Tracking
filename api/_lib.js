'use strict';
const crypto = require('crypto');

const REST_URL = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const REST_TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;

class HttpError extends Error {
  constructor(status, message, code) {
    super(message);
    this.status = status;
    this.code = code || '';
  }
}

async function redis(...cmd) {
  if (!REST_URL || !REST_TOKEN) throw new HttpError(503, 'Storage is not connected yet.', 'no_storage');
  const r = await fetch(REST_URL, {
    method: 'POST',
    headers: { authorization: 'Bearer ' + REST_TOKEN, 'content-type': 'application/json' },
    body: JSON.stringify(cmd),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.error) throw new HttpError(502, 'Storage error: ' + (j.error || r.status), 'storage');
  return j.result;
}

const SECRET =
  process.env.AUTH_SECRET ||
  crypto.createHash('sha256').update('alfen-auth:' + (REST_TOKEN || 'dev')).digest('hex');

function signToken(mobile) {
  const body = Buffer.from(JSON.stringify({ m: mobile, exp: Date.now() + 30 * 864e5 })).toString('base64url');
  const sig = crypto.createHmac('sha256', SECRET).update(body).digest('base64url');
  return body + '.' + sig;
}

function verifyToken(t) {
  if (!t || typeof t !== 'string') return null;
  const [body, sig] = t.split('.');
  if (!body || !sig) return null;
  const want = crypto.createHmac('sha256', SECRET).update(body).digest('base64url');
  const a = Buffer.from(sig);
  const b = Buffer.from(want);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const p = JSON.parse(Buffer.from(body, 'base64url').toString());
    return p.exp > Date.now() ? p.m : null;
  } catch (e) {
    return null;
  }
}

function hashPin(pin, salt) {
  return crypto.scryptSync(String(pin), salt, 32).toString('hex');
}
function newCred(pin) {
  const salt = crypto.randomBytes(16).toString('hex');
  return { salt, hash: hashPin(pin, salt) };
}
function checkPin(user, pin) {
  const h = Buffer.from(hashPin(pin, user.salt), 'hex');
  const e = Buffer.from(user.hash, 'hex');
  return h.length === e.length && crypto.timingSafeEqual(h, e);
}

async function getUser(mobile) {
  const v = await redis('HGET', 'users', mobile);
  return v ? JSON.parse(v) : null;
}
const publicUser = (mobile, u) => ({ mobile, name: u.name, role: u.role, func: u.func || 'viewer', active: u.active !== false });

function tokenFrom(req) {
  const h = req.headers && (req.headers.authorization || req.headers.Authorization);
  if (h && /^Bearer /i.test(h)) return h.slice(7).trim();
  const q = req.query && req.query.t;
  if (q) return String(q);
  try {
    const u = new URL(req.url, 'http://x');
    return u.searchParams.get('t') || '';
  } catch (e) {
    return '';
  }
}

async function authed(req) {
  const mobile = verifyToken(tokenFrom(req));
  if (!mobile) throw new HttpError(401, 'Please sign in again.', 'auth');
  const u = await getUser(mobile);
  if (!u || u.active === false) throw new HttpError(401, 'This account is not active.', 'auth');
  return { m: mobile, u };
}

const can = {
  dispatch: (u) => ['admin', 'manager', 'store'].includes(u.role),
  receive: (u) => ['admin', 'manager'].includes(u.role) || (u.role === 'user' && ['site', 'driver'].includes(u.func)),
  verify: (u) => ['admin', 'manager'].includes(u.role) || (u.role === 'user' && u.func === 'fitting'),
  admin: (u) => u.role === 'admin',
};

module.exports = {
  HttpError, redis, signToken, verifyToken, newCred, checkPin, getUser, publicUser, authed, can, tokenFrom,
};
