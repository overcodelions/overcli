# overcli for an org on AWS (alpha)

> **Alpha.** The org layer is early: expect changes, and back up `/data`.

## What has to survive

The container is disposable. Everything that matters lives in **`/data`**:

- workers, their journals and runs
- `org.json` and sign-ins
- the decision log
- installed tools (`/data/home/.claude.json`) and cloned repos

Replace the container whenever you like (an upgrade, a crash, a new instance). As long as the same `/data` comes back, nothing is lost. **Lose `/data` and the org loses its workers.**

So on AWS the job is to put `/data` on a durable disk, snapshot it, and run exactly one container against it.

**Run only one at a time.** overcli takes a lock on `/data`, and Slack's Socket Mode would split events between two copies. Never run two copies against the same data or the same Slack app.

## Recommended: one EC2 instance in a private subnet

```
          VPC (private subnets)
 ┌───────────────────────────────────────────────┐
 │  internal ALB (HTTPS, ACM cert) ──► EC2 :7420  │
 │                                     │ docker   │
 │                                     │ /data ◄── EBS gp3 (snapshots daily)
 │  VPC endpoint: Bedrock ◄────────────┤          │
 │  NAT ──► slack.com, git host        │          │
 └───────────────────────────────────────────────┘
```

1. **Instance.** `t3.large` or similar, Amazon Linux 2023 or Ubuntu, in a private subnet. Install Docker and the compose plugin.
2. **Disk.** Attach an EBS gp3 volume (50–100 GB; worktrees add up). Format it and mount it at `/srv/overcli-data` through `/etc/fstab`, then `sudo chown -R 1000:1000 /srv/overcli-data`.
3. **Snapshots.** Add a Data Lifecycle Manager policy for that volume: daily, keep 14.
4. **Model.** Use Bedrock, so no API key sits on the box. Give the instance role `bedrock:InvokeModel` and `bedrock:InvokeModelWithResponseStream`, and add a VPC interface endpoint for `bedrock-runtime`. In `deploy/.env`:
   ```
   CLAUDE_CODE_USE_BEDROCK=1
   AWS_REGION=us-east-1
   ```
5. **Secrets.** Keep the Slack tokens and `OVERCLI_SSO_CLIENT_SECRET` in Secrets Manager or SSM Parameter Store, and write them into `deploy/.env` at boot from user data. Never bake them into the image.
6. **Image.** Build once and push to ECR. The instance pulls it.
   ```sh
   docker build -f deploy/Dockerfile -t <acct>.dkr.ecr.<region>.amazonaws.com/overcli-org:<version> .
   docker push <acct>.dkr.ecr.<region>.amazonaws.com/overcli-org:<version>
   ```
7. **Run.**
   ```sh
   export OVERCLI_DATA=/srv/overcli-data
   docker compose -f deploy/docker-compose.yml up -d
   ```
   Change the compose port mapping to `"7420:7420"` so the load balancer can reach it. The instance's security group should allow 7420 only from the ALB.
8. **HTTPS.** Put an internal ALB in front with an ACM certificate, a target group on 7420, and the health check on `/healthz`. Set `OVERCLI_TRUST_PROXY=1` in `.env`, and `publicUrl` in `org.json` to the ALB's name (e.g. `https://overcli.acme.internal`).
9. **Egress.** Through a NAT gateway: `slack.com`, `wss-primary.slack.com`, `wss-backup.slack.com`, your git host, and package registries if your tools use `npx` or `uvx`.

### Upgrading

Push a new image tag, then:

```sh
docker compose -f deploy/docker-compose.yml pull && docker compose -f deploy/docker-compose.yml up -d
```

The old container stops and the new one picks up the same `/data`.

### If the instance dies

Launch a new instance and attach the same EBS volume (or one restored from the latest snapshot) at `/srv/overcli-data`. Bring the stack up again. Workers, sign-ins, tools and schedules are all as they were; a run that was in flight is marked as interrupted.

## Alternative: ECS

ECS works, with care:

- **ECS on EC2 with an EBS-backed volume** is closest to the setup above.
- **Fargate with EFS** works too. Mount EFS at `/data` (uid 1000) and set `desiredCount: 1`, `maximumPercent: 100` and `minimumHealthyPercent: 0`, so a deploy never runs two tasks at once. EFS is slower for git worktrees, which makes runs feel sluggish on big repos.

## Not a fit

**Lambda and App Runner.** overcli is one long-lived process: it holds Slack's connection, fires schedules and keeps worktrees on disk.
