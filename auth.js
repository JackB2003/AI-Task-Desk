'use strict';
// Password hashing and signed login cookies. One user, one password, no npm dependencies.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const A = require('./agentlib');

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

function safeEqual(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  return `${salt.toString('hex')}:${crypto.scryptSync(pw, salt, 64).toString('hex')}`;
}

function verifyPassword(pw, stored) {
  if (!stored) return false;
  const [salt, hash] = stored.split(':');
  const calc = crypto.scryptSync(String(pw), Buffer.from(salt, 'hex'), 64);
  const expected = Buffer.from(hash, 'hex');
  return calc.length === expected.length && crypto.timingSafeEqual(calc, expected);
}

// The cookie-signing secret: from SESSION_SECRET, or generated once and kept in data/.session-secret.
function loadSessionSecret(env, dataDir) {
  if (env.SESSION_SECRET && env.SESSION_SECRET.length >= 32) return env.SESSION_SECRET;
  const file = path.join(dataDir, '.session-secret');
  try {
    const s = fs.readFileSync(file, 'utf8').trim();
    if (s.length >= 32) return s;
  } catch { /* first run */ }
  const s = crypto.randomBytes(32).toString('hex');
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, s, { mode: 0o600 });
  return s;
}

function makeAuth(secret) {
  const mac = (db, exp) => crypto.createHmac('sha256', secret).update(`${exp}.${A.getSetting(db, 'session_epoch') || '0'}`).digest('base64url');
  return {
    makeToken(db) {
      const exp = String(Date.now() + 30 * 24 * 3600 * 1000);
      return `${exp}.${mac(db, exp)}`;
    },
    verifyToken(db, tok) {
      const [exp, m] = String(tok).split('.');
      if (!exp || !m || Number(exp) < Date.now()) return false;
      return safeEqual(m, mac(db, exp));
    },
  };
}

function parseCookies(req) {
  const out = {};
  for (const part of String(req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}

module.exports = { sha256, safeEqual, hashPassword, verifyPassword, loadSessionSecret, makeAuth, parseCookies };
