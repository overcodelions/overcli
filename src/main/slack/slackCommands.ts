// `/worker` and `/hire` in Slack, over the same Socket Mode connection the
// bridge holds — so they work from inside a VPC with no inbound route.
//
//   /worker                    the workers you can see
//   /worker waiting            what is waiting on you
//   /worker <name>             one worker: job, manager, spend, recent work
//   /worker <name> ask <text>  an errand; the reply comes back in a DM
//   /worker <name> pause|resume
//   /hire <job description>    a hire, interviewed in a DM thread, confirmed
//                              with a button, routed to an approver when it
//                              is over the asker's allowance
//
// Every command runs as the Slack user who typed it, through `OrgService`,
// so Slack can do exactly what that person could do in the console or over
// MCP — and no more.

import type { OrgService, HireSummary, PendingHire, WaitingItem, WorkerSummary } from '../org/orgService';
import type { AskRecord } from '../org/orgStores';
import { ROLE_TEXT, type AccessService, type Invite, type JoinRequest } from '../org/accessService';
import { slackCall } from './slackApi';
import { isAdmin, type OrgCaller, type OrgPolicy } from '../../shared/org/policy';
import type { Worker } from '../../shared/flows/worker';
import type { TeamTask } from '../../shared/flows/team';
import type { Orchestration } from '../../shared/flows/orchestration';
import type { MainToRendererEvent } from '../../shared/types';
import { escapeMrkdwn, openIm, postMessage, updateMessage, type FetchLike } from './slackApi';

export const HIRE_CONFIRM_ACTION = 'overcli_hire_confirm';
export const HIRE_CANCEL_ACTION = 'overcli_hire_cancel';
export const HIRE_APPROVE_ACTION = 'overcli_hire_approve';
export const HIRE_REJECT_ACTION = 'overcli_hire_reject';
export const TEAM_APPROVE_ACTION = 'overcli_team_approve';
export const TEAM_CONTINUE_ACTION = 'overcli_team_continue';
export const TEAM_CANCEL_ACTION = 'overcli_team_cancel';
export const JOIN_LETIN_ACTION = 'overcli_join_letin';
export const JOIN_DECLINE_ACTION = 'overcli_join_decline';
/// A link button: Slack opens the URL and still sends the click here.
export const OPEN_LINK_ACTION = 'overcli_open_link';
export const PROPOSALS_APPROVE_ACTION = 'overcli_proposals_approve';
export const PROPOSALS_SKIP_ACTION = 'overcli_proposals_skip';
export const BUDGET_RAISE_ACTION = 'overcli_budget_raise';

/// A console question answered later than this gets its answer DMed too.
export const ASK_DM_AFTER_MS = 30_000;

export interface SlackCommandsDeps {
  org: OrgService;
  /// Invites and `/overcli join`. Absent: the access commands are not offered.
  access?: AccessService;
  policy(): OrgPolicy;
  botToken(): string | null;
  /// The workspace the bot is installed in; anything from another is ignored.
  teamId(): string | null;
  log(level: 'info' | 'warn', message: string): void;
  fetchImpl?: FetchLike;
}

interface SlashPayload {
  command?: string;
  text?: string;
  user_id?: string;
  user_name?: string;
  team_id?: string;
  response_url?: string;
}

const MAX_LINES = 25;

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

export class SlackCommands {
  /// DM thread → the hire it is interviewing for. In memory: a draft expires
  /// in a day, and after a restart `/hire` simply starts again.
  private hireThreads = new Map<string, string>();
  /// Display names seen on commands, so an approval DM can say who asked.
  private names = new Map<string, string>();
  /// DM thread → the team task whose questions it asked.
  private teamThreads = new Map<string, string>();
  /// The last state of each team task the requester was told about, so a
  /// stream of progress updates turns into one DM per thing that needs them.
  private toldTeam = new Map<string, string>();

  constructor(private readonly deps: SlackCommandsDeps) {}

  private caller(slackUserId: string, name?: string): OrgCaller {
    if (name) this.names.set(slackUserId, name);
    const display = name ?? this.names.get(slackUserId) ?? `<@${slackUserId}>`;
    return { slackUserId, name: display, admin: isAdmin(this.deps.policy(), { slackUserId, name: display, admin: false }) };
  }

  private fromOurTeam(teamId: unknown): boolean {
    const ours = this.deps.teamId();
    return !!ours && teamId === ours;
  }

  // ---- REPLIES ----------------------------------------------------------

  /// An ephemeral reply to a slash command. Only Slack's own hook host is
  /// accepted: the URL arrives in a payload, and a forged one must not turn
  /// this box into a proxy.
  private async respond(responseUrl: string | undefined, text: string, blocks?: unknown[]): Promise<void> {
    if (!responseUrl) return;
    let url: URL;
    try {
      url = new URL(responseUrl);
    } catch {
      return;
    }
    if (url.protocol !== 'https:' || url.hostname !== 'hooks.slack.com') return;
    try {
      await (this.deps.fetchImpl ?? fetch)(url.toString(), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json; charset=utf-8' },
        body: JSON.stringify({ response_type: 'ephemeral', text, ...(blocks ? { blocks } : {}) }),
      });
    } catch (err) {
      this.deps.log('warn', `Could not answer a slash command: ${String(err)}`);
    }
  }

  private async dm(userId: string, text: string, opts: { blocks?: unknown[]; threadTs?: string } = {}): Promise<{ channel: string; ts: string } | null> {
    const bot = this.deps.botToken();
    if (!bot) return null;
    const im = await openIm(bot, userId, this.deps.fetchImpl);
    if (!im.ok) {
      this.deps.log('warn', `Could not open a DM: ${im.error}`);
      return null;
    }
    const posted = await postMessage(bot, { channel: im.data, text, blocks: opts.blocks, threadTs: opts.threadTs }, this.deps.fetchImpl);
    if (!posted.ok) {
      this.deps.log('warn', `Could not send a DM: ${posted.error}`);
      return null;
    }
    return posted.data;
  }

  private async reply(channel: string, threadTs: string, text: string, blocks?: unknown[]): Promise<{ channel: string; ts: string } | null> {
    const bot = this.deps.botToken();
    if (!bot) return null;
    const posted = await postMessage(bot, { channel, threadTs, text, blocks }, this.deps.fetchImpl);
    return posted.ok ? posted.data : null;
  }

  // ---- SLASH ------------------------------------------------------------

  async onSlash(payload: unknown): Promise<void> {
    const p = payload as SlashPayload;
    if (!p?.user_id || !this.fromOurTeam(p.team_id)) return;
    const caller = this.caller(p.user_id, p.user_name);
    const text = (p.text ?? '').trim();
    if (p.command === '/hire') return this.hire(caller, text, p.response_url);
    if (p.command === '/worker') return this.worker(caller, text, p.response_url);
    if (p.command === '/team') return this.team(caller, text, p.response_url);
    if (p.command === '/overcli') return this.overcli(caller, text, p.response_url);
  }

  /// A person's real name, for invites and requests. Falls back to the handle.
  private async realName(slackUserId: string, fallback: string): Promise<string> {
    const bot = this.deps.botToken();
    if (!bot) return fallback;
    const res = await slackCall<{ user?: { real_name?: string; profile?: { real_name?: string } } }>('users.info', bot, { user: slackUserId }, this.deps.fetchImpl);
    return (res.ok && (res.data.user?.profile?.real_name || res.data.user?.real_name)) || fallback;
  }

  /// `/overcli join`: ask to use the org's workers. Slack has already said
  /// who is asking.
  private async overcli(caller: OrgCaller, text: string, responseUrl?: string): Promise<void> {
    const access = this.deps.access;
    if (text.toLowerCase() !== 'join' || !access) {
      return this.respond(responseUrl, '`/overcli join` asks to use this org’s AI workers. Once you’re in: `/worker`, `/team`, `/hire`.');
    }
    const name = await this.realName(caller.slackUserId!, caller.name);
    const base = access.baseUrl();
    const res = await access.requestJoin({ slackUserId: caller.slackUserId!, name }, base ?? '');
    if (!res.ok) return this.respond(responseUrl, res.error);
    return this.respond(
      responseUrl,
      res.outcome === 'invited'
        ? 'I’ve sent you a sign-in link in a DM.'
        : res.outcome === 'already'
          ? 'You’ve already asked. An admin will let you in soon.'
          : 'Asked. An admin will let you in, and I’ll DM you a link when they do.',
    );
  }

  /// `/team` lists teams; `/team <name>: <task>` gives one a task. The
  /// coordinator's questions and plan come back as DMs (`onTeamTask`).
  private async team(caller: OrgCaller, text: string, responseUrl?: string): Promise<void> {
    const { org } = this.deps;
    if (!text) {
      const teams = org.teams(caller);
      if (!teams.length) return this.respond(responseUrl, 'You cannot see any teams yet.');
      return this.respond(responseUrl, `${teams.length} teams`, [
        section(
          teams
            .map((t) => `• *${escapeMrkdwn(t.name)}*${t.purpose ? ` — ${escapeMrkdwn(clip(t.purpose, 80))}` : ''}\n   ${escapeMrkdwn(t.members.map((m) => m.name).join(', '))}`)
            .join('\n'),
        ),
        context('Give one a task: `/team <name>: what you want back`'),
      ]);
    }
    const at = text.indexOf(':');
    if (at <= 0) return this.respond(responseUrl, 'Name the team, then the task: `/team Pricing: review Q4 pricing against the three main competitors`');
    const res = org.briefTeam(caller, text.slice(0, at).trim(), text.slice(at + 1).trim());
    return this.respond(
      responseUrl,
      res.ok
        ? `${res.task.teamName} is on it. Its coordinator will DM you with questions or a plan to approve.`
        : res.error,
    );
  }

  private async worker(caller: OrgCaller, text: string, responseUrl?: string): Promise<void> {
    const { org } = this.deps;
    if (!text || text === 'list') {
      const list = org.listWorkers(caller);
      if (!list.length) return this.respond(responseUrl, 'No workers you can see yet. Hire one with `/hire <what the job is>`, or ask a teammate to share theirs.');
      return this.respond(responseUrl, `${list.length} workers`, [section(list.slice(0, MAX_LINES).map(workerLine).join('\n'))]);
    }
    if (text === 'waiting') {
      const items = org.listWaiting(caller);
      const proposed = org.proposals(caller);
      const total = items.length + proposed.length;
      if (!total) return this.respond(responseUrl, 'Nothing is waiting on you.');
      const lines = [
        ...proposed.map((b) => `• *${escapeMrkdwn(b.workerName)}* proposes ${b.items.length === 1 ? 'one thing' : `${b.items.length} things`} to do`),
        ...items.map(waitingLine),
      ];
      return this.respond(responseUrl, `${total} waiting on you`, [
        section(lines.slice(0, MAX_LINES).join('\n')),
        context('Answer a question in the DM thread it came in, or use the buttons on its DM. Pick proposed work item by item on Today in the console.'),
      ]);
    }
    if (text === 'help') return this.respond(responseUrl, HELP);
    // `<name> [verb] [rest]`, where the name may be several words: try the
    // longest prefix that names a worker.
    const words = text.split(/\s+/);
    let worker: Worker | null = null;
    let used = 0;
    for (let n = words.length; n > 0 && !worker; n--) {
      worker = org.resolve(caller, words.slice(0, n).join(' '));
      if (worker) used = n;
    }
    if (!worker) return this.respond(responseUrl, `No worker called "${clip(words[0], 40)}" that you can see. Try \`/worker\` for the list.`);
    const verb = words[used]?.toLowerCase();
    const rest = words.slice(used + 1).join(' ');
    if (!verb) {
      const got = org.getWorker(caller, worker.id);
      if (!got.ok) return this.respond(responseUrl, got.error);
      const w = got.worker;
      const recent = got.recent.slice(0, 5).map((e) => `• ${escapeMrkdwn(clip(e.title || e.kind, 120))}`).join('\n');
      return this.respond(responseUrl, w.name, [
        section(`*${escapeMrkdwn(w.name)}* — ${escapeMrkdwn(w.tagline)}\n${workerFacts(w)}`),
        section(escapeMrkdwn(clip(got.jobDescription, 1200))),
        ...(recent ? [section(`*Recently*\n${recent}`)] : []),
      ]);
    }
    if (verb === 'pause' || verb === 'resume') {
      const res = org.setPaused(caller, worker.id, verb === 'pause');
      return this.respond(responseUrl, res.ok ? `${res.name} is ${verb === 'pause' ? 'paused' : 'back at work'}.` : res.error);
    }
    if (verb === 'ask') {
      if (!rest.trim()) return this.respond(responseUrl, `What should I ask ${worker.name}? \`/worker ${worker.name} ask …\``);
      await this.respond(responseUrl, `Asked ${worker.name}. The answer will come to you in a DM.`);
      const res = await org.ask(caller, worker.id, rest, 'slack');
      await this.dm(
        caller.slackUserId!,
        res.ok ? `${worker.name}: ${clip(res.reply, 2800)}` : `${worker.name} could not take that: ${res.error}`,
        res.ok
          ? {
              blocks: [
                section(`*${escapeMrkdwn(worker.name)}* answered _${escapeMrkdwn(clip(rest, 120))}_`),
                section(escapeMrkdwn(clip(res.reply, 2800))),
                ...(res.launched ? [context(`Started ${res.launched} piece(s) of work.`)] : []),
              ],
            }
          : {},
      );
      return;
    }
    return this.respond(responseUrl, HELP);
  }

  private async hire(caller: OrgCaller, text: string, responseUrl?: string): Promise<void> {
    if (!text) return this.respond(responseUrl, 'Describe the job: `/hire watch our usage dashboards and send me a weekly summary of what changed`');
    await this.respond(responseUrl, 'Drafting a hire — I will DM you the questions or the contract.');
    const head = await this.dm(caller.slackUserId!, `Drafting a hire: ${clip(text, 200)}`, {
      blocks: [section(`*Drafting a hire*\n${quote(text)}`)],
    });
    if (!head) return;
    const res = await this.deps.org.draftHire(caller, { jobDescription: text });
    if (!res.ok) {
      await this.reply(head.channel, head.ts, res.error);
      return;
    }
    this.hireThreads.set(`${head.channel}:${head.ts}`, res.hire.hireId);
    await this.showDraft(head.channel, head.ts, res.hire);
  }

  private async showDraft(channel: string, threadTs: string, hire: HireSummary): Promise<void> {
    if (hire.questions) {
      await this.reply(channel, threadTs, 'A few questions first', [
        section(`*A few questions first*\n${hire.questions.map((q) => quote(q)).join('\n')}`),
        context('Reply in this thread. Say "just draft it" to skip the rest.'),
      ]);
      return;
    }
    const c = hire.contract!;
    await this.reply(channel, threadTs, `Ready to hire ${c.name}`, [
      section(`*${escapeMrkdwn(c.name)}*${c.tagline ? ` — ${escapeMrkdwn(c.tagline)}` : ''}\n${quote(clip(c.jobDescription, 1500))}`),
      context(
        `$${c.budgetUSDPerMonth}/month · ${escapeMrkdwn(c.schedule)} · tools: ${escapeMrkdwn(c.connectors.join(', ') || 'none')}`,
      ),
      context(`You become its manager. It starts on probation${c.cadence ? ', so you approve what it proposes at each run' : ''}. Change its schedule, who it reports to and who may ask it on its page in the console.`),
      {
        type: 'actions',
        elements: [
          button(`Hire ${c.name}`, HIRE_CONFIRM_ACTION, hire.hireId, 'primary'),
          button('Cancel', HIRE_CANCEL_ACTION, hire.hireId),
        ],
      },
    ]);
  }

  // ---- THREADS ----------------------------------------------------------

  /// A reply in a hire interview thread. Returns false when the thread is not
  /// one of ours, so the bridge can ignore it.
  async onThreadReply(event: { channel?: string; thread_ts?: string; user?: string; text?: string }, teamId: unknown): Promise<boolean> {
    const key = `${event.channel}:${event.thread_ts}`;
    const taskId = this.teamThreads.get(key);
    if (taskId && event.user && this.fromOurTeam(teamId)) {
      const text = (event.text ?? '').trim();
      if (!text) return true;
      // One reply answers every question: numbered lines go to their
      // questions; anything else answers them all at once.
      const numbered = text.split(/\n+/).map((l) => /^\s*(\d+)[.)]\s*(.+)$/.exec(l)).filter((m): m is RegExpExecArray => !!m);
      const answers = numbered.length ? numbered.sort((a, b) => Number(a[1]) - Number(b[1])).map((m) => m[2]) : [text];
      const res = this.deps.org.decideTeamTask(this.caller(event.user), taskId, { kind: 'answer', answers });
      await this.reply(event.channel!, event.thread_ts!, res.ok ? 'Thanks — the coordinator is planning with that.' : res.error);
      if (res.ok) this.teamThreads.delete(key);
      return true;
    }
    const hireId = this.hireThreads.get(key);
    if (!hireId || !event.user || !this.fromOurTeam(teamId)) return false;
    const caller = this.caller(event.user);
    const text = (event.text ?? '').trim();
    if (!text) return true;
    const skip = /^just draft it\b/i.test(text);
    const res = await this.deps.org.draftHire(caller, { hireId, answer: skip ? '' : text, skipQuestions: skip });
    if (!res.ok) {
      await this.reply(event.channel!, event.thread_ts!, res.error);
      return true;
    }
    await this.showDraft(event.channel!, event.thread_ts!, res.hire);
    return true;
  }

  // ---- BUTTONS ----------------------------------------------------------

  handlesAction(actionId: string | undefined): boolean {
    return (
      actionId === HIRE_CONFIRM_ACTION ||
      actionId === HIRE_CANCEL_ACTION ||
      actionId === HIRE_APPROVE_ACTION ||
      actionId === HIRE_REJECT_ACTION ||
      actionId === TEAM_APPROVE_ACTION ||
      actionId === TEAM_CONTINUE_ACTION ||
      actionId === TEAM_CANCEL_ACTION ||
      actionId === JOIN_LETIN_ACTION ||
      actionId === JOIN_DECLINE_ACTION ||
      actionId === OPEN_LINK_ACTION ||
      actionId === BUDGET_RAISE_ACTION ||
      actionId === PROPOSALS_APPROVE_ACTION ||
      actionId === PROPOSALS_SKIP_ACTION
    );
  }

  async onAction(payload: unknown): Promise<void> {
    const p = payload as {
      user?: { id?: string; name?: string; username?: string };
      team?: { id?: string };
      actions?: Array<{ action_id?: string; value?: string }>;
      container?: { channel_id?: string; message_ts?: string; thread_ts?: string };
      channel?: { id?: string };
      message?: { ts?: string; thread_ts?: string };
    };
    const action = p.actions?.[0];
    if (!p.user?.id || !action?.value || !this.fromOurTeam(p.team?.id)) return;
    const caller = this.caller(p.user.id, p.user.name ?? p.user.username);
    const channel = p.channel?.id ?? p.container?.channel_id;
    const ts = p.message?.ts ?? p.container?.message_ts;
    const threadTs = p.message?.thread_ts ?? p.container?.thread_ts ?? ts;
    const settle = async (text: string) => {
      const bot = this.deps.botToken();
      if (bot && channel && ts) await updateMessage(bot, { channel, ts, text, blocks: [section(escapeMrkdwn(text))] }, this.deps.fetchImpl);
    };
    const { org } = this.deps;
    switch (action.action_id) {
      case OPEN_LINK_ACTION:
        return;
      case BUDGET_RAISE_ACTION: {
        const [workerId, amount] = action.value.split(':');
        const res = org.update(caller, workerId, { budgetUSDPerMonth: Number(amount) });
        if (!res.ok) {
          if (channel && threadTs) await this.reply(channel, threadTs, res.error);
          return;
        }
        await settle(`${caller.name} raised ${res.worker.name}'s budget to $${Number(amount)} a month.`);
        return;
      }
      case PROPOSALS_APPROVE_ACTION:
      case PROPOSALS_SKIP_ACTION: {
        const approve = action.action_id === PROPOSALS_APPROVE_ACTION;
        const batch = org.proposals(caller).find((b) => b.batchId === action.value);
        if (!batch) {
          await settle('Already decided.');
          return;
        }
        const res = await org.decideProposal(caller, action.value, approve ? { approve: 'all' } : { approve: [], skip: batch.items.map((i) => i.candidateId) });
        if (!res.ok) {
          if (channel && threadTs) await this.reply(channel, threadTs, res.error);
          return;
        }
        await settle(approve ? `Approved by ${caller.name}: ${res.queued} started.` : `Skipped by ${caller.name}.`);
        return;
      }
      case JOIN_LETIN_ACTION:
      case JOIN_DECLINE_ACTION: {
        const access = this.deps.access;
        if (!access) return;
        const approve = action.action_id === JOIN_LETIN_ACTION;
        const base = access.baseUrl();
        if (approve && !base) {
          if (channel && threadTs) await this.reply(channel, threadTs, 'I don’t know this org’s address to build their link. Set publicUrl in org.json, or let them in from the console’s People page.');
          return;
        }
        const res = await access.decideRequest(caller, action.value, approve, base ?? '');
        if (!res.ok) {
          if (channel && threadTs) await this.reply(channel, threadTs, res.error);
          return;
        }
        await settle(approve ? `Let in by ${caller.name}. They have their link.` : `Turned down by ${caller.name}.`);
        return;
      }
      case HIRE_CANCEL_ACTION: {
        const res = org.cancelHire(caller, action.value);
        if (!res.ok) {
          if (channel && threadTs) await this.reply(channel, threadTs, res.error);
          return;
        }
        await settle('Hire cancelled.');
        return;
      }
      case HIRE_CONFIRM_ACTION: {
        const res = org.confirmHire(caller, action.value);
        if (!res.ok) {
          if (channel && threadTs) await this.reply(channel, threadTs, res.error);
          return;
        }
        await settle(
          res.hired
            ? `Hired ${res.hired.name}. You are its manager; it starts on probation.`
            : `Sent for approval — ${(res.hire.reasons ?? []).join(' ')}`,
        );
        return;
      }
      case TEAM_APPROVE_ACTION:
      case TEAM_CONTINUE_ACTION:
      case TEAM_CANCEL_ACTION: {
        const kind = action.action_id === TEAM_APPROVE_ACTION ? 'approve' : action.action_id === TEAM_CONTINUE_ACTION ? 'continue' : 'cancel';
        const res = org.decideTeamTask(caller, action.value, { kind });
        if (!res.ok) {
          if (channel && threadTs) await this.reply(channel, threadTs, res.error);
          return;
        }
        await settle(kind === 'approve' ? 'Plan approved — the team is on it.' : kind === 'continue' ? 'Carrying on.' : 'Task cancelled.');
        return;
      }
      case HIRE_APPROVE_ACTION:
      case HIRE_REJECT_ACTION: {
        const approve = action.action_id === HIRE_APPROVE_ACTION;
        const res = org.decideHire(caller, action.value, approve);
        if (!res.ok) {
          if (channel && threadTs) await this.reply(channel, threadTs, res.error);
          return;
        }
        await settle(approve ? `Approved by ${caller.name}${res.hired ? ` — ${res.hired.name} is hired.` : '.'}` : `Turned down by ${caller.name}.`);
        return;
      }
    }
  }

  // ---- TEAM TASKS -------------------------------------------------------

  /// Fed every engine event; acts on team task changes. The person who asked
  /// for a task hears about it when it needs them, and when it is done.
  onEvent(event: MainToRendererEvent): void {
    if (event.type === 'teamTaskUpdate') void this.onTeamTask(event.task);
    else if (event.type === 'orchestrationUpdate') void this.onBatch(event.orchestration);
  }

  /// Batches already put in front of a manager, so progress updates on the
  /// same batch do not DM again.
  private toldBatches = new Set<string>();

  /// A worker on probation proposed work at a scheduled run: ask its manager.
  private async onBatch(o: Orchestration): Promise<void> {
    if (o.origin?.kind !== 'worker' || this.toldBatches.has(o.id)) return;
    const items = o.items.filter((i) => i.status === 'proposed');
    if (!items.length) return;
    const to = this.deps.org.managerSlackId(o.origin.workerId);
    if (!to || !this.deps.botToken()) return;
    this.toldBatches.add(o.id);
    const name = o.origin.workerName;
    const lines = items.slice(0, 8).map((i) => `• ${escapeMrkdwn(clip(i.candidate.title, 140))}`).join('\n');
    const posted = await this.dm(to, `${name} proposes ${items.length} thing${items.length === 1 ? '' : 's'} to do`, {
      blocks: [
        section(`*${escapeMrkdwn(name)}* proposes ${items.length === 1 ? 'one thing' : `${items.length} things`} from its ${o.origin.task === 'errand' ? 'errand' : 'scheduled run'}:\n${lines}${items.length > 8 ? `\n…and ${items.length - 8} more` : ''}`),
        {
          type: 'actions',
          elements: [
            button(items.length === 1 ? 'Approve' : 'Approve all', PROPOSALS_APPROVE_ACTION, o.id, 'primary'),
            button('Skip', PROPOSALS_SKIP_ACTION, o.id),
          ],
        },
        context('Pick item by item on the console’s Today page. Trusted workers start their own runs without asking.'),
      ],
    });
    if (!posted) this.toldBatches.delete(o.id);
  }

  private async onTeamTask(task: TeamTask): Promise<void> {
    const to = task.requestedBy?.slackUserId;
    if (!to || !this.deps.botToken()) return;
    const state =
      task.status === 'waiting' ? `waiting:${task.waiting?.reason}:${task.stageIndex}` : `${task.status}:${task.stageIndex}`;
    if (this.toldTeam.get(task.id) === state) return;
    // Claimed before the post, which awaits: a burst of updates for one
    // state must not each send the DM.
    const previous = this.toldTeam.get(task.id);
    this.toldTeam.set(task.id, state);
    const title = escapeMrkdwn(task.title ?? clip(task.brief, 80));
    const team = escapeMrkdwn(task.teamName);
    let posted: { channel: string; ts: string } | null = null;
    if (task.status === 'questions' && task.questions?.length) {
      posted = await this.dm(to, `${task.teamName} has questions about "${task.title ?? task.brief}"`, {
        blocks: [
          section(`*${team}* has a few questions before it plans _${title}_`),
          section(task.questions.map((q, i) => `${i + 1}. ${escapeMrkdwn(q)}`).join('\n')),
          context('Reply in this thread. Number your answers to match, or write one answer for all of them.'),
        ],
      });
      if (posted) this.teamThreads.set(`${posted.channel}:${posted.ts}`, task.id);
    } else if (task.status === 'proposed') {
      const stages = task.stages.map((s, i) => `${i + 1}. ${escapeMrkdwn(s.title)}`).join('\n');
      posted = await this.dm(to, `${task.teamName}'s plan for "${task.title ?? task.brief}" is ready`, {
        blocks: [
          section(`*${team}* has a plan for _${title}_${task.planNote ? `\n${quote(clip(task.planNote, 1200))}` : ''}`),
          ...(stages ? [section(stages)] : []),
          context(`Budget: up to $${task.budgetUSD} for this task.`),
          {
            type: 'actions',
            elements: [button('Approve the plan', TEAM_APPROVE_ACTION, task.id, 'primary'), button('Cancel', TEAM_CANCEL_ACTION, task.id)],
          },
        ],
      });
    } else if (task.status === 'waiting' && task.waiting && task.waiting.reason !== 'away') {
      posted = await this.dm(to, `${task.teamName} is waiting on you`, {
        blocks: [
          section(`*${team}* stopped on _${title}_\n${escapeMrkdwn(clip(task.waiting.message, 1200))}`),
          {
            type: 'actions',
            elements: [button('Carry on', TEAM_CONTINUE_ACTION, task.id, 'primary'), button('Cancel the task', TEAM_CANCEL_ACTION, task.id, 'danger')],
          },
        ],
      });
    } else if (task.status === 'done' && task.pack) {
      posted = await this.dm(to, `${task.teamName} finished "${task.title ?? task.brief}"`, {
        blocks: [
          section(`*${team}* finished _${title}_`),
          section(escapeMrkdwn(clip(task.pack.summary, 2500))),
          context(`Spent $${task.spentUSD.toFixed(2)}. Files: ${escapeMrkdwn(task.pack.files.join(', ') || 'none')}.`),
        ],
      });
    } else {
      // Progress the requester does not need to act on: remembered, unsaid.
      return;
    }
    if (!posted) {
      if (previous === undefined) this.toldTeam.delete(task.id);
      else this.toldTeam.set(task.id, previous);
    }
  }

  // ---- ACCESS -------------------------------------------------------------

  /// The invite DM: who asked, what they can do, and the one-time link.
  async dmInvite(invite: Invite, link: string, org: string): Promise<boolean> {
    if (!invite.slackUserId) return false;
    const can = ROLE_TEXT[invite.role];
    const posted = await this.dm(invite.slackUserId, `${invite.invitedBy.name} invited you to ${org}’s AI workers`, {
      blocks: [
        section(`*${escapeMrkdwn(invite.invitedBy.name)}* invited you to *${escapeMrkdwn(org)}*’s AI workers. You’ll be able to ${escapeMrkdwn(can)}${invite.allowanceUSD ? `, up to $${invite.allowanceUSD} a month` : ''}.`),
        {
          type: 'actions',
          elements: [{ type: 'button', style: 'primary', text: { type: 'plain_text', text: 'Sign in' }, url: link, action_id: OPEN_LINK_ACTION, value: invite.id }],
        },
        context('The link signs you in once and works for a week. Already, here in Slack: `/worker`, `/team` and `/hire`.'),
      ],
    });
    return !!posted;
  }

  askAdmins(request: JoinRequest, admins: string[], org: string): void {
    for (const admin of admins) {
      void this.dm(admin, `${request.name} asked to join ${org}’s workers`, {
        blocks: [
          section(`<@${request.slackUserId}> (${escapeMrkdwn(request.name)}) asked to use *${escapeMrkdwn(org)}*’s workers.`),
          {
            type: 'actions',
            elements: [
              button('Let them in', JOIN_LETIN_ACTION, request.id, 'primary'),
              button('Decline', JOIN_DECLINE_ACTION, request.id),
            ],
          },
          context('They’ll be able to ask workers things. Make them a hirer from People in the console.'),
        ],
      });
    }
  }

  /// An engine notice an org should hear: a worker out of budget goes to its
  /// manager, the shared pool running dry to the admins. The rest stays in
  /// the log, where it always went.
  onNotice(notice: { title: string; body: string; workerId?: string; forAdmins?: boolean }): void {
    if (!this.deps.botToken()) return;
    const to = notice.workerId
      ? [this.deps.org.managerSlackId(notice.workerId)].filter((id): id is string => !!id)
      : notice.forAdmins
        ? this.deps.policy().admins
        : [];
    // Out of budget: offer a raise of half again, which the allowance rules
    // still check when it is pressed.
    const worker = notice.workerId ? this.deps.org.listWorkers({ name: 'overcli', admin: true }).find((w) => w.id === notice.workerId) : undefined;
    const raiseTo = worker ? Math.max(worker.budgetUSDPerMonth + 5, Math.ceil((worker.budgetUSDPerMonth * 1.5) / 5) * 5) : 0;
    for (const id of to) {
      void this.dm(id, notice.title, {
        blocks: [
          section(`*${escapeMrkdwn(notice.title)}*\n${escapeMrkdwn(clip(notice.body, 1500))}`),
          ...(worker ? [{ type: 'actions', elements: [button(`Raise to $${raiseTo} a month`, BUDGET_RAISE_ACTION, `${worker.id}:${raiseTo}`, 'primary')] }] : []),
          context(notice.workerId ? 'Or change its budget on its page in the console.' : 'Raise budgets or pause some workers from the console.'),
        ],
      });
    }
  }

  /// A question asked in the console came back after the asker had likely
  /// moved on: the answer follows them to Slack.
  askAnswered(ask: AskRecord): void {
    if (ask.via !== 'console' || !ask.slackUserId || !this.deps.botToken()) return;
    if ((ask.doneAt ?? 0) - ask.at < ASK_DM_AFTER_MS) return;
    const head = ask.status === 'answered' ? `*${escapeMrkdwn(ask.workerName)}* answered _${escapeMrkdwn(clip(ask.text, 120))}_` : `*${escapeMrkdwn(ask.workerName)}* could not answer _${escapeMrkdwn(clip(ask.text, 120))}_`;
    void this.dm(ask.slackUserId, `${ask.workerName}: ${clip(ask.reply ?? ask.error ?? '', 2800)}`, {
      blocks: [section(head), section(escapeMrkdwn(clip(ask.reply ?? ask.error ?? '', 2800))), ...(ask.launched ? [context(`Started ${ask.launched} piece(s) of work.`)] : [])],
    });
  }

  /// A plain notice to some people, e.g. a spend warning.
  tellPeople(ids: string[], title: string, body: string): void {
    if (!this.deps.botToken()) return;
    for (const id of ids) void this.dm(id, title, { blocks: [section(`*${escapeMrkdwn(title)}*\n${escapeMrkdwn(clip(body, 1500))}`)] });
  }

  tellRequester(slackUserId: string, text: string): void {
    void this.dm(slackUserId, text);
  }

  // ---- NOTIFICATIONS FROM THE SERVICE -----------------------------------

  /// Ask each approver about a hire over someone's allowance.
  notifyApprovers(hire: PendingHire, approvers: string[]): void {
    // From the summary, not the draft: a worker published from someone's
    // app has no draft, and the approver must still see what it costs.
    const c = this.deps.org.summarize(hire).contract;
    const who = hire.requestedBy.slackUserId ? `<@${hire.requestedBy.slackUserId}>` : escapeMrkdwn(hire.requestedBy.name);
    for (const approver of approvers) {
      void this.dm(approver, `${hire.requestedBy.name} wants to hire ${c?.name ?? 'a worker'}`, {
        blocks: [
          section(`*Hire approval* — ${who} wants to hire *${escapeMrkdwn(c?.name ?? 'a worker')}*`),
          ...(c ? [section(quote(clip(c.jobDescription, 1200)))] : []),
          context(`$${c?.budgetUSDPerMonth ?? 0}/month · ${escapeMrkdwn(c?.schedule ?? 'When asked')} · tools: ${escapeMrkdwn((c?.connectors ?? []).join(', ') || 'none')}`),
          section((hire.reasons ?? []).map((r) => `• ${escapeMrkdwn(r)}`).join('\n') || 'Needs an approver.'),
          {
            type: 'actions',
            elements: [
              button('Approve hire', HIRE_APPROVE_ACTION, hire.id, 'primary'),
              button('Turn down', HIRE_REJECT_ACTION, hire.id, 'danger'),
            ],
          },
        ],
      });
    }
  }

  notifyDecided(hire: PendingHire, outcome: { approved: boolean; by: string; worker?: Worker; error?: string }): void {
    const to = hire.requestedBy.slackUserId;
    if (!to) return;
    const name = this.deps.org.summarize(hire).contract?.name ?? 'your hire';
    const text = outcome.error
      ? `${outcome.by} approved ${name}, but hiring failed: ${outcome.error}`
      : outcome.approved
        ? `${outcome.by} approved ${name} — hired. You are its manager.`
        : `${outcome.by} turned down ${name}.`;
    void this.dm(to, text);
  }
}

const HELP = [
  '`/worker` — the workers you can see',
  '`/worker waiting` — questions, approvals and proposed work waiting on you',
  '`/worker <name>` — one worker',
  '`/worker <name> ask <text>` — ask it to do something',
  '`/worker <name> pause` / `resume`',
  '`/hire <job description>` — hire a worker',
  '`/team <name>: <task>` — give a team a task',
  '`/overcli join` — ask to join, or get a new sign-in link',
].join('\n');

function section(text: string) {
  return { type: 'section', text: { type: 'mrkdwn', text: clip(text, 2900) } };
}

function context(text: string) {
  return { type: 'context', elements: [{ type: 'mrkdwn', text: clip(text, 2900) }] };
}

function quote(text: string): string {
  return text
    .split('\n')
    .map((line) => `> ${escapeMrkdwn(line)}`)
    .join('\n');
}

function button(text: string, actionId: string, value: string, style?: 'primary' | 'danger') {
  return { type: 'button', text: { type: 'plain_text', text: clip(text, 70) }, action_id: actionId, value, ...(style ? { style } : {}) };
}

function workerFacts(w: WorkerSummary): string {
  return [
    w.manager ? `manager ${escapeMrkdwn(w.manager)}` : 'no manager',
    w.reportsTo ? `reports to ${escapeMrkdwn(w.reportsTo.name)}` : null,
    `$${w.spentThisMonthUSD.toFixed(2)} of $${w.budgetUSDPerMonth}/mo`,
    w.waiting ? `*${w.waiting} waiting*` : null,
    w.enabled ? null : 'paused',
  ]
    .filter(Boolean)
    .join(' · ');
}

function workerLine(w: WorkerSummary): string {
  return `• *${escapeMrkdwn(w.name)}* — ${escapeMrkdwn(clip(w.tagline, 80))}\n   ${workerFacts(w)}`;
}

function waitingLine(it: WaitingItem): string {
  const what = it.kind === 'question' ? escapeMrkdwn(clip(it.question ?? 'a question', 160)) : 'wants your approval for a step that reaches outside overcli';
  return `• *${escapeMrkdwn(it.workerName)}* (${escapeMrkdwn(clip(it.title, 60))}): ${what}`;
}
