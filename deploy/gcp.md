# overcli for an org on Google Cloud (alpha)

> **Alpha.** The org layer is early: expect changes, and back up `/data`.

## What has to survive

The container is disposable. Everything that matters lives in **`/data`**:

- workers, journals and runs
- `org.json` and sign-ins
- the decision log
- installed tools and cloned repos

Replace the container freely; keep `/data` on a persistent disk and snapshot it.

**Run only one at a time.** Run exactly one container against one `/data` and one Slack app.

## Recommended: one Compute Engine VM, no public IP

1. **VM.** `e2-standard-2` or larger, Debian 12, no external IP, in your VPC. Install Docker and the compose plugin.
2. **Disk.** Add a persistent disk (balanced, 50–100 GB). Mount it at `/srv/overcli-data` through `/etc/fstab`, then `sudo chown -R 1000:1000 /srv/overcli-data`.
3. **Snapshots.** Attach a snapshot schedule to the disk: daily, keep 14.
4. **Model.** Use Vertex AI, with no API key on the box. Give the VM's service account `roles/aiplatform.user`. In `deploy/.env`:
   ```
   CLAUDE_CODE_USE_VERTEX=1
   CLOUD_ML_REGION=us-east5
   ANTHROPIC_VERTEX_PROJECT_ID=<project>
   ```
   Turn on Private Google Access on the subnet so Vertex is reached privately.
5. **Secrets.** Keep them in Secret Manager, managed from the console:
   - In `deploy/.env`, set `OVERCLI_SECRETS=gcp:<project>/overcli-acme-`.
   - Give the VM's service account `roles/secretmanager.admin` on the project, or `roles/secretmanager.secretAccessor` with `OVERCLI_SECRETS_READONLY=1` if you manage the secrets yourself.
   - Add the git host tokens, Slack tokens and SSO client secret on **Setup → Secrets**. They're used at once and re-read every five minutes.
6. **Image.** Build and push to Artifact Registry.
   ```sh
   docker build -f deploy/Dockerfile -t <region>-docker.pkg.dev/<project>/overcli/overcli-org:<version> .
   docker push <region>-docker.pkg.dev/<project>/overcli/overcli-org:<version>
   ```
7. **Run.**
   ```sh
   export OVERCLI_DATA=/srv/overcli-data
   docker compose -f deploy/docker-compose.yml up -d
   ```
   Change the compose port mapping to `"7420:7420"`. A firewall rule should allow 7420 only from the load balancer's proxy subnet.
8. **HTTPS.** Use an internal Application Load Balancer with a managed or self-managed certificate. Back it with an unmanaged instance group holding the VM, port 7420, health check `/healthz`. Set `OVERCLI_TRUST_PROXY=1`, and `publicUrl` in `org.json`.
9. **Egress.** Through Cloud NAT: Slack, your git host, and package registries for `npx`/`uvx` tools.

### Upgrading and recovering

Upgrading is `docker compose pull && docker compose up -d`; `/data` stays.

If the VM is lost, create a new one, attach the disk (or a disk made from the latest snapshot) at `/srv/overcli-data`, and start the stack.

## Alternative: GKE

Use a `StatefulSet` with `replicas: 1`, a `PersistentVolumeClaim` on `/data` (`fsGroup: 1000`), and the `Recreate` update strategy, so two pods never share the volume. Use Workload Identity for Vertex.

## Not a fit

**Cloud Run and Cloud Functions.** overcli needs one long-lived process with a real disk.
