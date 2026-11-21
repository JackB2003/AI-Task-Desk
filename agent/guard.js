'use strict';
// Rule checker. Claude runs this before EVERY tool call the agent makes (PreToolUse hook).
// Reads the call as JSON on stdin; prints a JSON decision (or nothing = normal rules apply).
//
// Per-run files live in $DD_RUN_DIR:
//   grants.json      approvals you gave: [{kind:'bash'|'path', value}]   (written by the worker)
//   approval.json    the last action that was blocked pending approval     (read by the worker)
//   changes.jsonl    every file the agent edited, with where its original was saved
//   before/          copies of the original files (the undo log)
//
// Fails closed: if this script itself breaks, the tool call is denied.

const fs = require('node:fs');
const path = require('node:path');

const RUN_DIR = process.env.DD_RUN_DIR || '';
const APP_ROOT = process.env.DD_ROOT || path.resolve(__dirname, '..');
// Folders the agent may use without asking (the workspace, plus any AGENT_ADD_DIRS), and the temp folder.
const ALLOWED_DIRS = String(process.env.DD_ALLOWED_DIRS || '').split(path.delimiter).filter(Boolean).map((d) => path.resolve(d)).concat(['/tmp', require('node:os').tmpdir()]);
const under = (p, dir) => p === dir || p.startsWith(dir.endsWith(path.sep) ? dir : dir + path.sep);
const DATA_DIR = path.resolve(process.env.DD_DATA_DIR || path.join(APP_ROOT, 'data'));
const insideAllowed = (p) => ALLOWED_DIRS.some((d) => under(p, d)) || (RUN_DIR && under(p, RUN_DIR)) || under(p, path.join(DATA_DIR, 'attachments'));

const norm = (s) => String(s).trim().split(/\s+/).join(' ');

function decide(decision, reason) {
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: decision, permissionDecisionReason: reason } }));
  process.exit(0);
}

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

const grants = RUN_DIR ? readJson(path.join(RUN_DIR, 'grants.json'), []) : [];
// Bash approvals match the action itself (folder + command), not the exact wording, so
// `cd repo && git push` and `git -C repo push` count as the same approved action.
const isGranted = (kind, value, canon) => grants.some((g) => g.kind === kind && (kind === 'bash' ? (canon && g.canon ? g.canon === canon : norm(g.value) === norm(value)) : g.value === value));

function requestApproval(kind, value, reason, tool, canon) {
  if (RUN_DIR) {
    const rec = { tool, kind, value, reason, canon: canon || null, at: new Date().toISOString() };
    try {
      fs.writeFileSync(path.join(RUN_DIR, 'approval.json'), JSON.stringify(rec));
      fs.appendFileSync(path.join(RUN_DIR, 'approvals.jsonl'), `${JSON.stringify(rec)}\n`);
    } catch { /* the deny below still protects */ }
  }
  decide('deny', `APPROVAL REQUIRED (${reason}). Do not retry or work around this. Finish now with status needs_approval, and say what you were trying to do and why.`);
}

// ---------- paths ----------

const SECRET_PATHS = [
  /(^|\/)\.env(\.[^/]*)?$/, /(^|\/)\.credentials\.json$/, /(^|\/)\.git-credentials$/, /(^|\/)\.npmrc$/, /(^|\/)\.netrc$/,
  /\.(pem|key|p12|pfx)$/i, /(^|\/)id_(rsa|ed25519|ecdsa|dsa)(\.pub)?$/, /(^|\/)\.ssh(\/|$)/, /(^|\/)\.config(\/|$)/,
  /(^|\/)\.claude(\/|$)/, /(^|\/)\.aws(\/|$)/, /(^|\/)\.gnupg(\/|$)/, /(^|\/)\.kube(\/|$)/,
  // files named like a secret with no extension (my_token), or secret/credential json files; source files like tokenizer.js are fine
  /(^|\/)[^/.]*(token|secret|apikey|api_key|password)[^/.]*$/i, /(secret|credentials?)[^/]*\.json$/i,
];
const isSecretPath = (p) => SECRET_PATHS.some((re) => re.test(p));

// The app's own code, database and settings are off limits for writing (the workspace folder inside it is fine).
const isProtectedWrite = (p) => (under(p, APP_ROOT) || under(p, DATA_DIR)) && !ALLOWED_DIRS.some((d) => under(p, d)) && !(RUN_DIR && under(p, RUN_DIR));

const SYSTEM_DIRS = /^\/(etc|usr|boot|sys|proc|dev|root|var\/lib|var\/log|bin|sbin|lib|lib64)(\/|$)/;

function resolveP(p, cwd) {
  return path.resolve(cwd || process.cwd(), String(p));
}

// ---------- shell commands ----------

const NEEDS_ROOT = /^(sudo|su|systemctl|service|apt|apt-get|dpkg|snap|shutdown|reboot|halt|poweroff|mount|umount|iptables|ufw|fail2ban-client|nginx|certbot|visudo|useradd|usermod|userdel|passwd|chroot)$/;

function firstWord(seg) {
  const toks = seg.trim().split(/\s+/);
  let i = 0;
  while (i < toks.length && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(toks[i]) || ['time', 'nohup', 'command', 'exec', 'env'].includes(toks[i]))) i++;
  return { word: (toks[i] || '').replace(/^.*\//, ''), rest: toks.slice(i + 1) };
}

const SECRET_IN_CMD = /(^|[\s"'=\/<>])(\.env(\.[A-Za-z0-9_-]+)?|\.credentials\.json|\.git-credentials|\.netrc|\.npmrc|id_(rsa|ed25519|ecdsa)|\.ssh\/[^\s"']*|\.aws\/[^\s"']*)(?=$|[\s"';|&)<>])/;

// Returns a reason string if this single command (no chaining) needs your approval, else null.
function approvalReason(seg) {
  const { word, rest } = firstWord(seg);
  const text = seg.toLowerCase();
  if (word === 'git') {
    if (/\bpush\b/.test(text)) return 'git push';
    if (/\breset\b.*--hard/.test(text)) return 'git reset --hard (discards work)';
    if (/\bclean\b/.test(text)) return 'git clean (deletes files)';
    if (/\bbranch\b.*\s-D\b/.test(seg)) return 'deleting a git branch';
    if (/\bfilter-branch\b|\bfilter-repo\b/.test(text)) return 'rewriting git history';
    if (/\brm\b/.test(text)) return 'git rm (deletes files)';
  }
  if (['pm2', 'systemctl', 'launchctl'].includes(word) && /\b(restart|reload|stop|delete|start|kill|save|resurrect|flush|unload|load|disable|enable)\b/.test(text)) return 'changing a running app or service';
  if (['rm', 'rmdir', 'shred', 'unlink', 'trash'].includes(word)) {
    const targets = rest.filter((t) => !t.startsWith('-')).map((t) => t.replace(/^["']|["']$/g, ''));
    const scratch = targets.length && targets.every((t) => t.startsWith('/tmp/') || (RUN_DIR && t.startsWith(RUN_DIR)));
    if (!scratch) return 'deleting files';
  }
  if (word === 'find' && /\s-delete\b|\s-exec\s+(rm|shred)\b/.test(text)) return 'deleting files';
  if (['curl', 'wget'].includes(word) && /(\s-X\s*(post|put|patch|delete)\b|--request\s+(post|put|patch|delete)\b|\s-d\s|\s-d[^\s]|--data|\s-F\s|--form|\s-T\s|--upload-file|--json)/i.test(seg)) return 'sending data out with curl/wget';
  if (['sendmail', 'mail', 'mailx', 'mutt', 'msmtp', 'swaks'].includes(word)) return 'sending email';
  if (word === 'sqlite3' && /\b(insert|update|delete|drop|alter|create|replace|truncate|vacuum)\b/i.test(seg)) return 'writing to a database';
  if (['psql', 'mysql', 'mariadb', 'mongosh', 'mongo', 'redis-cli'].includes(word)) return 'database access';
  if (['stripe', 'aws', 'gcloud', 'az', 'doctl', 'terraform', 'pulumi', 'heroku', 'flyctl', 'fly'].includes(word)) return 'cloud or payment tool';
  if (word === 'gh' && !/\b(view|list|diff|checks|status|--version|help)\b/.test(text)) return 'GitHub action';
  if (['vercel', 'netlify', 'wrangler', 'firebase', 'rsync', 'scp', 'ssh', 'sftp', 'ftp'].includes(word)) return 'deploying or connecting to another machine';
  if (['npm', 'yarn', 'pnpm'].includes(word) && /\bpublish\b/.test(text)) return 'publishing a package';
  if (word === 'docker' && /\b(rm|rmi|stop|kill|prune|down)\b/.test(text)) return 'changing containers';
  if (['kill', 'pkill', 'killall'].includes(word)) return 'stopping processes';
  if (word === 'crontab') return 'changing scheduled jobs';
  if (SECRET_IN_CMD.test(seg)) return 'touching a secret file';
  if (word === 'printenv' || /^env\s*$/.test(seg.trim()) || /\bANTHROPIC_(API_KEY|AUTH_TOKEN)\b/.test(seg)) return 'reading secrets from the environment';
  return null;
}

// Common shell ways of writing a file: redirects, tee, sed -i / perl -i, mv, cp.
// Their targets are backed up (or checked against the protected list) before the command runs.
function bashWriteTargets(cmd, cwd) {
  const clean = (t) => t.replace(/^["']|["']$/g, '');
  const maybeNew = new Set(); // redirect/tee/cp targets: may not exist yet
  const mustExist = new Set(); // sed -i / mv sources: only count real files
  let m;
  const redir = /(?:^|[^<&>0-9\\])(?:\d?>>?|&>>?)\s*("[^"]+"|'[^']+'|[^\s;&|<>()]+)/g;
  while ((m = redir.exec(cmd))) maybeNew.add(clean(m[1]));
  const tee = /\btee\s+(?:-[a-zA-Z]+\s+)*("[^"]+"|'[^']+'|[^\s;&|<>()]+)/g;
  while ((m = tee.exec(cmd))) maybeNew.add(clean(m[1]));
  for (const seg of cmd.split(/&&|\|\||;|\||\n/)) {
    const { word, rest } = firstWord(seg);
    if ((word === 'sed' || word === 'perl') && rest.some((t) => /^-[a-zA-Z]*i/.test(t))) {
      for (const t of rest) if (!t.startsWith('-')) mustExist.add(clean(t));
    }
    if (word === 'mv' || word === 'cp') {
      const args = rest.filter((t) => !t.startsWith('-')).map(clean);
      if (args.length >= 2) {
        const dest = resolveP(args[args.length - 1], cwd);
        let destIsDir = false;
        try { destIsDir = fs.statSync(dest).isDirectory(); } catch { /* not there yet */ }
        for (const src of args.slice(0, -1)) {
          if (destIsDir) maybeNew.add(path.join(dest, path.basename(src)));
          if (word === 'mv') mustExist.add(src);
        }
        if (!destIsDir) maybeNew.add(args[args.length - 1]);
      }
    }
  }
  // The shell turns ~ and $HOME into the home folder before the command runs, so do the same here.
  const home = require('node:os').homedir();
  const expand = (t) => t.replace(/^~(?=\/|$)/, home).replace(/^\$\{?HOME\}?(?=\/|$)/, home);
  const ignorable = (t) => !t || t.startsWith('/dev/') || t.startsWith('&');
  const unresolved = []; // targets built from other variables or command output: cannot be checked, so ask
  const usable = (t0) => {
    const t = expand(t0);
    if (ignorable(t)) return false;
    if (/[$`]/.test(t)) { unresolved.push(t0); return false; }
    return !/[*?]/.test(t);
  };
  const out = [];
  for (const t of maybeNew) if (usable(t)) out.push(resolveP(expand(t), cwd));
  for (const t of mustExist) {
    if (!usable(t)) continue;
    const abs = resolveP(expand(t), cwd);
    try { if (fs.statSync(abs).isFile()) out.push(abs); } catch { /* not a file */ }
  }
  return { paths: [...new Set(out)].filter((p) => !(RUN_DIR && p.startsWith(RUN_DIR))), unresolved };
}

function guardBashWrites(cmd, cwd) {
  const { paths, unresolved } = bashWriteTargets(cmd, cwd);
  for (const raw of unresolved) {
    if (isGranted('path', raw)) continue;
    requestApproval('path', raw, 'writing to a path the rule checker cannot resolve', 'Bash');
  }
  for (const abs of paths) {
    if (SYSTEM_DIRS.test(abs)) decide('deny', `${abs} is a system location you cannot change (it needs root). Finish with status blocked and say what the user needs to do.`);
    if (isSecretPath(abs) || isProtectedWrite(abs)) {
      if (isGranted('path', abs)) continue;
      requestApproval('path', abs, isSecretPath(abs) ? 'touching a secret file' : "changing the app's own files", 'Bash');
    }
    if (!insideAllowed(abs)) {
      if (isGranted('path', abs)) continue;
      requestApproval('path', abs, 'writing outside the workspace folder', 'Bash');
    }
    backupBeforeWrite(abs, 'Bash');
  }
}

function checkBash(cmd, cwd) {
  const segs = cmd.split(/&&|\|\||;|\||\n/).map((s) => s.trim()).filter(Boolean);
  for (const seg of segs) {
    const { word } = firstWord(seg);
    if (NEEDS_ROOT.test(word)) decide('deny', `The "${word}" command needs root, which you do not have. Do not try to work around it. Finish with status blocked and say exactly what the user needs to do.`);
  }
  const reasons = segs.map(approvalReason).filter(Boolean);
  if (!reasons.length) { guardBashWrites(cmd, cwd); return; } // ordinary command: back up what it writes, then normal rules (allowed)
  // An action that needs approval must be one command, optionally after `cd <folder>` steps, or `git -C <folder>`.
  const info = analyzeApprovable(segs, cwd);
  if (!info) decide('deny', `This command includes an action that needs approval (${reasons[0]}) and is chained with other commands. Run the other steps first, then run the risky command ALONE as one single command (you may \`cd\` into the folder first, in a separate step).`);
  const canon = `${info.dir}\u0000${info.cmd}`;
  if (isGranted('bash', info.cmd, canon)) decide('allow', 'Approved by the user for this action.');
  requestApproval('bash', `${info.cmd}   (in ${info.dir})`, reasons[0], 'Bash', canon);
}

// Segments must be zero or more `cd <folder>` steps followed by exactly one command.
function analyzeApprovable(segs, cwd) {
  const clean = (t) => t.replace(/^["']|["']$/g, '');
  let dir = cwd || process.cwd();
  for (let i = 0; i < segs.length - 1; i++) {
    const { word, rest } = firstWord(segs[i]);
    if (word !== 'cd' || rest.length !== 1 || /[$*?`]/.test(rest[0])) return null;
    dir = resolveP(clean(rest[0]), dir);
  }
  let c = segs[segs.length - 1];
  const m = c.match(/^(\s*(?:[A-Za-z_][A-Za-z0-9_]*=\S+\s+)*git)\s+-C\s+("[^"]+"|'[^']+'|\S+)\s+(.*)$/);
  if (m) { dir = resolveP(clean(m[2]), dir); c = `${m[1]} ${m[3]}`; }
  return { dir, cmd: norm(c) };
}

// ---------- file tools ----------

function loggedChanges() {
  if (!RUN_DIR) return [];
  try {
    return fs.readFileSync(path.join(RUN_DIR, 'changes.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  } catch { return []; }
}

function backupBeforeWrite(file, tool) {
  if (!RUN_DIR) return;
  const prior = loggedChanges();
  if (prior.some((c) => c.path === file)) return; // the first original is the one that matters
  const rec = { path: file, tool, at: new Date().toISOString(), existed: false, mode: null, bak: null };
  try {
    const st = fs.statSync(file);
    if (st.isFile()) {
      fs.mkdirSync(path.join(RUN_DIR, 'before'), { recursive: true });
      rec.bak = `b${prior.length + 1}`;
      fs.copyFileSync(file, path.join(RUN_DIR, 'before', rec.bak));
      rec.existed = true;
      rec.mode = st.mode & 0o777;
    }
  } catch { /* file does not exist yet: a new file */ }
  fs.appendFileSync(path.join(RUN_DIR, 'changes.jsonl'), `${JSON.stringify(rec)}\n`);
}

function checkFileTool(tool, input, cwd) {
  const writeTool = tool === 'Edit' || tool === 'Write';
  const candidates = [];
  if (writeTool) candidates.push(input.file_path);
  else {
    for (const k of ['file_path', 'path', 'glob']) if (typeof input[k] === 'string') candidates.push(input[k]);
    if (tool === 'Glob' && typeof input.pattern === 'string') candidates.push(input.pattern);
  }
  for (const c of candidates) {
    if (!c) continue;
    const abs = resolveP(c, cwd);
    if (writeTool && SYSTEM_DIRS.test(abs)) decide('deny', `${abs} is a system location you cannot change (it needs root). Finish with status blocked and say what the user needs to do.`);
    const secretWildcard = !writeTool && /(^|\/)\.env[^/]*$/.test(String(c)); // e.g. a Glob for ".env*"
    if (isSecretPath(abs) || secretWildcard || (writeTool && isProtectedWrite(abs))) {
      if (isGranted('path', abs)) continue;
      requestApproval('path', abs, writeTool && !isSecretPath(abs) ? "changing the app's own files" : 'touching a secret file', tool);
    }
    if (!insideAllowed(abs)) {
      if (isGranted('path', abs)) continue;
      requestApproval('path', abs, 'outside the workspace folder', tool);
    }
  }
  if (writeTool && input.file_path) backupBeforeWrite(resolveP(input.file_path, cwd), tool);
}

// ---------- main ----------

try {
  const raw = fs.readFileSync(0, 'utf8');
  const call = JSON.parse(raw || '{}');
  const tool = call.tool_name;
  const input = call.tool_input || {};
  if (tool === 'Bash') checkBash(String(input.command || ''), call.cwd);
  else if (['Read', 'Glob', 'Grep', 'Edit', 'Write'].includes(tool)) checkFileTool(tool, input, call.cwd);
  process.exit(0);
} catch (e) {
  decide('deny', `Rule checker error (${e.message}). Blocked to be safe. Finish with status blocked.`);
}
