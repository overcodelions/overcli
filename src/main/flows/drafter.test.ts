import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { AppSettings } from '../../shared/types';

const { mockQuery } = vi.hoisted(() => ({
  mockQuery: vi.fn(),
}));

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: mockQuery,
}));

// Drafter resolves a backend via probeBackendHealth — stub it so tests are
// hermetic and always land on Claude (the SDK path the suite mocks).
vi.mock('../health', () => ({
  probeBackendHealth: vi.fn(() => ({ kind: 'ready' })),
}));

import { draftFlowFromPrompt, type DraftDeps } from './drafter';

/// Deps that route the drafter to the mocked Claude SDK path. The runner is
/// never touched when the backend resolves to Claude, so a stub suffices.
function claudeDeps(): DraftDeps {
  return {
    settings: {
      preferredBackend: 'claude',
      disabledBackends: {},
      backendPaths: {},
    } as unknown as AppSettings,
    runner: {} as DraftDeps['runner'],
  };
}

function claudeStream(text: string) {
  return (async function* () {
    yield {
      type: 'assistant',
      message: {
        content: [
          {
            type: 'text',
            text,
          },
        ],
      },
    };
    yield { type: 'result' };
  })();
}

function validYaml(name = 'Solve a Ticket!'): string {
  return [
    '```yaml',
    `name: ${name}`,
    'input: user_prompt',
    'steps:',
    '  - id: plan',
    '    model: { backend: claude, model: claude-sonnet-4-6 }',
    '    role: planner',
    '    inputs: [user_prompt]',
    '    tools: [Read]',
    '    output: plan.md',
    '```',
  ].join('\n');
}

describe('draftFlowFromPrompt', () => {
  beforeEach(() => {
    mockQuery.mockClear();
  });

  it('rejects an empty description without calling Claude', async () => {
    const result = await draftFlowFromPrompt({ description: '   ' }, claudeDeps());

    expect(result).toEqual({ ok: false, error: 'Description is empty.' });
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('strips code fences and slugifies the drafted flow name', async () => {
    mockQuery.mockReturnValue(claudeStream(validYaml()));

    const result = await draftFlowFromPrompt({ description: 'Make a flow' }, claudeDeps());

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.flow.id).toBe('solve-a-ticket');
      expect(result.flow.name).toBe('Solve a Ticket!');
      expect(result.flow.steps).toHaveLength(1);
    }
  });

  it('returns a validation error when Claude drafts an invalid flow', async () => {
    mockQuery.mockReturnValue(
      claudeStream([
        '```yaml',
        'name: Invalid Flow',
        'input: user_prompt',
        'steps: []',
        '```',
      ].join('\n')),
    );

    const result = await draftFlowFromPrompt({ description: 'Make a bad flow' }, claudeDeps());

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('failed validation');
      expect(result.error).toContain('steps');
    }
  });

  it('routes a non-Claude preferred backend through runner.oneShot', async () => {
    const oneShot = vi.fn().mockResolvedValue({ ok: true, text: validYaml('Codex Drafted') });
    const deps: DraftDeps = {
      settings: {
        preferredBackend: 'codex',
        disabledBackends: {},
        backendPaths: {},
      } as unknown as AppSettings,
      runner: { oneShot } as unknown as DraftDeps['runner'],
    };

    const result = await draftFlowFromPrompt({ description: 'Build via Codex' }, deps);

    expect(oneShot).toHaveBeenCalledTimes(1);
    expect(oneShot.mock.calls[0][0]).toMatchObject({ backend: 'codex', model: 'gpt-5.5' });
    expect(mockQuery).not.toHaveBeenCalled();
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.flow.name).toBe('Codex Drafted');
  });

  it('surfaces an error when no backend is signed in', async () => {
    const { probeBackendHealth } = await import('../health');
    vi.mocked(probeBackendHealth).mockReturnValueOnce({ kind: 'missing' } as never);
    vi.mocked(probeBackendHealth).mockReturnValue({ kind: 'unauthenticated' } as never);

    const result = await draftFlowFromPrompt({ description: 'anything' }, {
      settings: {
        preferredBackend: undefined,
        disabledBackends: {},
        backendPaths: {},
      } as unknown as AppSettings,
      runner: {} as DraftDeps['runner'],
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('No CLI is signed in');
  });
});
