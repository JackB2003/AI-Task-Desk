# Contributing

Thanks for wanting to help. This is a small project with a deliberately small footprint, so a few ground rules keep it that way.

## Ground rules

- **No npm dependencies.** Plain Node.js (22.13+) and vanilla JavaScript. If something seems to need a package, open an issue first.
- **Safety first.** Anything that changes what the agent is allowed to do (`agent/guard.js`, `agent/rulebook.md`) needs a test in `test/guard.test.js` that shows the new behaviour.
- **Keep the demo safe.** Demo mode (`demo.js`) must never run a command, call an AI, or write to disk.
- **Plain language in the interface.** The people using this are not always developers.

## Set up

```bash
git clone https://github.com/JackB2003/ai-task-desk.git
cd ai-task-desk
npm test            # no install step, nothing to build
npm run demo        # try the page at http://localhost:3025 with fake data and no AI needed
```

The tests start the real server on scratch ports and use a fake `claude` program, so they never call an AI or cost anything.

## Sending a change

1. Open an issue first for anything bigger than a small fix, so we can agree on the approach.
2. Keep the change focused. One idea per pull request.
3. Add or update tests, and make sure `npm test` passes.
4. Describe what changed and why in the pull request. A screenshot helps for anything visual.

## Reporting a security problem

Please do not open a public issue. See [SECURITY.md](SECURITY.md).
