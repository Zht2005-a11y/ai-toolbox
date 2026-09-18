import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(__dirname, '..');

// ===== 加载 .env（零依赖，Node 18+ 均可）=====
(function loadEnv() {
  const envPath = path.join(ROOT, '.env');
  if (!fs.existsSync(envPath)) return;
  if (typeof process.loadEnvFile === 'function') {
    try {
      process.loadEnvFile(envPath);
      return;
    } catch (e) {
      console.error('[env] .env 解析失败，回退到手动解析:', e.message);
    }
  }
  for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!m) continue;
    let v = m[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    if (process.env[m[1]] === undefined) process.env[m[1]] = v;
  }
})();

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const API_KEY = process.env.AGNES_API_KEY || '';
const BASE_URL = process.env.AGNES_BASE_URL || 'https://apihub.agnes-ai.com/v1';
const MODEL = process.env.AGNES_MODEL || 'agnes-3.0-flash';
const RETRY = Math.max(1, Number(process.env.UPSTREAM_RETRY || 3));
const TIMEOUT = Math.max(10000, Number(process.env.LLM_TIMEOUT_MS || 180000));

// 编译任务的最小调用间隔：免费档约 20 请求/分钟 → 3s 一次，留出余量
const COMPILE_INTERVAL = Math.max(0, Number(process.env.LLM_MIN_INTERVAL_MS || 3200));

export const llmConfig = { API_KEY, BASE_URL, MODEL, RETRY };

// ===== 底层请求（带重试）=====
async function post(payload) {
  let lastError = null;

  for (let attempt = 1; attempt <= RETRY; attempt++) {
    try {
      const res = await fetch(`${BASE_URL}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${API_KEY}`,
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(TIMEOUT),
      });

      // 5xx = 上游临时故障，可重试
      if (res.status >= 500 && attempt < RETRY) {
        console.error(`[LLM] 第 ${attempt} 次返回 ${res.status}，准备重试`);
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
        `[LLM] 第 ${attempt}/${RETRY} 次请求失败: ${e.message}` +
          (causeText ? ` | 底层原因: ${causeText}` : '')
      );
      if (attempt < RETRY) await sleep(300 * attempt);
    }
  }

  const c = lastError && lastError.cause;
  const detail = c ? `${c.code || ''}${c.message ? ' ' + c.message : ''}`.trim() : '';
  const err = new Error('连接模型服务失败' + (detail ? `（${detail}）` : ''));
  err.cause = c;
  throw err;
}

export function upstreamError(status, detail) {
  const err = new Error(`模型服务返回错误（${status}）`);
  err.status = status;
  err.detail = detail;
  return err;
}

// ===== 编译节流闸门：保证编译类调用之间至少间隔 COMPILE_INTERVAL =====
let lastCompileCallAt = 0;
let compileTail = Promise.resolve();

function compileGate() {
  const run = compileTail.then(async () => {
    const wait = COMPILE_INTERVAL - (Date.now() - lastCompileCallAt);
    if (wait > 0) await sleep(wait);
    lastCompileCallAt = Date.now();
  });
  compileTail = run.catch(() => {});
  return run;
}

/**
 * 非流式对话，返回完整文本
 * @param {Array} messages
 * @param {object} opts { temperature, maxTokens, json, throttle }
 */
export async function chat(messages, opts = {}) {
  if (opts.throttle) await compileGate();

  const upstream = await post({
    model: MODEL,
    messages,
    temperature: opts.temperature ?? 0.3,
    max_tokens: opts.maxTokens ?? 4096,
    stream: false,
  });

  if (!upstream.ok) {
    const t = await upstream.text();
    throw upstreamError(upstream.status, t.slice(0, 300));
  }

  const data = await upstream.json();
  return data?.choices?.[0]?.message?.content || '';
}

/**
 * 要求模型返回 JSON，带容错解析
 */
export async function chatJSON(messages, opts = {}) {
  const text = await chat(messages, opts);
  return parseLooseJSON(text);
}

export function parseLooseJSON(text) {
  if (!text) throw new Error('模型返回为空');

  // 1) 直接尝试
  const trimmed = text.trim();
  try {
    return JSON.parse(trimmed);
  } catch (e) {}

  // 2) 去掉 ```json ... ``` 围栏
  const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) {
    try {
      return JSON.parse(fence[1].trim());
    } catch (e) {}
  }

  // 3) 截取第一个 { 到最后一个 }
  const s = trimmed.indexOf('{');
  const e2 = trimmed.lastIndexOf('}');
  if (s !== -1 && e2 > s) {
    try {
      return JSON.parse(trimmed.slice(s, e2 + 1));
    } catch (e) {}
  }

  // 4) 数组形式
  const as = trimmed.indexOf('[');
  const ae = trimmed.lastIndexOf(']');
  if (as !== -1 && ae > as) {
    try {
      return JSON.parse(trimmed.slice(as, ae + 1));
    } catch (e) {}
  }

  throw new Error('模型返回的不是合法 JSON');
}

/**
 * 流式对话：逐段回调 onDelta
 * 返回完整文本
 */
export async function chatStream(messages, onDelta, opts = {}) {
  const upstream = await post({
    model: MODEL,
    messages,
    temperature: opts.temperature ?? 0.7,
    max_tokens: opts.maxTokens ?? 2048,
    stream: true,
  });

  if (!upstream.ok) {
    const t = await upstream.text();
    throw upstreamError(upstream.status, t.slice(0, 300));
  }

  const reader = upstream.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  let full = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });

    const lines = buf.split('\n');
    buf = lines.pop() || '';

    for (const line of lines) {
      const t = line.trim();
      if (!t || !t.startsWith('data:')) continue;
      const data = t.slice(5).trim();
      if (data === '[DONE]') return full;
      try {
        const j = JSON.parse(data);
        const delta = j?.choices?.[0]?.delta?.content;
        if (delta) {
          full += delta;
          if (onDelta) onDelta(delta);
        }
      } catch (e) {
        // 忽略无法解析的帧
      }
    }
  }
  return full;
}

/**
 * 把上游 SSE 原样透传给客户端（用于 /api/chat 直通）
 */
export async function pipeStream(messages, res, opts = {}) {
  const upstream = await post({
    model: MODEL,
    messages,
    temperature: opts.temperature ?? 0.7,
    max_tokens: opts.maxTokens ?? 2048,
    stream: true,
  });

  if (!upstream.ok) {
    const t = await upstream.text();
    throw upstreamError(upstream.status, t.slice(0, 300));
  }

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
      res.write(decoder.decode(value, { stream: true }));
    }
  } catch (e) {
    console.error('[LLM] 流读取中断:', e.message);
  }
  res.end();
}
