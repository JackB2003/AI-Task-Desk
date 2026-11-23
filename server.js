'use strict';
// AI Task Desk: a personal task list where some tasks are handed to an AI agent.
// Web app + JSON API. No npm dependencies. Needs Node 22.13+ (built-in node:sqlite).
//
// Two ways to run it:
//   normal  one user, one password, one SQLite file; the agent runs through worker.js
//   DEMO=1  public showcase: every visitor gets a private in-memory copy with fake data,
//           and the "agent" is a scripted simulation (demo.js). Nothing can reach a shell or an AI.

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { AsyncLocalStorage } = require('node:async_hooks');

const C = require('./config');
const A = require('./agentlib');
const F = require('./attach');
const { openDb } = require('./db');
const Auth = require('./auth');
const AI = require('./aicheck');

const { ROOT, env, TZ, PORT, HOST, DEMO } = C;
const COOKIE_PATH = env.COOKIE_PATH || '/';
const DISPLAY_NAME = (env.DISPLAY_NAME || '').trim().slice(0, 40);
const REPO_URL = env.DEMO_REPO_URL || 'https://github.com/JackB2003/ai-task-desk';
const CSRF_HEADER = 'ai-task-desk';

// Every request runs inside als.run({ db, demo }), so the helpers below always talk to the
// right database (the single real one, or the visitor's own copy in demo mode).
const als = new AsyncLocalStorage();
const D = () => als.getStore().db;
const S = () => als.getStore().demo;

let mainDb = null;
let auth = null;
let demoMgr = null;
if (DEMO) {
  demoMgr = require('./demo').createManager({ tz: TZ });
} else {
  mainDb = openDb(C.DB_FILE);
  auth = Auth.makeAuth(Auth.loadSessionSecret(env, C.DATA_DIR));
}

// ---------- small helpers ----------

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

const getSetting = (k) => A.getSetting(D(), k);
const setSetting = (k, v) => A.setSetting(D(), k, v);
const nowIso = () => new Date().toISOString();

const todayLocal = () => new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
const weekdayLocal = () => new Intl.DateTimeFormat('en-US', { timeZone: TZ, weekday: 'long' }).format(new Date());

function addDays(dateStr, n) {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function validDate(s) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

// ---------- failed-attempt throttle (per IP, in memory) ----------

const failures = new Map();
const FAIL_LIMIT = 20;
const FAIL_WINDOW_MS = 15 * 60 * 1000;

function tooManyFailures(ip) {
  const f = failures.get(ip);
  if (!f) return false;
  if (Date.now() - f.first > FAIL_WINDOW_MS) { failures.delete(ip); return false; }
  return f.count >= FAIL_LIMIT;
}

function noteFailure(ip) {
  const f = failures.get(ip);
  if (!f || Date.now() - f.first > FAIL_WINDOW_MS) failures.set(ip, { count: 1, first: Date.now() });
  else f.count += 1;
}

setInterval(() => {
  for (const [ip, f] of failures) if (Date.now() - f.first > FAIL_WINDOW_MS) failures.delete(ip);
}, 10 * 60 * 1000).unref();

// ---------- request identity ----------

// A reverse proxy (nginx, Caddy) can pass the real client address in X-Real-IP. It is only
// trusted when the connection really came from this machine's proxy.
function isLoopback(addr) {
  return addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1';
}

function clientIp(req) {
  let ip = req.socket.remoteAddress || '';
  if (isLoopback(ip) && env.TRUST_PROXY === '1' && req.headers['x-real-ip']) ip = String(req.headers['x-real-ip']);
  return ip.replace(/^::ffff:/, '');
}

// True only for a direct connection from this machine (not through a proxy), used for first-run setup.
const isDirectLocal = (req) => isLoopback(req.socket.remoteAddress || '') && !req.headers['x-forwarded-for'] && !req.headers['x-real-ip'];

const isHttps = (req) => env.COOKIE_SECURE === '1' || String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https';

function sessionCookie(req, token, maxAgeSeconds) {
  return `atd_session=${token}; Path=${COOKIE_PATH}; HttpOnly; SameSite=Strict; Max-Age=${maxAgeSeconds}${isHttps(req) ? '; Secure' : ''}`;
}

function authUser(req) {
  if (DEMO) return { actor: 'me', via: 'demo' };
  const tok = Auth.parseCookies(req).atd_session;
  if (tok && auth.verifyToken(D(), tok)) return { actor: 'me', via: 'session' };
  return null;
}

// ---------- tasks ----------

const COLS = 'id, title, notes, due, priority, owner, status, created_by, created_at, updated_at, completed_at, archived_at';
const PRIORITIES = ['high', 'normal', 'low'];
const OWNERS = ['me', 'agent'];
const STATUS_FILTERS = ['open', 'done', 'archived', 'all'];

const plain = (row) => (row ? { ...row } : null);
const getTask = (id) => plain(D().prepare(`SELECT ${COLS} FROM tasks WHERE id = ?`).get(id));

function listTasks(status) {
  const prio = "CASE priority WHEN 'high' THEN 0 WHEN 'normal' THEN 1 ELSE 2 END";
  let sql;
  if (status === 'open') sql = `SELECT ${COLS} FROM tasks WHERE status = 'open' ORDER BY ${prio}, due IS NULL, due, id`;
  else if (status === 'done') sql = `SELECT ${COLS} FROM tasks WHERE status = 'done' ORDER BY completed_at DESC, id DESC`;
  else if (status === 'archived') sql = `SELECT ${COLS} FROM tasks WHERE status = 'archived' ORDER BY archived_at DESC, id DESC`;
  else sql = `SELECT ${COLS} FROM tasks ORDER BY id DESC`;
  return D().prepare(sql).all().map(plain);
}

function logEvent(taskId, actor, action, detail) {
  D().prepare('INSERT INTO task_events (task_id, actor, action, detail, at) VALUES (?, ?, ?, ?, ?)')
    .run(taskId, actor, action, detail || null, nowIso());
}

// allowStatus: list of status values the caller may set (empty = status not editable).
function parseTaskInput(body, { creating = false, allowStatus = [] } = {}) {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) throw new HttpError(400, 'A JSON object is required');
  const allowed = ['title', 'notes', 'due', 'priority', 'owner', ...(allowStatus.length ? ['status'] : [])];
  for (const k of Object.keys(body)) {
    if (!allowed.includes(k)) throw new HttpError(400, `Field not allowed: ${k}. Allowed fields: ${allowed.join(', ')}`);
  }
  const v = {};
  if (creating || 'title' in body) {
    const t = typeof body.title === 'string' ? body.title.trim() : '';
    if (!t || t.length > 200) throw new HttpError(400, 'title is required (1 to 200 characters)');
    v.title = t;
  }
  if ('notes' in body) {
    if (typeof body.notes !== 'string' || body.notes.length > 5000) throw new HttpError(400, 'notes must be text up to 5000 characters');
    v.notes = body.notes;
  }
  if ('due' in body) {
    if (body.due === null || body.due === '') v.due = null;
    else if (typeof body.due === 'string' && validDate(body.due)) v.due = body.due;
    else throw new HttpError(400, 'due must be a date like 2026-11-30, or null');
  }
  if ('priority' in body) {
    if (!PRIORITIES.includes(body.priority)) throw new HttpError(400, `priority must be one of: ${PRIORITIES.join(', ')}`);
    v.priority = body.priority;
  }
  if ('owner' in body) {
    if (!OWNERS.includes(body.owner)) throw new HttpError(400, `owner must be one of: ${OWNERS.join(', ')}`);
    v.owner = body.owner;
  }
  if ('status' in body) {
    if (!allowStatus.includes(body.status)) throw new HttpError(400, `status can only be set to: ${allowStatus.join(', ')} (use the archive action to archive)`);
    v.status = body.status;
  }
  return v;
}

function createTask(v, actor) {
  if (S() && D().prepare('SELECT COUNT(*) AS n FROM tasks').get().n >= demoMgr.limits.tasks) {
    throw new HttpError(429, `The demo holds up to ${demoMgr.limits.tasks} tasks. Archive some, or press "Reset demo".`);
  }
  const now = nowIso();
  const info = D().prepare(
    'INSERT INTO tasks (title, notes, due, priority, owner, status, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
  ).run(v.title, v.notes || '', v.due ?? null, v.priority || 'normal', v.owner || 'me', 'open', actor, now, now);
  const id = Number(info.lastInsertRowid);
  logEvent(id, actor, 'created', v.title);
  return getTask(id);
}

function updateTask(id, v, actor) {
  const t = getTask(id);
  if (!t) throw new HttpError(404, 'Task not found');
  if (t.status === 'archived') throw new HttpError(409, 'Task is archived. Restore it before editing.');
  const sets = [];
  const args = [];
  const changed = [];
  for (const k of ['title', 'notes', 'due', 'priority', 'owner']) {
    if (k in v && v[k] !== t[k]) { sets.push(`${k} = ?`); args.push(v[k]); changed.push(k); }
  }
  const statusChanged = 'status' in v && v.status !== t.status;
  if (statusChanged) {
    sets.push('status = ?', 'completed_at = ?');
    args.push(v.status, v.status === 'done' ? nowIso() : null);
  }
  if (!sets.length) return t;
  sets.push('updated_at = ?');
  args.push(nowIso());
  D().prepare(`UPDATE tasks SET ${sets.join(', ')} WHERE id = ?`).run(...args, id);
  if (statusChanged) logEvent(id, actor, v.status === 'done' ? 'completed' : 'reopened');
  if (changed.length) logEvent(id, actor, 'edited', changed.join(', '));
  return getTask(id);
}

function archiveTask(id, actor) {
  const t = getTask(id);
  if (!t) throw new HttpError(404, 'Task not found');
  if (t.status === 'archived') return t;
  const now = nowIso();
  D().prepare("UPDATE tasks SET status = 'archived', archived_at = ?, updated_at = ? WHERE id = ?").run(now, now, id);
  logEvent(id, actor, 'archived');
  return getTask(id);
}

function restoreTask(id, actor) {
  const t = getTask(id);
  if (!t) throw new HttpError(404, 'Task not found');
  if (t.status !== 'archived') throw new HttpError(409, 'Task is not archived');
  D().prepare('UPDATE tasks SET status = ?, archived_at = NULL, updated_at = ? WHERE id = ?')
    .run(t.completed_at ? 'done' : 'open', nowIso(), id);
  logEvent(id, actor, 'restored');
  return getTask(id);
}

function buildBriefing() {
  const today = todayLocal();
  const weekEnd = addDays(today, 7);
  const since = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
  const open = listTasks('open');
  const overdue = open.filter((t) => t.due && t.due < today);
  const dueToday = open.filter((t) => t.due === today);
  const nextWeek = open.filter((t) => t.due && t.due > today && t.due <= weekEnd);
  const noDate = open.filter((t) => !t.due);
  const later = open.filter((t) => t.due && t.due > weekEnd);
  const completed = D().prepare(`SELECT ${COLS} FROM tasks WHERE status = 'done' AND completed_at >= ? ORDER BY completed_at DESC`).all(since).map(plain);
  const added = D().prepare(`SELECT ${COLS} FROM tasks WHERE created_at >= ? ORDER BY id DESC`).all(since).map(plain);
  return {
    generated_at: nowIso(),
    date: today,
    weekday: weekdayLocal(),
    timezone: TZ,
    counts: {
      open: open.length,
      overdue: overdue.length,
      due_today: dueToday.length,
      due_next_7_days: nextWeek.length,
      no_due_date: noDate.length,
      open_for_me: open.filter((t) => t.owner === 'me').length,
      open_for_agent: open.filter((t) => t.owner === 'agent').length,
    },
    overdue,
    due_today: dueToday,
    due_next_7_days: nextWeek,
    due_later: later,
    no_due_date: noDate,
    completed_last_24h: completed,
    added_last_24h: added,
  };
}

// ---------- http plumbing ----------

function send(res, status, obj, extraHeaders) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    ...extraHeaders,
  });
  res.end(body);
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size <= 65536) chunks.push(c); // past the limit: keep draining, store nothing
    });
    req.on('end', () => {
      if (size > 65536) { reject(new HttpError(413, 'Request body too large (64 KB max)')); return; }
      if (!size) { resolve({}); return; }
      if (!/^application\/json/i.test(req.headers['content-type'] || '')) { reject(new HttpError(415, 'Content-Type must be application/json')); return; }
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch { reject(new HttpError(400, 'Invalid JSON')); }
    });
    req.on('error', reject);
  });
}

// Raw file bodies (screenshots etc.). Anything past the cap is drained, not stored.
function readRaw(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size <= limit) chunks.push(c);
    });
    req.on('end', () => {
      if (size > limit) reject(new HttpError(413, `That file is too big (${Math.round(limit / 1048576)} MB max)`));
      else resolve(Buffer.concat(chunks));
    });
    req.on('error', reject);
  });
}

function statusParam(url, fallback) {
  const s = url.searchParams.get('status') || fallback;
  if (!STATUS_FILTERS.includes(s)) throw new HttpError(400, `status must be one of: ${STATUS_FILTERS.join(', ')}`);
  return s;
}

const STATIC = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/index.html': ['index.html', 'text/html; charset=utf-8'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/style.css': ['style.css', 'text/css; charset=utf-8'],
  '/favicon.svg': ['favicon.svg', 'image/svg+xml'],
};

const PAGE_CSP = "default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'";

function serveStatic(res, p) {
  const entry = STATIC[p];
  if (!entry) throw new HttpError(404, 'Not found');
  const data = fs.readFileSync(path.join(ROOT, 'public', entry[0]));
  res.writeHead(200, {
    'Content-Type': entry[1], 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff',
    ...(entry[0] === 'index.html' ? { 'Content-Security-Policy': PAGE_CSP, 'Referrer-Policy': 'no-referrer' } : {}),
  });
  res.end(data);
}

// ---------- agent runs ----------

const runDirOf = (id) => path.join(C.DATA_DIR, 'runs', String(id));
const safeParse = (s, fallback) => { try { return s ? JSON.parse(s) : fallback; } catch { return fallback; } };

function agentStatus() {
  const db = D();
  const usage = S() ? demoMgr.fakeUsage(S()) : A.readUsage(db);
  const nowS = Date.now() / 1000;
  const running = db.prepare("SELECT id, task_id FROM runs WHERE status = 'running' LIMIT 1").get();
  const queued = db.prepare("SELECT COUNT(*) AS n FROM runs WHERE status = 'queued'").get().n;
  const needs = db.prepare(`SELECT COUNT(*) AS n FROM runs WHERE status IN (${A.NEEDS_YOU.map(() => '?').join(',')})`).get(...A.NEEDS_YOU).n;
  const hit = Number(getSetting('limit_hit_until') || 0);
  const until = Math.max(A.pausedUntil(usage), hit > nowS ? hit : 0);
  const beat = getSetting('worker_heartbeat');
  const pct = (w) => (w ? { percent: Math.round(w.u * 100), resets_at: w.resetsAt } : null);
  return {
    running: running ? { run_id: running.id, task_id: running.task_id } : null,
    queued, needs_you: needs,
    usage: usage ? { five_hour: pct(usage.five_hour), seven_day: pct(usage.seven_day), at: usage.at } : null,
    paused_until: until > nowS ? until : 0,
    worker_ok: DEMO || (!!beat && Date.now() - Date.parse(beat) < 60000),
    telegram: { token_set: !!getSetting('telegram_token'), connected: !!getSetting('telegram_chat_id') },
    briefing: { enabled: getSetting('briefing_enabled') !== '0', time: getSetting('briefing_time') || '09:00', last_sent: getSetting('briefing_last_sent') },
  };
}

function runDetail(runId) {
  const run = A.getRun(D(), runId);
  if (!run) throw new HttpError(404, 'Run not found');
  const log = D().prepare('SELECT at, kind, text FROM run_log WHERE run_id = ? ORDER BY id').all(runId).map(plain);
  if (S()) {
    return { run: { ...run, pending_action: safeParse(run.pending_action, null), grants: undefined }, log, changes: demoMgr.changesOf(S(), runId), undone: demoMgr.isUndone(S(), runId) };
  }
  const changes = A.readChangeLog(runDirOf(runId)).map((c) => ({ path: c.path, existed: c.existed, tool: c.tool, at: c.at }));
  const undone = fs.existsSync(path.join(runDirOf(runId), 'undone.flag'));
  return { run: { ...run, pending_action: safeParse(run.pending_action, null), grants: undefined }, log, changes, undone };
}

// Put every file the agent edited back as it was; files the agent created are moved aside, not deleted.
function undoRun(runId, actor) {
  const run = A.getRun(D(), runId);
  if (!run) throw new HttpError(404, 'Run not found');
  if (run.status === 'running') throw new HttpError(409, 'Stop the run before undoing its changes');
  if (S()) {
    const out = demoMgr.undo(S(), runId);
    if (!out) throw new HttpError(409, 'This run has no recorded file changes, or was already undone');
    A.logRun(D(), runId, 'undo', `Undone: ${out.restored} restored, ${out.removed} new files moved aside (simulated)`);
    logEvent(run.task_id, actor, 'agent_undo', `${out.restored} restored, ${out.removed} removed`);
    return out;
  }
  const dir = runDirOf(runId);
  if (fs.existsSync(path.join(dir, 'undone.flag'))) throw new HttpError(409, 'This run was already undone');
  const changes = A.readChangeLog(dir).reverse();
  if (!changes.length) throw new HttpError(409, 'This run has no recorded file changes');
  let restored = 0;
  let removed = 0;
  const failed = [];
  fs.mkdirSync(path.join(dir, 'removed'), { recursive: true });
  for (const c of changes) {
    try {
      if (c.existed && c.bak) {
        fs.copyFileSync(path.join(dir, 'before', c.bak), c.path);
        if (c.mode != null) fs.chmodSync(c.path, c.mode);
        restored += 1;
      } else if (!c.existed && fs.existsSync(c.path)) {
        fs.renameSync(c.path, path.join(dir, 'removed', `${removed + 1}-${path.basename(c.path)}`));
        removed += 1;
      }
    } catch (e) { failed.push(`${c.path}: ${e.message}`); }
  }
  fs.writeFileSync(path.join(dir, 'undone.flag'), nowIso());
  A.logRun(D(), runId, 'undo', `Undone by ${actor}: ${restored} restored, ${removed} new files moved aside${failed.length ? `, ${failed.length} failed` : ''}`);
  logEvent(run.task_id, actor, 'agent_undo', `${restored} restored, ${removed} removed`);
  return { restored, removed, failed };
}

const NOT_IN_DEMO = 'This is switched off in the live demo. Run AI Task Desk yourself to use it (see the README).';

async function agentRoute(req, res, url, p, actor) {
  const db = D();
  if (p === '/api/agent/status' && req.method === 'GET') return send(res, 200, agentStatus());

  let m = p.match(/^\/api\/tasks\/(\d+)\/work$/);
  if (m && req.method === 'POST') {
    await readJson(req);
    const id = Number(m[1]);
    const t = getTask(id);
    if (!t) throw new HttpError(404, 'Task not found');
    if (t.status !== 'open') throw new HttpError(409, 'Only open tasks can be worked on');
    if (t.owner !== 'agent') throw new HttpError(409, 'This task is marked Mine. Change "Who does it" to Agent first.');
    if (A.activeRunForTask(db, id)) throw new HttpError(409, 'This task already has a run in progress');
    if (S() && !demoMgr.canStartRun(S())) throw new HttpError(429, `The demo allows ${demoMgr.limits.runs} agent runs per visit. Press "Reset demo" to start over.`);
    const runId = A.queueRun(db, id, null);
    logEvent(id, actor, 'agent_queued', t.title);
    if (S()) demoMgr.kick(S());
    return send(res, 201, { run_id: runId });
  }

  m = p.match(/^\/api\/runs\/(\d+)$/);
  if (m && req.method === 'GET') return send(res, 200, runDetail(Number(m[1])));

  m = p.match(/^\/api\/runs\/(\d+)\/(answer|approve|stop|resume|undo)$/);
  if (m && req.method === 'POST') {
    const runId = Number(m[1]);
    const action = m[2];
    const run = A.getRun(db, runId);
    if (!run) throw new HttpError(404, 'Run not found');
    const body = await readJson(req);
    if (action === 'answer') {
      if (!['needs_input', 'blocked'].includes(run.status)) throw new HttpError(409, 'This run is not waiting for an answer');
      const text = typeof body.text === 'string' ? body.text.trim() : '';
      if (!text || text.length > 4000) throw new HttpError(400, 'Type an answer (up to 4000 characters)');
      A.logRun(db, runId, 'answer', text);
      A.requeueRun(db, runId, `The user answered:\n"""\n${text}\n"""\nContinue the task.`);
    } else if (action === 'approve') {
      if (run.status !== 'needs_approval') throw new HttpError(409, 'This run is not waiting for approval');
      const pending = safeParse(run.pending_action, null);
      if (!pending) throw new HttpError(409, 'No pending action recorded');
      if (body.decision === 'deny') {
        A.logRun(db, runId, 'denied', pending.value);
        A.requeueRun(db, runId, `The user DENIED this action: ${pending.value}\nDo not do it and do not look for a way around it. Continue with another approach if there is one; otherwise finish with status blocked and explain.`);
      } else {
        const grants = safeParse(run.grants, []);
        grants.push({ kind: pending.kind, value: pending.value, canon: pending.canon || null });
        A.logRun(db, runId, 'approved', pending.value);
        const prompt = pending.kind === 'bash'
          ? `The user approved this action: ${pending.value}\nRun it now as its own single command (you may first cd into that folder as a separate step, or use git -C), then continue the task.`
          : `The user approved access to this path: ${pending.value}\nContinue the task.`;
        A.requeueRun(db, runId, prompt, { grants: JSON.stringify(grants) });
      }
    } else if (action === 'stop') {
      if (S() && ['running', 'queued'].includes(run.status)) demoMgr.stop(S(), runId);
      else if (run.status === 'running') db.prepare('UPDATE runs SET stop_requested = 1, updated_at = ? WHERE id = ?').run(nowIso(), runId);
      else if (['queued', 'needs_input', 'needs_approval', 'blocked'].includes(run.status)) {
        db.prepare("UPDATE runs SET status = 'stopped', summary = 'Stopped by you.', ended_at = ?, updated_at = ? WHERE id = ?").run(nowIso(), nowIso(), runId);
        A.logRun(db, runId, 'stopped', 'Stopped by you');
      } else throw new HttpError(409, 'This run is not active');
    } else if (action === 'resume') {
      if (!['failed', 'stopped', 'timed_out'].includes(run.status)) throw new HttpError(409, 'This run cannot be resumed');
      const t = getTask(run.task_id);
      if (!t || t.status !== 'open') throw new HttpError(409, 'The task is no longer open');
      const act = A.activeRunForTask(db, t.id);
      if (act && act.id !== runId) throw new HttpError(409, 'Another run is already active for this task');
      const why = { timed_out: 'You were stopped by the time limit.', stopped: 'The user stopped the run earlier and now wants you to continue.', failed: 'The previous attempt ended with a problem.' }[run.status];
      A.logRun(db, runId, 'resumed', 'Resumed by you');
      A.requeueRun(db, runId, run.session_id ? `${why} Continue where you left off.` : null);
    } else if (action === 'undo') {
      return send(res, 200, undoRun(runId, actor));
    }
    if (S() && ['answer', 'approve', 'resume'].includes(action)) demoMgr.kick(S());
    return send(res, 200, { run: runDetail(runId).run });
  }

  // ----- Telegram setup (the token is stored in the database and never sent back) -----
  if (p.startsWith('/api/telegram/') || p === '/api/briefing/send-now') {
    if (S()) throw new HttpError(403, NOT_IN_DEMO);
  }
  if (p === '/api/telegram/token' && req.method === 'POST') {
    const body = await readJson(req);
    const token = typeof body.token === 'string' ? body.token.trim() : '';
    if (!/^\d{5,}:[A-Za-z0-9_-]{30,}$/.test(token)) throw new HttpError(400, 'That does not look like a bot token. It looks like 123456789:ABC... and comes from BotFather.');
    let me;
    try { me = await A.telegramApi(token, 'getMe'); } catch (e) { throw new HttpError(400, `Telegram did not accept that token (${e.message})`); }
    setSetting('telegram_token', token);
    A.delSetting(db, 'telegram_chat_id');
    return send(res, 200, { ok: true, bot: me.username });
  }
  if (p === '/api/telegram/connect' && req.method === 'POST') {
    const token = getSetting('telegram_token');
    if (!token) throw new HttpError(409, 'Save the bot token first');
    let updates;
    try { updates = await A.telegramApi(token, 'getUpdates', { limit: 25, timeout: 0 }); } catch (e) { throw new HttpError(502, `Could not reach Telegram (${e.message})`); }
    const msgs = (updates || []).map((u) => u.message).filter((m2) => m2 && m2.chat && m2.chat.type === 'private');
    if (!msgs.length) throw new HttpError(409, 'No message found yet. Open your bot in Telegram, send it any message (like "hi"), then press Connect again.');
    const chat = msgs[msgs.length - 1].chat;
    setSetting('telegram_chat_id', String(chat.id));
    const sent = await A.sendTelegram(db, 'AI Task Desk is connected. You will get agent updates and plan-usage warnings here.');
    return send(res, 200, { ok: true, name: chat.first_name || chat.username || 'you', test_sent: sent });
  }
  if (p === '/api/telegram/test' && req.method === 'POST') {
    if (!getSetting('telegram_chat_id')) throw new HttpError(409, 'Telegram is not connected yet');
    const ok = await A.sendTelegram(db, 'Test message from AI Task Desk. If you can read this, alerts will reach you.');
    if (!ok) throw new HttpError(502, 'The test message could not be sent');
    return send(res, 200, { ok: true });
  }
  if (p === '/api/telegram/disconnect' && req.method === 'POST') {
    A.delSetting(db, 'telegram_token');
    A.delSetting(db, 'telegram_chat_id');
    return send(res, 200, { ok: true });
  }
  // ----- daily briefing -----
  if (p === '/api/briefing/text' && req.method === 'GET') return send(res, 200, { text: A.buildBriefingText(db) });
  if (p === '/api/briefing/settings' && req.method === 'POST') {
    const body = await readJson(req);
    if (typeof body.enabled !== 'boolean') throw new HttpError(400, 'enabled must be true or false');
    if (typeof body.time !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(body.time)) throw new HttpError(400, 'time must look like 09:00');
    setSetting('briefing_enabled', body.enabled ? '1' : '0');
    setSetting('briefing_time', body.time);
    return send(res, 200, { ok: true });
  }
  if (p === '/api/briefing/send-now' && req.method === 'POST') {
    if (!getSetting('telegram_chat_id')) throw new HttpError(409, 'Telegram is not connected yet');
    const ok = await A.sendTelegram(db, A.buildBriefingText(db));
    if (!ok) throw new HttpError(502, 'The briefing could not be sent');
    return send(res, 200, { ok: true });
  }
  return false; // not an agent route
}

// ---------- AI connection (the "AI connection" screen) ----------

let aiVersionCache = null; // { at, version }: checking the install takes a moment, so remember it for 30 seconds
let aiTestBusy = false;
let aiTestLast = 0;

function aiStatus() {
  if (S()) {
    return { demo: true, installed: true, version: 'simulated', mode: 'subscription', apiKeySet: false, workspace: 'workspace/', worker_ok: true, installUrl: AI.INSTALL_URL,
      tested: S().aiTested ? { at: nowIso(), ok: true, simulated: true } : null };
  }
  if (!aiVersionCache || Date.now() - aiVersionCache.at > 30000) aiVersionCache = { at: Date.now(), version: AI.version() };
  const beat = getSetting('worker_heartbeat');
  return {
    demo: false, installed: !!aiVersionCache.version, version: aiVersionCache.version,
    mode: AI.useApiKey() ? 'api' : 'subscription', apiKeySet: !!env.ANTHROPIC_API_KEY,
    workspace: C.WORKSPACE, worker_ok: !!beat && Date.now() - Date.parse(beat) < 60000, installUrl: AI.INSTALL_URL,
    tested: safeParse(getSetting('ai_test'), null),
  };
}

async function aiTest() {
  if (S()) {
    await new Promise((r) => setTimeout(r, 900)); // pretend to think
    S().aiTested = true;
    return { ok: true, simulated: true };
  }
  aiVersionCache = null;
  if (!AI.version()) throw new HttpError(409, `Claude Code was not found (looked for "${AI.CLAUDE_BIN}"). Install it first, then test again.`);
  if (aiTestBusy) throw new HttpError(409, 'A test is already running. Give it a moment.');
  if (Date.now() - aiTestLast < 10000) throw new HttpError(429, 'Please wait a few seconds between tests.');
  aiTestBusy = true;
  aiTestLast = Date.now();
  try {
    const r = await AI.testLogin();
    const out = { at: nowIso(), ok: r.ok, ...(r.ok ? {} : { why: r.why }) };
    setSetting('ai_test', JSON.stringify(out));
    return out;
  } finally { aiTestBusy = false; }
}

// ---------- browser API ----------

async function uiRoute(req, res, ip, url, p) {
  const db = D();
  const needsSetup = !DEMO && !getSetting('password_hash');

  // First run: create the password. Only from this machine, and only while no password exists.
  if (p === '/api/setup' && req.method === 'POST') {
    if (DEMO) throw new HttpError(403, NOT_IN_DEMO);
    if (req.headers['x-requested-with'] !== CSRF_HEADER) throw new HttpError(403, 'Bad request');
    if (!needsSetup) throw new HttpError(409, 'A password is already set');
    if (!isDirectLocal(req)) throw new HttpError(403, 'First-time setup must be done from the machine running AI Task Desk. Or run: npm run setup');
    const body = await readJson(req);
    if (typeof body.password !== 'string' || body.password.length < 12) throw new HttpError(400, 'Password must be at least 12 characters');
    setSetting('password_hash', Auth.hashPassword(body.password));
    return send(res, 200, { ok: true }, { 'Set-Cookie': sessionCookie(req, auth.makeToken(db), 30 * 24 * 3600) });
  }

  if (p === '/api/login' && req.method === 'POST') {
    if (DEMO) throw new HttpError(404, 'No login in the demo');
    if (req.headers['x-requested-with'] !== CSRF_HEADER) throw new HttpError(403, 'Bad request');
    if (tooManyFailures(ip)) throw new HttpError(429, 'Too many failed attempts. Try again in 15 minutes.');
    const body = await readJson(req);
    const stored = getSetting('password_hash');
    if (!stored) throw new HttpError(400, 'No password is set yet. Open this page on the machine running AI Task Desk, or run: npm run setup');
    if (!Auth.verifyPassword(String(body.password || ''), stored)) { noteFailure(ip); throw new HttpError(401, 'Wrong password'); }
    return send(res, 200, { ok: true }, { 'Set-Cookie': sessionCookie(req, auth.makeToken(db), 30 * 24 * 3600) });
  }

  const user = authUser(req);
  if (p === '/api/me' && req.method === 'GET') {
    if (!user) return send(res, 401, { error: 'Login required', needsSetup, canSetupHere: needsSetup && isDirectLocal(req) });
    return send(res, 200, {
      actor: user.actor, via: user.via, today: todayLocal(), timezone: TZ, name: DISPLAY_NAME, demo: DEMO, repo: DEMO ? REPO_URL : undefined,
      demoLimits: DEMO ? demoMgr.limits : undefined,
    });
  }
  if (!user) throw new HttpError(401, 'Login required');
  if (req.method !== 'GET' && req.headers['x-requested-with'] !== CSRF_HEADER) throw new HttpError(403, 'Bad request');
  const actor = user.actor;

  if (p === '/api/logout' && req.method === 'POST') return send(res, 200, { ok: true }, { 'Set-Cookie': sessionCookie(req, '', 0) });

  if (p === '/api/demo/reset' && req.method === 'POST') {
    if (!DEMO) throw new HttpError(404, 'Unknown endpoint');
    demoMgr.reset(S());
    return send(res, 200, { ok: true });
  }

  if (p === '/api/ai/status' && req.method === 'GET') return send(res, 200, aiStatus());
  if (p === '/api/ai/test' && req.method === 'POST') return send(res, 200, await aiTest());

  if (p === '/api/password' && req.method === 'POST') {
    if (DEMO) throw new HttpError(403, NOT_IN_DEMO);
    const body = await readJson(req);
    if (typeof body.password !== 'string' || body.password.length < 12) throw new HttpError(400, 'Password must be at least 12 characters');
    const stored = getSetting('password_hash');
    if (stored && !Auth.verifyPassword(String(body.current || ''), stored)) throw new HttpError(403, 'Current password is incorrect');
    setSetting('password_hash', Auth.hashPassword(body.password));
    setSetting('session_epoch', crypto.randomBytes(8).toString('hex')); // signs out every other device
    logEvent(null, actor, 'password_changed');
    return send(res, 200, { ok: true }, { 'Set-Cookie': sessionCookie(req, auth.makeToken(db), 30 * 24 * 3600) });
  }

  if (p === '/api/briefing' && req.method === 'GET') return send(res, 200, buildBriefing());

  if (p === '/api/activity' && req.method === 'GET') {
    const limit = Math.min(Math.max(Number(url.searchParams.get('limit')) || 50, 1), 200);
    const rows = db.prepare(
      'SELECT e.id, e.task_id, e.actor, e.action, e.detail, e.at, t.title FROM task_events e LEFT JOIN tasks t ON t.id = e.task_id ORDER BY e.id DESC LIMIT ?'
    ).all(limit).map(plain);
    return send(res, 200, { events: rows });
  }

  if (p === '/api/tasks' && req.method === 'GET') {
    const runs = A.latestRunsByTask(db);
    const files = new Map();
    for (const a of db.prepare('SELECT id, task_id, name, mime, size FROM attachments ORDER BY id').all()) {
      if (!files.has(a.task_id)) files.set(a.task_id, []);
      files.get(a.task_id).push({ ...a });
    }
    return send(res, 200, { tasks: listTasks(statusParam(url, 'open')).map((t) => ({ ...t, run: runs.get(t.id) || null, files: files.get(t.id) || [] })) });
  }

  // ----- attachments -----
  let am = p.match(/^\/api\/tasks\/(\d+)\/attachments$/);
  if (am && req.method === 'POST') {
    if (DEMO) throw new HttpError(403, 'File uploads are switched off in the live demo.');
    const t = getTask(Number(am[1]));
    if (!t) throw new HttpError(404, 'Task not found');
    if (t.status === 'archived') throw new HttpError(409, 'Task is archived. Restore it before adding files.');
    const buf = await readRaw(req, F.MAX_BYTES);
    let name = '';
    try { name = decodeURIComponent(String(req.headers['x-filename'] || '')); } catch { /* keep empty */ }
    let a;
    try { a = F.save(db, t.id, name, String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase(), buf); }
    catch (e) { throw e.status ? new HttpError(e.status, e.message) : e; }
    logEvent(t.id, actor, 'file_added', a.name);
    return send(res, 201, { file: a });
  }
  am = p.match(/^\/api\/attachments\/(\d+)$/);
  if (am && req.method === 'GET') {
    const a = F.get(db, Number(am[1]));
    if (!a) throw new HttpError(404, 'File not found');
    let data;
    try { data = fs.readFileSync(F.fileOf(a.id, a.mime)); } catch { throw new HttpError(404, 'File not found'); }
    const safeName = encodeURIComponent(a.name);
    res.writeHead(200, {
      'Content-Type': a.mime === 'text/markdown' ? 'text/plain; charset=utf-8' : (a.mime === 'text/plain' ? 'text/plain; charset=utf-8' : a.mime),
      'Content-Length': data.length,
      'Content-Disposition': `${F.isImage(a.mime) ? 'inline' : 'attachment'}; filename*=UTF-8''${safeName}`,
      'Cache-Control': 'private, max-age=3600',
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; sandbox",
    });
    return res.end(data);
  }
  if (am && req.method === 'DELETE') {
    if (DEMO) throw new HttpError(403, 'File uploads are switched off in the live demo.');
    const a = F.get(db, Number(am[1]));
    if (!a) throw new HttpError(404, 'File not found');
    F.remove(db, a.id);
    logEvent(a.task_id, actor, 'file_removed', a.name);
    return send(res, 200, { ok: true });
  }

  if (p === '/api/tasks' && req.method === 'POST') {
    const v = parseTaskInput(await readJson(req), { creating: true });
    return send(res, 201, { task: createTask(v, actor) });
  }
  const m = p.match(/^\/api\/tasks\/(\d+)(?:\/(archive|restore))?$/);
  if (m && !m[2] && req.method === 'PATCH') {
    const v = parseTaskInput(await readJson(req), { allowStatus: ['open', 'done'] });
    return send(res, 200, { task: updateTask(Number(m[1]), v, actor) });
  }
  if (m && m[2] === 'archive' && req.method === 'POST') return send(res, 200, { task: archiveTask(Number(m[1]), actor) });
  if (m && m[2] === 'restore' && req.method === 'POST') return send(res, 200, { task: restoreTask(Number(m[1]), actor) });

  if ((await agentRoute(req, res, url, p, actor)) !== false) return;

  throw new HttpError(404, 'Unknown endpoint');
}

// ---------- server ----------

const server = http.createServer(async (req, res) => {
  const ip = clientIp(req);
  let p = '/';
  try {
    const url = new URL(req.url, 'http://localhost');
    p = url.pathname.length > 1 ? url.pathname.replace(/\/+$/, '') : url.pathname;
    if (!env.QUIET) res.on('finish', () => console.log(`${nowIso()} ${DEMO ? '' : `${ip} `}${req.method} ${p} ${res.statusCode}`));

    if (p === '/healthz') return send(res, 200, { ok: true, demo: DEMO });
    if (p.startsWith('/api/')) {
      if (DEMO) {
        const lease = demoMgr.acquire(req, res, ip, isHttps(req), COOKIE_PATH); // may throw 429/503
        await als.run({ db: lease.sess.db, demo: lease.sess }, () => uiRoute(req, res, ip, url, p));
      } else {
        await als.run({ db: mainDb, demo: null }, () => uiRoute(req, res, ip, url, p));
      }
    } else if (req.method === 'GET' || req.method === 'HEAD') {
      serveStatic(res, p);
    } else {
      throw new HttpError(405, 'Method not allowed');
    }
  } catch (e) {
    if (res.headersSent) return;
    if (e instanceof HttpError) send(res, e.status, { error: e.message });
    else if (e && e.httpStatus) send(res, e.httpStatus, { error: e.message });
    else { console.error(e); send(res, 500, { error: 'Server error' }); }
  }
});

function shutdown() {
  if (demoMgr) demoMgr.shutdown();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1500).unref();
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

server.listen(PORT, HOST, () => {
  console.log(`AI Task Desk listening on http://${HOST}:${PORT}/ ${DEMO ? '(DEMO mode: scripted agent, no AI, per-visitor in-memory data)' : ''}`);
  if (mainDb && !A.getSetting(mainDb, 'password_hash')) {
    console.log('No password yet. Open the page on this machine to create one, or run: npm run setup');
  }
});
