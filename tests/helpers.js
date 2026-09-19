import { spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(__dirname, '..');

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 建一个临时目录（给 DATA_DIR 用，避免测试污染真实 data/） */
export function tmpDir(prefix = 'aitool-test-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

export function rmDir(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch (e) {}
}

/**
 * 起一个真实的服务进程用于接口测试。
 * - DATA_DIR 指向临时目录
 * - AGNES_API_KEY 置空，保证测试绝不会真的去调模型（不花钱、不依赖网络）
 */
export async function startServer({ dataDir } = {}) {
  const dir = dataDir || tmpDir();
  const ports = [3399, 3413, 3427, 3441, 3455];

  for (const port of ports) {
    const child = spawn(process.execPath, ['server.js'], {
      cwd: ROOT,
      env: {
        ...process.env,
        PORT: String(port),
        DATA_DIR: dir,
        AGNES_API_KEY: '',
        AGNES_BASE_URL: 'http://127.0.0.1:1/v1',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let log = '';
    child.stdout.on('data', (d) => (log += d.toString()));
    child.stderr.on('data', (d) => (log += d.toString()));

    const base = `http://127.0.0.1:${port}`;
    for (let i = 0; i < 60; i++) {
      try {
        const r = await fetch(`${base}/api/health`);
        if (r.ok) return { child, base, dataDir: dir, log: () => log };
      } catch (e) {}
      if (child.exitCode !== null) break; // 端口被占用等，换下一个
      await sleep(150);
    }
    child.kill('SIGKILL');
    await sleep(200);
  }
  throw new Error('测试服务启动失败：所有候选端口都不可用');
}

export function stopServer(srv) {
  if (srv && srv.child && srv.child.exitCode === null) srv.child.kill('SIGKILL');
}

/** 从响应里取出会话 cookie */
export function cookieOf(res) {
  const raw = res.headers.getSetCookie ? res.headers.getSetCookie() : [res.headers.get('set-cookie')];
  for (const c of raw) {
    if (c && c.startsWith('aitool_sid=')) return c.split(';')[0];
  }
  return null;
}

export function jsonPost(base, path, body, cookie) {
  return fetch(base + path, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(cookie ? { Cookie: cookie } : {}),
    },
    body: JSON.stringify(body),
  });
}

export function apiGet(base, path, cookie) {
  return fetch(base + path, { headers: cookie ? { Cookie: cookie } : {} });
}
