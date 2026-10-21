import { describe, expect, it } from 'vitest';
import type { TeamAssignment, TeamComment, TeamStage, TeamTask } from '@shared/flows/team';
import {
  QUOTE_MAX,
  canRedoPiece,
  commentHint,
  commentOutcomeText,
  commentTopicLabel,
  commentsByMember,
  commentsByPiece,
  commentsOnFile,
  locateQuote,
  newestFirst,
  pieceKey,
  quoteFromSelection,
} from './commentView';

const comment = (id: string, extra: Partial<TeamComment> = {}): TeamComment => ({ id, at: 0, text: 'note', ...extra });
const piece = (workerId: string, extra: Partial<TeamAssignment> = {}): TeamAssignment => ({
  workerId,
  workerName: workerId[0].toUpperCase() + workerId.slice(1),
  ask: 'do it',
  status: 'done',
  ...extra,
});
const stage = (kind: TeamStage['kind'], assignments: TeamAssignment[], extra: Partial<TeamStage> = {}): TeamStage => ({
  kind,
  title: kind,
  assignments,
  status: 'done',
  ...extra,
});

describe('quoteFromSelection', () => {
  it('trims, folds spaces and drops blank lines', () => {
    expect(quoteFromSelection('  Acme   saves $40k \n\n\n  a year  ')).toBe('Acme saves $40k\na year');
  });
  it('cuts a long passage at a word, within the limit', () => {
    const q = quoteFromSelection('word '.repeat(400));
    expect(q.length).toBeLessThanOrEqual(QUOTE_MAX);
    expect(q.endsWith('word')).toBe(true);
  });
});

describe('commentOutcomeText', () => {
  it('says what came of it, naming the member where it matters', () => {
    expect(commentOutcomeText({ outcome: 'replanned' })).toBe('Re-planned with it');
    expect(commentOutcomeText({ outcome: 'steered', workerName: 'Wes' })).toBe('Sent to Wes while working');
    expect(commentOutcomeText({ outcome: 'asked' })).toBe('In the team conversation');
    expect(commentOutcomeText({ outcome: 'waiting' })).toBe('Goes to the team when it finishes answering');
    expect(commentOutcomeText({ outcome: 'queued' })).toBe('Briefs the next stages');
    expect(commentOutcomeText({ outcome: 'redo', workerName: 'Wes' })).toBe('Wes is redoing it');
    expect(commentOutcomeText({})).toBe('Briefs the next stages');
  });
});

describe('commentTopicLabel', () => {
  it('names the file, the questions, the plan or the member', () => {
    expect(commentTopicLabel(comment('a', { file: 'pieces/01-find-every-saving-wes.md', quote: 'x' }))).toBe('On 01-find-every-saving-wes.md');
    expect(commentTopicLabel(comment('b', { about: 'questions' }))).toBe('On the questions');
    expect(commentTopicLabel(comment('c', { about: 'plan' }))).toBe('On the plan');
    expect(commentTopicLabel(comment('d', { workerId: 'wes', workerName: 'Wes' }))).toBe('To Wes');
    expect(commentTopicLabel(comment('e'))).toBe('On the task');
  });
});

describe('grouping', () => {
  const list = [
    comment('a', { at: 1, file: 'one.md' }),
    comment('b', { at: 3, workerId: 'wes', workerName: 'Wes' }),
    comment('c', { at: 2, file: 'one.md', workerId: 'wes' }),
    comment('d', { at: 4, file: 'two.md' }),
  ];
  it('lists newest first without touching the original', () => {
    expect(newestFirst(list).map((c) => c.id)).toEqual(['d', 'b', 'c', 'a']);
    expect(list[0].id).toBe('a');
  });
  it('picks out one file, in order', () => {
    expect(commentsOnFile(list, 'one.md').map((c) => c.id)).toEqual(['a', 'c']);
    expect(commentsOnFile(undefined, 'one.md')).toEqual([]);
  });
  it('counts what was said to each member', () => {
    expect(commentsByMember(list).get('wes')).toBe(2);
  });
});

describe('commentsByPiece', () => {
  const stages = [
    stage('contribute', [piece('wes', { file: '01-wes.md' }), piece('ada')], { startedAt: 100 }),
    stage('challenge', [piece('wes')], { startedAt: 200, status: 'running' }),
    stage('respond', [piece('wes', { status: 'pending' })], { status: 'pending' }),
  ];
  it('puts a file comment on the piece that wrote it', () => {
    const m = commentsByPiece({ stages, comments: [comment('a', { file: '01-wes.md', at: 999 })] });
    expect(m.get(pieceKey(0, 'wes'))).toBe(1);
  });
  it('puts a comment to a member on the piece of the stage under way when it was said', () => {
    const m = commentsByPiece({
      stages,
      comments: [comment('a', { workerId: 'wes', at: 150 }), comment('b', { workerId: 'wes', at: 250 }), comment('c', { workerId: 'wes', at: 50 })],
    });
    expect(m.get(pieceKey(0, 'wes'))).toBe(2);
    expect(m.get(pieceKey(1, 'wes'))).toBe(1);
    expect(m.get(pieceKey(2, 'wes'))).toBeUndefined();
  });
  it('ignores comments with no member or piece file', () => {
    expect(commentsByPiece({ stages, comments: [comment('a', { about: 'plan' }), comment('b', { file: 'pack/PACK.md' })] }).size).toBe(0);
  });
});

describe('canRedoPiece', () => {
  const task = (extra: Partial<TeamTask> = {}) =>
    ({
      status: 'running',
      stageIndex: 1,
      stages: [stage('contribute', [piece('wes')]), stage('challenge', [piece('wes', { status: 'running' }), piece('ada', { status: 'pending' })], { status: 'running' }), stage('synthesize', [])],
      ...extra,
    }) as Pick<TeamTask, 'status' | 'stageIndex' | 'stages' | 'waiting'>;
  it('only in the current stage, for a piece that has begun', () => {
    expect(canRedoPiece(task(), 1, 'wes')).toBe(true);
    expect(canRedoPiece(task(), 0, 'wes')).toBe(false);
    expect(canRedoPiece(task(), 1, 'ada')).toBe(false);
    expect(canRedoPiece(task(), 1, 'nobody')).toBe(false);
  });
  it('while running, or stopped on a failure or checkpoint', () => {
    expect(canRedoPiece(task({ status: 'waiting', waiting: { reason: 'failed', message: '' } }), 1, 'wes')).toBe(true);
    expect(canRedoPiece(task({ status: 'waiting', waiting: { reason: 'budget', message: '' } }), 1, 'wes')).toBe(false);
    expect(canRedoPiece(task({ status: 'done' }), 1, 'wes')).toBe(false);
  });
});

describe('commentHint', () => {
  const base = { stageIndex: 0, stages: [] };
  it('says a plan waiting for approval is re-planned', () => {
    expect(commentHint({ ...base, status: 'proposed' })).toMatch(/re-plan/);
  });
  it('explains Send and Redo for a running or finished piece', () => {
    expect(commentHint({ ...base, status: 'running' }, { workerName: 'Wes', status: 'running', redo: true })).toBe(
      'Wes gets it at its next step; Redo starts the piece over with it.',
    );
    expect(commentHint({ ...base, status: 'running' }, { workerName: 'Wes', status: 'done', redo: true })).toBe(
      "Briefs Wes's next pieces; Redo replaces this piece.",
    );
  });
});

describe('locateQuote', () => {
  it('finds a passage across block breaks, ignoring whitespace', () => {
    const text = 'Savings# Cut the Acme seats40 unused.';
    const [s, e] = locateQuote(text, 'Cut the Acme seats\n\n40 unused')!;
    expect(text.slice(s, e)).toBe('Cut the Acme seats40 unused');
  });
  it('is null when the passage is gone', () => {
    expect(locateQuote('nothing here', 'Acme')).toBeNull();
    expect(locateQuote('anything', '   ')).toBeNull();
  });
});
