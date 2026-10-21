// A team task as one Slack message that keeps itself current: where it is
// in four facts, the stage it's on, who is on each, a progress bar, what it has spent,
// and the button for whatever waits on you. Posted once and edited as the
// task moves; what happens along the way goes in the thread under it, so
// a long task is one card to glance at rather than a stream of DMs.

import type { TeamStage, TeamTask } from '../../shared/flows/team';
import { escapeMrkdwn } from './slackApi';
import { slackMarkup } from './deliver';

export const TEAM_PIECE_APPROVE_ACTION = 'overcli_team_piece_approve';
export const TEAM_PIECE_RETRY_ACTION = 'overcli_team_piece_retry';
export const TEAM_ACCEPT_ACTION = 'overcli_team_accept';
/// A link button still sends an action; this one is ignored like any link.
export const TEAM_OPEN_ACTION = 'overcli_open_link';
/// Shared with the plan and checkpoint DMs (slackCommands.ts).
export const TEAM_CONTINUE_ACTION = 'overcli_team_continue';

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const money = (n: number) => `$${n.toLocaleString('en-US', { minimumFractionDigits: Number.isInteger(n) ? 0 : 2, maximumFractionDigits: 2 })}`;

/// "1h 12m", "4m", "40s".
export function took(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h ${m % 60}m`;
}

/// ▰▰▰▱▱▱▱▱▱▱: ten blocks whatever the stage count, so three stages read
/// as a bar and twelve still fit a line.
export function bar(done: number, total: number): string {
  const filled = Math.round((done / Math.max(1, total)) * 10);
  return '▰'.repeat(filled) + '▱'.repeat(10 - filled);
}

function mark(stage: TeamStage, current: boolean, waiting: boolean): string {
  if (stage.status === 'done') return '✅';
  if (stage.status === 'failed') return '❌';
  if (stage.status === 'skipped') return '⏭️';
  if (current) return waiting ? '🟡' : '🔵';
  return '⚪';
}

/// Stages finished so far, for the bar and for telling the thread.
export function stagesDone(task: Pick<TeamTask, 'stages'>): number {
  return task.stages.filter((s) => s.status === 'done' || s.status === 'skipped').length;
}

/// A sentence for where it stands, the line under the stages.
function standing(task: TeamTask): string {
  const n = task.stages.length;
  switch (task.status) {
    case 'done':
      return `Finished in ${took((task.finishedAt ?? task.updatedAt) - task.createdAt)}.`;
    case 'failed':
      return `Stopped: ${escapeMrkdwn(clip(task.error ?? 'a stage failed', 300))}`;
    case 'cancelled':
      return 'Cancelled.';
    case 'review':
      return 'Done, waiting for your review.';
    case 'waiting':
      return `Waiting on you: ${escapeMrkdwn(clip(task.waiting?.message ?? 'it needs your OK to go on', 300))}`;
    default: {
      const pausedPiece = task.stages[task.stageIndex]?.assignments.find((a) => a.status === 'paused');
      if (pausedPiece) return `${escapeMrkdwn(pausedPiece.workerName)} is waiting for your OK on stage ${task.stageIndex + 1}.`;
      return `Working on stage ${Math.min(task.stageIndex + 1, n)} of ${n}.`;
    }
  }
}

/// What the card can say about one member's run beyond the task itself:
/// its latest step, and in plain words what a step waiting for approval
/// would do outside the server.
export interface PieceLook {
  last?: { text: string; at: number };
  reaches?: string[];
}

const ago = (ms: number) => (ms < 60_000 ? 'just now' : `${took(ms)} ago`);

/// The card: Slack blocks plus the plain text a notification shows. Four
/// facts first, in Slack's two-column fields; finished stages folded to one
/// line; the current stage with room for what it's doing and its button;
/// what comes next in a quiet line. Finished, the facts say what it came to
/// and the summary takes the stages' place.
export function teamCard(task: TeamTask, opts: { now: number; consoleUrl?: string | null; look?: (runId: string) => PieceLook | null }): { text: string; blocks: unknown[] } {
  const total = task.stages.length;
  const done = stagesDone(task);
  const ended = task.status === 'done' || task.status === 'failed' || task.status === 'cancelled';
  // Held for your review is finished work too: the pack is written, and the
  // card shows it as it would a done task, with Accept beside it.
  const finished = task.status === 'done' || task.status === 'review';
  const title = task.title ?? clip(task.brief, 80);
  const icon = task.status === 'done' ? '✅  ' : task.status === 'review' ? '🟡  ' : task.status === 'failed' ? '❌  ' : task.status === 'cancelled' ? '⏹️  ' : '';
  const elapsed = took((ended ? (task.finishedAt ?? task.updatedAt) : opts.now) - task.createdAt);
  const at = Math.min(task.stageIndex + 1, total);
  const stage = ended ? undefined : task.stages[task.stageIndex];
  const paused = stage?.assignments.filter((a) => a.status === 'paused') ?? [];
  const failed = stage?.assignments.filter((a) => a.status === 'failed') ?? [];
  const field = (label: string, value: string) => ({ type: 'mrkdwn', text: `*${label}*\n${value}` });
  const open = opts.consoleUrl
    ? { type: 'button', text: { type: 'plain_text', text: 'Open' }, url: `${opts.consoleUrl.replace(/\/$/, '')}/#teamtask/${encodeURIComponent(task.id)}`, action_id: TEAM_OPEN_ACTION, value: task.id }
    : null;

  const needs = paused.length
    ? `🟡 ${escapeMrkdwn(paused.map((a) => a.workerName).join(', '))}’s step`
    : failed.length
      ? `❌ ${escapeMrkdwn(failed[0].workerName)} failed`
      : task.status === 'waiting'
        ? '🟡 Your OK to go on'
        : task.status === 'review'
          ? '🟡 Your review'
          : 'Nothing';
  const files = task.pack?.files ?? [];
  const facts = finished
    ? [field(task.status === 'review' ? 'Ready for your review' : 'Done', `${bar(total, total)}  ${total} of ${total}`), field('Took', elapsed), field('Spent', `${money(task.spentUSD)} of ${money(task.budgetUSD)}`), field('Files', files.length ? `${escapeMrkdwn(clip(files[0], 40))}${files.length > 1 ? ` and ${files.length - 1} more` : ''}` : 'none')]
    : [field('Progress', `${bar(done, total)}  ${ended ? done : at} of ${total}`), field(ended ? 'Ended' : 'Needs you', ended ? standing(task) : needs), field('Spent', `${money(task.spentUSD)} of ${money(task.budgetUSD)}`), field(ended ? 'Ran for' : 'Running for', elapsed)];

  const blocks: unknown[] = [
    { type: 'header', text: { type: 'plain_text', text: clip(`${icon}${task.teamName}`, 150), emoji: true } },
    { type: 'section', text: { type: 'mrkdwn', text: escapeMrkdwn(clip(title, 300)) }, ...(open ? { accessory: open } : {}) },
    { type: 'section', fields: facts },
    { type: 'divider' },
  ];

  if (finished) {
    blocks.push({ type: 'section', text: { type: 'mrkdwn', text: slackMarkup(clip(task.pack?.summary || 'Finished.', 2900)) } });
    if (task.status === 'review') {
      blocks.push({ type: 'actions', elements: [button('Accept', TEAM_ACCEPT_ACTION, task.id, 'primary')] });
      blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: 'The report is in the thread. Accept it, or open the task to ask for changes.' }] });
    }
  } else {
    // Finished stages, folded: their short names in one quiet line.
    const finished = task.stages.filter((s) => s.status === 'done' || s.status === 'skipped');
    if (finished.length) {
      const span = finished.length === 1 ? `Stage 1 done` : `Stages 1–${finished.length} done`;
      blocks.push({ type: 'section', text: { type: 'mrkdwn', text: `✅  *${span}*\n${escapeMrkdwn(clip(finished.map((s) => shortName(s.title)).join(' · '), 600))}` } });
    }
    if (stage) {
      const head = `${mark(stage, true, paused.length > 0 || task.status === 'waiting')}  *${at} · ${escapeMrkdwn(clip(stage.title, 120))}*`;
      let detail = '';
      let accessory: unknown = null;
      if (paused.length) {
        const a = paused[0];
        const reaches = a.runId ? opts.look?.(a.runId)?.reaches : undefined;
        detail = `*${escapeMrkdwn(a.workerName)}* ${reaches?.length ? `wants to ${escapeMrkdwn(clip(reaches.map(asWant).join(', '), 300))}` : 'wants to act outside the server'}. Waiting for your OK.`;
        if (a.runId) accessory = button('Approve', TEAM_PIECE_APPROVE_ACTION, `${task.id}:${a.runId}`, 'primary');
      } else if (failed.length) {
        const a = failed[0];
        detail = `*${escapeMrkdwn(a.workerName)}* failed${a.error ? `: ${escapeMrkdwn(clip(a.error, 300))}` : '.'}`;
        accessory = button('Retry', TEAM_PIECE_RETRY_ACTION, `${task.id}:${a.workerId}`);
      } else if (task.status === 'waiting') {
        detail = escapeMrkdwn(clip(task.waiting?.message ?? 'It stopped for your OK to go on.', 600));
        if (task.waiting?.reason !== 'away') accessory = button('Carry on', TEAM_CONTINUE_ACTION, task.id, 'primary');
      } else {
        const working = stage.assignments.filter((a) => a.status === 'running').map((a) => a.workerName);
        detail = working.length ? `${escapeMrkdwn(working.join(', '))} ${working.length === 1 ? 'is' : 'are'} on it.` : stage.assignments.length ? escapeMrkdwn(stage.assignments.map((a) => a.workerName).join(', ')) : 'The coordinator is on it.';
      }
      blocks.push({ type: 'section', text: { type: 'mrkdwn', text: `${head}\n${detail}` }, ...(accessory ? { accessory } : {}) });
      // More than one waiting, or failed alongside: the rest as buttons.
      const more = [...paused.slice(1).filter((a) => a.runId).map((a) => button(`Approve ${a.workerName}`, TEAM_PIECE_APPROVE_ACTION, `${task.id}:${a.runId}`, 'primary')), ...(paused.length ? failed : failed.slice(1)).map((a) => button(`Retry ${a.workerName}`, TEAM_PIECE_RETRY_ACTION, `${task.id}:${a.workerId}`))];
      if (more.length) blocks.push({ type: 'actions', elements: more.slice(0, 5) });
      const live = stage.assignments.map((a) => (a.runId ? opts.look?.(a.runId)?.last : undefined)).filter((x): x is { text: string; at: number } => !!x).sort((a, b) => b.at - a.at)[0];
      if (live) blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: `Last: ${escapeMrkdwn(clip(live.text, 140))} · ${ago(opts.now - live.at)}` }] });
    }
    const next = ended ? undefined : task.stages[task.stageIndex + 1];
    if (next) blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: `⚪  Next: ${task.stageIndex + 2} · ${escapeMrkdwn(clip(next.title, 120))}` }] });
    if (ended) blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: standing(task) }] });
  }
  const text = `${task.teamName}: ${title}, ${ended ? task.status : `stage ${at} of ${total}`}`;
  return { text, blocks };
}

/// "runs shell commands" as what someone wants to do: "run shell commands".
function asWant(reach: string): string {
  return reach
    .replace(/^may change\b/, 'change')
    .replace(/^runs\b/, 'run')
    .replace(/^opens\b/, 'open')
    .replace(/^searches\b/, 'search')
    .replace(/^reads\b/, 'read')
    .replace(/^ships\b/, 'ship')
    .replace(/^is marked as acting\b/, 'act');
}

/// A stage's name in a word or two, for the folded line: "Candidate
/// evidence: market, customer, innovation" is "Candidate evidence".
function shortName(title: string): string {
  const head = title.split(/[:—–(]/)[0].trim();
  const words = head.split(/\s+/);
  return words.length > 3 ? `${words.slice(0, 3).join(' ')}…` : head;
}

/// What the thread hears when a stage ends.
export function stageNote(task: TeamTask, index: number): string {
  const s = task.stages[index];
  const people = s.assignments.map((a) => a.workerName).join(', ');
  const files = s.assignments.filter((a) => a.file).length;
  const verb = s.status === 'failed' ? '❌ Stage failed' : s.status === 'skipped' ? '⏭️ Stage skipped' : '✅ Stage done';
  const time = s.startedAt && s.finishedAt ? `, ${took(s.finishedAt - s.startedAt)}` : '';
  return `${verb} · *${index + 1}. ${escapeMrkdwn(s.title)}*${people ? ` · ${escapeMrkdwn(people)}` : ''}${files ? ` · ${files} file${files === 1 ? '' : 's'}` : ''}${time}`;
}

function button(text: string, actionId: string, value: string, style?: 'primary' | 'danger') {
  return { type: 'button', text: { type: 'plain_text', text: clip(text, 70) }, action_id: actionId, value, ...(style ? { style } : {}) };
}
