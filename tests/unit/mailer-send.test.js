import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'http';

// 用本地假发信服务验证「已配置」路径（独立进程，避免环境变量互相污染）
let lastReq = null;
let shouldFail = false;

const fake = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    lastReq = { url: req.url, auth: req.headers.authorization, body: JSON.parse(body || '{}') };
    if (shouldFail) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end('{"error":"boom"}');
    } else {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ id: 'msg_1' }));
    }
  });
});

await new Promise((r) => fake.listen(0, '127.0.0.1', r));
const port = fake.address().port;

process.env.MAIL_API_URL = `http://127.0.0.1:${port}/emails`;
process.env.MAIL_API_KEY = 'test-key';
process.env.MAIL_FROM = 'AI 工具箱 <noreply@example.com>';

const mailer = await import('../../lib/mailer.js');

test.after(() => fake.close());

test('配置了发信服务时 enabled 为 true 且使用自定义 from', () => {
  assert.equal(mailer.mailConfig.enabled, true);
  assert.equal(mailer.mailConfig.from, 'AI 工具箱 <noreply@example.com>');
});

test('sendMail：成功时返回 ok:true 并带上鉴权、收件人、主题', async () => {
  const r = await mailer.sendMail({
    to: 'user@example.com',
    subject: '重置你的密码',
    html: '<p>验证码 123456</p>',
  });
  assert.equal(r.ok, true);
  assert.equal(lastReq.url, '/emails');
  assert.equal(lastReq.auth, 'Bearer test-key');
  assert.deepEqual(lastReq.body.to, ['user@example.com']);
  assert.equal(lastReq.body.subject, '重置你的密码');
  assert.equal(lastReq.body.from, 'AI 工具箱 <noreply@example.com>');
  assert.match(lastReq.body.html, /123456/);
});

test('sendMail：会带上纯文本备选内容（去标签）', async () => {
  await mailer.sendMail({ to: 'u@example.com', subject: 's', html: '<p>验证码 654321</p>' });
  assert.match(String(lastReq.body.text), /654321/);
  assert.ok(!String(lastReq.body.text).includes('<p>'), '纯文本不应残留标签');
});

test('sendMail：上游返回 5xx 时降级为 ok:false 而不抛异常', async () => {
  shouldFail = true;
  const r = await mailer.sendMail({ to: 'u@example.com', subject: 's', html: '<p>x</p>' });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'upstream');
  shouldFail = false;
});

test('sendMail：服务不可达时降级为 ok:false', async () => {
  fake.close();
  const r = await mailer.sendMail({ to: 'u@example.com', subject: 's', html: '<p>x</p>' });
  assert.equal(r.ok, false);
  assert.ok(r.reason && r.reason !== '', '应带上失败原因');
});
