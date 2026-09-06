import { describe, expect, it } from 'vitest';
import type { Conversation } from '@shared/types';
import type { FlowRun } from '@shared/flows/schema';
import { DEFAULT_CLEANUP_RULES } from '@shared/cleanupRules';
import { estimateTidyCandidates } from './cleanupNudge';

const DAY = 24 * 60 * 60 * 1000;
const NOW = 1_700_000_000_000;

const conv = (over: Partial<Conversation> & { id: string }): Conversation =>
  ({
    name: 'Chat',
    createdAt: NOW,
    totalCostUSD: 0,
    turnCount: 0,
    currentModel: '',
    permissionMode: 'default',
    ...over,
  }) as Conversation;

const run = (over: Partial<FlowRun> & { id: string }): FlowRun =>
  ({
    flowId: 'audit',
    flowSnapshot: { name: 'Audit' },
    projectPath: '/proj',
    userPrompt: 'go',
    conversationIds: {},
    artifacts: {},
    state: { kind: 'done', success: true },
    createdAt: NOW - 60 * DAY,
    attempts: [],
    ...over,
  }) as unknown as FlowRun;

const base = { rules: { ...DEFAULT_CLEANUP_RULES, keepPerProducer: 0 }, now: NOW };

describe('estimateTidyCandidates', () => {
  it('counts idle worktrees past the age threshold', () => {
    const count = estimateTidyCandidates({
      ...base,
      owners: [
        {
          conversations: [
            conv({ id: 'a', worktreePath: '/wt/a', lastActiveAt: NOW - 30 * DAY }),
            conv({ id: 'b', worktreePath: '/wt/b', lastActiveAt: NOW - DAY }),
          ],
        },
      ],
      runs: [],
      runningById: {},
    });
    expect(count).toBe(1);
  });

  it('ignores conversations without a worktree', () => {
    const count = estimateTidyCandidates({
      ...base,
      owners: [{ conversations: [conv({ id: 'a', lastActiveAt: NOW - 90 * DAY })] }],
      runs: [],
      runningById: {},
    });
    expect(count).toBe(0);
  });

  it('ignores a conversation that is streaming', () => {
    const count = estimateTidyCandidates({
      ...base,
      owners: [
        { conversations: [conv({ id: 'a', worktreePath: '/wt/a', lastActiveAt: NOW - 90 * DAY })] },
      ],
      runs: [],
      runningById: { a: true },
    });
    expect(count).toBe(0);
  });

  it('counts a run tree once, not again through the conversation on it', () => {
    const count = estimateTidyCandidates({
      ...base,
      owners: [
        { conversations: [conv({ id: 'a', worktreePath: '/wt/r1', lastActiveAt: NOW - 90 * DAY })] },
      ],
      runs: [run({ id: 'r1', worktreePath: '/wt/r1' })],
      runningById: {},
    });
    expect(count).toBe(1);
  });

  it('ignores runs that are still working', () => {
    const count = estimateTidyCandidates({
      ...base,
      owners: [],
      runs: [
        run({ id: 'r1', worktreePath: '/wt/r1', state: { kind: 'running', currentStepId: 's' } }),
        run({
          id: 'r2',
          worktreePath: '/wt/r2',
          state: { kind: 'paused', nextStepId: 's', reason: 'needsInput' },
        }),
      ],
      runningById: {},
    });
    expect(count).toBe(0);
  });

  it('respects the keep-the-newest-few rule per producer', () => {
    const runs = [0, 1, 2, 3].map((i) =>
      run({
        id: `r${i}`,
        worktreePath: `/wt/r${i}`,
        workerId: 'w1',
        createdAt: NOW - (30 + i) * DAY,
      }),
    );
    const count = estimateTidyCandidates({
      ...base,
      rules: { ...DEFAULT_CLEANUP_RULES, keepPerProducer: 3 },
      owners: [],
      runs,
      runningById: {},
    });
    expect(count).toBe(1);
  });

  it('says nothing when auto-tidy is off', () => {
    const count = estimateTidyCandidates({
      ...base,
      rules: { ...DEFAULT_CLEANUP_RULES, retireAfterDays: 0 },
      owners: [
        { conversations: [conv({ id: 'a', worktreePath: '/wt/a', lastActiveAt: NOW - 90 * DAY })] },
      ],
      runs: [],
      runningById: {},
    });
    expect(count).toBe(0);
  });

  it('never counts a borrowed worktree — the row does not own it', () => {
    const count = estimateTidyCandidates({
      ...base,
      owners: [
        {
          conversations: [
            conv({
              id: 'a',
              worktreePath: '/wt/a',
              adoptedWorktree: true,
              lastActiveAt: NOW - 90 * DAY,
            }),
          ],
        },
      ],
      runs: [],
      runningById: {},
    });
    expect(count).toBe(0);
  });
});
