# Running overcli for an org (alpha)

> **Alpha.** Org workers are early. Expect rough edges and changes between versions, and back up `/data`. In the desktop app, they're switched on under Settings → Labs → Org workers.

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

## 1. Build and configure

```sh
docker build -f deploy/Dockerfile -t overcli-org .
# with Codex too:  docker build -f deploy/Dockerfile --build-arg INSTALL_CODEX=1 -t overcli-org .
cp deploy/.env.example deploy/.env
```

In `deploy/.env`:

- **The model.** Workers run through the Claude Code CLI inside the container. Give it `ANTHROPIC_API_KEY`, or Bedrock (`CLAUDE_CODE_USE_BEDROCK=1` and AWS credentials, ideally from the instance role), or Vertex. For Codex, build with `INSTALL_CODEX=1` and set `OPENAI_API_KEY`. The console's Admin page shows which models are signed in.
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

Workers doing research and writing can use the default **Workers** folder. Workers doing code need the repo:

```sh
docker compose -f deploy/docker-compose.yml exec overcli git clone git@github.com:acme/app.git /data/repos/app
docker compose -f deploy/docker-compose.yml exec overcli overcli projects add /data/repos/app --name App
```

For private repos, mount a deploy key into `/data/home/.ssh`, or put a GitHub App token in the remote URL.

**Teams** are put together in the overcli app (a coordinator plus members), and run on the server. People give them tasks from the console's Teams page, from Claude (`brief_team`), or with `/team Pricing: …` in Slack. The plan comes back to whoever asked, for approval.

## 5. Sign in, then invite people

On first start with nobody signed in, the log prints a one-time link:

```
control: nobody has signed in yet. Open this once to sign in as the first admin: https://…/join/…
```

Open it to sign in as the first admin (the Slack ID you gave `org init`). It works once and for a day; each restart with nobody signed in prints a new one and cancels the last. Set `publicUrl` in `org.json` (or `org init --url`) to the address people use, so links sent from Slack point at the right place.

After that, nobody copies a token. Every person is their Slack account, and there are three ways in:

- **Invite**, from the console's **People** page. Pick people from your Slack (the bot needs the `users:read` scope) or type a name and Slack member ID, and choose what they can do: ask workers, hire within an allowance, approve hires, or admin. overcli DMs each a one-time link that signs them in. Without Slack, you get the link to send yourself.
- **`/overcli join`** in Slack. Slack has already proved who's asking, so they appear under *Asking to join* for an admin to let in. With `"openJoin": true` in `org.json`, they're let in straight away, able to ask workers things.
- **The overcli app**: Settings → Advanced → Your org, paste the address, press **Sign in**. The browser opens on the org's page showing a code; the person confirms it, and the app gets its own sign-in in the keychain.

People shows where each person is signed in (browser, app, token), lets an admin change their role or allowance, and signs out one device or a person everywhere. Their **Connect** page has copy-paste setup for Claude Code, Claude Desktop, Codex and the app.

Tokens are still there for scripts and service accounts:

```sh
docker compose -f deploy/docker-compose.yml exec overcli overcli tokens create --name "Ops automation" --admin
docker compose -f deploy/docker-compose.yml exec overcli overcli tokens list
docker compose -f deploy/docker-compose.yml exec overcli overcli tokens revoke "Ops automation"
```

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

- **In the app:** Settings → Advanced → Your org (sign in), then **Publish to your org** on the worker's Share card.
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
