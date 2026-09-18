import express from 'express';
import path from 'path';
import fs from 'fs';
import { llmConfig, pipeStream, chat, ROOT } from './lib/llm.js';
import * as store from './lib/store.js';
import * as auth from './lib/auth.js';
import * as wiki from './lib/wiki.js';
import { chunkText } from './lib/chunk.js';
import * as mailer from './lib/mailer.js';

const app = express();
app.use(express.json({ limit: '20mb' }));

const PORT = process.env.PORT || 3000;
const MAX_DOC_CHARS = Math.max(100000, Number(process.env.MAX_DOC_CHARS || 1500000));

// ============================================================
// 认证
// ============================================================

app.post('/api/auth/register', (req, res) => {
  try {
    const { email, password } = req.body || {};
    const mail = auth.validateEmail(email);
    if (!mail) return res.status(400).json({ error: '邮箱格式不正确' });
    const pwdErr = auth.validatePassword(password);
    if (pwdErr) return res.status(400).json({ error: pwdErr });
    if (store.findUserByEmail(mail)) return res.status(409).json({ error: '该邮箱已注册，请直接登录' });

    const { hash, salt } = auth.hashPassword(password);
    const user = store.createUser({ email: mail, passwordHash: hash, salt });
    const session = store.createSession(user.id);
    auth.setSessionCookie(res, session.token);

    return res.json({ ok: true, user: { id: user.id, email: user.email } });
  } catch (e) {
    console.error('[auth] 注册异常:', e.message);
    return res.status(500).json({ error: '注册失败，请稍后重试' });
  }
});

app.post('/api/auth/login', (req, res) => {
  try {
    const { email, password } = req.body || {};
    const mail = auth.validateEmail(email);
    if (!mail || !password) return res.status(400).json({ error: '请输入邮箱和密码' });

    const user = store.findUserByEmail(mail);
    if (!user || !auth.verifyPassword(password, user.passwordHash, user.salt)) {
      return res.status(401).json({ error: '邮箱或密码不正确' });
    }
    const session = store.createSession(user.id);
    auth.setSessionCookie(res, session.token);
    return res.json({ ok: true, user: { id: user.id, email: user.email } });
  } catch (e) {
    console.error('[auth] 登录异常:', e.message);
    return res.status(500).json({ error: '登录失败，请稍后重试' });
  }
});

app.post('/api/auth/logout', (req, res) => {
  const ctx = auth.currentUser(req);
  if (ctx) store.deleteSession(ctx.token);
  auth.clearSessionCookie(res);
  res.json({ ok: true });
});

app.get('/api/auth/me', (req, res) => {
  const ctx = auth.currentUser(req);
  if (!ctx) return res.json({ user: null });
  res.json({ user: { id: ctx.user.id, email: ctx.user.email, createdAt: ctx.user.createdAt } });
});

// ============================================================
// 忘记密码 / 重置密码
// ============================================================

// 简易限流：同一 IP 每分钟最多 5 次、每小时最多 20 次
const forgotHits = new Map();

function rateLimited(key) {
  const now = Date.now();
  const hits = (forgotHits.get(key) || []).filter((t) => now - t < 3600000);
  const recent = hits.filter((t) => now - t < 60000);
  if (recent.length >= 5 || hits.length >= 20) {
    forgotHits.set(key, hits);
    return true;
  }
  hits.push(now);
  forgotHits.set(key, hits);
  return false;
}

function originOf(req) {
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  const proto = req.headers['x-forwarded-proto'] || req.protocol || 'http';
  return `${proto}://${host}`;
}

function resetMailHtml(code, link, minutes) {
  return [
    '<div style="font-family:-apple-system,\'PingFang SC\',\'Microsoft YaHei\',sans-serif;line-height:1.7;color:#1a1d29">',
    '<h2 style="margin:0 0 14px">重置你的 AI 工具箱密码</h2>',
    `<p>我们收到了重置密码的请求。验证码 <b>${minutes}</b> 分钟内有效。</p>`,
    `<p style="font-size:26px;font-weight:800;letter-spacing:6px;margin:18px 0;color:#5b6cff">${code}</p>`,
    `<p>也可以直接点击下面的链接设置新密码：<br><a href="${link}" style="color:#5b6cff">${link}</a></p>`,
    '<p style="color:#6b7280;font-size:13px">如果不是你本人操作，忽略这封邮件即可，密码不会改变。</p>',
    '</div>',
  ].join('');
}

// 第 1 步：申请重置（不泄露邮箱是否已注册）
app.post('/api/auth/forgot', async (req, res) => {
  try {
    const email = auth.validateEmail((req.body || {}).email);
    if (!email) return res.status(400).json({ error: '邮箱格式不正确' });

    const ip = req.headers['x-forwarded-for'] || req.socket?.remoteAddress || 'unknown';
    if (rateLimited(String(ip).split(',')[0])) {
      return res.status(429).json({ error: '请求太频繁，请稍后再试' });
    }

    const user = store.findUserByEmail(email);
    const payload = { ok: true, emailed: false, devMode: !mailer.mailConfig.enabled };

    if (!user) {
      // 账号不存在也返回成功，避免被用来探测注册邮箱
      return res.json(payload);
    }

    const rec = store.createReset(user.id);
    const link = `${originOf(req)}/reset.html?token=${rec.token}`;
    const sent = await mailer.sendMail({
      to: user.email,
      subject: '重置你的 AI 工具箱密码',
      html: resetMailHtml(rec.code, link, 15),
    });

    if (sent.ok) {
      payload.emailed = true;
      payload.hint = '重置邮件已发送，请查收邮箱（含垃圾箱）';
    } else {
      // 未配置邮件服务：把验证码打到服务端日志，并在本地模式下回传，
      // 方便自部署自测。配置好 MAIL_API_URL / MAIL_API_KEY 后会自动关闭。
      console.log(`[auth] 密码重置（邮件未配置）：${user.email} 验证码 ${rec.code} 链接 ${link}`);
      payload.emailed = false;
      payload.devCode = rec.code;
      payload.devLink = link;
      payload.hint = '当前服务未配置邮件，已生成验证码，请在下方继续';
    }
    return res.json(payload);
  } catch (e) {
    console.error('[auth] 申请重置异常:', e.message);
    return res.status(500).json({ error: '操作失败，请稍后重试' });
  }
});

// 校验链接里的 token 是否仍然有效
app.get('/api/auth/reset/check', (req, res) => {
  const token = String(req.query.token || '').trim();
  const rec = store.findReset(token);
  if (!rec) return res.status(400).json({ error: '链接无效或已过期，请重新申请' });
  const user = store.findUserById(rec.userId);
  if (!user) return res.status(400).json({ error: '链接无效或已过期，请重新申请' });
  const at = user.email.indexOf('@');
  const masked = at > 1 ? user.email[0] + '***' + user.email.slice(at) : user.email;
  res.json({ ok: true, email: masked });
});

// 第 2 步：用「链接 token」或「邮箱 + 验证码」重置密码
app.post('/api/auth/reset', (req, res) => {
  try {
    const { token, code, email, password } = req.body || {};
    const pwdErr = auth.validatePassword(password);
    if (pwdErr) return res.status(400).json({ error: pwdErr });

    let rec = null;
    if (token) {
      rec = store.findReset(token);
    } else {
      const mail = auth.validateEmail(email);
      if (!mail || !code) return res.status(400).json({ error: '请填写邮箱和验证码' });
      const user = store.findUserByEmail(mail);
      if (!user) return res.status(400).json({ error: '验证码不正确或已过期' });
      const found = store.findReset(String(code).trim());
      // 验证码必须属于该邮箱，避免跨账号撞码
      if (!found || found.userId !== user.id) {
        return res.status(400).json({ error: '验证码不正确或已过期' });
      }
      rec = found;
    }
    if (!rec) return res.status(400).json({ error: '验证码不正确或已过期' });

    const user = store.findUserById(rec.userId);
    if (!user) return res.status(400).json({ error: '账号不存在' });

    const { hash, salt } = auth.hashPassword(password);
    store.setUserPassword(user.id, { passwordHash: hash, salt });
    store.consumeReset(rec.token);
    // 改密后踢掉所有旧会话，强制重新登录
    store.deleteUserSessions(user.id);

    console.log('[auth] 密码已重置:', user.email);
    res.json({ ok: true });
  } catch (e) {
    console.error('[auth] 重置密码异常:', e.message);
    res.status(500).json({ error: '重置失败，请稍后重试' });
  }
});

// ============================================================
// 文档（每个用户私有）
// ============================================================

app.get('/api/docs', auth.requireAuth, (req, res) => {
  const docs = store.listDocs(req.user.id).map((d) => ({
    id: d.id,
    name: d.name,
    type: d.type,
    chars: d.chars,
    chunkCount: d.chunkCount,
    status: d.status,
    error: d.error,
    pageCount: (d.pageSlugs || []).length,
    createdAt: d.createdAt,
    compiledAt: d.compiledAt,
  }));
  res.json({ docs, queue: wiki.queueStatus() });
});

app.post('/api/docs', auth.requireAuth, (req, res) => {
  try {
    const { name, type, text } = req.body || {};
    const docName = String(name || '').trim().slice(0, 200) || '未命名文档';
    const content = String(text || '');

    if (!content.trim()) return res.status(400).json({ error: '未能提取到文本内容' });
    if (content.length > MAX_DOC_CHARS) {
      return res.status(413).json({ error: `文档过长（${content.length} 字），请拆分后再上传` });
    }

    const chunks = chunkText(content);
    if (!chunks.length) return res.status(400).json({ error: '切分后内容为空' });

    const doc = store.createDoc({
      userId: req.user.id,
      name: docName,
      type: String(type || 'txt').toLowerCase().slice(0, 10),
      chars: content.length,
      chunkCount: chunks.length,
    });
    store.saveContent(doc.id, chunks);

    // 异步入队编译，立即返回，前端轮询状态
    wiki.enqueueCompile(req.user.id, doc.id);

    res.json({ ok: true, doc: { id: doc.id, name: doc.name, status: doc.status, chunkCount: chunks.length } });
  } catch (e) {
    console.error('[docs] 保存异常:', e.message);
    res.status(500).json({ error: '保存失败，请稍后重试' });
  }
});

app.get('/api/docs/:id', auth.requireAuth, (req, res) => {
  const doc = store.getDoc(req.user.id, req.params.id);
  if (!doc) return res.status(404).json({ error: '文档不存在' });
  const chunks = store.loadContent(doc.id) || [];
  res.json({ doc, text: chunks.map((c) => (typeof c === 'string' ? c : c.text)).join('\n\n') });
});

app.delete('/api/docs/:id', auth.requireAuth, (req, res) => {
  const ok = store.deleteDoc(req.user.id, req.params.id);
  if (!ok) return res.status(404).json({ error: '文档不存在' });
  // 删掉文档后重建目录，让 index 与实际词条保持一致
  wiki.enqueueReindex(req.user.id);
  res.json({ ok: true });
});

app.post('/api/docs/:id/recompile', auth.requireAuth, (req, res) => {
  const doc = store.getDoc(req.user.id, req.params.id);
  if (!doc) return res.status(404).json({ error: '文档不存在' });
  wiki.enqueueCompile(req.user.id, doc.id);
  res.json({ ok: true, status: 'pending' });
});

// ============================================================
// Wiki 知识库
// ============================================================

app.get('/api/wiki', auth.requireAuth, (req, res) => {
  const pages = store.listPages(req.user.id).map((slug) => {
    const raw = store.readPage(req.user.id, slug) || '';
    return {
      slug,
      title: ((raw.match(/^title:\s*(.+)$/m) || [])[1] || slug).trim(),
      type: ((raw.match(/^type:\s*(.+)$/m) || [])[1] || 'concept').trim(),
      summary: ((raw.match(/^summary:\s*(.+)$/m) || [])[1] || '').trim(),
      updated: ((raw.match(/^updated:\s*(.+)$/m) || [])[1] || '').trim(),
    };
  });
  res.json({
    index: store.readWikiFile(req.user.id, 'index.md') || '',
    pages,
    log: store.readWikiFile(req.user.id, 'log.md') || '',
  });
});

app.get('/api/wiki/page/:slug', auth.requireAuth, (req, res) => {
  const raw = store.readPage(req.user.id, req.params.slug);
  if (!raw) return res.status(404).json({ error: '词条不存在' });
  res.json({ slug: req.params.slug, content: raw });
});

app.get('/api/wiki/lint', auth.requireAuth, (req, res) => {
  res.json(wiki.lintWiki(req.user.id));
});

// ============================================================
// RAG 问答（基于已编译的 wiki）
// ============================================================

app.post('/api/rag/ask', auth.requireAuth, async (req, res) => {
  const { question } = req.body || {};
  const q = String(question || '').trim();
  if (!q) return res.status(400).json({ error: '请输入问题' });
  if (q.length > 2000) return res.status(400).json({ error: '问题过长' });

  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const send = (obj) => {
    try {
      res.write(`data: ${JSON.stringify(obj)}\n\n`);
    } catch (e) {}
  };

  try {
    await wiki.answerFromWiki(
      req.user.id,
      q,
      (delta) => send({ type: 'delta', text: delta }),
      (meta) => send({ type: 'meta', ...meta })
    );
    send({ type: 'done' });
  } catch (e) {
    console.error('[rag] 回答异常:', e.message);
    send({ type: 'error', message: e.message || '模型服务异常' });
  } finally {
    res.end();
  }
});

// ============================================================
// 通用 AI 代理（周报生成器使用）
// ============================================================

app.post('/api/chat', async (req, res) => {
  try {
    if (!llmConfig.API_KEY) return res.status(500).json({ error: '服务器未配置 AGNES_API_KEY' });
    const { messages, temperature, max_tokens, stream = false } = req.body || {};
    if (!Array.isArray(messages) || !messages.length) {
      return res.status(400).json({ error: '缺少 messages 参数' });
    }

    const opts = {
      temperature: temperature ?? 0.7,
      maxTokens: max_tokens ?? 2048,
    };

    // 流式：直接透传上游 SSE
    if (stream) {
      await pipeStream(messages, res, opts);
      return;
    }

    const text = await chat(messages, opts);
    res.json({ choices: [{ message: { role: 'assistant', content: text } }] });
  } catch (e) {
    console.error('[chat] 异常:', e.message);
    if (!res.headersSent) {
      res.status(e.status || 502).json({ error: e.message || '模型服务异常' });
    } else {
      try {
        res.end();
      } catch (_) {}
    }
  }
});

// ============================================================
// 健康检查
// ============================================================

app.get('/api/health', (req, res) => {
  res.json({
    ok: true,
    model: llmConfig.MODEL,
    keyConfigured: !!llmConfig.API_KEY,
    upstreamRetry: llmConfig.RETRY,
    wikiQueue: wiki.queueStatus(),
    features: { auth: true, wiki: true },
  });
});

// ============================================================
// 静态资源
// ============================================================

// 安全拦截：点开头文件（.env / .gitignore / .workbuddy）、后端源码、数据目录、依赖目录
const BLOCKED_FILES =
  /^\/(server\.js|package\.json|package-lock\.json|ecosystem\.config\.(cjs|js)|README\.md|DEPLOY\.md)$/i;

app.use((req, res, next) => {
  const p = req.path;
  if (/(^|\/)\./.test(p)) return res.status(404).send('Not Found');
  if (BLOCKED_FILES.test(p)) return res.status(404).send('Not Found');
  if (p.startsWith('/node_modules') || p.startsWith('/data') || p.startsWith('/lib')) {
    return res.status(404).send('Not Found');
  }
  next();
});

// 需要登录的页面：在服务端就 302，避免页面先渲染、JS 再跳走造成的「闪一下」
const AUTH_PAGES = new Set(['/rag.html']);

app.use((req, res, next) => {
  if (!AUTH_PAGES.has(req.path)) return next();
  if (!auth.currentUser(req)) return res.redirect(302, '/login.html?next=rag.html');
  next();
});

app.use(
  express.static(ROOT, {
    setHeaders(res, filePath) {
      if (filePath.endsWith('.html')) res.setHeader('Cache-Control', 'no-cache');
    },
  })
);

// 兜底：非 API 路径返回 index.html
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api/')) return next();
  res.sendFile(path.join(ROOT, 'index.html'));
});

// JSON 解析错误
app.use((err, req, res, next) => {
  if (err && err.type === 'entity.too.large') {
    return res.status(413).json({ error: '请求体过大' });
  }
  if (err) {
    console.error('[server] 未捕获错误:', err.message);
    return res.status(500).json({ error: '服务器内部错误' });
  }
  next();
});

// 确保 data 目录存在
if (!fs.existsSync(path.join(ROOT, 'data'))) {
  fs.mkdirSync(path.join(ROOT, 'data'), { recursive: true });
}

app.listen(PORT, () => {
  console.log(`✅ AI 工具箱后端已启动: http://localhost:${PORT}`);
  console.log(`   模型: ${llmConfig.MODEL}`);
  console.log(`   Key 已配置: ${llmConfig.API_KEY ? '是' : '否（请在 .env 中设置）'}`);
  console.log(`   上游重试: ${llmConfig.RETRY} 次`);
});
