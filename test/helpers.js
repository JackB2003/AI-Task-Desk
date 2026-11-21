'use strict';
// Test helpers: start the real server as a child process and talk to it with a cookie jar.

const cp = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
let nextPort = 3960 + Math.floor(Math.random() * 500);

async function startServer(extraEnv = {}) {
  const port = nextPort++;
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'atd-test-'));
  const child = cp.spawn(process.execPath, [path.join(ROOT, 'server.js')], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(port), DATA_DIR: dataDir, QUIET: '1', TIMEZONE: 'UTC', DEMO_STEP_MS: '30', ...extraEnv },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  child.stdout.on('data', (d) => { log += d; });
  child.stderr.on('data', (d) => { log += d; });
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 100; i++) {
    try { const r = await fetch(`${base}/healthz`); if (r.ok) break; } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 50));
    if (child.exitCode !== null) throw new Error(`server exited: ${log}`);
  }
  return {
    base,
    dataDir,
    stop: async () => { child.kill('SIGTERM'); await new Promise((r) => child.once('exit', r)); fs.rmSync(dataDir, { recursive: true, force: true }); },
  };
}

// A tiny fetch wrapper that remembers cookies (one "browser").
function client(base, headers = {}) {
  const jar = new Map();
  const cookieHeader = () => [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
  async function call(method, p, body, extra = {}) {
    const res = await fetch(base + p, {
      method,
      headers: {
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        'X-Requested-With': 'ai-task-desk',
        ...(jar.size ? { Cookie: cookieHeader() } : {}),
        ...headers, ...extra,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    for (const c of res.headers.getSetCookie()) {
      const [kv] = c.split(';');
      const i = kv.indexOf('=');
      const val = kv.slice(i + 1);
      if (/Max-Age=0/i.test(c) || val === '') jar.delete(kv.slice(0, i)); else jar.set(kv.slice(0, i), val);
    }
    let data = {};
    try { data = await res.json(); } catch { /* empty */ }
    return { status: res.status, data };
  }
  return { get: (p) => call('GET', p), post: (p, b = {}, extra) => call('POST', p, b, extra), patch: (p, b) => call('PATCH', p, b), call, jar, cookieHeader };
}

async function until(fn, ms = 6000, step = 40) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, step));
  }
}

module.exports = { startServer, client, until, ROOT };
