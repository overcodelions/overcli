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

/// Deps that route the drafter to the mocked Claude SDK path. The SDK path is
/// only taken when the experimental SDK transport is enabled, so these deps
/// opt in via claudeTransport: 'sdk'. The runner is never touched on this
/// path, so a stub suffices.
function claudeDeps(): DraftDeps {
  return {
    settings: {
      preferredBackend: 'claude',
      disabledBackends: {},
      backendPaths: {},
      claudeTransport: 'sdk',
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

  it('repairs near-miss output names and rewires input refs', async () => {
    mockQuery.mockReturnValue(
      claudeStream([
        '```yaml',
        'name: Audit Flow',
        'input: user_prompt',
        'steps:',
        '  - id: pull',
        '    model: { backend: claude, model: claude-sonnet-4-6 }',
        '    role: researcher',
        '    inputs: [user_prompt]',
        '    tools: [Read]',
        '    output: zendesk metrics',
        '  - id: report',
        '    model: { backend: claude, model: claude-sonnet-4-6 }',
        '    role: reviewer',
        '    inputs: [zendesk metrics]',
        '    tools: [Read]',
        '    output: audit report',
        '```',
      ].join('\n')),
    );

    const result = await draftFlowFromPrompt({ description: 'Audit tickets' }, claudeDeps());

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.flow.steps[0].output).toBe('zendesk_metrics');
      expect(result.flow.steps[1].output).toBe('audit_report');
      // The downstream input ref tracked the renamed output.
      expect(result.flow.steps[1].inputs).toEqual(['zendesk_metrics']);
    }
  });

  it('keeps a drafted custom step with its own system prompt', async () => {
    mockQuery.mockReturnValue(
      claudeStream([
        '```yaml',
        'name: Triage Flow',
        'input: user_prompt',
        'steps:',
        '  - id: triage',
        '    model: { backend: claude, model: claude-sonnet-4-6 }',
        '    role: custom',
        '    system_prompt: |',
        '      You are the TRIAGE step of a multi-stage automated flow.',
        '      Group the incoming reports by root cause. You are READ-ONLY.',
        '    inputs: [user_prompt]',
        '    tools: [Read]',
        '    output: triage.md',
        '```',
      ].join('\n')),
    );

    const result = await draftFlowFromPrompt({ description: 'Triage bugs' }, claudeDeps());

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.flow.steps[0].role).toBe('custom');
      expect(result.flow.steps[0].systemPromptOverride).toContain('TRIAGE step');
    }
  });

  it('flips a step to custom when a system prompt lands under a preset role', async () => {
    // The prompt is the more specific signal: resolveSystemPrompt would drop
    // it on a preset role and silently run the preset body instead.
    mockQuery.mockReturnValue(
      claudeStream([
        '```yaml',
        'name: Narrow Review',
        'input: user_prompt',
        'steps:',
        '  - id: a11y',
        '    model: { backend: claude, model: claude-sonnet-4-6 }',
        '    role: reviewer',
        '    system_prompt: Review the diff ONLY for accessibility regressions.',
        '    inputs: [user_prompt]',
        '    tools: [Read]',
        '    output: a11y.md',
        '```',
      ].join('\n')),
    );

    const result = await draftFlowFromPrompt({ description: 'a11y review' }, claudeDeps());

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.flow.steps[0].role).toBe('custom');
      expect(result.flow.steps[0].systemPromptOverride).toContain('accessibility');
    }
  });

  it('rescues an invented role name that carries a system prompt', async () => {
    mockQuery.mockReturnValue(
      claudeStream([
        '```yaml',
        'name: Summary Flow',
        'input: user_prompt',
        'steps:',
        '  - id: sum',
        '    model: { backend: claude, model: claude-sonnet-4-6 }',
        '    role: summarizer',
        '    system_prompt: Summarize the input logs into a short digest.',
        '    inputs: [user_prompt]',
        '    tools: [Read]',
        '    output: digest.md',
        '```',
      ].join('\n')),
    );

    const result = await draftFlowFromPrompt({ description: 'summarize logs' }, claudeDeps());

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.flow.steps[0].role).toBe('custom');
  });

  it('rejects an unknown role with no system prompt to recover it from', async () => {
    mockQuery.mockReturnValue(
      claudeStream([
        '```yaml',
        'name: Typo Flow',
        'input: user_prompt',
        'steps:',
        '  - id: review',
        '    model: { backend: claude, model: claude-sonnet-4-6 }',
        '    role: reviewr',
        '    inputs: [user_prompt]',
        '    tools: [Read]',
        '    output: review.md',
        '```',
      ].join('\n')),
    );

    const result = await draftFlowFromPrompt({ description: 'review it' }, claudeDeps());

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('Unknown role "reviewr"');
  });

  it('drafts Claude through runner.oneShot on the default cli transport', async () => {
    const oneShot = vi.fn().mockResolvedValue({ ok: true, text: validYaml('CLI Drafted') });
    const deps: DraftDeps = {
      settings: {
        preferredBackend: 'claude',
        disabledBackends: {},
        backendPaths: {},
        // no claudeTransport → defaults to 'cli', so drafting must NOT use the SDK
      } as unknown as AppSettings,
      runner: { oneShot } as unknown as DraftDeps['runner'],
    };

    const result = await draftFlowFromPrompt({ description: 'Build via Claude' }, deps);

    expect(oneShot).toHaveBeenCalledTimes(1);
    expect(oneShot.mock.calls[0][0]).toMatchObject({ backend: 'claude' });
    expect(mockQuery).not.toHaveBeenCalled();
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.flow.name).toBe('CLI Drafted');
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
    expect(oneShot.mock.calls[0][0]).toMatchObject({ backend: 'codex', model: 'gpt-5.6-sol' });
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
