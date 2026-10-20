# For managers

You manage a worker if you hired it, published it, or had it handed to you. Its questions and approvals come to you, and you decide how much it may do on its own.

## Answering and approving

The worker's questions and approvals come to you as Slack DMs, and also wait in the console's **Inbox**.

- **A question:** reply in the DM thread. Your answer goes to the worker and it carries on.
- **An approval** (before it pushes, posts, sends, or writes to another system): press **Approve** or **Reject**. The card says what the step does ("runs git push", "uses jira: add comment"), what it's told to do, and what it read first. Reading the web doesn't ask, unless your org's rules say it should.
- **Proposals** from a scheduled run on probation: a list of what it wants to do. Pick which go ahead.

A question climbs the **reports-to** chain before it reaches a person. If the worker reports to another worker, that one tries to answer first, and you're asked only when it can't.

## Trust

| Level | What it does on its own |
|---|---|
| **Probation** | Everything that reaches outside the server waits for you. New workers start here. |
| **Trusted** | Its best work starts without you; you're asked about the rest. |
| **Autonomous** | Runs whole shifts unattended. Only an admin can set this. |

- **Moving up:** your call. The worker's page shows when its record supports it, such as enough approved work and few rejections.
- **Moving down:** automatic. Three rejections in a row drop it a level; approving anything resets the count.

## Watching it work

While it's busy, a bar above the worker's tabs says what it's doing in one sentence ("Marta is on step 2 of 2, compare, of "Acme pricing snapshot" because you asked…"), with the run's steps. **Show me** jumps to the thread it belongs to.

The conversation is one **thread** per piece of work: each question, **Run now**, scheduled check and trigger. A thread shows, left to right:

1. what set it off;
2. what the worker decided (its reasoning is under **Why**);
3. whether it needs your OK, which you can give right there with **Run it** or **Not now**;
4. the run, step by step;
5. the answer.

To answer a worker, use **Reply** on its thread, or tap one of the answers it offers. The reply, and anything it leads to, stays in that thread. The **Ask** box at the top is for new topics.

A finished thread leads with **What it found**, with the full report one click away and **Was this useful?** beside it. Checks that found nothing to do fold into one line. Everything refreshes on its own, every few seconds while something is moving.

A run cut short by a server restart (an upgrade, say) carries on by itself when the server is back. One older than a day waits, with a **Carry on** button.

## What it does on its own

On the worker's page:

- **Schedule:** "weekdays at 9", "every 4 hours". The next run is shown, and **Run now** runs it immediately.
- **Triggers** (the Triggers tab): work that starts when something happens.
  - **Watch:** checks a tool every 5–60 minutes, such as a Jira search or a CRM view, and acts once on each new item. The first check only notes what's already there. **Try it now** shows what it sees before you save.
  - **Webhook:** a secret address for GitHub, Jira automation or Zapier to post to.
  - **Slack:** a new message, a mention, or an emoji reaction (🐛) in a channel.

  Each trigger has instructions (what to do with each item), a destination (a channel, the thread it came from, or "comment on the ticket"), and a daily limit.
- **The value strip** on the Triggers tab shows items handled this month, typical time, cost per item, and the share people rated useful.

## Code

To let a worker change a repo your admin has connected: **Setup → Repos → pick the worker → Let it change this repo**. Or ask Claude: "let Triage change the app repo". For a change across several repos, point it at a **workspace** the same way.

The worker then plans the change, makes it, and writes the pull request. On probation you approve that last step, and nothing is pushed without it. The server then commits and pushes a branch called `overcli/<change>` in each repo that changed, after each repo's tests pass. The person who asked gets a link to open each pull request. Workers never run git, never open or merge pull requests, and never push to the main branch.

A team's code works the same way: when a team task in a repo or workspace is done, **Push the branches** on its card pushes each repo's branch past its tests.

## Settings

- **Who may ask it:** just you, your team, or everyone. "Everyone" may need an admin, depending on your org's rules.
- **Reports to:** another worker that tries to answer its questions first.
- **Budget:** what it may spend a month. You're warned at 80%, and scheduled runs stop at the limit until the month turns. A raise over your allowance goes to an approver.
- **Job:** edit the job description on the Job tab. It's what the worker reads every time.
- **Pause** stops everything it would start, without losing its journal.

## Teams

A team is several workers plus a coordinator. Give it a task from the console's Teams page, from Slack (`/team Pricing: …`), or from Claude. The coordinator may ask you questions, then proposes a plan; **nothing runs until you approve it**. Checkpoints can hold the work for you partway through or before it's filed.

You can give a team work if you manage one of its members.

**A team takes one task at a time.** Give it another while it's busy and the new task waits as **Up next**, starting when the current one ends. Tasks start in the order they were given. Take a waiting task out of the line from the team's page.

**Making a team.** There are three ways:

- **On the console:** **Teams → Make a team**. Say what the team does, then pick its members from the workers you manage, or press **Suggest a crew** and let overcli pick them and write what each does. If the team needs a job none of your workers covers, the suggestion adds a new member. That member is hired when you make the team: hired straight away if it fits your allowance, or sent to an approver and added to the team once approved. **Skip** drops it. Choose where it checks in with you:
  - asking questions first
  - approving the plan (always on)
  - reading the draft before it's challenged
  - reviewing the result
  - approving follow-up work
- **In Slack:** `/team new writes PR/FAQs for new features`. overcli DMs you a suggested crew, with **Make the team**, **Change it** and **Cancel** buttons. **Change it** opens a form for the name, what the team does, its budget per task, where it checks in with you, and who can ask its new hires.

A `/hire` offer in Slack has **Change it** too. It opens a form for the worker's name, budget, who can ask it, its tools, the repo it works in, and who it reports to.
- **In the desktop app:** build it, then **Publish to your org**.

## Handing over

Leaving, or changing jobs? An admin hands your workers to someone else from **People**, or you hand over one at a time from the worker's settings. The worker keeps its journal and its record.
