# Using workers

For everyone in the org. You don't need to know which worker does what.

## Ask from Slack

Mention the app in any channel it's in, or DM it:

> @overgo add an export button to the reports page

> @overgo what's the competitive picture for the reports feature against company A?

What happens:

1. **Someone takes it.** Start with a worker's name ("Triage, …") to choose. Otherwise the server picks the worker whose job fits, and tells you who and why. If nobody clearly fits, it asks you to pick from a short list; reply with a name.
2. **The worker answers in the thread.** A long answer comes as a summary with the full text attached.
3. **If it starts work,** you hear back in the same thread when it ends:
   - **a code change:** "Branch pushed. Open a pull request: <link>". Open the PR from there; workers never open or merge one.
   - **a report:** the report, attached;
   - **files it made:** attached;
   - a link to the **Library**, where everything it delivered is kept.

### Give it context

- **Ask inside a thread,** and the thread comes along: "@overgo Triage, fix this" under a bug report means *that* bug.
- **Ask right after something in a channel,** and the last few messages come along too: post a ticket, then "@overgo what's the status of this ticket?"
- **Questions about a record go to a worker that can open it.** A ticket, an account or a pull request goes to a worker whose tools reach that system, rather than one that could only guess.
- **Screenshots** in the message or the thread are attached for the worker to see.
- **Follow up in the same thread** ("and make it blue") and the same worker picks it up.

### Things to know

- **Some work waits for approval.** Work that reaches outside the server, such as pushing code, posting or sending, waits for the worker's manager to approve it while the worker is on probation. You'll hear back once it's done.
- **You can only ask workers you're allowed to see.** Each worker has a "who may ask it" setting: just its manager, its team, or everyone.
- **Not in yet?** Type `/overgo join` in Slack. An admin lets you in, or you're in straight away if the org allows it.

### Slash commands

| Command | Does |
|---|---|
| `/worker` | Lists the workers you can see |
| `/worker Triage ask <text>` | Asks one worker; the answer comes as a DM |
| `/worker waiting` | What's waiting on you |
| `/team Pricing: <task>` | Gives a team a task; its plan comes back for approval |
| `/team new <what it's for>` | Suggests a team from your workers, to make with one button |
| `/hire <the job>` | Hires a worker, with a short interview |
| `/idea <process>: <the idea>` | Puts an idea into a process; `/idea` alone shows where yours are |

## The web console

Your org's server address, signed in through a Slack link, company sign-in, or the desktop app.

- **Inbox:** questions and approvals waiting on you, what came in, and a box to ask anything.
- **Library:** everything workers delivered, searchable, with links (PRs, docs) and a "useful?" rating. Rating matters: workers read it.
- **Workers:** each worker's page has its conversation, triggers, job and settings.
- **Teams:** give a team a task, and follow its plan and progress.
- **Hire:** the roles your org has approved, or describe a new one.

## From Claude

Connect Claude Code, Claude Desktop or Codex to the server's MCP address. The console's **Use from Slack or Claude** page gives you the exact command and a key of your own. Then ask in plain words:

> What's waiting on me?
> Ask the analyst what changed in competitor pricing this week.
> Show me what Triage delivered yesterday.

## Rate what you get

On a result in the Library, or on an answer, **Useful** or **Not useful** (with a note) goes into the worker's journal. Workers read their journals before each piece of work, so this is how they get better at your org's version of the job.
