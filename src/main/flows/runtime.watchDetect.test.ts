// A watch polls forever, so anything a tick carries is paid for forever.
// The DETECT tier — the cheap "has anyone commented?" look that runs every
// tick and posts nothing — must therefore run on a throwaway conversation:
// its prompt is self-contained, and sending it down the participant's
// conversation instead re-sent the whole flow transcript plus every prior
// tick's "nothing new" report, growing without bound.
//
// The ANSWER tier is the opposite case and must NOT change: it replies to a
// human, so it keeps the participant's conversation and stays grounded.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let userDataDir = '';
const { mockGetPath } = vi.hoisted(() => ({ mockGetPath: vi.fn(() => userDataDir) }));

vi.mock('electron', () => ({ app: { getPath: mockGetPath } }));
vi.mock('./runsStore', () => ({
  loadAllRuns: () => [],
  saveRun: vi.fn(),
  deleteRun: vi.fn(),
}));
vi.mock('./storage', () => ({ loadAllFlows: () => [] }));
vi.mock('./preflight', () => ({
  preflightRun: async () => ({ ok: true, problems: [] }),
  formatPreflight: () => '',
}));
vi.mock('../git', () => ({
  baseBranchExistsAsync: vi.fn(),
  createWorktreeAsync: vi.fn(),
  detectBaseBranchAsync: vi.fn(),
  removeWorktreeAsync: vi.fn(),
  runGit: () => ({ stdout: '', stderr: '', exitCode: 0 }),
  runGitAsync: async () => ({ stdout: '', stderr: '', exitCode: 0 }),
  worktreeNameTaken: () => false,
}));

import { FlowRuntimeImpl } from './runtime';

const RUN_ID = 'run-w1';
const PARTICIPANT_CONV = '11111111-1111-4111-8111-111111111111';

type Send = { conversationId: string; model: string; prompt: string };

function harness() {
  const sends: Send[] = [];
  const stopped: string[] = [];
  const runtime = new FlowRuntimeImpl(
    {
      send: (a: Send) => {
        sends.push(a);
        return { ok: true };
      },
      stop: (c: string) => stopped.push(c),
      prewarm: () => {},
      dropIfPrewarmed: () => {},
    } as never,
    () => {},
    () => [],
    () => ({ backends: {} }) as never,
  );

  const run = {
    id: RUN_ID,
    flowId: 'flow-1',
    projectPath: '/tmp/project',
    userPrompt: 'Fix the login bug.',
    conversationIds: { primary: PARTICIPANT_CONV },
    artifacts: {},
    attempts: [],
    flowSnapshot: {
      id: 'flow-1',
      name: 'Fix flow',
      input: 'user_prompt',
      participants: [
        {
          id: 'primary',
          name: 'Primary',
          backend: 'claude',
          model: 'claude-opus-4-6',
          kind: 'primary',
        },
      ],
      steps: [],
    },
    state: {
      kind: 'watching',
      watch: {
        sourceId: 'ai',
        binding: 'PR #12',
        participantId: 'primary',
        watchModel: 'claude-haiku-4-5-20251001',
        instructions: 'Watch PR #12 for review comments.',
        pollIntervalMs: 60_000,
        answered: 0,
        escalated: false,
      },
    },
  };
  (runtime as never as { runs: Map<string, unknown> }).runs.set(RUN_ID, run);

  const priv = runtime as never as {
    watchTick: (id: string) => Promise<void>;
    sendWatchAnswer: (id: string, detected: string) => void;
    finalizeWatchTick: (id: string, r: unknown) => void;
    watchDetectConv: Map<string, string>;
    convIdToRun: Map<string, string>;
  };
  return { runtime, run, sends, stopped, priv };
}

describe('watch detect tier', () => {
  beforeEach(() => {
    userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'overcli-watch-'));
  });
  afterEach(() => {
    fs.rmSync(userDataDir, { recursive: true, force: true });
  });

  it('ticks on a throwaway conversation, not the participant transcript', async () => {
    const { sends, priv } = harness();
    await priv.watchTick(RUN_ID);

    expect(sends).toHaveLength(1);
    expect(sends[0].conversationId).not.toBe(PARTICIPANT_CONV);
    // Still the cheap tier, and still the real detect prompt.
    expect(sends[0].model).toBe('claude-haiku-4-5-20251001');
    expect(sends[0].prompt).toContain('DETECT TICK');
    // Routable, so the reply reaches the tick buffer.
    expect(priv.convIdToRun.get(sends[0].conversationId)).toBe(RUN_ID);
  });

  it('uses a FRESH conversation each tick so cost stays flat', async () => {
    const { sends, priv } = harness();
    await priv.watchTick(RUN_ID);
    priv.finalizeWatchTick(RUN_ID, null);
    await priv.watchTick(RUN_ID);

    // A reused detect conversation would accumulate its own tick history and
    // reproduce exactly the unbounded growth this split removes.
    expect(sends).toHaveLength(2);
    expect(sends[0].conversationId).not.toBe(sends[1].conversationId);
  });

  it('releases the detect conversation when the tick ends', async () => {
    const { sends, stopped, priv } = harness();
    await priv.watchTick(RUN_ID);
    const detectConv = sends[0].conversationId;

    priv.finalizeWatchTick(RUN_ID, null);

    expect(priv.watchDetectConv.has(RUN_ID)).toBe(false);
    expect(priv.convIdToRun.has(detectConv)).toBe(false);
    expect(stopped).toContain(detectConv);
  });

  it('answers on the participant conversation, so replies stay grounded', async () => {
    const { sends, priv } = harness();
    await priv.watchTick(RUN_ID);
    priv.sendWatchAnswer(RUN_ID, 'Dave asked why the retry loop was removed.');

    const answer = sends[1];
    expect(answer.conversationId).toBe(PARTICIPANT_CONV);
    // The premium tier — NOT the cheap detect model.
    expect(answer.model).toBe('claude-opus-4-6');
    expect(answer.prompt).toContain('ANSWER TICK');
    // Escalating retires the throwaway conversation.
    expect(priv.watchDetectConv.has(RUN_ID)).toBe(false);
  });

  it('backs off instead of ticking when the participant has no conversation', async () => {
    const { run, sends, priv } = harness();
    // Nothing to escalate TO — a watch that can detect but never answer is
    // worse than one that waits.
    (run as { conversationIds: Record<string, string> }).conversationIds = {};

    await priv.watchTick(RUN_ID);
    expect(sends).toHaveLength(0);
  });
});
