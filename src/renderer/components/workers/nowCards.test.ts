import { describe, expect, it } from 'vitest';
import type { FlowRun } from '@shared/flows/schema';
import type { StreamEvent } from '@shared/types';
import {
  currentConversationId,
  elapsedLabel,
  lastTalkedStep,
  latestExchange,
  workerDecisions,
  latestSaid,
  latestToolLine,
  priorConversationId,
  talkedSincePause,
  waitingLine,
} from './nowCards';

const assistant = (text: string, tools: Array<[string, object]> = []) =>
  ({
    kind: {
      type: 'assistant',
      info: { text, toolUses: tools.map(([name, input]) => ({ name, inputJSON: JSON.stringify(input) })) },
    },
  }) as unknown as StreamEvent;

describe('latestToolLine', () => {
  it('reads the newest tool call, skipping later text-only messages', () => {
    const events = [
      assistant('', [['Read', { file_path: '/a.md' }]]),
      assistant('', [['Bash', { command: 'npm test -- portal' }]]),
      assistant('Looking at the output now.'),
    ];
    expect(latestToolLine(events)).toBe('Bash · npm test -- portal');
  });

  it('names MCP tools by server and tool', () => {
    const line = latestToolLine([
      assistant('', [['mcp__claude_ai_Gmail__search_threads', { query: 'flight' }]]),
    ]);
    expect(line.startsWith('Gmail · search_threads')).toBe(true);
  });

  it('is empty with nothing to show', () => {
    expect(latestToolLine(undefined)).toBe('');
    expect(latestToolLine([assistant('hi')])).toBe('');
  });
});

describe('latestSaid', () => {
  it('returns the last thing said, flattened and trimmed', () => {
    expect(latestSaid([assistant('first'), assistant('Which   sandbox:\nstaging-2 or staging-4?')])).toBe(
      'Which sandbox: staging-2 or staging-4?',
    );
    expect(latestSaid([assistant('x'.repeat(300))], 20)).toHaveLength(20);
  });

  it('shows the question out of its protocol tag, and the asking sentence when it is long', () => {
    expect(latestSaid([assistant('Thinking.\n<worker_question>Deploy to staging-2?</worker_question>')])).toBe(
      'Deploy to staging-2?',
    );
    const long = `<worker_question>${'Context about the sweep. '.repeat(20)}Should I use staging-2 or staging-4?</worker_question>`;
    expect(latestSaid([assistant(long)])).toBe('Should I use staging-2 or staging-4?');
  });
});

describe('waitingLine', () => {
  it('names the waiting step and what to do about it', () => {
    expect(waitingLine('preStep', 'push')).toBe('Paused before “push” — check the work so far, then continue.');
    expect(waitingLine('externalAction', 'slack-dm')).toContain('acts outside the repo');
    expect(waitingLine(undefined, undefined)).toContain('the next step');
  });
});

describe('currentConversationId', () => {
  const run = (state: FlowRun['state']) =>
    ({
      state,
      flowSnapshot: { steps: [{ id: 'gather', participantId: 'p1' }, { id: 'hunt', participantId: 'p2' }] },
      conversationIds: { p1: 'conv-1', p2: 'conv-2' },
    }) as unknown as FlowRun;

  it('follows the step being run, or the one the run stopped in front of', () => {
    expect(currentConversationId(run({ kind: 'running', currentStepId: 'hunt' } as FlowRun['state']))).toBe('conv-2');
    expect(
      currentConversationId(run({ kind: 'paused', nextStepId: 'gather', reason: 'needsInput' } as FlowRun['state'])),
    ).toBe('conv-1');
    expect(currentConversationId(run({ kind: 'done', success: true }))).toBeUndefined();
  });

  it('finds the step before a pause, where the work being approved was done', () => {
    expect(
      priorConversationId(run({ kind: 'paused', nextStepId: 'hunt', reason: 'preStep' } as FlowRun['state'])),
    ).toBe('conv-1');
    expect(
      priorConversationId(run({ kind: 'paused', nextStepId: 'gather', reason: 'preStep' } as FlowRun['state'])),
    ).toBeUndefined();
    expect(priorConversationId(run({ kind: 'running', currentStepId: 'hunt' } as FlowRun['state']))).toBeUndefined();
  });
});

describe('elapsedLabel', () => {
  it('reads like a person would say it', () => {
    expect(elapsedLabel(10_000)).toBe('just now');
    expect(elapsedLabel(3 * 60_000)).toBe('3m');
    expect(elapsedLabel(80 * 60_000)).toBe('1h 20m');
    expect(elapsedLabel(120 * 60_000)).toBe('2h');
  });
});

describe('talking to a paused run', () => {
  const run = (over: Partial<FlowRun> = {}) =>
    ({
      state: { kind: 'paused', nextStepId: 'push', reason: 'preStep' },
      attempts: [
        { stepId: 'build', startedAt: 10, endedAt: 50 },
        { stepId: 'eval', startedAt: 60, endedAt: 100 },
      ],
      flowSnapshot: {
        steps: [
          { id: 'build', participantId: 'p1' },
          { id: 'eval', participantId: 'p2' },
          { id: 'push', participantId: 'p3' },
        ],
      },
      conversationIds: { p1: 'conv-build', p2: 'conv-eval' },
      ...over,
    }) as unknown as FlowRun;

  it('knows you have spoken to it since it stopped', () => {
    expect(talkedSincePause(run())).toBe(false);
    expect(talkedSincePause(run({ lastUserTurnAt: 90 }))).toBe(false);
    expect(talkedSincePause(run({ lastUserTurnAt: 150 }))).toBe(true);
  });

  it('finds the step whose conversation moved last after the pause', () => {
    const times: Record<string, number> = { 'conv-build': 120, 'conv-eval': 180 };
    expect(lastTalkedStep(run(), (c) => times[c] ?? 0)).toBe('eval');
    expect(lastTalkedStep(run(), () => 90)).toBeUndefined();
  });

  it('opens a shared conversation on the step of it that ran last', () => {
    // review and eval are both played by p2: talking to p2 after the pause
    // is talking to eval, the step that ran last and handed on its output.
    const shared = run({
      attempts: [
        { stepId: 'review', startedAt: 10, endedAt: 50 },
        { stepId: 'eval', startedAt: 60, endedAt: 100 },
      ],
      flowSnapshot: {
        steps: [
          { id: 'review', participantId: 'p2' },
          { id: 'eval', participantId: 'p2' },
          { id: 'push', participantId: 'p3' },
        ],
      },
      conversationIds: { p2: 'conv-claude' },
    } as unknown as Partial<FlowRun>);
    expect(lastTalkedStep(shared, () => 180)).toBe('eval');
  });
});

describe('the worker’s side of a question', () => {
  const run = (exchanges: object[], state: object = { kind: 'paused', nextStepId: 'gather', reason: 'needsInput' }) =>
    ({ state, workerExchanges: exchanges }) as unknown as FlowRun;
  const x = (stepId: string, status: string, extra = {}) => ({ id: `${stepId}-${status}`, stepId, status, question: 'q', ...extra });

  it('finds the latest exchange for the step the run stopped at', () => {
    const r = run([x('gather', 'answered', { answer: 'a' }), x('gather', 'escalated', { note: 'needs you' }), x('other', 'failed')]);
    expect(latestExchange(r)).toMatchObject({ status: 'escalated', note: 'needs you' });
    expect(latestExchange(run([x('other', 'escalated')]))).toBeUndefined();
    expect(latestExchange(run([x('gather', 'escalated')], { kind: 'done', success: true }))).toBeUndefined();
  });

  it('lists only the questions the worker actually answered', () => {
    const r = run([x('a', 'answered', { answer: 'yes' }), x('b', 'escalated'), x('c', 'answered')]);
    expect(workerDecisions(r).map((e) => e.stepId)).toEqual(['a']);
  });
});
