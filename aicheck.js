'use strict';
// Checks the AI side: is Claude Code installed, and does a tiny request work?
// Shared by the setup wizard (setup.js) and the "AI connection" screen in the web page (server.js).
// No npm dependencies.

const cp = require('node:child_process');
const { env, ROOT } = require('./config');

const CLAUDE_BIN = env.CLAUDE_BIN || 'claude';
const INSTALL_URL = 'https://code.claude.com/docs/en/overview';
const useApiKey = () => env.AGENT_AUTH === 'api';

// The installed Claude Code version, or null if it is not found.
function version(bin = CLAUDE_BIN) {
  const r = cp.spawnSync(bin, ['--version'], { encoding: 'utf8', timeout: 15000 });
  return !r.error && r.status === 0 ? r.stdout.trim() : null;
}

function cleanEnv(apiMode, apiKey) {
  const e = { ...process.env };
  if (apiMode) { if (apiKey) e.ANTHROPIC_API_KEY = apiKey; } else { delete e.ANTHROPIC_API_KEY; delete e.ANTHROPIC_AUTH_TOKEN; }
  return e;
}

// One tiny request (about 500 tokens) to prove the login or API key works. Never blocks the server.
function testLogin({ apiMode = useApiKey(), apiKey = env.ANTHROPIC_API_KEY, bin = CLAUDE_BIN, timeoutMs = 90000 } = {}) {
  return new Promise((resolve) => {
    const child = cp.spawn(bin, ['-p', 'Reply with the single word OK', '--tools', '', '--max-turns', '1', '--no-session-persistence', '--output-format', 'json'],
      { cwd: ROOT, env: cleanEnv(apiMode, apiKey), stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    let settled = false;
    const done = (r) => { if (!settled) { settled = true; clearTimeout(timer); resolve(r); } };
    const timer = setTimeout(() => { child.kill('SIGKILL'); done({ ok: false, why: 'It took too long to answer (over 90 seconds).' }); }, timeoutMs);
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', (e) => done({ ok: false, why: e.message }));
    child.on('close', (code) => {
      let parsed = null;
      try { parsed = JSON.parse(out); } catch { /* not json */ }
      if (code === 0 && parsed && !parsed.is_error) return done({ ok: true });
      done({ ok: false, why: String((parsed && parsed.result) || err || out || `exit code ${code}`).trim().slice(0, 300) });
    });
  });
}

module.exports = { CLAUDE_BIN, INSTALL_URL, useApiKey, version, testLogin };
