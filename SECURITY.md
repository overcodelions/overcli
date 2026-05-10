# Security Policy

## Reporting a vulnerability

**Please do not open a public GitHub issue for security bugs.**

Email **security@codelionsllc.com** with:

- A description of the issue and the impact
- Steps to reproduce, or a proof-of-concept
- Affected version (Help → About, or `package.json`)
- Your platform and which backend(s) are involved, if relevant

You can also use [GitHub's private vulnerability reporting](https://github.com/overcodelions/overcli/security/advisories/new).

We'll acknowledge the report within a few days, work with you on a fix, and credit you in the release notes unless you'd prefer otherwise.

## Scope

Overcli is a desktop GUI that wraps third-party CLIs (`claude`, `codex`, `gemini`, `ollama`). In-scope issues include:

- Local privilege escalation, sandbox escape, or arbitrary code execution via Overcli itself
- Mishandling of credentials, tokens, or other secrets that Overcli reads or writes
- IPC contract abuse (renderer → main) that bypasses approval/permission UI
- Vulnerabilities in Overcli's dependencies that affect the shipped app

Out of scope:

- Bugs in the upstream CLIs (`claude`, `codex`, `gemini`, `ollama`) themselves — please report those upstream
- Issues that require an attacker to already have code execution on the user's machine
- Self-inflicted misconfiguration (e.g. running with elevated privileges and approving a destructive command)
