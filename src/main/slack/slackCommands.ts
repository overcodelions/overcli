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
import { escapeMrkdwn, fetchMessage, openIm, openView, postMessage, updateMessage, uploadFile, userName, type FetchLike } from './slackApi';
import { HIRE_EDIT_VIEW, TEAM_EDIT_VIEW, hireEditView, readHireEdit, readTeamEdit, teamEditView, type EditMeta, type TeamDraftForm } from './editForms';
import { DEFAULT_TEAM_CHECKPOINTS } from '../../shared/flows/team';
import { deliverResults, finishedText, slackMarkup, type PostAs } from './deliver';
import { TEAM_ACCEPT_ACTION, TEAM_CONTINUE_ACTION, TEAM_PIECE_APPROVE_ACTION, TEAM_PIECE_RETRY_ACTION, stageNote, stagesDone, teamCard, type PieceLook } from './teamCard';

export const HIRE_CONFIRM_ACTION = 'overcli_hire_confirm';
export const HIRE_CANCEL_ACTION = 'overcli_hire_cancel';
export const HIRE_APPROVE_ACTION = 'overcli_hire_approve';
export const HIRE_REJECT_ACTION = 'overcli_hire_reject';
export const TEAM_APPROVE_ACTION = 'overcli_team_approve';
export { TEAM_CONTINUE_ACTION };
export const TEAM_CANCEL_ACTION = 'overcli_team_cancel';
export const TEAM_MAKE_ACTION = 'overcli_team_make';
export const TEAM_DROP_ACTION = 'overcli_team_drop';
export const HIRE_EDIT_ACTION = 'overcli_hire_edit';
export const TEAM_EDIT_ACTION = 'overcli_team_edit';
/// What a new team starts with per task, until someone changes it in the console.
const NEW_TEAM_BUDGET_USD = 50;
export const JOIN_LETIN_ACTION = 'overcli_join_letin';
export const JOIN_DECLINE_ACTION = 'overcli_join_decline';
export const LINK_CONFIRM_ACTION = 'overcli_link_confirm';
export const LINK_DECLINE_ACTION = 'overcli_link_decline';
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
  /// A finished run's file, for attaching to a shift's DM. Absent: the DM
  /// carries the answer but no files.
  readFile?(path: string, maxBytes: number): Buffer | null;
  /// The console's Library, linked from a finished shift's DM.
  libraryUrl?(): string | null;
  now?(): number;
  /// Where each team task's live card is, so it is edited rather than
  /// posted again, across restarts. Absent: kept in memory.
  teamCards?: { load(): Record<string, TeamCardRef>; save(all: Record<string, TeamCardRef>): void };
  /// A file in a team task's folder, by name, for attaching the final pack.
  teamFile?(taskId: string, name: string, maxBytes: number): Buffer | null;
  /// A member's run as the card shows it: its latest step, and what a step
  /// waiting for approval would do.
  pieceLook?(runId: string): PieceLook | null;
  /// DM threads that asked a team's questions, by `channel:ts`, so an answer
  /// still lands after a restart. Absent: kept in memory only.
  teamThreads?: { load(): Record<string, string>; save(all: Record<string, string>): void };
  /// Where a new hire may work: the server's repos and workspaces.
  places?(): Array<{ name: string; path: string }>;
}

/// A team task's card in Slack, and what the thread under it was last told.
export interface TeamCardRef {
  channel: string;
  ts: string;
  /// Stages the thread has heard finish.
  told: number;
  at: number;
  done?: boolean;
  /// The pack's files went up to the thread.
  attached?: boolean;
}

/// Edits to one card are at least this far apart: a stage can send a burst
/// of updates, and Slack limits how often one message may change.
const CARD_EVERY_MS = 4000;

/// A shift's last update replayed after a restart is older than this, and its
/// manager was told when it happened.
const SHIFT_DM_WINDOW_MS = 30 * 60_000;

interface SlashPayload {
  command?: string;
  text?: string;
  user_id?: string;
  user_name?: string;
  team_id?: string;
  response_url?: string;
}

const MAX_LINES = 25;

/// Money as people write it: $8, $47.44. Budgets split from a pool carry
/// long fractions ($47.43996) that mean nothing to anyone reading.
function dollars(n: number): string {
  const cents = Math.round(n * 100) / 100;
  return `$${Number.isInteger(cents) ? cents : cents.toFixed(2)}`;
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

export class SlackCommands {
  /// DM thread → the hire it is interviewing for. In memory: a draft expires
  /// in a day, and after a restart `/hire` simply starts again.
  private hireThreads = new Map<string, string>();
  /// Crews suggested by `/team new`, waiting on Make the team. In memory: a
  /// restart means asking again.
  private teamDrafts = new Map<string, TeamDraftForm & { by: string; note: string; members: Array<{ workerId: string; name: string; role: string }>; hires: Array<{ job: string; role: string }> }>();
  /// Display names seen on commands, so an approval DM can say who asked.
  private names = new Map<string, string>();
  /// DM thread → the team task whose questions it asked.
  private threadsKept: Map<string, string> | null = null;
  /// DM thread → the team task whose questions it asked.
  private get teamThreads(): Map<string, string> {
    if (!this.threadsKept) this.threadsKept = new Map(Object.entries(this.deps.teamThreads?.load() ?? {}));
    return this.threadsKept;
  }
  private keepTeamThreads(): void {
    // The newest few hundred: a thread answered long ago needs no keeping.
    this.deps.teamThreads?.save(Object.fromEntries([...this.teamThreads].slice(-300)));
  }
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

  /// `as`: posted under a worker's or team's own name and picture.
  /// `inThread`: in that thread instead, where the request it's about was made.
  private async dm(userId: string, text: string, opts: { blocks?: unknown[]; threadTs?: string; broadcast?: boolean; as?: PostAs; inThread?: { channel: string; threadTs: string } } = {}): Promise<{ channel: string; ts: string } | null> {
    const bot = this.deps.botToken();
    if (!bot) return null;
    let channel = opts.inThread?.channel;
    if (!channel) {
      const im = await openIm(bot, userId, this.deps.fetchImpl);
      if (!im.ok) {
        this.deps.log('warn', `Could not open a DM: ${im.error}`);
        return null;
      }
      channel = im.data;
    }
    const post = { channel, text, blocks: opts.blocks, threadTs: opts.inThread?.threadTs ?? opts.threadTs, broadcast: opts.broadcast };
    const who = opts.as ? { username: opts.as.name, ...(opts.as.iconUrl ? { iconUrl: opts.as.iconUrl } : {}) } : {};
    let posted = await postMessage(bot, { ...post, ...who }, this.deps.fetchImpl);
    // An app installed before it could post under another name: as itself.
    if (!posted.ok && opts.as && posted.error === 'missing_scope') posted = await postMessage(bot, post, this.deps.fetchImpl);
    if (!posted.ok) {
      this.deps.log('warn', `Could not send a DM: ${posted.error}`);
      return null;
    }
    return posted.data;
  }

  /// A worker or team, as Slack messages are posted under: its name, and its
  /// picture when it has one.
  private asOf(id: string, name: string): PostAs {
    const pic = this.deps.org.pictureOf?.(id);
    return { name, ...(pic ? { iconUrl: pic } : {}) };
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
      // What each is on now, newest first, and whether it waits on you.
      const live = org.teamTasks(caller).filter((t) => !['done', 'failed', 'cancelled'].includes(t.status)).sort((a, b) => b.updatedAt - a.updatedAt);
      const now = (teamId: string) => {
        const t = live.find((x) => x.teamId === teamId);
        if (!t) return 'free';
        const stage = t.stages.find((s) => s.state === 'now');
        return `${t.waitingOnYou ? '*waiting on you* · ' : ''}on “${escapeMrkdwn(clip(t.title, 60))}”${stage ? ` · ${escapeMrkdwn(stage.label)}` : ''}`;
      };
      return this.respond(responseUrl, `${teams.length} teams`, [
        section(
          teams
            .map((t) => `• *${escapeMrkdwn(t.name)}*${t.purpose ? ` — ${escapeMrkdwn(clip(t.purpose, 80))}` : ''}\n   ${escapeMrkdwn(t.members.map((m) => m.name).join(', '))} · ${now(t.id)}`)
            .join('\n'),
        ),
        context('Give one a task: `/team <name>: what you want back`'),
      ]);
    }
    const made = /^new\b[:\s]*(.*)$/is.exec(text);
    if (made) return this.newTeam(caller, made[1].trim(), responseUrl);
    const at = text.indexOf(':');
    if (at <= 0) return this.respond(responseUrl, 'Name the team, then the task: `/team Pricing: review Q4 pricing against the three main competitors`. Or make one: `/team new writes PR/FAQs for new features`');
    const res = org.briefTeam(caller, text.slice(0, at).trim(), text.slice(at + 1).trim());
    return this.respond(
      responseUrl,
      !res.ok
        ? res.error
        : res.task.status === 'queued'
          ? `${res.task.teamName} is busy on another task, so this one is next in line. Its coordinator will DM you when it starts.`
          : `${res.task.teamName} is on it. Its coordinator will DM you with questions or a plan to approve.`,
    );
  }

  /// `/team new <what it's for>`: a crew from the workers this person
  /// manages, sent by DM to make or drop.
  private async newTeam(caller: OrgCaller, purpose: string, responseUrl?: string): Promise<void> {
    if (!purpose) return this.respond(responseUrl, 'Say what the team is for: `/team new writes PR/FAQs for new features`');
    await this.respond(responseUrl, 'Putting a crew together from your workers. I’ll DM you who and why.');
    const head = await this.dm(caller.slackUserId!, `A team for: ${clip(purpose, 200)}`, { blocks: [section(`*A team for*\n${quote(purpose)}`)] });
    if (!head) return;
    const put = await this.working(head.channel, head.ts, 'Picking the crew from your workers and writing what each does… about half a minute.');
    const res = await this.deps.org.suggestTeam(caller, purpose);
    if (!res.ok) {
      await put(res.error);
      return;
    }
    if (res.members.length + res.gaps.length < 2) {
      await put(`Only ${res.members.length === 1 ? `${res.members[0].name} fits` : 'none of your workers fit'} what the team is for. A team needs two or more: hire another, or describe the team differently.`);
      return;
    }
    const id = `${caller.slackUserId}:${Date.now().toString(36)}`;
    const draft = {
      by: caller.slackUserId!,
      name: res.name,
      purpose: res.purpose,
      note: res.note,
      members: res.members,
      hires: res.gaps,
      budgetUSDPerTask: NEW_TEAM_BUDGET_USD,
      checkpoints: { ...DEFAULT_TEAM_CHECKPOINTS },
      hireVisibility: 'private' as const,
      hasHires: res.gaps.length > 0,
    };
    this.teamDrafts.set(id, draft);
    const drawn = this.teamDraftMessage(id);
    await put(drawn.text, drawn.blocks);
  }

  /// A suggested team as its DM shows it, with what it would be made with.
  private teamDraftMessage(id: string): { text: string; blocks: unknown[] } {
    const d = this.teamDrafts.get(id)!;
    const lines = d.members.map((m) => `• *${escapeMrkdwn(m.name)}* — ${escapeMrkdwn(m.role)}`).join('\n');
    const gaps = d.hires.map((g) => `\n• _New hire_ — ${escapeMrkdwn(g.role || g.job)}`).join('');
    const checks = [d.checkpoints.askFirst && 'asks what it needs to know first', 'you approve each plan', d.checkpoints.reviewBeforeChallenge && 'you read the draft before it’s challenged', d.checkpoints.finalReview && 'you review the result'].filter(Boolean).join(', ');
    const who = { private: 'just you', team: 'people in your groups', org: 'everyone in the org' }[d.hireVisibility];
    return {
      text: `${d.name}: ${d.members.map((m) => m.name).join(', ')}`,
      blocks: [
        section(`*${escapeMrkdwn(d.name)}* — ${escapeMrkdwn(d.purpose)}\n${lines}${gaps}`),
        ...(d.note ? [context(escapeMrkdwn(clip(d.note, 300)))] : []),
        context(`$${d.budgetUSDPerTask} a task. ${checks[0].toUpperCase()}${checks.slice(1)}.${d.hires.length ? ` ${d.hires.length === 1 ? 'The new hire is' : 'New hires are'} hired when you make the team, and ${who} can ask ${d.hires.length === 1 ? 'it' : 'them'}.` : ''}`),
        { type: 'actions', elements: [button('Make the team', TEAM_MAKE_ACTION, id, 'primary'), button('Change it', TEAM_EDIT_ACTION, id), button('Cancel', TEAM_DROP_ACTION, id)] },
      ],
    };
  }

  private async worker(caller: OrgCaller, text: string, responseUrl?: string): Promise<void> {
    const { org } = this.deps;
    if (!text || text === 'list') {
      const list = org.listWorkers(caller);
      if (!list.length) return this.respond(responseUrl, 'No workers you can see yet. Hire one with `/hire <what the job is>`, or ask a teammate to share theirs.');
      // Yours first, then the rest you can see: shared with you, or every
      // worker in the org when you're an admin.
      const yours = list.filter((w) => !!caller.slackUserId && w.managerSlackUserId === caller.slackUserId);
      const others = list.filter((w) => !yours.includes(w));
      if (!yours.length || !others.length) return this.respond(responseUrl, `${list.length} workers`, [section(list.slice(0, MAX_LINES).map(workerLine).join('\n'))]);
      const admin = isAdmin(this.deps.policy(), caller);
      return this.respond(responseUrl, `${list.length} workers`, [
        section(`*Yours*\n${yours.slice(0, MAX_LINES).map(workerLine).join('\n')}`),
        section(`*${admin ? 'Everyone else’s' : 'Shared with you'}*\n${others.slice(0, Math.max(1, MAX_LINES - yours.length)).map(workerLine).join('\n')}`),
        ...(admin ? [context('You see every worker because you’re an admin.')] : []),
      ]);
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
    // "@Vantage," and "vantage:" name Vantage too.
    for (let n = words.length; n > 0 && !worker; n--) {
      worker = org.resolve(caller, words.slice(0, n).join(' ').replace(/^@/, '').replace(/[,:;.!?]+$/, ''));
      if (worker) used = n;
    }
    if (!worker) {
      return this.respond(
        responseUrl,
        `No worker called "${clip(words[0], 40)}" that you can see. Try \`/worker\` for the list, or DM me what you need and I'll pick the worker.`,
      );
    }
    let verb = words[used]?.toLowerCase();
    let rest = words.slice(used + 1).join(' ');
    // "/worker Vantage what do you know about …" is an ask without the word.
    if (verb && verb !== 'pause' && verb !== 'resume' && verb !== 'ask') {
      verb = 'ask';
      rest = words.slice(used).join(' ');
    }
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
                section(slackMarkup(clip(res.reply, 2800))),
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
    const put = await this.working(head.channel, head.ts, 'Reading the job and working out what to ask or offer… about half a minute.');
    const res = await this.deps.org.draftHire(caller, { jobDescription: text });
    if (!res.ok) {
      await put(res.error);
      return;
    }
    this.hireThreads.set(`${head.channel}:${head.ts}`, res.hire.hireId);
    await this.showDraft(put, res.hire);
  }

  /// Say at once that something slow is under way (a model turn takes half
  /// a minute), in the thread; what it returns puts the result in that same
  /// message when it's ready, or posts it if the message can't be changed.
  private async working(channel: string, threadTs: string, what: string): Promise<(text: string, blocks?: unknown[]) => Promise<void>> {
    const posted = await this.reply(channel, threadTs, what, [context(`_${escapeMrkdwn(what)}_`)]);
    return async (text, blocks) => {
      const bot = this.deps.botToken();
      if (posted && bot) {
        const done = await updateMessage(bot, { channel: posted.channel, ts: posted.ts, text, blocks: blocks ?? [section(escapeMrkdwn(text))] }, this.deps.fetchImpl);
        if (done.ok) return;
      }
      await this.reply(channel, threadTs, text, blocks);
    };
  }

  private async showDraft(put: (text: string, blocks?: unknown[]) => Promise<void>, hire: HireSummary): Promise<void> {
    if (hire.questions) {
      await put('A few questions first', [
        ...this.alreadyDoes(hire),
        section(`*A few questions first*\n${hire.questions.map((q) => quote(q)).join('\n')}`),
        context('Reply in this thread. Say "just draft it" to skip the rest.'),
      ]);
      return;
    }
    await put(`Ready to hire ${hire.contract!.name}`, [...this.alreadyDoes(hire), ...this.offerBlocks(hire)]);
  }

  /// Someone already does this job: said first, with how to ask them.
  private alreadyDoes(hire: HireSummary): unknown[] {
    const a = hire.alreadyDoes;
    if (!a) return [];
    return [
      section(`*${escapeMrkdwn(a.name)}* may already do this${a.why ? `: ${escapeMrkdwn(a.why)}` : a.tagline ? ` (${escapeMrkdwn(a.tagline)})` : ''}. Ask ${escapeMrkdwn(a.name)} instead with \`@overcli ${escapeMrkdwn(a.name)}, …\`, or carry on to hire.`),
      { type: 'divider' },
    ];
  }

  /// An offer as its message shows it: who, the job, what it gets, and the buttons.
  private offerBlocks(hire: HireSummary): unknown[] {
    const c = hire.contract!;
    const where = c.projectPath ? this.deps.places?.().find((p) => p.path === c.projectPath)?.name ?? c.projectPath.split('/').pop() : null;
    const who = { private: 'just you', team: 'people in your groups', org: 'everyone in the org' }[c.visibility ?? 'private'];
    return [
      section(`*${escapeMrkdwn(c.name)}*${c.tagline ? ` — ${escapeMrkdwn(c.tagline)}` : ''}\n${quote(clip(c.jobDescription, 1500))}`),
      context(
        `${dollars(c.budgetUSDPerMonth)}/month · ${escapeMrkdwn(c.schedule)} · tools: ${escapeMrkdwn(c.connectors.join(', ') || 'none')}${where ? ` · works in ${escapeMrkdwn(where)}` : ''}`,
      ),
      context(`Who can ask it: ${who}.${c.reportsTo ? ` Reports to ${escapeMrkdwn(c.reportsTo)}.` : ''} You become its manager. It starts on probation${c.cadence ? ', so you approve what it proposes at each run' : ''}.`),
      {
        type: 'actions',
        elements: [
          button(`Hire ${c.name}`, HIRE_CONFIRM_ACTION, hire.hireId, 'primary'),
          button('Change it', HIRE_EDIT_ACTION, hire.hireId),
          button('Cancel', HIRE_CANCEL_ACTION, hire.hireId),
        ],
      },
    ];
  }

  /// Which hire, and what its offer is now, for the Change it form.
  handlesView(callbackId: string | undefined): boolean {
    return callbackId === HIRE_EDIT_VIEW || callbackId === TEAM_EDIT_VIEW;
  }

  /// A Change it form was saved: apply it and redraw the message it came from.
  async onViewSubmit(payload: unknown): Promise<void> {
    const p = payload as { user?: { id?: string; name?: string; username?: string }; team?: { id?: string }; view?: { callback_id?: string; private_metadata?: string; state?: { values?: Record<string, never> } } };
    if (!p.user?.id || !this.fromOurTeam(p.team?.id) || !p.view) return;
    let meta: EditMeta;
    try {
      meta = JSON.parse(p.view.private_metadata ?? '') as EditMeta;
    } catch {
      return;
    }
    const caller = this.caller(p.user.id, p.user.name ?? p.user.username);
    const values = p.view.state?.values ?? {};
    const bot = this.deps.botToken();
    if (!bot) return;
    if (p.view.callback_id === HIRE_EDIT_VIEW) {
      const res = this.deps.org.editHire(caller, meta.id, readHireEdit(values));
      if (!res.ok) {
        await this.reply(meta.channel, meta.ts, `That change didn’t go through: ${res.error}`);
        return;
      }
      await updateMessage(bot, { channel: meta.channel, ts: meta.ts, text: `Ready to hire ${res.hire.contract!.name}`, blocks: this.offerBlocks(res.hire) }, this.deps.fetchImpl);
      return;
    }
    const draft = this.teamDrafts.get(meta.id);
    if (!draft || draft.by !== p.user.id) return;
    Object.assign(draft, readTeamEdit(values, draft));
    const drawn = this.teamDraftMessage(meta.id);
    await updateMessage(bot, { channel: meta.channel, ts: meta.ts, text: drawn.text, blocks: drawn.blocks }, this.deps.fetchImpl);
  }

  // ---- THREADS ----------------------------------------------------------

  /// A reply in a hire interview thread. Returns false when the thread is not
  /// one of ours, so the bridge can ignore it.
  async onThreadReply(event: { channel?: string; thread_ts?: string; user?: string; text?: string }, teamId: unknown): Promise<boolean> {
    const key = `${event.channel}:${event.thread_ts}`;
    const taskId = this.teamThreads.get(key) ?? (event.user ? await this.teamQuestionThread(event, this.caller(event.user)) : undefined);
    if (taskId && event.user && this.fromOurTeam(teamId)) {
      const text = (event.text ?? '').trim();
      if (!text) return true;
      // One reply answers every question: numbered lines go to their
      // questions; anything else answers them all at once.
      const numbered = text.split(/\n+/).map((l) => /^\s*(\d+)[.)]\s*(.+)$/.exec(l)).filter((m): m is RegExpExecArray => !!m);
      const answers = numbered.length ? numbered.sort((a, b) => Number(a[1]) - Number(b[1])).map((m) => m[2]) : [text];
      const res = this.deps.org.decideTeamTask(this.caller(event.user), taskId, { kind: 'answer', answers });
      await this.reply(event.channel!, event.thread_ts!, res.ok ? 'Thanks — the coordinator is planning with that.' : res.error);
      if (res.ok) {
        this.teamThreads.delete(key);
        this.keepTeamThreads();
      }
      return true;
    }
    const hireId = this.hireThreads.get(key);
    if (!hireId || !event.user || !this.fromOurTeam(teamId)) return false;
    const caller = this.caller(event.user);
    const text = (event.text ?? '').trim();
    if (!text) return true;
    const skip = /^just draft it\b/i.test(text);
    const put = await this.working(event.channel!, event.thread_ts!, skip ? 'Writing the offer… about half a minute.' : 'Got it. Writing the offer from your answers… about half a minute.');
    const res = await this.deps.org.draftHire(caller, { hireId, answer: skip ? '' : text, skipQuestions: skip });
    if (!res.ok) {
      await put(res.error);
      return true;
    }
    await this.showDraft(put, res.hire);
    return true;
  }

  /// A thread nobody kept track of (it was asked before a restart, say):
  /// whether it is a team's questions waiting on this person, from what the
  /// message it replies to says.
  private async teamQuestionThread(event: { channel?: string; thread_ts?: string }, caller: OrgCaller): Promise<string | undefined> {
    const bot = this.deps.botToken();
    if (!bot || !event.channel || !event.thread_ts) return undefined;
    const waiting = (typeof this.deps.org.teamTasks === 'function' ? this.deps.org.teamTasks(caller) : []).filter((t) => t.status === 'questions' && t.waitingOnYou);
    if (!waiting.length) return undefined;
    const parent = await fetchMessage(bot, event.channel, event.thread_ts, this.deps.fetchImpl);
    if (!parent.ok || parent.data.user && parent.data.user === caller.slackUserId) return undefined;
    const task = waiting.find((t) => parent.data.text.startsWith(`${t.teamName} has questions about`));
    return task?.id;
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
      actionId === TEAM_MAKE_ACTION ||
      actionId === HIRE_EDIT_ACTION ||
      actionId === TEAM_EDIT_ACTION ||
      actionId === TEAM_DROP_ACTION ||
      actionId === JOIN_LETIN_ACTION ||
      actionId === JOIN_DECLINE_ACTION ||
      actionId === LINK_CONFIRM_ACTION ||
      actionId === LINK_DECLINE_ACTION ||
      actionId === OPEN_LINK_ACTION ||
      actionId === BUDGET_RAISE_ACTION ||
      actionId === TEAM_PIECE_APPROVE_ACTION ||
      actionId === TEAM_ACCEPT_ACTION ||
      actionId === TEAM_PIECE_RETRY_ACTION ||
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
      trigger_id?: string;
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
      case LINK_CONFIRM_ACTION:
      case LINK_DECLINE_ACTION: {
        const access = this.deps.access;
        if (!access) return;
        if (action.action_id === LINK_DECLINE_ACTION) {
          access.linkSlackDecline(p.user.id, action.value);
          await settle('Not linked. Nothing changed.');
          return;
        }
        const bot = this.deps.botToken();
        const slackName = bot ? await userName(bot, p.user.id, this.deps.fetchImpl) : null;
        const res = access.linkSlackConfirm(p.user.id, action.value, slackName ?? undefined);
        if (!res.ok) {
          if (channel && threadTs) await this.reply(channel, threadTs, res.error);
          return;
        }
        await settle(
          `Linked. The console sign-in "${res.was}" is you now${res.workers ? `, and the ${res.workers === 1 ? 'worker' : `${res.workers} workers`} it manages will message you here` : ''}. Reload the console to see it.`,
        );
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
      case TEAM_ACCEPT_ACTION: {
        const res = org.decideTeamTask(caller, action.value, { kind: 'accept' });
        if (!res.ok && channel && threadTs) await this.reply(channel, threadTs, res.error);
        return;
      }
      case TEAM_PIECE_APPROVE_ACTION:
      case TEAM_PIECE_RETRY_ACTION: {
        const [taskId, id] = action.value.split(':');
        const res = action.action_id === TEAM_PIECE_APPROVE_ACTION ? org.decideRun(caller, id, true) : org.decideTeamTask(caller, taskId, { kind: 'retryPiece', workerId: id });
        if (!res.ok && channel && threadTs) await this.reply(channel, threadTs, res.error);
        // The card redraws itself from the task's next update.
        return;
      }
      case HIRE_EDIT_ACTION: {
        const hire = org.listHires(caller).find((x) => x.hireId === action.value);
        const bot = this.deps.botToken();
        if (!hire?.contract || !bot || !p.trigger_id || !channel || !ts) return;
        const tools = org.tools(caller);
        const bosses = org.listWorkers(caller).filter((w) => w.youManage).map((w) => ({ id: w.id, name: w.name }));
        const opened = await openView(bot, p.trigger_id, hireEditView(hire, { id: hire.hireId, channel, ts }, {
          tools: tools.ok ? tools.tools.map((t) => t.name) : [],
          places: this.deps.places?.() ?? [],
          bosses,
        }), this.deps.fetchImpl);
        if (!opened.ok && threadTs) await this.reply(channel, threadTs, 'The form didn’t open. Try again, or change it on the worker’s page in the console once it’s hired.');
        return;
      }
      case TEAM_EDIT_ACTION: {
        const draft = this.teamDrafts.get(action.value);
        const bot = this.deps.botToken();
        if (!bot || !p.trigger_id || !channel || !ts) return;
        if (!draft || draft.by !== p.user.id) {
          await settle(draft ? 'Only whoever asked for this team can change it.' : 'This suggestion has expired. Ask again with `/team new …`.');
          return;
        }
        await openView(bot, p.trigger_id, teamEditView(draft, { id: action.value, channel, ts }), this.deps.fetchImpl);
        return;
      }
      case TEAM_MAKE_ACTION:
      case TEAM_DROP_ACTION: {
        const draft = this.teamDrafts.get(action.value);
        // Only whoever asked for it decides it.
        if (!draft || draft.by !== p.user.id) {
          await settle(draft ? 'Only whoever asked for this team can make it.' : 'This suggestion has expired. Ask again with `/team new …`.');
          return;
        }
        if (action.action_id === TEAM_DROP_ACTION) {
          this.teamDrafts.delete(action.value);
          await settle('Dropped. Nothing was made.');
          return;
        }
        if (draft.hires.length) await settle(`Hiring ${draft.hires.length === 1 ? 'the new member' : `${draft.hires.length} new members`}, then making ${draft.name}…`);
        const res = await org.makeTeamWithHires(caller, {
          name: draft.name,
          purpose: draft.purpose,
          budgetUSDPerTask: draft.budgetUSDPerTask,
          checkpoints: draft.checkpoints,
          members: draft.members.map((m) => ({ workerId: m.workerId, role: m.role })),
          hires: draft.hires,
          ...(draft.hires.length ? { hireVisibility: draft.hireVisibility } : {}),
        });
        if (!res.ok) {
          if (channel && threadTs) await this.reply(channel, threadTs, res.error);
          return;
        }
        this.teamDrafts.delete(action.value);
        const on = [...draft.members.map((m) => m.name), ...res.hired.map((m) => `${m.name} (new)`)];
        const after = [
          ...res.waiting.map((m) => `${m.name} is waiting on an approver and joins once approved.`),
          ...res.failed.map((f) => `Couldn't hire for "${f.role}": ${f.error}`),
        ].join(' ');
        await settle(`${res.team.name} is made: ${on.join(', ')}.${after ? ` ${after}` : ''} Give it work with \`/team ${res.team.name}: …\` or \`@overcli ${res.team.name}, …\`.`);
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

  /// Finished shifts whose manager has been told.
  private toldFinished = new Set<string>();

  /// A scheduled shift finished: what it did goes to its manager, with the
  /// answer and the files it wrote, the way an ask made in Slack is answered
  /// in its thread. Only shifts: an errand asked in Slack is answered where
  /// it was asked, one asked in the console follows its asker
  /// (`askAnswered`), and a team piece reports to its team.
  private async onShiftDone(o: Orchestration): Promise<void> {
    if (o.origin?.kind !== 'worker' || this.toldFinished.has(o.id)) return;
    const p = this.deps.org.errandProgress?.(o.id);
    // Still going, or nothing ran: proposals turned down, or none made.
    if (!p?.done || !p.items.some((i) => i.status === 'done' || i.status === 'failed')) return;
    const ended = Math.max(0, ...o.items.map((i) => i.finishedAt ?? 0));
    if (ended && (this.deps.now ?? Date.now)() - ended > SHIFT_DM_WINDOW_MS) return;
    const to = this.deps.org.managerSlackId(o.origin.workerId);
    const bot = this.deps.botToken();
    if (!to || !bot) return;
    this.toldFinished.add(o.id);
    const name = o.origin.workerName;
    const head = await this.dm(to, finishedText(name, p, this.deps.libraryUrl?.() ?? null).replace(/\*/g, ''), {
      blocks: [section(clip(finishedText(escapeMrkdwn(name), { ...p, items: p.items.map((i) => ({ ...i, title: escapeMrkdwn(i.title) })) }, this.deps.libraryUrl?.() ?? null), 2900)), context('From its scheduled run.')],
      as: this.asOf(o.origin.workerId, name),
    });
    if (!head) return;
    await deliverResults(
      {
        post: (channel, text, threadTs) => postMessage(bot, { channel, text, threadTs }, this.deps.fetchImpl),
        upload: async (channel, threadTs, filename, bytes) => {
          const res = await uploadFile(bot, { channel, threadTs, filename, bytes }, this.deps.fetchImpl);
          if (!res.ok) this.deps.log('warn', `Could not attach ${filename} to ${name}'s shift DM: ${res.error}`);
          return res.ok;
        },
        readFile: (path, max) => this.deps.readFile?.(path, max) ?? null,
      },
      head.channel,
      head.ts,
      name,
      p,
    );
  }

  /// A worker on probation proposed work at a scheduled run: ask its manager.
  private async onBatch(o: Orchestration): Promise<void> {
    if (o.origin?.kind === 'worker' && o.origin.task === 'shift') void this.onShiftDone(o);
    if (o.origin?.kind !== 'worker' || this.toldBatches.has(o.id)) return;
    const items = o.items.filter((i) => i.status === 'proposed');
    if (!items.length) return;
    const to = this.deps.org.managerSlackId(o.origin.workerId);
    if (!to || !this.deps.botToken()) return;
    this.toldBatches.add(o.id);
    const name = o.origin.workerName;
    const lines = items.slice(0, 8).map((i) => `• ${escapeMrkdwn(clip(i.candidate.title, 140))}`).join('\n');
    // Asked for in a Slack thread by the person who approves it: asked there.
    const thread = this.deps.org.slackThreadFor?.({ orchestrationId: o.id });
    const posted = await this.dm(to, `${name} proposes ${items.length} thing${items.length === 1 ? '' : 's'} to do`, {
      as: this.asOf(o.origin.workerId, name),
      ...(thread && thread.slackUserId === to ? { inThread: { channel: thread.channel, threadTs: thread.threadTs } } : {}),
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
    // Whoever asked; an admin when they aren't in Slack, as for approvals.
    const to = task.requestedBy?.slackUserId ?? this.deps.policy().admins[0];
    if (!to || !this.deps.botToken()) return;
    void this.teamCardFor(task, to);
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
        as: this.asOf(task.teamId, task.teamName),
        blocks: [
          section(`*${team}* has a few questions before it plans _${title}_`),
          section(task.questions.map((q, i) => `${i + 1}. ${escapeMrkdwn(q)}`).join('\n')),
          context('Reply in this thread. Number your answers to match, or write one answer for all of them.'),
        ],
      });
      if (posted) {
        this.teamThreads.set(`${posted.channel}:${posted.ts}`, task.id);
        this.keepTeamThreads();
      }
    } else if (task.status === 'proposed') {
      const stages = task.stages.map((s, i) => `${i + 1}. ${escapeMrkdwn(s.title)}`).join('\n');
      posted = await this.dm(to, `${task.teamName}'s plan for "${task.title ?? task.brief}" is ready`, {
        as: this.asOf(task.teamId, task.teamName),
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
        as: this.asOf(task.teamId, task.teamName),
        ...(this.cardOf(task.id) ? { threadTs: this.cardOf(task.id)!.ts } : {}),
        blocks: [
          section(`*${team}* stopped on _${title}_\n${escapeMrkdwn(clip(task.waiting.message, 1200))}`),
          {
            type: 'actions',
            elements: [button('Carry on', TEAM_CONTINUE_ACTION, task.id, 'primary'), button('Cancel the task', TEAM_CANCEL_ACTION, task.id, 'danger')],
          },
        ],
      });
    } else if (task.status === 'review' && task.pack) {
      // An edited card notifies nobody: the moment it needs you is a message
      // of its own, in the card's thread and shown in the conversation too.
      const card = this.cardOf(task.id);
      posted = await this.dm(to, `${task.teamName}'s pack for "${task.title ?? task.brief}" is ready for your review`, {
        as: this.asOf(task.teamId, task.teamName),
        ...(card ? { threadTs: card.ts, broadcast: true } : {}),
        blocks: [
          section(`*${team}* finished _${title}_ and is holding it for your review.\n${slackMarkup(clip(task.pack.summary, 1500))}`),
          { type: 'actions', elements: [button('Accept', TEAM_ACCEPT_ACTION, task.id, 'primary')] },
          context(`The report is attached in this thread${task.pack.files.length ? ` (${escapeMrkdwn(task.pack.files.map((f) => f.split('/').pop()).join(', '))})` : ''}. To ask for changes, open the task in the console.`),
        ],
      });
    } else if (task.status === 'done' && task.pack) {
      posted = await this.dm(to, `${task.teamName} finished "${task.title ?? task.brief}"`, {
        as: this.asOf(task.teamId, task.teamName),
        ...(this.cardOf(task.id) ? { threadTs: this.cardOf(task.id)!.ts } : {}),
        blocks: [
          section(`*${team}* finished _${title}_`),
          section(slackMarkup(clip(task.pack.summary, 2500))),
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

  // ---- TEAM CARDS ---------------------------------------------------------

  private cards: Record<string, TeamCardRef> | null = null;
  private cardTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private cardLatest = new Map<string, TeamTask>();
  private cardBusy = new Set<string>();

  private cardOf(taskId: string): TeamCardRef | undefined {
    if (!this.cards) this.cards = this.deps.teamCards?.load() ?? {};
    return this.cards[taskId];
  }

  private saveCards(): void {
    if (!this.cards) return;
    // A month of cards is plenty; older tasks are not coming back.
    const cutoff = (this.deps.now ?? Date.now)() - 30 * 24 * 3_600_000;
    for (const [id, c] of Object.entries(this.cards)) if (c.at < cutoff) delete this.cards[id];
    this.deps.teamCards?.save(this.cards);
  }

  /// The live card for a team task once it is under way: posted the first
  /// time, edited after (no more often than CARD_EVERY_MS), and a line in its
  /// thread for each stage that ends. Planning and the plan itself are DMs of
  /// their own (`onTeamTask`); the card starts when there is work to show.
  private async teamCardFor(task: TeamTask, to: string): Promise<void> {
    if (!['running', 'waiting', 'review', 'done', 'failed', 'cancelled'].includes(task.status) || !task.stages.length) return;
    if (!this.deps.botToken()) return;
    this.cardLatest.set(task.id, task);
    const card = this.cardOf(task.id);
    if (card?.done) return;
    const now = (this.deps.now ?? Date.now)();
    if (card && now - card.at < CARD_EVERY_MS && !['done', 'failed', 'review'].includes(task.status)) {
      if (!this.cardTimers.has(task.id)) {
        this.cardTimers.set(task.id, setTimeout(() => {
          this.cardTimers.delete(task.id);
          const latest = this.cardLatest.get(task.id);
          if (latest) void this.teamCardFor(latest, to);
        }, CARD_EVERY_MS - (now - card.at)));
      }
      return;
    }
    if (this.cardBusy.has(task.id)) {
      // Drawn again when the edit in flight finishes.
      return;
    }
    this.cardBusy.add(task.id);
    try {
      const bot = this.deps.botToken();
      if (!bot) return;
      const drawn = teamCard(task, { now, consoleUrl: this.deps.libraryUrl?.() ?? null, ...(this.deps.pieceLook ? { look: (id: string) => this.deps.pieceLook!(id) } : {}) });
      const ended = task.status === 'done' || task.status === 'failed' || task.status === 'cancelled';
      if (!card) {
        const posted = await this.dm(to, drawn.text, { blocks: drawn.blocks, as: this.asOf(task.teamId, task.teamName) });
        if (!posted) return;
        this.cards![task.id] = { channel: posted.channel, ts: posted.ts, told: stagesDone(task), at: now, ...(ended ? { done: true } : {}) };
        this.saveCards();
        if ((task.status === 'done' || task.status === 'review') && task.pack) await this.attachPack(bot, this.cards![task.id], task);
        return;
      }
      await updateMessage(bot, { channel: card.channel, ts: card.ts, text: drawn.text, blocks: drawn.blocks }, this.deps.fetchImpl);
      // Each stage that has ended since, said in the thread.
      const finished = task.stages.map((s, i) => ({ s, i })).filter(({ s }) => s.status === 'done' || s.status === 'skipped' || s.status === 'failed');
      for (const { i } of finished.slice(card.told)) {
        await postMessage(bot, { channel: card.channel, threadTs: card.ts, text: stageNote(task, i) }, this.deps.fetchImpl);
      }
      Object.assign(card, { told: Math.max(card.told, finished.length), at: now, ...(ended ? { done: true } : {}) });
      this.saveCards();
      if ((task.status === 'done' || task.status === 'review') && task.pack) await this.attachPack(bot, card, task);
    } finally {
      this.cardBusy.delete(task.id);
      // An update that came in while this one was being drawn.
      const latest = this.cardLatest.get(task.id);
      if (latest && latest !== task && latest.updatedAt > task.updatedAt) void this.teamCardFor(latest, to);
    }
  }

  /// The finished pack's files, into the card's thread: the report itself
  /// rather than a list of names. Up to five, the kinds Slack shows.
  private async attachPack(bot: string, card: TeamCardRef, task: TeamTask): Promise<void> {
    // Once: held for review, then accepted, is the same pack.
    if (card.attached) return;
    card.attached = true;
    this.saveCards();
    let sent = 0;
    for (const name of task.pack?.files ?? []) {
      if (sent >= 5 || !/\.(md|markdown|txt|csv|json|html?|pdf|png|jpe?g|docx|pptx|xlsx)$/i.test(name)) continue;
      const bytes = this.deps.teamFile?.(task.id, name, 10_000_000);
      if (!bytes) continue;
      const res = await uploadFile(bot, { channel: card.channel, threadTs: card.ts, filename: name.split('/').pop() ?? name, bytes }, this.deps.fetchImpl);
      if (res.ok) sent++;
      else this.deps.log('warn', `Could not attach ${name} to ${task.teamName}'s card: ${res.error}`);
    }
  }

  /// After a start: each card still in motion drawn again from its task
  /// as it is now, so a restart while a task moved on doesn't leave a card
  /// stuck where it was.
  refreshTeamCards(tasks: TeamTask[]): void {
    for (const task of tasks) {
      const card = this.cardOf(task.id);
      if (!card || card.done) continue;
      const to = task.requestedBy?.slackUserId ?? this.deps.policy().admins[0];
      if (to) void this.teamCardFor({ ...task }, to);
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

  /// "Is this you?" for a console sign-in someone wants linked to this
  /// Slack account. Only this person's press links it.
  async dmLinkSlack(slackUserId: string, linkId: string, signedInAs: string, org: string): Promise<boolean> {
    const posted = await this.dm(slackUserId, `Is the console sign-in "${signedInAs}" you?`, {
      blocks: [
        section(`Someone signed in to *${escapeMrkdwn(org)}*’s console as *${escapeMrkdwn(signedInAs)}* says that’s you. If it is, link them: that sign-in becomes you, and the workers it manages will message you here.`),
        { type: 'actions', elements: [button('Yes, that’s me', LINK_CONFIRM_ACTION, linkId, 'primary'), button('No', LINK_DECLINE_ACTION, linkId)] },
        context('If you didn’t ask for this, press No. The request ends in 15 minutes either way.'),
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
  /// So does one asked anywhere that a restart cut short and the server
  /// asked again: the thread or page that was waiting has gone.
  askAnswered(ask: AskRecord): void {
    if (!ask.slackUserId || !this.deps.botToken()) return;
    if (!ask.resumed && (ask.via !== 'console' || (ask.doneAt ?? 0) - ask.at < ASK_DM_AFTER_MS)) return;
    const head = ask.status === 'answered' ? `*${escapeMrkdwn(ask.workerName)}* answered _${escapeMrkdwn(clip(ask.text, 120))}_` : `*${escapeMrkdwn(ask.workerName)}* could not answer _${escapeMrkdwn(clip(ask.text, 120))}_`;
    void this.dm(ask.slackUserId, `${ask.workerName}: ${clip(ask.reply ?? ask.error ?? '', 2800)}`, {
      blocks: [section(head), section(slackMarkup(clip(ask.reply ?? ask.error ?? '', 2800))), ...(ask.launched ? [context(`Started ${ask.launched} piece(s) of work.`)] : [])],
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
          context(`${dollars(c?.budgetUSDPerMonth ?? 0)}/month · ${escapeMrkdwn(c?.schedule ?? 'When asked')} · tools: ${escapeMrkdwn((c?.connectors ?? []).join(', ') || 'none')}`),
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
  '`/worker <name> <text>` — ask it to do something',
  '`/worker <name> pause` / `resume`',
  '`/hire <job description>` — hire a worker',
  '`/team` — the teams you can see, and what each is on',
  '`/team <name>: <task>` — give a team a task',
  '`/team new <what it’s for>` — make a team from your workers',
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
    `${dollars(w.spentThisMonthUSD)} of ${dollars(w.budgetUSDPerMonth)}/mo`,
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
