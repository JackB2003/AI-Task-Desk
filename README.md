# AI Task Desk

A personal task list where some tasks are handed to an AI agent.

Add a task, mark it **Agent**, press **Work on it**. The agent (Claude Code) does the work in a sandbox folder, asks you when it needs a decision, stops and asks before anything risky, and reports back. Every file it changes can be undone with one click. Optional Telegram alerts tell you when it needs you.

**[Try the live demo](https://jackhost.shop/ai-task-desk/)** (simulated agent, no sign-up, nothing to install)

- No npm dependencies. Plain Node.js, SQLite (built into Node), vanilla JavaScript.
- Runs on your own machine. Your tasks never leave it.
- Built around a safety layer: a rule checker runs before **every** action the agent takes.

## What you need

| You need | Why | Cost |
| --- | --- | --- |
| **Node.js 22.13 or newer** | runs the app (uses Node's built-in SQLite) | free |
| **Claude Code** | this is the AI agent | needs a Claude **subscription** (Pro or Max) **or** your own **Anthropic API key** (pay per use) |
| macOS or Linux (Windows: use WSL) | the agent runs commands | |
| A Telegram bot token | *optional*, for phone alerts and a daily briefing | free |

The task list works without Claude Code. Only the "Work on it" button needs it.

## Quick start (3 steps)

```bash
git clone https://github.com/JackB2003/ai-task-desk.git
cd ai-task-desk
npm run setup      # a 2-minute guided setup: checks Claude Code, sets your password
npm start          # then open http://localhost:3025
```

`npm run setup` walks you through everything and checks each step. Run `npm run doctor` any time to see what is and is not working.

### Install Claude Code (for the agent)

1. Install it: <https://code.claude.com/docs/en/overview>
2. Run `claude` once in a terminal and log in with your Claude account (or choose the API key option in setup).
3. Run `npm run setup` again. It sends one tiny test request to prove the login works.

**Subscription or API key?** Subscription (default) uses your Claude plan's allowance. API key bills your Anthropic account per use. Pick during setup, or set `AGENT_AUTH=api` and `ANTHROPIC_API_KEY` in `.env`. Agent runs can be long, so check your plan limits or API spend.

## How it works

1. You add tasks and choose **Me** or **Agent** for who does them.
2. Press **Work on it** on an agent task. It queues, then runs (one at a time, 30 minute limit by default).
3. The agent finishes with one of: **done** (the task is checked off), **partly done**, **needs you** (a question), **needs approval**, or **blocked**.
4. You answer, approve, deny, stop, resume, or **undo its file changes**.

```
 browser ──► server.js ──► SQLite (data/desk.db) ◄── worker.js ──► claude -p ... (one run at a time)
                                                         │                │
                                                         │      agent/guard.js checks every tool call
                                                         └──► Telegram (optional)
```

- `server.js`: web page and JSON API
- `worker.js`: runs the agent through the Claude Code CLI and records what happened
- `agent/guard.js`: the rule checker (see below)
- `agent/rulebook.md`: the instructions the agent always follows
- `demo.js`: the scripted, safe version used for the public demo

## The safety rules

Claude Code runs `agent/guard.js` before every tool call. It:

- **Stops and asks you first** for: `git push`, deleting files, sending data out (`curl -d`), email, `ssh`/`rsync`/deploy tools, cloud and payment CLIs, database writes, killing processes, scheduled jobs, reading secrets from the environment, and touching secret files (`.env`, SSH keys, tokens, cloud credentials).
- **Keeps the agent in its workspace.** File reads and writes outside the workspace folder need your approval.
- **Refuses anything that needs root** (`sudo`, system services).
- **Protects the app itself.** The agent cannot edit this app's code, rulebook or database.
- **Backs up every file it edits** so **Undo** works. (Changes made by build tools or scripts are not tracked.)
- **Fails closed.** If the checker itself breaks, the action is denied.
- An approval is for that one action only. Approving `git push origin main` does not approve `git push origin other`.

> **Be honest about the limits.** The agent can run shell commands as *you*. The rule checker catches the common risky patterns, but it is a safety net, not a security boundary. A determined or confused agent could find a way around a pattern list. Run it as a normal user (never root), keep sensitive things out of reach, and consider running it in a container or a separate user account if you give it tasks you do not trust. Read `agent/guard.js`: it is short.

## Telegram alerts (optional)

Set up in `npm run setup`, or later in **Settings**. You need a bot token from [@BotFather](https://t.me/BotFather) (send `/newbot`). Then you get a message when a run needs you or finishes, a warning at 80% and 90% of your Claude plan usage, and an optional morning briefing of what is due.

## Settings

Everything is optional. See `.env.example` for the full list. The common ones:

| Setting | What it does |
| --- | --- |
| `PORT`, `HOST` | where it listens (default `127.0.0.1:3025`, this machine only) |
| `TIMEZONE` | for "due today" and the briefing |
| `AGENT_WORKSPACE` | the folder the agent works in (default `./workspace`) |
| `AGENT_ADD_DIRS` | extra folders the agent may use without asking |
| `AGENT_AUTH` | `subscription` (default) or `api` |
| `USAGE_PING=1` | check plan usage every 15 min (costs a few hundred tokens each time) |

## Putting it on a server

It listens on `127.0.0.1` by default. To reach it from elsewhere, put it behind a reverse proxy with HTTPS (nginx, Caddy) and set `TRUST_PROXY=1`. It has a login (one password, throttled after failed attempts), but **do not expose the agent to the internet without HTTPS and a strong password**. See `deploy/` for example nginx and process-manager configs.

## Run your own public demo

`DEMO=1 npm run web` starts a version that is safe to publish. Every visitor gets a private in-memory copy with sample tasks, and the "agent" is a script that plays out a believable run: finishing, asking a question, asking for approval. No AI is called, no command runs, nothing is written to disk. Uploads, Telegram and passwords are off. Sessions, request rates, tasks and runs are capped, and idle sessions are deleted after 45 minutes. Details in `docs/demo-mode.md`.

## Tests

```bash
npm test
```

Covers the web API (login, setup, tasks, agent runs), the rule checker (every approval rule), and the demo (isolation, limits, scripted runs). They start the real server on scratch ports and never call an AI.

## Project layout

```
server.js  worker.js  start.js  setup.js     the four programs
agentlib.js  attach.js  config.js  db.js  auth.js  demo.js   shared code
agent/     guard.js, rulebook.md, schema.json
public/    the web page (index.html, app.js, style.css)
test/      automated tests
deploy/    example nginx + pm2 configs
docs/      demo mode notes
```

## License

MIT. See `LICENSE`.
