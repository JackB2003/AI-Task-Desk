'use strict';
// On a first run, `npm start` launches the web app and the worker at the same moment. Both open a brand-new database.
const test = require('node:test');
const assert = require('node:assert/strict');
const cp = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

test('several processes can create the same new database at once', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atd-db-'));
  const file = path.join(dir, 'desk.db');
  const code = `require(${JSON.stringify(path.resolve(__dirname, '..', 'db.js'))}).openDb(${JSON.stringify(file)}); process.exit(0);`;
  const runs = Array.from({ length: 16 }, () => new Promise((resolve) => {
    const c = cp.spawn(process.execPath, ['-e', code], { stdio: ['ignore', 'ignore', 'pipe'], env: { ...process.env, NODE_NO_WARNINGS: '1' } });
    let err = '';
    c.stderr.on('data', (d) => { err += d; });
    c.on('exit', (status) => resolve({ status, err }));
  }));
  const results = await Promise.all(runs);
  fs.rmSync(dir, { recursive: true, force: true });
  for (const r of results) assert.equal(r.status, 0, r.err);
});
