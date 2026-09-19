import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';

import { tmpDir, rmDir } from '../helpers.js';

const dir = tmpDir('aitool-store-');
process.env.DATA_DIR = dir;

const store = await import('../../lib/store.js');
const auth = await import('../../lib/auth.js');

test.after(() => rmDir(dir));

const newUser = (email) => {
  const { hash, salt } = auth.hashPassword('pwd123456');
  return store.createUser({ email, passwordHash: hash, salt });
};

// ===== 用户 =====
test('createUser / findUserByEmail：邮箱大小写与空格归一化', () => {
  const u = newUser('  MixedCase@Example.COM ');
  assert.equal(u.email, 'mixedcase@example.com');
  assert.ok(store.findUserByEmail('mixedcase@example.com'));
  assert.ok(store.findUserByEmail('MIXEDCASE@EXAMPLE.COM'));
  assert.equal(store.findUserByEmail('nobody@example.com'), null);
});

test('findUserById：按 id 命中', () => {
  const u = newUser('byid@example.com');
  assert.equal(store.findUserById(u.id).email, 'byid@example.com');
  assert.equal(store.findUserById('u_not_exist'), null);
});

test('setUserPassword：改密后旧密码失效、新密码可用', () => {
  const u = newUser('changepwd@example.com');
  assert.equal(auth.verifyPassword('pwd123456', u.passwordHash, u.salt), true);

  const { hash, salt } = auth.hashPassword('newpwd999');
  store.setUserPassword(u.id, { passwordHash: hash, salt });

  const fresh = store.findUserById(u.id);
  assert.equal(auth.verifyPassword('pwd123456', fresh.passwordHash, fresh.salt), false);
  assert.equal(auth.verifyPassword('newpwd999', fresh.passwordHash, fresh.salt), true);
  assert.ok(fresh.passwordUpdatedAt, '应记录改密时间');
});

test('setUserPassword：用户不存在返回 null', () => {
  assert.equal(store.setUserPassword('u_nope', { passwordHash: 'x', salt: 'y' }), null);
});

// ===== 会话 =====
test('createSession / getSession：可查到且带过期时间', () => {
  const u = newUser('sess@example.com');
  const s = store.createSession(u.id);
  assert.equal(store.getSession(s.token).userId, u.id);
  assert.ok(new Date(s.expiresAt) > new Date());
});

test('getSession：未知 token 与已过期会话返回 null', () => {
  assert.equal(store.getSession(''), null);
  assert.equal(store.getSession('bogus'), null);

  const u = newUser('expired@example.com');
  const s = store.createSession(u.id);
  s.expiresAt = new Date(Date.now() - 1000).toISOString();
  assert.equal(store.getSession(s.token), null);
});

test('deleteSession / deleteUserSessions：只影响目标会话', () => {
  const a = newUser('sa@example.com');
  const b = newUser('sb@example.com');
  const s1 = store.createSession(a.id);
  const s2 = store.createSession(a.id);
  const s3 = store.createSession(b.id);

  store.deleteSession(s1.token);
  assert.equal(store.getSession(s1.token), null);
  assert.ok(store.getSession(s2.token));

  store.deleteUserSessions(a.id);
  assert.equal(store.getSession(s2.token), null, 'a 的会话应全部清除');
  assert.ok(store.getSession(s3.token), 'b 的会话不应受影响');
});

// ===== 密码重置 =====
test('createReset：生成 token 与 6 位数字验证码', () => {
  const u = newUser('reset1@example.com');
  const rec = store.createReset(u.id);
  assert.match(rec.token, /^[0-9a-f]{48}$/);
  assert.match(rec.code, /^\d{6}$/);
  assert.equal(rec.used, false);
});

test('findReset：token 与 code 都能查到，且自动清理过期记录', () => {
  const u = newUser('reset2@example.com');
  const rec = store.createReset(u.id);
  assert.equal(store.findReset(rec.token).userId, u.id);
  assert.equal(store.findReset(rec.code).userId, u.id);
  assert.equal(store.findReset('000000'), null);

  // 手动把这条置为过期
  const stale = store.createReset(u.id);
  stale.expiresAt = Date.now() - 1;
  assert.equal(store.findReset(stale.token), null, '过期记录应查不到');
  assert.equal(store.findReset(stale.code), null);
});

test('consumeReset：核销后不能再用（一次性）', () => {
  const u = newUser('reset3@example.com');
  const rec = store.createReset(u.id);
  assert.equal(store.consumeReset(rec.token), true);
  assert.equal(store.findReset(rec.token), null, '核销后 token 失效');
  assert.equal(store.findReset(rec.code), null, '核销后 code 也失效');
  assert.equal(store.consumeReset(rec.token), false, '重复核销返回 false');
});

// ===== 文档 =====
test('文档 CRUD：创建 → 列表 → 更新 → 删除', () => {
  const u = newUser('doc@example.com');
  const d = store.createDoc({ userId: u.id, name: 'a.txt', type: 'txt', chars: 100, chunkCount: 2 });
  assert.equal(store.listDocs(u.id).length, 1);
  assert.equal(store.getDoc(u.id, d.id).name, 'a.txt');
  assert.equal(store.getDoc('other-user', d.id), null, '文档按 userId 隔离');

  store.updateDoc(d.id, { status: 'done', pageCount: 3 });
  assert.equal(store.getDoc(u.id, d.id).status, 'done');

  assert.equal(store.deleteDoc(u.id, d.id), true);
  assert.equal(store.deleteDoc(u.id, d.id), false, '重复删除返回 false');
});

test('saveContent / loadContent：原文可读写', () => {
  const d = store.createDoc({ userId: 'u_content', name: 'c.txt', type: 'txt', chars: 3, chunkCount: 1 });
  store.saveContent(d.id, ['第一段', '第二段']);
  assert.deepEqual(store.loadContent(d.id), ['第一段', '第二段']);
  assert.equal(store.loadContent('d_missing'), null);
});

// ===== Wiki 文件层 =====
test('wiki 文件：写页 → 列页 → 读页 → 删页', () => {
  const uid = 'u_wiki';
  store.writePage(uid, 'term-a', '---\ntitle: 词条A\n---\n正文');
  assert.deepEqual(store.listPages(uid), ['term-a']);
  assert.match(store.readPage(uid, 'term-a'), /title: 词条A/);
  assert.equal(store.readPage(uid, 'nope'), null);

  assert.equal(store.deletePage(uid, 'term-a'), true);
  assert.deepEqual(store.listPages(uid), []);
});

test('readPage：slug 里的路径穿越字符被清理', () => {
  assert.equal(store.readPage('u_x', '../../etc/passwd'), null);
});

test('writeWikiFile / readWikiFile / appendLog', () => {
  const uid = 'u_wiki2';
  store.writeWikiFile(uid, 'index.md', '# 目录');
  assert.equal(store.readWikiFile(uid, 'index.md'), '# 目录');
  assert.equal(store.readWikiFile(uid, 'missing.md'), null);

  store.appendLog(uid, '测试日志');
  assert.match(store.readWikiFile(uid, 'log.md'), /测试日志/);
});

// ===== 工具 =====
test('slugify：清理非法字符并截断', () => {
  assert.equal(store.slugify('Hybrid/Analysis: 混合分析?'), 'HybridAnalysis-混合分析');
  assert.equal(store.slugify('  '), 'page', '空标题回落为 page');
  assert.ok(store.slugify('x'.repeat(200)).length <= 60);
});

test('原子写：db.json 落盘且不残留 .tmp 文件', () => {
  assert.equal(fs.existsSync(path.join(dir, 'db.json')), true);
  const leftovers = fs.readdirSync(dir).filter((f) => f.endsWith('.tmp'));
  assert.deepEqual(leftovers, []);
});
