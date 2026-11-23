'use strict';
// The "AI connection" screen: is Claude Code installed, does a tiny test request work.
// A fake `claude` program stands in, so these tests never call a real AI.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { startServer, client } = require('./helpers');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atd-fakeclaude-'));
const fake = path.join(dir, 'claude');
fs.writeFileSync(fake, `#!/bin/sh
if [ "$1" = "--version" ]; then echo "9.9.9 (Fake Claude Code)"; exit 0; fi
if [ "$FAKE_MODE" = "fail" ]; then echo '{"is_error":true,"result":"Not logged in. Run claude to log in."}'; exit 1; fi
echo '{"is_error":false,"result":"OK"}'
`, { mode: 0o755 });
test.after(() => fs.rmSync(dir, { recursive: true, force: true }));

async function signedIn(srv) {
  const c = client(srv.base);
  assert.equal((await c.post('/api/setup', { password: 'correct horse battery' })).status, 200);
  return c;
}

test('Claude Code not installed: says so, and refuses to test', async () => {
  const srv = await startServer({ CLAUDE_BIN: path.join(dir, 'missing') });
  try {
    const c = await signedIn(srv);
    const s = (await c.get('/api/ai/status')).data;
    assert.equal(s.installed, false);
    assert.equal(s.mode, 'subscription');
    assert.equal(s.tested, null);
    assert.match(s.installUrl, /^https:\/\//);
    const t = await c.post('/api/ai/test');
    assert.equal(t.status, 409);
    assert.match(t.data.error, /not found/i);
  } finally { await srv.stop(); }
});

test('Claude Code installed: shows the version, test works and is remembered', async () => {
  const srv = await startServer({ CLAUDE_BIN: fake });
  try {
    const c = await signedIn(srv);
    const before = (await c.get('/api/ai/status')).data;
    assert.equal(before.installed, true);
    assert.match(before.version, /Fake Claude Code/);
    assert.equal(before.tested, null);
    const t = await c.post('/api/ai/test');
    assert.equal(t.status, 200);
    assert.equal(t.data.ok, true);
    const after = (await c.get('/api/ai/status')).data;
    assert.equal(after.tested.ok, true);
    // tests are rate limited
    assert.equal((await c.post('/api/ai/test')).status, 429);
  } finally { await srv.stop(); }
});

test('a failed test explains why (for example, not logged in)', async () => {
  const srv = await startServer({ CLAUDE_BIN: fake, FAKE_MODE: 'fail' });
  try {
    const c = await signedIn(srv);
    const t = await c.post('/api/ai/test');
    assert.equal(t.status, 200);
    assert.equal(t.data.ok, false);
    assert.match(t.data.why, /Not logged in/);
    assert.equal((await c.get('/api/ai/status')).data.tested.ok, false);
  } finally { await srv.stop(); }
});

test('API key mode is reported, and the key itself is never sent to the page', async () => {
  const srv = await startServer({ CLAUDE_BIN: fake, AGENT_AUTH: 'api', ANTHROPIC_API_KEY: 'sk-ant-test-1234567890' });
  try {
    const c = await signedIn(srv);
    const r = await c.get('/api/ai/status');
    assert.equal(r.data.mode, 'api');
    assert.equal(r.data.apiKeySet, true);
    assert.equal(JSON.stringify(r.data).includes('sk-ant'), false);
  } finally { await srv.stop(); }
});

test('the AI screen needs a login', async () => {
  const srv = await startServer({ CLAUDE_BIN: fake });
  try {
    assert.equal((await client(srv.base).get('/api/ai/status')).status, 401);
  } finally { await srv.stop(); }
});

test('demo: the AI screen is simulated and never runs anything', async () => {
  const srv = await startServer({ DEMO: '1', CLAUDE_BIN: path.join(dir, 'missing') });
  try {
    const c = client(srv.base);
    await c.get('/api/me');
    const s = (await c.get('/api/ai/status')).data;
    assert.equal(s.demo, true);
    assert.equal(s.installed, true);
    assert.equal(s.tested, null);
    const t = await c.post('/api/ai/test');
    assert.equal(t.data.simulated, true);
    assert.equal((await c.get('/api/ai/status')).data.tested.simulated, true);
  } finally { await srv.stop(); }
});
