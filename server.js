import express from 'express';
import path from 'path';
import fs from 'fs';
import { llmConfig, pipeStream, chat, ROOT } from './lib/llm.js';
import * as store from './lib/store.js';
import * as auth from './lib/auth.js';
import * as wiki from './lib/wiki.js';
import { chunkText } from './lib/chunk.js';

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

app.use(express.static(ROOT));

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
