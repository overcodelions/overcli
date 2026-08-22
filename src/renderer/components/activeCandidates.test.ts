// What feeds the sidebar's Active section. The rule under test: rows are
// ranked by what the USER last touched — typing in a chat or opening it —
// never by what a backend is doing on its own.

import { describe, expect, it } from 'vitest';

import { collectActiveCandidates } from './Sidebar';
import { selectActiveEntries } from '../activeSection';
import type { Conversation, Project, UUID } from '@shared/types';
import type { FlowRun } from '@shared/flows/schema';

const NOW = 1_700_000_000_000;
const MIN = 60_000;

function conv(id: string, overrides: Partial<Conversation> = {}): Conversation {
  return {
    id,
    name: id,
    createdAt: NOW - 60 * MIN,
    totalCostUSD: 0,
    turnCount: 1,
    currentModel: 'claude-opus-5',
    permissionMode: 'default',
    ...overrides,
  } as Conversation;
}

function project(name: string, conversations: Conversation[]): Project {
  return { id: name, name, path: `/repo/${name}`, conversations } as Project;
}

function run(id: string, overrides: Partial<FlowRun> = {}): FlowRun {
  return {
    id,
    flowId: 'f',
    flowSnapshot: { id: 'f', name: 'flow', steps: [], participants: [] },
    projectPath: '/repo/a',
    userPrompt: 'do the thing',
    conversationIds: {},
    artifacts: {},
    state: { kind: 'running' },
    createdAt: NOW - 90 * MIN,
    attempts: [],
    ...overrides,
  } as unknown as FlowRun;
}

const NO_SELECTION = {
  openedConversationId: null,
  lastSelectedAt: {} as Record<UUID, number>,
  openedRunId: null,
  lastOpenedAtByRun: {} as Record<string, number>,
};

const order = (projects: Project[], runs: FlowRun[], runners: any, selection: any) =>
  selectActiveEntries(
    collectActiveCandidates(
      projects,
      [],
      Object.fromEntries(runs.map((r) => [r.id, r])) as Record<UUID, FlowRun>,
      runners,
      { ...NO_SELECTION, ...selection },
      NOW,
    ),
    { now: NOW },
  ).map((c) => (c.entry.kind === 'flow' ? c.entry.run.id : c.entry.conv.id));

describe('collectActiveCandidates', () => {
  // A worker run lives at its worker's desk, not in the project's flow list.
  // Active is the exception, and only while the run is actually happening:
  // this section answers "what is going on right now", and a run nobody
  // started that is spending money is exactly that.
  it('shows a worker run while it is running, and drops it when it finishes', () => {
    const userRun = run('user-run', { createdAt: NOW - MIN });
    const working = run('worker-run', {
      workerId: 'worker-1',
      createdAt: NOW - 2 * MIN,
    } as Partial<FlowRun>);
    expect(order([project('a', [])], [userRun, working], {}, {})).toEqual([
      'user-run',
      'worker-run',
    ]);

    const finished = run('worker-run', {
      workerId: 'worker-1',
      createdAt: NOW - 2 * MIN,
      state: { kind: 'done' },
    } as Partial<FlowRun>);
    expect(order([project('a', [])], [userRun, finished], {}, {})).toEqual(['user-run']);
  });

  it('keeps a finished run in Active while it is still answering you', () => {
    // Hijack-chatting a run that has already completed streams turns through
    // its participant conversations. The row has to stay put mid-reply — for
    // a worker's run as much as your own.
    const streaming = { c1: { isRunning: true } };
    const workerRun = run('worker-run', {
      workerId: 'worker-1',
      state: { kind: 'done' },
      conversationIds: { writer: 'c1' },
      createdAt: NOW - 90 * MIN,
    } as unknown as Partial<FlowRun>);
    expect(order([project('a', [])], [workerRun], streaming, {})).toContain('worker-run');

    const userRun = run('user-run', {
      state: { kind: 'done' },
      conversationIds: { writer: 'c1' },
      createdAt: NOW - 90 * MIN,
    } as unknown as Partial<FlowRun>);
    expect(order([project('a', [])], [userRun], streaming, {})).toContain('user-run');
  });

  it('does not let a waking roster evict the worker run you have open', () => {
    const answering = run('answering', {
      workerId: 'w0',
      state: { kind: 'done' },
      conversationIds: { writer: 'c1' },
      createdAt: NOW - 90 * MIN,
    } as unknown as Partial<FlowRun>);
    const woken = [1, 2, 3, 4].map((n) =>
      run(`worker-${n}`, { workerId: `w${n}`, createdAt: NOW - n } as Partial<FlowRun>),
    );
    expect(
      order([project('a', [])], [answering, ...woken], { c1: { isRunning: true } }, {
        openedRunId: 'answering',
      }),
    ).toContain('answering');
  });

  it('keeps a worker run that is waiting on you', () => {
    const paused = run('worker-run', {
      workerId: 'worker-1',
      state: { kind: 'paused' },
    } as Partial<FlowRun>);
    expect(order([project('a', [])], [paused], {}, {})).toContain('worker-run');
  });

  it('does not let finished worker runs change the Active floor', () => {
    const projects = [project('a', [conv('chat', { lastPromptAt: NOW - MIN })])];
    const userRuns = [run('user-run', { createdAt: NOW - 2 * MIN })];
    const done = { kind: 'done' } as FlowRun['state'];
    const workerRuns = [
      run('worker-1', { workerId: 'worker-1', state: done } as Partial<FlowRun>),
      run('worker-2', { workerId: 'worker-2', state: done } as Partial<FlowRun>),
    ];
    expect(order(projects, [...userRuns, ...workerRuns], {}, {})).toEqual(order(projects, userRuns, {}, {}));
  });

  it('caps how many worker runs a waking roster can put in Active', () => {
    // Six workers firing at once must not evict the work you are doing.
    const workerRuns = [1, 2, 3, 4, 5, 6].map((n) =>
      run(`worker-${n}`, {
        workerId: `w${n}`,
        createdAt: NOW - n * MIN,
      } as Partial<FlowRun>),
    );
    const shown = order([project('a', [])], workerRuns, {}, {});
    expect(shown).toEqual(['worker-1', 'worker-2', 'worker-3']); // newest first
  });

  it('cannot evict the chat you are reading, however many workers wake up', () => {
    const chats = [1, 2, 3, 4, 5, 6].map((n) =>
      conv(`chat-${n}`, { lastPromptAt: NOW - n * MIN, lastActiveAt: NOW - n * MIN }),
    );
    const workerRuns = [1, 2, 3, 4, 5].map((n) =>
      run(`worker-${n}`, { workerId: `w${n}`, createdAt: NOW - n } as Partial<FlowRun>),
    );
    const shown = order([project('a', chats)], workerRuns, {}, {
      openedConversationId: 'chat-6' as UUID,
      lastSelectedAt: { 'chat-6': NOW } as Record<UUID, number>,
    });
    expect(shown).toContain('chat-6');
  });

  it('names a worker run after its worker, not its project', () => {
    const candidates = collectActiveCandidates(
      [project('a', [])],
      [],
      { r: run('r', { workerId: 'w1' } as Partial<FlowRun>) } as Record<UUID, FlowRun>,
      {},
      NO_SELECTION,
      NOW,
      { w1: { name: 'Chief of Staff' } },
    );
    const entry = candidates.find((c) => c.entry.kind === 'flow')!.entry;
    expect(entry).toMatchObject({ ownerKind: 'worker', ownerName: 'Chief of Staff' });
  });

  it('does not move a row when you open it', () => {
    // The reported bug: clicking a row in the Active section sent it to the
    // top, so the list reshuffled under the pointer. Opening earns the row a
    // slot; it must not change where that slot is.
    const projects = [
      project('a', [
        conv('typed-30m-ago', { lastPromptAt: NOW - 30 * MIN, lastActiveAt: NOW - 30 * MIN }),
        conv('typed-5m-ago', { lastPromptAt: NOW - 5 * MIN, lastActiveAt: NOW - 5 * MIN }),
      ]),
    ];
    const openRun = run('open-run');
    const before = order(projects, [openRun], {}, {});

    const afterClick = order(projects, [openRun], {}, {
      openedRunId: 'open-run',
      lastOpenedAtByRun: { 'open-run': NOW },
    });
    expect(afterClick).toEqual(before);

    const afterChatClick = order(projects, [openRun], {}, {
      openedConversationId: 'typed-30m-ago' as UUID,
      lastSelectedAt: { 'typed-30m-ago': NOW } as Record<UUID, number>,
    });
    expect(afterChatClick).toEqual(before);
  });

  it('keeps the chat you are reading in the section while its agent works', () => {
    const projects = [
      project('a', [
        conv('watching', { lastPromptAt: NOW - 20 * MIN, lastActiveAt: NOW - MIN }),
        conv('typed-later', { lastPromptAt: NOW - 10 * MIN, lastActiveAt: NOW - 10 * MIN }),
      ]),
    ];
    const selection = {
      openedConversationId: 'watching' as UUID,
      lastSelectedAt: { watching: NOW - 30_000 } as Record<UUID, number>,
    };
    // Ordered by the user's own turns, so the later-typed chat still leads.
    expect(order(projects, [], { watching: { isRunning: true } }, selection)).toEqual([
      'typed-later',
      'watching',
    ]);
  });

  it('never drops the open chat, however many backends are busy', () => {
    const busy = Array.from({ length: 12 }, (_, i) =>
      conv(`busy-${i}`, { lastPromptAt: NOW - (i + 1) * MIN, lastActiveAt: NOW }),
    );
    const open = conv('open', { lastPromptAt: NOW - 120 * MIN, lastActiveAt: NOW - 120 * MIN });
    const runners = Object.fromEntries(busy.map((c) => [c.id, { isRunning: true }]));
    const rows = order([project('a', [...busy, open])], [], runners, {
      openedConversationId: 'open' as UUID,
      lastSelectedAt: { open: NOW } as Record<UUID, number>,
    });
    // Kept despite the cap being full of busy chats — but at its own place in
    // the order (last typed in two hours ago), not hoisted to the top.
    expect(rows).toContain('open');
    expect(rows[rows.length - 1]).toBe('open');
  });

  it('keeps a finished run you were just in after you switch to another', () => {
    // Straight from the bug report: RED-6644 (done, last activity well
    // outside the liveness window) is open, you switch to another run, and
    // it vanished — five other things were active, so nothing was backfilled.
    const busyChats = Array.from({ length: 5 }, (_, i) =>
      conv(`busy-${i}`, { lastPromptAt: NOW - (40 + i) * MIN, lastActiveAt: NOW - MIN }),
    );
    const done = run('red-6644', {
      state: { kind: 'done' },
      createdAt: NOW - 120 * MIN,
      attempts: [{ stepId: 's', startedAt: NOW - 100 * MIN, endedAt: NOW - 90 * MIN }],
    } as Partial<FlowRun>);

    const whileOpen = order([project('a', busyChats)], [done], {}, {
      openedRunId: 'red-6644',
      lastOpenedAtByRun: { 'red-6644': NOW - 30_000 },
    });
    expect(whileOpen).toContain('red-6644');

    // Switched away — no longer open, still not "active". It must stay.
    const afterLeaving = order([project('a', busyChats)], [done], {}, {
      openedRunId: 'other-run',
      lastOpenedAtByRun: { 'red-6644': NOW - 30_000 },
    });
    expect(afterLeaving).toEqual(whileOpen);
  });

  it('ignores backend progress: a run advancing steps does not move its row', () => {
    const projects = [
      project('a', [conv('mine', { lastPromptAt: NOW - MIN, lastActiveAt: NOW - MIN })]),
    ];
    const quiet = run('r', { attempts: [] });
    const advanced = run('r', {
      // Ten steps' worth of runtime activity, all of it after the user's turn.
      attempts: Array.from({ length: 10 }, (_, i) => ({
        stepId: `s${i}`,
        startedAt: NOW - 30_000,
        endedAt: NOW,
        conversationId: 'c',
      })),
    });
    expect(order(projects, [quiet], {}, {})[0]).toBe('mine');
    expect(order(projects, [advanced], {}, {})[0]).toBe('mine');
  });
});
