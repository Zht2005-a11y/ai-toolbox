import test from 'node:test';
import assert from 'node:assert/strict';

// 未配置邮件服务时的降级行为（必须在 import 前清空环境变量）
delete process.env.MAIL_API_URL;
delete process.env.MAIL_API_KEY;
delete process.env.MAIL_FROM;

const mailer = await import('../../lib/mailer.js');

test('未配置邮件时 mailConfig.enabled 为 false', () => {
  assert.equal(mailer.mailConfig.enabled, false);
});

test('未配置邮件时 from 有兜底值', () => {
  assert.equal(typeof mailer.mailConfig.from, 'string');
  assert.ok(mailer.mailConfig.from.includes('<'), '应形如 "名称 <邮箱>"');
});

test('未配置邮件时 sendMail 返回 ok:false 而不是抛异常', async () => {
  const r = await mailer.sendMail({ to: 'a@example.com', subject: 's', html: '<p>hi</p>' });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'mail-not-configured');
});
