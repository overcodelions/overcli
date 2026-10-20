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
    - **Or a change to an item:** set it off by a change to one field, such as a ticket's status, rather than a new item. Turn on **Only items I track**, and put `{{ids}}` in the tool's arguments, for example `"jql": "key in ({{ids}})"`. Add tickets on the Triggers tab, or in Slack with `@overcli Watcher, track ACME-412`, `stop tracking ACME-412`, or `/worker Watcher track ACME-412`. With **Just tell me what changed**, you get "ACME-412 moved from In review to Done" and a link, with no worker turn, so a quiet day costs nothing.
    - **Inside a VPC:** a watch checks outward, so nothing needs to reach the server. It only needs outbound access to the tool's API.
  - **Webhook:** a secret address for GitHub, Jira automation or Zapier to post to.
  - **Slack:** a new message, a mention, or an emoji reaction (🐛) in a channel.

  Each trigger has instructions (what to do with each item), a destination (a channel, a DM to you, the thread it came from, or "comment on the ticket"), and a daily limit.
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

## Processes

A process moves one piece of work through several teams and people's decisions, in order. For example, an idea becomes a PR/FAQ, then a prototype, then a decision, then a build, a launch and a check on how it's doing. Make one on the console's **Processes** page.

**The process library** (**Processes → Process library**) has eleven ways SaaS teams commonly run work that crosses teams: idea to launch, bug report to fix, customer escalation, security vulnerability response, incident postmortem, launch readiness, quarterly roadmap planning, growth experiments, a content pipeline, customer onboarding and pricing changes. Each one says when to use it, what goes in and what comes out, and why each stage is there. For each team stage it names the team of yours that fits, or the crew a new team would need, with **Make this team**. For each decision it says who usually decides. **Use this process** opens it in the editor with those teams filled in.

**From an image** (on **Processes** and in the library) starts one from a picture: a flowchart, a swimlane or a slide you found online. Drop it in, pick the file or paste it, and add a note if you want something changed ("use our Product Team for design"). Reading it takes a minute or so. Each box becomes a stage, decision diamonds and approvals become people who decide, rework or reject arrows say where work is sent back, and waits or "weekly" steps become waits and repeats. Where one of your teams or workers clearly fits a stage it's filled in; otherwise the stage says who the picture names ("Legal reviewer") so you can pick. The editor opens with the draft, unsaved, with what the reading was unsure of (a parallel branch it put in order, steps it left out past twelve) and the picture to keep open beside it. Nothing is saved until you make the process. Pictures are PNG, JPEG, WebP or GIF, under 5 MB.

Each stage is one of two kinds:

- **A team.** It's briefed with the stage's job, the original request, and what every earlier stage produced, pack files included. The team works as it always does: questions, a plan to approve, its pack to sign off. Those go to the stage's lead: the person you name, or else the team's manager. The item moves on when the lead signs off the pack.
- **People who decide.** They get a DM with **Approve**, **Send back…** and **Stop it**, and the same buttons are on the console. Any one of them can decide. **Send back** asks what needs to change and returns the item to the team stage before (or the stage you pick), briefed with that note.

Who owns what:

- **The process owner** sees every item, can move it to any stage, start a team stage again, or stop it, and hears when an item is stuck.
- **Each stage's lead** answers its team's questions, approves its plan and signs off what leaves it.
- **The person who put an item in** hears in Slack each time it moves, and when it finishes or stops.

Work comes in from `/idea` in Slack (`/idea Idea to launch: CSV export for reports`; `/idea` alone shows where yours are), from `@overcli` (`@overcli idea: CSV export`, `@overcli Bug report to fix: the export button is greyed out`, or a request the router judges to be a new item for a process), from **Put something in** on the console, from every new message in a Slack channel, or from events posted to a secret URL. It can also start items **on a schedule** (every week, every weekday, the 1st of each month, the first day of each quarter: "Quarterly roadmap · Jan 1, 2027"), or **watch a tool**: each new ticket, deal or row a tool call returns goes in, checked every few minutes from inside your network. Set these up under **How work comes in** on the process's page.

A team or worker stage can **wait** (start two weeks after the stage before, when there's adoption to read) and **repeat** (weekly, four times, each run building on the last) before the item moves on. The board says when a waiting stage starts; its owner can **Start now**.

On the board, a card marked **Your call** is waiting on your decision and **Stuck** means a team stage failed or was cancelled. "How are we doing?" to @overcli lists the decisions waiting on you.

In the desktop app you can build a process from your own teams and try it on your own, then **Publish to your org**. Publish its teams first.

## Handing over

Leaving, or changing jobs? An admin hands your workers to someone else from **People**, or you hand over one at a time from the worker's settings. The worker keeps its journal and its record.
