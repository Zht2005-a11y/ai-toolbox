// 零依赖邮件发送：直接 fetch 一个「发信 API」（默认兼容 Resend 的 /emails 接口）。
// 未配置时不抛错，返回 { ok:false, reason:'mail-not-configured' }，由调用方降级处理。

const API_URL = process.env.MAIL_API_URL || '';
const API_KEY = process.env.MAIL_API_KEY || '';
const FROM = process.env.MAIL_FROM || 'AI 工具箱 <onboarding@resend.dev>';

export const mailConfig = {
  enabled: Boolean(API_URL && API_KEY),
  from: FROM,
};

export async function sendMail({ to, subject, html, text }) {
  if (!mailConfig.enabled) return { ok: false, reason: 'mail-not-configured' };

  try {
    const res = await fetch(API_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: mailConfig.from,
        to: [to],
        subject,
        html,
        text: text || String(html || '').replace(/<[^>]+>/g, ''),
      }),
    });

    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      console.error('[mail] 发送失败:', res.status, detail.slice(0, 300));
      return { ok: false, reason: 'upstream' };
    }
    return { ok: true };
  } catch (e) {
    console.error('[mail] 发送异常:', e.message);
    return { ok: false, reason: e.message };
  }
}
