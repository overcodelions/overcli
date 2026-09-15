import { describe, expect, it } from 'vitest';

import type { Orchestration } from '@shared/flows/orchestration';
import type { FlowRun } from '@shared/flows/schema';
import {
  BLOCKING_AFTER_MS,
  NUDGE_AFTER_MS,
  attentionInbox,
  attentionLabel,
  attentionLevel,
  groupAttention,
  type AttentionSources,
} from './attentionInbox';
import { STALL_AFTER_MS } from './components/flows/runTriage';

const NOW = 1_000 * 60 * 60 * 24 * 400;
const MIN = 60 * 1000;

function run(id: string, overrides: Partial<FlowRun> = {}): FlowRun {
  return {
    id,
    flowId: 'flow',
    flowSnapshot: {
      id: 'flow',
      name: 'Solve a ticket',
      steps: [{ id: 'plan' }, { id: 'push' }],
      participants: [],
    },
    projectPath: '/repo',
    userPrompt: 'Acme lead forwarding broken',
    conversationIds: {},
    artifacts: {},
    state: { kind: 'paused', reason: 'externalAction', nextStepId: 'push' },
    createdAt: NOW - MIN,
    attempts: [],
    ...overrides,
  } as unknown as FlowRun;
}

function batch(id: string, overrides: Partial<Orchestration> = {}): Orchestration {
  return {
    id,
    title: 'Nightly sweep',
    projectPath: '/repo',
    maxConcurrent: 1,
    items: [{ status: 'proposed' }, { status: 'proposed' }, { status: 'running' }],
    createdAt: NOW - 5 * MIN,
    ...overrides,
  } as unknown as Orchestration;
}

function sources(over: Partial<AttentionSources> = {}): AttentionSources {
  return {
    runs: {},
    orchestrations: {},
    workers: {},
    funding: null,
    pendingHire: null,
    ...over,
  };
}

describe('attentionInbox', () => {
  it('is empty when nothing waits', () => {
    expect(attentionInbox(sources({ runs: { a: run('a', { state: { kind: 'running' } } as Partial<FlowRun>) } }), NOW)).toEqual([]);
  });

  it('collects every source, stopped runs first', () => {
    const items = attentionInbox(
      sources({
        runs: { r: run('r', { workerId: 'w1' } as Partial<FlowRun>) },
        orchestrations: {
          o: batch('o', { origin: { kind: 'schedule', scheduleId: 's', scheduleName: 'Nightly' } }),
          done: batch('done', { items: [{ status: 'done' }] } as unknown as Partial<Orchestration>),
        },
        workers: { w1: { id: 'w1', name: 'Triage', enabled: true } },
        funding: [
          { workerId: 'w1', blocked: 'pool' },
          { workerId: 'w2', blocked: 'cap' },
        ],
        pendingHire: { draft: { name: 'Sweeper' }, at: NOW - MIN },
      }),
      NOW,
    );
    expect(items.map((it) => it.key)).toEqual(['run:r', 'approval:o', 'hire', 'unfunded:w1']);
    expect(items[0]).toMatchObject({
      workerId: 'w1',
      reason: 'At push 2/2 · needs approval',
      urgent: true,
    });
    expect(items[1].reason).toBe('Nightly · 2 to approve');
  });

  it('drops runs paused long enough to count as stalled, matching the Flows badge', () => {
    const stale = run('s', { createdAt: NOW - STALL_AFTER_MS - 1 });
    expect(attentionInbox(sources({ runs: { s: stale } }), NOW)).toEqual([]);
  });

  it('attributes worker batches and names manual ones after the Orchestrator', () => {
    const items = attentionInbox(
      sources({
        orchestrations: {
          w: batch('w', { origin: { kind: 'worker', workerId: 'w1', workerName: 'Chief of Staff' } }),
          m: batch('m', { createdAt: NOW - 20 * MIN }),
        },
      }),
      NOW,
    );
    expect(items.map((it) => [it.key, it.workerId, it.reason])).toEqual([
      ['approval:m', null, 'Orchestrator · 2 to approve'],
      ['approval:w', 'w1', 'Chief of Staff · 2 to approve'],
    ]);
  });

  it('ignores an unfunded worker that is benched', () => {
    const items = attentionInbox(
      sources({
        workers: { w1: { id: 'w1', name: 'Triage', enabled: false } },
        funding: [{ workerId: 'w1', blocked: 'pool' }],
      }),
      NOW,
    );
    expect(items).toEqual([]);
  });
});

describe('attentionLevel', () => {
  const approvalAt = (at: number) =>
    attentionInbox(sources({ orchestrations: { o: batch('o', { createdAt: at }) } }), NOW);

  it('is null with nothing waiting', () => {
    expect(attentionLevel([], NOW)).toBeNull();
  });

  it('escalates with the oldest wait', () => {
    expect(attentionLevel(approvalAt(NOW - MIN), NOW)).toBe('calm');
    expect(attentionLevel(approvalAt(NOW - NUDGE_AFTER_MS), NOW)).toBe('waiting');
    expect(attentionLevel(approvalAt(NOW - BLOCKING_AFTER_MS), NOW)).toBe('blocking');
  });

  it('is blocking the moment a run needs an answer or approval, however fresh', () => {
    const items = attentionInbox(sources({ runs: { r: run('r', { createdAt: NOW }) } }), NOW);
    expect(attentionLevel(items, NOW)).toBe('blocking');
  });

  it('lets a run that paused where it was told to escalate on age like anything else', () => {
    const planned = (at: number) =>
      run('r', {
        createdAt: at,
        state: { kind: 'paused', reason: 'preStep', nextStepId: 'push' },
      } as Partial<FlowRun>);
    const fresh = attentionInbox(sources({ runs: { r: planned(NOW) } }), NOW);
    expect(fresh[0]).toMatchObject({ urgent: false, reason: 'At push 2/2 · paused before this step' });
    expect(attentionLevel(fresh, NOW)).toBe('calm');
    const old = attentionInbox(sources({ runs: { r: planned(NOW - BLOCKING_AFTER_MS) } }), NOW);
    expect(attentionLevel(old, NOW)).toBe('blocking');
  });
});

describe('groupAttention', () => {
  it('sections the tray by kind, in inbox order, with each section complete', () => {
    const items = attentionInbox(
      sources({
        runs: { a: run('a'), b: run('b') },
        orchestrations: { o: batch('o') },
        pendingHire: { draft: { name: 'Sweeper' }, at: NOW },
      }),
      NOW,
    );
    expect(groupAttention(items).map((g) => [g.title, g.items.length])).toEqual([
      ['Paused runs', 2],
      ['To approve', 1],
      ['Hires', 1],
    ]);
  });
});

describe('attentionLabel', () => {
  it('leads with the paused run when that is why it is amber', () => {
    const runs = { a: run('a'), b: run('b') };
    expect(attentionLabel(attentionInbox(sources({ runs: { a: runs.a } }), NOW))).toBe('Run paused');
    expect(attentionLabel(attentionInbox(sources({ runs }), NOW))).toBe('2 runs paused');
    expect(
      attentionLabel(
        attentionInbox(sources({ runs: { a: runs.a }, orchestrations: { o: batch('o') } }), NOW),
      ),
    ).toBe('Run paused · 2 need you');
  });

  it('counts everything else as needing you', () => {
    expect(attentionLabel(attentionInbox(sources({ orchestrations: { o: batch('o') } }), NOW))).toBe('1 needs you');
  });
});
