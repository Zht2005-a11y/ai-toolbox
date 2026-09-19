import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';

import { startServer, stopServer, cookieOf, jsonPost, apiGet, rmDir } from '../helpers.js';

let srv;
let base;
let cookie = null;
const email = `api_${Date.now()}@example.com`;
const PASS_OLD = 'oldpass123';
const PASS_NEW = 'newpass456';

before(async () => {
  srv = await startServer();
  base = srv.base;
});

after(() => {
  stopServer(srv);
  if (srv) rmDir(srv.dataDir);
});

// ============================================================
// 基础可用性与安全
// ============================================================

test('健康检查返回 ok', async () => {
  const r = await apiGet(base, '/api/health');
  assert.equal(r.status, 200);
  const d = await r.json();
  assert.equal(d.ok, true);
  assert.equal(d.features.auth, true);
});

test('静态页面可访问', async () => {
  for (const p of ['/index.html', '/login.html', '/reset.html', '/report.html']) {
    const r = await apiGet(base, p);
    assert.equal(r.status, 200, `${p} 应返回 200`);
  }
});

test('敏感文件被拦截（.env / 后端源码 / node_modules）', async () => {
  for (const p of ['/.env', '/server.js', '/package.json', '/node_modules/express/package.json']) {
    const r = await apiGet(base, p);
    assert.equal(r.status, 404, `${p} 应返回 404`);
  }
});

// ============================================================
// 登录守卫
// ============================================================

test('未登录访问 /rag.html：服务端直接 302 到登录页（不渲染页面）', async () => {
  const r = await fetch(base + '/rag.html', { redirect: 'manual' });
  assert.equal(r.status, 302);
  assert.equal(r.headers.get('location'), '/login.html?next=rag.html');
  const body = await r.text();
  assert.ok(!body.includes('知识库问答'), '302 响应不应带页面正文');
});

test('未登录调用需要登录的接口：全部 401', async () => {
  for (const p of ['/api/docs', '/api/wiki']) {
    const r = await apiGet(base, p);
    assert.equal(r.status, 401, `${p} 未登录应为 401`);
  }
  const r2 = await jsonPost(base, '/api/docs', { name: 'a.txt', type: 'txt', text: 'hello' });
  assert.equal(r2.status, 401);
});

test('未登录 /api/auth/me 返回 user:null', async () => {
  const r = await apiGet(base, '/api/auth/me');
  const d = await r.json();
  assert.equal(d.user, null);
});

// ============================================================
// 注册 / 登录 / 登出
// ============================================================

test('注册成功并下发会话 cookie', async () => {
  const r = await jsonPost(base, '/api/auth/register', { email, password: PASS_OLD });
  assert.equal(r.status, 200);
  const d = await r.json();
  assert.equal(d.ok, true);
  assert.equal(d.user.email, email);
  cookie = cookieOf(r);
  assert.ok(cookie, '应拿到 aitool_sid');
});

test('已登录访问 /rag.html 返回 200 且是知识库页面', async () => {
  const r = await fetch(base + '/rag.html', { headers: { Cookie: cookie }, redirect: 'manual' });
  assert.equal(r.status, 200);
  const body = await r.text();
  assert.ok(body.includes('知识库问答'));
});

test('已登录 /api/auth/me 返回用户信息', async () => {
  const r = await apiGet(base, '/api/auth/me', cookie);
  const d = await r.json();
  assert.equal(d.user.email, email);
});

test('注册校验：重复邮箱 409 / 弱密码 400 / 邮箱格式 400', async () => {
  let r = await jsonPost(base, '/api/auth/register', { email, password: PASS_OLD });
  assert.equal(r.status, 409);

  r = await jsonPost(base, '/api/auth/register', { email: 'weak@example.com', password: '123' });
  assert.equal(r.status, 400);

  r = await jsonPost(base, '/api/auth/register', { email: 'not-an-email', password: 'abc123456' });
  assert.equal(r.status, 400);
});

test('登录校验：错密码 401 / 正确密码 200', async () => {
  let r = await jsonPost(base, '/api/auth/login', { email, password: 'wrongpass' });
  assert.equal(r.status, 401);

  r = await jsonPost(base, '/api/auth/login', { email, password: PASS_OLD });
  assert.equal(r.status, 200);
  assert.ok(cookieOf(r), '登录应下发新 cookie');
});

// ============================================================
// 文档接口（不触发真实模型调用）
// ============================================================

let docId = null;

test('文档列表：已登录时为空数组', async () => {
  const r = await apiGet(base, '/api/docs', cookie);
  assert.equal(r.status, 200);
  const d = await r.json();
  assert.deepEqual(d.docs, []);
});

test('上传校验：空内容返回 400', async () => {
  const r = await jsonPost(base, '/api/docs', { name: 'empty.txt', type: 'txt', text: '   ' }, cookie);
  assert.equal(r.status, 400);
});

test('上传文档：返回 ok 并进入列表', async () => {
  const r = await jsonPost(
    base,
    '/api/docs',
    { name: '测试文档.txt', type: 'txt', text: '第一段内容。第二段内容。第三段内容。' },
    cookie
  );
  assert.equal(r.status, 200);
  const d = await r.json();
  assert.equal(d.ok, true);
  docId = d.doc.id;

  const list = await (await apiGet(base, '/api/docs', cookie)).json();
  assert.equal(list.docs.length, 1);
  assert.equal(list.docs[0].name, '测试文档.txt');
});

test('删除文档：从列表中移除', async () => {
  const r = await fetch(`${base}/api/docs/${docId}`, { method: 'DELETE', headers: { Cookie: cookie } });
  assert.equal(r.status, 200);
  const list = await (await apiGet(base, '/api/docs', cookie)).json();
  assert.equal(list.docs.length, 0);
});

test('删除不存在的文档返回 404', async () => {
  const r = await fetch(`${base}/api/docs/d_not_exist`, { method: 'DELETE', headers: { Cookie: cookie } });
  assert.equal(r.status, 404);
});

test('知识库：已登录但无内容时返回空 index 与空词条', async () => {
  const r = await apiGet(base, '/api/wiki', cookie);
  assert.equal(r.status, 200);
  const d = await r.json();
  assert.equal(d.index, '');
  assert.deepEqual(d.pages, []);
});

// ============================================================
// 忘记密码 / 重置密码
// ============================================================

test('申请重置：未注册邮箱也返回成功，但不给验证码（不泄露账号存在性）', async () => {
  const r = await jsonPost(base, '/api/auth/forgot', { email: `nobody_${Date.now()}@example.com` });
  assert.equal(r.status, 200);
  const d = await r.json();
  assert.equal(d.ok, true);
  assert.equal(d.devCode, undefined);
});

test('申请重置：邮箱格式错误返回 400', async () => {
  const r = await jsonPost(base, '/api/auth/forgot', { email: 'bad-email' });
  assert.equal(r.status, 400);
});

let firstCode = null;
let firstToken = null;

test('申请重置：已注册邮箱返回验证码与重置链接（本地模式）', async () => {
  const r = await jsonPost(base, '/api/auth/forgot', { email });
  assert.equal(r.status, 200);
  const d = await r.json();
  assert.match(d.devCode, /^\d{6}$/);
  assert.ok(d.devLink.includes('/reset.html?token='));
  firstCode = d.devCode;
  firstToken = new URL(d.devLink).searchParams.get('token');
});

test('校验重置链接：有效 token 通过、无效 token 400', async () => {
  const ok = await apiGet(base, `/api/auth/reset/check?token=${firstToken}`);
  assert.equal(ok.status, 200);
  const d = await ok.json();
  assert.equal(d.ok, true);
  assert.ok(d.email.includes('***'), '邮箱应打码');

  const bad = await apiGet(base, '/api/auth/reset/check?token=bogus');
  assert.equal(bad.status, 400);
});

test('重置密码：错误验证码被拒', async () => {
  const r = await jsonPost(base, '/api/auth/reset', { email, code: '000000', password: PASS_NEW });
  assert.equal(r.status, 400);
});

test('重置密码：弱密码被拒', async () => {
  const r = await jsonPost(base, '/api/auth/reset', { email, code: firstCode, password: '123' });
  assert.equal(r.status, 400);
});

test('重置密码：验证码正确 → 改密成功 → 旧会话失效 → 新密码可登录', async () => {
  const r = await jsonPost(base, '/api/auth/reset', { email, code: firstCode, password: PASS_NEW });
  assert.equal(r.status, 200);
  assert.equal((await r.json()).ok, true);

  // 旧会话被踢掉
  const me = await (await apiGet(base, '/api/auth/me', cookie)).json();
  assert.equal(me.user, null, '改密后旧会话应失效');

  // 旧密码不可用
  const old = await jsonPost(base, '/api/auth/login', { email, password: PASS_OLD });
  assert.equal(old.status, 401);

  // 新密码可用
  const fresh = await jsonPost(base, '/api/auth/login', { email, password: PASS_NEW });
  assert.equal(fresh.status, 200);
});

test('重置密码：邮件链接方式（token）同样可用，且 token 一次性', async () => {
  const apply = await jsonPost(base, '/api/auth/forgot', { email });
  const token = new URL((await apply.json()).devLink).searchParams.get('token');

  const r = await jsonPost(base, '/api/auth/reset', { token, password: 'thirdpass789' });
  assert.equal(r.status, 200);

  const reuse = await jsonPost(base, '/api/auth/reset', { token, password: 'fourthpass000' });
  assert.equal(reuse.status, 400, '同一个 token 不能二次使用');
});

test('重置密码：缺验证码或邮箱时返回 400', async () => {
  let r = await jsonPost(base, '/api/auth/reset', { email, password: 'whatever123' });
  assert.equal(r.status, 400);
  r = await jsonPost(base, '/api/auth/reset', { code: '123456', password: 'whatever123' });
  assert.equal(r.status, 400);
});

test('申请重置：频繁请求会被限流（429）', async () => {
  let limited = false;
  for (let i = 0; i < 10; i++) {
    const r = await jsonPost(base, '/api/auth/forgot', { email });
    if (r.status === 429) {
      limited = true;
      break;
    }
  }
  assert.equal(limited, true, '连续申请应触发限流');
});
