// Workers ask their managers in Slack.
//
// A worker-owned run that pauses for a person — a question nobody up its
// reporting chain could answer (`needsInput`), or an external action waiting
// for approval (`externalAction`) — is DMed to the worker's manager, posted
// under the worker's own name and face. The manager answers in the thread, or
// presses Approve/Reject, and the run carries on exactly as if they had done
// it at the desk: an answer is a steer plus a resume, approval is a resume,
// rejection declines the item.
//
// Only the manager can answer. A reply from anyone else in the thread, from
// another workspace, or from a bot is ignored — the thread is a channel into
// a running agent, and the manager is the one person who may steer it.
//
// No Electron here: the bridge runs under the app and under `overcli serve`
// alike. Run one bridge per Slack app — Socket Mode spreads events across
// every open connection, so a second process on the same app token would
// swallow replies meant for runs it does not have.

import { randomUUID } from 'node:crypto';
import type { FlowRun } from '../../shared/flows/schema';
import { flowRunTitle } from '../../shared/flows/schema';
import type { Worker } from '../../shared/flows/worker';
import { managerFor } from '../../shared/flows/org';
import type { UUID } from '../../shared/types';
import { authTest, escapeMrkdwn, openIm, postMessage, updateMessage, type FetchLike, type SlackIdentity, uploadFile } from './slackApi';
import { SocketModeClient, type SocketCtor, type SocketEnvelope } from './socketMode';
import { threadKey, type SlackThread, type SlackThreadKind, type ThreadStore } from './threadStore';
import type { SlackCommands } from './slackCommands';
import { DOOR_CHOICE_ACTION, DOOR_SUBSCRIBE_ACTION, type FrontDoor } from './frontDoor';
import { stepOutsideTools, stepsARunGrantCovers } from '../flows/stepEffect';
import { changesAsDiff, changesSummary, type RunChanges } from '../org/runChanges';
import type { FlowStep } from '../../shared/flows/schema';
import { initialsPicture } from '../../shared/flows/avatars';
import type { SlackFile } from './slackApi';

export const SLACK_APPROVE_ACTION = 'overcli_approve';
/// Approve the step and the later ones needing only the same tools.
export const SLACK_APPROVE_RUN_ACTION = 'overcli_approve_run';
export const SLACK_APPROVE_ALWAYS_ACTION = 'overcli_approve_always';
export const SLACK_REJECT_ACTION = 'overcli_reject';
/// "Show changes" on an approval: the run's diff, as a file in the thread.
export const SLACK_CHANGES_ACTION = 'overcli_changes';

/// What the bridge reports to Settings. Never carries a token.
export interface SlackBridgeStatus {
  enabled: boolean;
  connected: boolean;
  team?: string;
  error?: string;
  openThreads: number;
}

type Result = { ok: true } | { ok: false; error: string };

export interface SlackBridgeDeps {
  tokens(): { bot: string | null; app: string | null };
  /// The workspace the org is (`org.json` slackTeamId). A token from any
  /// other is refused before the socket opens.
  expectedTeamId?(): string | undefined;
  workers(): Worker[];
  getRun(runId: UUID): FlowRun | null;
  /// Keep the step a run waits at as one its worker always runs (its
  /// manager's "Always allow"). Absent: no such button.
  alwaysAllow?(slackUserId: string, runId: UUID): { ok: true } | { ok: false; error: string };
  listRuns(): FlowRun[];
  steerRun(args: { runId: UUID; text: string }): Result;
  resumeRun(args: { runId: UUID; forRun?: boolean }): Result;
  /// The Slack thread a run's work was asked for in, and who asked: its
  /// questions and approvals go there when that person is who's asked.
  threadFor?(runId: UUID): { channel: string; threadTs: string; slackUserId?: string } | null;
  /// Decline a paused run: abort it and settle its batch item, as Reject
  /// does at the desk.
  rejectRun(runId: UUID): Result;
  /// What a run has changed so far (runChanges.ts); with the diff when asked.
  runChanges?(runId: UUID, diff: boolean): Promise<RunChanges | null>;
  store: ThreadStore;
  /// Who answers in Slack for a worker whose manager isn't in it (signed in
  /// before Slack was connected, say): an admin, so a question or approval
  /// still reaches someone. Absent: it waits in the console.
  standIn?(workerId: UUID): string | undefined;
  onStatus?(status: SlackBridgeStatus): void;
  log(level: 'info' | 'warn', message: string): void;
  now?(): number;
  fetchImpl?: FetchLike;
  WebSocketCtor?: SocketCtor;
}

/// The pauses a manager can settle from Slack. `riskyStep` is deliberately
/// not one: it means the step's own instructions look hostile, and that is
/// worth reading in full at the desk rather than approving from a phone.
function pauseKind(run: FlowRun): SlackThreadKind | null {
  if (run.state.kind !== 'paused' || !run.workerId) return null;
  if (run.state.reason === 'needsInput') return 'question';
  // A flow's own checkpoint ("pause before push") waits on a person too.
  // Posted nowhere, the run looked hung from Slack.
  if (run.state.reason === 'externalAction' || run.state.reason === 'preStep') return 'approval';
  return null;
}

/// The exchange a needsInput pause is about: the newest one on the paused
/// step that a worker could not answer.
function openExchange(run: FlowRun, stepId: string) {
  return [...(run.workerExchanges ?? [])]
    .reverse()
    .find((x) => x.stepId === stepId && (x.status === 'escalated' || x.status === 'failed'));
}

const MAX_QUOTE = 2500;

function clip(text: string, max = MAX_QUOTE): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function quote(text: string): string {
  return clip(text)
    .split('\n')
    .map((line) => `> ${escapeMrkdwn(line)}`)
    .join('\n');
}

export class SlackBridge {
  private socket: SocketModeClient | null = null;
  private identity: SlackIdentity | null = null;
  private threads: SlackThread[] = [];
  /// Keys being posted right now, so a burst of run updates for one pause
  /// cannot post the same DM twice before the first post returns.
  private posting = new Set<string>();
  /// When this process began. A thread settled before it — a run approved,
  /// then the process died before the step ran — does not stop the restored
  /// pause from being asked again.
  private readonly bootedAt = Date.now();

  /// Only the worker's manager as it is now may answer: a worker moved to
  /// someone else, or a manager taken off it, ends the old manager's say.
  private isCurrentManager(t: { workerId: UUID; managerSlackUserId: string }, user: string | undefined): boolean {
    return !!user && user === t.managerSlackUserId && this.slackAnswerer(t.workerId)?.id === user;
  }

  /// Who the worker's questions and approvals go to in Slack now: its
  /// manager, or the stand-in when the manager isn't in Slack.
  private slackAnswerer(workerId: UUID): { id: string; standIn: boolean } | null {
    const own = managerFor(this.deps.workers(), workerId)?.slackUserId;
    if (own) return { id: own, standIn: false };
    const other = this.deps.standIn?.(workerId);
    return other ? { id: other, standIn: true } : null;
  }
  private status: SlackBridgeStatus = { enabled: false, connected: false, openThreads: 0 };
  /// `/worker`, `/hire` and hire approvals — set once the org control plane
  /// exists, which is built after the bridge.
  private commands: SlackCommands | null = null;

  constructor(private readonly deps: SlackBridgeDeps) {}

  setCommands(commands: SlackCommands): void {
    this.commands = commands;
  }

  /// How to find a run's Slack thread, once the org that knows is up.
  private threadFinder: SlackBridgeDeps['threadFor'] | null = null;
  setThreadFor(find: NonNullable<SlackBridgeDeps['threadFor']>): void {
    this.threadFinder = find;
  }

  /// The workspace the bot token belongs to, once connected.
  teamId(): string | null {
    return this.identity?.teamId ?? null;
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  getStatus(): SlackBridgeStatus {
    return { ...this.status, openThreads: this.threads.filter((t) => !t.resolvedAt).length };
  }

  private setStatus(patch: Partial<SlackBridgeStatus>): void {
    this.status = { ...this.status, ...patch };
    this.deps.onStatus?.(this.getStatus());
  }

  /// Bumped by every start and stop. A start that finds it moved while it
  /// waited on Slack gives up: two quick Reconnects must not open two
  /// sockets, and turning Slack off mid-start must not connect anyway.
  private generation = 0;

  async start(): Promise<Result> {
    this.stop();
    const gen = this.generation;
    const { bot, app } = this.deps.tokens();
    if (!bot || !app) {
      this.setStatus({ enabled: true, connected: false, error: 'Add both the bot token and the app token.' });
      return { ok: false, error: 'Slack needs both a bot token and an app-level token.' };
    }
    const who = await authTest(bot, this.deps.fetchImpl);
    if (gen !== this.generation) return { ok: false, error: 'Superseded by a newer start or stop.' };
    if (!who.ok) {
      this.setStatus({ enabled: true, connected: false, error: who.error });
      return { ok: false, error: who.error };
    }
    const expected = this.deps.expectedTeamId?.();
    if (expected && expected !== who.data.teamId) {
      const error = `This bot token is for the ${who.data.team} workspace (${who.data.teamId}), but org.json says this org is ${expected}.`;
      this.setStatus({ enabled: true, connected: false, error });
      return { ok: false, error };
    }
    this.identity = who.data;
    this.threads = this.deps.store.list();
    this.setStatus({ enabled: true, team: who.data.team, error: undefined });
    this.socket = new SocketModeClient({
      appToken: app,
      fetchImpl: this.deps.fetchImpl,
      WebSocketCtor: this.deps.WebSocketCtor,
      onEnvelope: (env) => this.onEnvelope(env),
      onState: (s) => this.setStatus({ connected: s.connected, ...(s.error ? { error: s.error } : {}) }),
      log: (level, message) => this.deps.log(level, message),
    });
    this.socket.start();
    // Runs restored already paused emit nothing until they change, so look
    // once now — otherwise a question asked just before a restart waits in
    // the app forever.
    for (const run of this.deps.listRuns()) await this.onRunUpdate(run);
    return { ok: true };
  }

  stop(): void {
    this.generation++;
    this.socket?.stop();
    this.socket = null;
    this.identity = null;
    this.setStatus({ enabled: false, connected: false });
  }

  get running(): boolean {
    return this.identity !== null;
  }

  // ---- OUTBOUND ---------------------------------------------------------

  /// Called for every run update. Cheap for the runs it does not care about.
  async onRunUpdate(run: FlowRun): Promise<void> {
    if (!this.identity) return;
    await this.settleStale(run.id, run);
    const kind = pauseKind(run);
    if (!kind || run.state.kind !== 'paused') return;
    const stepId = run.state.nextStepId;
    const exchange = kind === 'question' ? openExchange(run, stepId) : undefined;
    const key = threadKey({ runId: run.id, stepId, kind, exchangeId: exchange?.id });
    if (this.posting.has(key) || this.threads.some((t) => threadKey(t) === key && (!t.resolvedAt || t.resolvedAt >= this.bootedAt))) return;

    const workers = this.deps.workers();
    const worker = workers.find((w) => w.id === run.workerId);
    const to = this.slackAnswerer(run.workerId!);
    if (!worker || !to) return;

    this.posting.add(key);
    try {
      await this.post(run, worker, to.id, kind, stepId, exchange, to.standIn ? managerFor(workers, run.workerId!)?.name ?? 'nobody' : undefined);
    } finally {
      this.posting.delete(key);
    }
  }

  private async post(
    run: FlowRun,
    worker: Worker,
    managerSlackUserId: string,
    kind: SlackThreadKind,
    stepId: string,
    exchange: ReturnType<typeof openExchange>,
    /// Set when this goes to a stand-in: the manager it would have gone to.
    standInFor?: string,
  ): Promise<void> {
    const bot = this.deps.tokens().bot;
    if (!bot) return;
    // Asked for in a thread by the person being asked: it goes in that thread.
    const asked = (this.threadFinder ?? this.deps.threadFor)?.(run.id);
    const inThread = asked && asked.slackUserId === managerSlackUserId ? asked : null;
    const im = inThread ? { ok: true as const, data: inThread.channel } : await openIm(bot, managerSlackUserId, this.deps.fetchImpl);
    if (!im.ok) {
      this.deps.log('warn', `Could not open a DM with the manager of ${worker.name}: ${im.error}`);
      return;
    }
    const id = randomUUID();
    // The same step asking again (overcli restarted while it ran) asks in the
    // thread it asked in before, rather than as one more message.
    const earlier = kind === 'approval' ? this.threads.filter((t) => t.runId === run.id && t.stepId === stepId && t.kind === 'approval' && t.managerSlackUserId === managerSlackUserId).at(-1) : undefined;
    const title = escapeMrkdwn(clip(flowRunTitle(run), 200));
    const step = run.flowSnapshot.steps.find((s) => s.id === stepId);
    let text: string;
    let blocks: unknown[];
    // What it has changed so far, so an OK (a push, most often) is given
    // with the change in view.
    const changes = kind === 'approval' ? await this.deps.runChanges?.(run.id, false).catch(() => null) : null;
    const changed = !!changes?.repos.length;
    if (kind === 'question') {
      const question = exchange?.question ?? 'The run needs your input before it can go on.';
      const why = exchange?.note?.trim();
      text = `${worker.name} has a question about "${flowRunTitle(run)}"`;
      blocks = [
        { type: 'section', text: { type: 'mrkdwn', text: `*I need your call on* _${title}_\n${quote(question)}` } },
        ...(why
          ? [{ type: 'context', elements: [{ type: 'mrkdwn', text: `Why nobody else could answer: ${escapeMrkdwn(clip(why, 600))}` }] }]
          : []),
        { type: 'context', elements: [{ type: 'mrkdwn', text: 'Reply in this thread and I will carry on.' }] },
      ];
    } else {
      const what = step ? `the step *${escapeMrkdwn(step.id)}*` : 'the next step';
      // The flow's own checkpoint, not a reach outside: its author asked to
      // look before this step runs.
      const checkpoint = run.state.kind === 'paused' && run.state.reason === 'preStep';
      // Later steps needing only the same tools: one OK can cover them.
      const later = !earlier && run.state.kind === 'paused' && run.state.reason === 'externalAction' ? stepsARunGrantCovers(run.flowSnapshot.steps, stepId).length : 0;
      text = earlier
        ? `${worker.name} needs your OK again on "${flowRunTitle(run)}"`
        : checkpoint
          ? `${worker.name} is ready for ${step?.id ?? 'the next step'} on "${flowRunTitle(run)}"`
          : `${worker.name} wants to act outside its sandbox on "${flowRunTitle(run)}"`;
      blocks = [
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: earlier
              ? `*Asking again.* I restarted while ${what} was running. It can change a service, so running it again could repeat what it already did, and it needs your OK again.`
              : checkpoint
                ? `*Ready for ${what}* of _${title}_\nThe flow stops here so someone looks before it runs. Continue when you're happy, or stop it.`
                : `*Approval needed* for _${title}_\n` +
                  `I am about to run ${what}, which reaches outside my sandbox — it may push, send, publish or change a service.`,
          },
        },
        // What it was asked to do and what it needs, not the flow's own
        // instructions: a team piece's are the same for every member.
        ...(!earlier && taskOf(run)
          ? [{ type: 'section', text: { type: 'mrkdwn', text: `*Its task*\n${quote(clip(taskOf(run), 900))}` } }]
          : []),
        ...(step && !earlier
          ? [{ type: 'context', elements: [{ type: 'mrkdwn', text: needsText(step) }] }]
          : []),
        ...(changed ? [{ type: 'context', elements: [{ type: 'mrkdwn', text: `*Changes so far:* ${escapeMrkdwn(changesSummary(changes!))}` }] }] : []),
        {
          type: 'actions',
          elements: [
            ...(later ? [{ type: 'button', style: 'primary', text: { type: 'plain_text', text: 'Approve for this run' }, action_id: SLACK_APPROVE_RUN_ACTION, value: id }] : []),
            { type: 'button', ...(later ? {} : { style: 'primary' }), text: { type: 'plain_text', text: later ? 'Just this step' : checkpoint ? 'Continue' : 'Approve' }, action_id: SLACK_APPROVE_ACTION, value: id },
            { type: 'button', style: 'danger', text: { type: 'plain_text', text: checkpoint ? 'Stop' : 'Reject' }, action_id: SLACK_REJECT_ACTION, value: id },
            ...(changed ? [{ type: 'button', text: { type: 'plain_text', text: 'Show changes' }, action_id: SLACK_CHANGES_ACTION, value: id }] : []),
            ...(!checkpoint && !earlier && this.alwaysAllow ? [{ type: 'button', text: { type: 'plain_text', text: 'Always allow' }, action_id: SLACK_APPROVE_ALWAYS_ACTION, value: id }] : []),
          ],
        },
        ...(!checkpoint && !earlier && this.alwaysAllow
          ? [{ type: 'context', elements: [{ type: 'mrkdwn', text: `Always allow: ${escapeMrkdwn(step?.id ?? 'this step')} runs without asking from now on. Undo it in its Settings in the console.` }] }]
          : []),
        ...(later
          ? [{ type: 'context', elements: [{ type: 'mrkdwn', text: `For this run also covers ${later === 1 ? 'the 1 later step that uses' : `the ${later} later steps that use`} the same tools. Anything new still asks.` }] }]
          : []),
      ];
    }
    if (standInFor) {
      blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: `This came to you, an admin, because ${escapeMrkdwn(worker.name)}’s manager (${escapeMrkdwn(standInFor)}) isn’t linked to Slack. Link them on People in the console, or pick a manager in its Settings.` }] });
    }
    const posted = await postMessage(
      bot,
      {
        channel: earlier?.channel ?? im.data,
        text,
        blocks,
        username: worker.name,
        iconUrl: worker.avatarUrl ?? initialsPicture(worker.id, worker.name),
        // Shown in the conversation too, so asking again still notifies.
        ...(earlier ? { threadTs: earlier.threadTs, broadcast: true } : inThread ? { threadTs: inThread.threadTs } : {}),
      },
      this.deps.fetchImpl,
    );
    if (!posted.ok) {
      this.deps.log('warn', `Could not DM the manager of ${worker.name}: ${posted.error}`);
      return;
    }
    this.threads.push({
      id,
      kind,
      runId: run.id,
      stepId,
      ...(exchange ? { exchangeId: exchange.id } : {}),
      workerId: worker.id,
      workerName: worker.name,
      managerSlackUserId,
      channel: posted.data.channel,
      threadTs: earlier?.threadTs ?? inThread?.threadTs ?? posted.data.ts,
      ...(earlier || inThread ? { messageTs: posted.data.ts } : {}),
      ...(kind === 'approval' ? { about: `${step ? `*${escapeMrkdwn(step.id)}*` : 'the next step'} on _${escapeMrkdwn(flowRunTitle(run))}_` } : {}),
      createdAt: this.now(),
    });
    this.persist();
  }

  /// Close threads whose pause someone already settled — at the desk, or by
  /// the run ending — so the manager is not left with a question that no
  /// longer needs them.
  private async settleStale(runId: UUID, run: FlowRun | null): Promise<void> {
    const open = this.threads.filter((t) => t.runId === runId && !t.resolvedAt);
    if (open.length === 0) return;
    for (const t of open) {
      if (this.stillWaiting(run, t)) continue;
      t.resolvedAt = this.now();
      t.resolution = 'elsewhere';
      this.persist();
      const done = !run || run.state.kind === 'done' || run.state.kind === 'aborted';
      // An approval's card says so itself; a second message would only repeat it.
      if (t.kind === 'approval') await this.clearButtons(t, done ? 'The run has finished.' : 'Handled outside Slack.');
      else await this.reply(t, done ? 'This run has finished — nothing more needed here.' : 'Answered outside Slack — nothing more needed here.');
    }
  }

  private stillWaiting(run: FlowRun | null, t: SlackThread): boolean {
    if (!run || run.state.kind !== 'paused' || run.state.nextStepId !== t.stepId) return false;
    if (pauseKind(run) !== t.kind) return false;
    if (t.kind === 'question' && t.exchangeId) return openExchange(run, t.stepId)?.id === t.exchangeId;
    return true;
  }

  /// "Always allow" on approval cards, once the org server can keep it.
  private alwaysAllow: SlackBridgeDeps['alwaysAllow'];
  setAlwaysAllow(fn: SlackBridgeDeps['alwaysAllow']): void {
    this.alwaysAllow = fn;
  }

  private persist(): void {
    this.deps.store.save(this.threads);
    this.deps.onStatus?.(this.getStatus());
  }

  private async reply(t: SlackThread, text: string): Promise<void> {
    const bot = this.deps.tokens().bot;
    if (!bot) return;
    const res = await postMessage(bot, { channel: t.channel, threadTs: t.threadTs, text, username: t.workerName }, this.deps.fetchImpl);
    if (!res.ok) this.deps.log('warn', `Could not reply in Slack: ${res.error}`);
  }

  private async clearButtons(t: SlackThread, outcome: string): Promise<void> {
    const bot = this.deps.tokens().bot;
    if (!bot) return;
    await updateMessage(
      bot,
      {
        channel: t.channel,
        ts: t.messageTs ?? t.threadTs,
        text: outcome,
        blocks: [{ type: 'section', text: { type: 'mrkdwn', text: `*${escapeMrkdwn(t.workerName)}* asked for approval${t.about ? ` to run ${t.about}` : ''}. ${outcome}` } }],
      },
      this.deps.fetchImpl,
    );
  }

  // ---- INBOUND ----------------------------------------------------------

  async onEnvelope(env: SocketEnvelope): Promise<void> {
    if (env.type === 'events_api') await this.onEvent(env.payload);
    else if (env.type === 'interactive') await this.onInteractive(env.payload);
    else if (env.type === 'slash_commands') await this.commands?.onSlash(env.payload);
  }

  private fromOurTeam(teamId: unknown): boolean {
    return !!this.identity && teamId === this.identity.teamId;
  }

  /// Channel messages, mentions and reactions, for workers' Slack triggers.
  /// Resolves true when a trigger took the event.
  private eventTap: ((ev: Record<string, any>) => boolean | void | Promise<boolean | void>) | null = null;

  setEventTap(tap: ((ev: Record<string, any>) => boolean | void | Promise<boolean | void>) | null): void {
    this.eventTap = tap;
  }

  /// "@overgo …" and DMs that aren't answers to anything: requests for
  /// whichever worker fits. See frontDoor.ts.
  private frontDoor: Pick<FrontDoor, 'onMessage' | 'owns' | 'onChoice' | 'subscribe' | 'adopt'> | null = null;

  setFrontDoor(door: Pick<FrontDoor, 'onMessage' | 'owns' | 'onChoice' | 'subscribe' | 'adopt'> | null): void {
    this.frontDoor = door;
  }

  private async toFrontDoor(ev: { channel?: string; ts?: string; thread_ts?: string; user?: string; text?: string; files?: SlackFile[] }, dm: boolean): Promise<void> {
    if (!this.frontDoor || !ev.channel || !ev.ts || !ev.user) return;
    try {
      await this.frontDoor.onMessage({
        channel: ev.channel,
        ts: ev.ts,
        ...(ev.thread_ts ? { threadTs: ev.thread_ts } : {}),
        user: ev.user,
        text: ev.text ?? '',
        ...(ev.files?.length ? { files: ev.files } : {}),
        dm,
      });
    } catch (err) {
      this.deps.log('warn', `The front door failed: ${String(err)}`);
    }
  }

  private async onEvent(payload: unknown): Promise<void> {
    const p = payload as {
      team_id?: string;
      event?: { type?: string; channel_type?: string; user?: string; bot_id?: string; subtype?: string; text?: string; ts?: string; thread_ts?: string; channel?: string; files?: SlackFile[] };
    };
    const ev = p?.event;
    // A message with a screenshot is a `file_share`, and a thread reply also
    // sent to the channel a `thread_broadcast`; every other subtype is an
    // edit, a join, a bot — not something someone said.
    const said = !!ev && !ev.bot_id && (!ev.subtype || ev.subtype === 'file_share' || ev.subtype === 'thread_broadcast') && !!ev.user;
    const route = (where: string) => this.deps.log('info', `Slack ${ev?.type ?? 'event'} from ${ev?.user ?? '?'} in ${ev?.channel ?? '?'}${ev?.thread_ts ? ` (thread ${ev.thread_ts})` : ''}: ${where}`);
    if (ev && ev.channel_type !== 'im' && this.fromOurTeam(p.team_id)) {
      let took = false;
      if (this.eventTap) {
        try {
          took = (await this.eventTap(ev as Record<string, any>)) === true;
        } catch (err) {
          this.deps.log('warn', `A Slack trigger failed: ${String(err)}`);
        }
      }
      if (took) return route('a trigger took it');
      if (!said) return;
      // A reply that mentions the bot arrives twice: as a message and as an
      // app_mention. The app_mention is the one acted on.
      const mentioned = !!this.identity && (ev.text ?? '').includes(`<@${this.identity.botUserId}>`);
      if (ev.type === 'message' && mentioned) return;
      // A run's question asked in this thread takes the reply as its answer,
      // whether or not it mentions the bot: "@overgo yes, use X" is still
      // the answer, not a new request.
      const asking = ev.thread_ts && ev.channel ? this.openQuestion(ev.channel, ev.thread_ts) : undefined;
      if (asking) {
        route(`answers the question for run ${asking.runId}`);
        return this.answer(asking, { ...ev, text: this.withoutMention(ev.text) });
      }
      if (ev.type === 'app_mention') {
        route('the front door (a mention)');
        return this.toFrontDoor(ev, false);
      }
      // A plain reply in a thread the door started carries on that request.
      if (ev.type === 'message' && ev.thread_ts && ev.channel && this.frontDoor?.owns(ev.channel, ev.thread_ts)) {
        route('the front door (its thread)');
        return this.toFrontDoor(ev, false);
      }
      // A run's settled question or approval: more said there is for its worker.
      const run = ev.type === 'message' && ev.thread_ts ? this.threads.find((x) => x.channel === ev.channel && x.threadTs === ev.thread_ts && x.resolvedAt) : undefined;
      if (run && this.frontDoor) {
        this.frontDoor.adopt(run.channel, run.threadTs, { id: run.workerId, name: run.workerName });
        route(`the front door, for ${run.workerName} (a settled run thread)`);
        return this.toFrontDoor(ev, false);
      }
      if (ev.thread_ts) route('nothing: not a thread anyone here is waiting on');
      return;
    }
    if (!ev || ev.type !== 'message' || ev.channel_type !== 'im') return;
    if (!said || !this.fromOurTeam(p.team_id)) return;
    if (!ev.thread_ts) {
      // Replying beside a question rather than in its thread is still the
      // answer, when it's the one question waiting on you in this DM.
      const waiting = this.threads.filter((x) => x.channel === ev.channel && x.kind === 'question' && !x.resolvedAt && x.managerSlackUserId === ev.user);
      if (waiting.length === 1) {
        route(`answers the one open question here, for run ${waiting[0].runId}`);
        return this.answer(waiting[0], ev);
      }
      // Likewise beside a team's questions, when they're the only ones open.
      if (!waiting.length && (await this.commands?.answerLoneTeamQuestion(ev, p.team_id))) {
        route("answers the team's questions waiting here");
        return;
      }
      // A new DM: a request for whoever fits.
      route(waiting.length ? `the front door (${waiting.length} questions open here, so not taken as an answer)` : 'the front door (a new DM)');
      return this.toFrontDoor(ev, true);
    }
    // A request's thread, where the work it started asks and gets approved:
    // a reply answers an open question, else carries on the conversation.
    const asking = this.openQuestion(ev.channel!, ev.thread_ts);
    if (asking) {
      route(`answers the question for run ${asking.runId}`);
      return this.answer(asking, { ...ev, text: this.withoutMention(ev.text) });
    }
    if (this.frontDoor?.owns(ev.channel!, ev.thread_ts)) {
      route('the front door (its thread)');
      return this.toFrontDoor(ev, true);
    }
    const t = this.threads.find((x) => x.channel === ev.channel && x.threadTs === ev.thread_ts);
    if (!t) {
      // Not a run's thread — maybe a hire interview, else a request's thread.
      const took = await this.commands?.onThreadReply(ev, p.team_id);
      route(took ? 'a team or hire thread' : 'the front door (a thread nobody here owns)');
      if (!took) await this.toFrontDoor(ev, true);
      return;
    }
    route(`run ${t.runId}'s ${t.kind} thread`);
    if (!this.isCurrentManager(t, ev.user)) return;
    if (t.resolvedAt) {
      // Settled, but the worker is still there: "can you push it and give
      // me the PR?" under its approval is for it, with the thread as context.
      if (this.frontDoor) {
        this.frontDoor.adopt(t.channel, t.threadTs, { id: t.workerId, name: t.workerName });
        return this.toFrontDoor(ev, true);
      }
      await this.reply(t, 'This one is already settled — start a new thread if something changed.');
      return;
    }
    if (t.kind === 'approval') {
      await this.reply(t, 'Use Approve or Reject above — a reply here does not approve anything.');
      return;
    }
    await this.answer(t, ev);
  }

  /// A run's question still open in this thread, if there is one.
  private openQuestion(channel: string, threadTs: string): SlackThread | undefined {
    return this.threads.find((x) => x.channel === channel && x.threadTs === threadTs && x.kind === 'question' && !x.resolvedAt);
  }

  /// A run's diff as a file in its approval's thread.
  private async postChanges(t: SlackThread): Promise<void> {
    const bot = this.deps.tokens().bot;
    const changes = await this.deps.runChanges?.(t.runId, true).catch(() => null);
    if (!bot) return;
    if (!changes?.repos.length) {
      await this.reply(t, changes?.gone ? 'Its checkout is gone now; the changes are on its branch.' : 'No changes to show yet.');
      return;
    }
    const posted = await uploadFile(bot, { channel: t.channel, threadTs: t.threadTs, filename: `${t.workerName.replace(/[^\w.-]+/g, '-')}-changes.diff`, bytes: Buffer.from(changesAsDiff(changes)), title: changesSummary(changes) }, this.deps.fetchImpl);
    if (!posted.ok) {
      this.deps.log('warn', `Could not post the changes for run ${t.runId}: ${posted.error}`);
      await this.reply(t, `Couldn't attach the diff (${posted.error}). It's on the run's page in the console.`);
    }
  }

  /// The text with the bot's own mention taken out.
  private withoutMention(text: string | undefined): string {
    return this.identity ? (text ?? '').split(`<@${this.identity.botUserId}>`).join('').trim() : (text ?? '').trim();
  }

  /// A reply to a run's question: its answer, from its manager.
  private async answer(t: SlackThread, ev: { user?: string; text?: string }): Promise<void> {
    if (!this.isCurrentManager(t, ev.user)) {
      // Said so, rather than nothing: someone answering who can't looks
      // exactly like the worker not being there.
      const who = this.slackAnswerer(t.workerId);
      this.deps.log('info', `Slack answer for run ${t.runId} from ${ev.user ?? '?'} not taken: only ${who?.id ?? 'its manager'} answers it.`);
      await this.reply(t, who ? `Only <@${who.id}> can answer this one — it's their worker's question.` : 'Only its manager can answer this one.');
      return;
    }
    const answer = (ev.text ?? '').trim();
    if (!answer) return;
    const run = this.deps.getRun(t.runId);
    if (!this.stillWaiting(run, t)) {
      await this.settleStale(t.runId, run);
      return;
    }
    const steer = this.deps.steerRun({ runId: t.runId, text: `Your manager answered your question via Slack:\n${answer}` });
    if (!steer.ok) {
      await this.reply(t, `I could not take that answer: ${steer.error}`);
      return;
    }
    t.resolvedAt = this.now();
    t.resolution = 'answered';
    this.persist();
    const resumed = this.deps.resumeRun({ runId: t.runId });
    await this.reply(t, resumed.ok ? 'Thanks — carrying on.' : `Got the answer, but the run did not resume: ${resumed.error}`);
  }

  private async onInteractive(payload: unknown): Promise<void> {
    const p = payload as {
      type?: string;
      user?: { id?: string };
      team?: { id?: string };
      actions?: Array<{ action_id?: string; value?: string }>;
    };
    // A Change it form saved: its handler redraws the message it came from.
    const view = (payload as { view?: { callback_id?: string } })?.view;
    if (p?.type === 'view_submission' && this.fromOurTeam(p.team?.id) && this.commands?.handlesView(view?.callback_id)) {
      await this.commands.onViewSubmit(payload);
      return;
    }
    if (p?.type !== 'block_actions' || !this.fromOurTeam(p.team?.id)) return;
    const action = p.actions?.[0];
    // "Show changes" on an approval: the diff, as a file in its thread, for
    // whoever the approval went to.
    if (action?.action_id === SLACK_CHANGES_ACTION) {
      const t = this.threads.find((x) => x.id === action.value);
      if (t && p.user?.id === t.managerSlackUserId) await this.postChanges(t);
      return;
    }
    // "Notify me" under a front-door hand-off: the presser follows the thread by DM.
    if (action?.action_id === DOOR_SUBSCRIBE_ACTION && this.frontDoor) {
      const m = (payload as { message?: { ts?: string; thread_ts?: string }; channel?: { id?: string }; container?: { channel_id?: string } });
      const channel = m.channel?.id ?? m.container?.channel_id;
      const ts = m.message?.ts;
      const user = p.user?.id;
      if (channel && ts && user) await this.frontDoor.subscribe(channel, m.message?.thread_ts ?? ts, user, true);
      return;
    }
    // A one-tap answer under a worker's reply in a front-door thread.
    if (action?.action_id?.startsWith(DOOR_CHOICE_ACTION) && this.frontDoor) {
      const m = (payload as { message?: { ts?: string; thread_ts?: string }; channel?: { id?: string }; container?: { channel_id?: string } });
      const channel = m.channel?.id ?? m.container?.channel_id;
      const ts = m.message?.ts;
      const user = p.user?.id;
      if (channel && ts && user && action.value) await this.frontDoor.onChoice({ channel, messageTs: ts, threadTs: m.message?.thread_ts ?? ts, user, text: action.value });
      return;
    }
    if (action && this.commands?.handlesAction(action.action_id)) {
      await this.commands.onAction(payload);
      return;
    }
    if (!action || (action.action_id !== SLACK_APPROVE_ACTION && action.action_id !== SLACK_APPROVE_RUN_ACTION && action.action_id !== SLACK_APPROVE_ALWAYS_ACTION && action.action_id !== SLACK_REJECT_ACTION)) return;
    const t = this.threads.find((x) => x.id === action.value && x.kind === 'approval');
    if (!t || !this.isCurrentManager(t, p.user?.id) || t.resolvedAt) return;
    const run = this.deps.getRun(t.runId);
    if (!this.stillWaiting(run, t)) {
      await this.settleStale(t.runId, run);
      return;
    }
    const forRun = action.action_id === SLACK_APPROVE_RUN_ACTION;
    const always = action.action_id === SLACK_APPROVE_ALWAYS_ACTION;
    if (always && this.alwaysAllow) {
      const kept = this.alwaysAllow(p.user!.id!, t.runId);
      if (!kept.ok) {
        await this.reply(t, `That did not go through: ${kept.error}`);
        return;
      }
    }
    const approve = forRun || always || action.action_id === SLACK_APPROVE_ACTION;
    // Settled before the run moves: resuming announces the run's new state
    // at once, and that sweep (settleStale) would otherwise find this card
    // still open, call it handled elsewhere, and overwrite "Approved by".
    t.resolvedAt = this.now();
    t.resolution = approve ? 'approved' : 'rejected';
    const res = approve ? this.deps.resumeRun({ runId: t.runId, ...(forRun ? { forRun: true } : {}) }) : this.deps.rejectRun(t.runId);
    if (!res.ok) {
      delete t.resolvedAt;
      delete t.resolution;
      await this.reply(t, `That did not go through: ${res.error}`);
      return;
    }
    this.persist();
    await this.clearButtons(t, !approve ? `Rejected by <@${t.managerSlackUserId}>.` : always ? `Approved by <@${t.managerSlackUserId}>, and always allowed from now on.` : forRun ? `Approved for this run by <@${t.managerSlackUserId}>.` : `Approved by <@${t.managerSlackUserId}>.`);
  }
}

/// Check tokens without starting anything — for Settings' Test button.
export async function testSlackTokens(
  bot: string | null,
  fetchImpl?: FetchLike,
): Promise<{ ok: true; team: string } | { ok: false; error: string }> {
  if (!bot) return { ok: false, error: 'Add the bot token first.' };
  const who = await authTest(bot, fetchImpl);
  return who.ok ? { ok: true, team: who.data.team } : who;
}

/// What a step needs that asks, in a line for the approval card.
function needsText(step: FlowStep): string {
  const outside = stepOutsideTools(step);
  if (outside === null) return 'Why: the step says it ships, sends or changes something outside, or names no tools.';
  return outside.length ? `It needs: ${escapeMrkdwn(outside.join(', '))}` : 'It only works locally.';
}

/// What a run was asked to do: a worker's prompt opens with who it is and
/// what it keeps, and the ask itself follows THE WORK.
function taskOf(run: FlowRun): string {
  const p = run.userPrompt ?? '';
  const at = p.lastIndexOf('\nTHE WORK\n');
  return (at >= 0 ? p.slice(at + '\nTHE WORK\n'.length) : p).trim();
}
