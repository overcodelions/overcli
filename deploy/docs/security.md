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
- **Customer data isn't kept.** Tools ticked under Setup → **Data protection** → *Tools that may return customer data* make every worker that holds them ephemeral. Its transcripts, runs, work log, journal and files are purged once its conversation ends, but a content-free action record of each run (tools called and counts, outcome, cost) stays in the decision log, and personal data (emails, card numbers, phone numbers) is scrubbed from what it posts. See [Admins](admins.md#setup--data-protection).
- **Redacted from answers.** With **Secrets in answers** on (the default; Setup → Data protection), credentials are replaced with `[REDACTED]` in everything a worker says to people: Slack messages and files attached to threads, answers in the console and over MCP, and webhook notifications. It catches known formats (AWS keys, GitHub, Slack and Stripe tokens, private keys, JWTs, bearer tokens, `password=` lines) and the exact value of every stored secret, whatever its name. It's a safety net, not a guarantee: anything encoded or split across lines can get through, and run logs on the server are not changed.
- **Tools' credentials stay in the server.** A remote tool's address and token (pasted, or from Sign in for everyone), overdb passwords, and the env, args and headers of every tool on a worker's allowlist stay in app-owned transports. The run's temporary config names each such tool as a relay descriptor only; the one thing it names as it is, is a plain remote address with no headers and no token in it (no user and password, no query string, no token-like path segment). A tool the relay starts runs in the run's folder and, when the run is write-jailed, inside the same jail, so a run cannot get a tool run free by redefining it in its own `.mcp.json`; that file is also kept from a jailed run's writes. Each helper gets a revocable per-run token in its environment, and the relay checks that token, starts or connects to the real tool with its credentials, and forwards calls, with the server's own secrets stripped from any tool it starts. Scope and logging are not the relay's: the tool gateway applies each worker's scope and records its calls, and overdb keeps its own query log. This does not isolate processes sharing the server OS user: a shell-capable worker remains inside that same OS security boundary (see below). It's on in the Docker image (`OVERCLI_TOOL_GATEWAY=1`); turning it off puts gateway tools back as they were on the next start.
- **Command tools' settings are sealed too.** With the gateway on, a command (stdio) tool's environment, where its token usually is, is kept sealed in the server (`org/tool-env.json`), not in `~/.claude.json`, and taken out of that file's backups. The server starts each such tool itself, for every run, and the worker's CLI reaches it through the relay. Setup → Tools reads and changes them as before. Turning the gateway off puts them back in the file on the next start. Codex keeps its own copy in `~/.codex/config.toml`, which this doesn't cover.
- **Credential files are kept from Claude's file tools.** Claude's Read and Edit tools are denied the CLIs' config, their sign-ins, git and ssh credentials, other processes' environments, and the server's own state (people's tokens, the audit log, sealed secrets and keys), in every permission mode.
- **That is not a sandbox.** The deny rules don't reach shell commands, and Codex and Gemini workers get none. Unless workers run as a user of their own (below; on in the compose file), they run as the server's user, so a worker that runs shell commands can read those files and the server's environment, including the gateway's key file (`org/tool-gateway.key`) and the tool tokens it seals. Run workers as a user of their own (below) to close that. Until you do, treat the server's volume, environment and every connected tool's token as readable by any worker that runs shell commands, and give each worker only the repos, tools and trust level it needs.

## Workers as a user of their own

It's on in `deploy/docker-compose.yml`. Elsewhere (plain `docker run`, Kubernetes), set `OVERCLI_WORKER_UID=1001` and start the container as root. The server still runs as `node`; every worker's CLI, and every command it runs, runs as user 1001 with no capabilities and no way to gain any. Then:

- **A worker can't read the server's secrets:** the secrets key and store, the tool gateway's key and vault, connections, people's tokens, `org.json`, or the server's environment. It can still use the tools it's scoped to, through the gateway, with a key that only works for its own run.
- **What workers share with the server stays where it was:** HOME (the CLIs' config, sign-ins and transcripts, worktrees, attachments), the repo clones, the default project, the workspace and coordinator folders runs work in, each worker's own folder, team tasks' files and run attachments. Those are opened to the worker's group; ssh keys, git and gh credentials in HOME are not. The rest of the volume a worker can read, as before, but not change.
- **The server checks at start, and again once it's running.** As the worker user, it tries to read each secret file and the server's environment, to write the shared folders, and to run `claude`. If any of that comes out wrong, the server doesn't start, and says which. A minute after start, and every six hours, it tries the secret files again (on a new volume most don't exist at the first check); if a worker can read one, the server stops. Set `OVERCLI_WORKER_UID=` (empty) in `.env` to go back to running workers as the server; the server then warns at every start that workers can read its secrets.
- **The server keeps four capabilities, and nothing it starts gets them:** setuid and setgid, to launch workers; dac_override, to read and tidy what their CLIs write owner-only (transcripts, `~/.claude.json`); and kill, to stop a worker's process, which runs as another user (a stopped run, a relaunch with new settings, a test that runs over). Without kill the server won't start with workers as their own user. The entrypoint has to hand them over as ambient capabilities, which every child would inherit, so the server starts every other process (git, relayed tools, Services processes, repo tests) through `setpriv`, which clears them and sets no_new_privs first. It won't start holding them if `setpriv` is missing. Repo tests (`OVERCLI_TEST_UID`) switch user the same way as workers.
- **Workers can't make the server's git run their commands.** The repos, worktrees and HOME are shared, so a worker can write git config that names a command (`core.fsmonitor`, a diff or filter driver, a hook, a credential helper). The server's own git in those folders runs as the worker, so whatever that config runs, runs as the worker; the repo's filters, LFS and hooks behave as they always have. Pushes, fetches and clones need the server's token, so they run as the server with fsmonitor, hooks, askpass and every configured credential helper switched off on the command line, and the server's own helper for each connected repo's host put back; `ext::` and `git://` remotes are refused. `core.sshCommand` in git config isn't used for them: set `GIT_SSH_COMMAND` in the server's environment if a host needs one.
- **Workers can't choose what the server starts.** They can write `~/.claude.json`, and a repo can bring its own `.mcp.json`, so the server pins each command tool's command, args and folder whenever it saves the tool (Setup → Tools), and the relay starts only that, with its sealed settings, whatever the file or a repo now says under its name. A command tool the server never saved is left to the worker's CLI, which starts it as the worker. Relayed tools start in a folder and HOME of the server's own (`tool-home` in the data dir), never the run's folder or the shared HOME, where a planted `.npmrc` or `node_modules` could steer them. A change made to `~/.claude.json` by hand (a rotated token, a new argument) is ignored and logged at start: make it in Setup → Tools instead (a tool's Edit, or Replace on one of its keys). Command tools are sealed this way whenever workers run as their own user, even with the gateway off; with the gateway off, remote tools' tokens go back in `~/.claude.json`, and the server warns that workers can read them.

What it doesn't cover yet:

- **The model's credentials.** A worker's CLI needs them, so it can read them: `ANTHROPIC_API_KEY`, `AWS_BEARER_TOKEN_BEDROCK` or a `claude login` sign-in, `OPENAI_API_KEY`.
- **Anything else in the shared HOME,** such as `~/.codex/config.toml` when Codex is installed, or a tool's own config that a tool added by hand reads (see below). On Docker Desktop for Mac, a bind-mounted folder is readable whatever its owner and mode, so don't bind-mount `/data` itself from a Mac: the start check finds the secrets readable and the server stops. Use the named volume.

**A tool's own credential files go in `/data/tool-home`, not HOME.** A tool saved in Setup → Tools starts with `HOME=/data/tool-home`, a folder only the server can read, so that's where it looks for `~/.aws`, `~/.kube` or `~/.config/gcloud`. Mount them there, for example `~/.aws-overcli:/data/tool-home/.aws:ro` in a compose override. Workers can't read them there, and still reach the tool through the relay. A folder mounted into `/data/home` instead is never seen by a saved tool: the tool fails as if the file were missing (for the CloudWatch tool, "the config profile … could not be found"). A tool added by hand and never saved in Setup → Tools still starts as the worker, with the shared HOME. A saved tool's profile is used only when its settings name it (`AWS_PROFILE` in the tool's environment); otherwise it gets the worker's role, below.
- **The cloud identity on Compute Engine.** A worker can still ask the metadata server for the instance's service account. On AWS, see below.
- **Fargate and GKE.** Fargate can't give the server those capabilities, and a pod under the `restricted` policy can't start as root, so workers run as the server there.

## Workers' AWS access

Workers never use the role the server is hosted with (the EC2 instance role or the ECS task role). That role reads the org's secrets; a worker gets a role of its own.

- **A role per worker.** Set `OVERGO_AWSWORKER_ROLE` on Setup → Secrets to an IAM role ARN: every worker uses it. Add more as `OVERGO_AWSWORKER_ROLE_<NAME>` (`_QA`, `_DEVOPS`) and set a worker to that name on its Access tab, so QA reads logs and DevOps reads the whole account. Only an admin sets a worker's role. With no role set, a worker has no AWS access at all. The role must trust the server's role, and should be read-only.
- **How it's handed out.** The server assumes the worker's role for each run and serves the credentials on loopback, through the container credentials endpoint the AWS CLI and SDKs already use, behind a token that names the run. A request is judged when it arrives, so a worker moved to another role, or retired, gets the change on its next call. Sessions last an hour and renew on their own. The session is named after the worker (`overgo-<name>`), so CloudTrail says which worker made each call.
- **The server's role is refused.** A setting that names the role the server runs as is never handed out, whatever it says.
- **The server's identity is taken out of a worker's environment:** its keys, profile, web identity and container credentials variables. The SDKs are told not to ask the metadata service, and `~/.aws/config` and `~/.aws/credentials` are swapped for an empty file, so no profile on the box leads back to the server's role. Claude's file tools can't read `~/.aws`.
- **Saved tools get the worker's role too.** A tool saved in Setup → Tools runs as the server, through the relay. For a worker's run it gets that worker's role, unless its own settings name the credentials it uses (`AWS_PROFILE`, keys or a role ARN): an admin chose those. The overdb and test-systems tools act for the server and keep its role.
- **The model goes through the server.** Claude on Bedrock sends its calls to a gateway on loopback in the server, which signs them with the server's role and forwards model calls only (`ANTHROPIC_BEDROCK_BASE_URL`). A worker's role needs no Bedrock access, and the server's role is used for nothing else on a worker's behalf.
- **A fence at the host.** The environment settings above only steer the SDKs, and a worker could unset them. The one-click stack also rejects the worker user's packets to the metadata service at the host's firewall (`overcli-worker-fence`), and the server won't start without that rule. It keys on the worker's user id, so it needs workers running as a user of their own (above). On your own EC2 host, add the same rule: `iptables -I OUTPUT -d 169.254.169.254 -m owner --uid-owner 1001 -j REJECT`. Fargate has no metadata service to fence, but its task role's credentials endpoint is reachable from inside the task: keep the task role small there.
- **Workers share one user.** Every worker runs as the same user (1001), so one worker could read another's process environment, its credentials token included, and borrow that worker's role. Per-worker roles keep each worker to its job; they are not a wall between workers that set out to get round them. Give no worker a role you wouldn't accept any worker using.
- **Turning it off.** `OVERCLI_WORKER_CLOUD=host` in the server's environment goes back to workers using the server's role, and the server warns at every start. Don't, outside a laptop trial.

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
- **Workers message people through the server.** The built-in notify call is answered inside the server, which sends the Slack message itself and records it; workers never hold the bot's token, and a run sends at most five.
- **Apps to test** keep their test accounts sealed with the tools' secrets. The server signs in itself; workers get a signed-in browser without the tools that read cookies, storage or request headers, or run code in the page, and credentials are only sent to the app's own address or its feature environments' pattern. Use test accounts with the least access, on non-production environments.
- **Metrics,** when turned on, are served on a port of their own and show worker names and spend. Keep that port reachable only from your monitoring, and set `OVERCLI_METRICS_TOKEN` to require a bearer token where the network isn't one team's.
- **Webhooks** need the server reachable from the sender. Watches don't, so prefer them inside a private network.

## What it isn't

- **Not a sandbox.** Unless workers run as a user of their own, a worker's run executes with the server process's privileges, within the tools it's allowed. Even then it can use the network and the model's credentials. Run the server on a network that can reach only what workers need.
- **Not a substitute for review.** It's built to put a person at each point that matters: approving outside actions, opening the pull request, rating the result.
