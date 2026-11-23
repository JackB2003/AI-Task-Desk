'use strict';

const $ = (sel) => document.querySelector(sel);
const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const wait = (ms) => new Promise((r) => setTimeout(r, reducedMotion ? 0 : ms));

function el(tag, props, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (k === 'class') node.className = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v);
  }
  for (const c of children.flat()) node.append(c instanceof Node ? c : document.createTextNode(String(c)));
  return node;
}

async function api(method, path, body) {
  const res = await fetch(path, {
    method,
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'ai-task-desk' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let data = {};
  try { data = await res.json(); } catch { /* empty body */ }
  if (!res.ok) {
    const err = new Error(data.error || `Request failed (${res.status})`);
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

// ---------- attachments ----------

const FILE_OK = /^(image\/(png|jpeg|gif|webp)|application\/pdf|text\/(plain|markdown))$/;
const kb = (n) => (n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);

async function uploadFile(taskId, file) {
  const res = await fetch(`api/tasks/${taskId}/attachments`, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': file.type || 'application/octet-stream', 'X-Requested-With': 'ai-task-desk', 'X-Filename': encodeURIComponent(file.name || 'file') },
    body: file,
  });
  let data = {};
  try { data = await res.json(); } catch { /* empty */ }
  if (!res.ok) throw new Error(data.error || `Upload failed (${res.status})`);
  return data.file;
}

function viewFile(f) {
  if (f.mime.startsWith('image/')) {
    $('#viewImg').src = `api/attachments/${f.id}`;
    $('#viewImg').alt = f.name;
    $('#viewOpen').href = `api/attachments/${f.id}`;
    $('#viewDialog').showModal();
  } else window.open(`api/attachments/${f.id}`, '_blank', 'noopener');
}
$('#viewClose').addEventListener('click', () => $('#viewDialog').close());
$('#viewDialog').addEventListener('click', (ev) => { if (ev.target === $('#viewDialog')) $('#viewDialog').close(); });

function thumb(f, onRemove) {
  const isImg = f.mime.startsWith('image/');
  const box = el('div', { class: 'thumb' });
  const open = el('button', { type: 'button', class: 'thumb-open', title: f.name, onclick: (ev) => { ev.stopPropagation(); viewFile(f); } },
    isImg ? el('img', { src: `api/attachments/${f.id}`, alt: f.name, loading: 'lazy' }) : el('span', { class: 'doc' }, f.mime === 'application/pdf' ? '📄' : '📝'),
    el('span', { class: 'thumb-name' }, f.name));
  box.append(open);
  if (onRemove) box.append(el('button', { type: 'button', class: 'thumb-x', 'aria-label': `Remove ${f.name}`, onclick: (ev) => { ev.stopPropagation(); onRemove(); } }, '×'));
  return box;
}

// files picked/pasted/dropped on the add form, waiting for the task to be created
const pending = [];

function renderPending() {
  const box = $('#addPreview');
  box.replaceChildren();
  pending.forEach((file, i) => {
    const isImg = file.type.startsWith('image/');
    if (!file._url && isImg) file._url = URL.createObjectURL(file);
    const t = el('div', { class: 'thumb' },
      el('div', { class: 'thumb-open' },
        isImg ? el('img', { src: file._url, alt: file.name }) : el('span', { class: 'doc' }, file.type === 'application/pdf' ? '📄' : '📝'),
        el('span', { class: 'thumb-name' }, `${file.name || 'pasted image'} (${kb(file.size)})`)),
      el('button', { type: 'button', class: 'thumb-x', 'aria-label': 'Remove', onclick: () => { pending.splice(i, 1); renderPending(); } }, '×'));
    box.append(t);
  });
}

function takeFiles(list) {
  const err = $('#addError');
  err.textContent = '';
  for (const f of list) {
    if (!FILE_OK.test(f.type)) { err.textContent = `${f.name || 'That file'} is not an image, PDF or text file.`; continue; }
    if (f.size > 10 * 1048576) { err.textContent = `${f.name || 'That file'} is bigger than 10 MB.`; continue; }
    if (pending.length >= 10) { err.textContent = 'A task can hold up to 10 files.'; break; }
    pending.push(f);
  }
  renderPending();
}

$('#addFiles').addEventListener('change', (ev) => { takeFiles([...ev.target.files]); ev.target.value = ''; });
// paste a screenshot anywhere on the page (unless you are pasting into the edit window)
document.addEventListener('paste', (ev) => {
  if ($('#app').hidden || state.demo || document.querySelector('dialog[open]')) return;
  const files = [...(ev.clipboardData ? ev.clipboardData.files : [])];
  if (!files.length) return;
  ev.preventDefault();
  takeFiles(files.map((f, i) => (f.name && f.name !== 'image.png' ? f : new File([f], `screenshot-${Date.now()}-${i}.${(f.type.split('/')[1] || 'png').replace('jpeg', 'jpg')}`, { type: f.type }))));
});
const addCard = $('#addForm');
addCard.addEventListener('dragover', (ev) => { if (ev.dataTransfer && [...ev.dataTransfer.types].includes('Files')) { ev.preventDefault(); addCard.classList.add('dropping'); } });
addCard.addEventListener('dragleave', () => addCard.classList.remove('dropping'));
addCard.addEventListener('drop', (ev) => { ev.preventDefault(); addCard.classList.remove('dropping'); if (!state.demo) takeFiles([...ev.dataTransfer.files]); });

const state = { tab: 'open', view: 'week', expanded: new Set(), today: '', via: '', tz: undefined, name: '', demo: false, agent: null, sig: '', prevActive: new Set() };

function addDays(dateStr, n) {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function prettyDate(s) {
  const d = new Date(`${s}T00:00:00Z`);
  return d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' });
}

function whoLabel(actor) {
  return { me: 'You', agent: 'Agent' }[actor] || actor;
}

// ---------- confetti ----------

const canvas = $('#confetti');
const ctx = canvas.getContext('2d');
const COLORS = ['#7c3aed', '#ec4899', '#fb923c', '#fbbf24', '#2dd4bf', '#3b82f6', '#ff5a5f'];
const particles = [];
let confettiRunning = false;

function burst(x, y, count = 40) {
  if (reducedMotion) return;
  for (let i = 0; i < count; i++) {
    const a = Math.random() * Math.PI * 2;
    const s = 3 + Math.random() * 7;
    particles.push({
      x, y, vx: Math.cos(a) * s, vy: Math.sin(a) * s - 5, w: 6 + Math.random() * 6, h: 4 + Math.random() * 5,
      rot: Math.random() * 6, vr: (Math.random() - 0.5) * 0.5, color: COLORS[i % COLORS.length], life: 0,
    });
  }
  if (!confettiRunning) {
    confettiRunning = true;
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;
    requestAnimationFrame(tick);
  }
}

function tick() {
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  for (let i = particles.length - 1; i >= 0; i--) {
    const p = particles[i];
    p.vy += 0.28; p.vx *= 0.99; p.x += p.vx; p.y += p.vy; p.rot += p.vr; p.life += 1;
    if (p.life > 75) { particles.splice(i, 1); continue; }
    ctx.save();
    ctx.globalAlpha = Math.max(0, 1 - p.life / 75);
    ctx.translate(p.x, p.y);
    ctx.rotate(p.rot);
    ctx.fillStyle = p.color;
    ctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h);
    ctx.restore();
  }
  if (particles.length) requestAnimationFrame(tick);
  else { confettiRunning = false; ctx.clearRect(0, 0, canvas.width, canvas.height); }
}

// ---------- hero: greeting, stats, momentum ----------

function greeting() {
  const hour = Number(new Date().toLocaleString('en-US', { hour: 'numeric', hour12: false, timeZone: state.tz })) % 24;
  const part = hour < 5 ? 'Burning the midnight oil' : hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening';
  $('#greeting').replaceChildren(`${part}${state.name ? `, ${state.name}` : ''} `, el('span', { class: 'wave' }, '👋'));
}

function countTo(node, target) {
  const from = Number(node.textContent) || 0;
  if (reducedMotion || from === target) { node.textContent = target; return; }
  const start = performance.now();
  const dur = 650;
  const step = (now) => {
    const t = Math.min(1, (now - start) / dur);
    node.textContent = Math.round(from + (target - from) * (1 - (1 - t) ** 3));
    if (t < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

async function refreshStats() {
  try {
    const b = await api('GET', 'api/briefing');
    const done = b.completed_last_24h.length;
    countTo($('#stOpen'), b.counts.open);
    countTo($('#stToday'), b.counts.due_today);
    countTo($('#stOver'), b.counts.overdue);
    countTo($('#stDone'), done);
    const todo = b.counts.overdue + b.counts.due_today;
    const total = done + todo;
    const pct = total ? Math.round((done / total) * 100) : (done ? 100 : 0);
    $('#barFill').style.width = `${pct}%`;
    $('#momentumText').textContent = total === 0
      ? (b.counts.open ? 'Nothing due today. Pick something off the list! 🚀' : 'All clear. Enjoy it! 🎉')
      : `${done} of ${total} done in the last 24h${pct === 100 ? ' 🔥 Nailed it!' : ''}`;
  } catch { /* stats are decoration; the list reports real errors */ }
}

// ---------- start-up ----------

async function init() {
  try {
    const me = await api('GET', 'api/me');
    state.today = me.today;
    state.via = me.via;
    state.tz = me.timezone;
    state.name = me.name || '';
    state.demo = !!me.demo;
    $('#login').hidden = true;
    $('#app').hidden = false;
    document.body.classList.toggle('demo', state.demo);
    $('#demoBar').hidden = !state.demo;
    if (state.demo) $('#demoRepo').href = me.repo;
    $('#tzName').textContent = me.timezone || 'your time zone';
    greeting();
    $('#today').textContent = new Date(`${me.today}T00:00:00Z`).toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
    $('#logoutBtn').hidden = me.via !== 'session';
    $('#currentPwLabel').hidden = false;
    await render({ animate: true });
    refreshAi();
  } catch (e) {
    if (e.status === 401) {
      $('#app').hidden = true;
      $('#login').hidden = false;
      const setup = !!e.data.needsSetup;
      $('#loginForm').hidden = setup;
      $('#setupForm').hidden = !(setup && e.data.canSetupHere);
      $('#loginNote').textContent = !setup ? 'Sign in to see your tasks.'
        : e.data.canSetupHere ? 'Welcome! Choose a password to protect your task list.'
          : 'No password has been set yet. Open this page on the machine running AI Task Desk, or run "npm run setup" there.';
    } else {
      document.body.prepend(el('p', { class: 'error' }, e.message));
    }
  }
}

// ---------- list rendering ----------

async function render({ animate = false } = {}) {
  const list = $('#list');
  for (const b of document.querySelectorAll('#tabs button')) b.classList.toggle('active', b.dataset.tab === state.tab);
  refreshStats();
  refreshAgent();
  $('#weekBar').hidden = true;
  let index = 0;
  const nextRow = (t) => taskRow(t, animate ? Math.min(index++, 14) : null);
  try {
    if (state.tab === 'activity') return await renderActivity(list);
    const { tasks } = await api('GET', `api/tasks?status=${state.tab}`);
    state.sig = sigOf(tasks);
    if (state.tab === 'open') state.prevActive = activeIds(tasks);
    list.replaceChildren();
    if (!tasks.length) {
      const empty = { open: ['🎉', 'Nothing open. Add a task above!'], done: ['🌱', 'Nothing completed yet.'], archived: ['📦', 'Nothing archived.'] }[state.tab];
      list.append(el('div', { class: 'empty' }, el('span', { class: 'big' }, empty[0]), empty[1]));
      return;
    }
    if (state.tab !== 'open') {
      for (const t of tasks) list.append(nextRow(t));
      return;
    }
    state.openTasks = tasks;
    renderOpen(list, tasks, nextRow);
  } catch (e) {
    if (e.status === 401) return init();
    list.replaceChildren(el('p', { class: 'error' }, e.message));
  }
}


// ---------- open tab: week strip + day grouping ----------

function dayLabel(date) {
  if (date === state.today) return ['Today', 'g-today'];
  if (date === addDays(state.today, 1)) return ['Tomorrow', 'g-week'];
  const d = new Date(`${date}T00:00:00Z`);
  const inWeek = date > state.today && date <= addDays(state.today, 6);
  const name = inWeek ? d.toLocaleDateString(undefined, { weekday: 'long', timeZone: 'UTC' }) : prettyDate(date);
  return [name, date > addDays(state.today, 6) ? 'g-later' : 'g-week'];
}

function plural(n, word) { return `${n} ${word}${n === 1 ? '' : 's'}`; }

function groupHead(label, cls, sub) {
  return el('div', { class: 'day-head' }, el('span', { class: `group-title ${cls}` }, label), el('span', { class: 'day-sub' }, sub));
}

function renderOpen(list, tasks, nextRow) {
  const weekEnd = addDays(state.today, 6);
  const days = Array.from({ length: 7 }, (_, i) => addDays(state.today, i));
  const over = tasks.filter((t) => t.due && t.due < state.today);
  const week = tasks.filter((t) => t.due && t.due >= state.today && t.due <= weekEnd);
  const later = tasks.filter((t) => t.due && t.due > weekEnd);
  const none = tasks.filter((t) => !t.due);
  const byDay = (d) => tasks.filter((t) => t.due === d);
  renderWeekBar({ days, over, week, later, none, byDay });

  const add = (head, items) => { list.append(head); for (const t of items) list.append(nextRow(t)); };
  const overdueGroup = () => over.length && add(groupHead('Overdue', 'g-overdue', plural(over.length, 'task')), over);
  const dateGroups = (items) => {
    const dates = [...new Set(items.map((t) => t.due))].sort();
    for (const d of dates) {
      const its = items.filter((t) => t.due === d);
      const [label, cls] = dayLabel(d);
      add(groupHead(label, cls, `${prettyDate(d)} · ${plural(its.length, 'task')}`), its);
    }
  };
  const view = state.view;
  if (view === 'week') {
    overdueGroup();
    dateGroups(week);
    if (!over.length && !week.length) list.append(el('div', { class: 'empty' }, el('span', { class: 'big' }, '🌴'), 'Nothing due in the next 7 days.'));
  } else if (view === 'all') {
    overdueGroup();
    dateGroups([...week, ...later]);
    if (none.length) add(groupHead('No due date', 'g-none', plural(none.length, 'task')), none);
  } else if (view === 'overdue') {
    overdueGroup();
  } else if (view === 'later') {
    dateGroups(later);
  } else if (view === 'none') {
    if (none.length) add(groupHead('No due date', 'g-none', plural(none.length, 'task')), none);
  } else {
    const items = byDay(view);
    const [label, cls] = dayLabel(view);
    if (items.length) add(groupHead(label, cls, `${prettyDate(view)} · ${plural(items.length, 'task')}`), items);
    else list.append(groupHead(label, cls, prettyDate(view)), el('div', { class: 'empty' }, el('span', { class: 'big' }, '🌤️'), 'Nothing due this day.'));
  }
  if (!list.children.length) list.append(el('div', { class: 'empty' }, el('span', { class: 'big' }, '☁️'), 'Nothing here.'));
}

function renderWeekBar({ days, over, week, later, none, byDay }) {
  const bar = $('#weekBar');
  const setView = (v) => {
    state.view = v;
    const list = $('#list');
    const y = window.scrollY;
    list.replaceChildren();
    renderOpen(list, state.openTasks, (t) => taskRow(t, null));
    window.scrollTo(0, y);
  };
  const tabs = [['week', 'Week', week.length + over.length], ['all', 'All', over.length + week.length + later.length + none.length],
    ['overdue', 'Overdue', over.length], ['none', 'No date', none.length], ['later', 'Later', later.length]]
    .filter(([k, , n]) => n > 0 || ['week', 'all'].includes(k) || state.view === k);
  const row = el('div', { class: 'view-tabs', role: 'tablist' }, tabs.map(([k, label, n]) => el('button', {
    type: 'button', role: 'tab', class: `view-tab ${k === 'overdue' && n ? 'hot' : ''} ${state.view === k ? 'on' : ''}`,
    'aria-selected': String(state.view === k), onclick: () => setView(k),
  }, label, k === 'week' || k === 'all' ? '' : el('span', { class: 'n' }, n))));
  const strip = el('div', { class: 'week-strip' }, days.map((d) => {
    const n = byDay(d).length;
    const dt = new Date(`${d}T00:00:00Z`);
    const wd = d === state.today ? 'Today' : dt.toLocaleDateString(undefined, { weekday: 'short', timeZone: 'UTC' });
    return el('button', {
      type: 'button', class: `day-btn ${d === state.today ? 'is-today' : ''} ${state.view === d ? 'sel' : ''}`,
      'aria-pressed': String(state.view === d), 'aria-label': `${prettyDate(d)}, ${plural(n, 'task')}`,
      onclick: () => setView(state.view === d ? 'week' : d),
    }, el('small', {}, wd), el('b', {}, dt.getUTCDate()), el('span', { class: `cnt ${n ? 'has' : ''}` }, n || ''));
  }));
  const keep = bar.querySelector('.view-tabs');
  const left = keep ? keep.scrollLeft : 0;
  bar.replaceChildren(row, strip);
  row.scrollLeft = left;
  bar.hidden = false;
}

function taskRow(t, enterIndex) {
  const meta = el('div', { class: 'meta' });
  if (t.due) meta.append(el('span', { class: `chip ${t.status === 'open' && t.due < state.today ? 'overdue' : ''}` }, `Due ${prettyDate(t.due)}`));
  if (t.priority === 'high') meta.append(el('span', { class: 'chip high' }, '🔥 High priority'));
  if (t.priority === 'low') meta.append(el('span', { class: 'chip' }, 'Low priority'));
  meta.append(t.owner === 'agent' ? el('span', { class: 'chip agent' }, '🤖 Agent') : el('span', { class: 'chip mine' }, '🙋 Mine'));

  const row = el('div', { class: `task p-${t.priority} ${t.status === 'done' ? 'done' : ''}` });
  if (enterIndex !== null) {
    row.classList.add('enter');
    row.style.setProperty('--i', enterIndex);
  }

  const actions = el('div', { class: 'actions' });
  if (t.status === 'archived') {
    actions.append(el('button', { class: 'small', type: 'button', onclick: () => act('POST', `api/tasks/${t.id}/restore`) }, 'Restore'));
  } else {
    if (t.owner === 'agent' && t.status === 'open' && canStartRun(t)) actions.append(el('button', { class: 'small work', type: 'button', onclick: () => workOn(t) }, '🤖 Work on it'));
    actions.append(el('button', { class: 'small', type: 'button', onclick: () => openEdit(t) }, 'Edit'));
    actions.append(el('button', {
      class: 'small', type: 'button',
      onclick: async () => { row.classList.add('leaving'); await wait(320); act('POST', `api/tasks/${t.id}/archive`); },
    }, 'Archive'));
  }

  const fmtDay = (iso) => new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric', timeZone: state.tz });
  const detail = (k, v) => el('div', {}, el('span', {}, k), v);
  const details = el('div', { class: 'details' });
  if (t.notes) details.append(el('div', { class: 'notes full' }, t.notes));
  if (t.files && t.files.length) details.append(el('div', { class: 'thumbs' }, t.files.map((f) => thumb(f))));
  details.append(el('div', { class: 'detail-grid' },
    detail('Due', t.due ? prettyDate(t.due) : 'No due date'),
    detail('Added', fmtDay(t.created_at)),
    ...(t.completed_at ? [detail('Done', fmtDay(t.completed_at))] : [])));
  details.append(actions);

  const head = el('div', { class: 'head', role: 'button', tabindex: '0', 'aria-expanded': 'false' },
    el('div', { class: 'title' }, t.title), el('span', { class: 'chev', 'aria-hidden': 'true' }, '▾'));
  const body = el('div', { class: 'body' }, head);
  if (t.notes) body.append(el('div', { class: 'notes preview' }, t.notes));
  if (t.files && t.files.length) meta.append(el('span', { class: 'chip' }, `📎 ${t.files.length}`));
  body.append(meta);
  const panel = runPanel(t);
  if (panel) body.append(panel);
  body.append(details);

  const setOpen = (open, fromClick = false) => {
    row.classList.toggle('open', open);
    row.classList.toggle('fresh', open && fromClick);
    head.setAttribute('aria-expanded', String(open));
    if (open) state.expanded.add(t.id); else state.expanded.delete(t.id);
  };
  setOpen(state.expanded.has(t.id));
  head.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); setOpen(!row.classList.contains('open'), true); }
  });
  row.addEventListener('click', (ev) => {
    if (ev.target.closest('button, input, textarea, select, a, .run-panel')) return;
    if (String(window.getSelection())) return;
    setOpen(!row.classList.contains('open'), true);
  });

  if (t.status !== 'archived') {
    row.append(el('input', {
      type: 'checkbox',
      'aria-label': `Mark "${t.title}" ${t.status === 'done' ? 'not done' : 'done'}`,
      ...(t.status === 'done' ? { checked: '' } : {}),
      onchange: async (ev) => {
        if (ev.target.checked) {
          const r = ev.target.getBoundingClientRect();
          burst(r.left + r.width / 2, r.top + r.height / 2);
          row.classList.add('completing');
          await wait(520);
        }
        act('PATCH', `api/tasks/${t.id}`, { status: ev.target.checked ? 'done' : 'open' });
      },
    }));
  }
  row.append(body);
  return row;
}

async function act(method, path, body) {
  try { await api(method, path, body); } catch (e) { alert(e.message); }
  await render();
}

async function renderActivity(list) {
  const { events } = await api('GET', 'api/activity?limit=100');
  list.replaceChildren();
  if (!events.length) { list.append(el('div', { class: 'empty' }, el('span', { class: 'big' }, '🌙'), 'No activity yet.')); return; }
  const verbs = {
    created: '✨ added', completed: '✅ completed', reopened: '↩️ reopened', edited: '✏️ edited', archived: '📦 archived',
    restored: '♻️ restored', password_changed: '🔑 changed the password',
    agent_queued: '🤖 sent to the agent:', agent_started: '▶️ started', agent_needs_you: '✋ needs you on', agent_finished: '🏁 finished',
    agent_failed: '⚠️ hit a problem on', agent_stopped: '⏹️ stopped', agent_undo: '↩️ undid the agent\'s file changes on',
  };
  events.forEach((ev, i) => {
    const what = ev.title ? `"${ev.title}"` : '';
    const extra = ev.action === 'edited' && ev.detail ? ` (${ev.detail})` : '';
    const row = el('div', { class: 'event' }, `${whoLabel(ev.actor)} ${verbs[ev.action] || ev.action} ${what}${extra}`, el('div', { class: 'muted' }, new Date(ev.at).toLocaleString()));
    row.style.setProperty('--i', Math.min(i, 14));
    list.append(row);
  });
}

// ---------- add / edit ----------

$('#addForm').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const f = new FormData(ev.target);
  const body = { title: f.get('title'), priority: f.get('priority'), owner: f.get('owner'), notes: f.get('notes') || '', due: f.get('due') || null };
  $('#addError').textContent = '';
  try {
    const { task } = await api('POST', 'api/tasks', body);
    const failed = [];
    for (const file of pending) {
      try { await uploadFile(task.id, file); } catch (e) { failed.push(`${file.name}: ${e.message}`); }
    }
    pending.length = 0;
    renderPending();
    ev.target.reset();
    if (failed.length) $('#addError').textContent = `Task added, but some files did not upload. ${failed.join(' ')}`;
    state.tab = 'open';
    await render({ animate: true });
    $('#addTitle').focus();
  } catch (e) { $('#addError').textContent = e.message; }
});

let editingId = null;

function openEdit(t) {
  editingId = t.id;
  const f = $('#editForm');
  f.title.value = t.title;
  f.notes.value = t.notes;
  f.due.value = t.due || '';
  f.priority.value = t.priority;
  f.owner.value = t.owner;
  $('#editError').textContent = '';
  renderEditFiles(t.files || []);
  $('#editDialog').showModal();
}

function renderEditFiles(files) {
  const box = $('#editFiles');
  box.replaceChildren(...files.map((f) => thumb(f, async () => {
    try {
      await api('DELETE', `api/attachments/${f.id}`);
      files = files.filter((x) => x.id !== f.id);
      renderEditFiles(files);
      render();
    } catch (e) { $('#editError').textContent = e.message; }
  })));
  box._files = files;
}

$('#editAddFile').addEventListener('change', async (ev) => {
  const picked = [...ev.target.files];
  ev.target.value = '';
  $('#editError').textContent = '';
  const files = $('#editFiles')._files || [];
  for (const file of picked) {
    if (!FILE_OK.test(file.type)) { $('#editError').textContent = `${file.name} is not an image, PDF or text file.`; continue; }
    try { files.push(await uploadFile(editingId, file)); } catch (e) { $('#editError').textContent = e.message; }
  }
  renderEditFiles(files);
  render();
});

$('#editCancel').addEventListener('click', () => $('#editDialog').close());
$('#editForm').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const f = ev.target;
  try {
    await api('PATCH', `api/tasks/${editingId}`, { title: f.title.value, notes: f.notes.value, due: f.due.value || null, priority: f.priority.value, owner: f.owner.value });
    $('#editDialog').close();
    await render();
  } catch (e) { $('#editError').textContent = e.message; }
});

// ---------- tabs, login, settings, briefing ----------

$('#tabs').addEventListener('click', (ev) => {
  const b = ev.target.closest('button[data-tab]');
  if (!b) return;
  state.tab = b.dataset.tab;
  render({ animate: true });
});

$('#loginForm').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const f = ev.target;
  $('#loginError').textContent = '';
  try {
    await api('POST', 'api/login', { password: f.password.value });
    f.reset();
    await init();
  } catch (e) { $('#loginError').textContent = e.message; }
});

$('#setupForm').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const f = ev.target;
  $('#setupError').textContent = '';
  try {
    await api('POST', 'api/setup', { password: f.password.value });
    f.reset();
    await init();
  } catch (e) { $('#setupError').textContent = e.message; }
});

$('#settingsBtn').addEventListener('click', () => {
  $('#passwordMsg').textContent = '';
  $('#tgMsg').textContent = '';
  for (const id of ['passwordForm', 'telegramBox', 'settingsHr']) $(`#${id}`).hidden = state.demo;
  $('#demoSettingsNote').hidden = !state.demo;
  if (!state.demo) refreshTelegram();
  $('#settingsDialog').showModal();
});
$('#settingsClose').addEventListener('click', () => $('#settingsDialog').close());

$('#passwordForm').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const f = ev.target;
  const msg = $('#passwordMsg');
  try {
    await api('POST', 'api/password', { password: f.password.value, current: f.current.value });
    f.reset();
    msg.className = '';
    msg.textContent = 'Password saved.';
  } catch (e) { msg.className = 'error'; msg.textContent = e.message; }
});

$('#logoutBtn').addEventListener('click', async () => {
  await api('POST', 'api/logout');
  $('#settingsDialog').close();
  await init();
});

$('#briefingBtn').addEventListener('click', async () => {
  try {
    const b = await api('GET', 'api/briefing/text');
    $('#briefingOut').textContent = b.text;
    $('#briefingDialog').showModal();
  } catch (e) { alert(e.message); }
});
$('#briefingClose').addEventListener('click', () => $('#briefingDialog').close());

// ---------- agent ----------

const ACTIVE_RUN = ['queued', 'running', 'needs_input', 'needs_approval', 'blocked'];
const sigOf = (tasks) => JSON.stringify(tasks.map((t) => [t.id, t.status, t.run && t.run.id, t.run && t.run.status, t.run && t.run.updated_at, (t.files || []).map((f) => f.id)]));
const activeIds = (tasks) => new Set(tasks.filter((t) => t.run && ['queued', 'running'].includes(t.run.status)).map((t) => t.id));

function canStartRun(t) {
  const r = t.run;
  return !r || (!ACTIVE_RUN.includes(r.status) && !['failed', 'stopped', 'timed_out'].includes(r.status));
}

function fmtReset(epochSeconds) {
  return new Date(epochSeconds * 1000).toLocaleString(undefined, { weekday: 'short', hour: 'numeric', minute: '2-digit' });
}

function runPanel(t) {
  const r = t.run;
  if (!r) return null;
  const post = (path, body) => act('POST', path, body || {});
  const btn = (label, cls, fn) => el('button', { class: `small ${cls || ''}`, type: 'button', onclick: fn }, label);
  const detailsBtn = () => btn('Details', '', () => openRunDetails(r.id));
  const stopBtn = () => btn('Stop', '', () => post(`api/runs/${r.id}/stop`));
  const dots = () => el('span', { class: 'dots' }, el('span', {}, '.'), el('span', {}, '.'), el('span', {}, '.'));
  const panel = (cls, head, ...kids) => el('div', { class: `run-panel ${cls}` }, el('div', { class: 'run-head' }, ...head), ...kids);
  const body = (text) => el('div', { class: 'run-body' }, text);
  const row = (...kids) => el('div', { class: 'row wrap' }, ...kids);
  const answerBox = (placeholder, label) => {
    const ta = el('textarea', { rows: '2', placeholder, maxlength: '4000' });
    const send = btn(label, 'go', async () => { if (ta.value.trim()) await post(`api/runs/${r.id}/answer`, { text: ta.value }); });
    return [ta, row(send, stopBtn(), detailsBtn())];
  };

  switch (r.status) {
    case 'queued':
      return panel('', ['⏳ Waiting in line'], row(stopBtn()));
    case 'running':
      return panel('', [el('span', { class: 'spin' }, '⚙️'), 'Working', dots()], row(stopBtn(), detailsBtn()));
    case 'needs_input':
      return panel('needs', ['✋ Needs you'], body(r.question || 'The agent has a question.'), ...answerBox('Type your answer...', 'Send answer'));
    case 'blocked':
      return panel('needs', ['🚧 Blocked'], body(r.question || r.summary || 'The agent cannot continue.'), ...answerBox('Tell it what to do next...', 'Send'));
    case 'needs_approval': {
      const p = r.pending_action || {};
      return panel('needs', ['✋ Needs your approval'],
        body(`It wants to do this (${p.reason || 'needs approval'}):`),
        el('code', { class: 'run-cmd' }, p.value || '(unknown)'),
        row(btn('Approve', 'approve', () => post(`api/runs/${r.id}/approve`, { decision: 'approve' })), btn('Deny', 'deny', () => post(`api/runs/${r.id}/approve`, { decision: 'deny' })), stopBtn(), detailsBtn()));
    }
    case 'finished': {
      const done = r.report_status === 'done';
      const text = r.summary || '';
      return panel(done ? 'ok' : '', [done ? '✅ Finished' : '🟡 Partly done'], body(text.length > 420 ? `${text.slice(0, 420)}...` : text), row(detailsBtn()));
    }
    case 'timed_out':
      return panel('bad', ['⏱️ Stopped at the time limit'], body('Its work so far is saved. Resume to let it continue.'), row(btn('Resume', 'work', () => post(`api/runs/${r.id}/resume`)), detailsBtn()));
    case 'stopped':
      return panel('bad', ['⏹️ Stopped'], row(btn('Resume', 'work', () => post(`api/runs/${r.id}/resume`)), detailsBtn()));
    case 'failed':
      return panel('bad', ['⚠️ Problem'], body(r.error || 'The run failed.'), row(btn('Resume', 'work', () => post(`api/runs/${r.id}/resume`)), detailsBtn()));
    default:
      return null;
  }
}

async function workOn(t) {
  if (state.ai && !state.ai.installed) { openAi(); return; } // no AI connected yet: show how, instead of failing
  await act('POST', `api/tasks/${t.id}/work`, {});
}

async function openRunDetails(id) {
  try {
    const d = await api('GET', `api/runs/${id}`);
    const r = d.run;
    $('#runTitle').textContent = `Agent run #${r.id}`;
    $('#runMeta').textContent = `${r.status.replace('_', ' ')} | ${r.segments} part${r.segments === 1 ? '' : 's'}${r.started_at ? ` | started ${new Date(r.started_at).toLocaleString()}` : ''}`;
    $('#runSummary').textContent = r.summary || r.error || r.question || 'No summary yet.';
    const ch = $('#runChanges');
    ch.replaceChildren();
    if (!d.changes.length) ch.append(el('div', { class: 'muted' }, 'No files changed with the editor tools.'));
    for (const c of d.changes) ch.append(el('div', {}, `${c.existed ? 'Edited' : 'Created'}: ${c.path}`));
    const undo = $('#runUndoBtn');
    undo.hidden = !(d.changes.length && !d.undone && r.status !== 'running');
    undo.onclick = async () => {
      if (!confirm('Put every file the agent edited back the way it was? Files it created are moved aside, not deleted.')) return;
      try {
        const out = await api('POST', `api/runs/${id}/undo`, {});
        alert(`Done: ${out.restored} file(s) restored, ${out.removed} new file(s) moved aside${out.failed.length ? `, ${out.failed.length} could not be restored` : ''}.`);
        await openRunDetails(id);
      } catch (e) { alert(e.message); }
    };
    if (d.undone) ch.append(el('div', { class: 'muted' }, 'These changes were undone.'));
    const lg = $('#runLog');
    lg.replaceChildren();
    for (const e of d.log) lg.append(el('div', {}, el('span', { class: 't' }, new Date(e.at).toLocaleTimeString()), e.kind === 'tool' ? e.text : `${e.kind.replace('_', ' ')}${e.text ? `: ${e.text}` : ''}`));
    if (!$('#runDialog').open) $('#runDialog').showModal();
  } catch (e) { alert(e.message); }
}
$('#runClose').addEventListener('click', () => $('#runDialog').close());

function setPill(sel, w, label) {
  const node = $(sel);
  if (!w) { node.hidden = true; return; }
  node.hidden = false;
  node.textContent = `${label} usage ${w.percent}%`;
  node.className = `pill${w.percent >= 90 ? ' hot' : w.percent >= 80 ? ' warn' : ''}`;
  node.title = `Resets ${fmtReset(w.resets_at)}`;
}

async function refreshAgent() {
  try {
    const s = await api('GET', 'api/agent/status');
    state.agent = s;
    setPill('#usage5h', s.usage && s.usage.five_hour, '5-hour');
    setPill('#usage7d', s.usage && s.usage.seven_day, '7-day');
    const needs = $('#needsChip');
    needs.hidden = !s.needs_you;
    needs.textContent = `✋ ${s.needs_you} need${s.needs_you === 1 ? 's' : ''} you`;
    const chip = $('#agentChip');
    chip.hidden = !(s.running || s.queued);
    chip.textContent = s.running ? `🤖 Agent working${s.queued ? ` (${s.queued} waiting)` : ''}` : `⏳ ${s.queued} queued`;
    const pause = $('#pauseBanner');
    pause.hidden = !s.paused_until;
    if (s.paused_until) pause.textContent = `Plan usage is high, so the agent will not start new runs until it resets ${fmtReset(s.paused_until)}.`;
    $('#workerBanner').hidden = s.worker_ok;
    return s;
  } catch { return null; }
}

async function poll() {
  if ($('#app').hidden) return;
  await refreshAgent();
  if (state.tab === 'activity' || document.querySelector('dialog[open]')) return;
  const typing = document.activeElement && document.activeElement.tagName === 'TEXTAREA' && $('#list').contains(document.activeElement);
  try {
    const { tasks } = await api('GET', `api/tasks?status=${state.tab}`);
    if (state.tab === 'open') {
      for (const id of state.prevActive) if (!tasks.some((t) => t.id === id)) burst(window.innerWidth / 2, 140, 60);
      state.prevActive = activeIds(tasks);
    }
    const sig = sigOf(tasks);
    if (sig !== state.sig && !typing) { state.sig = sig; await render(); }
  } catch { /* try again next time */ }
}
setInterval(poll, 5000);

// ---------- Telegram setup ----------

async function refreshTelegram() {
  const s = state.agent || await refreshAgent();
  const t = s && s.telegram;
  $('#tgStatus').textContent = !t || !t.token_set ? 'Not set up yet.'
    : t.connected ? 'Connected. Alerts go to your Telegram.'
      : 'Token saved. Next: open your bot in Telegram, send it "hi", then press Connect.';
  const b = s && s.briefing;
  if (b) { const f = $('#briefForm'); f.enabled.checked = b.enabled; f.time.value = b.time; }
}

async function tgDo(path, body, okText) {
  const msg = $('#tgMsg');
  msg.className = '';
  msg.textContent = 'Working...';
  try {
    const out = await api('POST', path, body || {});
    msg.textContent = typeof okText === 'function' ? okText(out) : okText;
  } catch (e) { msg.className = 'error'; msg.textContent = e.message; }
  await refreshAgent();
  await refreshTelegram();
}

$('#tgTokenForm').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const f = ev.target;
  await tgDo('api/telegram/token', { token: f.token.value }, (o) => `Token saved for @${o.bot}. Now open the bot in Telegram, send it "hi", then press Connect.`);
  f.reset();
});
$('#tgConnectBtn').addEventListener('click', () => tgDo('api/telegram/connect', {}, (o) => `Connected to ${o.name}. ${o.test_sent ? 'A confirmation message was sent.' : 'The confirmation message could not be sent, so try the test button.'}`));
$('#briefForm').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const f = ev.target;
  const msg = $('#briefMsg');
  msg.className = '';
  try {
    await api('POST', 'api/briefing/settings', { enabled: f.enabled.checked, time: f.time.value || '09:00' });
    msg.textContent = f.enabled.checked ? `Saved. The briefing goes out every morning at ${f.time.value || '09:00'} (${state.tz || 'your time zone'}).` : 'Saved. The daily briefing is off.';
  } catch (e) { msg.className = 'error'; msg.textContent = e.message; }
});
$('#briefNowBtn').addEventListener('click', async () => {
  const msg = $('#briefMsg');
  msg.className = '';
  msg.textContent = 'Sending...';
  try { await api('POST', 'api/briefing/send-now', {}); msg.textContent = 'Sent. Check Telegram.'; } catch (e) { msg.className = 'error'; msg.textContent = e.message; }
});
$('#tgTestBtn').addEventListener('click', () => tgDo('api/telegram/test', {}, 'Test message sent. Check Telegram.'));
$('#tgDisconnectBtn').addEventListener('click', () => { if (confirm('Disconnect Telegram? Alerts stop until you set it up again.')) tgDo('api/telegram/disconnect', {}, 'Disconnected.'); });

// ---------- AI connection ----------

async function refreshAi() {
  try {
    state.ai = await api('GET', 'api/ai/status');
    const a = state.ai;
    $('#aiBanner').hidden = a.installed;
    const dot = $('#aiDot');
    dot.className = `ai-dot ${!a.installed ? 'bad' : a.tested && !a.tested.ok ? 'warn' : a.tested ? 'ok' : 'idle'}`;
    return a;
  } catch { return null; }
}

function aiCheck(state_, text, sub) {
  const icon = { ok: '✅', bad: '❌', warn: '⚠️', idle: '⚪' }[state_];
  return el('li', { class: `ai-check ${state_}` }, el('span', { class: 'ai-icon', 'aria-hidden': 'true' }, icon), el('div', {}, el('div', { class: 'ai-text' }, text), sub ? el('div', { class: 'muted small-hint' }, sub) : ''));
}

function renderAi(a) {
  $('#aiDemoNote').hidden = !a.demo;
  const list = $('#aiChecks');
  list.replaceChildren(
    a.installed
      ? aiCheck('ok', 'Claude Code is installed', a.demo ? 'Simulated in the demo' : a.version)
      : aiCheck('bad', 'Claude Code was not found', 'It is the program that does the work. Install steps below.'),
    !a.installed ? aiCheck('idle', 'Connection not tested', 'Install Claude Code first.')
      : !a.tested ? aiCheck('idle', 'Connection not tested yet', 'Press "Test connection". It sends one tiny request (about 500 tokens).')
        : a.tested.ok ? aiCheck('ok', a.tested.simulated ? 'Connection works (simulated)' : 'Connection works', `Tested ${new Date(a.tested.at).toLocaleString()}`)
          : aiCheck('warn', 'The last test failed', a.tested.why),
    a.mode === 'api'
      ? aiCheck(a.apiKeySet ? 'ok' : 'bad', 'Pays with: your Anthropic API key', a.apiKeySet ? 'Key found. Billed per use by Anthropic.' : 'AGENT_AUTH=api is set, but no ANTHROPIC_API_KEY was found. Run npm run setup.')
      : aiCheck('ok', 'Pays with: your Claude subscription', 'Uses the login from running "claude" once.'),
    a.worker_ok ? aiCheck('ok', 'Agent worker is running') : aiCheck('bad', 'Agent worker is not running', 'Start everything with: npm start'),
    aiCheck('idle', `Workspace: ${a.workspace}`, 'The folder the agent works in. Anything outside it needs your approval.'),
  );
  const help = $('#aiHelp');
  help.replaceChildren();
  if (!a.installed) {
    help.append(el('h3', {}, 'To connect it'),
      el('ol', {},
        el('li', {}, 'Install Claude Code: ', el('a', { href: a.installUrl, target: '_blank', rel: 'noopener' }, a.installUrl)),
        el('li', {}, 'In a terminal, run ', el('code', {}, 'claude'), ' once and log in. (To use an API key instead, see the note below.)'),
        el('li', {}, 'Run ', el('code', {}, 'npm run setup'), ' in the AI Task Desk folder, or just come back here and press "Test connection".')));
  }
}

async function openAi() {
  const a = (await refreshAi()) || state.ai;
  if (!a) return;
  $('#aiTestMsg').textContent = '';
  renderAi(a);
  if (!$('#aiDialog').open) $('#aiDialog').showModal();
}

$('#aiBtn').addEventListener('click', openAi);
$('#aiBannerBtn').addEventListener('click', openAi);
$('#aiClose').addEventListener('click', () => $('#aiDialog').close());
$('#aiTestBtn').addEventListener('click', async () => {
  const msg = $('#aiTestMsg');
  const btn = $('#aiTestBtn');
  msg.className = '';
  msg.textContent = 'Testing... this can take up to a minute.';
  btn.disabled = true;
  try {
    const r = await api('POST', 'api/ai/test', {});
    msg.className = r.ok ? '' : 'error';
    msg.textContent = r.ok ? 'It works. You can use "Work on it" now.' : `That did not work: ${r.why}`;
  } catch (e) { msg.className = 'error'; msg.textContent = e.message; }
  btn.disabled = false;
  const a = await refreshAi();
  if (a) renderAi(a);
});

$('#demoReset').addEventListener('click', async () => {
  if (!confirm('Reset the demo? Your changes are discarded and the sample tasks come back.')) return;
  try { await api('POST', 'api/demo/reset', {}); } catch (e) { alert(e.message); return; }
  state.tab = 'open';
  state.view = 'week';
  state.expanded.clear();
  await render({ animate: true });
});

init();
