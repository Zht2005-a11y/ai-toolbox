import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';

import { tmpDir, rmDir } from '../helpers.js';

const dir = tmpDir('aitool-auth-');
process.env.DATA_DIR = dir;

const auth = await import('../../lib/auth.js');
const store = await import('../../lib/store.js');

test.after(() => rmDir(dir));

test('hashPassword：同一密码 + 同一 salt 结果稳定', () => {
  const a = auth.hashPassword('secret123', 'fixed-salt');
  const b = auth.hashPassword('secret123', 'fixed-salt');
  assert.equal(a.hash, b.hash);
  assert.equal(a.salt, 'fixed-salt');
});

test('hashPassword：自动生成随机 salt', () => {
  const a = auth.hashPassword('secret123');
  const b = auth.hashPassword('secret123');
  assert.notEqual(a.salt, b.salt, '两次盐值不应相同');
  assert.notEqual(a.hash, b.hash, '盐不同则哈希不同');
});

test('verifyPassword：正确密码通过、错误密码拒绝', () => {
  const { hash, salt } = auth.hashPassword('secret123');
  assert.equal(auth.verifyPassword('secret123', hash, salt), true);
  assert.equal(auth.verifyPassword('secret124', hash, salt), false);
  assert.equal(auth.verifyPassword('', hash, salt), false);
});

test('verifyPassword：哈希被篡改时返回 false 而不抛异常', () => {
  const { hash, salt } = auth.hashPassword('secret123');
  assert.equal(auth.verifyPassword('secret123', 'zzzz' + hash.slice(4), salt), false);
  assert.equal(auth.verifyPassword('secret123', 'not-hex-at-all', salt), false);
});

test('validateEmail：合法邮箱归一化（去空格 + 转小写）', () => {
  assert.equal(auth.validateEmail('  User@Example.COM '), 'user@example.com');
});

test('validateEmail：非法邮箱返回 null', () => {
  for (const bad of ['', 'no-at', 'a@b', 'a@b.c', '@example.com', 'a b@example.com', null, undefined]) {
    assert.equal(auth.validateEmail(bad), null, `应拒绝: ${bad}`);
  }
});

test('validateEmail：超长邮箱返回 null', () => {
  assert.equal(auth.validateEmail('a'.repeat(120) + '@example.com'), null);
});

test('validatePassword：长度校验', () => {
  assert.equal(auth.validatePassword('12345'), '密码至少 6 位');
  assert.equal(auth.validatePassword('123456'), null);
  assert.equal(auth.validatePassword('a'.repeat(129)), '密码太长');
});

test('parseCookies：解析多个 cookie 并做 URL 解码', () => {
  const out = auth.parseCookies({ headers: { cookie: 'a=1; b=hello%20world; c=' } });
  assert.equal(out.a, '1');
  assert.equal(out.b, 'hello world');
  assert.equal(out.c, '');
});

test('parseCookies：无 cookie 头时返回空对象', () => {
  assert.deepEqual(auth.parseCookies({ headers: {} }), {});
});

test('setSessionCookie：带 HttpOnly / SameSite / Path', () => {
  const headers = {};
  const res = { setHeader: (k, v) => (headers[k] = v) };
  auth.setSessionCookie(res, 'tok123');
  const c = headers['Set-Cookie'];
  assert.match(c, /^aitool_sid=tok123;/);
  assert.match(c, /HttpOnly/);
  assert.match(c, /SameSite=Lax/);
  assert.match(c, /Path=\//);
});

test('clearSessionCookie：立即过期', () => {
  const headers = {};
  const res = { setHeader: (k, v) => (headers[k] = v) };
  auth.clearSessionCookie(res);
  assert.match(headers['Set-Cookie'], /Max-Age=0/);
});

test('currentUser：无 token / 失效 token 都返回 null', () => {
  assert.equal(auth.currentUser({ headers: {} }), null);
  assert.equal(auth.currentUser({ headers: { cookie: 'aitool_sid=bogus' } }), null);
});

test('currentUser：有效会话返回用户，并支持 x-session-token', () => {
  const user = store.createUser({ email: 'cu@example.com', passwordHash: 'h', salt: 's' });
  const session = store.createSession(user.id);
  const ctx = auth.currentUser({ headers: { cookie: `aitool_sid=${session.token}` } });
  assert.equal(ctx.user.id, user.id);
  assert.equal(ctx.token, session.token);

  const ctx2 = auth.currentUser({ headers: { 'x-session-token': session.token } });
  assert.equal(ctx2 && ctx2.user.id, user.id);
});

test('requireAuth：未登录回 401，已登录放行', () => {
  let status = null;
  const res = { status: (s) => ({ json: () => (status = s) }) };
  const req = { headers: {} };
  let nextCalled = false;
  auth.requireAuth(req, res, () => (nextCalled = true));
  assert.equal(status, 401);
  assert.equal(nextCalled, false);

  const user = store.createUser({ email: 'ra@example.com', passwordHash: 'h', salt: 's' });
  const session = store.createSession(user.id);
  const req2 = { headers: { cookie: `aitool_sid=${session.token}` } };
  auth.requireAuth(req2, res, () => (nextCalled = true));
  assert.equal(nextCalled, true);
  assert.equal(req2.user.id, user.id);
});

test('数据目录用的是测试临时目录，没污染真实 data/', () => {
  assert.equal(fs.existsSync(dir), true);
  assert.equal(fs.existsSync(path.join(dir, 'db.json')), true);
});
