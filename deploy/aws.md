# overcli for an org on AWS (alpha)

> **Alpha.** The org layer is early: expect changes, and back up `/data`.

**Prefer one click?** [deploy/aws/README.md](https://github.com/overcodelions/overcli/blob/master/deploy/aws/README.md) builds the recommended setup below as one CloudFormation stack.

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
   The CloudFormation template runs the container on the host network so the server can read Secrets Manager and Bedrock through the instance role. Accepted risk: code a worker runs inside the container can reach that role too, so keep the role to Bedrock invoke and the `overcli/<Org>/` secrets prefix only. Repo test commands do not run in this setup unless you set `OVERCLI_TEST_AS_SERVER=1` in `deploy/.env` (the container cannot switch user), so until then a repo with a test command pushes nothing; connect it without one, or decide that trade-off with the role kept that small.
5. **Secrets.** Keep them in Secrets Manager, managed from the console. In `deploy/.env`, set `OVERCLI_SECRETS=aws:overcli/acme/`. Then add the git host tokens, Slack tokens and SSO client secret on **Setup → Secrets**. They're written to Secrets Manager under that prefix and used at once, with no restart. Give the instance role the [secrets policy](#secrets-policy) below. Never bake secrets into the image.
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
9. **Egress.** Through a NAT gateway: `slack.com`, `wss-primary.slack.com`, `wss-backup.slack.com`, your git host, and package registries if your tools use `npx` or `uvx`. `uvx` also fetches its Python from `github.com` the first time.

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
- **Fargate with EFS** works too:
  - Mount EFS at `/data` (uid 1000).
  - Set `desiredCount: 1`, `maximumPercent: 100` and `minimumHealthyPercent: 0`, so a deploy never runs two tasks at once.
  - Set `OVERCLI_SECRETS=aws:overcli/acme/` in the task definition's environment, and give the task role the secrets policy below. Nothing secret then lives on EFS or in the task definition, and secrets set on the console survive every redeploy.
  - Secrets you'd rather inject through the task definition's own `secrets` block still work. They show on the console as "set by the environment" and win.
  - EFS is slower for git worktrees, which makes runs feel sluggish on big repos.

## Secrets policy

The role overcli runs as (instance role or task role) needs this on its prefix. Drop the write actions and set `OVERCLI_SECRETS_READONLY=1` if Terraform manages the secrets instead; the console then lists them and points there.

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": ["secretsmanager:ListSecrets"],
      "Resource": "*"
    },
    {
      "Effect": "Allow",
      "Action": [
        "secretsmanager:GetSecretValue",
        "secretsmanager:DescribeSecret",
        "secretsmanager:CreateSecret",
        "secretsmanager:UpdateSecret",
        "secretsmanager:DeleteSecret",
        "secretsmanager:RestoreSecret",
        "secretsmanager:TagResource"
      ],
      "Resource": "arn:aws:secretsmanager:<region>:<account>:secret:overcli/acme/*"
    }
  ]
}
```

With a customer-managed KMS key, add `kms:Decrypt` and `kms:GenerateDataKey` on it. overcli reads the secrets at start and every five minutes, so one rotated in Secrets Manager applies without a redeploy.

## CloudWatch logs for workers

Workers can read CloudWatch logs through AWS's CloudWatch MCP server, using the role overcli already runs as. There is no key to paste and nothing to renew: the instance or task role's credentials rotate on their own, and the tool starts fresh for each run.

1. **Give the role read access to the log groups workers may see.** Name them, or end a name with `*` for every group under a prefix (`/ecs/acme-*`). A bare `*` gives every group, which is rarely what you want.

    ```json
    {
      "Version": "2012-10-17",
      "Statement": [
        {
          "Effect": "Allow",
          "Action": ["logs:DescribeLogGroups", "logs:StopQuery"],
          "Resource": "*"
        },
        {
          "Effect": "Allow",
          "Action": [
            "logs:DescribeLogStreams",
            "logs:GetLogEvents",
            "logs:FilterLogEvents",
            "logs:StartQuery",
            "logs:GetQueryResults",
            "logs:GetLogGroupFields",
            "logs:GetLogRecord"
          ],
          "Resource": [
            "arn:aws:logs:<region>:<account>:log-group:/acme/api:*",
            "arn:aws:logs:<region>:<account>:log-group:/ecs/acme-*:*"
          ]
        }
      ]
    }
    ```

    `DescribeLogGroups` and `StopQuery` can't be limited to log groups. Workers can list every group's name, but read only the groups named here. `StopQuery` only stops a query the role started.

2. **Install the tool** on Setup → Tools → Install a tool, as a command:
    - Name: `cloudwatch`
    - Command: `uvx`, arguments `awslabs.cloudwatch-mcp-server@latest`
    - Environment: `AWS_REGION=<region>`

    The image includes `uv`. The first run downloads the server and its Python into the volume, so it takes a minute; later runs start at once.
3. **Give it only to the workers that need it,** and leave its scope as the whole tool. The role is what keeps it read-only, and overcli's "Read only" scope judges calls by name, so it would refuse queries like `execute_log_insights_query`.

**Treat it as confidential.** Logs often carry customer data, and a worker that's trusted to act and has a shell can use whatever the role can. Keep the role's log access to the groups above, and make the tool admin-only on Setup → Tools.

The one-click stack sets up step 1's policy for you: name the groups in **Log groups workers may read** (`deploy/aws/README.md`).

### Inside a private VPC

Everything here goes out from the server; nothing has to reach it.

- **CloudWatch's APIs.** Through the NAT gateway (`logs.<region>.amazonaws.com`, `monitoring.<region>.amazonaws.com`), or VPC interface endpoints for `logs` and `monitoring` to keep them inside the VPC. The stack makes both endpoints when **Private CloudWatch endpoints** is yes.
- **The first run of the tool.** `uvx` downloads the server from PyPI (`pypi.org`, `files.pythonhosted.org`) and a Python build from `github.com`, once, into `/data`. Without a route to those, run the tool once from a machine that has one, or bake it into the image.

### Alarms that start a worker

Let CloudWatch decide what's wrong, and let the worker find out why:

1. **An alarm for each thing you care about.** For a pattern in the logs ("more than 20 5xx in 5 minutes", "any `OutOfMemory`"), make a metric filter on the log group and an alarm on that metric. That's cheaper than a worker reading logs on a timer, and it only fires on real trouble.
2. **A watch trigger on the alarms.** On the worker, add a trigger: **Something new or changed in a tool** → tool `cloudwatch` → **Set it up for CloudWatch alarms**. It asks `get_active_alarms` every 5 minutes with no model running. Each alarm that goes off is handed to the worker once; one that recovers and goes off again is handed over again.
3. **What the worker does.** The setup fills in a starting point: pull the logs around the alarm with a Logs Insights query, find the likely cause, and post a summary. Send it to a Slack channel, a DM or a team. On probation it proposes; trusted, it acts. **At most per day** keeps an alarm that flaps from running up cost.

An alarm can take up to the watch's interval (5 minutes) to reach the worker. A webhook from EventBridge would be instant, but EventBridge can't reach a server behind an internal load balancer.

## Not a fit

**Lambda and App Runner.** overcli is one long-lived process: it holds Slack's connection, fires schedules and keeps worktrees on disk.
