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
  it('puts the long run you are sitting in at the top, not at its launch time', () => {
    // The exact case that made this look broken: a run launched 90 minutes
    // ago that you have open right now, against chats typed since.
    const projects = [
      project('a', [
        conv('typed-30m-ago', { lastPromptAt: NOW - 30 * MIN, lastActiveAt: NOW - 30 * MIN }),
        conv('typed-5m-ago', { lastPromptAt: NOW - 5 * MIN, lastActiveAt: NOW - 5 * MIN }),
      ]),
    ];
    const openRun = run('open-run');

    expect(order(projects, [openRun], {}, {})[0]).toBe('typed-5m-ago');

    // Now open the run. It's what you're working on, so it leads.
    expect(
      order(projects, [openRun], {}, {
        openedRunId: 'open-run',
        lastOpenedAtByRun: { 'open-run': NOW },
      })[0],
    ).toBe('open-run');
  });

  it('keeps the chat you are reading on top while its agent works', () => {
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
    expect(order(projects, [], { watching: { isRunning: true } }, selection)[0]).toBe('watching');
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
    expect(rows).toContain('open');
    expect(rows[0]).toBe('open');
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
    expect(whileOpen[0]).toBe('red-6644');

    // Switched away — no longer open, still not "active". It must stay.
    const afterLeaving = order([project('a', busyChats)], [done], {}, {
      openedRunId: 'other-run',
      lastOpenedAtByRun: { 'red-6644': NOW - 30_000 },
    });
    expect(afterLeaving[0]).toBe('red-6644');
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
