# Running overcli for an org (alpha)

> **Alpha.** Org workers are early. Expect rough edges and changes between versions, and back up `/data`. In the desktop app, they're switched on under Settings → Labs → Org workers.

**The docs:** [deploy/docs](docs/README.md) covers everyone, from people asking workers for things to managers and admins. They're also served by every org server at `/docs`. This page is the operator's guide to the container.

**On AWS or Google Cloud:** see [aws.md](aws.md) and [gcp.md](gcp.md). Those guides keep `/data` on a durable disk with snapshots, use Bedrock or Vertex with no API key on the box, and put HTTPS in front from inside your VPC.

One container runs `overcli serve`. It holds the org's workers and teams, the Slack bridge, and the **control plane**: the web console and the MCP server people use to manage workers without the desktop app.

```
              ┌──────────────── container / VM ────────────────┐
  Slack ◄───► │ overcli serve                                  │
  (outbound   │  ├─ workers, teams, schedules                  │
   Socket     │  ├─ Slack: questions, approvals, /worker,      │
   Mode)      │  │    /team, /hire                              │
              │  ├─ control plane :7420                         │
  Claude ───► │  │    /mcp   MCP for Claude Code, Desktop, Codex│
  browser ──► │  │    /      web console                       │
  overcli ───►│  │    /api   publishing workers from the app    │
              │  └─ /data: workers, journals, org.json, tokens  │
              └────────────────────────────────────────────────┘
```

Every way in goes through one set of rules (`org.json`):

| Who | Where | What |
|---|---|---|
| Everyone | Console → **Today** | What needs them, what their workers delivered, spend |
| Managers | Slack | Workers' questions and approvals as DMs; `/worker`, `/team`, `/hire` |
| Anyone with Claude or Codex | MCP | "What's waiting on me?", "hire me a competitive analyst", "rate that report" |
| People who build workers | overcli app, `overcli workers push` | Publish a worker they built locally to the org |
| Admins | Console → **Admin** | Health, people, spend, the rules, the decision log |
| Operators | `docker exec … overcli` | `org`, `tokens`, `projects` |

## 1. Get the image and configure

```sh
cp deploy/.env.example deploy/.env
docker compose -f deploy/docker-compose.yml pull
```

Each release publishes one image, the same for every org: `ghcr.io/overcodelions/overcli-server`, for Intel and ARM, with Claude Code and Codex inside. Nothing about your org is in it; that all lives on the `/data` volume. Tags: the exact version (`0.22.0`), the minor version (`0.22`, which takes fixes), and `latest`. Pick one with `OVERCLI_VERSION` in `.env`.

Each image is signed (keyless, by this repo's release workflow) and carries an SBOM and build provenance. Check one before you run it, or before you mirror it into your own registry:

```sh
cosign verify ghcr.io/overcodelions/overcli-server:0.22 \
  --certificate-identity-regexp 'https://github.com/overcodelions/overcli/.github/workflows/release.yml@.*' \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com
```

To build it yourself instead (to change the code, say): `docker build -f deploy/Dockerfile -t overcli-org .` (add `--build-arg INSTALL_CODEX=1` for Codex), and point `image:` in `docker-compose.yml` at `overcli-org`.

In `deploy/.env`:

- **The model.** Workers run through the Claude Code CLI inside the container. Give it `ANTHROPIC_API_KEY`, or Bedrock (`CLAUDE_CODE_USE_BEDROCK=1` and AWS credentials, ideally from the instance role), or Vertex. For Codex, set `OPENAI_API_KEY`: the published image has it. The console's Admin page shows which models are signed in.
- **Slack** (optional). Create an app from `src/main/slack/slack-app-manifest.yml` and put its bot token (`xoxb-`) and app-level token (`xapp-`, scope `connections:write`) in `.env`.

## 2. Start it

```sh
docker compose -f deploy/docker-compose.yml up -d
docker compose -f deploy/docker-compose.yml logs -f
```

On first start it creates a **Workers** folder on the volume as the default place for workers to work, so hiring works straight away.

## 3. Say who the org is

```sh
docker compose -f deploy/docker-compose.yml exec overcli overcli org init --name "Acme" --admin U012AB3CD --slack-team T012AB3CD \
  --url https://overcli.acme.internal:7420 --timezone America/New_York
docker compose -f deploy/docker-compose.yml exec overcli overcli org show
```

This writes `/data/org.json`. It names the org (in the console, Slack and MCP), pins the Slack workspace (the bridge refuses a token from any other), and holds the rules. After the first admin signs in, change the rules from the console (**Admin → Change the rules**) or from Claude (`set_org_rules`); each change is checked and written to the decision log. Editing the file by hand works too, and applies without a restart. `deploy/org.example.json` has every field:

| Field | Meaning |
|---|---|
| `name`, `slackTeamId`, `timezone` | Who the org is |
| `publicUrl` | The address people use; links sent from Slack point here |
| `openJoin` | Let anyone in your Slack in with `/overcli join`, without an admin |
| `admins` | Slack member IDs who can do anything |
| `hirers` | `"*"`, or the list of people who may hire |
| `budgetAllowanceUSD`, `allowances` | What one person's workers may cost per month before a hire needs an approver; per-person overrides |
| `approvers` | Who decides hires over an allowance (default: the admins) |
| `teams` | Groups of people, for "its team may ask it" |
| `allowedMcpServers` | Connectors any hire gets without approval |
| `orgVisibilityNeedsAdmin` | Whether "everyone may ask it" needs an admin |
| `roles` | The approved role catalog on the Hire page: a job, its tools (cleared for that role), and a budget |
| `orgBudgetUSD` | What every worker together may cost a month. At the cap, scheduled runs stop until the month turns |
| `alertAtPercent` | Warn a worker's manager (and the admins, for the org cap) at this share of a budget. Default 80; 0 turns it off |
| `retentionDays` | Keep the decision log and finished runs this long (7 or more). Absent: forever |
| `sso` | Company sign-in: `issuer`, `clientId`, `allowedDomains`, `required` (see below) |
| `people` | Work email → Slack member ID, for anyone company sign-in can't match through Slack |
| `fleet` | The company's other overcli servers, watched from Admin |

A new `org.json` starts narrow: only admins hire, until you change `hirers`.

## Tools (MCP servers)

Workers on the server can use only the MCP servers installed **on the server**. They don't get the ones on someone's desktop. A worker lists its tools by name, and gets one when a server tool has the same name.

- **Console:** **Tools** (admins). Install a command-based server (`npx …`, `uvx …`, with its settings and secrets) or a remote one (URL and headers). **Check them** starts Claude once on the server and shows which connect.
  - **Workers are missing these** lists every tool a worker names that isn't installed.
  - A worker published from the desktop brings its tools' setup with it, minus every secret, so installing one is mostly filling in the keys.
- **From a terminal:**
  ```sh
  docker compose -f deploy/docker-compose.yml exec overcli claude mcp add --scope user jira -e JIRA_API_TOKEN=… -- npx -y <package>
  ```
- **What doesn't work:** connectors that sign in through a browser, such as claude.ai connectors or OAuth pop-ups. A server has nobody to click "Allow". Use servers that take an API token or a service account.

Tools are kept in `/data/home/.claude.json` (and `.codex/config.toml`), so they survive restarts and upgrades.

## 4. Give it work to do

Workers doing research and writing can use the default **Workers** folder. Workers doing code need a repo.

### Code: repos and branches

Workers change code by pushing a branch. The reply hands back the link to open a pull request from it, and a person opens the PR. GitHub, Bitbucket Cloud and any other git host work.

1. **Give the server a way to push.** Over https, add a token for a bot account on **Setup → Secrets** (or right on the Repos page). No restart is needed:
   - **GitHub:** `GH_TOKEN`, a fine-grained or GitHub App token with contents read and write.
   - **Bitbucket Cloud:** `BITBUCKET_TOKEN`, a repository or workspace access token with read and write.
   - **Any other host** (Bitbucket Data Center, GitLab, …): `GIT_TOKEN` and `GIT_USER`.

   Or use the repo's `git@` address with an ssh key mounted in `/data/home/.ssh`. The key needs write access; Bitbucket's per-repo access keys are read-only.
2. **Connect the repo** on **Setup → Repos**: its address, and the test command to run before every push (`npm test`). Or from Claude: `connect_repo`. The server clones it into `/data/repos/<name>` and registers it as a project.
3. **Point a worker at it.** On the same page, pick a worker and press **Let it change this repo**. Or from Claude: `let_worker_change_repo`. The worker now works in that repo, with a flow that plans the change, makes it, and writes the pull request.
4. **When the run finishes,** the server commits the change and pushes `overcli/<change>`. The clone's pre-push hook runs the repo's tests first, and a failing push is held back. The reply carries the link to open the pull request (GitHub's compare page, Bitbucket's new pull request page, or the link git printed for other hosts).

**Workspaces** group repos that change together, like an API and the app that uses it. Make one on **Setup → Repos → Make a workspace**, or from Claude with `create_workspace`. Give it instructions every run reads ("the API owns prices…"), then point a worker or a team at it.

- **Each run gets its own worktree of every repo,** side by side.
- **The worker plans across them** and changes the repos the request needs.
- **The server pushes one branch per changed repo,** each past that repo's tests, and the reply has one pull request link per repo.
- **Teams:** set **Works in** to the workspace when making the team. A finished team task's code gets **Push the branches** on its card (or `push_team_code`), which pushes each repo's branch past its tests the same way.

What keeps it reviewable:

- **The token stays in the secrets store.** Git reads it from the server's environment through a credential helper set on that clone only. It's never written into the repo or its config.
- **No pushes to the default branch.** The clone refuses them with a pre-push hook. Protect the branch on the host too: required reviews, no force pushes. That's the real guard, since git can be told to skip hooks.
- **Pushing waits for a yes.** The pull request step counts as external, so a worker on probation waits for its manager's yes in Slack. Nothing is pushed without it.
- **Workers run no git.** The model plans, edits files and writes the pull request. The server commits and pushes, one command per repo, the same way every time. Connecting a repo grants only read-only git for planning.
- **Tests guard every push, when you turn them on.** The repo's test command runs before the push, and a failing push is held back with the output. By default the server refuses to run it, because its own user can read its secrets, **and a repo with a test command then pushes nothing**: the run says "repo tests are turned off on this server", and the Repos tab warns on that repo. Repos with no test command push as usual. Set `OVERCLI_TEST_UID`/`OVERCLI_TEST_GID` to the numeric id of a user that cannot read `/data` (the server must be able to switch user), or `OVERCLI_TEST_AS_SERVER=1` to accept running tests as the server. See `deploy/.env.example`.

Plain folders, with no remote to push to, still work the old way:

```sh
docker compose -f deploy/docker-compose.yml exec overcli overcli projects add /data/repos/app --name App
```

### Asking from Slack

Anyone in your Slack can ask, with no names to learn:

- **`@overcli add an export button to the reports page`** in any channel the app is in, or the same in a DM to the app.
- **Who takes it:** a request that starts with a worker's name goes to that worker. Otherwise the server matches the request against each worker's job, and asks a model when the words alone don't decide it. When nobody fits clearly, it replies with a short list of names to pick from.
- **What comes with it:** a request made inside a thread brings the thread along, and screenshots in it are attached for the worker to see.
- **What comes back, all in the thread:**
  - who took it, then the worker's answer;
  - for a long answer, a summary in the message with the full text attached;
  - when the answer was to start work, the results once it ends: the link to open a pull request from the pushed branch, the report attached, any files it made, and a link to the Library.
- **Follow-ups:** reply in the thread ("and make it blue") to give the same worker more.
- **Who can ask what:** a person can ask any worker they're allowed to see (its "who may ask it" setting). Approvals still go to each worker's manager.

The Slack app needs `files:read` and `files:write` for screenshots and attachments. They're in the manifest; reinstall the app after updating it.

The desktop app can use the same front door, but only for its owner: set **Your Slack member ID** under Settings → Your org → Slack, and DM the bot to ask your own workers from anywhere. Everyone else is turned down, because the work runs on that laptop and its model account.

**Teams** run on the server. People give them tasks from the console's Teams page, from Claude (`brief_team`), or with `/team Pricing: …` in Slack. The plan comes back to whoever asked, for approval. A team gets there two ways:

- **Publish one you built in the app:** open the team and press **Publish to your org**, or run `overcli teams push "Launch crew"`. Members the server doesn't have go up first, each a hire under the usual rules with you as manager; members published from your install before are reused. A member over your allowance holds the team until an approver says yes, and a no means the team isn't made. Publish again to update it in place. The project it worked in stays on your laptop: on the server each member works in their own until one is picked.
- **Make one on the console:** **Teams → Make a team**, from workers you manage.

## 5. Sign in, then invite people

On first start with nobody signed in, the log prints a one-time link:

```
control: nobody has signed in yet. Open this once to sign in as the first admin: https://…/join/…
```

Open it to sign in as the first admin (the Slack ID you gave `org init`). It works once and for a day; each restart with nobody signed in prints a new one and cancels the last. Set `publicUrl` in `org.json` (or `org init --url`) to the address people use, so links sent from Slack point at the right place.

After that, nobody copies a token. Every person is their Slack account, and there are three ways in:

- **Invite**, from the console's **People** page. Pick people from your Slack (the bot needs the `users:read` scope) or type a name and Slack member ID, and choose what they can do: ask workers, hire within an allowance, approve hires, or admin. overcli DMs each a one-time link that signs them in. Without Slack, you get the link to send yourself.
- **`/overcli join`** in Slack. Slack has already proved who's asking, so they appear under *Asking to join* for an admin to let in. With `"openJoin": true` in `org.json`, they're let in straight away, able to ask workers things.
- **The overcli app**: Settings → Your org, paste the address, press **Sign in**. The browser opens on the org's page showing a code; the person confirms it, and the app gets its own sign-in in the keychain.

People shows where each person is signed in (browser, app, token), lets an admin change their role or allowance, and signs out one device or a person everywhere. Their **Connect** page has copy-paste setup for Claude Code, Claude Desktop, Codex and the app.

Tokens are still there for scripts and service accounts:

```sh
docker compose -f deploy/docker-compose.yml exec overcli overcli tokens create --name "Ops automation" --admin
docker compose -f deploy/docker-compose.yml exec overcli overcli tokens list
docker compose -f deploy/docker-compose.yml exec overcli overcli tokens revoke "Ops automation"
```

## Secrets

Admins manage the server's secrets on **Setup → Secrets**: git host tokens, the Slack tokens, the SSO client secret, model API keys, and credentials for tools (`JIRA_API_TOKEN`).

- **Values go in and never come back out.** The page shows each secret's name, whether it's set, by whom and when, and what needs a missing one. Changes are recorded in the decision log by name.
- **Changes apply at once.** New worker runs and git pick up a change immediately, and Slack reconnects when its tokens change. No restart.
- **Where they're kept** is set by `OVERCLI_SECRETS`:
  - **Unset:** an encrypted file on the data volume. The key comes from `OVERCLI_SECRETS_KEY`, from the login keychain when the server runs on a Mac, or else from a key file beside the secrets (the page warns about that one).
  - **`aws:overcli/acme/`:** AWS Secrets Manager, through the instance or task role. See [aws.md](aws.md#secrets-policy).
  - **`gcp:<project>/overcli-`:** GCP Secret Manager, through the service account. See [gcp.md](gcp.md).
- **The environment wins.** Anything set in `deploy/.env` or the task definition shows as "set by the environment" and is changed there.
- **Read-only mode:** with `OVERCLI_SECRETS_READONLY=1` (for secrets managed in Terraform), the page lists them and changes nothing. They're re-read every five minutes either way.
- **Allowed names:** the listed names, or a credential name for a tool (capitals, ending `_TOKEN`, `_API_KEY`, `_KEY`, `_SECRET` or `_PASSWORD`). Names that could redirect overcli, git or the model are refused.

## Company sign-in (SSO)

People can sign in with the company account instead of a Slack link: Okta, Entra ID, Google Workspace, or anything that speaks OpenID Connect.

1. In the identity provider, create a web app (OIDC, authorization code). Set its redirect address to `<publicUrl>/sso/callback`; the console shows the exact address. Assign it to the people who should have workers; the provider decides who gets in.
2. On **Admin → Change the rules → Sign-in**, enter the issuer (e.g. `https://acme.okta.example`) and the client ID. A confidential client's secret goes in `OVERCLI_SSO_CLIENT_SECRET` in `deploy/.env`, never in `org.json`. Public clients work without one (PKCE).
3. `publicUrl` must be set: the provider sends people back to a fixed address.

overcli knows people by their Slack account, so an email is matched to a Slack member by asking Slack (the bot needs `users:read.email`, which the manifest includes) or through the `people` list. **Everyone signs in this way** turns invite links into role grants only: the person's role applies the first time they sign in. Scripts' tokens keep working.

## Spend, records and offboarding

- **Budgets.** Each worker has its own; `orgBudgetUSD` caps them all. Managers get a Slack DM when a worker passes `alertAtPercent` of its budget, with a button to raise it within their allowance; admins hear when the org does. Admin shows spend by manager and by team.
- **Decision log.** Admin → **Full log** searches every decision by person, worker, words and dates, and downloads it as a CSV. `retentionDays` prunes it, and finished runs, once a day. A run whose work was never reviewed is never deleted.
- **Someone leaves.** People → Manage → **has left**: pick who takes their workers. Their workers and hires in progress go to that person; they're signed out everywhere and taken off every rule. A worker can also be handed to someone else, or let go, from its own page.

## More than one server

One server serves one Slack app. A company that runs one per department lists the others under **Other servers** in the rules, and connects each with an admin token minted there (`overcli tokens create --name "Fleet" --admin`). Admin then shows each server's health and spend in one place.

## Triggers: workers that act on business events

A schedule runs a worker at set times. A trigger runs it the moment work shows up: a bug filed, a deal moved, a message in a channel. Set triggers on a worker's **Triggers** tab, or from Claude with `create_trigger`. Each one says three things:

1. **What sets it off.**
   - **Watch:** every few minutes, overcli calls one of the server's tools directly, with no model and no cost per check (for example a Jira search). It acts once on each item it hasn't seen. The first check only records what's already there, so turning a trigger on never floods the worker with the backlog. It works inside a VPC, because nothing has to reach the server. **Try it now** shows what it would see before you save.
   - **Webhook:** Jira automation, GitHub, a CRM or Zapier posts each event to a secret address, `<publicUrl>/hooks/<id>/<secret>`, shown once when you save. The same event sent twice is handled once. This needs the control plane reachable from the sender.
   - **Slack:** a new message, a mention of the bot, or an emoji reaction (say 🐛) in a channel. Invite the bot to the channel. This needs the manifest's channel scopes, so reinstall the Slack app after upgrading.
2. **What it does with each one,** in plain words. The worker gets the event itself (the ticket, the PR, the message) with your instructions. On probation it proposes what it would do and waits; once trusted, it acts.
3. **Where the result goes:** a Slack channel, the thread the event came from, or the worker delivers it itself with its tools ("comment your triage on the ticket", "open a PR").

Every event, and what came of it, is kept in the **Library**: what set it off, the result and its links, where it went, how long it took, and whether people found it useful. A worker's Triggers tab shows what its events came to this month: items handled, typical time, cost per item and the share rated useful. A daily limit on each trigger keeps cost in check.

## Schedules

A worker runs when someone asks it, or on a schedule. A hire takes the schedule its job description implies ("a summary every Monday morning"), and the offer and the worker's Settings let its manager change it: every day, weekdays, once a week, or every few hours inside working hours. The worker's page shows the next run and has **Run now**.

Schedules run in the org's `timezone` from `org.json` (the container's `TZ`, if set, wins). Changing it while the server runs takes effect within five minutes. The server has to be running for a schedule to fire; a run missed while it was down is not made up.

What a scheduled run does depends on the worker's trust:

- **On probation**, it proposes the work and waits. Its manager sees "Triage proposes 3 things" on Today, unticks what they don't want and approves the rest, or presses **Approve all** or **Skip** in the Slack DM. From Claude: `list_proposals`, then `decide_proposal`.
- **Trusted or autonomous**, it starts the work itself, and the manager reads what came in.

Every approval costs model time, so a worker's monthly budget still caps what its schedule can spend.

## Publishing a worker someone built themselves

Anyone who can hire can bring a worker they built in their own overcli app:

- **In the app:** Settings → Your org (sign in), then **Publish to your org** on the worker's Share card.
- **From a terminal:** `OVERCLI_ORG_URL=… OVERCLI_ORG_TOKEN=… overcli workers push "Worker name"`
- **In the console:** Hire → *Bring a worker you built yourself*, then paste its file.

It's treated as a hire. The publisher becomes its manager, it starts on probation with a fresh journal, and anything over their allowance or asking for uncleared tools waits for an approver.

## Inside a VPC or behind a VPN

Slack needs no inbound route. The bridge uses Socket Mode, so the container dials out and Slack's events come back down that connection.

| Direction | To | Why |
|---|---|---|
| Egress 443 | `slack.com`, `wss-primary.slack.com`, `wss-backup.slack.com` | Slack |
| Egress 443 | `api.anthropic.com`, or Bedrock or Vertex via a private endpoint | The model |
| Egress | your git host | Repos |
| Ingress 7420 | only from where people use the console and MCP | Control plane |

Three ways to expose the control plane, strictest first:

1. **VPN only.** Keep 7420 on the private network. Console, Claude Code, Codex and the overcli app all work from VPN-connected machines.
2. **Internal load balancer with TLS** in front of 7420, for a proper `https://` name inside the network. The app and CLI require https for anything that isn't this machine.
3. **Public HTTPS ingress**, only if you want claude.ai connectors. Use an ALB or API gateway with TLS, or Cloudflare Tunnel (outbound-only, like Socket Mode). Restrict it to Anthropic's published egress ranges, and keep token auth on.

The compose file binds 7420 to loopback. Open it up deliberately. Behind a proxy or load balancer, set `OVERCLI_TRUST_PROXY=1` so rate limits see each person's address rather than the proxy's; without it, `X-Forwarded-*` headers are ignored.

## Operating it

- **Run one instance per Slack app.** Socket Mode spreads events across every open connection, so a second instance on the same tokens takes replies meant for the first. To grow past one box, split by department, each with its own Slack app and volume.
- **A bind mount instead of the named volume** must be writable by uid 1000 (`chown -R 1000:1000 <dir>`), the `node` user the image runs as.
- **Back up `/data`.** It holds every worker, journal, run, token hash, `org.json`, ratings and the decision log (`org/audit.jsonl`).
- **Permissions.** `--permissions deny` lets worker runs use no tools; the compose file uses an allow-list. External actions (push, send, publish) still stop for the manager's approval until the worker is trusted with them. Trust is raised from the worker's page when its record earns it.
- **Logs.** stdout carries startup, Slack connection and control plane messages.
