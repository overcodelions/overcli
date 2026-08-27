// A participant keeps ONE conversation across all its steps, so an artifact
// it produced in step N is still sitting in the transcript when step N+1
// resumes. Re-inlining that artifact as an input pays for the same text a
// second time. These tests pin when the runtime references it instead —
// and, just as importantly, when it must not.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useTestHost } from '../testHost';

let userDataDir = '';
const { mockGetPath } = vi.hoisted(() => ({
  mockGetPath: vi.fn(() => userDataDir),
}));

useTestHost(mockGetPath);
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

const CONV = '11111111-1111-4111-8111-111111111111';
const PLAN_BODY = 'PLAN-BODY-SENTINEL: rewrite the parser.';

function makeRuntime(): FlowRuntimeImpl {
  return new FlowRuntimeImpl(
    { send: () => ({ ok: true }), prewarm: () => {}, dropIfPrewarmed: () => {} } as never,
    () => {},
    () => [],
    () => ({ backends: {} }) as never,
  );
}

/// A run where `plan` (participant `primary`) has already succeeded on
/// conversation CONV, and `build` — same participant — consumes `plan.md`.
function makeRun(over: Record<string, unknown> = {}): never {
  const base = {
    id: 'run-1',
    flowId: 'flow-1',
    projectPath: '/tmp/project',
    userPrompt: 'Rewrite the parser.',
    conversationIds: { primary: CONV },
    artifacts: {
      'plan.md': {
        name: 'plan.md',
        kind: 'markdown',
        body: PLAN_BODY,
        producedByStepId: 'plan',
        producedAt: 1,
      },
    },
    attempts: [{ stepId: 'plan', conversationId: CONV, startedAt: 1, outcome: 'success' }],
    flowSnapshot: {
      id: 'flow-1',
      name: 'Build flow',
      input: 'user_prompt',
      participants: [
        { id: 'primary', name: 'Primary', backend: 'claude', model: 'claude-sonnet-4-6', kind: 'primary' },
        { id: 'critic', name: 'Critic', backend: 'claude', model: 'claude-opus-4-6', kind: 'critic' },
      ],
      steps: [
        { id: 'plan', participantId: 'primary', role: 'planner', inputs: ['user_prompt'], tools: [], output: 'plan.md' },
        { id: 'build', participantId: 'primary', role: 'implementer', inputs: ['plan.md'], tools: [], output: 'diff' },
      ],
    },
    ...over,
  };
  return base as never;
}

function buildPrompt(runtime: FlowRuntimeImpl, run: unknown, stepId = 'build'): string {
  const step = (run as { flowSnapshot: { steps: Array<{ id: string }> } }).flowSnapshot.steps.find(
    (s) => s.id === stepId,
  );
  return (runtime as never as {
    buildStepPrompt: (r: unknown, s: unknown) => string;
  }).buildStepPrompt(run, step);
}

describe('self-produced step inputs', () => {
  beforeEach(() => {
    userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'overcli-recall-'));
  });
  afterEach(() => {
    fs.rmSync(userDataDir, { recursive: true, force: true });
  });

  it('references, rather than re-inlines, an artifact the participant wrote in this conversation', () => {
    const prompt = buildPrompt(makeRuntime(), makeRun());

    expect(prompt).not.toContain(PLAN_BODY);
    expect(prompt).toContain('recalled="true"');
    // Still declared as an input so the step's contract is unchanged.
    expect(prompt).toContain('<input name="plan.md"');
    // And recoverable: a compacted conversation can re-read the bytes.
    const match = /attached="([^"]+)"/.exec(prompt);
    expect(match).not.toBeNull();
    expect(fs.readFileSync(match![1], 'utf-8')).toBe(PLAN_BODY);
  });

  it('inlines normally when a DIFFERENT participant produced the artifact', () => {
    const run = makeRun();
    (run as never as { flowSnapshot: { steps: Array<{ id: string; participantId: string }> } })
      .flowSnapshot.steps[1].participantId = 'critic';
    (run as never as { conversationIds: Record<string, string> }).conversationIds.critic =
      '22222222-2222-4222-8222-222222222222';

    const prompt = buildPrompt(makeRuntime(), run);
    expect(prompt).toContain(PLAN_BODY);
    expect(prompt).not.toContain('recalled="true"');
  });

  it('inlines normally when the participant conversation was re-minted', () => {
    // Same participant, but its attempt ran on a conversation that is no
    // longer the one this step resumes — the transcript is gone.
    const run = makeRun({
      attempts: [
        { stepId: 'plan', conversationId: '33333333-3333-4333-8333-333333333333', startedAt: 1, outcome: 'success' },
      ],
    });
    const prompt = buildPrompt(makeRuntime(), run);
    expect(prompt).toContain(PLAN_BODY);
  });

  it('inlines normally on ollama, where each step gets a fresh conversation', () => {
    const run = makeRun();
    (run as never as { flowSnapshot: { participants: Array<{ backend: string; model: string }> } })
      .flowSnapshot.participants[0] = {
      ...(run as never as { flowSnapshot: { participants: Array<{ backend: string }> } }).flowSnapshot
        .participants[0],
      backend: 'ollama',
      model: 'gemma4:26b',
    } as never;

    const prompt = buildPrompt(makeRuntime(), run);
    expect(prompt).toContain(PLAN_BODY);
  });

  it('never recalls a diff — its body is re-derived from the worktree, not the model text', () => {
    const run = makeRun({
      artifacts: {
        diff: {
          name: 'diff',
          kind: 'diff',
          body: 'DIFF-BODY-SENTINEL',
          producedByStepId: 'plan',
          producedAt: 1,
        },
      },
    });
    (run as never as { flowSnapshot: { steps: Array<{ inputs: string[] }> } }).flowSnapshot.steps[1].inputs =
      ['diff'];

    const prompt = buildPrompt(makeRuntime(), run);
    expect(prompt).toContain('DIFF-BODY-SENTINEL');
    expect(prompt).not.toContain('recalled="true"');
  });

  it('does not recall an artifact from the step\'s own earlier attempt', () => {
    // A retry wants its failed attempt's output back in front of it as text.
    const run = makeRun({
      artifacts: {
        'plan.md': {
          name: 'plan.md',
          kind: 'markdown',
          body: PLAN_BODY,
          producedByStepId: 'build',
          producedAt: 1,
        },
      },
      attempts: [{ stepId: 'build', conversationId: CONV, startedAt: 1, outcome: 'success' }],
    });
    const prompt = buildPrompt(makeRuntime(), run);
    expect(prompt).toContain(PLAN_BODY);
  });
});
