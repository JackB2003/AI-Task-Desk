'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { startServer, client, until } = require('./helpers');

let srv;
test.before(async () => { srv = await startServer({ DEMO: '1' }); });
test.after(async () => { await srv.stop(); });

const tasks = async (c, status = 'open') => (await c.get(`/api/tasks?status=${status}`)).data.tasks;
const byTitle = (list, re) => list.find((t) => re.test(t.title));
const runOf = async (c, re, status) => until(async () => { const t = byTitle(await tasks(c), re); return t && t.run && t.run.status === status ? t.run : null; });
const isDone = (c, id) => async () => (await tasks(c, 'done')).some((x) => x.id === id);

test('needs no login and starts with sample tasks', async () => {
  const c = client(srv.base);
  const me = await c.get('/api/me');
  assert.equal(me.status, 200);
  assert.equal(me.data.demo, true);
  const list = await tasks(c);
  assert.ok(list.length >= 6);
  assert.ok(byTitle(list, /offsite/));
});

test('each visitor gets a private copy', async () => {
  const a = client(srv.base);
  const b = client(srv.base);
  await a.get('/api/me');
  await b.get('/api/me');
  await a.post('/api/tasks', { title: 'Only in A' });
  assert.ok(byTitle(await tasks(a), /Only in A/));
  assert.equal(byTitle(await tasks(b), /Only in A/), undefined);
});

test('research task runs and checks itself off, with an undoable file change', async () => {
  const c = client(srv.base);
  await c.get('/api/me');
  const t = byTitle(await tasks(c), /customer feedback/);
  assert.equal((await c.post(`/api/tasks/${t.id}/work`)).status, 201);
  await until(isDone(c, t.id));
  const run = (await tasks(c, 'done')).find((x) => x.id === t.id).run;
  assert.equal(run.status, 'finished');
  const detail = await c.get(`/api/runs/${run.id}`);
  assert.ok(detail.data.changes.length >= 1);
  assert.ok(detail.data.log.some((l) => l.kind === 'demo'));
  assert.equal((await c.post(`/api/runs/${run.id}/undo`)).status, 200);
  assert.equal((await c.post(`/api/runs/${run.id}/undo`)).status, 409);
});

test('question flow: asks, takes your answer, then finishes', async () => {
  const c = client(srv.base);
  await c.get('/api/me');
  const t = byTitle(await tasks(c), /offsite/);
  await c.post(`/api/tasks/${t.id}/work`);
  const run = await runOf(c, /offsite/, 'needs_input');
  assert.match(run.question, /cost|quality/);
  assert.equal((await c.post(`/api/runs/${run.id}/answer`, { text: 'lowest cost' })).status, 200);
  await until(isDone(c, t.id));
  const done = (await tasks(c, 'done')).find((x) => x.id === t.id).run;
  assert.match(done.summary, /lowest cost/);
});

test('approval flow: approve finishes, deny blocks', async () => {
  const c = client(srv.base);
  await c.get('/api/me');
  const t = byTitle(await tasks(c), /release notes/);
  await c.post(`/api/tasks/${t.id}/work`);
  const run = await runOf(c, /release notes/, 'needs_approval');
  assert.match(run.pending_action.value, /git push/);
  await c.post(`/api/runs/${run.id}/approve`, { decision: 'approve' });
  await until(isDone(c, t.id));

  const c2 = client(srv.base);
  await c2.get('/api/me');
  const t2 = byTitle(await tasks(c2), /release notes/);
  await c2.post(`/api/tasks/${t2.id}/work`);
  const run2 = await runOf(c2, /release notes/, 'needs_approval');
  await c2.post(`/api/runs/${run2.id}/approve`, { decision: 'deny' });
  const blocked = await runOf(c2, /release notes/, 'blocked');
  assert.match(blocked.summary, /denied/);
});

test('stop works and the run can be resumed', async () => {
  const s = await startServer({ DEMO: '1', DEMO_STEP_MS: '400' });
  try {
    const c = client(s.base);
    await c.get('/api/me');
    const t = byTitle(await tasks(c), /customer feedback/);
    await c.post(`/api/tasks/${t.id}/work`);
    const running = await runOf(c, /customer feedback/, 'running');
    assert.equal((await c.post(`/api/runs/${running.id}/stop`)).status, 200);
    const stopped = await runOf(c, /customer feedback/, 'stopped');
    assert.equal((await c.post(`/api/runs/${stopped.id}/resume`)).status, 200);
    await until(isDone(c, t.id), 9000);
  } finally { await s.stop(); }
});

test('dangerous or personal features are switched off', async () => {
  const c = client(srv.base);
  await c.get('/api/me');
  const t = byTitle(await tasks(c), /dentist/);
  const up = await fetch(`${srv.base}/api/tasks/${t.id}/attachments`, {
    method: 'POST', headers: { 'X-Requested-With': 'ai-task-desk', 'Content-Type': 'text/plain', Cookie: c.cookieHeader() }, body: 'hello',
  });
  assert.equal(up.status, 403);
  assert.equal((await c.post('/api/telegram/token', { token: '123456:abcdefghijklmnopqrstuvwxyzabcdefghij' })).status, 403);
  assert.equal((await c.post('/api/password', { password: 'x'.repeat(20) })).status, 403);
  assert.equal((await c.post('/api/setup', { password: 'x'.repeat(20) })).status, 403);
});

test('runs per visit are capped, and Reset gives a fresh start', async () => {
  const c = client(srv.base);
  await c.get('/api/me');
  let blocked = null;
  for (let i = 0; i < 14 && !blocked; i++) {
    const { data } = await c.post('/api/tasks', { title: `Research thing ${i}`, owner: 'agent' });
    const r = await c.post(`/api/tasks/${data.task.id}/work`);
    if (r.status === 429) blocked = r;
    else await until(async () => { const x = (await tasks(c, 'all')).find((q) => q.id === data.task.id); return x && x.run && x.run.status === 'finished'; });
  }
  assert.ok(blocked, 'expected the run cap to kick in');
  assert.equal((await c.post('/api/demo/reset')).status, 200);
  const list = await tasks(c);
  assert.ok(byTitle(list, /offsite/));
  assert.equal(byTitle(list, /Research thing/), undefined);
});

test('tasks per visit are capped', async () => {
  const c = client(srv.base);
  await c.get('/api/me');
  let last;
  for (let i = 0; i < 45; i++) { last = await c.post('/api/tasks', { title: `t${i}` }); if (last.status === 429) break; }
  assert.equal(last.status, 429);
});

test('requests without the browser header are refused (CSRF guard)', async () => {
  const c = client(srv.base);
  await c.get('/api/me');
  const r = await c.call('POST', '/api/tasks', { title: 'sneaky' }, { 'X-Requested-With': '' });
  assert.equal(r.status, 403);
});
