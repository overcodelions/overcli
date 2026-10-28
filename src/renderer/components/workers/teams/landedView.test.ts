import { describe, expect, it } from 'vitest';
import {
  canKeepDebating,
  defaultTaskTab,
  latestWrapUp,
  pendingChanges,
  replyCount,
  replyGist,
  repliesTo,
  unfoldedExchanges,
  yourTurn,
} from './landedView';
import type { TeamMessage, TeamTask } from '@shared/flows/team';

let ids = 0;
const msg = (exchange: number, speaker: TeamMessage['speaker'], text: string, extra: Partial<TeamMessage> = {}): TeamMessage => ({
  id: `m${++ids}`,
  speaker,
  text,
  at: 1_000 + ids,
  exchange,
  ...extra,
});
const you = { kind: 'you' } as const;
const mira = { kind: 'member', workerId: 'mira', name: 'Mira' } as const;
const lena = { kind: 'member', workerId: 'lena', name: 'Lena' } as const;
const coordinator = { kind: 'coordinator' } as const;

const WRAP = 'The plan holds.\n\n**Agreed:**\n- Ship v2.\n\n**Still open:**\n- Pricing — finance, by Friday\n\n**Worth changing in the pack:**\n- Add the risk table.\n- State the range.';

const task = (messages: TeamMessage[], extra: Partial<TeamTask> = {}): TeamTask =>
  ({
    id: 't',
    status: 'review',
    stages: [{ kind: 'synthesize', title: 'Pack', assignments: [], status: 'done' }],
    stageIndex: 0,
    pack: { summary: '', files: ['pack/A.md', 'pack/B.md'], version: 2, updatedAt: 500 },
    room: { messages, foldedThrough: 0 },
    ...extra,
  }) as unknown as TeamTask;

const debate = () => [
  msg(0, you, 'Is the plan safe?'),
  msg(0, mira, 'Mostly. The range matters.'),
  msg(0, lena, 'I agree with Mira, but the risk table is missing.'),
  msg(0, coordinator, WRAP, { wrapUp: true }),
];

describe('latestWrapUp and pendingChanges', () => {
  it('reads the latest wrap-up, and its changes until a pack update folds them in', () => {
    const t = task(debate());
    expect(latestWrapUp(t)).toMatchObject({ index: 3, folded: false, wrap: { bottomLine: 'The plan holds.' } });
    expect(pendingChanges(t)).toEqual(['Add the risk table.', 'State the range.']);
    const folded = task(debate(), { room: { messages: debate(), foldedThrough: 5 } });
    expect(latestWrapUp(folded)?.folded).toBe(true);
    expect(pendingChanges(folded)).toEqual([]);
  });

  it('skips a failed wrap-up, and one that does not read as one', () => {
    const t = task([msg(0, coordinator, WRAP, { wrapUp: true }), msg(1, coordinator, 'Just a note.', { wrapUp: true }), msg(2, coordinator, WRAP, { wrapUp: true, failed: true })]);
    expect(latestWrapUp(t)?.index).toBe(0);
    expect(latestWrapUp(task([]))).toBeNull();
  });
});

describe('counts', () => {
  it('counts replies, exchanges since the pack, and whether debate can go on', () => {
    const list = [...debate(), msg(1, you, 'And cost?'), msg(1, mira, 'Fine.', { failed: true })];
    const t = task(list, { room: { messages: list, foldedThrough: 1 } });
    expect(replyCount(list)).toBe(3);
    expect(unfoldedExchanges(t)).toBe(1);
    expect(canKeepDebating(t)).toBe(false);
    expect(canKeepDebating(task(debate()))).toBe(true);
    expect(canKeepDebating(task(debate(), { room: { messages: debate(), busy: { speaker: 'Mira', since: 1 } } }))).toBe(false);
  });
});

describe('defaultTaskTab', () => {
  it('opens on where it landed when nothing has been said since the wrap-up', () => {
    expect(defaultTaskTab(task(debate()), 4)).toBe('landed');
  });

  it('opens on the conversation only while someone answers; a question since still opens where it landed', () => {
    const busy = task(debate(), { room: { messages: debate(), busy: { speaker: 'Mira', since: 1 } } });
    expect(defaultTaskTab(busy, 4)).toBe('conversation');
    const after = [...debate(), msg(1, you, 'More?'), msg(1, mira, 'Yes, more.')];
    expect(defaultTaskTab(task(after), 4)).toBe('landed');
  });

  it('opens on the pack once a pack update came after everything said', () => {
    const list = [...debate(), msg(0, coordinator, 'Updated the pack (version 3).', { at: 9_999 })];
    expect(defaultTaskTab(task(list, { pack: { summary: '', files: [], version: 3, updatedAt: 9_999 } }), list.length)).toBe('pack');
    expect(defaultTaskTab(task([]), 0)).toBe('pack');
  });
});

describe('yourTurn', () => {
  it('opens the run of a piece stopped for you while the task runs', () => {
    const band = yourTurn(
      task([], {
        status: 'running',
        stageIndex: 0,
        stages: [
          {
            kind: 'contribute',
            title: 'Build',
            status: 'running',
            assignments: [{ workerId: 'w-hugo', workerName: 'Hugo', ask: '', status: 'paused', runId: 'run-1', waitingFor: 'wants your OK to use bash for "check"' }],
          },
        ],
      }),
    )!;
    expect(band.title).toBe('Your turn: Hugo is waiting on you');
    expect(band.detail).toBe('Hugo wants your OK to use bash for "check". The stage can’t finish until it goes on.');
    expect(band.actions).toEqual([{ id: 'openRun', label: 'Open Hugo’s run', primary: true }]);
    expect(band.run).toEqual({ runId: 'run-1', workerId: 'w-hugo' });
  });

  it('offers to add the agreed changes before review', () => {
    const band = yourTurn(task(debate()))!;
    expect(band.title).toBe('Your turn: the pack is ready to review');
    expect(band.detail).toBe('Version 2, 2 files. The team debated after it was built, and 2 changes they agreed on aren’t in it yet.');
    expect(band.actions.map((a) => [a.id, a.label, !!a.primary])).toEqual([
      ['addChanges', 'Add the 2 changes, then review', true],
      ['reviewPack', 'Review v2 as it is', false],
      ['keepDebating', 'Keep debating', false],
    ]);
    expect(band.changes).toEqual(['Add the risk table.', 'State the range.']);
  });

  it('offers only the review once the task continued in a new run', () => {
    const band = yourTurn(task(debate(), { continuedAs: { taskId: 'task-2', at: 1 } }))!;
    expect(band.detail).toBe('Version 2, 2 files. This task continued in a new run, where the team works now.');
    expect(band.actions).toEqual([{ id: 'reviewPack', label: 'Review v2', primary: true }]);
  });

  it('says review when the pack has everything, and nothing while someone answers or once filed', () => {
    const quiet = task([], { room: { messages: [] } });
    expect(yourTurn(quiet)?.actions).toEqual([{ id: 'reviewPack', label: 'Review v2', primary: true }]);
    expect(yourTurn(task(debate(), { room: { messages: debate(), busy: { speaker: 'Coordinator', since: 1 } } }))).toBeNull();
    expect(yourTurn(task(debate(), { status: 'done' }))).toBeNull();
  });

  it('asks for the questions, the plan, or what a waiting stage needs', () => {
    expect(yourTurn(task([], { status: 'questions', questions: ['a', 'b'] }))).toMatchObject({
      title: 'Your turn: the coordinator has 2 questions',
      actions: [{ id: 'answerQuestions', primary: true }],
    });
    const plan = yourTurn(
      task([], {
        status: 'proposed',
        stages: [
          { kind: 'contribute', title: 'A', status: 'pending', assignments: [{ workerId: 'm', workerName: 'Mira', ask: 'x', status: 'pending' }] },
          { kind: 'synthesize', title: 'B', status: 'pending', assignments: [] },
        ],
      } as Partial<TeamTask>),
    );
    expect(plan).toMatchObject({ title: 'Your turn: approve the plan', detail: '2 stages with 1 member. Nothing runs until you approve.' });
    expect(yourTurn(task([], { status: 'waiting', waiting: { reason: 'budget', message: 'Spent $5 of $5.' } } as Partial<TeamTask>))).toMatchObject({
      title: 'Your turn: the task reached its budget',
      detail: 'Spent $5 of $5.',
    });
    expect(yourTurn(task([], { status: 'waiting', waiting: { reason: 'away', message: 'Back at 9.' } } as Partial<TeamTask>))).toBeNull();
    expect(yourTurn(task([], { status: 'running' }))).toBeNull();
  });
});

describe('replyGist', () => {
  it('folds to the bold lead, or the first sentence', () => {
    expect(replyGist('**The 73% figure is an upper bound.** Being under plan proves nothing.\n\n- One\n- Two')).toEqual({
      gist: 'The 73% figure is an upper bound.',
      more: 2,
    });
    expect(replyGist('Accepts the range as stated. Dec 15 is the deadline. Jan 15 for the decision.')).toEqual({
      gist: 'Accepts the range as stated.',
      more: 2,
    });
  });

  it('has nothing more to show for a one-liner', () => {
    expect(replyGist('Same direction, less confidence.')).toEqual({ gist: 'Same direction, less confidence.', more: 0 });
  });
});

describe('repliesTo', () => {
  it('names teammates the reply mentions who spoke before it, else you for the first answer', () => {
    const list = debate();
    expect(repliesTo(list, 0)).toEqual([]);
    expect(repliesTo(list, 1)).toEqual(['you']);
    expect(repliesTo(list, 2)).toEqual(['Mira']);
    expect(repliesTo(list, 3)).toEqual(['everyone']);
  });

  it('says nothing when it cannot tell', () => {
    const list = [msg(0, you, 'q'), msg(0, mira, 'a'), msg(0, lena, 'Another angle entirely.')];
    expect(repliesTo(list, 2)).toEqual([]);
  });
});
