'use strict';
// Live-demo mode (DEMO=1). Safe to put on the public internet because:
//   - every visitor gets a private, in-memory database (nothing on disk, gone after idle time)
//   - the "agent" is a script that writes a believable run into that database
//     (no AI call, no shell, no files, no network)
//   - uploads, Telegram and passwords are switched off (see server.js)
//   - sessions, requests, tasks and runs are all capped
// No npm dependencies.

const crypto = require('node:crypto');
const { env } = require('./config');
const A = require('./agentlib');
const { openDb } = require('./db');
const { parseCookies } = require('./auth');

const STEP_MS = Number(env.DEMO_STEP_MS || 1100); // pause between simulated agent steps
const IDLE_MS = Number(env.DEMO_IDLE_MIN || 45) * 60 * 1000;
const MAX_SESSIONS = Number(env.DEMO_MAX_SESSIONS || 200);
const RATE_PER_MIN = Number(env.DEMO_RATE_PER_MIN || 240); // API calls per IP per minute (the page polls every 5s)
const NEW_SESSIONS_PER_HOUR = Number(env.DEMO_NEW_SESSIONS_PER_HOUR || 30); // per IP
const LIMITS = { tasks: 40, runs: 12 };

const nowIso = () => new Date().toISOString();
const clip = (s, n) => { const t = String(s || '').replace(/\s+/g, ' ').trim(); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };

function httpError(status, message) {
  return Object.assign(new Error(message), { httpStatus: status });
}

// ---------- fake starting data ----------

function addDays(dateStr, n) {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function seed(db, today) {
  const insert = db.prepare(
    'INSERT INTO tasks (title, notes, due, priority, owner, status, created_by, created_at, updated_at, completed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
  );
  const event = db.prepare('INSERT INTO task_events (task_id, actor, action, detail, at) VALUES (?, ?, ?, ?, ?)');
  const now = nowIso();
  const rows = [
    ['Plan the team offsite', 'Find three venues under $5k and compare travel time. I will pick one.', addDays(today, 2), 'high', 'agent'],
    ["Summarize this week's customer feedback", 'Pull themes from the support inbox export. Keep it to one page.', today, 'normal', 'agent'],
    ['Publish the release notes', 'Draft is in the repo. Needs to go out before the demo call.', addDays(today, 1), 'normal', 'agent'],
    ["Review Sam's pull request", 'Focus on the billing changes.', addDays(today, -1), 'high', 'me'],
    ['Book dentist appointment', '', addDays(today, 3), 'normal', 'me'],
    ['Water the plants', '', null, 'low', 'me'],
  ];
  for (const [title, notes, due, priority, owner] of rows) {
    const info = insert.run(title, notes, due, priority, owner, 'open', 'me', now, now, null);
    event.run(Number(info.lastInsertRowid), 'me', 'created', title, now);
  }
  const doneAt = new Date(Date.now() - 3 * 3600 * 1000).toISOString();
  const info = insert.run('Send invoice to Acme', '', today, 'normal', 'me', 'done', 'me', doneAt, doneAt, doneAt);
  event.run(Number(info.lastInsertRowid), 'me', 'created', 'Send invoice to Acme', doneAt);
  event.run(Number(info.lastInsertRowid), 'me', 'completed', null, doneAt);
}

// ---------- scripted agent runs ----------
// A scenario is a list of segments. A segment is some "tool" steps, then how it ends.
// This mirrors the real agent: it can finish, ask a question, or ask for approval.

const SCENARIOS = {
  // Researches, writes a file, finishes.
  research: [
    (c) => ({
      steps: ['Read: notes.md', `WebSearch: ${clip(c.title, 60)}`, 'WebFetch: https://example.com/source-article', 'Write: workspace/summary.md'],
      end: {
        type: 'done',
        summary: `I looked into "${clip(c.title, 70)}" and wrote a one-page summary to workspace/summary.md. This is a simulated run: in the real app, this is where the agent's actual findings and its checks appear.`,
        changes: [{ path: 'workspace/summary.md', existed: false, tool: 'Write' }],
      },
    }),
  ],
  // Needs a decision from you, then continues.
  question: [
    (c) => ({
      steps: ['Read: notes.md', 'Glob: **/*.md'],
      end: {
        type: 'needs_input',
        summary: 'I need one decision before I can finish.',
        question: `Quick question about "${clip(c.title, 60)}": should I optimise for lowest cost or for the best quality? (Type anything, for example "lowest cost".)`,
      },
    }),
    (c) => ({
      steps: ['Edit: workspace/plan.md', 'Write: workspace/options.md'],
      end: {
        type: 'done',
        summary: `Thanks. I went with your answer ("${clip(c.answer, 80)}") and wrote the plan to workspace/plan.md and the options to workspace/options.md. Simulated run: nothing was actually written.`,
        changes: [{ path: 'workspace/plan.md', existed: true, tool: 'Edit' }, { path: 'workspace/options.md', existed: false, tool: 'Write' }],
      },
    }),
  ],
  // Wants to do something risky, so the rule checker stops it and asks you.
  approval: [
    (c) => ({
      steps: ['Read: CHANGELOG.md', 'Edit: CHANGELOG.md', 'Bash: git add CHANGELOG.md', 'Bash: git commit -m "Add release notes"'],
      end: {
        type: 'needs_approval',
        summary: 'The release notes are committed locally. Publishing needs your approval.',
        pending: { tool: 'Bash', kind: 'bash', value: 'git push origin main   (in /workspace/my-project)', reason: 'git push', canon: null },
        changes: [{ path: 'CHANGELOG.md', existed: true, tool: 'Edit' }],
      },
    }),
    (c) => (c.decision === 'denied'
      ? { steps: [], end: { type: 'blocked', summary: 'You denied the push, so I stopped. The notes are committed locally and nothing was sent.', question: 'Nothing was published. Tell me what to do next, or stop here.' } }
      : { steps: ['Bash: git push origin main'], end: { type: 'done', summary: 'Approved, pushed, and checked. The release notes are published. Simulated run: nothing was actually pushed.' } }),
  ],
};

function pickScenario(task) {
  const text = `${task.title} ${task.notes || ''}`.toLowerCase();
  if (/\b(push|publish|deploy|send|email|post|delete|remove|release)\b/.test(text)) return 'approval';
  if (/\b(plan|choose|pick|decide|which|compare|draft|write|design)\b/.test(text)) return 'question';
  return 'research';
}

// ---------- manager ----------

function createManager({ tz }) {
  const sessions = new Map(); // id -> session
  const ipRate = new Map(); // ip -> { start, count }
  const ipNew = new Map(); // ip -> [timestamps]

  const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());

  function freshDb() {
    const db = openDb(':memory:');
    seed(db, today());
    return db;
  }

  function newSession() {
    const id = crypto.randomBytes(24).toString('base64url');
    const sess = { id, db: freshDb(), seen: Date.now(), gen: 0, current: null, ticking: false, changes: new Map(), undone: new Set() };
    sessions.set(id, sess);
    return sess;
  }

  function destroy(sess) {
    sess.gen += 1;
    clearTimers(sess);
    sess.dead = true;
    try { sess.db.close(); } catch { /* already closed */ }
    sessions.delete(sess.id);
  }

  function clearTimers(sess) {
    if (sess.current) for (const t of sess.current.timers) clearTimeout(t);
    sess.current = null;
  }

  function acquire(req, res, ip, https, cookiePath) {
    const now = Date.now();
    const rate = ipRate.get(ip);
    if (!rate || now - rate.start > 60000) ipRate.set(ip, { start: now, count: 1 });
    else if (++rate.count > RATE_PER_MIN) throw httpError(429, 'Too many requests. Slow down for a minute.');

    const id = parseCookies(req).atd_demo;
    let sess = id ? sessions.get(id) : null;
    if (!sess) {
      const hits = (ipNew.get(ip) || []).filter((t) => now - t < 3600 * 1000);
      if (hits.length >= NEW_SESSIONS_PER_HOUR) throw httpError(429, 'Too many new demo sessions from your network. Try again later.');
      if (sessions.size >= MAX_SESSIONS) {
        const idle = [...sessions.values()].filter((s) => now - s.seen > 120000).sort((a, b) => a.seen - b.seen)[0];
        if (!idle) throw httpError(503, 'The demo is busy right now. Please try again in a few minutes.');
        destroy(idle);
      }
      hits.push(now);
      ipNew.set(ip, hits);
      sess = newSession();
      res.setHeader('Set-Cookie', `atd_demo=${sess.id}; Path=${cookiePath}; HttpOnly; SameSite=Lax; Max-Age=${Math.round(IDLE_MS / 1000)}${https ? '; Secure' : ''}`);
    }
    sess.seen = now;
    return { sess };
  }

  // ----- the simulated worker -----

  const taskEvent = (sess, taskId, action, detail) => {
    sess.db.prepare('INSERT INTO task_events (task_id, actor, action, detail, at) VALUES (?, ?, ?, ?, ?)').run(taskId, 'agent', action, detail || null, nowIso());
  };

  function kick(sess) {
    if (sess.ticking || sess.dead) return;
    sess.ticking = true;
    setImmediate(() => pump(sess));
  }

  function pump(sess) {
    if (sess.dead) return;
    sess.ticking = false;
    if (sess.current) return;
    const run = sess.db.prepare("SELECT * FROM runs WHERE status = 'queued' ORDER BY queued_at, id LIMIT 1").get();
    if (run) startSegment(sess, { ...run });
  }

  function lastLog(sess, runId, kind) {
    const r = sess.db.prepare('SELECT text FROM run_log WHERE run_id = ? AND kind = ? ORDER BY id DESC LIMIT 1').get(runId, kind);
    return r ? r.text : null;
  }

  function startSegment(sess, run) {
    const db = sess.db;
    const gen = sess.gen;
    const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(run.task_id);
    if (!task || task.status !== 'open') {
      db.prepare("UPDATE runs SET status = 'stopped', summary = ?, ended_at = ?, updated_at = ? WHERE id = ?").run('The task is no longer open, so the run was cancelled.', nowIso(), nowIso(), run.id);
      A.logRun(db, run.id, 'stopped', 'Task is no longer open');
      return;
    }
    const segNo = run.segments + 1;
    const name = run.session_id && run.session_id.startsWith('demo:') ? run.session_id.slice(5) : pickScenario(task);
    const now = nowIso();
    db.prepare("UPDATE runs SET status = 'running', segments = ?, session_id = ?, started_at = COALESCE(started_at, ?), updated_at = ?, ended_at = NULL WHERE id = ?")
      .run(segNo, `demo:${name}`, now, now, run.id);
    A.logRun(db, run.id, 'started', segNo === 1 ? 'Started working' : `Continued (part ${segNo})`);
    if (segNo === 1) {
      taskEvent(sess, task.id, 'agent_started', task.title);
      A.logRun(db, run.id, 'demo', 'Demo mode: this run is scripted. No AI was called and no commands were run.');
    }

    const make = (SCENARIOS[name] || SCENARIOS.research)[segNo - 1] || (() => ({
      steps: ['Read: notes.md'],
      end: { type: 'done', summary: 'Picked up where I left off and finished. Simulated run.' },
    }));
    const plan = make({ title: task.title, answer: lastLog(sess, run.id, 'answer') || 'your answer', decision: lastLog(sess, run.id, 'denied') ? 'denied' : 'approved' });

    const timers = [];
    sess.current = { runId: run.id, timers };
    plan.steps.forEach((text, i) => {
      timers.push(setTimeout(() => { if (sess.gen === gen) A.logRun(sess.db, run.id, 'tool', text); }, STEP_MS * (i + 1)));
    });
    timers.push(setTimeout(() => {
      if (sess.gen !== gen) return;
      sess.current = null;
      try { finishSegment(sess, run.id, task, plan.end); } catch (e) { console.error('demo finish failed', e.message); }
      kick(sess);
    }, STEP_MS * (plan.steps.length + 1)));
    for (const t of timers) t.unref();
  }

  function finishSegment(sess, runId, task, end) {
    const db = sess.db;
    const ts = nowIso();
    const update = (fields) => {
      const cols = Object.keys(fields);
      db.prepare(`UPDATE runs SET ${cols.map((c) => `${c} = ?`).join(', ')}, updated_at = ? WHERE id = ?`).run(...cols.map((c) => fields[c]), ts, runId);
    };
    if (end.changes) {
      const list = sess.changes.get(runId) || [];
      for (const c of end.changes) if (!list.some((x) => x.path === c.path)) list.push({ ...c, at: ts });
      sess.changes.set(runId, list);
    }
    const nChanges = (sess.changes.get(runId) || []).length;
    let summary = end.summary;
    if (nChanges) summary += `\n\n${nChanges} file${nChanges === 1 ? '' : 's'} changed (original copies are saved, so they can be undone).`;

    if (end.type === 'done') {
      update({ status: 'finished', summary, report_status: 'done', question: null, pending_action: null, ended_at: ts });
      db.prepare("UPDATE tasks SET status = 'done', completed_at = ?, updated_at = ? WHERE id = ? AND status = 'open'").run(ts, ts, task.id);
      taskEvent(sess, task.id, 'completed');
      A.logRun(db, runId, 'finished', 'Finished; task checked off');
      taskEvent(sess, task.id, 'agent_finished', task.title);
    } else if (end.type === 'needs_input') {
      update({ status: 'needs_input', summary, report_status: 'needs_input', question: end.question, pending_action: null, ended_at: ts });
      A.logRun(db, runId, 'needs_input', end.question);
      taskEvent(sess, task.id, 'agent_needs_you', 'question');
    } else if (end.type === 'needs_approval') {
      update({ status: 'needs_approval', summary, report_status: 'needs_approval', question: null, pending_action: JSON.stringify(end.pending), ended_at: ts });
      A.logRun(db, runId, 'needs_approval', `${end.pending.reason}: ${end.pending.value}`);
      taskEvent(sess, task.id, 'agent_needs_you', 'approval');
    } else {
      update({ status: 'blocked', summary, report_status: 'blocked', question: end.question || summary, pending_action: null, ended_at: ts });
      A.logRun(db, runId, 'blocked', end.question || summary);
      taskEvent(sess, task.id, 'agent_needs_you', 'blocked');
    }
  }

  function stop(sess, runId) {
    const db = sess.db;
    const run = A.getRun(db, runId);
    if (!run) return;
    const wasRunning = run.status === 'running';
    if (sess.current && sess.current.runId === runId) clearTimers(sess);
    const ts = nowIso();
    // A stopped segment is replayed from its start when resumed.
    db.prepare("UPDATE runs SET status = 'stopped', summary = 'Stopped by you.', ended_at = ?, updated_at = ?, stop_requested = 0, segments = MAX(segments - ?, 0) WHERE id = ?").run(ts, ts, wasRunning ? 1 : 0, runId);
    A.logRun(db, runId, 'stopped', 'Stopped by you');
    taskEvent(sess, run.task_id, 'agent_stopped', null);
    kick(sess);
  }

  // ----- fake file-change log -----

  const changesOf = (sess, runId) => (sess.changes.get(runId) || []).map((c) => ({ ...c }));
  const isUndone = (sess, runId) => sess.undone.has(runId);
  function undo(sess, runId) {
    const list = sess.changes.get(runId) || [];
    if (!list.length || sess.undone.has(runId)) return null;
    sess.undone.add(runId);
    return { restored: list.filter((c) => c.existed).length, removed: list.filter((c) => !c.existed).length, failed: [] };
  }

  const canStartRun = (sess) => sess.db.prepare('SELECT COUNT(*) AS n FROM runs').get().n < LIMITS.runs;

  function reset(sess) {
    sess.gen += 1;
    clearTimers(sess);
    const old = sess.db;
    sess.db = freshDb();
    sess.changes = new Map();
    sess.undone = new Set();
    sess.ticking = false;
    try { old.close(); } catch { /* ignore */ }
  }

  // Made-up plan-usage numbers so the page shows its usage meters.
  function fakeUsage(sess) {
    const runs = sess ? sess.db.prepare('SELECT COUNT(*) AS n FROM runs').get().n : 0;
    const nowS = Date.now() / 1000;
    return { five_hour: { u: Math.min(0.2 + 0.04 * runs, 0.7), resetsAt: nowS + 3 * 3600 }, seven_day: { u: Math.min(0.08 + 0.01 * runs, 0.4), resetsAt: nowS + 4 * 86400 } };
  }

  const sweep = setInterval(() => {
    const now = Date.now();
    for (const s of [...sessions.values()]) if (now - s.seen > IDLE_MS) destroy(s);
    for (const [ip, r] of ipRate) if (now - r.start > 60000) ipRate.delete(ip);
    for (const [ip, hits] of ipNew) { const keep = hits.filter((t) => now - t < 3600 * 1000); if (keep.length) ipNew.set(ip, keep); else ipNew.delete(ip); }
  }, 60000);
  sweep.unref();

  return {
    limits: LIMITS, acquire, kick, stop, reset, undo, changesOf, isUndone, canStartRun, fakeUsage,
    stats: () => ({ sessions: sessions.size }),
    shutdown: () => { clearInterval(sweep); for (const s of [...sessions.values()]) destroy(s); },
  };
}

module.exports = { createManager, SCENARIOS, pickScenario };
