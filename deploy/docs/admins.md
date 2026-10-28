# For admins

Admins set the server up and keep it healthy. Most of this lives on the console's **Setup** page, with people and the decision log on **People** and **Activity**.

Setup is one page at a time, picked from the list beside it: **Readiness**; **Organization** (General, People & teams, Sign-in, Records); **Workers** (Hiring, Role catalog, Handbook, Spending); and **Connections** (Tools, Secrets, Repos & workspaces, From desktops, Other servers). On a phone the list is a menu above the page. Each page saves on its own, and **Save** waits until something changed.

## Setup → Readiness

A checklist of what the server needs: a model, Slack, a place to work, the tools workers list, people. Each missing item says how to fix it.

## Setup → From desktops

People publish their setup from the overcli app: **Settings → Your org → Publish my setup**. They choose which workspaces, projects and tools to send; nothing is chosen to start with. Each published setup arrives here as a checklist:

- **Repos:** **Connect** clones the repo from its git remote. A project with no remote can only be connected by a server on the same machine, started with `OVERCLI_ALLOW_LOCAL_REPOS=1`.
- **Workspaces:** **Make it** once all its repos are connected.
- **Tools:** each arrives as a template: where it runs, and the names of the keys it needs, never their values. Type the keys in and **Install**. Use a service account or bot token made for the org: every worker that uses the tool acts with it.

**Keys sent from a desktop.** Someone can choose to send a tool's keys with their setup. The server only accepts them from an admin, and only over https or from the same machine. The tool is installed straight away, so the values are stored only where the model CLI reads them. The activity log records which keys arrived, by name, never their values. A key sent this way acts as the person who sent it, for every worker that uses that tool. Fine for a test server; for a real deployment, prefer org-owned credentials.

## Setup → Tools

The MCP servers workers use, such as Jira, a CRM or a search API. Installed here, they're available to every worker that lists them.

- **Install from the catalog.** **Install a tool** opens on the common ones: GitHub, Bitbucket, Atlassian Rovo, Linear, Notion, Slack, Salesforce, HubSpot, Attio, Sentry, Stripe, AWS, a headless browser and more. Pick one and the form is filled in; it says what each setting is and links to where you get the key. A worker that lists a catalog tool you haven't installed gets the same filled-in form.
- **Install anything else** with **Something else**: a command (`npx -y @acme/jira-mcp`) or a URL (a remote MCP server), plus its settings.
- **Workers published from the desktop app** bring their tools' setup with the secret values removed. Installing them here is then pre-filled.
- **Connectors from someone's Claude app** ("claude.ai Atlassian") stay on that person's Claude account, so they never come to the server. A worker that used one shows under **Workers are missing these** as the tool to install instead (`atlassian`). Install it once, and those workers switch to it with their scope kept. If it's already installed, **Use the installed atlassian** switches them.
- **Tools that sign in through a browser** are signed in once, by you, for the whole org. See [Remote tools that sign in](#remote-tools-that-sign-in) below.

### Remote tools that sign in

Many remote MCP servers ask you to sign in on their own page instead of pasting a token. Nobody on a server can press "Allow", so you sign in for it:

1. **Install a tool → A remote server, by URL.** Paste the address. The form checks how the server signs in:
   - **No sign-in needed:** install it as it is.
   - **Wants a token:** paste it as a header, such as `Authorization: Bearer …`.
   - **Signs in with** the service's name: the button becomes **Sign in and install**.
2. **Sign in** on the service's page and approve. You come back to Setup → Tools, and the tool is installed.
3. **Give it to workers:** click the tool's row, as with any tool.

> [!IMPORTANT]
> Every worker you give the tool acts as the account you signed in with. Use a service or bot account where the service has one, rather than your own.

**Behind the scenes:**

- overgo registers itself as an app with the service the first time.
- It signs in with PKCE, keeps the refresh token encrypted in `org/tool-signins.json`, and renews the sign-in itself. Every run starts with at least half an hour left on it.
- Workers only ever see a short-lived access token.
- Removing the tool ends the sign-in at the service, where the service allows it.

**On a server inside a private network.** The service never calls the server: it sends *your browser* back to the console, so a console you reach over a VPN still gets the sign-in. What stops it is the address. Services only send people back to `https://` or `localhost`, and most refuse a plain `http://` internal address. The form warns when that's the case. Your options:

- **Use a key instead.** Catalog tools that sign in also have a key way (the **Use a key instead** button): an API token or service-account key, pasted once. Nothing comes back from the service, so it works anywhere the server can reach the service.
- **Give the console an https address** (`publicUrl` in `org.json`), even an internal one with your own certificate, then sign in.
- **Sign in through a tunnel.** `ssh -L 7420:localhost:7420 <server>` and open `http://localhost:7420`, with `publicUrl` unset while you sign in. Services accept `localhost`.

Either way the server needs outbound access to the service; a network with no way out can't use remote tools at all.

**Signing in again.** Open the tool, then **Sign in again**. It replaces the account. Do it when the tool shows **Signed out**: the service ended the sign-in, or the account lost access.

**When the service won't register apps.** Some services only accept apps made by hand. The form says so, and shows the redirect address (the console address followed by `/oauth/tools/callback`). Make an OAuth app on the service with that address, then paste its client ID and secret into the form.

**A tool you already installed with a token.** Open the tool, then **Sign in for everyone**. It switches it to a sign-in. The pasted token is replaced.

> [!NOTE]
> The redirect address uses the server's public address (`publicUrl`) when it's set. Set it before signing tools in, or a service may send you back to an address it can't reach.


**Who can use a tool.** Each tool on Setup → Tools has three levels:

- **Only admins, to workers they pick:** you give it to each worker that needs it (**Give it to a worker**). Use this for anything that changes systems people rely on, or that uses one person's key.
- **Any manager, to their workers:** managers add it to their own workers without asking an admin. Use this for tools that write, but where a mistake is cheap.
- **Every worker has it:** every worker has it, including future hires. Use this for tools that only read. Before you switch it on, the console lists the tool's actions that can change things.

Workers that ask first still ask before any step that changes something, whatever a tool's level.

**What a tool can do.** A tool's panel counts its actions: so many **reads**, so many **changes**, or **Only reads**. **See what it can do** lists them by name.

**Whose keys it uses.** When a tool's keys belong to a person, its panel says **It acts as** that person: anyone who can ask a worker with the tool reads what they can, and what it changes shows as theirs. The box turns red when that person has left the org, because every worker with the tool stops when their account is closed. Replace the key with a service account's. If the keys already are one, press **These are a service account's keys** and the warning goes away (**Not any more** undoes it).

### Tool requests

A manager who wants a tool for a worker asks from the worker's **Access** tab (**+ Give it a tool**) or from Slack (`/worker Ada tools add zendesk: to read tickets`).

- **Given at once** when the tool is one any hire may have (see [Setup → Hiring](#setup--rules-spending-and-sign-in)), or when an admin asks.
- **Otherwise it comes to you.** Every admin gets a Slack DM, and a **Tool** card waits in the Inbox, with what it's for. **Give it** or **Decline**. A tool that isn't installed yet has to be installed on Setup → Tools first.
- **The person who asked hears** in Slack either way, and the DMs to the other admins update to say who decided.

### When a tool stops working

The server watches every tool call. A tool that starts failing reaches you, instead of showing up as workers quietly saying they couldn't read something.

- **Right away** when its calls are refused (401, 403, an expired or revoked key) or when it says what it calls is retired or gone.
- **After five failures in a row** for any other error, so a model calling a tool wrong now and then doesn't count.
- **How you hear:** a Slack DM to every admin, with the last error and the workers it holds up, at most once a day per tool. A **Fix** card waits in the Inbox.
- **On Setup → Tools** the tool shows **Can't sign in since…**, **Its API looks retired** or **Failing since…**. Its panel has the last error and **Mark fixed**.
- **It clears itself** the next time a call to the tool works.

**npx tools are installed ahead of time.** A tool run as `npx -y <package>` used to download itself on its first start, inside a run's short start-up time. Cut off halfway, it left a broken install and every start after failed with "Cannot find module". The server now installs each npx tool in the background at startup, every 30 minutes, and right after you install one, and removes and reinstalls a broken install. Pin a version in the command (`zd-mcp-server@0.6.1`, as the catalog's Zendesk does) so an update can't change the tool under you.
## Setup → Repos

Code repos workers may change. See also [Security model](security.md#code).

1. **Give the server a way to push.** Set the host's token on **Setup → Secrets**: `GH_TOKEN` (GitHub), `BITBUCKET_TOKEN` (Bitbucket Cloud) or `GIT_TOKEN` + `GIT_USER` (any other host). Or connect with a `git@` address and an ssh key on the server.
2. **Connect** the repo: its address, and the test command to run before every push. Repo tests are off until the server's operator turns them on (`OVERCLI_TEST_UID` or `OVERCLI_TEST_AS_SERVER`, see the [deploy README](../README.md)); until then a repo with a test command pushes nothing, and the Repos tab says so on that repo.
3. **Let a worker change it:** pick the worker and press **Let it change this repo**.

Protect the default branch on your git host as well (required reviews, no force pushes). The server refuses pushes to it, but the host is the real guard.

**Workspaces** group repos that change together, like an API and the app that uses it.

- **Making one:** **Make a workspace** at the bottom of the tab. Pick the repos, and add instructions every run reads (which repo owns what, what must stay in step).
- **Using one:** point a worker at it with **Let it change this workspace**, or set a team's **Works in** to it.
- **What a run does:** each run gets its own worktree of every repo. The server pushes one branch per changed repo, each past that repo's tests, and the reply has one pull request link per repo.
- **Changing or removing it:** **Change** edits the repos or instructions, and workers in it use the new setup from their next run. A workspace can't be removed while a worker works there.

- **Pull requests:** what the server does after pushing a worker's branch. **Open as a draft** (the default) opens the pull request on Bitbucket or GitHub with the title and description the worker wrote, as a draft a person marks ready; **open for review** opens it ready; **link only** hands back the link to open one, as before. A fix pushed onto a branch whose pull request is open goes into that pull request. The token needs pull request write access (Bitbucket: Pull requests: Write; GitHub: Pull requests: Read and write); without it the run says why and the link stands.
- **When CI fails:** after the server pushes a worker's branch, it reads the repo's own CI result for that commit through the git host's API, with the same token it pushes with: Bitbucket commit statuses (and, for Pipelines, the failed step's test cases and log), or GitHub check runs and commit statuses (with annotations and the Actions job log). A red build goes back to the same worker with the failing checks, tests and the end of the log, to fix on the same branch, so the open pull request gets the fix and CI runs again. After the number of rounds set in the strip (3 by default; "tell the manager" for none), or a build still running after 3 hours, the worker's manager gets a Slack DM, and a reply there goes to the worker. Each run's result is attached to it as `ci.md`. A repo whose CI reports nothing within 20 minutes isn't watched. A Bitbucket access token needs read access to pipelines for the detail; without it the worker still gets the failing checks and their links.
- **Workers don't fetch or push.** Before each run the server fetches every branch of the repo, and every step of a worker's run is told so: work from `origin/<branch>` (an open pull request's branch included), never `git fetch` or `git push`, and the server pushes when the run ends.

## Setup → Databases

Databases people published from [overdb](https://github.com/overcodelions/overdb), for workers to read. In overdb, someone opens a connection's Read-only menu and chooses **Publish to your org's server**; their overcli app sends it here. What arrives is where the database is and which login to use, never a password.

Each one waits under **Waiting** until you finish it:

- **A password connection** asks for the password once. It goes straight into the overdb tool's own settings, under the variable the row names, and nowhere else: not the connections file, not the audit log. Like a tool's keys, it is only accepted over https or on this same machine.
- **An IAM connection** signs in with a token from this server's own AWS role. Give the role `rds-db:connect` for the login the row names; there is nothing to type.
- **DynamoDB** reads with this server's AWS role directly.

Each row also says what it **tells workers**: the tenancy rule (which column every query filters on), the publisher's notes, and overdb's map of the code — what each table is for, the values a status column takes, the links only the code makes. Workers get these before they write SQL, so their queries are right the first time. They come from overdb as they were when published; publish again to update them.

**Set up** writes the connection to `org/overdb-connections.json` and installs the **overdb** tool, which runs overdb's MCP server against that file. Then add `overdb` to the workers that should read these databases, as with any tool. Every session is read-only on the database itself and every statement has a 30-second limit, but a read can still be expensive: use a login made for agents, with only the grants you would give them, especially on prod.

The server needs overdb's built `dist` folder. The Docker image keeps it at `/opt/overdb`; anywhere else, set `OVERDB_HEADLESS` to its `dist/mcp/headless.js`. Until then the tab says so and nothing can be set up.

**Remove** takes a database away from workers, and its password with it.

**Recent queries by workers** lists what each worker asked of which database: the tool, the SQL, how many rows came back, and anything refused — including a worker naming a database it was not given. No rows are kept, and no values bound into a query. The log is `org/overdb-queries.jsonl`, moved aside at 5 MB.

Rows a worker reads go to the model and can end up wherever that worker posts: Slack, a ticket, a pull request. Give the overdb tool to workers whose output stays where the data may go, and point production at a read replica.

## Setup → Secrets

Every secret the server uses, with why it's needed and how to get one. Values go in and are never shown again; changes apply at once and are recorded by name in the decision log. Where they're kept depends on `OVERCLI_SECRETS`:

| Setting | Kept in | Notes |
|---|---|---|
| unset | an encrypted file on the data volume | Key from `OVERCLI_SECRETS_KEY`, the Mac login keychain, or a key file beside it (warned about) |
| `aws:overcli/acme/` | AWS Secrets Manager | Through the instance or task role; see [the policy](../aws.md#secrets-policy) |
| `gcp:<project>/overcli-` | GCP Secret Manager | Through the service account |

- **The environment wins.** A secret set in the server's environment (`deploy/.env` or the task definition) shows as "set by the environment" and is changed there.
- **Read-only mode:** with `OVERCLI_SECRETS_READONLY=1`, for secrets managed in Terraform, the page lists them and changes nothing. The server re-reads them every five minutes either way.

## Setup → Toolchains

Build tools for workers and repo tests, without rebuilding the image. The server downloads each one for its own OS and CPU into `toolchains/` on the data volume, checks it against the publisher's checksum, runs it once to show its version, and keeps it across restarts and upgrades. A restart during a download marks it failed; install it again.

| Kit | From | Versions | Also sets |
|---|---|---|---|
| Java | Amazon Corretto | 8, 11, 17, 21, 25 | `JAVA_HOME` |
| Node.js | nodejs.org (latest of each major) | 18 to 26 | |
| Python | python-build-standalone, through `uv` (in the image) | 3.9 to 3.14 | |
| Go | go.dev | 1.22 to 1.26 | `GOROOT` |
| Custom | any `.tar.gz` or `.tar.xz` you give | | the variables you name |

**Which version a run gets**, per kit, from the next run on:

1. the repo's pick under *Versions each repo uses*;
2. else what the repo asks for itself, if that version is installed: `.nvmrc` or `.node-version`, `.python-version`, `.sdkmanrc` or `.java-version`, the `go` line in `go.mod`, or `.tool-versions`;
3. else the kit's **default** (the first one installed, until you make another the default).

Every worker's shell and every repo's test command gets that version's `bin` first on `PATH`. A repo whose files already say `java=8.0.422-amzn` or `20` needs no setting at all once that version is installed.

**Custom kits** are for anything the catalog doesn't carry (Terraform, a Maven, another runtime). Give a name, an https address of the archive built for the server's OS and CPU (the section shows which), the folder inside it to put on `PATH` (`bin` by default, counted from the archive's one top folder if it has one), and any variables, with `{home}` for where it unpacks. Give its **sha256** when the publisher lists one: a download that doesn't match is never installed. A custom kit can't set `PATH`, `HOME`, `LD_*`, `DYLD_*`, `NODE_OPTIONS` or `OVERCLI_*`. It runs on the server like any other tool workers have, so it's admin-only and recorded in the decision log with its address.

**Remove** deletes it from the volume. A version a repo is set to can't be removed until that repo picks another.

Baked-in toolchains (`--build-arg JDKS=…` or `EXTRA_APT_PACKAGES`, see the [deploy README](../README.md)) still work; whatever is installed here comes first on `PATH`.

## Setup → Handbook

What every worker should know about your org, written once. Every worker reads it after its own job, before every run and every answer.

- **What to put in it:** what your products are called, where work is tracked, who owns what, how you like things written. For example: "Work is tracked in WEB (the site) and API (the platform). Billing questions go to Ada's team."
- **Keep it short.** It's read on every run, so it costs a little each time. The limit is 12,000 characters.
- **Who changes it:** admins. Everyone else can read it. **Save the handbook** applies from each worker's next run, and the change goes in the decision log.

It's kept in `org/handbook.md` on the data volume. A worker's own job still comes first: put what only one worker needs in its job, not here.

## Google Drive for everyone

People can save a team's files into their own Google Drive, as themselves. There are two steps, done by different people:

- **An admin, once:** register overgo with Google for the whole org. This connects nobody's Drive; it only lets overgo ask Google.
- **Each person, for themselves:** connects their own Google account from their menu (**Your connections**) and approves it on Google's own page. Their files then save into their Drive, in a folder called `overcli`.

> [!NOTE]
> Set the console address first (**Setup → General**, or `publicUrl` in `org.json`). The redirect address Google needs is built from it, and connecting only works from that address. `localhost` is fine for trying it on one machine.

### Turning it on

1. **Pick a Google Cloud project.** In console.cloud.google.com, choose or create one for overgo.
2. **Turn on the Google Drive API.** APIs & Services → Library → *Google Drive API* → Enable.
3. **Set up the consent screen.** APIs & Services → OAuth consent screen (or Google Auth Platform → Branding and Audience).
   - **Internal** if everyone uses your company's Google Workspace: only your accounts can connect, and Google needs no review.
   - **External** only for personal Gmail. While it's in *Testing*, add each person as a test user; their access lasts 7 days at a time.
   - App name *overgo*, your support email, and the scope `…/auth/drive.file`. Nothing broader.
4. **Create the OAuth client.** Credentials → Create credentials → OAuth client ID → *Web application*. Under **Authorized redirect URIs** add the console address followed by `/oauth/google/callback`. **Your connections** shows the exact address with a Copy button. Leave JavaScript origins empty.
5. **Give overgo the client.** On **Setup → Secrets**, add `GOOGLE_OAUTH_CLIENT_ID` and `GOOGLE_OAUTH_CLIENT_SECRET`. They apply at once.
6. **Check it.** **Your connections** now shows *Connect Google Drive*. Connect your own account first to try it.

### What overgo can reach

- Only files it creates, in each person's `overcli` folder (the `drive.file` permission). It can't list, open or change anything else in their Drive.
- Each person's Google access is stored on the server, encrypted, under a key kept in the secrets store. It never reaches workers, the console or a URL.
- A connection can only be started by a signed-in person, in their own browser, within ten minutes, so a forwarded Google link can't attach someone else's Drive to your account.
- Disconnecting revokes the access at Google. People can also remove *overgo* from their Google account's third-party access.

### If connecting fails

| What you see | Why |
|---|---|
| `redirect_uri_mismatch` on Google's page | The redirect address in step 4 doesn't exactly match the server's, including `http`/`https` and the port. |
| "Access blocked" or "app not verified" | The consent screen is External and the person isn't a test user, or it should be Internal. |
| "Came back to a different browser or address" | The connection was started from an address other than the console address. |
| "Didn't give lasting access" | The person connected before. They remove *overgo* from their Google account's third-party access, then connect again. |

## Setup → Rules, spending and sign-in

The org's rules, kept in `org.json` on the volume (or set by Claude with `set_org_rules`). Every change is checked and logged. They're spread across Setup's pages: the org's name, address and time zone on **General**; teams on **People & teams**; who may hire, approvals, visibility and web pages on **Hiring**; roles on **Role catalog**; the org budget on **Spending**; what workers may do on **Permissions**; credentials kept out of answers on **Secrets in answers**; Bedrock and Vertex model ids on **Model ids**; how long records are kept on **Records**; company sign-in on **Sign-in**.

- **Who may hire:** everyone, or a list of people.
- **Allowances:** what one person's workers may cost a month before a hire needs an approver; per-person overrides; who the approvers are.
- **Org budget:** what all workers together may cost a month. At the cap, scheduled runs stop until the month turns. Warnings go out at `alertAtPercent` (80% by default).
- **Tools any hire may have without approval:** tick them from the installed tools. Managers give these to their workers at once; any other tool, they ask an admin for (see [Tool requests](#tool-requests)).
- **Roles:** the catalog on the Hire page. Each role is a job, its cleared tools, and a budget.
- **Visibility:** whether "everyone may ask it" needs an admin.
- **Opening web pages:** how workers open pages. Searching the web never asks. See [Security model](security.md#reading-the-web).
  - **Safe fetches** (the default): a worker opens a page only when the address came from the request, a search result, or a page it already read. An address it wrote itself is refused, and it's told to search for it first.
  - **Ask before a step that opens pages:** the manager approves first.
  - **Any page, without asking.**
- **Your own sites (always open):** sites workers may always open, such as `acme.atlassian.net, wiki.acme.com`. Subdomains count. List a private address here if workers should read it.
- **Company sign-in:** OpenID Connect (Okta, Entra ID, Google Workspace). Enter the issuer and client ID here; a confidential client's secret goes on Setup → Secrets as `OVERCLI_SSO_CLIENT_SECRET`. "Everyone signs in this way" turns invite links into role grants.

## Setup → Permissions

What workers may do on the server without asking. Pick one level:

- **Read only:** read files and the web, and use tools only to look things up.
- **Standard:** also edit and write files. Shell commands only to read their own files and saved tool results.
- **Shell for listed commands:** also run the commands you list, one per line, by how they start (`npm test`, `jq`). Any other command is refused.
- **Everything:** any tool and any command, without asking.

**More tools by name** adds single tools at any level, such as one connector's write (`mcp__acme-tracker__create_issue`). A tool added here is used without asking, whatever the worker's trust level, so add one only when workers should act with it on their own.

The server caps the level with `--max-access` (the compose file uses `shell`); levels above it are greyed out. Until you save a level, workers get what the server was started with (`--allow-tool`), and the page shows which level that comes to. Repo grants (git and each repo's test command) are added on top while a repo is connected. Changes apply within a few seconds.

**Refused in the last week** lists each worker's refused tools, how often, and an example. Raise the level when a worker keeps running into the same one. The counts start again when the server restarts.

The level and the trust level are separate: trust decides how much work a worker starts without a manager's OK; the level decides which tools any worker may use at all.

## Setup → Secrets in answers

On by default. Credentials are replaced with `[REDACTED]` in everything workers say to people: Slack, the console, MCP, attached text files and notifications. See [Security model](security.md#secrets).

## Setup → Model ids

On Bedrock (`CLAUDE_CODE_USE_BEDROCK=1`) or Vertex (`CLAUDE_CODE_USE_VERTEX=1`), the id each model goes by there. The page says which provider the server uses and lists every Claude model overcli offers, each with its default in grey: on Bedrock `anthropic.<id>`, on Vertex the id as it is.

- **Every model not set below:** one pattern for all of them, with `{id}` standing for the model's id. Most Bedrock accounts call models through an inference profile: `us.anthropic.{id}` (or `eu.`, `apac.`, `global.`).
- **A row per model:** set one when its id differs, such as an application inference profile's ARN.
- **Other models:** ids overcli doesn't list yet, one per line as `overcli id = provider id`.
- **Reset to defaults** clears them all.

Copy the ids from the Bedrock or Vertex console. The aliases Claude Code resolves itself (`opus`, `sonnet`, `haiku`) are left alone, so the server's `ANTHROPIC_DEFAULT_*_MODEL` settings still apply to them.

## People

- **Invite:** pick someone from Slack. They get a one-time link by DM, or you copy it.
- **Join requests:** `/overgo join` in Slack lands here for you to let in, or lets people straight in with `openJoin`. `/overcli join` still works for Slack apps installed before the rename.
- **Roles:** member, hirer, approver, admin.
- **Offboard:** hand all of someone's workers to another manager and sign them out everywhere, in one step.
- **Keys:** each person's sign-ins (browsers, the desktop app, Claude) are listed and can be signed out one by one.

## Activity

The decision log: hires, approvals, rule changes, secrets set (by name), repos connected, trust changes. It's searchable and exports to CSV. Retention follows the org's rules.

## The Monday digest

Every Monday at 9am in the org's time zone, overgo DMs a short week in review:

- **To each manager:** for each of their workers, what it finished, what failed, how many times it was asked, what it cost, and how people rated it. Then how much is waiting on them.
- **To admins,** as well: the org's totals, the cost per finished item, tools that are failing, and tool requests waiting.

`/overgo digest` sends this week's so far, any time. Someone with nothing to report gets nothing.

## Day to day

- **Back up the data volume.** It's everything: workers, journals, the Library, sign-ins, rules, encrypted secrets.
- **Run one server per Slack app.** A second one on the same tokens takes replies meant for the first.
- **Upgrade** by running the new image on the same volume: set `OVERCLI_VERSION` in `deploy/.env` (a minor version like `0.23` takes fixes as they come), then `docker compose pull && docker compose up -d`. **Setup → Readiness** says what version runs and when a newer one is out. Everything lives on the volume, so nothing is lost:
  - runs cut short carry on by themselves;
  - a question a worker was still answering is asked again;
  - Slack's team cards catch up.

  If the release notes say the Slack manifest changed, update the app from the new manifest and reinstall it.
- **Logs** go to stdout: startup, Slack, the secrets store, the control plane.

The [operator's guide](../README.md) covers the container itself.
