# Security model

What workers can and can't do on an org server, and where each control is.

## The boundaries

| Control | What it does | Where it's set |
|---|---|---|
| **Trust level** | On probation, every step that reaches outside the server (push, post, send, write to another system) waits for the worker's manager. | The worker's page |
| **Permissions policy** | Each tool request a worker run makes gets an automatic answer: `deny` refuses everything, `allow-list` allows only the named tools, `auto-approve` allows everything. The compose file uses `allow-list`. | `overcli serve --permissions` |
| **Narrowed commands** | Shell access is never granted wholesale. Connecting a repo adds only `git switch/add/commit/push`, read-only git, and that repo's test command. Any other shell command is refused. | Automatic, from Setup → Repos |
| **Visibility** | Who may ask a worker: its manager, its team, or everyone. | The worker's settings |
| **Budgets** | Per worker, per person (allowance), and for the whole org. At a limit, scheduled work stops. | The worker's settings, Setup → Rules |
| **Approvers** | Hires over an allowance, and tools that aren't pre-approved, need an approver's yes. | Setup → Rules |

A worker's own limits always win. `--permissions auto-approve` can't grant a worker outside actions its trust level doesn't allow.

## Reading the web

- **Doesn't ask by default.** On an org server, searching the web and opening pages (WebSearch, WebFetch) runs without the manager's approval, because research is most of what workers do. Anything that acts (a push, a post, a write to another system) still asks.
- **Turning it back on:** **Setup → Rules → "Workers ask before reading the web"** (`webNeedsApproval` in `org.json`). Use it when the server's network can reach things a fetched page must not.
- **The desktop app** still asks before workers read the web, as before.

> [!WARNING]
> A page a worker opens can carry instructions meant for the model. A worker that reads a hostile page could be steered into fetching an internal address. On a cloud server that includes the instance metadata endpoint.

> [!TIP]
> Run the server where outbound traffic is limited to what workers need. Use IMDSv2 with a hop limit of 1 on EC2, and keep task-role permissions narrow on Fargate.

## Code

- **Workers run no git.** The model plans, edits files in its worktree and writes the pull request. It has read-only git for planning, and no command that commits, pushes or opens anything.
- **The server pushes,** once the run finishes: it commits each changed worktree and pushes an `overcli/<change>` branch.
- **On probation, nothing is pushed without a yes.** The pull request step waits for the manager's approval.
- **Every push passes the tests.** Each clone has a pre-push hook that refuses pushes to the default branch and runs the repo's test command, holding back a failing push.
- **People open pull requests.** Workers never open, approve or merge one, and never call the git host's API.
- **Every change runs in its own worktree,** separate from the clone's checkout and from other work.
- **Protect the default branch on your git host:** required reviews, no force pushes, no bypass for the bot account. Git can be told to skip hooks, so the host's protection is the real guard.
- **Use a bot account's token,** limited to the repos workers may change.

## Secrets

- **Write-only.** Set on Setup → Secrets by admins and never shown again, not in the console, the API, or Claude. Claude can list them (names and status) but not set them, so values never pass through a chat.
- **Stored** encrypted on the volume, or in AWS or GCP Secret Manager through the server's cloud identity. See [For admins](admins.md#setup--secrets).
- **Git tokens** are read from the server's environment by a credential helper scoped to each clone, and never written into the repo or its config.
- **Restricted names.** Only known names and credential-shaped names (`…_TOKEN`, `…_API_KEY`) can be set, so a console session can't redirect the model, git or Node through the environment.
- **Logged by name.** Every change goes in the decision log by name, never by value.

## People and sign-in

- **Ways in:** a one-time invite link (DMed in Slack), company sign-in (OIDC with PKCE), or the desktop app pairing with a code you confirm in the browser. Scripts use tokens from `overcli tokens create`.
- **Tokens are hashed** on the server, so a token is shown once and can't be recovered. Each sign-in can be revoked on its own, and signing out revokes it on the server.
- **Admin links expire.** The first-admin link works once and for a day.
- **Behind a proxy,** set `OVERCLI_TRUST_PROXY=1` so rate limits see each person, not the proxy. Without it, forwarded headers are ignored.

## Slack

- **Answers come only from the current manager.** Only a worker's current manager can answer its questions or approve its steps; buttons pressed by anyone else are ignored.
- **Personal installs answer only their owner.** On a desktop app, the Slack front door takes requests only from the person whose member ID is set in its settings.
- **One workspace.** The server refuses Slack tokens from any workspace but the one in `org.json`.

## Network

- **The server makes outbound connections only:** Slack (Socket Mode), the model provider, your git host, and the tools you install. It needs no public address.
- **People reach the console and MCP** over your VPN or an internal load balancer with HTTPS. The desktop app and CLI insist on https for anything but `localhost`.
- **Webhooks** need the server reachable from the sender. Watches don't, so prefer them inside a private network.

## What it isn't

- **Not a sandbox.** A worker's run executes with the server process's privileges, within the tools it's allowed. Run the container as the unprivileged user it ships with, on a network that can reach only what workers need.
- **Not a substitute for review.** It's built to put a person at each point that matters: approving outside actions, opening the pull request, rating the result.
