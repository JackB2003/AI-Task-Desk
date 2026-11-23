# Security

## Reporting a vulnerability

Please report security problems privately, not in a public issue. Use GitHub's **"Report a vulnerability"** button on the Security tab of this repository. Include what you found, how to reproduce it, and what you think the impact is.

You can expect a reply within a few days.

## What to know before you run it

AI Task Desk lets an AI agent run commands on your computer, as you. The rule checker (`agent/guard.js`) asks for your approval before the common risky actions, keeps file access inside a workspace folder, and fails closed. It is a **safety net, not a sandbox**: a pattern list cannot catch everything.

- Run it as a normal user, never as root.
- Keep it on `127.0.0.1` (the default) unless you put it behind HTTPS and set a strong password.
- Run it in a container or a separate user account if you give the agent tasks you do not fully trust.
- Your Anthropic API key (if you use one) is stored in the `.env` file, readable only by you. Never commit that file. It is already in `.gitignore`.

## What counts as a vulnerability

Examples we want to hear about: a way for the agent to skip an approval, read or write outside the workspace without asking, edit the app's own files, or read secrets; a way to log in without the password; anything that lets one visitor of the public demo see another's data, run a command, or call an AI.
