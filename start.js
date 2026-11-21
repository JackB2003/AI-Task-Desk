'use strict';
// Starts the web app and the agent worker together, restarts either if it crashes, and stops both on Ctrl+C.
// (If you prefer a process manager like pm2 or systemd, run server.js and worker.js yourself.)

const cp = require('node:child_process');
const path = require('node:path');
const { DEMO } = require('./config');

const parts = DEMO ? ['server.js'] : ['server.js', 'worker.js'];
const children = new Map();
let stopping = false;

function launch(file, delay = 0) {
  setTimeout(() => {
    if (stopping) return;
    const started = Date.now();
    const child = cp.spawn(process.execPath, [path.join(__dirname, file)], { stdio: 'inherit' });
    children.set(file, child);
    child.on('exit', (code) => {
      children.delete(file);
      if (stopping) return;
      const ranFor = Date.now() - started;
      console.error(`${file} stopped (code ${code}). Restarting...`);
      launch(file, ranFor < 5000 ? 5000 : 500); // crash loop: wait a bit
    });
  }, delay);
}

function stop() {
  stopping = true;
  for (const c of children.values()) c.kill('SIGTERM');
  setTimeout(() => process.exit(0), 1500).unref();
}
process.on('SIGINT', stop);
process.on('SIGTERM', stop);

parts.forEach((f) => launch(f));
