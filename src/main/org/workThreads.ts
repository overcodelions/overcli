// One thread per piece of a worker's work: what set it off (a question, Run
// now, its schedule, a trigger, a colleague), what it decided, what it put
// to its manager, the runs that came of it and what they found — joined, so
// the page can say in one sentence where each stands.
//
// Pure: the org service hands in what it has, so the joins are testable on
// their own.

import type { FlowRun } from '../../shared/flows/schema';
import { flowRunTitle } from '../../shared/flows/schema';
import type { Orchestration, OrchestrationItem } from '../../shared/flows/orchestration';
import type { WorkerJournalEntry } from '../../shared/flows/worker';
import type { AskRecord } from './orgStores';

type UUID = string;

export type ThreadStage =
  | 'deciding'
  | 'waiting'
  | 'running'
  | 'needsYou'
  | 'done'
  | 'answered'
  | 'nothing'
  | 'declined'
  | 'failed'
  | 'stopped';

export interface ThreadRun {
  runId: UUID;
  title: string;
  state: 'working' | 'question' | 'approval' | 'interrupted' | 'paused' | 'done' | 'failed' | 'stopped';
  startedAt: number;
  endedAt?: number;
  /// 1-based: where it is, or where it stopped.
  step: { index: number; total: number; name: string };
  steps: Array<{ id: string; label: string; state: 'done' | 'now' | 'need' | 'next' | 'failed'; tookMs?: number }>;
  costUSD?: number;
  /// What it found, in a sentence or two, and the file it wrote.
  summary?: string;
  result?: { name: string; body: string };
  error?: string;
  /// The journal entry its result was filed under, for "was this useful?".
  entryId?: string;
  rating?: { useful: boolean; by: string; note?: string };
}

export interface ThreadItem {
  candidateId: string;
  title: string;
  detail?: string;
  status: 'waiting' | 'queued' | 'running' | 'done' | 'failed' | 'skipped';
  runId?: UUID;
}

export interface WorkThread {
  id: string;
  at: number;
  /// When anything in it last moved: the thread list's order for live work.
  updatedAt: number;
  source: 'ask' | 'runNow' | 'schedule' | 'trigger' | 'colleague' | 'run';
  /// What set it off, as it should read: the question, or a short label.
  prompt: string;
  by?: string;
  via?: AskRecord['via'];
  stage: ThreadStage;
  /// Where it stands, in one sentence.
  headline: string;
  /// Its lifecycle, left to right.
  progress: Array<{ label: string; state: 'done' | 'now' | 'next' | 'need' | 'failed' | 'skipped'; at?: number; detail?: string }>;
  /// The worker's own words: its answer, or why it chose what it chose.
  reply?: { text: string; at: number; tookMs?: number };
  proposal?: { batchId: UUID; waiting: boolean; items: ThreadItem[] };
  runs: ThreadRun[];
  costUSD: number;
  error?: string;
  note?: string;
  /// One-tap answers the worker offered, when it asked its manager to decide.
  choices?: string[];
  /// Replies in this thread, oldest first, each with its own outcome. When
  /// there are any, `stage` and `headline` are the latest reply's, and
  /// `selfStage` / `selfHeadline` keep the thread's own.
  followUps?: WorkThread[];
  selfStage?: ThreadStage;
  selfHeadline?: string;
  /// The newest moment in it, replies included: the list's order.
  lastAt: number;
  /// Set when it was a piece of a team's task.
  team?: { id: UUID; name: string; taskId: UUID };
}

export interface ThreadInputs {
  workerName: string;
  asks: AskRecord[];
  journal: WorkerJournalEntry[];
  /// This worker's batches.
  batches: Orchestration[];
  /// This worker's runs.
  runs: FlowRun[];
  /// Results filed in its journal, by run.
  filed: Map<UUID, { entryId: string; title: string; rating?: ThreadRun['rating'] }>;
  planning: { since: number; task: 'shift' | 'errand'; manual?: boolean } | null;
  /// Who pressed Run now, and when: the decision log's record of it, which
  /// also marks shifts journaled before they carried `manual`.
  runNow?: Array<{ at: number; by: string }>;
  now: number;
}

const cap = (s: string): string => (s ? s.charAt(0).toUpperCase() + s.slice(1).replace(/[-_]+/g, ' ') : '');
const quote = (s: string): string => `“${s}”`;

/// The first line or two of a report that says something: past headings,
/// rules and empty lines, with markdown taken off.
export function summarize(body: string, max = 320): string {
  const lines = body
    .replace(/\r/g, '')
    .replace(/^---\n[\s\S]*?\n---\n/, '')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !/^#{1,6}\s/.test(l) && !/^(-{3,}|\*{3,}|_{3,}|\x60{3}.*)$/.test(l) && !/^\|/.test(l));
  const plain = (l: string) =>
    l
      .replace(/^[-*+]\s+|^\d+[.)]\s+|^>\s?/, '')
      .replace(/\*\*([^*]+)\*\*|__([^_]+)__/g, '$1$2')
      .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
      .replace(/\x60([^\x60]+)\x60/g, '$1')
      .trim();
  let out = '';
  for (const l of lines) {
    const p = plain(l);
    if (!p || /:$/.test(p)) continue;
    out = out ? `${out} ${p}` : p;
    if (out.length > max / 2) break;
  }
  return out.length > max ? `${out.slice(0, max - 1).replace(/\s+\S*$/, '')}…` : out;
}

function firstSentence(text: string, max = 220): string {
  const s = summarize(text, max * 2);
  const m = /^(.{20,}?[.!?])(\s|$)/.exec(s);
  const one = m ? m[1] : s;
  return one.length > max ? `${one.slice(0, max - 1).replace(/\s+\S*$/, '')}…` : one;
}

function threadRun(r: FlowRun, filed: ThreadInputs['filed']): ThreadRun {
  const steps = r.flowSnapshot.steps;
  const s = r.state;
  const atId = s.kind === 'running' ? s.currentStepId : s.kind === 'paused' ? s.nextStepId : undefined;
  const ended = s.kind === 'done' || s.kind === 'aborted';
  const failedAttempt = r.attempts.filter((a) => a.outcome === 'error' || a.outcome === 'reboundExhausted').pop();
  const success = s.kind === 'done' && s.success;
  let index = atId ? steps.findIndex((x) => x.id === atId) : -1;
  if (index < 0) index = ended && !success && failedAttempt ? Math.max(0, steps.findIndex((x) => x.id === failedAttempt.stepId)) : ended ? steps.length - 1 : 0;
  const took = (id: string) => r.attempts.filter((a) => a.stepId === id).reduce((n, a) => n + Math.max(0, (a.endedAt ?? a.startedAt) - a.startedAt), 0);
  const reason = s.kind === 'paused' ? s.reason : undefined;
  const state: ThreadRun['state'] =
    s.kind === 'running'
      ? 'working'
      : s.kind === 'paused'
        ? reason === 'needsInput'
          ? 'question'
          : reason === 'externalAction' || reason === 'riskyStep'
            ? 'approval'
            : reason === 'interrupted'
              ? 'interrupted'
              : 'paused'
        : success
          ? 'done'
          : s.kind === 'aborted' && !failedAttempt
            ? 'stopped'
            : 'failed';
  const artifact = Object.values(r.artifacts ?? {}).sort((a, b) => b.producedAt - a.producedAt)[0];
  const endedAt = ended ? Math.max(r.createdAt, ...r.attempts.map((a) => a.endedAt ?? a.startedAt)) : undefined;
  const f = filed.get(r.id);
  const title = flowRunTitle(r);
  const summary = f && f.title && f.title !== title ? f.title : artifact && /\.(md|markdown|txt)$/i.test(artifact.name) ? summarize(artifact.body) : undefined;
  return {
    runId: r.id,
    title,
    state,
    startedAt: r.createdAt,
    ...(endedAt ? { endedAt } : {}),
    step: { index: index + 1, total: steps.length, name: cap(steps[index]?.id ?? '') },
    steps: steps.map((x, i) => {
      const st: 'done' | 'now' | 'need' | 'next' | 'failed' =
        success || i < index
          ? 'done'
          : i === index
            ? state === 'working'
              ? 'now'
              : state === 'question' || state === 'approval'
                ? 'need'
                : state === 'done'
                  ? 'done'
                  : 'failed'
            : 'next';
      const ms = took(x.id);
      return { id: x.id, label: cap(x.id), state: st, ...(ms ? { tookMs: ms } : {}) };
    }),
    ...(r.costUSD ? { costUSD: r.costUSD } : {}),
    ...(summary ? { summary } : {}),
    ...(artifact ? { result: { name: artifact.name, body: artifact.body.slice(0, 20_000) } } : {}),
    ...(state === 'failed' && failedAttempt?.errorMessage ? { error: failedAttempt.errorMessage.slice(0, 400) } : {}),
    ...(f ? { entryId: f.entryId, ...(f.rating ? { rating: f.rating } : {}) } : {}),
  };
}

function itemStatus(i: OrchestrationItem): ThreadItem['status'] {
  switch (i.status) {
    case 'proposed':
      return 'waiting';
    case 'queued':
      return 'queued';
    case 'running':
    case 'paused':
      return 'running';
    case 'done':
      return 'done';
    case 'failed':
      return 'failed';
    default:
      return 'skipped';
  }
}

/// The one-tap answers a worker offered: `<replies><reply>…</reply></replies>`.
export function replyChoices(s: string): string[] {
  const block = /<replies>([\s\S]*?)<\/replies>/.exec(s);
  if (!block) return [];
  return [...block[1].matchAll(/<reply>([\s\S]*?)<\/reply>/g)]
    .map((m) => m[1].replace(/\s+/g, ' ').trim())
    .filter((x) => x && x.length <= 120)
    .slice(0, 4);
}

/// Slack's link markup, <url|label> or <url>, as it was typed. Questions
/// asked in Slack before the front door cleaned them still carry it.
export function slackPlain(text: string): string {
  return text.replace(/<((?:https?|mailto):[^|>]+)\|([^>]+)>/g, '$2').replace(/<((?:https?|mailto):[^>]+)>/g, '$1');
}

/// What was asked, out of the errand a worker was handed: without the
/// directions overcli adds after it (where the answer goes, how to send a
/// file) or the Slack thread quoted under it.
export function askedWords(errand: string): string {
  const cut = errand.search(/\n(?:Your reply is posted back in that Slack thread|The Slack thread this came from|The last messages in the channel before this request|Also shared there)/);
  return slackPlain((cut > 0 ? errand.slice(0, cut) : errand).replace(/^More from .+ on the same request:\n/, '').trim());
}

const stripReply = (s: string): string =>
  s
    .replace(/<remember>[\s\S]*?<\/remember>/g, '')
    .replace(/<replies>[\s\S]*?<\/replies>/g, '')
    .replace(/<candidates>[\s\S]*?<\/candidates>/g, '')
    .replace(/<subject>[\s\S]*?<\/subject>/g, '')
    .replace(/<flow_request>[\s\S]*?<\/flow_request>/g, '')
    .trim();

/// Every thread, newest first.
export function buildThreads(input: ThreadInputs): WorkThread[] {
  const { workerName: name } = input;
  const runsById = new Map(input.runs.map((r) => [r.id, r]));
  const batchById = new Map(input.batches.map((b) => [b.id, b]));
  const usedBatches = new Set<string>();
  const usedRuns = new Set<string>();
  const approvedAt = new Map<string, number>();
  for (const e of input.journal) {
    if (e.kind === 'approved' && e.orchestrationId && !approvedAt.has(e.orchestrationId)) approvedAt.set(e.orchestrationId, e.at);
  }

  // The batch an ask led to: recorded on the ask, else the errand batch
  // created while it was being answered, carrying its words.
  //
  // Never one another ask names as its own: a reply in a Slack thread
  // carries the thread so far, so the next ask's errand contains this one's
  // words too, and matching by words alone handed this ask its work.
  const errandBatches = input.batches.filter((b) => b.origin?.kind === 'worker' && b.origin.task === 'errand').sort((x, y) => x.createdAt - y.createdAt);
  const claimed = new Set(input.asks.flatMap((a) => (a.orchestrationId ? [a.orchestrationId] : [])));
  const batchForAsk = (a: AskRecord): Orchestration | undefined => {
    if (a.orchestrationId) return batchById.get(a.orchestrationId);
    const until = (a.doneAt ?? input.now) + 60_000;
    return errandBatches.find(
      (b) =>
        !usedBatches.has(b.id) &&
        !claimed.has(b.id) &&
        b.createdAt >= a.at - 1000 &&
        b.createdAt <= until &&
        b.origin?.kind === 'worker' &&
        // By what was asked, or by what the worker was handed: a turn overcli
        // asks for itself (finishing up handed-off work) is labelled in words
        // its prompt never uses.
        ((b.origin.errand ?? '').includes(a.text.slice(0, 200)) || (!!a.prompt && (b.origin.errand ?? '').includes(a.prompt.slice(0, 200)))),
    );
  };

  const make = (base: {
    id: string;
    at: number;
    source: WorkThread['source'];
    prompt: string;
    by?: string;
    via?: AskRecord['via'];
    deciding: boolean;
    decidedAt?: number;
    decidedLabel: string;
    reply?: string;
    failed?: string;
    note?: string;
    batch?: Orchestration;
    extraRuns?: FlowRun[];
    choices?: string[];
  }): WorkThread => {
    const b = base.batch;
    if (b) usedBatches.add(b.id);
    const items: ThreadItem[] = (b?.items ?? []).map((i) => ({
      candidateId: i.candidate.id,
      title: i.candidate.title,
      ...(i.candidate.note ? { detail: i.candidate.note } : {}),
      status: itemStatus(i),
      ...(i.runId ? { runId: i.runId } : {}),
    }));
    const runIds = [...items.flatMap((i) => (i.runId ? [i.runId] : [])), ...(base.extraRuns ?? []).map((r) => r.id)];
    const runs = runIds.flatMap((id) => {
      const r = runsById.get(id);
      if (!r || usedRuns.has(id)) return [];
      usedRuns.add(id);
      return [threadRun(r, input.filed)];
    });
    // A team's piece: say which team, and drop "Team: " from its titles.
    const teamRun = runIds.map((id) => runsById.get(id)).find((r) => r?.team);
    const team = teamRun?.team ? { id: teamRun.team.teamId, name: teamRun.team.teamName, taskId: teamRun.team.taskId } : undefined;
    const unprefix = (x: string) => (team && x.startsWith(`${team.name}: `) ? x.slice(team.name.length + 2) : x);
    if (team) {
      for (const r of runs) r.title = unprefix(r.title);
      base.prompt = unprefix(base.prompt);
    }
    const waiting = items.filter((i) => i.status === 'waiting');
    const live = runs.filter((r) => r.state === 'working');
    const need = runs.filter((r) => r.state === 'question' || r.state === 'approval');
    const stopped = runs.filter((r) => r.state === 'interrupted' || r.state === 'paused');
    const queued = items.filter((i) => i.status === 'queued' || (i.status === 'running' && !runs.some((r) => r.runId === i.runId)));
    const finished = runs.filter((r) => r.state === 'done');
    const broke = runs.filter((r) => r.state === 'failed' || r.state === 'stopped');

    const stage: ThreadStage = base.deciding
      ? 'deciding'
      : base.failed
        ? 'failed'
        : need.length
          ? 'needsYou'
          : live.length || queued.length
            ? 'running'
            : stopped.length
              ? 'stopped'
              : waiting.length
                ? 'waiting'
                : items.length && !runs.length && items.every((i) => i.status === 'skipped')
                  ? 'declined'
                  : runs.length
                    ? finished.length
                      ? 'done'
                      : 'failed'
                    : base.source === 'ask' || base.source === 'trigger' || base.source === 'colleague'
                      ? base.reply
                        ? 'answered'
                        : 'nothing'
                      : 'nothing';

    const titles = (xs: Array<{ title: string }>) => (xs.length === 1 ? quote(xs[0].title) : `${xs.length} things`);
    const r0 = live[0] ?? need[0] ?? stopped[0] ?? runs[0];
    const headline =
      stage === 'deciding'
        ? base.source === 'ask'
          ? `${name} is working out how to answer this.`
          : `${name} is deciding what to work on.`
        : stage === 'failed'
          ? base.failed
            ? `${name} couldn’t: ${base.failed}`
            : `${quote(broke[0]?.title ?? 'The run')} failed${broke[0]?.error ? `: ${broke[0].error}` : '.'}`
          : stage === 'needsYou'
            ? need[0].state === 'question'
              ? `${quote(need[0].title)} has a question for you.`
              : `${quote(need[0].title)} wants your OK before its ${need[0].step.name.toLowerCase()} step.`
            : stage === 'running'
              ? r0
                ? `${r0.step.name}: step ${r0.step.index} of ${r0.step.total} of ${quote(r0.title)}.`
                : `Starting ${titles(queued)}.`
              : stage === 'stopped'
                ? `${quote(stopped[0].title)} stopped at step ${stopped[0].step.index}${stopped[0].state === 'interrupted' ? ': the server restarted' : ''}.`
                : stage === 'waiting'
                  ? `${name} wants to run ${titles(waiting)}. OK?`
                  : stage === 'declined'
                    ? `You skipped ${titles(items)}.`
                    : stage === 'done'
                      ? finished[0].summary
                        ? firstSentence(finished[0].summary, 260)
                        : `Finished ${quote(finished[0].title)}.`
                      : stage === 'answered'
                        ? firstSentence(base.reply ?? '', 260)
                        : base.note && !/^Nothing worth proposing/.test(base.note) && !/^\d+ proposed/.test(base.note)
                          ? base.note
                          : 'Looked, and found nothing new worth doing.';

    // Its lifecycle, as far as it applies.
    const progress: WorkThread['progress'] = [];
    progress.push(
      base.deciding
        ? { label: `${name} decides`, state: 'now' }
        : base.failed
          ? { label: `${name} decides`, state: 'failed', ...(base.decidedAt ? { at: base.decidedAt } : {}) }
          : { label: base.decidedLabel, state: 'done', ...(base.decidedAt ? { at: base.decidedAt, detail: `${Math.max(1, Math.round((base.decidedAt - base.at) / 1000))} s` } : {}) },
    );
    const asked = b ? approvedAt.get(b.id) : undefined;
    if (items.length && b) {
      const autoStarted = !waiting.length && runs.length && !asked;
      progress.push(
        waiting.length
          ? { label: 'Your OK', state: 'need' }
          : stage === 'declined'
            ? { label: 'You skipped it', state: 'skipped' }
            : autoStarted
              ? { label: 'Started on its own', state: 'done', at: b.createdAt }
              : { label: 'You approved', state: 'done', ...(asked ? { at: asked } : {}) },
      );
    }
    if (runs.length || queued.length || (waiting.length && items.length)) {
      const total = runs.length || queued.length || waiting.length;
      progress.push(
        live.length || queued.length
          ? { label: r0 ? `Running · step ${r0.step.index} of ${r0.step.total}` : 'Starting', state: 'now', ...(r0 ? { at: r0.startedAt } : {}) }
          : need.length
            ? { label: need[0].state === 'question' ? 'Has a question' : 'Wants your OK', state: 'need' }
            : stopped.length
              ? { label: 'Stopped', state: 'failed' }
              : runs.length && (finished.length || broke.length)
                ? { label: total > 1 ? `Ran ${total}` : `Ran in ${Math.max(1, Math.round(((runs[0].endedAt ?? input.now) - runs[0].startedAt) / 60_000))} min`, state: finished.length ? 'done' : 'failed' }
                : { label: total > 1 ? `Run ${total}` : 'Run', state: 'next' },
      );
      progress.push(
        stage === 'done'
          ? { label: 'Answer', state: 'done', ...(finished[0].endedAt ? { at: finished[0].endedAt } : {}) }
          : stage === 'failed'
            ? { label: 'Answer', state: 'failed' }
            : { label: 'Answer', state: 'next', detail: 'lands here' },
      );
    } else if (stage === 'answered') {
      progress.push({ label: 'Answered', state: 'done', ...(base.decidedAt ? { at: base.decidedAt } : {}) });
    }

    const at = base.at;
    const updatedAt = Math.max(at, base.decidedAt ?? at, ...runs.map((r) => r.endedAt ?? (r.state === 'working' ? input.now : r.startedAt)), b?.createdAt ?? at);
    const costUSD = runs.reduce((n, r) => n + (r.costUSD ?? 0), 0);
    return {
      id: base.id,
      at,
      updatedAt,
      source: base.source,
      prompt: base.prompt,
      ...(base.by ? { by: base.by } : {}),
      ...(base.via ? { via: base.via } : {}),
      stage,
      headline,
      progress,
      ...(base.reply ? { reply: { text: base.reply, at: base.decidedAt ?? at, ...(base.decidedAt ? { tookMs: base.decidedAt - at } : {}) } } : {}),
      ...(b && items.length ? { proposal: { batchId: b.id, waiting: waiting.length > 0, items } } : {}),
      runs,
      costUSD,
      ...(base.failed ? { error: base.failed } : {}),
      ...(base.note ? { note: base.note } : {}),
      ...(base.choices?.length ? { choices: base.choices } : {}),
      ...(team ? { team } : {}),
      lastAt: at,
    };
  };

  const threads: WorkThread[] = [];

  // Replies are built where their questions are, so they claim their own
  // batches and runs; they are hung on their threads at the end.
  const replies: Array<{ parent: string; thread: WorkThread }> = [];
  for (const a of input.asks) {
    // Even while it's still deciding: the worker hands work off before its
    // reply comes back, and that batch is this ask's, not an errand of its
    // own titled with the raw prompt.
    const b = batchForAsk(a);
    (a.replyTo ? (t: WorkThread) => replies.push({ parent: a.replyTo!, thread: t }) : (t: WorkThread) => threads.push(t))(
      make({
        id: `ask:${a.id}`,
        at: a.at,
        source: a.via === 'trigger' ? 'trigger' : 'ask',
        prompt: slackPlain(a.text),
        by: a.by,
        ...(a.via ? { via: a.via } : {}),
        deciding: a.status === 'working',
        ...(a.doneAt ? { decidedAt: a.doneAt } : {}),
        decidedLabel: `${name} decided`,
        ...(a.reply ? { reply: stripReply(a.reply), choices: a.choices?.length ? a.choices : replyChoices(a.reply) } : {}),
        ...(a.status === 'failed' ? { failed: a.error || 'it could not answer.' } : {}),
        ...(b ? { batch: b } : {}),
      }),
    );
  }

  const shifts = input.journal.filter((e) => e.kind === 'shift');
  for (const e of shifts) {
    const b = e.orchestrationId ? batchById.get(e.orchestrationId) : undefined;
    // Logged as the reply came back, so within moments of the journal line.
    const pressed = (input.runNow ?? []).find((x) => Math.abs(x.at - e.at) < 5000);
    const manual = e.manual || !!pressed;
    const reply = stripReply(b?.producer?.reply ?? '');
    const failed = !b && /^Failed: /.test(e.note ?? '') ? (e.note ?? '').replace(/^Failed: /, '') : undefined;
    threads.push(
      make({
        id: `shift:${e.id}`,
        // A shift is journaled when it has decided; it began when planning did.
        at: b?.createdAt && b.createdAt < e.at ? b.createdAt : e.at,
        source: manual ? 'runNow' : 'schedule',
        prompt: manual ? 'Run now' : 'Scheduled check',
        ...(pressed ? { by: pressed.by } : {}),
        deciding: false,
        decidedAt: e.at,
        decidedLabel: `${name} decided`,
        ...(reply ? { reply } : {}),
        ...(failed ? { failed } : {}),
        ...(!b && !failed && e.note ? { note: e.note } : {}),
        ...(b ? { batch: b } : {}),
      }),
    );
  }

  // A shift deciding right now has no journal entry yet.
  if (input.planning?.task === 'shift') {
    threads.push(
      make({
        id: 'deciding',
        at: input.planning.since,
        source: input.planning.manual ? 'runNow' : 'schedule',
        prompt: input.planning.manual ? 'Run now' : 'Scheduled check',
        deciding: true,
        decidedLabel: `${name} decided`,
      }),
    );
  }

  // Errands no ask covers: a colleague's handoff, or one sent from elsewhere.
  for (const b of input.batches) {
    if (usedBatches.has(b.id) || b.origin?.kind !== 'worker' || b.origin.task !== 'errand') continue;
    const from = (b.origin as { from?: { workerName?: string } }).from;
    threads.push(
      make({
        id: `batch:${b.id}`,
        at: b.createdAt,
        source: from ? 'colleague' : 'ask',
        prompt: askedWords(b.origin.errand || b.title),
        ...(from?.workerName ? { by: from.workerName } : {}),
        deciding: false,
        decidedAt: b.createdAt,
        decidedLabel: `${name} decided`,
        ...(b.producer?.reply ? { reply: stripReply(b.producer.reply) } : {}),
        batch: b,
      }),
    );
  }
  // Shift batches whose journal line is gone: still work that happened.
  for (const b of input.batches) {
    if (usedBatches.has(b.id) || b.origin?.kind !== 'worker') continue;
    threads.push(
      make({
        id: `batch:${b.id}`,
        at: b.createdAt,
        source: 'schedule',
        prompt: 'Scheduled check',
        deciding: false,
        decidedAt: b.createdAt,
        decidedLabel: `${name} decided`,
        ...(b.producer?.reply ? { reply: stripReply(b.producer.reply) } : {}),
        batch: b,
      }),
    );
  }

  // Runs started some other way — a trigger, a team, by hand.
  for (const r of input.runs) {
    if (usedRuns.has(r.id)) continue;
    threads.push(
      make({
        id: `run:${r.id}`,
        at: r.createdAt,
        source: 'run',
        prompt: flowRunTitle(r),
        deciding: false,
        decidedLabel: 'Started',
        extraRuns: [r],
      }),
    );
  }

  const byId = new Map(threads.map((t) => [t.id, t]));
  for (const r of replies.sort((a, b) => a.thread.at - b.thread.at)) {
    // A reply to a reply belongs to the thread its parent hangs on.
    let parent = byId.get(r.parent);
    if (!parent) {
      const owner = threads.find((t) => t.followUps?.some((f) => f.id === r.parent));
      parent = owner;
    }
    if (!parent) {
      threads.push(r.thread); // its thread is gone: stand alone rather than vanish
      byId.set(r.thread.id, r.thread);
      continue;
    }
    if (!parent.followUps) {
      parent.followUps = [];
      parent.selfStage = parent.stage;
      parent.selfHeadline = parent.headline;
    }
    parent.followUps.push(r.thread);
    parent.stage = r.thread.stage;
    parent.headline = r.thread.headline;
    parent.costUSD += r.thread.costUSD;
    parent.lastAt = Math.max(parent.lastAt, r.thread.lastAt);
    parent.updatedAt = Math.max(parent.updatedAt, r.thread.updatedAt);
  }
  return threads.sort((a, b) => b.lastAt - a.lastAt);
}

/// What the worker is doing this moment, in one sentence, and which thread
/// it belongs to. Null when it's doing nothing.
export function nowLine(threads: WorkThread[], name: string, now = Date.now()): { sentence: string; threadId: string; since?: number; costUSD?: number; run?: ThreadRun } | null {
  const order: ThreadStage[] = ['running', 'needsYou', 'deciding', 'waiting', 'stopped'];
  for (const stage of order) {
    // A stop older than a day won't carry on by itself; it's history, not now.
    const units = threads.flatMap((x) => [x.followUps ? { ...x, stage: x.selfStage ?? x.stage, headline: x.selfHeadline ?? x.headline } : x, ...(x.followUps ?? [])]);
    const t = units.find((x) => x.stage === stage && (stage !== 'stopped' || now - x.updatedAt < 86_400_000));
    if (!t) continue;
    const run = t.runs.find((r) => r.state === 'working') ?? t.runs.find((r) => r.state === 'question' || r.state === 'approval') ?? t.runs.find((r) => r.state === 'interrupted' || r.state === 'paused');
    const why = t.source === 'ask' || t.source === 'trigger' ? ` because ${t.by ? `${t.by} asked` : 'someone asked'} ${quote(t.prompt.length > 80 ? `${t.prompt.slice(0, 79)}…` : t.prompt)}` : t.source === 'runNow' ? ' because of Run now' : t.source === 'schedule' ? ' on its schedule' : '';
    const sentence =
      stage === 'running'
        ? run
          ? `${name} is on step ${run.step.index} of ${run.step.total}, ${run.step.name.toLowerCase()}, of ${quote(run.title)}${why}.`
          : `${name} is starting work${why}.`
        : stage === 'needsYou'
          ? `${name} is waiting on you: ${t.headline.charAt(0).toLowerCase()}${t.headline.slice(1)}`
          : stage === 'deciding'
            ? t.source === 'ask'
              ? `${name} is working out how to answer ${quote(t.prompt.length > 80 ? `${t.prompt.slice(0, 79)}…` : t.prompt)}.`
              : `${name} is deciding what to work on${why}: reading its job, its journal and what has changed.`
            : stage === 'waiting'
              ? `${name} is waiting for your OK to start ${t.proposal && t.proposal.items.filter((i) => i.status === 'waiting').length === 1 ? quote(t.proposal.items.find((i) => i.status === 'waiting')!.title) : 'what it proposed'}.`
              : `${t.headline}`;
    return {
      sentence,
      threadId: t.id,
      ...(run ? { since: run.startedAt, run } : stage === 'deciding' ? { since: t.at } : {}),
      ...(t.costUSD ? { costUSD: t.costUSD } : {}),
    };
  }
  return null;
}
