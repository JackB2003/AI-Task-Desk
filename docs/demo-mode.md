# Demo mode

`DEMO=1 node server.js` runs a version built to be public. This page explains what it does and does not do, so you can judge it before you publish one.

## What visitors get

- A full copy of the app with six sample tasks, no sign-up.
- Real behaviour, fake agent: pressing **Work on it** plays a scripted run. Depending on the task wording it **finishes**, **asks a question**, or **asks for approval** (approve and deny both work). The run log, file-change list and **Undo** all work, on fake data.
- A **Reset demo** button and a link to the code.

## What is switched off

- The real worker and Claude Code. `worker.js` exits immediately in demo mode.
- File uploads, Telegram, password and first-run setup (they return 403).
- Anything touching disk: every visitor's data is an in-memory SQLite database.

## Safety limits (all configurable by environment variable)

| Limit | Default | Setting |
| --- | --- | --- |
| Visitors at once | 200 | `DEMO_MAX_SESSIONS` |
| Idle time before a visitor's data is deleted | 45 minutes | `DEMO_IDLE_MIN` |
| API calls per IP per minute | 240 | `DEMO_RATE_PER_MIN` |
| New visitors per IP per hour | 30 | `DEMO_NEW_SESSIONS_PER_HOUR` |
| Tasks per visitor | 40 | fixed in `demo.js` |
| Simulated agent runs per visit | 12 | fixed in `demo.js` |
| Speed of the simulated agent (ms per step) | 1100 | `DEMO_STEP_MS` |

When the visitor cap is full and nobody has been idle for two minutes, new visitors see a friendly "busy" message instead of the server running out of memory.

## Hosting it

Run `DEMO=1 PORT=3025 node server.js` under a process manager and put it behind HTTPS. Set `TRUST_PROXY=1` so rate limits use the visitor's real address, and `COOKIE_PATH` if it lives under a sub-path. Example configs are in `deploy/`.

## How the simulation works

`demo.js` holds three scripted scenarios (`research`, `question`, `approval`). A task is matched to one by its words (for example "publish" or "send" picks the approval scenario). Each scenario is a list of segments: some "tool" steps that appear in the run log one at a time, then an ending (done, needs input, needs approval, blocked). It writes the same database rows the real worker writes, so the page behaves identically.
