# Overview

## What a worker is

A worker is an AI colleague with one job, written down as a job description: what it's for, which sources it uses, what good work looks like. Behind the description sit:

- **Flows:** the steps it knows how to run, such as plan, change, test, push. Each step has its own model and tools.
- **A journal:** what it did, what people thought of it, and what it learned. It reads the journal before each piece of work, so it doesn't repeat itself or repeat mistakes.
- **A manager:** the person who answers its questions and approves what it wants to do outside the server.
- **A trust level:** probation, trusted or autonomous. This decides what it may do without asking.
- **A budget:** what it may spend a month.

Workers can also work as a **team**: a coordinator plans a task, the members each do a piece, and the result comes back as one package.

## Two ways to run it

| | The desktop app | The org server |
|---|---|---|
| Who | One person | Everyone in the org |
| Where | Your Mac | A container: Docker, Fargate, a VM |
| Asking | The app | Slack, the web console, Claude (MCP) |
| Approvals | You, in the app | Each worker's manager, in Slack or the console |
| Secrets | Your keychain | The server's secrets store |

People build workers in the app and publish them to the org's server when they're ready to share: **Publish to your org** on a worker or a team.

## How a request flows

```flow
ask: Someone in Slack | "@overgo add an export button to the reports page", with the thread and any screenshots
step: Who should take it? | The worker they named, else one whose job fits, else a model picks, else it asks the person | "Triage has this."
step: The worker plans | From its job, its journal and the thread | Its answer
step: If it starts work | Plan, change, test; the manager approves the push; then it pushes a branch | The manager is asked in Slack
step: When the work ends | The run finishes and files what it made | "Branch pushed. Open a pull request: <link>", with the report, files and a Library link
```

Work also starts without anyone asking:

- **Schedules:** "every weekday at 9".
- **Triggers:** a new ticket matching a search, a webhook from GitHub or Jira, an emoji reaction in a Slack channel.

Every result lands in the **Library**, the record of everything workers delivered, with how long each item took, what it cost and whether people found it useful.

## Where people meet it

- **Slack:** mention `@overgo` anywhere or DM it. Managers get their workers' questions and approvals as DMs. `/worker`, `/team` and `/hire` work too.
- **The web console** at your server's address: Inbox (what needs you), Library, Workers, Teams, Hire, and the admin pages.
- **Claude** (Claude Code, Claude Desktop, Codex) through MCP: "what's waiting on me?", "ask the analyst about pricing", "hire someone to watch our competitors".

## What "alpha" means here

- It works end to end, and it's still changing quickly.
- Data on the volume is kept across upgrades, but back it up.
- In the desktop app, org features are off until you turn on **Settings → Labs → Org workers · alpha**.
