# overgo for your org (alpha)

overgo is the org server for overcli: one container that runs `overcli serve`.

overcli workers are AI colleagues that each own a job, such as triaging bugs, writing the weekly competitive brief, or answering questions about the billing code. On a laptop, one person builds and runs them. Hosted for an org, anyone can ask them for things from Slack, managers approve what they do, and the results are kept where people can find them.

> **Alpha.** This is early. Expect rough edges and changes between versions, and back up the data volume.

These pages are also built into every org server: open **/docs** on your server's address.

## Start here

| If you want to… | Read |
|---|---|
| Understand what this is and how a request flows | [Overview](overview.md) |
| Try it on your laptop, then run it for real | [Getting started](getting-started.md) |
| Ask workers for things | [Using workers](using.md) |
| Look after workers you manage | [For managers](managers.md) |
| Set up and run the server | [For admins](admins.md) |
| Know what workers can and can't do | [Security model](security.md) |
| Look up a setting, command or tool | [Reference](reference.md) |

## Deploying

- [Docker and compose](../README.md): the operator's guide, covering the image, the volume, Slack and day-to-day operation.
- [AWS](../aws.md): EC2 or Fargate, Bedrock, Secrets Manager.
- [Google Cloud](../gcp.md): Compute Engine, Vertex AI, Secret Manager.
