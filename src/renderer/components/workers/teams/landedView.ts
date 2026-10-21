// What a team task comes to once the team has talked about its pack: the
// coordinator's latest wrap-up read into its parts, the changes it proposed
// that the pack doesn't have yet, whether the task is waiting on you (and
// for what), and each reply in the debate folded to its point.

import { parseWrapUp, type WrapUp } from '@shared/flows/teamWrapUp';
import { piecesWaiting, type TeamMessage, type TeamTask } from '@shared/flows/team';
import { teamAsk } from '../todayBoard';
import { plainLine } from './roomView';

export interface LandedWrapUp {
  message: TeamMessage;
  /// Its place in the room's messages.
  index: number;
  wrap: WrapUp;
  /// Already in the pack: a pack update came after it.
  folded: boolean;
}

/// The coordinator's latest wrap-up that reads as one (labels it can find).
export function latestWrapUp(task: Pick<TeamTask, 'room'>): LandedWrapUp | null {
  const messages = task.room?.messages ?? [];
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (!m.wrapUp || m.failed) continue;
    const wrap = parseWrapUp(m.text);
    if (!wrap) continue;
    return { message: m, index: i, wrap, folded: i < (task.room?.foldedThrough ?? 0) };
  }
  return null;
}

/// The changes the latest wrap-up proposed that no pack update has taken in.
export function pendingChanges(task: Pick<TeamTask, 'room'>): string[] {
  const landed = latestWrapUp(task);
  return landed && !landed.folded ? landed.wrap.changes : [];
}

/// What the team said, not you: the Debate tab's count.
export function replyCount(messages: TeamMessage[]): number {
  return messages.filter((m) => m.speaker.kind !== 'you' && !m.failed).length;
}

/// Exchanges since the pack was last written, with a reply in them.
export function unfoldedExchanges(task: Pick<TeamTask, 'room'>): number {
  const messages = task.room?.messages ?? [];
  const folded = task.room?.foldedThrough ?? 0;
  return new Set(messages.slice(folded).filter((m) => m.speaker.kind !== 'you' && !m.failed).map((m) => m.exchange)).size;
}

/// Whether "Keep debating" has something to continue: members spoke in the
/// latest exchange and nobody is answering now.
export function canKeepDebating(task: Pick<TeamTask, 'room'>): boolean {
  const messages = task.room?.messages ?? [];
  const last = messages.at(-1)?.exchange;
  return !task.room?.busy && messages.some((m) => m.exchange === last && m.speaker.kind === 'member' && !m.failed);
}

/// Whether the pack can be rewritten now: the task is finished, nobody is
/// answering, and no work handed off from the room is running.
export function canUpdatePack(task: Pick<TeamTask, 'status' | 'room' | 'pack'>): boolean {
  return !!task.pack && (task.status === 'review' || task.status === 'done') && !task.room?.busy;
}

export type TaskTabId = 'landed' | 'conversation' | 'pack' | 'plan';

/// The tab a task opens on. Live talk or work from the room is the
/// conversation; a wrap-up nothing has been said after is where it landed;
/// otherwise the conversation when there is something new there, else the
/// pack.
export function defaultTaskTab(
  task: Pick<TeamTask, 'room' | 'pack' | 'status' | 'stages' | 'stageIndex'>,
  seen: number,
): TaskTabId {
  const messages = task.room?.messages ?? [];
  const roomWork = (task.status === 'running' || task.status === 'waiting') && !!task.stages[task.stageIndex]?.fromRoom;
  if (task.room?.busy || roomWork) return 'conversation';
  const landed = latestWrapUp(task);
  if (landed && replyCount(messages.slice(landed.index + 1)) === 0) return 'landed';
  const fresh = replyCount(messages.slice(seen)) > 0 || (messages.at(-1)?.at ?? 0) > (task.pack?.updatedAt ?? 0);
  return messages.length > 0 && fresh ? 'conversation' : 'pack';
}

export type TurnAction =
  | 'addChanges'
  | 'reviewPack'
  | 'updatePack'
  | 'keepDebating'
  | 'answerQuestions'
  | 'approvePlan'
  | 'readPlan'
  | 'seeWaiting'
  | 'openRun';

export interface TurnBand {
  title: string;
  detail: string;
  actions: Array<{ id: TurnAction; label: string; primary?: boolean }>;
  /// For `addChanges`: the changes it sends.
  changes?: string[];
  /// For `openRun`: the paused piece's run, and whose it is.
  run?: { runId: string; workerId: string };
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/// The "Your turn" band: what the task needs from you, said plainly, with
/// the actions that answer it. Null when it needs nothing, or while someone
/// in the room is answering (the status pill says that).
export function yourTurn(task: TeamTask): TurnBand | null {
  if (task.room?.busy) return null;
  if (!teamAsk(task)) return null;
  switch (task.status) {
    case 'questions': {
      const n = task.questions?.length ?? 0;
      return {
        title: `Your turn: the coordinator has ${plural(n, 'question')}`,
        detail: 'Answer what you can before it plans. Leave one blank and the coordinator decides.',
        actions: [{ id: 'answerQuestions', label: n === 1 ? 'Answer it' : 'Answer them', primary: true }],
      };
    }
    case 'proposed': {
      const members = new Set(task.stages.flatMap((s) => s.assignments.map((a) => a.workerId))).size;
      const hires = task.hires?.length ?? 0;
      return {
        title: 'Your turn: approve the plan',
        detail: `${plural(task.stages.length, 'stage')} with ${plural(members, 'member')}${hires ? `, and ${plural(hires, 'new hire')}` : ''}. Nothing runs until you approve.`,
        actions: [
          { id: 'approvePlan', label: hires ? `Approve, hire ${hires} and start` : 'Approve and start', primary: true },
          { id: 'readPlan', label: 'Read the plan first' },
        ],
      };
    }
    case 'running': {
      const waiting = piecesWaiting(task);
      const first = waiting[0];
      if (!first) return null;
      return {
        title:
          waiting.length === 1
            ? `Your turn: ${first.workerName} is waiting on you`
            : `Your turn: ${plural(waiting.length, 'member')} are waiting on you`,
        detail: `${waiting.map((a) => `${a.workerName} ${a.waitingFor}.`).join(' ')} The stage can’t finish until ${waiting.length === 1 ? 'it goes on' : 'they go on'}.`,
        actions: first.runId ? [{ id: 'openRun', label: `Open ${first.workerName}’s run`, primary: true }] : [],
        ...(first.runId ? { run: { runId: first.runId, workerId: first.workerId } } : {}),
      };
    }
    case 'waiting':
      return {
        title:
          task.waiting?.reason === 'budget'
            ? 'Your turn: the task reached its budget'
            : task.waiting?.reason === 'checkpoint'
              ? 'Your turn: a checkpoint'
              : 'Your turn: a stage needs you',
        detail: task.waiting?.message?.trim() || '',
        actions: [{ id: 'seeWaiting', label: 'See what it needs', primary: true }],
      };
    case 'review': {
      const version = task.pack?.version ?? 1;
      const files = task.pack?.files.length ?? 0;
      const head = `Version ${version}, ${plural(files, 'file')}.`;
      const changes = pendingChanges(task);
      const debate: TurnBand['actions'][number] = { id: 'keepDebating', label: 'Keep debating' };
      if (changes.length > 0) {
        return {
          title: 'Your turn: the pack is ready to review',
          detail: `${head} The team debated after it was built, and ${
            changes.length === 1 ? '1 change they agreed on isn’t' : `${changes.length} changes they agreed on aren’t`
          } in it yet.`,
          actions: [
            { id: 'addChanges', label: `Add the ${plural(changes.length, 'change')}, then review`, primary: true },
            { id: 'reviewPack', label: `Review v${version} as it is` },
            debate,
          ],
          changes,
        };
      }
      const talked = unfoldedExchanges(task);
      if (talked > 0) {
        return {
          title: 'Your turn: the pack is ready to review',
          detail: `${head} The team talked after it was built: ${plural(talked, 'exchange')} ${talked === 1 ? 'isn’t' : 'aren’t'} in it.`,
          actions: [
            { id: 'reviewPack', label: `Review v${version}`, primary: true },
            { id: 'updatePack', label: 'Update the pack first' },
            debate,
          ],
        };
      }
      return {
        title: 'Your turn: the pack is ready to review',
        detail: head,
        actions: [{ id: 'reviewPack', label: `Review v${version}`, primary: true }],
      };
    }
    default:
      return null;
  }
}

const BULLET = /^\s*(?:[-*•+]|\d+[.)])\s+/;

/// A reply folded to its point: its bold lead when it opens with one, else
/// its first sentence. `more` counts what "Show detail" opens to — its
/// bullets, else the sentences after the first; 0 when the gist is all of it.
export function replyGist(text: string): { gist: string; more: number } {
  const src = text.trim();
  const flat = plainLine(src);
  const lead = src.match(/^(?:\*\*|__)([^*_\n]{8,200}?)(?:\*\*|__)/)?.[1]?.trim().replace(/[:\s]+$/, '');
  const sentence = flat.match(/^.{20,}?[.!?](?=\s|$)/)?.[0];
  let gist = lead || sentence || flat;
  if (gist.length > 240) {
    const cut = gist.slice(0, 240);
    const space = cut.lastIndexOf(' ');
    gist = `${(space > 160 ? cut.slice(0, space) : cut).replace(/[,;:.\s]+$/, '')}…`;
  }
  const rest = flat.length - plainLine(gist.replace(/…$/, '')).length;
  if (rest <= 8) return { gist, more: 0 };
  const bullets = src.split('\n').filter((l) => BULLET.test(l)).length;
  if (bullets > 0) return { gist, more: bullets };
  const sentences = flat.match(/[^.!?]+[.!?]+(?=\s|$)/g)?.length ?? 1;
  return { gist, more: Math.max(1, sentences - 1) };
}

/// Who a reply answers, when the room says: the teammates it names who
/// spoke before it in the exchange; you, when it is the first answer to your
/// question; everyone, for a wrap-up. Empty when it can't be told.
export function repliesTo(messages: TeamMessage[], index: number): string[] {
  const m = messages[index];
  if (!m || m.speaker.kind === 'you') return [];
  if (m.wrapUp) return ['everyone'];
  const self = m.speaker.kind === 'member' ? m.speaker.name : 'Coordinator';
  const before = messages.slice(0, index).filter((x) => x.exchange === m.exchange);
  const earlier = [...new Set(before.flatMap((x) => (x.speaker.kind === 'member' && x.speaker.name !== self ? [x.speaker.name] : [])))];
  const text = m.text.toLowerCase();
  const named = earlier.filter((name) => {
    const n = name.toLowerCase();
    return new RegExp(`(^|[^a-z0-9_])@?${n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![a-z0-9_])`).test(text);
  });
  if (named.length > 0) return named;
  const asked = before.some((x) => x.speaker.kind === 'you');
  const answered = before.some((x) => x.speaker.kind !== 'you' && !x.failed);
  return asked && !answered ? ['you'] : [];
}
