# For managers

You manage a worker if you hired it, published it, or had it handed to you. Its questions and approvals come to you, and you decide how much it may do on its own.

## Answering and approving

The worker's questions and approvals come to you as Slack DMs, and also wait in the console's **Inbox**.

- **A question:** reply in the DM thread. Your answer goes to the worker and it carries on.
- **An approval** (before it pushes, posts, sends, or writes to another system): press **Approve** or **Reject**. The card says what the step does ("runs git push", "uses jira: add comment"), what it's told to do, and what it read first. Once it's settled, the card still says what it was for. Reading the web doesn't ask, unless your org's rules say it should.
- **Always allow** on an approval card (in Slack and on the console) approves the step and lets that step of that flow run without asking from then on. Take it back on the worker's [Access](#access) tab.
- **Proposals** from a scheduled run on probation: a list of what it wants to do. Pick which go ahead.

**What doesn't ask.** A step whose tools only read (a search, a ticket lookup, its own files) runs without an approval, even when its instructions mention writing something. So do read-only shell commands on its own folders, such as `git log`, `git show`, `git blame`, `git grep`, `git shortlog`, `rg` and `grep`, also after a `cd` into the repo (`cd api && git log`).

A question climbs the **reports-to** chain before it reaches a person. If the worker reports to another worker, that one tries to answer first, and you're asked only when it can't.

## Trust

The worker's **Access** tab shows this as **How much it does alone**:

| Level | What it does on its own |
|---|---|
| **Asks first** (probation) | It proposes each run's work, and everything that reaches outside the server waits for you. New workers start here. |
| **Trusted** | It starts its own runs, and still asks before anything that changes something outside the server: a ticket, a message, a push. |
| **On its own** (autonomous) | It starts its own work and acts outside the server without asking. Only an admin can set this. |

- **Moving up:** your call. **Trust it to start its own work** (or, for an admin, **Let it act on its own**). The ladder marks a level **ready** when its record supports it, such as enough approved work and few rejections, but you can move it up before then.
- **Moving down:** **Back to asks first**, or automatic: three rejections in a row drop it a level; approving anything resets the count.

## Access

The worker's **Access** tab is what it may use and how much it does without asking. The sidebar of its page shows a short version (its trust, its tools and their scope, any standing approvals) with **Manage →** to open the tab.

- **Tools:** each tool it has, with its **Scope**: the org's default, everything, read only, or only the calls you tick. Calls outside a tool's scope are refused, even with your OK. A scope wider than the org's default needs an admin. **Take it off** removes a tool.
- **+ Give it a tool:** pick an installed tool, or **Something not listed…**, and say what it's for. A tool your org clears for any hire is given at once. Anything else goes to the admins, and waits under the list as "waiting on an admin" until one decides; you hear in Slack. From Slack: `/worker Ada tools` lists its tools, and `/worker Ada tools add zendesk: to read tickets` gives or asks.
- **How much it does alone:** the trust ladder above.
- **Always allowed:** the steps you said it may always run, from **Always allow** on an approval. **Take off** and it asks again.
- **Checkpoints:** some flows stop before a step so someone looks first ("Continue to push?"). An admin can switch on **Run straight through its flows' checkpoints**. Anything that acts outside the server still asks, unless its trust says otherwise.

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
    - **Or a change to an item:** set it off by a change to one field, such as a ticket's status, rather than a new item. Turn on **Only items I track**, and put `{{ids}}` in the tool's arguments, for example `"jql": "key in ({{ids}})"`. Add tickets on the Triggers tab, or in Slack with `@overgo Watcher, track ACME-412`, `stop tracking ACME-412`, or `/worker Watcher track ACME-412`. With **Just tell me what changed**, you get "ACME-412 moved from In review to Done" and a link, with no worker turn, so a quiet day costs nothing.
    - **Inside a VPC:** a watch checks outward, so nothing needs to reach the server. It only needs outbound access to the tool's API.
  - **Webhook:** a secret address for GitHub, Jira automation or Zapier to post to.
    The sender posts from the internet, so it can't reach a console that only answers inside your network, even on an https address. When the console's address only resolves to private addresses, the form says so and offers a watch instead, which only calls out.
  - **Slack:** a new message, a mention, or an emoji reaction (🐛) in a channel.

  Each trigger has instructions (what to do with each item), a destination (a channel, a DM to you, the thread it came from, or "comment on the ticket"), and a daily limit.
- **The value strip** on the Triggers tab shows items handled this month, typical time, cost per item, and the share people rated useful.

## Code

To let a worker change a repo your admin has connected: **Setup → Repos → pick the worker → Let it change this repo**. Or ask Claude: "let Triage change the app repo". For a change across several repos, point it at a **workspace** the same way.

The worker then plans the change, makes it, and writes the pull request. On probation you approve that last step, and nothing is pushed without it. The server then commits and pushes a branch called `overcli/<change>` in each repo that changed, after each repo's tests pass. The person who asked gets a link to open each pull request. Workers never run git, never open or merge pull requests, and never push to the main branch.

A team's code works the same way: when a team task in a repo or workspace is done, **Push the branches** on its card pushes each repo's branch past its tests.

## The job and what it knows

**The job** is on the worker's **Job** tab. It's what the worker plans every run from. **Edit the job** to change it by hand, or say the change in a sentence ("also check the WEB board on Fridays") and press **Rewrite it**: the job is rewritten in the box for you to read. **Undo** puts it back. Nothing is saved until you press **Save the job**.

In Slack, `/worker Ada edit` opens a form with the job, **Or say what should change**, **How much it does alone** (only an admin can pick **On its own**), when it runs, its budget, who can ask it, and **Slack conversations at once**. Admins also see a box to run straight through its flows' checkpoints. A change said in words comes back as a DM with the rewritten job: **Use this** or **Keep the old one**.

**What it knows** (a card beside the job) is its onboarding: one read-only run through its own tools, finding the projects, statuses, people and places its job uses. It reads these notes before every run.

- **When it happens:** by itself when it's hired with tools, or when you press **Learn its tools**. In Slack: `/worker Ada learn`. It takes a few minutes.
- **Learn again** goes through its tools again. **Correct it** lets you edit the notes yourself.
- **Refresh weekly** (the default) learns again once its notes are a week old. **Don't refresh** keeps them as they are.

Every worker also reads your org's **handbook**, which an admin keeps on Setup → Handbook, after its own job.

**Models** (a card on the Job tab) moves the worker onto newer models once your server knows them (a newer release of the server image brings newer models). It lists the model it plans with and each of its flows, with the newer model in the same line: Sonnet 5 → Sonnet 5.5, never Sonnet → Opus. Tick what to move and press **Upgrade the ones ticked**; its next run uses them. Nothing moves on its own.

- **A flow other workers use** moves for them too, so the card says who. If one of them isn't yours, their manager or an admin moves it.
- **"Here: … runs as …"** means that model's CLI isn't signed in on this server, so the step runs on one that is, at the same tier. Sign that CLI in (Admin page) to run it as written.

## Settings

- **Picture:** its face on the console and on what it posts in Slack.
- **When it runs:** its schedule, or only when someone asks.
- **Who it answers to:** its manager (an admin changes this), and the worker it **reports to**, which tries to answer its questions first.
- **Who can ask it:** just you, your team, or everyone. "Everyone" may need an admin, depending on your org's rules. Anyone who can ask it can learn what its tools can reach.
- **Where it works:** the repo, or workspace of repos, it reads and changes.
- **Answering in Slack:** how many people it answers at once, each in their own thread. Each answer counts against its budget.
- **How it works:** the flow its work goes through, unless you name another of its flows when you ask ("use solve-ticket"). Shown when it has more than one.
- **History:** every change to its job, tools, trust and settings, newest first, with who made it and **The job then**. **Restore** puts it back to that version. Restoring follows the same rules as changing it by hand, so it can't give the worker anything you couldn't, such as a trust level only an admin sets. The last 50 versions of each worker are kept; the page shows the newest 15.
- **Budget:** what it may spend a month. You're warned at 80%, and scheduled runs stop at the limit until the month turns. A raise over your allowance goes to an approver.
- **Pause** stops everything it would start, without losing its journal.

Tools, trust, standing approvals and checkpoints are on the [Access](#access) tab.

## Your week

Every Monday at 9am (the org's time zone) overgo DMs you a week in review: for each of your workers, what it finished, what failed, how often it was asked, what it cost and how it was rated, and what's waiting on you. `/overgo digest` sends this week's so far, any time.

## Teams

A team is several workers plus a coordinator. Give it a task from the console's Teams page, from Slack (`/team Pricing: …`), or from Claude. The coordinator may ask you questions, then proposes a plan; **nothing runs until you approve it**. Checkpoints can hold the work for you partway through or before it's filed.

You can give a team work if you manage one of its members.

**A team takes one task at a time.** Give it another while it's busy and the new task waits as **Up next**, starting when the current one ends. Tasks start in the order they were given. Take a waiting task out of the line from the team's page.

**A member's check is skipped when there's no code to check.** The check after a member's piece is a step marked `only_if_changed: true`, and any flow step can be. It's skipped, with any approval it would have asked for, when the run has changed nothing in its repo (or in any repo of its workspace) since it started but notes. Notes are Markdown (`.md`, `.markdown`) and `.txt` files, except a `.txt` a build, test or server reads: `requirements*.txt`, anything under a `requirements/` folder, `constraints*.txt`, `CMakeLists.txt`, `runtime.txt`, `apt.txt`, `packages.txt`, `version.txt`, `robots.txt`, `ads.txt`, `app-ads.txt`, `security.txt`, and anything under a `testdata/`, `test_data/`, `fixtures/`, `__snapshots__/`, `snapshots/`, `golden/` or `resources/` folder count as code. Edits, commits and new files count; files your `.gitignore` covers don't. Renames and deletions count by every path they touch, so `auth.ts` renamed to `auth.md`, or deleted, is a code change. When the change can't be measured (the run has no git baseline, or git fails), the step runs.

**Making a team.** There are three ways:

- **On the console:** **Teams → Make a team**. Say what the team does, then pick its members from the workers you manage, or press **Suggest a crew** and let overgo pick them and write what each does. If the team needs a job none of your workers covers, the suggestion adds a new member. That member is hired when you make the team: hired straight away if it fits your allowance, or sent to an approver and added to the team once approved. **Skip** drops it. Choose where it checks in with you:
  - asking questions first
  - approving the plan (always on)
  - reading the draft before it's challenged
  - reviewing the result
  - approving follow-up work
- **In Slack:** `/team new writes PR/FAQs for new features`. overgo DMs you a suggested crew, with **Make the team**, **Change it** and **Cancel** buttons. **Change it** opens a form for the name, what the team does, its budget per task, where it checks in with you, and who can ask its new hires.

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

**Who can see and start it.** Set under **Owner** in the editor:

- **Private**: only its owner, whoever made it, and admins. This is where every new process starts.
- **A team**: the members of the teams you pick (the org’s teams on **Setup → People & teams**), as they are at the time. Someone who joins the team can start it; someone who leaves can't.
- **Certain people**: the people you name, and anyone in a group you add.
- **Everyone**: anyone in the org. Processes made before this setting existed start here, as they worked before.

The person who made a process always keeps access, even after it's handed to another owner. People in its stages see the work that reaches them, but can only start items if they're in its audience. Anyone else doesn't see the process at all: it's not on the Processes page, `/idea` doesn't know it, and `@overgo` never routes a request into it. Schedules, watches and posted events keep putting work in whatever the setting, because they were set up by someone who steers the process. Someone who put an item in before the process was narrowed still follows that item.

Work comes in from `/idea` in Slack (`/idea Idea to launch: CSV export for reports`; `/idea` alone shows where yours are), from `@overgo` (`@overgo idea: CSV export`, `@overgo Bug report to fix: the export button is greyed out`, or a request the router judges to be a new item for a process), from **Put something in** on the console, from every new message in a Slack channel, or from events posted to a secret URL. It can also start items **on a schedule** (every week, every weekday, the 1st of each month, the first day of each quarter: "Quarterly roadmap · Jan 1, 2027"), or **watch a tool**: each new ticket, deal or row a tool call returns goes in, checked every few minutes from inside your network. Set these up under **How work comes in** on the process's page.

A team or worker stage can **wait** (start two weeks after the stage before, when there's adoption to read) and **repeat** (weekly, four times, each run building on the last) before the item moves on. The board says when a waiting stage starts; its owner can **Start now**.

On the board, a card marked **Your call** is waiting on your decision and **Stuck** means a team stage failed or was cancelled. "How are we doing?" to @overgo lists the decisions waiting on you.

In the desktop app you can build a process from your own teams and try it on your own, then **Publish to your org**. Publish its teams first. A process published for the first time is private in the org until its owner opens it up.

## Handing over

Leaving, or changing jobs? An admin hands your workers to someone else from **People**, or you hand over one at a time from the worker's settings. The worker keeps its journal and its record.
