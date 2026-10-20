# Launch on AWS (alpha)

One CloudFormation stack, [`overcli.yaml`](overcli.yaml), builds the setup [`../aws.md`](../aws.md) recommends: one instance in a private subnet, `/data` on its own disk with daily snapshots, Bedrock for the model, Secrets Manager for secrets, and an internal load balancer in front of the console.

[![Launch Stack](https://s3.amazonaws.com/cloudformation-examples/cloudformation-launch-stack.png)](https://console.aws.amazon.com/cloudformation/home#/stacks/create/review?stackName=overcli&templateURL=https://<your-bucket>.s3.amazonaws.com/overcli.yaml)

```markdown
[![Launch Stack](https://s3.amazonaws.com/cloudformation-examples/cloudformation-launch-stack.png)](https://console.aws.amazon.com/cloudformation/home#/stacks/create/review?stackName=overcli&templateURL=https://<your-bucket>.s3.amazonaws.com/overcli.yaml)
```

CloudFormation only launches a template from S3. Upload `overcli.yaml` to a bucket you own, then put its URL in `templateURL=` above. Add `region=us-east-1&` after `home?` to pick the region. Or skip the button:

```sh
aws cloudformation deploy --template-file deploy/aws/overcli.yaml --stack-name overcli \
  --capabilities CAPABILITY_IAM \
  --parameter-overrides OrgName=acme VpcId=vpc-0acme PrivateSubnetId=subnet-0acmea SecondPrivateSubnetId=subnet-0acmeb
```

## Before you start

- **A VPC with two private subnets** in different Availability Zones, and a **NAT gateway**. The instance needs it for packages, the container image, Slack and your git host.
- **The image.** By default it pulls `ghcr.io/overcodelions/overcli-server:latest`, published by each release. To pin a version or use your own build, push `deploy/Dockerfile` to ECR (see [`../aws.md`](../aws.md), step 6) and put that URI in **Container image**.
- **Bedrock model access** for Claude in the region you'll use.

## What it asks

1. **Org name.** A short lowercase name, like `acme`. Secrets go under `overcli/acme/` in Secrets Manager.
2. **Where it runs.** The VPC, the two private subnets, and who may reach the console (default `10.0.0.0/8`; narrow it to your VPN).
3. **HTTPS (optional).** An ACM certificate and the name people will use (`overcli.acme.internal`). With them, the console is on HTTPS and port 80 redirects. Without, it's plain HTTP on 80, inside the VPC only. Point your DNS record at the `LoadBalancerDnsName` output.
4. **Advanced** (the defaults are fine): the image, the instance type (`t3.large`), the disk size (50 GiB), the Bedrock region (the stack's), and an AMI to pin.

## What it creates

| | |
|---|---|
| EC2 instance | Amazon Linux 2023, private subnet, no public IP, no SSH key. IMDSv2 only, one hop. You get in with Session Manager. |
| Data volume | EBS gp3, encrypted, mounted at `/srv/overcli-data` and passed to the container as `/data`. It's only formatted when it's empty. |
| Snapshots | A Data Lifecycle Manager policy: daily, keep 14. |
| Instance role | Bedrock invoke, Secrets Manager under `overcli/<org>/*` ([the secrets policy](../aws.md#secrets-policy)), ECR pull, Session Manager, and writing one SSM parameter: the sign-in link. |
| The server | A systemd unit runs one container on the host network, restarting it if it stops. It uses Bedrock, Secrets Manager and the same tool allow-list as `docker-compose.yml`. |
| Load balancer | Internal ALB. The console is open to your CIDR; the instance takes 7420 from the ALB only. The health check is on `/healthz`. |

The stack finishes only once the container is up and the sign-in link is stored. If setup fails, the stack shows why. The full log is `/var/log/overcli-setup.log` on the instance.

## Sign in

On first start, `overcli serve` makes a one-time link that signs in the first admin. The stack stores it, encrypted, in SSM. Run the **GetFirstAdminLinkCommand** output:

```sh
aws ssm get-parameter --with-decryption --region us-east-1 \
  --name /overcli/overcli/first-admin-link --query Parameter.Value --output text
```

Open the link once, from inside the VPC. Then invite everyone else from the console, and add your Slack and git tokens on **Setup → Secrets**.

If the link no longer works (the server restarted before anyone used it), get a fresh one. Open a shell with **SessionManagerCommand**, then run `sudo docker logs overcli 2>&1 | grep "first admin" | tail -1`.

## Upgrading

Update the stack with a new **Container image** (a new tag), keeping every other answer. Within a few minutes the instance notices the change, pulls the image and restarts the container on the same `/data`. Nothing is lost. To restart by hand: `sudo systemctl restart overcli`.

Leave **AMI** blank and the instance keeps the AMI it started with. Updating to a new AMI replaces the instance, and CloudFormation can't move the data volume to the new instance in one update. Patch in place with `sudo dnf upgrade` instead.

## Deleting

Deleting the stack removes everything except:

- **A final snapshot of the data volume.** The daily snapshots stay too, until you delete them. To come back, restore the snapshot to a volume and attach it at `/dev/sdf` on a new instance (see [If the instance dies](../aws.md#if-the-instance-dies)).
- **The secrets under `overcli/<org>/`.**
- **The sign-in link parameter.** It's written by the instance, so the stack doesn't own it. Delete it with `aws ssm delete-parameter --name /overcli/<stack>/first-admin-link`.
