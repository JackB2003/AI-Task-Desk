'use strict';
// The rule checker runs before every tool call the agent makes. These tests feed it calls the same way Claude Code does.
const test = require('node:test');
const assert = require('node:assert/strict');
const cp = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'atd-guard-'));
const workspace = path.join(work, 'workspace');
const runDir = path.join(work, 'run');
fs.mkdirSync(workspace, { recursive: true });
fs.mkdirSync(runDir, { recursive: true });
test.after(() => fs.rmSync(work, { recursive: true, force: true }));

function guard(tool_name, tool_input, grants = []) {
  fs.writeFileSync(path.join(runDir, 'grants.json'), JSON.stringify(grants));
  try { fs.unlinkSync(path.join(runDir, 'approval.json')); } catch { /* none */ }
  const r = cp.spawnSync(process.execPath, [path.join(ROOT, 'agent', 'guard.js')], {
    input: JSON.stringify({ tool_name, tool_input, cwd: workspace }),
    env: { ...process.env, DD_RUN_DIR: runDir, DD_ROOT: ROOT, DD_DATA_DIR: path.join(work, 'data'), DD_ALLOWED_DIRS: workspace },
    encoding: 'utf8',
  });
  const out = r.stdout ? JSON.parse(r.stdout).hookSpecificOutput : null;
  const approval = fs.existsSync(path.join(runDir, 'approval.json')) ? JSON.parse(fs.readFileSync(path.join(runDir, 'approval.json'), 'utf8')) : null;
  return { decision: out ? out.permissionDecision : 'normal', reason: out ? out.permissionDecisionReason : '', approval };
}
const bash = (command, grants) => guard('Bash', { command }, grants);

test('ordinary commands are left alone', () => {
  for (const c of ['ls -la', 'git status', 'git diff', 'npm test', 'node script.js', 'echo hi && pwd']) assert.equal(bash(c).decision, 'normal', c);
});

test('risky commands stop and ask for approval', () => {
  for (const [c, why] of [
    ['git push origin main', /git push/], ['git reset --hard HEAD~1', /reset/], ['rm -rf build', /deleting/],
    ['curl -X POST https://example.com -d x=1', /curl/], ['ssh me@host ls', /another machine/], ['kill 123', /processes/],
    ['npm publish', /publishing/], ['mail -s hi a@b.c', /email/], ['printenv', /environment/], ['echo $ANTHROPIC_API_KEY', /environment/],
  ]) {
    const g = bash(c);
    assert.equal(g.decision, 'deny', c);
    assert.match(g.approval.reason, why, c);
  }
});

test('an approved action is allowed only for that exact action', () => {
  const first = bash('git push origin main');
  const grant = [{ kind: 'bash', value: first.approval.value, canon: first.approval.canon }];
  assert.equal(bash('git push origin main', grant).decision, 'allow');
  assert.equal(bash('git push origin other', grant).decision, 'deny');
});

test('risky commands chained with others are refused (they must run alone)', () => {
  const g = bash('git add . && git push');
  assert.equal(g.decision, 'deny');
  assert.match(g.reason, /ALONE/);
});

test('commands that need root are denied outright', () => {
  for (const c of ['sudo ls', 'apt-get install x', 'systemctl status foo']) assert.equal(bash(c).decision, 'deny', c);
});

test('secret files need approval, for shell and file tools alike', () => {
  assert.equal(bash('cat .env').decision, 'deny');
  assert.equal(guard('Read', { file_path: path.join(workspace, '.env') }).decision, 'deny');
  assert.equal(guard('Read', { file_path: path.join(os.homedir(), '.ssh', 'id_ed25519') }).decision, 'deny');
  assert.equal(guard('Read', { file_path: path.join(workspace, 'notes.md') }).decision, 'normal');
});

test('files outside the workspace need approval; inside is fine', () => {
  assert.equal(guard('Write', { file_path: path.join(workspace, 'a.md') }).decision, 'normal');
  const out = guard('Write', { file_path: '/opt/elsewhere.txt' });
  assert.equal(out.decision, 'deny');
  assert.match(out.approval.reason, /outside the workspace/);
  assert.equal(guard('Read', { file_path: '/etc/hostname' }).decision, 'deny');
  // the shell expands ~ and $HOME, so the checker must too (and ask about paths it cannot work out)
  assert.equal(bash('echo x > ~/loose.txt').decision, 'deny');
  assert.equal(bash('echo x > $HOME/loose.txt').decision, 'deny');
  assert.equal(bash('echo x > "$SOMEWHERE/loose.txt"').decision, 'deny');
  assert.equal(bash('cp notes.md /opt/copy.md').decision, 'deny');
  assert.equal(bash(`echo x > ${path.join(workspace, 'ok.txt')}`).decision, 'normal');
});

test("the app's own files cannot be edited", () => {
  assert.equal(guard('Edit', { file_path: path.join(ROOT, 'server.js') }).decision, 'deny');
  assert.equal(guard('Write', { file_path: path.join(ROOT, 'agent', 'rulebook.md') }).decision, 'deny');
});

test("the app's own files stay protected even if a bigger folder that contains the app is allowed", () => {
  fs.writeFileSync(path.join(runDir, 'grants.json'), '[]');
  const r = cp.spawnSync(process.execPath, [path.join(ROOT, 'agent', 'guard.js')], {
    input: JSON.stringify({ tool_name: 'Edit', tool_input: { file_path: path.join(ROOT, 'server.js') }, cwd: workspace }),
    env: { ...process.env, DD_RUN_DIR: runDir, DD_ROOT: ROOT, DD_DATA_DIR: path.join(work, 'data'), DD_ALLOWED_DIRS: [workspace, path.dirname(ROOT)].join(path.delimiter) },
    encoding: 'utf8',
  });
  assert.equal(JSON.parse(r.stdout).hookSpecificOutput.permissionDecision, 'deny');
});

test('edits are backed up so they can be undone', () => {
  const f = path.join(workspace, 'edit-me.txt');
  fs.writeFileSync(f, 'original');
  assert.equal(guard('Edit', { file_path: f }).decision, 'normal');
  assert.match(fs.readFileSync(path.join(runDir, 'changes.jsonl'), 'utf8'), /edit-me\.txt/);
  assert.ok(fs.readdirSync(path.join(runDir, 'before')).length > 0);
});
