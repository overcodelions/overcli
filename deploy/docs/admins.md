# For admins

Admins set the server up and keep it healthy. Most of this lives on the console's **Setup** page, with people and the decision log on **People** and **Activity**.

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

- **Install** with a command (`npx -y @acme/jira-mcp`) or a URL (a remote MCP server), plus its settings.
- **Workers published from the desktop app** bring their tools' setup with the secret values removed. Installing them here is then pre-filled.
- **Tools that sign in through a browser** are signed in once, by you, for the whole org. See [Remote tools that sign in](#remote-tools-that-sign-in) below.

### Remote tools that sign in

Many remote MCP servers ask you to sign in on their own page instead of pasting a token. Nobody on a server can press "Allow", so you sign in for it:

1. **Install a tool → A remote server, by URL.** Paste the address. The form checks how the server signs in:
   - **No sign-in needed:** install it as it is.
   - **Wants a token:** paste it as a header, such as `Authorization: Bearer …`.
   - **Signs in with** the service's name: the button becomes **Sign in and install**.
2. **Sign in** on the service's page and approve. You come back to Setup → Tools, and the tool is installed.
3. **Give it to workers** with **Manage**, as with any tool.

> [!IMPORTANT]
> Every worker you give the tool acts as the account you signed in with. Use a service or bot account where the service has one, rather than your own.

**Behind the scenes:**

- overcli registers itself as an app with the service the first time.
- It signs in with PKCE, keeps the refresh token encrypted in `org/tool-signins.json`, and renews the sign-in itself. Every run starts with at least half an hour left on it.
- Workers only ever see a short-lived access token.
- Removing the tool ends the sign-in at the service, where the service allows it.

**Signing in again.** **Manage → Sign in again** replaces the account. Do it when the tool shows **Signed out**: the service ended the sign-in, or the account lost access.

**When the service won't register apps.** Some services only accept apps made by hand. The form says so, and shows the redirect address (the console address followed by `/oauth/tools/callback`). Make an OAuth app on the service with that address, then paste its client ID and secret into the form.

**A tool you already installed with a token.** **Manage → Sign in for everyone** switches it to a sign-in. The pasted token is replaced.

> [!NOTE]
> The redirect address uses the server's public address (`publicUrl`) when it's set. Set it before signing tools in, or a service may send you back to an address it can't reach.


**Who can use a tool.** Each tool on Setup → Tools has three levels:

- **Workers you pick:** you give it to each worker that needs it (**Give it to a worker**). Use this for anything that changes systems people rely on, or that uses one person's key.
- **Any manager can give it:** managers add it to their own workers without asking an admin. Use this for tools that write, but where a mistake is cheap.
- **Every worker:** every worker has it, including future hires. Use this for tools that only read. Before you switch it on, the console lists the tool's actions that can change things.

Workers that ask first still ask before any step that changes something, whatever a tool's level.
## Setup → Repos

Code repos workers may change. See also [Security model](security.md#code).

1. **Give the server a way to push.** Set the host's token on **Setup → Secrets**: `GH_TOKEN` (GitHub), `BITBUCKET_TOKEN` (Bitbucket Cloud) or `GIT_TOKEN` + `GIT_USER` (any other host). Or connect with a `git@` address and an ssh key on the server.
2. **Connect** the repo: its address, and the test command to run before every push.
3. **Let a worker change it:** pick the worker and press **Let it change this repo**.

Protect the default branch on your git host as well (required reviews, no force pushes). The server refuses pushes to it, but the host is the real guard.

**Workspaces** group repos that change together, like an API and the app that uses it.

- **Making one:** **Make a workspace** at the bottom of the tab. Pick the repos, and add instructions every run reads (which repo owns what, what must stay in step).
- **Using one:** point a worker at it with **Let it change this workspace**, or set a team's **Works in** to it.
- **What a run does:** each run gets its own worktree of every repo. The server pushes one branch per changed repo, each past that repo's tests, and the reply has one pull request link per repo.
- **Changing or removing it:** **Change** edits the repos or instructions, and workers in it use the new setup from their next run. A workspace can't be removed while a worker works there.

## Setup → Secrets

Every secret the server uses, with why it's needed and how to get one. Values go in and are never shown again; changes apply at once and are recorded by name in the decision log. Where they're kept depends on `OVERCLI_SECRETS`:

| Setting | Kept in | Notes |
|---|---|---|
| unset | an encrypted file on the data volume | Key from `OVERCLI_SECRETS_KEY`, the Mac login keychain, or a key file beside it (warned about) |
| `aws:overcli/acme/` | AWS Secrets Manager | Through the instance or task role; see [the policy](../aws.md#secrets-policy) |
| `gcp:<project>/overcli-` | GCP Secret Manager | Through the service account |

- **The environment wins.** A secret set in the server's environment (`deploy/.env` or the task definition) shows as "set by the environment" and is changed there.
- **Read-only mode:** with `OVERCLI_SECRETS_READONLY=1`, for secrets managed in Terraform, the page lists them and changes nothing. The server re-reads them every five minutes either way.

## Google Drive for everyone

People can save a team's files into their own Google Drive, as themselves. There are two steps, done by different people:

- **An admin, once:** register overcli with Google for the whole org. This connects nobody's Drive; it only lets overcli ask Google.
- **Each person, for themselves:** connects their own Google account from their menu (**Your connections**) and approves it on Google's own page. Their files then save into their Drive, in a folder called `overcli`.

> [!NOTE]
> Set the console address first (**Setup → Rules**, or `publicUrl` in `org.json`). The redirect address Google needs is built from it, and connecting only works from that address. `localhost` is fine for trying it on one machine.

### Turning it on

1. **Pick a Google Cloud project.** In console.cloud.google.com, choose or create one for overcli.
2. **Turn on the Google Drive API.** APIs & Services → Library → *Google Drive API* → Enable.
3. **Set up the consent screen.** APIs & Services → OAuth consent screen (or Google Auth Platform → Branding and Audience).
   - **Internal** if everyone uses your company's Google Workspace: only your accounts can connect, and Google needs no review.
   - **External** only for personal Gmail. While it's in *Testing*, add each person as a test user; their access lasts 7 days at a time.
   - App name *overcli*, your support email, and the scope `…/auth/drive.file`. Nothing broader.
4. **Create the OAuth client.** Credentials → Create credentials → OAuth client ID → *Web application*. Under **Authorized redirect URIs** add the console address followed by `/oauth/google/callback`. **Your connections** shows the exact address with a Copy button. Leave JavaScript origins empty.
5. **Give overcli the client.** On **Setup → Secrets**, add `GOOGLE_OAUTH_CLIENT_ID` and `GOOGLE_OAUTH_CLIENT_SECRET`. They apply at once.
6. **Check it.** **Your connections** now shows *Connect Google Drive*. Connect your own account first to try it.

### What overcli can reach

- Only files it creates, in each person's `overcli` folder (the `drive.file` permission). It can't list, open or change anything else in their Drive.
- Each person's Google access is stored on the server, encrypted, under a key kept in the secrets store. It never reaches workers, the console or a URL.
- A connection can only be started by a signed-in person, in their own browser, within ten minutes, so a forwarded Google link can't attach someone else's Drive to your account.
- Disconnecting revokes the access at Google. People can also remove *overcli* from their Google account's third-party access.

### If connecting fails

| What you see | Why |
|---|---|
| `redirect_uri_mismatch` on Google's page | The redirect address in step 4 doesn't exactly match the server's, including `http`/`https` and the port. |
| "Access blocked" or "app not verified" | The consent screen is External and the person isn't a test user, or it should be Internal. |
| "Came back to a different browser or address" | The connection was started from an address other than the console address. |
| "Didn't give lasting access" | The person connected before. They remove *overcli* from their Google account's third-party access, then connect again. |

## Setup → Rules, spending and sign-in

The org's rules, kept in `org.json` on the volume and editable here (or by Claude with `set_org_rules`). Every change is checked and logged.

- **Who may hire:** everyone, or a list of people.
- **Allowances:** what one person's workers may cost a month before a hire needs an approver; per-person overrides; who the approvers are.
- **Org budget:** what all workers together may cost a month. At the cap, scheduled runs stop until the month turns. Warnings go out at `alertAtPercent` (80% by default).
- **Approved tools:** connectors any hire gets without approval.
- **Roles:** the catalog on the Hire page. Each role is a job, its cleared tools, and a budget.
- **Visibility:** whether "everyone may ask it" needs an admin.
- **Reading the web:** whether workers ask before searching the web or opening a page. Off by default; see [Security model](security.md#reading-the-web).
- **Company sign-in:** OpenID Connect (Okta, Entra ID, Google Workspace). Enter the issuer and client ID here; a confidential client's secret goes on Setup → Secrets as `OVERCLI_SSO_CLIENT_SECRET`. "Everyone signs in this way" turns invite links into role grants.

## People

- **Invite:** pick someone from Slack. They get a one-time link by DM, or you copy it.
- **Join requests:** `/overcli join` in Slack lands here for you to let in, or lets people straight in with `openJoin`.
- **Roles:** member, hirer, approver, admin.
- **Offboard:** hand all of someone's workers to another manager and sign them out everywhere, in one step.
- **Keys:** each person's sign-ins (browsers, the desktop app, Claude) are listed and can be signed out one by one.

## Activity

The decision log: hires, approvals, rule changes, secrets set (by name), repos connected, trust changes. It's searchable and exports to CSV. Retention follows the org's rules.

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
