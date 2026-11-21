'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { startServer, client } = require('./helpers');

let srv;
test.before(async () => { srv = await startServer(); });
test.after(async () => { await srv.stop(); });

const PW = 'correct horse battery';

test('first run: asks for a password, locks everything until then', async () => {
  const c = client(srv.base);
  const me = await c.get('/api/me');
  assert.equal(me.status, 401);
  assert.equal(me.data.needsSetup, true);
  assert.equal(me.data.canSetupHere, true);
  assert.equal((await c.get('/api/tasks')).status, 401);
});

test('first-run setup is refused when it arrives through a proxy', async () => {
  const c = client(srv.base);
  const r = await c.post('/api/setup', { password: PW }, { 'X-Forwarded-For': '8.8.8.8' });
  assert.equal(r.status, 403);
});

test('setup rejects a short password, then accepts a good one and signs in', async () => {
  const c = client(srv.base);
  assert.equal((await c.post('/api/setup', { password: 'short' })).status, 400);
  assert.equal((await c.post('/api/setup', { password: PW })).status, 200);
  assert.equal((await c.get('/api/me')).status, 200);
  assert.equal((await client(srv.base).post('/api/setup', { password: 'another long password' })).status, 409);
});

test('login: wrong password fails, right password works, sign out works', async () => {
  const c = client(srv.base);
  assert.equal((await c.post('/api/login', { password: 'nope nope nope nope' })).status, 401);
  assert.equal((await c.post('/api/login', { password: PW })).status, 200);
  assert.equal((await c.get('/api/tasks')).status, 200);
  await c.post('/api/logout');
  assert.equal((await c.get('/api/tasks')).status, 401);
});

test('tasks: add, edit, complete, archive, restore, and see the activity log', async () => {
  const c = client(srv.base);
  await c.post('/api/login', { password: PW });
  const { data } = await c.post('/api/tasks', { title: 'Write the README', priority: 'high', due: '2030-01-02', owner: 'agent', notes: 'be nice' });
  const id = data.task.id;
  assert.equal(data.task.owner, 'agent');
  assert.equal((await c.patch(`/api/tasks/${id}`, { title: 'Write the README v2' })).data.task.title, 'Write the README v2');
  assert.equal((await c.patch(`/api/tasks/${id}`, { status: 'done' })).data.task.status, 'done');
  assert.equal((await c.post(`/api/tasks/${id}/archive`)).data.task.status, 'archived');
  assert.equal((await c.post(`/api/tasks/${id}/restore`)).data.task.status, 'done');
  const act = await c.get('/api/activity');
  assert.ok(act.data.events.some((e) => e.action === 'completed'));
  assert.equal((await c.post('/api/tasks', { title: '' })).status, 400);
  assert.equal((await c.post('/api/tasks', { title: 'x', due: 'tomorrow' })).status, 400);
  assert.equal((await c.post('/api/tasks', { title: 'x', hacker: 1 })).status, 400);
});

test('"Work on it" queues a run for agent tasks only', async () => {
  const c = client(srv.base);
  await c.post('/api/login', { password: PW });
  const mine = (await c.post('/api/tasks', { title: 'Mine', owner: 'me' })).data.task;
  assert.equal((await c.post(`/api/tasks/${mine.id}/work`)).status, 409);
  const agent = (await c.post('/api/tasks', { title: 'Agent one', owner: 'agent' })).data.task;
  assert.equal((await c.post(`/api/tasks/${agent.id}/work`)).status, 201);
  assert.equal((await c.post(`/api/tasks/${agent.id}/work`)).status, 409); // already queued
  const st = await c.get('/api/agent/status');
  assert.equal(st.data.queued, 1);
  assert.equal(st.data.worker_ok, false); // no worker running in this test
});

test('changing the password signs out other devices', async () => {
  const a = client(srv.base);
  const b = client(srv.base);
  await a.post('/api/login', { password: PW });
  await b.post('/api/login', { password: PW });
  assert.equal((await a.post('/api/password', { current: 'wrong wrong wrong', password: 'brand new password!' })).status, 403);
  assert.equal((await a.post('/api/password', { current: PW, password: 'brand new password!' })).status, 200);
  assert.equal((await a.get('/api/tasks')).status, 200);
  assert.equal((await b.get('/api/tasks')).status, 401);
});

test('static page is served with a strict content-security-policy, and source files are not exposed', async () => {
  const r = await fetch(`${srv.base}/`);
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-security-policy'), /script-src 'self'/);
  assert.equal((await fetch(`${srv.base}/server.js`)).status, 404);
  assert.equal((await fetch(`${srv.base}/.env`)).status, 404);
  assert.equal((await fetch(`${srv.base}/data/desk.db`)).status, 404);
});
