# Reference

## Environment variables

Set these in `deploy/.env`, the task definition, or the shell. Secrets can also be set on **Setup → Secrets** instead; a value in the environment wins.

### The server

| Variable | Meaning |
|---|---|
| `OVERCLI_HOME` | The data directory (`/data` in the image). Default `~/.overcli`. |
| `OVERCLI_CONTROL` | Where the console and MCP listen, e.g. `0.0.0.0:7420`. Same as `--control`. |
| `OVERCLI_TRUST_PROXY` | `1` behind a load balancer or proxy that sets `X-Forwarded-*`. |
| `TZ` | Time zone for schedules. Unset: the org's `timezone` from `org.json`. |

### The model

| Variable | Meaning |
|---|---|
| `ANTHROPIC_API_KEY` | The Anthropic API. |
| `CLAUDE_CODE_USE_BEDROCK`, `AWS_REGION` | Bedrock, through the server's AWS role. |
| `AWS_BEARER_TOKEN_BEDROCK` | A Bedrock API key, for a server without an AWS role. |
| `CLAUDE_CODE_USE_VERTEX`, `CLOUD_ML_REGION`, `ANTHROPIC_VERTEX_PROJECT_ID` | Vertex AI, through the service account. |
| `OPENAI_API_KEY` | Codex, if the image was built with `INSTALL_CODEX=1`. |

### Secrets

| Variable | Meaning |
|---|---|
| `OVERCLI_SECRETS` | Where secrets live: unset (an encrypted file), `aws:<prefix>`, or `gcp:<project>[/<prefix>]`. |
| `OVERCLI_SECRETS_KEY` | The encrypted file's key. Keep it apart from the volume. |
| `OVERCLI_SECRETS_READONLY` | `1` when secrets are managed elsewhere (Terraform). |

### Slack and sign-in

| Variable | Meaning |
|---|---|
| `OVERCLI_SLACK_ENABLED` | `1` to connect to Slack. |
| `OVERCLI_SLACK_BOT_TOKEN` | xoxb-… (or set it on Setup → Secrets). |
| `OVERCLI_SLACK_APP_TOKEN` | xapp-…, with `connections:write` (or set it on Setup → Secrets). |
| `OVERCLI_SSO_CLIENT_SECRET` | A confidential OIDC client's secret. |

### Git hosts

| Variable | Meaning |
|---|---|
| `GH_TOKEN` | GitHub. |
| `BITBUCKET_TOKEN`, `BITBUCKET_USER` | Bitbucket Cloud. The user defaults to `x-token-auth`, as access tokens use. |
| `GIT_TOKEN`, `GIT_USER` | Any other host over https. The user defaults to `oauth2`. |
| `OVERCLI_ALLOW_LOCAL_REPOS` | `1` to connect `file://` repos on the server's own disk. For trying Repos on a laptop; leave it off on a real server. |

### Publishing from a laptop

| Variable | Meaning |
|---|---|
| `OVERCLI_ORG_URL`, `OVERCLI_ORG_TOKEN` | Where `overcli workers push` and `overcli teams push` publish, and as whom. |

## `org.json`

The org's identity and rules, on the data volume. Write it with `overcli org init`, then change it on **Setup → Rules** (or by hand: changes apply without a restart). `deploy/org.example.json` has every field.

| Field | Meaning |
|---|---|
| `name`, `slackTeamId`, `timezone`, `publicUrl` | Who the org is, and the address people use |
| `admins`, `hirers`, `approvers` | Slack member IDs for each role (`hirers` may be `"*"`) |
| `openJoin` | Let anyone in the Slack workspace in with `/overcli join` |
| `budgetAllowanceUSD`, `allowances` | Per-person monthly allowance, and overrides |
| `orgBudgetUSD`, `alertAtPercent` | The org's monthly cap, and when to warn |
| `allowedMcpServers` | Tools any manager may give their workers without an admin |
| `sharedMcpServers` | Tools every worker has, without anyone giving them |
| `roles` | The Hire page's catalog |
| `teams` | Groups of people, for "its team may ask it" |
| `orgVisibilityNeedsAdmin` | Whether "everyone may ask it" needs an admin |
| `sso` | Company sign-in: issuer, client ID, whether it's required |
| `people` | Email → Slack member ID, for company sign-in |

## CLI

| Command | Does |
|---|---|
| `overcli serve [--control ADDR] [--permissions P] [--allow-tool T]` | Runs the server |
| `overcli org init --name N [--admin U…] [--slack-team T…] [--url URL] [--timezone Z]` | Writes `org.json` |
| `overcli org show` | Prints the org and its rules |
| `overcli tokens create --name N [--slack U…] [--admin]` | A token for a script; printed once |
| `overcli tokens list` / `revoke <id\|name>` | Lists or revokes tokens |
| `overcli projects add <dir> [--name N]` / `list` | Folders workers may work in |
| `overcli workers push <name\|file.yaml> --to URL [--token T]` | Publishes a worker from a laptop |
| `overcli teams push <name> --to URL [--token T]` | Publishes a team, members and all |

## MCP tools

Connect Claude Code, Claude Desktop or Codex to `<server>/mcp` with your key. What you can do depends on your role.

| Area | Tools |
|---|---|
| Asking | `ask_worker`, `check_question`, `list_workers`, `get_worker`, `org_chart`, `whoami` |
| What's waiting | `today`, `list_waiting`, `answer_question`, `decide_approval`, `list_proposals`, `decide_proposal` |
| Results | `library`, `list_work`, `rate_work` |
| Hiring | `list_roles`, `hire_role`, `draft_hire`, `confirm_hire`, `list_hires`, `cancel_hire`, `decide_hire`, `publish_worker` |
| Managing | `update_worker`, `set_worker_paused`, `set_worker_trust`, `set_worker_schedule`, `run_worker_now`, `retire_worker` |
| Triggers | `list_triggers`, `create_trigger`, `set_trigger_enabled` |
| Teams | `list_teams`, `list_team_tasks`, `brief_team`, `decide_team_task` |
| Code | `list_repos`, `connect_repo`, `create_workspace`, `let_worker_change_repo` (a repo or a workspace), `push_team_code` |
| Admin | `org_people`, `org_health`, `org_rules`, `set_org_rules`, `offboard_person`, `decision_log`, `list_tools`, `list_secrets` |

## Slack

| You type | Does |
|---|---|
| `@overcli <request>` or a DM | Whoever fits takes it; answers in the thread |
| `/worker`, `/worker <name> ask <text>`, `/worker waiting` | List, ask, what's waiting on you |
| `/team <name>: <task>` | Give a team a task (it waits as Up next if the team is busy) |
| `/team new <what it's for>` | Make a team from your workers: a suggested crew comes by DM |
| `/hire <the job>` | Hire a worker |
| `/overcli join` | Ask to be let in |

The app's scopes and events are in `src/main/slack/slack-app-manifest.yml`. Reinstall the app when the manifest changes.

## The data volume

| Path | Holds |
|---|---|
| `org.json` | The org's rules |
| `org/` | Sign-ins (hashed), invites, the decision log, ratings, asks, triggers, the Library's event deliverables, repos |
| `secrets.enc` | Encrypted secrets (file store) |
| `workers/`, `flows/`, `teams/` | Workers, their flows, teams |
| `repos/` | Connected repos' clones |
| `home/` | The model CLI's config, including installed tools |
