'use strict';
// Shared by the web app, the agent worker and the live demo: run records,
// Telegram sending, plan-usage tracking and the daily briefing. No npm dependencies.

const http = require('node:http');
const https = require('node:https');

const RUN_TIMEOUT_MS_DEFAULT = 30 * 60 * 1000;
const ACTIVE = ['queued', 'running', 'needs_input', 'needs_approval', 'blocked'];
const NEEDS_YOU = ['needs_input', 'needs_approval', 'blocked'];
const WARN_AT = 0.8;
const PAUSE_AT = 0.9;
const { TZ, PUBLIC_URL } = require('./config');

const nowIso = () => new Date().toISOString();

function initAgentSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS runs (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id        INTEGER NOT NULL,
      status         TEXT NOT NULL,
      session_id     TEXT,
      segments       INTEGER NOT NULL DEFAULT 0,
      next_prompt    TEXT,
      question       TEXT,
      pending_action TEXT,
      grants         TEXT NOT NULL DEFAULT '[]',
      summary        TEXT,
      report_status  TEXT,
      error          TEXT,
      stop_requested INTEGER NOT NULL DEFAULT 0,
      created_at     TEXT NOT NULL,
      queued_at      TEXT NOT NULL,
      started_at     TEXT,
      ended_at       TEXT,
      updated_at     TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_runs_status ON runs(status);
    CREATE INDEX IF NOT EXISTS idx_runs_task ON runs(task_id);
    CREATE TABLE IF NOT EXISTS run_log (
      id     INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id INTEGER NOT NULL,
      at     TEXT NOT NULL,
      kind   TEXT NOT NULL,
      text   TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_run_log_run ON run_log(run_id);
  `);
}

const getSetting = (db, k) => {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(k);
  return row ? row.value : null;
};
const setSetting = (db, k, v) => {
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(k, v);
};
const delSetting = (db, k) => { db.prepare('DELETE FROM settings WHERE key = ?').run(k); };

function logRun(db, runId, kind, text) {
  db.prepare('INSERT INTO run_log (run_id, at, kind, text) VALUES (?, ?, ?, ?)').run(runId, nowIso(), kind, text == null ? null : String(text).slice(0, 4000));
}

function getRun(db, id) {
  const r = db.prepare('SELECT * FROM runs WHERE id = ?').get(id);
  return r ? { ...r } : null;
}

function activeRunForTask(db, taskId) {
  const marks = ACTIVE.map(() => '?').join(',');
  const r = db.prepare(`SELECT * FROM runs WHERE task_id = ? AND status IN (${marks}) ORDER BY id DESC LIMIT 1`).get(taskId, ...ACTIVE);
  return r ? { ...r } : null;
}

// Compact view of each task's latest run, for the task list.
function latestRunsByTask(db) {
  const rows = db.prepare(
    'SELECT r.* FROM runs r JOIN (SELECT task_id, MAX(id) AS mid FROM runs GROUP BY task_id) m ON r.id = m.mid'
  ).all();
  const map = new Map();
  for (const r of rows) {
    let pending = null;
    try { pending = r.pending_action ? JSON.parse(r.pending_action) : null; } catch { /* ignore */ }
    map.set(r.task_id, {
      id: r.id, status: r.status, question: r.question, pending_action: pending, summary: r.summary,
      report_status: r.report_status, error: r.error, segments: r.segments, updated_at: r.updated_at,
      started_at: r.started_at, ended_at: r.ended_at,
    });
  }
  return map;
}

function queueRun(db, taskId, prompt) {
  const now = nowIso();
  const info = db.prepare(
    "INSERT INTO runs (task_id, status, next_prompt, created_at, queued_at, updated_at) VALUES (?, 'queued', ?, ?, ?, ?)"
  ).run(taskId, prompt || null, now, now, now);
  const id = Number(info.lastInsertRowid);
  logRun(db, id, 'queued', 'Work on it pressed');
  return id;
}

// Put an existing run back in the queue with the next instruction for the agent.
function requeueRun(db, runId, prompt, extra = {}) {
  const now = nowIso();
  const grants = extra.grants !== undefined ? extra.grants : null;
  db.prepare(
    `UPDATE runs SET status = 'queued', next_prompt = ?, queued_at = ?, updated_at = ?, stop_requested = 0, ended_at = NULL,
       question = NULL, pending_action = NULL, error = NULL${grants !== null ? ', grants = ?' : ''} WHERE id = ?`
  ).run(...[prompt, now, now, ...(grants !== null ? [grants] : []), runId]);
}

// ---------- Telegram ----------

function telegramBase() { return process.env.TELEGRAM_API_BASE || 'https://api.telegram.org'; }

function telegramApi(token, method, payload, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const base = new URL(telegramBase());
    const lib = base.protocol === 'http:' ? http : https;
    const body = JSON.stringify(payload || {});
    const req = lib.request({
      hostname: base.hostname, port: base.port || undefined, path: `${base.pathname.replace(/\/$/, '')}/bot${token}/${method}`, method: 'POST',
      family: process.env.TELEGRAM_FORCE_IPV4 === '1' ? 4 : undefined, // set TELEGRAM_FORCE_IPV4=1 if your IPv6 route to Telegram is flaky
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }, timeout: timeoutMs,
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        let data = null;
        try { data = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { /* not json */ }
        if (data && data.ok) resolve(data.result);
        else reject(new Error((data && data.description) || `Telegram HTTP ${res.statusCode}`));
      });
    });
    req.on('timeout', () => req.destroy(new Error('Telegram request timed out')));
    req.on('error', reject);
    req.end(body);
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Returns true if sent, false if not configured or all attempts failed. Never throws.
async function sendTelegram(db, text, { retries = 3 } = {}) {
  const token = getSetting(db, 'telegram_token');
  const chat = getSetting(db, 'telegram_chat_id');
  if (!token || !chat) return false;
  for (let i = 0; i < retries; i++) {
    try {
      await telegramApi(token, 'sendMessage', { chat_id: chat, text: String(text).slice(0, 3900), disable_web_page_preview: true });
      return true;
    } catch (e) {
      if (i < retries - 1) await sleep(process.env.TELEGRAM_RETRY_MS ? Number(process.env.TELEGRAM_RETRY_MS) : 1000 * 3 ** i);
      else console.error(`Telegram send failed: ${e.message}`);
    }
  }
  return false;
}

// ---------- plan usage ----------

function fmtReset(epochSeconds) {
  return new Intl.DateTimeFormat('en-US', { timeZone: TZ, weekday: 'short', hour: 'numeric', minute: '2-digit' }).format(new Date(epochSeconds * 1000));
}

// rate_limit_info.unifiedWindows -> { five_hour: {u, resetsAt}, seven_day: {...} }
function parseUsage(info) {
  const w = info && info.unifiedWindows;
  if (!w) return null;
  const out = {};
  for (const name of ['five_hour', 'seven_day']) {
    if (w[name] && typeof w[name].utilization === 'number') out[name] = { u: w[name].utilization, resetsAt: w[name].resetsAt, status: w[name].status };
  }
  return Object.keys(out).length ? out : null;
}

function saveUsage(db, usage) {
  setSetting(db, 'usage', JSON.stringify({ ...usage, at: nowIso() }));
}

function readUsage(db) {
  try { const v = getSetting(db, 'usage'); return v ? JSON.parse(v) : null; } catch { return null; }
}

// Epoch seconds until which new runs must not start (0 = not paused).
function pausedUntil(usage) {
  if (!usage) return 0;
  const nowS = Date.now() / 1000;
  let until = 0;
  for (const name of ['five_hour', 'seven_day']) {
    const w = usage[name];
    if (w && w.resetsAt > nowS && (w.u >= PAUSE_AT || (w.status && w.status !== 'allowed' && w.status !== 'allowed_warning'))) until = Math.max(until, w.resetsAt);
  }
  return until;
}

const WINDOW_LABEL = { five_hour: '5-hour', seven_day: '7-day' };

// Sends each Telegram heads-up once per window per reset.
async function checkUsageAlerts(db, usage) {
  if (!usage) return;
  let alerts = {};
  try { alerts = JSON.parse(getSetting(db, 'usage_alerts') || '{}'); } catch { alerts = {}; }
  const nowS = Date.now() / 1000;
  for (const k of Object.keys(alerts)) if (alerts[k] < nowS) delete alerts[k]; // forget windows that already reset
  let changed = false;
  for (const name of ['five_hour', 'seven_day']) {
    const w = usage[name];
    if (!w) continue;
    const pct = Math.round(w.u * 100);
    for (const [level, threshold] of [[90, PAUSE_AT], [80, WARN_AT]]) {
      if (w.u < threshold) continue;
      const key = `${name}:${w.resetsAt}:${level}`;
      if (alerts[key]) break; // already sent this level (and the lower one) for this window
      const text = level === 90
        ? `Plan usage at ${pct}% (${WINDOW_LABEL[name]} window). The agent will not start new runs until it resets ${fmtReset(w.resetsAt)}. A run already working will finish.`
        : `Plan usage heads-up: the ${WINDOW_LABEL[name]} window is at ${pct}%. It resets ${fmtReset(w.resetsAt)}.`;
      alerts[key] = w.resetsAt;
      alerts[`${name}:${w.resetsAt}:80`] = w.resetsAt;
      changed = true;
      await sendTelegram(db, text);
      break;
    }
  }
  if (changed) setSetting(db, 'usage_alerts', JSON.stringify(alerts));
}

// The recorded file changes of a run. Entries for files that were never actually created are dropped.
function readChangeLog(runDir) {
  const fs = require('node:fs');
  const path = require('node:path');
  let rows = [];
  try { rows = fs.readFileSync(path.join(runDir, 'changes.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; }
  return rows.filter((c) => c.existed || fs.existsSync(c.path));
}


// ---------- daily briefing (Telegram) ----------

function localParts(d = new Date()) {
  const p = {};
  for (const x of new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(d)) p[x.type] = x.value;
  return { date: `${p.year}-${p.month}-${p.day}`, minutes: Number(p.hour) * 60 + Number(p.minute) };
}

function addDaysStr(s, n) {
  const d = new Date(`${s}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

const clip = (s, n) => { const t = String(s || '').replace(/\s+/g, ' ').trim(); return t.length > n ? `${t.slice(0, n - 3)}...` : t; };
const prettyDay = (s) => new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', weekday: 'short', month: 'short', day: 'numeric' }).format(new Date(`${s}T00:00:00Z`));

// The text of the morning briefing, built from the live database.
function buildBriefingText(db) {
  const { date: today, minutes } = localParts();
  const weekEnd = addDaysStr(today, 7);
  const hello = minutes < 12 * 60 ? 'Good morning' : minutes < 17 * 60 ? 'Good afternoon' : 'Good evening';
  const longDate = new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', weekday: 'long', month: 'long', day: 'numeric' }).format(new Date(`${today}T00:00:00Z`));
  const open = db.prepare("SELECT id, title, due, priority, owner FROM tasks WHERE status = 'open' ORDER BY CASE priority WHEN 'high' THEN 0 WHEN 'normal' THEN 1 ELSE 2 END, due IS NULL, due, id").all();
  const overdue = open.filter((t) => t.due && t.due < today);
  const dueToday = open.filter((t) => t.due === today);
  const week = open.filter((t) => t.due && t.due > today && t.due <= weekEnd);
  const noDate = open.filter((t) => !t.due);
  const line = (t, withDue) => `- ${t.owner === 'agent' ? '🤖 ' : ''}${clip(t.title, 70)}${t.priority === 'high' ? ' (high priority)' : ''}${withDue && t.due ? ` - ${prettyDay(t.due)}` : ''}`;
  const list = (title, items, withDue, max = 8) => (items.length
    ? [`${title} (${items.length})`, ...items.slice(0, max).map((t) => line(t, withDue)), ...(items.length > max ? [`...and ${items.length - max} more`] : []), ''] : []);

  const since = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
  const active = db.prepare("SELECT r.status, t.title FROM runs r JOIN tasks t ON t.id = r.task_id WHERE r.status IN ('needs_input','needs_approval','blocked','running','queued') ORDER BY r.id").all();
  const recent = db.prepare("SELECT r.status, r.report_status, t.title FROM runs r JOIN tasks t ON t.id = r.task_id WHERE r.status IN ('finished','failed','timed_out') AND r.ended_at >= ? ORDER BY r.id").all(since);
  const doneCount = db.prepare("SELECT COUNT(*) AS n FROM tasks WHERE status = 'done' AND completed_at >= ?").get(since).n;
  const needLabel = { needs_input: 'has a question', needs_approval: 'needs your approval', blocked: 'is blocked' };

  const out = [`${hello}. It is ${longDate}.`, ''];
  if (!open.length) out.push('Nothing open on your list. Enjoy it.', '');
  else out.push(`${open.length} open: ${dueToday.length} due today, ${overdue.length} overdue.`, '');
  out.push(...list('OVERDUE', overdue, true), ...list('DUE TODAY', dueToday, false), ...list('NEXT 7 DAYS', week, true, 6));
  if (noDate.length) out.push(`NO DUE DATE (${noDate.length}): ${noDate.slice(0, 4).map((t) => clip(t.title, 40)).join(', ')}${noDate.length > 4 ? ', ...' : ''}`, '');

  const agentLines = [
    ...active.filter((r) => needLabel[r.status]).map((r) => `- Needs you: ${clip(r.title, 60)} ${needLabel[r.status]}`),
    ...active.filter((r) => r.status === 'running').map((r) => `- Working: ${clip(r.title, 60)}`),
    ...active.filter((r) => r.status === 'queued').map((r) => `- Waiting in line: ${clip(r.title, 60)}`),
    ...recent.map((r) => `- ${r.status === 'finished' ? (r.report_status === 'partial' ? 'Partly done' : 'Finished') : r.status === 'timed_out' ? 'Hit the time limit' : 'Problem'}: ${clip(r.title, 60)}`),
  ];
  if (agentLines.length) out.push('AGENT', ...agentLines.slice(0, 8), '');

  out.push(`Done in the last 24 hours: ${doneCount}.`);
  const u = readUsage(db);
  if (u && u.five_hour && u.seven_day) out.push(`Plan usage: 5-hour ${Math.round(u.five_hour.u * 100)}%, 7-day ${Math.round(u.seven_day.u * 100)}%.`);
  out.push('', `Open: ${PUBLIC_URL}`);
  return out.join('\n');
}

// Called often by the worker; sends once per day inside a 3-hour window after the chosen time.
async function maybeSendBriefing(db) {
  if (getSetting(db, 'briefing_enabled') === '0' || !getSetting(db, 'telegram_chat_id')) return false;
  const [h, m] = (getSetting(db, 'briefing_time') || '09:00').split(':').map(Number);
  const sched = h * 60 + m;
  const now = localParts();
  if (getSetting(db, 'briefing_last_sent') === now.date) return false;
  if (now.minutes < sched || now.minutes > sched + 180) return false;
  const lastTry = Number(getSetting(db, 'briefing_last_try') || 0);
  if (Date.now() - lastTry < 5 * 60 * 1000) return false; // after a failed send, wait 5 minutes before trying again
  setSetting(db, 'briefing_last_try', String(Date.now()));
  const ok = await sendTelegram(db, buildBriefingText(db));
  if (ok) { setSetting(db, 'briefing_last_sent', now.date); return true; }
  return false;
}

module.exports = {
  localParts, buildBriefingText, maybeSendBriefing,
  readChangeLog,
  RUN_TIMEOUT_MS_DEFAULT, ACTIVE, NEEDS_YOU, WARN_AT, PAUSE_AT, TZ,
  nowIso, initAgentSchema, getSetting, setSetting, delSetting, logRun, getRun, activeRunForTask, latestRunsByTask,
  queueRun, requeueRun, telegramApi, sendTelegram, fmtReset, parseUsage, saveUsage, readUsage, pausedUntil, checkUsageAlerts,
};
