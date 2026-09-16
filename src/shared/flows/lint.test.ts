import { describe, expect, it } from 'vitest';

import { lintFlow, optimizeInstructionFor, type FlowLintWarning } from './lint';
import type { Flow, FlowParticipant, FlowStep } from './schema';

function participant(overrides: Partial<FlowParticipant> = {}): FlowParticipant {
  return { id: 'primary', name: 'Primary', backend: 'claude', model: 'claude-sonnet-5', ...overrides };
}

function step(overrides: Partial<FlowStep> = {}): FlowStep {
  return {
    id: 'plan',
    participantId: 'primary',
    role: 'planner',
    inputs: ['user_prompt'],
    tools: ['Read'],
    output: 'plan.md',
    ...overrides,
  };
}

function flow(steps: FlowStep[], participants: FlowParticipant[] = [participant()]): Flow {
  return {
    id: 'test-flow',
    name: 'Test Flow',
    input: 'user_prompt',
    participants,
    steps,
    source: 'user',
    filePath: '/tmp/test-flow.yaml',
  };
}

const rules = (f: Flow) => lintFlow(f).map((w) => w.rule);

describe('lintFlow — discarded output', () => {
  it('flags a step that overwrites an artifact it never reads', () => {
    const warnings = lintFlow(
      flow([
        step({ id: 'report', role: 'technical-writer', inputs: ['user_prompt'], output: 'report.md' }),
        step({ id: 'report-brief', role: 'technical-writer', inputs: ['user_prompt'], output: 'report.md' }),
      ]),
    );
    expect(warnings).toHaveLength(1);
    expect(warnings[0].rule).toBe('discarded-output');
    expect(warnings[0].path).toBe('steps[1].output');
    expect(warnings[0].message).toContain('"report-brief" overwrites "report.md" from step "report"');
  });

  it('stays silent when the later step extends the artifact it rewrites', () => {
    expect(
      rules(
        flow([
          step({ id: 'build', role: 'implementer', inputs: ['user_prompt'], output: 'diff' }),
          step({ id: 'tests', role: 'test-writer', inputs: ['user_prompt', 'diff'], output: 'diff' }),
        ]),
      ),
    ).toEqual([]);
  });

  it('stays silent when every step writes a distinct artifact', () => {
    expect(
      rules(
        flow([
          step({ id: 'plan', output: 'plan.md' }),
          step({ id: 'build', role: 'implementer', inputs: ['user_prompt', 'plan.md'], output: 'diff' }),
        ]),
      ),
    ).toEqual([]);
  });

  it('blames the immediate predecessor when an artifact is rewritten repeatedly', () => {
    const warnings = lintFlow(
      flow([
        step({ id: 'a', output: 'report.md' }),
        step({ id: 'b', output: 'report.md' }),
        step({ id: 'c', output: 'report.md' }),
      ]),
    );
    expect(warnings).toHaveLength(2);
    expect(warnings[0].message).toContain('from step "a"');
    expect(warnings[1].message).toContain('from step "b"');
  });
});

describe('lintFlow — model tier', () => {
  const opus = participant({ id: 'big', model: 'claude-opus-5' });

  it('flags a multi-step flow where every step is top tier', () => {
    const warnings = lintFlow(
      flow(
        [
          step({ id: 'plan', participantId: 'big', output: 'plan.md' }),
          step({ id: 'build', participantId: 'big', role: 'implementer', output: 'diff' }),
        ],
        [opus],
      ),
    );
    expect(warnings.map((w) => w.rule)).toEqual(['all-steps-top-tier']);
    expect(warnings[0].message).toContain('All 2 steps');
  });

  it('does not flag a single-step flow on the top tier', () => {
    expect(rules(flow([step({ participantId: 'big' })], [opus]))).toEqual([]);
  });

  it('flags a mechanical role on the top tier', () => {
    const warnings = lintFlow(
      flow(
        [
          step({ id: 'plan', output: 'plan.md' }),
          step({
            id: 'write',
            participantId: 'big',
            role: 'technical-writer',
            inputs: ['user_prompt', 'plan.md'],
            output: 'report.md',
          }),
        ],
        [participant(), opus],
      ),
    );
    expect(warnings.map((w) => w.rule)).toEqual(['mechanical-step-top-tier']);
    expect(warnings[0].path).toBe('steps[1].model');
  });

  it('does not flag a reasoning role on the top tier', () => {
    expect(
      rules(
        flow(
          [
            step({ id: 'plan', output: 'plan.md' }),
            step({
              id: 'debug',
              participantId: 'big',
              role: 'debugger',
              inputs: ['user_prompt', 'plan.md'],
              output: 'cause.md',
            }),
          ],
          [participant(), opus],
        ),
      ),
    ).toEqual([]);
  });

  it('never judges a custom role on tier — only its prompt says what it does', () => {
    expect(
      rules(
        flow(
          [
            step({ id: 'plan', output: 'plan.md' }),
            step({
              id: 'custom-step',
              participantId: 'big',
              role: 'custom',
              systemPromptOverride: 'Summarise the plan.',
              inputs: ['user_prompt', 'plan.md'],
              output: 'summary.md',
            }),
          ],
          [participant(), opus],
        ),
      ),
    ).toEqual([]);
  });

  it('reports the flow-wide warning instead of repeating it per step', () => {
    const warnings = lintFlow(
      flow(
        [
          step({ id: 'a', role: 'technical-writer', participantId: 'big', output: 'a.md' }),
          step({ id: 'b', role: 'technical-writer', participantId: 'big', output: 'b.md' }),
        ],
        [opus],
      ),
    );
    expect(warnings.map((w) => w.rule)).toEqual(['all-steps-top-tier']);
  });
});

describe('lintFlow — artifact named but not readable', () => {
  const custom = (overrides: Partial<FlowStep>) =>
    step({ role: 'custom', ...overrides });

  it('flags a prompt naming an earlier artifact the step cannot read', () => {
    const warnings = lintFlow(
      flow([
        step({ id: 'plan', output: 'plan.md' }),
        custom({
          id: 'build',
          inputs: ['user_prompt'],
          systemPromptOverride: 'Implement what plan.md describes.',
          output: 'diff',
        }),
      ]),
    );
    expect(warnings.map((w) => w.rule)).toEqual(['unreadable-artifact-named']);
    expect(warnings[0].path).toBe('steps[1].systemPromptOverride');
    expect(warnings[0].message).toContain('mentions "plan.md"');
  });

  it('stays silent when the step actually takes the artifact as an input', () => {
    expect(
      rules(
        flow([
          step({ id: 'plan', output: 'plan.md' }),
          custom({
            id: 'build',
            inputs: ['user_prompt', 'plan.md'],
            systemPromptOverride: 'Implement what plan.md describes.',
            output: 'diff',
          }),
        ]),
      ),
    ).toEqual([]);
  });

  it('allows a prompt to name a LATER artifact — that is describing the pipeline', () => {
    expect(
      rules(
        flow([
          custom({
            id: 'gather',
            inputs: ['user_prompt'],
            systemPromptOverride: 'A later step will turn your work into root_cause.md.',
            output: 'evidence.md',
          }),
          step({ id: 'diagnose', role: 'debugger', inputs: ['user_prompt', 'evidence.md'], output: 'root_cause.md' }),
        ]),
      ),
    ).toEqual([]);
  });

  it('allows a step to name its own output', () => {
    expect(
      rules(
        flow([
          step({ id: 'plan', output: 'plan.md' }),
          custom({
            id: 'write',
            inputs: ['user_prompt', 'plan.md'],
            systemPromptOverride: 'Write report.md as your deliverable.',
            output: 'report.md',
          }),
        ]),
      ),
    ).toEqual([]);
  });

  it('matches whole tokens only', () => {
    expect(
      rules(
        flow([
          step({ id: 'plan', output: 'plan.md' }),
          custom({
            id: 'build',
            inputs: ['user_prompt'],
            systemPromptOverride: 'Consult the myplan.markdown notes and old-plan.md.backup.',
            output: 'diff',
          }),
        ]),
      ),
    ).toEqual([]);
  });

  it('does not read prompts on preset roles that have no override', () => {
    expect(
      rules(
        flow([
          step({ id: 'plan', output: 'plan.md' }),
          step({ id: 'build', role: 'implementer', inputs: ['user_prompt'], output: 'diff' }),
        ]),
      ),
    ).toEqual([]);
  });

  it('does NOT catch a prompt referring to an upstream step without naming its artifact', () => {
    // The report-brief case: prose about a "risk check" step that does not
    // exist. Static matching cannot see this; an AI review pass has to.
    // Pinned so the limitation is deliberate rather than an accident.
    expect(
      rules(
        flow([
          step({ id: 'evidence', output: 'evidence.md' }),
          custom({
            id: 'report',
            inputs: ['user_prompt', 'evidence.md'],
            systemPromptOverride: 'Earlier steps drafted a remediation plan and risk-checked it. Summarise both.',
            output: 'report.md',
          }),
        ]),
      ),
    ).toEqual([]);
  });
});

describe('lintFlow — edge cases', () => {
  it('returns nothing for a flow with no steps', () => {
    expect(lintFlow(flow([]))).toEqual([]);
  });
});

describe('optimizeInstructionFor', () => {
  const warn = (over: Partial<FlowLintWarning> = {}): FlowLintWarning => ({
    rule: 'all-steps-top-tier',
    path: 'steps',
    message: 'All 3 steps run on the most expensive model tier.',
    hint: 'Move the non-reasoning steps to a faster model.',
    ...over,
  });

  it('returns nothing when there is nothing to fix', () => {
    expect(optimizeInstructionFor([])).toBe('');
  });

  it('quotes each finding verbatim so the model does not go hunting', () => {
    const text = optimizeInstructionFor([warn()]);
    expect(text).toContain('- steps: All 3 steps run on the most expensive model tier.');
    expect(text).toContain('Move the non-reasoning steps to a faster model.');
  });

  it('includes every finding', () => {
    const text = optimizeInstructionFor([
      warn(),
      warn({ rule: 'discarded-output', path: 'steps[3].output', message: 'Discarded.', hint: undefined }),
    ]);
    expect(text).toContain('- steps: All 3 steps');
    expect(text).toContain('- steps[3].output: Discarded.');
  });

  it('guards the deliverable, so a cheaper flow is not a lesser one', () => {
    const text = optimizeInstructionFor([warn()]);
    expect(text).toContain('Keep every deliverable');
    expect(text).toContain('discarded unread');
    expect(text).toContain('plan, review, judge or debug stay where they are');
  });
});
