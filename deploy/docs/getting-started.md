# Getting started

Three stops: try it on your laptop, run it in Docker, then put it in your cloud. Each uses the same server, so what you set up carries over.

## 1. On your laptop

You need Node 22, a signed-in Claude Code CLI (or Bedrock or Vertex credentials), and a checkout of overcli.

```sh
npm install
npm run dev:serve        # builds, then runs the server on port 7420, rebuilding as you save
```

The first start prints a one-time link:

```
control: nobody has signed in yet. Open this once to sign in as the first admin: http://localhost:7420/join/…
```

Open it, and you're the admin. Then, in the console:

1. **Setup → Readiness:** this says what's missing.
2. **Hire** a worker, or publish one from the desktop app: turn on **Settings → Labs → Org workers · alpha**, then go to **Settings → Your org**, sign in with `http://localhost:7420`, and use **Publish to your org** on a worker.
3. **Ask it something** from its page.

Secrets you set on **Setup → Secrets** are kept in an encrypted file in the server's state folder, with its key in your Mac's login keychain.

### Add Slack (optional)

1. At api.slack.com/apps, create an app **from a manifest** and paste `src/main/slack/slack-app-manifest.yml`. Install it to a test workspace.
2. On **Setup → Secrets**, set `OVERCLI_SLACK_BOT_TOKEN` (xoxb-…) and `OVERCLI_SLACK_APP_TOKEN` (xapp-…).
3. Run the server with `OVERCLI_SLACK_ENABLED=1 npm run dev:serve`.
4. Say who the org is, so Slack knows who's an admin:
   ```sh
   node dist/cli/index.js org init --name "Acme" --admin <your Slack member ID> --slack-team <workspace ID> --url http://localhost:7420
   ```
5. DM the app "what can you do?", or mention it in a channel it's in.

Don't run two servers, or the desktop app's Slack bridge, on the same Slack app: they take each other's replies.

## 2. In Docker

```sh
cp deploy/.env.example deploy/.env      # the model, and where secrets live
docker compose -f deploy/docker-compose.yml pull   # the published image
docker compose -f deploy/docker-compose.yml up -d
docker compose -f deploy/docker-compose.yml logs -f    # the first-admin link is here
```

Everything the server keeps lives on the `/data` volume: workers, journals, the Library, sign-ins, the org's rules and the encrypted secrets. Back it up.

The [operator's guide](../README.md) covers the details: permissions, the volume, a reverse proxy, upgrades.

## 3. In your cloud

- **AWS:** [EC2 or Fargate](../aws.md). Fargate with EFS at `/data` and one task at a time. Bedrock for the model, through the task role. Secrets in Secrets Manager (`OVERCLI_SECRETS=aws:overcli/acme/`), so nothing secret sits on the disk or in the task definition.
- **Google Cloud:** [Compute Engine](../gcp.md). Vertex for the model, and Secret Manager for secrets.

Either way, give the server a private HTTPS address (an internal load balancer or your VPN). Set it as `publicUrl` in `org.json` so links sent from Slack point there.

## Next

- [For admins](admins.md): connect repos, add tools, set the rules, invite people.
- [Using workers](using.md): what to tell everyone else.
