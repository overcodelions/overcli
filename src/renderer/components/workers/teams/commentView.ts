// What you said about a team task's work, as the desk shows it: what each
// comment is about, what came of it in plain words, which file and which
// member's piece it belongs to, and where its passage sits in a file.

import { isMemberStage, type TeamComment, type TeamTask } from '@shared/flows/team';

/// The longest passage a comment quotes; main keeps no more than this.
export const QUOTE_MAX = 1000;

/// A selection, as the passage a comment quotes: runs of spaces folded,
/// blank lines dropped, trimmed, and cut to `QUOTE_MAX` at a word where it can.
export function quoteFromSelection(text: string): string {
  const tidy = text
    .replace(/[ \t ]+/g, ' ')
    .replace(/ ?\n[\s]*/g, '\n')
    .trim();
  if (tidy.length <= QUOTE_MAX) return tidy;
  const cut = tidy.slice(0, QUOTE_MAX);
  const space = cut.search(/\s\S*$/);
  return (space > QUOTE_MAX * 0.8 ? cut.slice(0, space) : cut).trimEnd();
}

/// What came of a comment, in words. `steered` and `redo` name the member.
export function commentOutcomeText(c: Pick<TeamComment, 'outcome' | 'workerName'>): string {
  const who = c.workerName ?? 'The member';
  switch (c.outcome) {
    case 'replanned':
      return 'Re-planned with it';
    case 'steered':
      return c.workerName ? `Sent to ${c.workerName} while working` : 'Sent to the running piece';
    case 'asked':
      return 'In the team conversation';
    case 'waiting':
      return 'Goes to the team when it finishes answering';
    case 'redo':
      return `${who} is redoing it`;
    default:
      return 'Briefs the next stages';
  }
}

export type CommentTopic =
  | { kind: 'file'; file: string; quote?: string }
  | { kind: 'questions' }
  | { kind: 'plan' }
  | { kind: 'coordinator' }
  | { kind: 'member'; workerId: string; workerName: string }
  | { kind: 'task' };

/// What a comment is about, most specific first: a passage of a file, then
/// the questions or plan, then the member it was said to.
export function commentTopic(c: TeamComment): CommentTopic {
  if (c.file) return { kind: 'file', file: c.file, quote: c.quote };
  if (c.about === 'questions') return { kind: 'questions' };
  if (c.about === 'plan') return { kind: 'plan' };
  if (c.about === 'coordinator') return { kind: 'coordinator' };
  if (c.workerId) return { kind: 'member', workerId: c.workerId, workerName: c.workerName ?? 'a member' };
  return { kind: 'task' };
}

/// A short label for what it's about: "On 01-find-every-saving-wes.md",
/// "On the questions", "To Wes".
export function commentTopicLabel(c: TeamComment): string {
  const t = commentTopic(c);
  const to = c.workerName && t.kind !== 'member' ? ` · to ${c.workerName}` : '';
  switch (t.kind) {
    case 'file':
      return `On ${t.file.split('/').pop() ?? t.file}${to}`;
    case 'questions':
      return `On the questions${to}`;
    case 'plan':
      return `On the plan${to}`;
    case 'coordinator':
      return 'To the coordinator';
    case 'member':
      return `To ${t.workerName}`;
    default:
      return 'On the task';
  }
}

/// Newest first, without changing the task's own list.
export function newestFirst(comments: readonly TeamComment[] | undefined): TeamComment[] {
  return [...(comments ?? [])].sort((a, b) => b.at - a.at);
}

/// The comments on one file, oldest first: the order they read down it.
export function commentsOnFile(comments: readonly TeamComment[] | undefined, file: string): TeamComment[] {
  return (comments ?? []).filter((c) => c.file === file);
}

/// How many comments were said to each member, by worker id.
export function commentsByMember(comments: readonly TeamComment[] | undefined): Map<string, number> {
  const out = new Map<string, number>();
  for (const c of comments ?? []) if (c.workerId) out.set(c.workerId, (out.get(c.workerId) ?? 0) + 1);
  return out;
}

/// The key of a member's piece in a stage, for `commentsByPiece`.
export const pieceKey = (stage: number, workerId: string) => `${stage}:${workerId}`;

/// How many comments belong to each member's piece in the plan, keyed by
/// `pieceKey`. A comment on a piece's file belongs to that piece. One said
/// to a member belongs to their piece in the latest stage that had started
/// when it was said, else their first piece.
export function commentsByPiece(task: Pick<TeamTask, 'stages' | 'comments'>): Map<string, number> {
  const out = new Map<string, number>();
  const bump = (key: string) => out.set(key, (out.get(key) ?? 0) + 1);
  const fileOwner = new Map<string, string>();
  task.stages.forEach((s, i) => s.assignments.forEach((a) => a.file && fileOwner.set(a.file, pieceKey(i, a.workerId))));
  for (const c of task.comments ?? []) {
    const byFile = c.file ? fileOwner.get(c.file) : undefined;
    if (byFile) {
      bump(byFile);
      continue;
    }
    if (!c.workerId) continue;
    let at = -1;
    let first = -1;
    task.stages.forEach((s, i) => {
      if (!s.assignments.some((a) => a.workerId === c.workerId)) return;
      if (first < 0) first = i;
      if (s.startedAt !== undefined && s.startedAt <= c.at) at = i;
    });
    const stage = at >= 0 ? at : first;
    if (stage >= 0) bump(pieceKey(stage, c.workerId));
  }
  return out;
}

/// Whether a member's piece can be started over: it is in the stage that
/// is running now (or stopped on a failure or a checkpoint) and has begun.
/// Mirrors what main allows, so the button is only there when it works.
export function canRedoPiece(task: Pick<TeamTask, 'status' | 'stageIndex' | 'stages' | 'waiting'>, stageIndex: number, workerId: string): boolean {
  if (stageIndex !== task.stageIndex) return false;
  const stage = task.stages[stageIndex];
  if (!stage || !isMemberStage(stage.kind)) return false;
  const a = stage.assignments.find((x) => x.workerId === workerId);
  if (!a || a.status === 'pending' || a.status === 'skipped') return false;
  return task.status === 'running' || (task.status === 'waiting' && (task.waiting?.reason === 'failed' || task.waiting?.reason === 'checkpoint'));
}

/// What a comment will do if sent now, said under the box. For one to a
/// member, `piece` is their piece in the cell you opened, and `redo` whether
/// Redo is offered beside Send.
export function commentHint(
  task: Pick<TeamTask, 'status' | 'stageIndex' | 'stages'>,
  to?: { workerName: string; status?: string; redo?: boolean },
): string {
  if (task.status === 'proposed') return 'The coordinator will re-plan with this.';
  if (task.status === 'review' || task.status === 'done') return 'It goes to the team conversation, where the team answers it.';
  if (to) {
    if (to.status === 'running') return `${to.workerName} gets it at its next step${to.redo ? '; Redo starts the piece over with it' : ''}.`;
    if (to.status === 'done' && to.redo) return `Briefs ${to.workerName}'s next pieces; Redo replaces this piece.`;
    if (to.redo) return `Briefs ${to.workerName}'s next pieces; Redo starts this piece over with it.`;
    return `Briefs ${to.workerName}'s next pieces, and every later stage.`;
  }
  return 'Every later piece and the final pack are briefed with it.';
}

/// What a note to the coordinator does: it reads it at its next stage, and
/// so does every member after it.
export function coordinatorHint(task: Pick<TeamTask, 'status' | 'stageIndex' | 'stages'>): string {
  if (task.status === 'proposed') return 'The coordinator will re-plan with this.';
  if (task.status === 'review' || task.status === 'done') return 'It goes to the team conversation, where the coordinator answers it.';
  const next = task.stages.slice(task.stageIndex).find((s) => !isMemberStage(s.kind) && s.status !== 'done');
  return next ? `The coordinator reads it when it starts “${next.title}”, and every member after reads it too.` : 'Every later piece and the final pack are briefed with it.';
}

/// Where a quoted passage sits in a block of text, as [start, end) offsets
/// into `text`, ignoring whitespace: the rendered page splits a passage into
/// text nodes with no newlines between blocks, while a selection reads back
/// with them. Null when it isn't there (the file was rewritten since).
export function locateQuote(text: string, quote: string): [number, number] | null {
  const want = quote.replace(/\s+/g, '');
  if (!want) return null;
  let squeezed = '';
  const at: number[] = [];
  for (let i = 0; i < text.length; i++) {
    if (/\s/.test(text[i])) continue;
    squeezed += text[i];
    at.push(i);
  }
  const found = squeezed.indexOf(want);
  if (found < 0) return null;
  return [at[found], at[found + want.length - 1] + 1];
}
