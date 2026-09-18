import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { ROOT } from './llm.js';

const DATA_DIR = path.join(ROOT, 'data');
const CONTENT_DIR = path.join(DATA_DIR, 'content');
const WIKI_DIR = path.join(DATA_DIR, 'wiki');
const DB_FILE = path.join(DATA_DIR, 'db.json');

for (const d of [DATA_DIR, CONTENT_DIR, WIKI_DIR]) {
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
}

// ===== 原子写：先写临时文件再 rename，避免进程中断导致文件半截 =====
function writeAtomic(file, text) {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, text, 'utf8');
  fs.renameSync(tmp, file);
}

const EMPTY_DB = { users: [], sessions: [], docs: [], resets: [] };

let db = null;

function load() {
  if (db) return db;
  try {
    db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
    for (const k of ['users', 'sessions', 'docs', 'resets']) if (!Array.isArray(db[k])) db[k] = [];
  } catch (e) {
    db = JSON.parse(JSON.stringify(EMPTY_DB));
  }
  return db;
}

function persist() {
  writeAtomic(DB_FILE, JSON.stringify(db, null, 2));
}

export function newId(prefix = '') {
  return prefix + crypto.randomBytes(9).toString('hex');
}

// ===== 用户 =====
export function findUserByEmail(email) {
  const d = load();
  const key = String(email || '').trim().toLowerCase();
  return d.users.find((u) => u.email === key) || null;
}

export function findUserById(id) {
  return load().users.find((u) => u.id === id) || null;
}

export function createUser({ email, passwordHash, salt }) {
  const d = load();
  const user = {
    id: newId('u_'),
    email: String(email).trim().toLowerCase(),
    passwordHash,
    salt,
    createdAt: new Date().toISOString(),
  };
  d.users.push(user);
  persist();
  return user;
}

// ===== 会话 =====
const SESSION_DAYS = 30;

export function setUserPassword(userId, { passwordHash, salt }) {
  const d = load();
  const user = d.users.find((u) => u.id === userId);
  if (!user) return null;
  user.passwordHash = passwordHash;
  user.salt = salt;
  user.passwordUpdatedAt = new Date().toISOString();
  persist();
  return user;
}

export function createSession(userId) {
  const d = load();
  const now = Date.now();
  const session = {
    token: crypto.randomBytes(32).toString('hex'),
    userId,
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + SESSION_DAYS * 86400000).toISOString(),
  };
  d.sessions.push(session);
  // 顺手清理过期会话
  d.sessions = d.sessions.filter((s) => new Date(s.expiresAt).getTime() > now);
  persist();
  return session;
}

export function getSession(token) {
  if (!token) return null;
  const s = load().sessions.find((x) => x.token === token);
  if (!s) return null;
  if (new Date(s.expiresAt).getTime() < Date.now()) return null;
  return s;
}

export function deleteSession(token) {
  const d = load();
  const before = d.sessions.length;
  d.sessions = d.sessions.filter((s) => s.token !== token);
  if (d.sessions.length !== before) persist();
}

export function deleteUserSessions(userId) {
  const d = load();
  const before = d.sessions.length;
  d.sessions = d.sessions.filter((s) => s.userId !== userId);
  if (d.sessions.length !== before) persist();
}

// ===== 密码重置 =====
const RESET_TTL_MS = 15 * 60 * 1000;

function pruneResets() {
  const d = load();
  const now = Date.now();
  d.resets = (d.resets || []).filter((r) => !r.used && r.expiresAt > now);
  return d;
}

/** 创建一个重置记录：token 用于邮件链接，code 是 6 位短码用于手填 */
export function createReset(userId) {
  const d = pruneResets();
  const now = Date.now();
  const rec = {
    token: crypto.randomBytes(24).toString('hex'),
    code: String(crypto.randomInt(100000, 1000000)),
    userId,
    createdAt: new Date(now).toISOString(),
    expiresAt: now + RESET_TTL_MS,
    used: false,
  };
  d.resets.push(rec);
  persist();
  return rec;
}

/** 按 token 或 code 查找有效（未使用、未过期）的重置记录 */
export function findReset(tokenOrCode) {
  const key = String(tokenOrCode || '').trim();
  if (!key) return null;
  const r = pruneResets().resets.find((x) => x.token === key || x.code === key);
  if (!r) return null;
  if (r.expiresAt <= Date.now()) return null;
  return r;
}

export function consumeReset(token) {
  const d = load();
  const r = (d.resets || []).find((x) => x.token === token);
  if (!r) return false;
  r.used = true;
  r.usedAt = new Date().toISOString();
  persist();
  return true;
}

// ===== 文档元数据 =====
export function listDocs(userId) {
  return load()
    .docs.filter((x) => x.userId === userId)
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
}

export function getDoc(userId, docId) {
  return load().docs.find((x) => x.id === docId && x.userId === userId) || null;
}

export function createDoc({ userId, name, type, chars, chunkCount }) {
  const d = load();
  const doc = {
    id: newId('d_'),
    userId,
    name,
    type,
    chars,
    chunkCount,
    status: 'pending', // pending | compiling | done | error
    error: null,
    pageSlugs: [],
    createdAt: new Date().toISOString(),
    compiledAt: null,
  };
  d.docs.push(doc);
  persist();
  return doc;
}

export function updateDoc(docId, patch) {
  const d = load();
  const doc = d.docs.find((x) => x.id === docId);
  if (!doc) return null;
  Object.assign(doc, patch);
  persist();
  return doc;
}

export function deleteDoc(userId, docId) {
  const d = load();
  const doc = d.docs.find((x) => x.id === docId && x.userId === userId);
  if (!doc) return false;
  d.docs = d.docs.filter((x) => !(x.id === docId && x.userId === userId));
  persist();
  try {
    fs.unlinkSync(contentFile(docId));
  } catch (e) {}
  return true;
}

// ===== 文档原文（切分后）=====
function contentFile(docId) {
  return path.join(CONTENT_DIR, `${docId}.json`);
}

export function saveContent(docId, chunks) {
  writeAtomic(contentFile(docId), JSON.stringify(chunks));
}

export function loadContent(docId) {
  try {
    return JSON.parse(fs.readFileSync(contentFile(docId), 'utf8'));
  } catch (e) {
    return null;
  }
}

// ===== Wiki 文件层（每个用户一个独立目录）=====
export function wikiDir(userId) {
  const dir = path.join(WIKI_DIR, userId);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function pagesDir(userId) {
  const dir = path.join(wikiDir(userId), 'pages');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function readWikiFile(userId, name) {
  try {
    return fs.readFileSync(path.join(wikiDir(userId), name), 'utf8');
  } catch (e) {
    return null;
  }
}

export function writeWikiFile(userId, name, text) {
  writeAtomic(path.join(wikiDir(userId), name), text);
}

export function appendLog(userId, line) {
  const file = path.join(wikiDir(userId), 'log.md');
  const stamp = new Date().toISOString().replace('T', ' ').slice(0, 16);
  fs.appendFileSync(file, `## [${stamp}] ${line}\n`);
}

export function listPages(userId) {
  const dir = pagesDir(userId);
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.md'))
    .map((f) => f.slice(0, -3))
    .sort();
}

export function readPage(userId, slug) {
  const safe = String(slug).replace(/[^a-zA-Z0-9\u4e00-\u9fa5_-]/g, '');
  if (!safe) return null;
  try {
    return fs.readFileSync(path.join(pagesDir(userId), `${safe}.md`), 'utf8');
  } catch (e) {
    return null;
  }
}

export function writePage(userId, slug, text) {
  writeAtomic(path.join(pagesDir(userId), `${slug}.md`), text);
}

export function deletePage(userId, slug) {
  try {
    fs.unlinkSync(path.join(pagesDir(userId), `${slug}.md`));
    return true;
  } catch (e) {
    return false;
  }
}

// 把标题转成安全的文件名 slug
export function slugify(title) {
  const base = String(title || '')
    .trim()
    .replace(/[\\/:*?"<>|#\[\]()]/g, '')
    .replace(/\s+/g, '-')
    .slice(0, 60);
  return base || 'page';
}

export { DATA_DIR, WIKI_DIR, DB_FILE };
