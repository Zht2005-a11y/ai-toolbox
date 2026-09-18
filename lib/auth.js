import crypto from 'crypto';
import * as store from './store.js';

const KEYLEN = 64;
const SCRYPT_OPTS = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

export const COOKIE_NAME = 'aitool_sid';

export function hashPassword(password, salt) {
  const s = salt || crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(password), s, KEYLEN, SCRYPT_OPTS).toString('hex');
  return { hash, salt: s };
}

export function verifyPassword(password, storedHash, salt) {
  try {
    const { hash } = hashPassword(password, salt);
    const a = Buffer.from(hash, 'hex');
    const b = Buffer.from(storedHash, 'hex');
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
  } catch (e) {
    return false;
  }
}

// ===== Cookie 工具（零依赖）=====
export function parseCookies(req) {
  const out = {};
  const raw = req.headers.cookie;
  if (!raw) return out;
  for (const part of raw.split(';')) {
    const i = part.indexOf('=');
    if (i === -1) continue;
    const k = part.slice(0, i).trim();
    const v = part.slice(i + 1).trim();
    if (k) out[k] = decodeURIComponent(v);
  }
  return out;
}

export function setSessionCookie(res, token, maxAgeSec = 30 * 86400) {
  res.setHeader(
    'Set-Cookie',
    `${COOKIE_NAME}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSec}`
  );
}

export function clearSessionCookie(res) {
  res.setHeader('Set-Cookie', `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
}

// ===== 从请求解析当前用户 =====
export function currentUser(req) {
  const cookies = parseCookies(req);
  const token = cookies[COOKIE_NAME] || req.headers['x-session-token'];
  if (!token) return null;
  const session = store.getSession(token);
  if (!session) return null;
  const user = store.findUserById(session.userId);
  if (!user) return null;
  return { user, token };
}

/**
 * 认证中间件：要求已登录，否则 401
 */
export function requireAuth(req, res, next) {
  const ctx = currentUser(req);
  if (!ctx) return res.status(401).json({ error: '请先登录' });
  req.user = ctx.user;
  req.sessionToken = ctx.token;
  next();
}

// ===== 输入校验 =====
export function validateEmail(email) {
  const v = String(email || '').trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(v)) return null;
  if (v.length > 120) return null;
  return v;
}

export function validatePassword(pwd) {
  const v = String(pwd || '');
  if (v.length < 6) return '密码至少 6 位';
  if (v.length > 128) return '密码太长';
  return null;
}
