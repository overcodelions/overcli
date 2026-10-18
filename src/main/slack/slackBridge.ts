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
import {
  authTest,
  escapeMrkdwn,
  openIm,
  postMessage,
  updateMessage,
  type FetchLike,
  type SlackIdentity,
} from './slackApi';
import { SocketModeClient, type SocketCtor, type SocketEnvelope } from './socketMode';
import { threadKey, type SlackThread, type SlackThreadKind, type ThreadStore } from './threadStore';
import type { SlackCommands } from './slackCommands';

export const SLACK_APPROVE_ACTION = 'overcli_approve';
export const SLACK_REJECT_ACTION = 'overcli_reject';

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
  listRuns(): FlowRun[];
  steerRun(args: { runId: UUID; text: string }): Result;
  resumeRun(args: { runId: UUID }): Result;
  /// Decline a paused run: abort it and settle its batch item, as Reject
  /// does at the desk.
  rejectRun(runId: UUID): Result;
  store: ThreadStore;
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
  if (run.state.reason === 'externalAction') return 'approval';
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
    return !!user && user === t.managerSlackUserId && managerFor(this.deps.workers(), t.workerId)?.slackUserId === user;
  }
  private status: SlackBridgeStatus = { enabled: false, connected: false, openThreads: 0 };
  /// `/worker`, `/hire` and hire approvals — set once the org control plane
  /// exists, which is built after the bridge.
  private commands: SlackCommands | null = null;

  constructor(private readonly deps: SlackBridgeDeps) {}

  setCommands(commands: SlackCommands): void {
    this.commands = commands;
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
    const manager = managerFor(workers, run.workerId!);
    if (!worker || !manager?.slackUserId) return;

    this.posting.add(key);
    try {
      await this.post(run, worker, manager.slackUserId, kind, stepId, exchange);
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
  ): Promise<void> {
    const bot = this.deps.tokens().bot;
    if (!bot) return;
    const im = await openIm(bot, managerSlackUserId, this.deps.fetchImpl);
    if (!im.ok) {
      this.deps.log('warn', `Could not open a DM with the manager of ${worker.name}: ${im.error}`);
      return;
    }
    const id = randomUUID();
    const title = escapeMrkdwn(clip(flowRunTitle(run), 200));
    const step = run.flowSnapshot.steps.find((s) => s.id === stepId);
    let text: string;
    let blocks: unknown[];
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
      text = `${worker.name} wants to act outside its sandbox on "${flowRunTitle(run)}"`;
      blocks = [
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text:
              `*Approval needed* for _${title}_\n` +
              `I am about to run ${what}, which reaches outside my sandbox — it may push, send, publish or change a service.`,
          },
        },
        ...(step?.systemPromptOverride
          ? [{ type: 'section', text: { type: 'mrkdwn', text: quote(clip(step.systemPromptOverride, 1200)) } }]
          : []),
        {
          type: 'actions',
          elements: [
            { type: 'button', style: 'primary', text: { type: 'plain_text', text: 'Approve' }, action_id: SLACK_APPROVE_ACTION, value: id },
            { type: 'button', style: 'danger', text: { type: 'plain_text', text: 'Reject' }, action_id: SLACK_REJECT_ACTION, value: id },
          ],
        },
      ];
    }
    const posted = await postMessage(
      bot,
      { channel: im.data, text, blocks, username: worker.name, ...(worker.avatarUrl ? { iconUrl: worker.avatarUrl } : {}) },
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
      threadTs: posted.data.ts,
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
      await this.reply(t, done ? 'This run has finished — nothing more needed here.' : 'Picked up in overcli — nothing more needed here.');
      if (t.kind === 'approval') await this.clearButtons(t, 'Handled in overcli.');
    }
  }

  private stillWaiting(run: FlowRun | null, t: SlackThread): boolean {
    if (!run || run.state.kind !== 'paused' || run.state.nextStepId !== t.stepId) return false;
    if (pauseKind(run) !== t.kind) return false;
    if (t.kind === 'question' && t.exchangeId) return openExchange(run, t.stepId)?.id === t.exchangeId;
    return true;
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
        ts: t.threadTs,
        text: outcome,
        blocks: [{ type: 'section', text: { type: 'mrkdwn', text: `*${escapeMrkdwn(t.workerName)}* asked for approval. ${outcome}` } }],
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
  private eventTap: ((ev: Record<string, any>) => void | Promise<void>) | null = null;

  setEventTap(tap: ((ev: Record<string, any>) => void | Promise<void>) | null): void {
    this.eventTap = tap;
  }

  private async onEvent(payload: unknown): Promise<void> {
    const p = payload as {
      team_id?: string;
      event?: { type?: string; channel_type?: string; user?: string; bot_id?: string; subtype?: string; text?: string; thread_ts?: string; channel?: string };
    };
    const ev = p?.event;
    if (ev && ev.channel_type !== 'im' && this.fromOurTeam(p.team_id) && this.eventTap) {
      try {
        await this.eventTap(ev as Record<string, any>);
      } catch (err) {
        this.deps.log('warn', `A Slack trigger failed: ${String(err)}`);
      }
      return;
    }
    if (!ev || ev.type !== 'message' || ev.channel_type !== 'im') return;
    if (ev.bot_id || ev.subtype || !ev.thread_ts || !ev.user) return;
    if (!this.fromOurTeam(p.team_id)) return;
    const t = this.threads.find((x) => x.channel === ev.channel && x.threadTs === ev.thread_ts);
    if (!t) {
      // Not a run's thread — maybe a hire interview.
      await this.commands?.onThreadReply(ev, p.team_id);
      return;
    }
    if (!this.isCurrentManager(t, ev.user)) return;
    if (t.resolvedAt) {
      await this.reply(t, 'This one is already settled — start a new thread if something changed.');
      return;
    }
    if (t.kind === 'approval') {
      await this.reply(t, 'Use Approve or Reject above — a reply here does not approve anything.');
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
    if (p?.type !== 'block_actions' || !this.fromOurTeam(p.team?.id)) return;
    const action = p.actions?.[0];
    if (action && this.commands?.handlesAction(action.action_id)) {
      await this.commands.onAction(payload);
      return;
    }
    if (!action || (action.action_id !== SLACK_APPROVE_ACTION && action.action_id !== SLACK_REJECT_ACTION)) return;
    const t = this.threads.find((x) => x.id === action.value && x.kind === 'approval');
    if (!t || !this.isCurrentManager(t, p.user?.id) || t.resolvedAt) return;
    const run = this.deps.getRun(t.runId);
    if (!this.stillWaiting(run, t)) {
      await this.settleStale(t.runId, run);
      return;
    }
    const approve = action.action_id === SLACK_APPROVE_ACTION;
    const res = approve ? this.deps.resumeRun({ runId: t.runId }) : this.deps.rejectRun(t.runId);
    if (!res.ok) {
      await this.reply(t, `That did not go through: ${res.error}`);
      return;
    }
    t.resolvedAt = this.now();
    t.resolution = approve ? 'approved' : 'rejected';
    this.persist();
    await this.clearButtons(t, approve ? `Approved by <@${t.managerSlackUserId}>.` : `Rejected by <@${t.managerSlackUserId}>.`);
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
