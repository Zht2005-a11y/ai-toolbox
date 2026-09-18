import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// 加载 .env（Node 22 内置，无需 dotenv 依赖）
try {
  const envPath = path.join(__dirname, '.env');
  if (fs.existsSync(envPath)) {
    process.loadEnvFile(envPath);
  }
} catch (e) {
  // 无 .env 文件时静默跳过，依赖系统环境变量
}

const app = express();
app.use(express.json({ limit: '2mb' }));

const PORT = process.env.PORT || 3000;

// Agnes 配置
const AGNES_API_KEY = process.env.AGNES_API_KEY || '';
const AGNES_BASE_URL = process.env.AGNES_BASE_URL || 'https://api.agnes-ai.cn/v1';
const AGNES_MODEL = process.env.AGNES_MODEL || 'agnes-3.0-flash';

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

    // 转发给 Agnes
    const upstream = await fetch(`${AGNES_BASE_URL}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${AGNES_API_KEY}`,
      },
      body: JSON.stringify({
        model: AGNES_MODEL,
        messages,
        temperature: temperature ?? 0.7,
        max_tokens: max_tokens ?? 2048,
        stream,
      }),
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
    return res.status(502).json({ error: '代理服务异常：' + e.message });
  }
});

// ===== 健康检查 =====
app.get('/api/health', (req, res) => {
  res.json({
    ok: true,
    model: AGNES_MODEL,
    keyConfigured: !!AGNES_API_KEY,
  });
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
});
