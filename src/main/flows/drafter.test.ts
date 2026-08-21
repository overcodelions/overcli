import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { AppSettings } from '../../shared/types';

const { mockQuery } = vi.hoisted(() => ({
  mockQuery: vi.fn(),
}));

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: mockQuery,
}));

// Drafter resolves which backends are healthy before picking one — stub it so
// tests are hermetic and always land on Claude (the SDK path the suite mocks).
vi.mock('../health', () => ({
  probeBackendHealth: vi.fn(async () => ({ kind: 'ready' })),
  healthyBackends: vi.fn(async () => new Set(['claude', 'codex', 'gemini', 'copilot', 'ollama'])),
}));

import { draftFlowFromPrompt, reviseFlowFromPrompt, type DraftDeps } from './drafter';

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

  it('un-gates a reviewer lens in a flow with nothing to gate', async () => {
    // A read-only audit: four lenses feed a report, no code is ever written.
    // Left gating, the security lens halts the run on exactly the shifts that
    // found something and the report never gets written.
    const audit = [
      'name: Release Audit',
      'input: user_prompt',
      'steps:',
      '  - id: lens-security',
      '    model: { backend: claude, model: claude-sonnet-4-6 }',
      '    role: security-reviewer',
      '    inputs: [user_prompt]',
      '    tools: [Read]',
      '    output: lens_security.md',
      '  - id: report',
      '    model: { backend: claude, model: claude-sonnet-4-6 }',
      '    role: technical-writer',
      '    inputs: [lens_security.md]',
      '    tools: [Read, Write]',
      '    output: report.md',
    ].join('\n');
    const oneShot = vi.fn().mockResolvedValue({ ok: true, text: audit });
    const deps: DraftDeps = {
      settings: {
        preferredBackend: 'claude',
        disabledBackends: {},
        backendPaths: {},
      } as unknown as AppSettings,
      runner: { oneShot } as unknown as DraftDeps['runner'],
    };

    const result = await draftFlowFromPrompt({ description: 'Audit the release' }, deps);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.flow.steps.find((s) => s.id === 'lens-security')?.verdictGate).toBe(false);
    }
  });

  it('leaves a reviewer gating when the flow can act on its verdict', async () => {
    const shipping = [
      'name: Fix And Ship',
      'input: user_prompt',
      'steps:',
      '  - id: build',
      '    model: { backend: claude, model: claude-sonnet-4-6 }',
      '    role: implementer',
      '    inputs: [user_prompt]',
      '    tools: [Read, Edit]',
      '    output: diff',
      '  - id: check',
      '    model: { backend: claude, model: claude-sonnet-4-6 }',
      '    role: code-reviewer',
      '    inputs: [diff]',
      '    tools: [Read]',
      '    output: review.md',
    ].join('\n');
    const oneShot = vi.fn().mockResolvedValue({ ok: true, text: shipping });
    const deps: DraftDeps = {
      settings: {
        preferredBackend: 'claude',
        disabledBackends: {},
        backendPaths: {},
      } as unknown as AppSettings,
      runner: { oneShot } as unknown as DraftDeps['runner'],
    };

    const result = await draftFlowFromPrompt({ description: 'Fix it and review' }, deps);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.flow.steps.find((s) => s.id === 'check')?.verdictGate).toBeUndefined();
    }
  });

  it('keeps plan-reviewer gating in a flow that writes no code', async () => {
    // The one reviewer whose whole job is to gate before code exists.
    const planning = [
      'name: Plan And Validate',
      'input: user_prompt',
      'steps:',
      '  - id: plan',
      '    model: { backend: claude, model: claude-sonnet-4-6 }',
      '    role: planner',
      '    inputs: [user_prompt]',
      '    tools: [Read]',
      '    output: plan.md',
      '  - id: judge',
      '    model: { backend: claude, model: claude-sonnet-4-6 }',
      '    role: plan-reviewer',
      '    inputs: [plan.md]',
      '    tools: [Read]',
      '    output: plan_review.md',
    ].join('\n');
    const oneShot = vi.fn().mockResolvedValue({ ok: true, text: planning });
    const deps: DraftDeps = {
      settings: {
        preferredBackend: 'claude',
        disabledBackends: {},
        backendPaths: {},
      } as unknown as AppSettings,
      runner: { oneShot } as unknown as DraftDeps['runner'],
    };

    const result = await draftFlowFromPrompt({ description: 'Plan it and check the plan' }, deps);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.flow.steps.find((s) => s.id === 'judge')?.verdictGate).toBeUndefined();
    }
  });

  it('budgets drafting on silence, not a flat wall clock', async () => {
    // `oneShot`'s 120s default cut healthy drafts off mid-YAML — the hire
    // drafter's second turn (a full flow draft on a frontier model) hit it
    // routinely and landed the user on a review screen with no flow.
    const oneShot = vi.fn().mockResolvedValue({ ok: true, text: validYaml('Slow Draft') });
    const deps: DraftDeps = {
      settings: {
        preferredBackend: 'claude',
        disabledBackends: {},
        backendPaths: {},
      } as unknown as AppSettings,
      runner: { oneShot } as unknown as DraftDeps['runner'],
    };

    await draftFlowFromPrompt({ description: 'Something long to design' }, deps);

    const call = oneShot.mock.calls[0][0];
    expect(call.idleTimeoutMs).toBeGreaterThan(0);
    expect(call.timeoutMs).toBeGreaterThan(120_000);
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

  /// Tags drafted by the model are only useful if they land in the same
  /// vocabulary the registry publishes — otherwise a drafted flow never
  /// shows up under the filter its user clicks.
  describe('tags', () => {
    function yamlWithTags(tags: string): string {
      return [
        '```yaml',
        'name: Tagged Flow',
        'input: user_prompt',
        `tags: ${tags}`,
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

    it('keeps tags drawn from the shared taxonomy', async () => {
      mockQuery.mockReturnValue(claudeStream(yamlWithTags('[review, tickets]')));

      const result = await draftFlowFromPrompt({ description: 'x' }, claudeDeps());

      expect(result.ok).toBe(true);
      if (result.ok) expect(result.flow.tags).toEqual(['review', 'tickets']);
    });

    it('drops invented tags rather than guessing at a mapping', async () => {
      mockQuery.mockReturnValue(claudeStream(yamlWithTags('[review, code-review, jira-triage]')));

      const result = await draftFlowFromPrompt({ description: 'x' }, claudeDeps());

      expect(result.ok).toBe(true);
      if (result.ok) expect(result.flow.tags).toEqual(['review']);
    });

    it('leaves tags undefined when nothing survives, so the YAML stays clean', async () => {
      mockQuery.mockReturnValue(claudeStream(yamlWithTags('[made-up, nonsense]')));

      const result = await draftFlowFromPrompt({ description: 'x' }, claudeDeps());

      expect(result.ok).toBe(true);
      if (result.ok) expect(result.flow.tags).toBeUndefined();
    });

    it('caps the list at four so a card stays scannable', async () => {
      mockQuery.mockReturnValue(
        claudeStream(yamlWithTags('[review, tickets, prs, design, research, testing]')),
      );

      const result = await draftFlowFromPrompt({ description: 'x' }, claudeDeps());

      expect(result.ok).toBe(true);
      if (result.ok) expect(result.flow.tags).toEqual(['review', 'tickets', 'prs', 'design']);
    });

    it('drafts without tags at all when the model omits the key', async () => {
      mockQuery.mockReturnValue(claudeStream(validYaml()));

      const result = await draftFlowFromPrompt({ description: 'x' }, claudeDeps());

      expect(result.ok).toBe(true);
      if (result.ok) expect(result.flow.tags).toBeUndefined();
    });
  });

  it('surfaces an error when no backend is signed in', async () => {
    const { healthyBackends } = await import('../health');
    vi.mocked(healthyBackends).mockResolvedValueOnce(new Set() as never);

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

/// Revising is the same call as drafting with the current flow in the prompt,
/// so these cover what's genuinely different: the id has to survive, and the
/// current YAML has to actually reach the CLI.
describe('reviseFlowFromPrompt', () => {
  beforeEach(() => {
    mockQuery.mockClear();
  });

  const CURRENT = [
    'name: Original',
    'input: user_prompt',
    'steps:',
    '  - id: plan',
    '    model: { backend: claude, model: claude-sonnet-4-6 }',
    '    role: planner',
    '    inputs: [user_prompt]',
    '    tools: [Read]',
    '    output: plan.md',
  ].join('\n');

  it('rejects an empty instruction or an empty flow', async () => {
    expect(
      await reviseFlowFromPrompt({ yaml: CURRENT, instruction: '  ' }, claudeDeps()),
    ).toMatchObject({ ok: false });
    expect(
      await reviseFlowFromPrompt({ yaml: '', instruction: 'add a step' }, claudeDeps()),
    ).toMatchObject({ ok: false });
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('keeps the caller\'s id even when the revision renames the flow', async () => {
    // The id is the filename on disk. Re-slugifying from the new name would
    // fork a second file on the next save instead of updating this flow.
    mockQuery.mockReturnValue(claudeStream(validYaml('Renamed Entirely')));

    const result = await reviseFlowFromPrompt(
      { yaml: CURRENT, instruction: 'rename it', id: 'my-existing-flow' },
      claudeDeps(),
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.flow.id).toBe('my-existing-flow');
      expect(result.flow.name).toBe('Renamed Entirely');
    }
  });

  it('sends the current flow and the instruction to the CLI', async () => {
    mockQuery.mockReturnValue(claudeStream(validYaml()));

    await reviseFlowFromPrompt(
      { yaml: CURRENT, instruction: 'add a security review' },
      claudeDeps(),
    );

    const prompt = mockQuery.mock.calls[0][0].prompt as string;
    expect(prompt).toContain('id: plan');
    expect(prompt).toContain('add a security review');
    const system = mockQuery.mock.calls[0][0].options.systemPrompt as string;
    expect(system).toContain('REVISION RULES');
  });

  it('routes a non-Claude backend through runner.oneShot with the revise prompt', async () => {
    const oneShot = vi.fn().mockResolvedValue({ ok: true, text: validYaml('Revised') });
    const deps: DraftDeps = {
      settings: {
        preferredBackend: 'codex',
        disabledBackends: {},
        backendPaths: {},
      } as unknown as AppSettings,
      runner: { oneShot } as unknown as DraftDeps['runner'],
    };

    const result = await reviseFlowFromPrompt(
      { yaml: CURRENT, instruction: 'drop the plan step' },
      deps,
    );

    expect(oneShot).toHaveBeenCalledTimes(1);
    expect(oneShot.mock.calls[0][0].prompt).toContain('REVISION RULES');
    expect(oneShot.mock.calls[0][0].prompt).toContain('drop the plan step');
    expect(result.ok).toBe(true);
  });

  it('falls back to a name-derived id when the caller has none', async () => {
    mockQuery.mockReturnValue(claudeStream(validYaml('Fresh Draft')));

    const result = await reviseFlowFromPrompt(
      { yaml: CURRENT, instruction: 'tweak it' },
      claudeDeps(),
    );

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.flow.id).toBe('fresh-draft');
  });
});

// ─── tier snapping ────────────────────────────────────────────────────────────

/// A drafted flow whose models are all real catalog ids but a generation
/// behind — the failure canonicalization and `liftMissingModel` both miss,
/// because nothing here is misspelled or retired.
function staleYaml(): string {
  return [
    '```yaml',
    'name: Stale Models',
    'input: user_prompt',
    'steps:',
    '  - id: plan',
    '    model: { backend: claude, model: claude-opus-4-8 }',
    '    role: planner',
    '    inputs: [user_prompt]',
    '    tools: [Read]',
    '    rebound:',
    '      critic: { backend: claude, model: claude-sonnet-4-6 }',
    '      mode: review',
    '      max_iters: 2',
    '    output: plan.md',
    '  - id: build',
    '    model: { backend: claude, model: claude-haiku-4-5 }',
    '    role: implementer',
    '    inputs: [plan.md]',
    '    tools: [Read, Edit]',
    '    output: build.md',
    '```',
  ].join('\n');
}

function depsWithDefaults(flowModelDefaults: AppSettings['flowModelDefaults']): DraftDeps {
  return {
    settings: {
      preferredBackend: 'claude',
      disabledBackends: {},
      backendPaths: {},
      claudeTransport: 'sdk',
      flowModelDefaults,
    } as unknown as AppSettings,
    runner: {} as DraftDeps['runner'],
  };
}

describe('drafted models snap to their tier default', () => {
  beforeEach(() => {
    mockQuery.mockClear();
  });

  it('rewrites stale-but-valid ids without changing the tier the drafter chose', async () => {
    mockQuery.mockReturnValue(claudeStream(staleYaml()));

    const result = await draftFlowFromPrompt({ description: 'Make a flow' }, claudeDeps());

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.flow.steps[0].model).toEqual({ backend: 'claude', model: 'claude-opus-5' });
    expect(result.flow.steps[0].rebound?.critic).toEqual({
      backend: 'claude',
      model: 'claude-sonnet-5',
    });
    // The implementer was on the fast tier and stays there — snapping fixes
    // which model a tier names, not the drafter's cost judgement.
    expect(result.flow.steps[1].model).toEqual({ backend: 'claude', model: 'claude-sonnet-5' });
  });

  it('snaps participants too, so the editor and the run agree', async () => {
    mockQuery.mockReturnValue(claudeStream(staleYaml()));

    const result = await draftFlowFromPrompt({ description: 'Make a flow' }, claudeDeps());

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.flow.participants.map((p) => p.model)).not.toContain('claude-opus-4-8');
    expect(result.flow.participants.map((p) => p.model)).not.toContain('claude-haiku-4-5');
  });

  it("honours the user's pin over the catalog", async () => {
    mockQuery.mockReturnValue(claudeStream(staleYaml()));

    const result = await draftFlowFromPrompt(
      { description: 'Make a flow' },
      depsWithDefaults({ claude: { fast: 'claude-haiku-4-5', thinking: 'claude-fable-5' } }),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.flow.steps[0].model).toEqual({ backend: 'claude', model: 'claude-fable-5' });
    expect(result.flow.steps[1].model).toEqual({ backend: 'claude', model: 'claude-haiku-4-5' });
  });

  it('tells the drafter the same models it will be snapped to', async () => {
    mockQuery.mockReturnValue(claudeStream(validYaml()));

    await draftFlowFromPrompt(
      { description: 'Make a flow' },
      depsWithDefaults({ claude: { fast: 'claude-haiku-4-5' } }),
    );

    const sys = mockQuery.mock.calls[0][0].options.systemPrompt as string;
    expect(sys).toContain('implementers + test-writers: { backend: claude, model: claude-haiku-4-5 }');
  });

  it('leaves a revision alone — an explicit model choice is the point', async () => {
    // Revise is told to preserve existing model picks, so snapping here would
    // undo "put the planner on Opus 4.8" using the user's own setting.
    mockQuery.mockReturnValue(claudeStream(staleYaml()));

    const result = await reviseFlowFromPrompt(
      { yaml: 'name: x', instruction: 'keep the models', id: 'stale-models' },
      claudeDeps(),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.flow.steps[0].model).toEqual({ backend: 'claude', model: 'claude-opus-4-8' });
  });
});

// ─── proven-flow exemplars ──────────────────────────────────────────────────

describe('proven flow exemplars', () => {
  beforeEach(() => {
    mockQuery.mockClear();
  });

  it('includes the proven-flows block in a draft when deps carry one', async () => {
    mockQuery.mockReturnValue(claudeStream(validYaml()));

    await draftFlowFromPrompt(
      { description: 'Make a flow' },
      { ...claudeDeps(), provenFlows: "PROVEN FLOWS IN THIS USER'S LIBRARY\n..." },
    );

    const sys = mockQuery.mock.calls[0][0].options.systemPrompt as string;
    expect(sys).toContain("PROVEN FLOWS IN THIS USER'S LIBRARY");
  });

  it('omits the proven-flows block when deps carry none', async () => {
    mockQuery.mockReturnValue(claudeStream(validYaml()));

    await draftFlowFromPrompt({ description: 'Make a flow' }, claudeDeps());

    const sys = mockQuery.mock.calls[0][0].options.systemPrompt as string;
    expect(sys).not.toContain('PROVEN FLOWS');
  });

  it('never surfaces the proven-flows block when revising', async () => {
    mockQuery.mockReturnValue(claudeStream(validYaml()));

    await reviseFlowFromPrompt(
      { yaml: validYaml('Original'), instruction: 'tweak it' },
      { ...claudeDeps(), provenFlows: "PROVEN FLOWS IN THIS USER'S LIBRARY\n..." },
    );

    const sys = mockQuery.mock.calls[0][0].options.systemPrompt as string;
    expect(sys).not.toContain('PROVEN FLOWS');
  });
});
