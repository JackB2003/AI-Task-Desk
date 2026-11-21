'use strict';
// Shared settings for the web app, the agent worker and the setup guide.
// Values come from environment variables, or from a .env file next to this one.
// No npm dependencies.

const fs = require('node:fs');
const path = require('node:path');

const ROOT = __dirname;

function loadEnvFile(file) {
  const out = {};
  let txt = '';
  try { txt = fs.readFileSync(file, 'utf8'); } catch { return out; }
  for (const line of txt.split('\n')) {
    if (line.trim().startsWith('#')) continue;
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m) out[m[1]] = m[2].replace(/^['"]|['"]$/g, '');
  }
  return out;
}

const env = { ...loadEnvFile(path.join(ROOT, '.env')), ...process.env };

const DATA_DIR = path.resolve(ROOT, env.DATA_DIR || 'data');

const systemTz = () => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; } catch { return 'UTC'; } };

module.exports = {
  ROOT,
  env,
  loadEnvFile,
  DATA_DIR,
  DB_FILE: path.join(DATA_DIR, 'desk.db'),
  TZ: env.TIMEZONE || systemTz(),
  PORT: Number(env.PORT || 3025),
  HOST: env.HOST || '127.0.0.1',
  DEMO: env.DEMO === '1',
  PUBLIC_URL: env.PUBLIC_URL || `http://localhost:${Number(env.PORT || 3025)}/`,
  WORKSPACE: path.resolve(ROOT, env.AGENT_WORKSPACE || 'workspace'),
};
