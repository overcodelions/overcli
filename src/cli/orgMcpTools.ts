// The org control plane as MCP tools, bound to one caller.
//
// Each request to `serve`'s /mcp endpoint builds a server with these tools
// registered for the person its token names, so every tool runs as that
// person and `OrgService` decides what they may do. A manager adding this
// server to Claude can say "hire me a product analyst that reports to Clara"
// and Claude walks the hire through these tools; the rules are the same as in
// Slack and the console because they all call the same service.

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';

import type { OrgService } from '../main/org/orgService';
import type { AccessService } from '../main/org/accessService';
import type { OrgCaller } from '../shared/org/policy';

function json(value: unknown): CallToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] };
}

function failure(message: string): CallToolResult {
  return { isError: true, content: [{ type: 'text', text: message }] };
}

type R = { ok: true } | { ok: false; error: string };

function out<T extends R>(res: T): CallToolResult {
  if (!res.ok) return failure(res.error);
  const { ok: _ok, ...rest } = res as { ok: true } & Record<string, unknown>;
  return json(Object.keys(rest).length ? rest : { ok: true });
}

const VISIBILITY = z.enum(['private', 'team', 'org']);

/// How long ask_worker waits before handing back an id to check later.
const ASK_WAIT_MS = 50_000;

export function registerOrgTools(server: McpServer, org: OrgService, caller: OrgCaller, access?: AccessService): void {
  // Hints for the client: read-only tools can run without a confirmation,
  // and letting a worker go should always get one.
  const tool: McpServer['registerTool'] = (name, config, cb) =>
    server.registerTool(name, { ...config, annotations: { ...annotationsFor(name), ...config.annotations } }, cb);
  tool(
    'whoami',
    { description: 'Who you are to this overcli org: admin or not, whether you may hire, and your monthly worker allowance.', inputSchema: {} },
    async () => json(org.whoami(caller)),
  );

  tool(
    'list_workers',
    {
      description:
        'The AI workers you can see: name, what it does, who manages it, who it reports to, budget and spend this month, ' +
        'and how many of its runs are waiting on a person. youManage says whether you may change it.',
      inputSchema: {},
    },
    async () => json(org.listWorkers(caller)),
  );

  tool(
    'get_worker',
    {
      description:
        "One worker in full: its job, what it delivered this month and how it was rated, the questions it asked and who " +
        'answered, what it has learned, and whether its record has earned more trust.',
      inputSchema: { worker: z.string().describe('Worker name or id.') },
    },
    async ({ worker }) => out(org.workerDetail(caller, worker)),
  );

  tool(
    'org_chart',
    { description: 'The org chart: each manager, the workers they manage, and every worker\'s reports, as a tree.', inputSchema: {} },
    async () => json(org.orgChart(caller)),
  );

  tool(
    'ask_worker',
    {
      description:
        "Send a worker an errand or a question. It plans from its job description and journal and replies; it may also start " +
        'work, which it reports. If it is not done within about 50 seconds you get an askId instead: call check_question with it.',
      inputSchema: {
        worker: z.string().describe('Worker name or id.'),
        message: z.string().min(1).describe('What you want, in plain words.'),
      },
    },
    async ({ worker, message }) => {
      const started = org.startAsk(caller, worker, message, 'mcp');
      if (!started.ok) return out(started);
      // Answer inside the client's patience, or say where to look later.
      const later = new Promise<'later'>((resolve) => setTimeout(() => resolve('later'), ASK_WAIT_MS).unref?.());
      const first = await Promise.race([started.done, later]);
      if (first === 'later') {
        return json({ askId: started.askId, status: 'working', note: 'Still working. Call check_question with this askId in a minute.' });
      }
      return out(first);
    },
  );

  tool(
    'list_tools',
    {
      description:
        "The tools (MCP servers) installed on this org server, which workers use each, and any a worker names that is not installed — " +
        'the usual reason a worker cannot reach Jira, a CRM or the like. Admins install them on the console\'s Tools page.',
      inputSchema: {},
    },
    async () => out(org.tools(caller)),
  );

  tool(
    'list_secrets',
    {
      description:
        "Admins: the secrets this server uses (git host tokens, Slack tokens, API keys) — which are set, where they're kept, and what needs a missing one. Never the values. " +
        'Values are set on the console (Setup → Secrets), not here, so they never pass through a chat.',
      inputSchema: {},
    },
    async () => out(org.secretList(caller)),
  );

  tool(
    'list_repos',
    { description: "The code repos connected to this server, each repo's test command, and which workers change it. Workers change a repo by pushing a branch and handing back the link to open a pull request.", inputSchema: {} },
    async () => out(org.repoList(caller)),
  );

  tool(
    'connect_repo',
    {
      description:
        'Admins: connect a code repo (GitHub, Bitbucket or any git host) so workers can change it by pushing branches. Clones it onto the server and refuses pushes to its default branch. ' +
        'Over https it needs the host\'s token on the server (GH_TOKEN, BITBUCKET_TOKEN or GIT_TOKEN); git@ addresses use the server\'s ssh key. testCommand (e.g. "npm test") runs before every push. Confirm with the person first.',
      inputSchema: { url: z.string(), name: z.string().optional(), testCommand: z.string().optional() },
    },
    async ({ url, name, testCommand }) => out(await org.connectRepo(caller, { url, ...(name ? { name } : {}), ...(testCommand ? { testCommand } : {}) })),
  );

  tool(
    'let_worker_change_repo',
    {
      description:
        "Point a worker you manage at a connected repo, or a workspace of repos: it works there from now on, and each code change arrives as a pushed branch per repo with the link to open each pull request (on probation, each push waits for its manager's yes). repo: a repo's or a workspace's name.",
      inputSchema: { worker: z.string(), repo: z.string() },
    },
    async ({ worker, repo }) => out(org.letWorkOnRepo(caller, worker, repo)),
  );

  tool(
    'create_workspace',
    {
      description:
        'Admins: group connected repos into a workspace, so one worker or team can change them together (an API and the app that uses it). Each run gets its own worktree of every repo. ' +
        'instructions: what every run in it should know — which repo owns what, what must stay in step. Confirm with the person first.',
      inputSchema: { name: z.string(), repos: z.array(z.string()), instructions: z.string().optional() },
    },
    async ({ name, repos, instructions }) => out(org.createWorkspace(caller, { name, repos, ...(instructions ? { instructions } : {}) })),
  );

  tool(
    'push_team_code',
    {
      description: "Push a finished team task's branch from every repo it changed, and get one link per repo to open its pull request. For whoever asked for the task, or an admin.",
      inputSchema: { taskId: z.string() },
    },
    async ({ taskId }) => out(org.pushTeamCode(caller, taskId)),
  );

  tool(
    'list_triggers',
    { description: 'What sets a worker off on its own: watches (a tool checked every few minutes), webhooks and Slack channel events, with what each has handled.', inputSchema: { worker: z.string() } },
    async ({ worker }) => out(org.triggers(caller, worker)),
  );

  tool(
    'create_trigger',
    {
      description:
        'Give a worker you manage a trigger: when something happens, it does a task and delivers the result. ' +
        'kind "watch": every N minutes call one of the server\'s tools (e.g. a Jira search) and act once per NEW item — the first check only records what is already there. ' +
        'kind "webhook": returns a secret URL path to post events to. kind "slack": a new message, a mention, or an emoji reaction in a channel. ' +
        'deliver: post to a Slack channel, reply in the Slack thread (slack triggers), or have the worker deliver it with its tools (e.g. "comment on the ticket"). ' +
        'Confirm the details with the person first.',
      inputSchema: {
        worker: z.string(),
        name: z.string().describe('e.g. "New bugs in Support Backlog"'),
        kind: z.enum(['watch', 'webhook', 'slack']),
        instructions: z.string().describe('What to do with each event, in plain words.'),
        watch: z
          .object({ server: z.string(), tool: z.string(), args: z.record(z.string(), z.unknown()).optional(), everyMinutes: z.number().int().min(5).optional(), itemsPath: z.string().optional(), idPath: z.string().optional() })
          .optional(),
        slack: z.object({ channel: z.string(), on: z.enum(['message', 'mention', 'reaction']), reaction: z.string().optional(), contains: z.string().optional() }).optional(),
        deliverToSlackChannel: z.string().optional().describe('A channel ID to post each result in.'),
        replyInThread: z.boolean().optional(),
        workerDelivers: z.string().optional().describe('What the worker should do with the result itself, e.g. "Comment your triage on the ticket."'),
        maxPerDay: z.number().int().min(1).max(500).optional(),
      },
    },
    async (a) =>
      out(
        org.createTrigger(caller, a.worker, {
          name: a.name,
          kind: a.kind,
          instructions: a.instructions,
          maxPerDay: a.maxPerDay ?? 50,
          deliver: [
            ...(a.deliverToSlackChannel ? [{ kind: 'slack' as const, channel: a.deliverToSlackChannel }] : []),
            ...(a.replyInThread ? [{ kind: 'thread' as const }] : []),
            ...(a.workerDelivers ? [{ kind: 'worker' as const, text: a.workerDelivers }] : []),
          ],
          ...(a.watch ? { watch: { server: a.watch.server, tool: a.watch.tool, args: a.watch.args ?? {}, everyMinutes: a.watch.everyMinutes ?? 15, ...(a.watch.itemsPath ? { itemsPath: a.watch.itemsPath } : {}), ...(a.watch.idPath ? { idPath: a.watch.idPath } : {}) } } : {}),
          ...(a.slack ? { slack: a.slack } : {}),
        }),
      ),
  );

  tool(
    'set_trigger_enabled',
    { description: 'Switch one of a worker\'s triggers off or on.', inputSchema: { triggerId: z.string(), enabled: z.boolean() } },
    async ({ triggerId, enabled }) => out(org.updateTrigger(caller, triggerId, { enabled })),
  );

  tool(
    'library',
    {
      description: 'What workers delivered, newest first: results of their triggers and their finished work, with links. Filter by worker and words.',
      inputSchema: { worker: z.string().optional(), query: z.string().optional(), limit: z.number().int().min(1).max(100).optional() },
    },
    async ({ worker, query, limit }) => {
      const w = worker ? org.resolve(caller, worker) : null;
      if (worker && !w) return out({ ok: false, error: 'No worker by that name that you can see.' });
      return json(org.library(caller, { ...(w ? { workerId: w.id } : {}), ...(query ? { query } : {}), limit: limit ?? 30 }));
    },
  );

  tool(
    'check_question',
    {
      description: 'Where a question sent with ask_worker got to: still working, answered (with the reply), or failed.',
      inputSchema: { askId: z.string() },
    },
    async ({ askId }) => out(org.askStatus(caller, askId)),
  );

  tool(
    'list_waiting',
    {
      description:
        'Questions and approvals waiting on you from the workers you manage (every worker, for an admin). ' +
        'Answer a question with answer_question; settle an approval with decide_approval. ' +
        'Work proposed at a scheduled run is separate: list_proposals.',
      inputSchema: {},
    },
    async () => json(org.listWaiting(caller)),
  );

  tool(
    'answer_question',
    {
      description: 'Answer a question a worker\'s run is paused on. The run carries on with your answer.',
      inputSchema: {
        runId: z.string().describe('From list_waiting.'),
        answer: z.string().min(1),
      },
    },
    async ({ runId, answer }) => out(org.answer(caller, runId, answer)),
  );

  tool(
    'decide_approval',
    {
      description:
        'Approve or reject a step a worker wants to run that acts outside its sandbox (a push, a message, a publish). ' +
        'Approval covers that one step, or with forRun the later steps of the same run that need only the same tools (list_waiting says how many: coversLater).',
      inputSchema: {
        runId: z.string().describe('From list_waiting.'),
        approve: z.boolean(),
        forRun: z.boolean().optional().describe('Also approve the later steps that need only the same tools. Only when list_waiting shows coversLater.'),
      },
    },
    async ({ runId, approve, forRun }) => out(org.decideRun(caller, runId, approve, forRun === true)),
  );

  tool(
    'draft_hire',
    {
      description:
        'Start hiring an AI worker from a job description, or continue a hire the drafter asked questions about (pass hireId ' +
        'and answer). Returns either the drafter\'s questions or a drafted contract to review. Nothing is hired until confirm_hire.',
      inputSchema: {
        jobDescription: z.string().optional().describe('What the worker should do, for whom, from which sources. Required to start.'),
        hireId: z.string().optional().describe('To continue a hire in progress.'),
        answer: z.string().optional().describe("Your answers to the drafter's questions."),
        skipQuestions: z.boolean().optional().describe('Draft straight away instead of letting the drafter ask first.'),
      },
    },
    async (args) => out(await org.draftHire(caller, args)),
  );

  tool(
    'confirm_hire',
    {
      description:
        'Hire a drafted worker. You become its manager. It is hired now if it fits your allowance and the org policy; ' +
        'otherwise it waits for an approver, who is notified. It keeps the schedule in its draft (change it later with set_worker_schedule); on probation, ' +
        'each scheduled run proposes its work and waits for your approval (list_proposals).',
      inputSchema: {
        hireId: z.string(),
        reportsTo: z.string().optional().describe('A worker name or id it reports to.'),
        visibility: VISIBILITY.optional().describe('Who may ask it things. Defaults to private (only you).'),
        budgetUSDPerMonth: z.number().positive().optional().describe("Overrides the drafter's budget."),
        projectPath: z.string().optional().describe('Overrides the project it works in.'),
      },
    },
    async ({ hireId, ...options }) => out(org.confirmHire(caller, hireId, options)),
  );

  tool(
    'list_hires',
    { description: 'Hires in progress that are yours, and (for approvers) hires waiting on approval.', inputSchema: {} },
    async () => json(org.listHires(caller)),
  );

  tool(
    'cancel_hire',
    { description: 'Drop a hire you started: a draft you decided against, or one still waiting on an approver.', inputSchema: { hireId: z.string() } },
    async ({ hireId }) => out(org.cancelHire(caller, hireId)),
  );

  tool(
    'decide_hire',
    {
      description: 'As an approver or admin: approve or turn down a hire waiting on approval.',
      inputSchema: { hireId: z.string(), approve: z.boolean() },
    },
    async ({ hireId, approve }) => out(org.decideHire(caller, hireId, approve)),
  );

  tool(
    'update_worker',
    {
      description:
        "Change a worker you manage: its manager (hand it to someone else), who it reports to, who may ask it things, or its " +
        'monthly budget. Pass null to clear manager or reportsTo.',
      inputSchema: {
        worker: z.string(),
        manager: z
          .object({ name: z.string().min(1), slackUserId: z.string().optional() })
          .nullable()
          .optional(),
        reportsTo: z.string().nullable().optional(),
        visibility: VISIBILITY.optional(),
        budgetUSDPerMonth: z.number().positive().optional(),
      },
    },
    async ({ worker, ...patch }) => out(org.update(caller, worker, patch)),
  );

  tool(
    'set_worker_paused',
    {
      description: 'Pause a worker you manage (no shifts, no errands) or resume it.',
      inputSchema: { worker: z.string(), paused: z.boolean() },
    },
    async ({ worker, paused }) => out(org.setPaused(caller, worker, paused)),
  );

  tool(
    'retire_worker',
    {
      description: 'Let a worker you manage go, permanently. Confirm with the person first. Its finished work and journal stay; its reports move up to its own boss.',
      inputSchema: { worker: z.string() },
    },
    async ({ worker }) => out(org.retire(caller, worker)),
  );

  tool(
    'today',
    {
      description:
        "Your day: what is waiting on you (questions, approvals, proposed work, hires to approve, team tasks), what your workers delivered " +
        'since yesterday, what each is doing now, and your spend this month with a month-end projection.',
      inputSchema: {},
    },
    async () => json(org.today(caller)),
  );

  tool(
    'list_work',
    {
      description: 'Finished work from the workers you can see, newest first, with ratings. mine: only workers you manage.',
      inputSchema: { mine: z.boolean().optional(), days: z.number().int().min(1).max(90).optional() },
    },
    async ({ mine, days }) => json(org.work(caller, { mine, days })),
  );

  tool(
    'rate_work',
    {
      description:
        "Say whether a finished piece of work was useful. It goes into the worker's journal, so its next run leans toward " +
        'what you found useful. entryId comes from list_work or today.',
      inputSchema: { entryId: z.string(), useful: z.boolean(), note: z.string().max(500).optional() },
    },
    async (args) => out(org.rate(caller, args)),
  );

  tool(
    'set_worker_trust',
    {
      description:
        'Promote or demote a worker you manage. probation: every run waits for approval. trusted: it starts its own runs and ' +
        'asks only before acting outside its sandbox. autonomous (admins only): it acts on its own.',
      inputSchema: { worker: z.string(), trust: z.enum(['probation', 'trusted', 'autonomous']) },
    },
    async ({ worker, trust }) => out(org.setTrust(caller, worker, trust)),
  );

  tool(
    'list_roles',
    { description: "The org's approved role catalog, and whether each fits your allowance.", inputSchema: {} },
    async () => json(org.roles(caller)),
  );

  tool(
    'hire_role',
    {
      description: 'Draft a hire from a catalog role, straight to an offer to confirm with confirm_hire.',
      inputSchema: {
        role: z.string().describe('A role name from list_roles.'),
        extra: z.string().optional().describe('Anything specific to this hire: the product area, the sources, who it reports to.'),
      },
    },
    async ({ role, extra }) => out(await org.hireRole(caller, role, extra)),
  );

  tool(
    'publish_worker',
    {
      description:
        "Put a worker you built on your own overcli onto the org's roster, from its share file (Workers → Share in the " +
        'app, or overcli workers push). You become its manager; it arrives on probation with a fresh journal, and waits ' +
        'for an approver if it is over your allowance.',
      inputSchema: {
        yaml: z.string().min(1).describe('The worker share file, as text.'),
        reportsTo: z.string().optional(),
        visibility: VISIBILITY.optional(),
        projectPath: z.string().optional(),
      },
    },
    async ({ yaml, ...options }) => out(org.publishWorker(caller, yaml, options)),
  );

  tool(
    'list_teams',
    { description: 'Teams of workers you can see, their members, and whether you can give them work.', inputSchema: {} },
    async () => json(org.teams(caller)),
  );

  tool(
    'list_team_tasks',
    { description: 'Team tasks you can see: their stages, what they need, and whether they are waiting on you.', inputSchema: {} },
    async () => json(org.teamTasks(caller)),
  );

  tool(
    'brief_team',
    {
      description:
        "Give a team a task. Its coordinator may ask you questions, then proposes a plan you approve (decide_team_task) " +
        'before any member starts.',
      inputSchema: { team: z.string().describe('Team name or id.'), task: z.string().min(10) },
    },
    async ({ team, task }) => out(org.briefTeam(caller, team, task)),
  );

  tool(
    'decide_team_task',
    {
      description:
        'Steer a team task you asked for: answer its questions, approve or revise its plan, carry on past a checkpoint, or cancel.',
      inputSchema: {
        taskId: z.string(),
        action: z.enum(['answer', 'approve', 'revise', 'continue', 'cancel']),
        answers: z.array(z.string()).optional().describe('For answer: one per question, in order.'),
        feedback: z.string().optional().describe('For revise: what to change in the plan.'),
      },
    },
    async ({ taskId, action, answers, feedback }) =>
      out(
        org.decideTeamTask(
          caller,
          taskId,
          action === 'answer'
            ? { kind: 'answer', answers: answers ?? [] }
            : action === 'revise'
              ? { kind: 'revise', feedback: feedback ?? '' }
              : { kind: action },
        ),
      ),
  );

  tool(
    'org_people',
    { description: 'Admins: everyone with access, their role, workers, spend and allowance.', inputSchema: {} },
    async () => out(org.people(caller)),
  );

  tool(
    'org_health',
    { description: 'Admins: whether Slack, the models and the workers are healthy, and spend by manager.', inputSchema: {} },
    async () => out(org.health(caller)),
  );

  tool(
    'decision_log',
    {
      description:
        'Admins: decisions — hires, approvals, promotions, rule changes, offboarding — and who made them, newest first. ' +
        'Filter by words (a person, a worker, "approved") and a date range.',
      inputSchema: {
        query: z.string().optional(),
        from: z.string().optional().describe('ISO date, e.g. 2026-10-01.'),
        to: z.string().optional().describe('ISO date, exclusive.'),
        limit: z.number().int().min(1).max(500).optional(),
      },
    },
    async ({ query, from, to, limit }) => {
      const at = (d?: string) => (d && Number.isFinite(Date.parse(d)) ? Date.parse(d) : undefined);
      return out(org.auditLog(caller, { limit: limit ?? 60, ...(query ? { query } : {}), ...(at(from) ? { from: at(from) } : {}), ...(at(to) ? { to: at(to) } : {}) }));
    },
  );

  tool(
    'list_proposals',
    {
      description:
        'Work your workers on probation proposed at their scheduled runs, waiting for you to approve. Approve or skip with decide_proposal.',
      inputSchema: {},
    },
    async () => json(org.proposals(caller)),
  );

  tool(
    'decide_proposal',
    {
      description: 'Approve some or all items a worker proposed (they start running), and skip others.',
      inputSchema: {
        batchId: z.string().describe('From list_proposals.'),
        approve: z.union([z.literal('all'), z.array(z.string())]).describe('"all", or candidate ids to approve.'),
        skip: z.array(z.string()).optional().describe('Candidate ids to skip.'),
      },
    },
    async ({ batchId, approve, skip }) => out(await org.decideProposal(caller, batchId, { approve, skip })),
  );

  tool(
    'run_worker_now',
    {
      description:
        "Start a worker's scheduled run now instead of waiting for its next time. A worker on probation only proposes its work; " +
        'approve it with decide_proposal. To give a worker one specific task, use ask_worker instead.',
      inputSchema: { worker: z.string() },
    },
    async ({ worker }) => out(await org.runNow(caller, worker)),
  );

  tool(
    'set_worker_schedule',
    {
      description:
        'When a worker runs on its own. "when_asked" turns the schedule off. "daily" runs at a time on the given weekdays ' +
        '(0 = Sunday); "every" repeats every N minutes (at least 30), optionally within hours of the day. Times are the org\'s time zone.',
      inputSchema: {
        worker: z.string(),
        kind: z.enum(['when_asked', 'daily', 'every']),
        time: z.string().regex(/^\d{2}:\d{2}$/).optional().describe('For daily, e.g. 09:00.'),
        days: z.array(z.number().int().min(0).max(6)).optional(),
        everyMinutes: z.number().int().min(30).optional(),
        between: z.object({ start: z.string(), end: z.string() }).optional().describe('For every: e.g. 08:00 to 18:00.'),
      },
    },
    async ({ worker, kind, time, days, everyMinutes, between }) => {
      const cadence =
        kind === 'when_asked'
          ? null
          : kind === 'daily'
            ? { kind: 'daily' as const, time: time ?? '09:00', ...(days?.length ? { days } : {}) }
            : { kind: 'interval' as const, everyMinutes: everyMinutes ?? 60, ...(days?.length ? { days } : {}), ...(between ? { window: between } : {}) };
      return out(org.update(caller, worker, { cadence }));
    },
  );

  if (access) {
    tool(
      'org_rules',
      { description: "Admins: the org's rules — who may hire, allowances, approvers, the org-wide budget and alerts, teams, roles, retention, sign-in.", inputSchema: {} },
      async () => out(access.rules(caller)),
    );

    tool(
      'offboard_person',
      {
        description:
          'Admins: someone has left. Hands every worker they manage, and their hires in progress, to a successor; then signs them out ' +
          'everywhere and takes them off every rule. Confirm with the person first: it cannot be undone.',
        inputSchema: {
          slackUserId: z.string().describe('Who left.'),
          successor: z.object({ name: z.string(), slackUserId: z.string() }).optional().describe('Who takes their workers. Needed when they manage any.'),
        },
        annotations: { destructiveHint: true },
      },
      async ({ slackUserId, successor }) => {
        if (successor) {
          const handed = org.handOverAll(caller, slackUserId, successor);
          if (!handed.ok) return out(handed);
        } else if (org.listWorkers(caller).some((w) => w.managerSlackUserId === slackUserId)) {
          return out({ ok: false, error: 'They still manage workers. Name a successor.' });
        }
        return out(access.removePerson(caller, slackUserId));
      },
    );

    tool(
      'set_org_rules',
      {
        description:
          "Admins: change some of the org's rules. Pass only the keys to change; null removes an optional one. " +
          'Keys: name, publicUrl, timezone, hirers ("*" or Slack ids), budgetAllowanceUSD, approvers, orgVisibilityNeedsAdmin, webFetch ("ask", "safe": only addresses a worker was shown or the org’s own sites, "any"), ownDomains (the org’s own sites), ' +
          'allowedMcpServers, teams ({name: [Slack ids]}), roles ([{name, job, tools, budgetUSDPerMonth}]), orgBudgetUSD, alertAtPercent, ' +
          'retentionDays, sso ({issuer, clientId, allowedDomains, required}), people ({email: Slack id}), fleet ([{name, url}]), ' +
          'redactSecrets (scrub credentials out of what workers say), providerModels ({model id: Bedrock or Vertex id}). ' +
          'Read org_rules first, and confirm the change with the person.',
        inputSchema: { patch: z.record(z.string(), z.unknown()) },
      },
      async ({ patch }) => out(access.setRules(caller, patch)),
    );
  }
}

const READ_ONLY = new Set([
  'whoami', 'list_workers', 'get_worker', 'org_chart', 'list_waiting', 'list_hires', 'today', 'list_work',
  'list_roles', 'list_teams', 'list_team_tasks', 'org_people', 'org_health', 'decision_log', 'list_proposals', 'org_rules', 'check_question', 'list_tools', 'list_triggers', 'library', 'list_repos', 'list_secrets',
]);

function annotationsFor(name: string): Record<string, boolean> {
  if (READ_ONLY.has(name)) return { readOnlyHint: true, openWorldHint: false };
  if (name === 'retire_worker') return { readOnlyHint: false, destructiveHint: true, openWorldHint: false };
  return { readOnlyHint: false, destructiveHint: false, openWorldHint: false };
}
