'use strict';
// Guided setup:  npm run setup      (or  npm run doctor  to only check your install)
// Checks Node and Claude Code, helps you log in, sets your password, and optionally connects Telegram.
// Nothing is sent anywhere except the one tiny test request to Claude (only if you say yes).

const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const readline = require('node:readline/promises');
const { Writable } = require('node:stream');
const C = require('./config');

const CHECK_ONLY = process.argv.includes('--check');
const ENV_FILE = path.join(C.ROOT, '.env');
const CLAUDE_BIN = C.env.CLAUDE_BIN || 'claude';
const INSTALL_URL = 'https://code.claude.com/docs/en/overview';

const ok = (m) => console.log(`  [ok] ${m}`);
const warn = (m) => console.log(`  [!!] ${m}`);
const info = (m) => console.log(`       ${m}`);
const step = (m) => console.log(`\n${m}`);

// ---------- input helpers ----------

const muted = new Writable({ write(chunk, enc, cb) { if (!muted.muted) process.stdout.write(chunk, enc); cb(); } });
const rl = CHECK_ONLY ? null : readline.createInterface({ input: process.stdin, output: muted, terminal: !!process.stdin.isTTY });

// At a keyboard we use readline's question(). With piped input (scripts, CI) question() would lose
// lines that arrive early, so read from the line iterator instead.
const lineIter = rl && !process.stdin.isTTY ? rl[Symbol.asyncIterator]() : null;
async function readLine() {
  if (!lineIter) return rl.question('');
  const { value, done } = await lineIter.next();
  if (done) throw new Error('The input ended before setup was finished.');
  return value;
}

async function ask(question, def = '') {
  process.stdout.write(`${question}${def ? ` [${def}]` : ''} `);
  const a = (await readLine()).trim();
  if (!process.stdin.isTTY) process.stdout.write('\n');
  return a || def;
}
async function yes(question, def = true) {
  const a = (await ask(`${question} (${def ? 'Y/n' : 'y/N'})`)).toLowerCase();
  return a ? a.startsWith('y') : def;
}
async function askSecret(question) {
  process.stdout.write(`${question} `);
  muted.muted = true;
  const a = await readLine();
  muted.muted = false;
  process.stdout.write('\n');
  return a;
}

// ---------- .env file ----------

function writeEnv(updates) {
  let lines = [];
  try { lines = fs.readFileSync(ENV_FILE, 'utf8').split('\n'); } catch { lines = ['# AI Task Desk settings (see .env.example)']; }
  const done = new Set();
  lines = lines.map((l) => {
    const m = l.match(/^\s*([A-Z0-9_]+)\s*=/);
    if (m && m[1] in updates) { done.add(m[1]); return `${m[1]}=${updates[m[1]]}`; }
    return l;
  });
  for (const [k, v] of Object.entries(updates)) if (!done.has(k)) lines.push(`${k}=${v}`);
  fs.writeFileSync(ENV_FILE, `${lines.join('\n').replace(/\n+$/, '')}\n`, { mode: 0o600 });
  try { fs.chmodSync(ENV_FILE, 0o600); } catch { /* best effort */ }
}

// ---------- checks ----------

function nodeOk() {
  const [maj, min] = process.versions.node.split('.').map(Number);
  return maj > 22 || (maj === 22 && min >= 13);
}

function claudeVersion() {
  const r = cp.spawnSync(CLAUDE_BIN, ['--version'], { encoding: 'utf8', timeout: 15000 });
  return !r.error && r.status === 0 ? r.stdout.trim() : null;
}

// One tiny request, to prove the login (or API key) works. About 500 tokens.
function claudeLoginWorks(useApiKey, apiKey) {
  const env = { ...process.env };
  if (useApiKey) { if (apiKey) env.ANTHROPIC_API_KEY = apiKey; } else { delete env.ANTHROPIC_API_KEY; delete env.ANTHROPIC_AUTH_TOKEN; }
  const r = cp.spawnSync(CLAUDE_BIN, ['-p', 'Reply with the single word OK', '--tools', '', '--max-turns', '1', '--no-session-persistence', '--output-format', 'json'],
    { encoding: 'utf8', timeout: 90000, env, cwd: C.ROOT });
  if (r.error) return { ok: false, why: r.error.message };
  let out = null;
  try { out = JSON.parse(r.stdout); } catch { /* not json */ }
  if (r.status === 0 && out && !out.is_error) return { ok: true };
  return { ok: false, why: String((out && out.result) || r.stderr || r.stdout || `exit code ${r.status}`).trim().slice(0, 300) };
}

function validTz(tz) { try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return true; } catch { return false; } }

function openDatabase() {
  const { openDb } = require('./db');
  return openDb(C.DB_FILE);
}

// ---------- the guide ----------

async function doctor() {
  console.log('AI Task Desk: checking your install\n');
  let problems = 0;
  if (nodeOk()) ok(`Node ${process.versions.node}`); else { warn(`Node ${process.versions.node} is too old. Need 22.13 or newer.`); problems++; }
  const v = claudeVersion();
  if (v) ok(`Claude Code found (${v})`); else { warn(`Claude Code ("${CLAUDE_BIN}") not found. The task list works, but the AI agent will not. Install: ${INSTALL_URL}`); problems++; }
  try {
    const db = openDatabase();
    const A = require('./agentlib');
    if (A.getSetting(db, 'password_hash')) ok('Password is set'); else { warn('No password yet. Run: npm run setup'); problems++; }
    ok(A.getSetting(db, 'telegram_chat_id') ? 'Telegram is connected' : 'Telegram not connected (optional)');
  } catch (e) { warn(`Database problem: ${e.message}`); problems++; }
  ok(`Workspace folder: ${C.WORKSPACE}`);
  ok(`Time zone: ${C.TZ}`);
  console.log(problems ? `\n${problems} thing(s) need attention.` : '\nAll good.');
  process.exit(problems ? 1 : 0);
}

async function main() {
  console.log('AI Task Desk setup\n------------------');
  console.log('This takes about two minutes. You can run it again any time.');
  const updates = {};

  step('1. Node.js');
  if (!nodeOk()) { warn(`You have Node ${process.versions.node}. AI Task Desk needs 22.13 or newer. Get it from https://nodejs.org`); process.exit(1); }
  ok(`Node ${process.versions.node}`);

  step('2. The AI agent (Claude Code)');
  info('The agent is Claude Code, which you install separately. The task list works without it.');
  let agent = false;
  let useApi = false;
  let apiKey = '';
  const v = claudeVersion();
  if (!v) {
    warn(`Claude Code was not found (looked for "${CLAUDE_BIN}").`);
    info(`Install it: ${INSTALL_URL}`);
    info('Then run "claude" once in a terminal and log in. After that, run this setup again.');
    if (!(await yes('Continue without the agent for now?', true))) process.exit(0);
  } else {
    ok(`Claude Code found (${v})`);
    agent = true;
    console.log('\n  How should the agent pay for its work?');
    console.log('    1) My Claude subscription (Pro or Max). Recommended. Log in once with "claude".');
    console.log('    2) My own Anthropic API key. Billed per use by Anthropic.');
    const choice = await ask('  Choose 1 or 2', '1');
    useApi = choice === '2';
    if (useApi) {
      info('Your key is saved in the .env file in this folder (readable only by you). Never commit that file.');
      apiKey = (await askSecret('  Paste your ANTHROPIC_API_KEY (input is hidden):')).trim();
      if (!apiKey) { warn('No key entered. Falling back to the subscription login.'); useApi = false; }
    }
    updates.AGENT_AUTH = useApi ? 'api' : 'subscription';
    if (useApi) updates.ANTHROPIC_API_KEY = apiKey;
    if (await yes('\n  Test that it works? This sends one tiny request (about 500 tokens).', true)) {
      process.stdout.write('  Testing... ');
      const t = claudeLoginWorks(useApi, apiKey);
      if (t.ok) console.log('it works.');
      else {
        console.log('failed.');
        warn(`Claude Code answered: ${t.why}`);
        info(useApi ? 'Check that the API key is correct and has credit.' : 'Run "claude" in a terminal, log in, then run this setup again.');
      }
    }
  }

  step('3. Password');
  const db = openDatabase();
  const A = require('./agentlib');
  const Auth = require('./auth');
  if (A.getSetting(db, 'password_hash') && !(await yes('A password is already set. Change it?', false))) ok('Keeping your current password');
  else {
    let pw = '';
    for (;;) {
      pw = await askSecret('  Choose a password (12+ characters, input is hidden):');
      if (pw.length < 12) { warn('Too short. Use at least 12 characters.'); continue; }
      if (pw !== (await askSecret('  Type it again:'))) { warn('They did not match.'); continue; }
      break;
    }
    A.setSetting(db, 'password_hash', Auth.hashPassword(pw));
    A.setSetting(db, 'session_epoch', require('node:crypto').randomBytes(8).toString('hex'));
    ok('Password saved');
  }

  step('4. Time zone and workspace');
  let tz = await ask('  Your time zone', C.TZ);
  while (!validTz(tz)) { warn(`"${tz}" is not a valid time zone name (example: America/New_York).`); tz = await ask('  Your time zone', C.TZ); }
  updates.TIMEZONE = tz;
  if (agent) {
    info('The agent works inside one folder, called the workspace. Anything outside it needs your approval.');
    const ws = await ask('  Workspace folder', C.WORKSPACE);
    fs.mkdirSync(path.resolve(ws), { recursive: true });
    updates.AGENT_WORKSPACE = path.resolve(ws);
    ok(`Workspace: ${updates.AGENT_WORKSPACE}`);
  }

  step('5. Telegram alerts (optional)');
  info('Get a message on your phone when the agent needs you, plus a daily briefing.');
  if (await yes('  Set it up now?', false)) {
    info('In Telegram, message @BotFather, send /newbot, and follow the steps. It gives you a token.');
    const token = (await askSecret('  Paste the bot token (input is hidden):')).trim();
    try {
      const me = await A.telegramApi(token, 'getMe');
      A.setSetting(db, 'telegram_token', token);
      ok(`Bot found: @${me.username}`);
      await ask(`  Now open @${me.username} in Telegram, send it "hi", then press Enter here.`);
      const updatesList = await A.telegramApi(token, 'getUpdates', { limit: 25, timeout: 0 });
      const chats = (updatesList || []).map((u) => u.message).filter((m) => m && m.chat && m.chat.type === 'private');
      if (!chats.length) warn('No message found. You can finish connecting later in Settings inside the app.');
      else {
        A.setSetting(db, 'telegram_chat_id', String(chats[chats.length - 1].chat.id));
        await A.sendTelegram(db, 'AI Task Desk is connected. You will get agent updates here.');
        ok('Connected. A confirmation message was sent.');
      }
    } catch (e) { warn(`Telegram did not accept that: ${e.message}. You can set it up later in Settings.`); }
  } else info('Skipped. You can do it later in Settings inside the app.');

  writeEnv(updates);
  step('Done.');
  console.log('  Start it with:   npm start');
  console.log(`  Then open:       http://localhost:${C.PORT}/`);
  console.log('  Check your install any time with:   npm run doctor\n');
  rl.close();
  process.exit(0);
}

(CHECK_ONLY ? doctor() : main()).catch((e) => { console.error(e); process.exit(1); });
