# Security model

What workers can and can't do on an org server, and where each control is.

## The boundaries

| Control | What it does | Where it's set |
|---|---|---|
| **Trust level** | On probation, every step that reaches outside the server (push, post, send, write to another system) waits for the worker's manager. | The worker's page |
| **Permissions policy** | Each tool request a worker run makes gets an automatic answer: `deny` refuses everything, `allow-list` allows only the named tools, `auto-approve` allows everything. The compose file uses `allow-list`. | `overcli serve --permissions` |
| **Access level** | Under `allow-list`, an admin picks what workers may do: read only, standard (edit files), shell for listed commands, or everything. It can never go past `--max-access`, which whoever runs the server sets. Until a level is saved, workers get what `--allow-tool` lists. | Setup → Permissions |
| **Narrowed commands** | Shell access is never granted wholesale. Connecting a repo adds only `git switch/add/commit/push`, read-only git, and that repo's test command. Any other shell command is refused. | Automatic, from Setup → Repos |
| **Visibility** | Who may ask a worker: its manager, its team, or everyone. | The worker's settings |
| **Budgets** | Per worker, per person (allowance), and for the whole org. At a limit, scheduled work stops. | The worker’s settings, Setup → Hiring and Spending |
| **Approvers** | Hires over an allowance, and tools that aren’t pre-approved, need an approver’s yes. | Setup → Hiring |

A worker's own limits always win. `--permissions auto-approve` can't grant a worker outside actions its trust level doesn't allow.

**Exceptions a manager or admin makes,** all on the worker's Access tab and recorded in its history:

- **Always allow** on an approval lets that one step of that flow run without asking from then on. A manager can take it off at any time.
- **Run straight through its flows' checkpoints** skips the pauses a flow's author wrote in (`pause_before`). Only an admin can switch it on. Outside actions still ask, as the trust level says.

**What never asks:** a step whose tools only read, and read-only commands on the worker's own folders (`git log`, `git show`, `git blame`, `git grep`, `git shortlog`, `rg`, `grep`, also after a `cd` into the repo). The step's instructions mentioning a write doesn't change that; what decides is what its tools can do. A tool result too big to hand the model inline is saved to a file, and plain reads of it (`cat`, `head`, `wc`) are allowed too.

**A refusal says it's the rules.** A tool call the server refuses is told it was refused by the server's rules, not by a person, and to carry on with the tools it has. Setup → Permissions lists what was refused in the last week, by worker.

**Listed commands are matched whole.** At the shell level, a command runs only when every part of the line starts with one you listed. A line that chains another command, substitutes one (`$(…)`), or redirects into a file is refused. Don't list anything that can run arbitrary code (`python`, `node`, `bash`, `curl`).

## Reading the web

Reading the web isn't the risk; the address is. A worker that has read a ticket could put it in a web address (`https://example.com/?q=<the ticket>`), and opening that page hands it to whoever runs the site. So on an org server, **Setup → Hiring → Opening web pages** (`webFetch` in `org.json`) has three settings:

- **Safe fetches** (the default): searching never asks. A worker opens a page without asking only when the address came from the request, a search result, or a page it already read. An address it wrote itself is refused, and it's told to search for it first.
- **Ask before a step that opens pages:** the manager approves first.
- **Any page, without asking.**

Whatever the setting:

- **The server's own addresses are never opened:** `localhost`, loopback, link-local (where cloud metadata lives) and the metadata names.
- **Private addresses** (`10.…`, `192.168.…`, names ending `.internal` or `.local`, a bare host name) are refused, unless an admin lists the site under **Your own sites (always open)** (`ownDomains`). Sites listed there are always open.
- **Workers set to act on their own** fetch freely.
- **Anything that acts** (a push, a post, a write to another system) still asks, as its trust says.
- **The desktop app** still asks before workers read the web, as before.

> [!WARNING]
> A page a worker opens can carry instructions meant for the model. Safe fetches don't check where a public name resolves to, so a public name that points at a private address isn't caught. Keep the server's network narrow too.

> [!TIP]
> Run the server where outbound traffic is limited to what workers need. Use IMDSv2 with a hop limit of 1 on EC2, and keep task-role permissions narrow on Fargate.

## Code

- **Workers run no git.** The model plans, edits files in its worktree and writes the pull request. It has read-only git for planning, and no command that commits, pushes or opens anything.
- **The server pushes,** once the run finishes: it commits each changed worktree and pushes an `overcli/<change>` branch.
- **On probation, nothing is pushed without a yes.** The pull request step waits for the manager's approval.
- **Every push passes the tests.** Each clone has a pre-push hook that refuses pushes to the default branch. The server runs the repo's test command before it pushes, without secrets in its environment, and holds back a failing push. It won't run tests as its own user, which can read its secrets: until an operator names a separate user (`OVERCLI_TEST_UID`) or accepts the risk (`OVERCLI_TEST_AS_SERVER=1`), a repo with a test command pushes nothing.
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
- **Redacted from answers.** With **Secrets in answers** on (the default), credentials are replaced with `[REDACTED]` in everything a worker says to people: Slack messages and files attached to threads, answers in the console and over MCP, and webhook notifications. It catches known formats (AWS keys, GitHub, Slack and Stripe tokens, private keys, JWTs, bearer tokens, `password=` lines) and the exact value of every stored secret, whatever its name. It's a safety net, not a guarantee: anything encoded or split across lines can get through, and run logs on the server are not changed.
- **Tools' credentials stay in the server.** A remote tool's address and token (pasted, or from Sign in for everyone), overdb passwords, and the env, args and headers of every tool on a worker's allowlist stay in app-owned transports. The run's temporary config names each such tool as a relay descriptor only; the one thing it names as it is, is a plain remote address with no headers and no token in it (no user and password, no query string, no token-like path segment). A tool the relay starts runs in the run's folder and, when the run is write-jailed, inside the same jail, so a run cannot get a tool run free by redefining it in its own `.mcp.json`; that file is also kept from a jailed run's writes. Each helper gets a revocable per-run token in its environment, and the relay checks that token, starts or connects to the real tool with its credentials, and forwards calls, with the server's own secrets stripped from any tool it starts. Scope and logging are not the relay's: the tool gateway applies each worker's scope and records its calls, and overdb keeps its own query log. This does not isolate processes sharing the server OS user: a shell-capable worker remains inside that same OS security boundary (see below). It's on in the Docker image (`OVERCLI_TOOL_GATEWAY=1`); turning it off puts gateway tools back as they were on the next start.
- **Credential files are kept from Claude's file tools.** Claude's Read and Edit tools are denied the CLIs' config, their sign-ins, git and ssh credentials, other processes' environments, and the server's own state (people's tokens, the audit log, sealed secrets and keys), in every permission mode.
- **That is not a sandbox.** The deny rules don't reach shell commands, and Codex and Gemini workers get none. On Linux and in Docker there is no OS sandbox yet, and workers run as the server's user, so a worker that runs shell commands can read those files and the server's environment, including the gateway's key file (`org/tool-gateway.key`) and the tool tokens it seals. Until workers run as a separate user, treat the server's volume, environment and every connected tool's token as readable by any worker that runs shell commands, and give each worker only the repos, tools and trust level it needs.

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
