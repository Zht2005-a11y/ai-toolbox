import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ===== 加载 .env（零依赖） =====
// Node 20.12+ 用内置 process.loadEnvFile；旧版本回退到手动解析，保证任何 Node 18+ 都能跑
const envPath = path.join(__dirname, '.env');
if (fs.existsSync(envPath)) {
  if (typeof process.loadEnvFile === 'function') {
    try {
      process.loadEnvFile(envPath);
    } catch (e) {
      console.error('[env] .env 解析失败，将依赖系统环境变量:', e.message);
    }
  } else {
    for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
      if (!m) continue;
      let val = m[2].trim();
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      if (process.env[m[1]] === undefined) process.env[m[1]] = val;
    }
  }
}

const app = express();
app.use(express.json({ limit: '2mb' }));

const PORT = process.env.PORT || 3000;

// Agnes 配置
const AGNES_API_KEY = process.env.AGNES_API_KEY || '';
const AGNES_BASE_URL = process.env.AGNES_BASE_URL || 'https://apihub.agnes-ai.com/v1';
const AGNES_MODEL = process.env.AGNES_MODEL || 'agnes-3.0-flash';
// 上游重试次数（国内服务器访问境外接口偶发抖动，靠重试吸收）
const UPSTREAM_RETRY = Math.max(1, Number(process.env.UPSTREAM_RETRY || 3));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ===== 调用 Agnes（带自动重试 + 详细错误日志） =====
async function callAgnes(payload) {
  let lastError = null;

  for (let attempt = 1; attempt <= UPSTREAM_RETRY; attempt++) {
    try {
      const res = await fetch(`${AGNES_BASE_URL}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${AGNES_API_KEY}`,
        },
        body: JSON.stringify(payload),
      });

      // 5xx = 上游临时故障，可重试；4xx = 请求本身问题，直接返回给调用方
      if (res.status >= 500 && attempt < UPSTREAM_RETRY) {
        console.error(`[Agnes] 第 ${attempt} 次返回 ${res.status}，准备重试`);
        await res.text().catch(() => {});
        await sleep(300 * attempt);
        continue;
      }
      return res;
    } catch (e) {
      lastError = e;
      const c = e.cause;
      const causeText = c ? `${c.code || ''}${c.message ? ' ' + c.message : ''}`.trim() : '';
      console.error(
        `[Agnes] 第 ${attempt}/${UPSTREAM_RETRY} 次请求失败: ${e.message}` +
          (causeText ? ` | 底层原因: ${causeText}` : '')
      );
      if (attempt < UPSTREAM_RETRY) await sleep(300 * attempt);
    }
  }

  const c = lastError && lastError.cause;
  const detail = c ? `${c.code || ''}${c.message ? ' ' + c.message : ''}`.trim() : '';
  const err = new Error('连接模型服务失败' + (detail ? `（${detail}）` : ''));
  err.cause = c;
  throw err;
}

// ===== AI 代理接口（关键：Key 只存在服务器端） =====
app.post('/api/chat', async (req, res) => {
  try {
    if (!AGNES_API_KEY) {
      return res.status(500).json({ error: '服务器未配置 AGNES_API_KEY' });
    }

    const { messages, temperature, max_tokens, stream = false } = req.body || {};

    if (!messages || !Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json({ error: '缺少 messages 参数' });
    }

    const upstream = await callAgnes({
      model: AGNES_MODEL,
      messages,
      temperature: temperature ?? 0.7,
      max_tokens: max_tokens ?? 2048,
      stream,
    });

    if (!upstream.ok) {
      const errText = await upstream.text();
      console.error(`[Agnes] 上游错误 ${upstream.status}:`, errText.slice(0, 500));
      return res.status(upstream.status).json({
        error: `模型服务返回错误（${upstream.status}）`,
        detail: errText.slice(0, 300),
      });
    }

    // 流式：直接透传 SSE
    if (stream) {
      res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      res.flushHeaders();

      const reader = upstream.body.getReader();
      const decoder = new TextDecoder();
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          const text = decoder.decode(value, { stream: true });
          res.write(text);
        }
      } catch (e) {
        console.error('[Agnes] 流读取中断:', e.message);
      }
      res.end();
      return;
    }

    // 非流式：返回完整 JSON
    const data = await upstream.json();
    return res.json(data);
  } catch (e) {
    console.error('[Agnes] 代理异常:', e.message);
    return res.status(502).json({
      error: `模型服务暂时连不上（已重试 ${UPSTREAM_RETRY} 次），请稍后重试`,
      detail: e.message,
    });
  }
});

// ===== 健康检查 =====
app.get('/api/health', (req, res) => {
  res.json({
    ok: true,
    model: AGNES_MODEL,
    keyConfigured: !!AGNES_API_KEY,
    upstreamRetry: UPSTREAM_RETRY,
  });
});

// ===== 安全拦截：禁止访问点开头文件（.env / .git / .workbuddy）与 node_modules =====
app.use((req, res, next) => {
  if (/(^|\/)\./.test(req.path) || req.path.startsWith('/node_modules')) {
    return res.status(404).send('Not Found');
  }
  next();
});

// ===== 静态托管前端 =====
app.use(express.static(__dirname));

// SPA 兜底：所有非 API 路径返回 index.html
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api/')) return next();
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.listen(PORT, () => {
  console.log(`✅ AI 工具箱后端已启动: http://localhost:${PORT}`);
  console.log(`   模型: ${AGNES_MODEL}`);
  console.log(`   Key 已配置: ${AGNES_API_KEY ? '是' : '否（请在 .env 中设置）'}`);
  console.log(`   上游重试: ${UPSTREAM_RETRY} 次`);
});
