'use strict';
// Files attached to tasks (screenshots, PDFs, text). Shared by server.js and worker.js.
// No npm dependencies.
// Files live in data/attachments/ under a plain numeric name, so a file called "token.png"
// can never trip the agent's secret-file rules.

const fs = require('node:fs');
const path = require('node:path');

const DIR = path.join(require('./config').DATA_DIR, 'attachments');
const MAX_BYTES = 10 * 1024 * 1024;
const MAX_PER_TASK = 10;
const TYPES = {
  'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp',
  'application/pdf': 'pdf', 'text/plain': 'txt', 'text/markdown': 'md',
};
const isImage = (mime) => mime.startsWith('image/');

function initAttachments(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS attachments (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id    INTEGER NOT NULL,
      name       TEXT NOT NULL,
      mime       TEXT NOT NULL,
      size       INTEGER NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_attachments_task ON attachments(task_id);
  `);
}

// What the file really is, from its first bytes. The label the browser sends is not trusted.
function sniff(buf) {
  if (buf.length >= 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.length >= 6 && /^GIF8[79]a$/.test(buf.subarray(0, 6).toString('latin1'))) return 'image/gif';
  if (buf.length >= 12 && buf.subarray(0, 4).toString('latin1') === 'RIFF' && buf.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
  if (buf.length >= 5 && buf.subarray(0, 5).toString('latin1') === '%PDF-') return 'application/pdf';
  if (buf.length && !buf.subarray(0, 4096).includes(0)) return 'text/plain';
  return null;
}

function cleanName(name, ext) {
  let n = String(name || '').replace(/[\u0000-\u001f\u007f"\\/]/g, '').trim().slice(0, 100);
  if (!n) n = `file.${ext}`;
  return n;
}

function listForTask(db, taskId) {
  return db.prepare('SELECT id, task_id, name, mime, size, created_at FROM attachments WHERE task_id = ? ORDER BY id').all(taskId).map((r) => ({ ...r }));
}

// Returns the new attachment row; throws an Error with .status for problems the caller should show.
function save(db, taskId, name, claimedMime, buf) {
  const fail = (status, msg) => Object.assign(new Error(msg), { status });
  if (!buf.length) throw fail(400, 'That file is empty');
  if (buf.length > MAX_BYTES) throw fail(413, `That file is too big (${Math.round(MAX_BYTES / 1048576)} MB max)`);
  let mime = sniff(buf);
  if (!mime) throw fail(415, 'Only images, PDFs and plain text files can be attached');
  // plain-text files may be markdown; keep that label only if the sender said so
  if (mime === 'text/plain' && claimedMime === 'text/markdown') mime = 'text/markdown';
  if (!TYPES[mime]) throw fail(415, 'Only images, PDFs and plain text files can be attached');
  const count = db.prepare('SELECT COUNT(*) AS n FROM attachments WHERE task_id = ?').get(taskId).n;
  if (count >= MAX_PER_TASK) throw fail(409, `A task can hold up to ${MAX_PER_TASK} files`);
  const now = new Date().toISOString();
  const info = db.prepare('INSERT INTO attachments (task_id, name, mime, size, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(taskId, cleanName(name, TYPES[mime]), mime, buf.length, now);
  const id = Number(info.lastInsertRowid);
  try {
    fs.mkdirSync(DIR, { recursive: true });
    fs.writeFileSync(fileOf(id, mime), buf, { mode: 0o600 });
  } catch (e) {
    db.prepare('DELETE FROM attachments WHERE id = ?').run(id);
    throw e;
  }
  return { id, task_id: taskId, name: cleanName(name, TYPES[mime]), mime, size: buf.length, created_at: now };
}

const fileOf = (id, mime) => path.join(DIR, `a${id}.${TYPES[mime]}`);

function get(db, id) {
  const r = db.prepare('SELECT id, task_id, name, mime, size, created_at FROM attachments WHERE id = ?').get(id);
  return r ? { ...r } : null;
}

function remove(db, id) {
  const a = get(db, id);
  if (!a) return false;
  db.prepare('DELETE FROM attachments WHERE id = ?').run(id);
  try { fs.unlinkSync(fileOf(a.id, a.mime)); } catch { /* already gone */ }
  return true;
}

module.exports = { DIR, MAX_BYTES, MAX_PER_TASK, TYPES, isImage, initAttachments, listForTask, save, get, remove, fileOf };
