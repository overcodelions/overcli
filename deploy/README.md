# Running overcli for an org

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
docker compose exec overcli overcli org init --name "Acme" --admin U012AB3CD --slack-team T012AB3CD \
  --url https://overcli.acme.internal:7420 --timezone America/New_York
docker compose exec overcli overcli org show
```

This writes `/data/org.json`. It names the org (in the console, Slack and MCP), pins the Slack workspace (the bridge refuses a token from any other), and holds the rules. Edit it any time: changes apply without a restart. `deploy/org.example.json` has every field:

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

A new `org.json` starts narrow: only admins hire, until you change `hirers`.

## 4. Give it work to do

Workers doing research and writing can use the default **Workers** folder. Workers doing code need the repo:

```sh
docker compose exec overcli git clone git@github.com:acme/app.git /data/repos/app
docker compose exec overcli overcli projects add /data/repos/app --name App
```

For private repos, mount a deploy key into `/data/home/.ssh`, or put a GitHub App token in the remote URL.

**Teams** are put together in the overcli app (a coordinator plus members), and run on the server. People give them tasks from the console's Teams page, from Claude (`brief_team`), or with `/team Pricing: …` in Slack. The plan comes back to whoever asked, for approval.

## 5. Sign in, then invite people

On first start with nobody signed in, the log prints a one-time link:

```
control: nobody has signed in yet. Open this once to sign in as the first admin: https://…/join/…
```

Open it to sign in as the first admin (the Slack ID you gave `org init`). Set `publicUrl` in `org.json` (or `org init --url`) to the address people use, so links sent from Slack point at the right place.

After that, nobody copies a token. Every person is their Slack account, and there are three ways in:

- **Invite**, from the console's **People** page. Pick people from your Slack (the bot needs the `users:read` scope) or type a name and Slack member ID, and choose what they can do: ask workers, hire within an allowance, approve hires, or admin. overcli DMs each a one-time link that signs them in. Without Slack, you get the link to send yourself.
- **`/overcli join`** in Slack. Slack has already proved who's asking, so they appear under *Asking to join* for an admin to let in. With `"openJoin": true` in `org.json`, they're let in straight away, able to ask workers things.
- **The overcli app**: Settings → Advanced → Your org, paste the address, press **Sign in**. The browser opens on the org's page showing a code; the person confirms it, and the app gets its own sign-in in the keychain.

People shows where each person is signed in (browser, app, token), lets an admin change their role or allowance, and signs out one device or a person everywhere. Their **Connect** page has copy-paste setup for Claude Code, Claude Desktop, Codex and the app.

Tokens are still there for scripts and service accounts:

```sh
docker compose exec overcli overcli tokens create --name "Ops automation" --admin
docker compose exec overcli overcli tokens list
docker compose exec overcli overcli tokens revoke "Ops automation"
```

## Schedules

A worker runs when someone asks it, or on a schedule. A hire takes the schedule its job description implies ("a summary every Monday morning"), and the offer and the worker's Settings let its manager change it: every day, weekdays, once a week, or every few hours inside working hours. The worker's page shows the next run and has **Run now**.

Schedules run in the org's `timezone` from `org.json` (the container's `TZ`, if set, wins). The server has to be running for a schedule to fire; a run missed while it was down is not made up.

What a scheduled run does depends on the worker's trust:

- **On probation**, it proposes the work and waits. Its manager sees "Triage proposes 3 things" on Today, unticks what they don't want and approves the rest, or presses **Approve all** or **Skip** in the Slack DM. From Claude: `list_proposals`, then `decide_proposal`.
- **Trusted or autonomous**, it starts the work itself, and the manager reads what came in.

Every approval costs model time, so a worker's monthly budget still caps what its schedule can spend.

## Publishing a worker someone built themselves

Anyone who can hire can bring a worker they built in their own overcli app:

- **In the app:** Settings → Advanced → Org server (address and token), then **Publish to your org** on the worker's Share card.
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

The compose file binds 7420 to loopback. Open it up deliberately.

## Operating it

- **Run one instance per Slack app.** Socket Mode spreads events across every open connection, so a second instance on the same tokens takes replies meant for the first. To grow past one box, split by department, each with its own Slack app and volume.
- **Back up `/data`.** It holds every worker, journal, run, token hash, `org.json`, ratings and the decision log (`org/audit.jsonl`).
- **Permissions.** `--permissions deny` lets worker runs use no tools; the compose file uses an allow-list. External actions (push, send, publish) still stop for the manager's approval until the worker is trusted with them. Trust is raised from the worker's page when its record earns it.
- **Logs.** stdout carries startup, Slack connection and control plane messages.
