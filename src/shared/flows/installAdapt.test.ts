import { describe, expect, it } from 'vitest';

import { adaptFlowYamlToMachine, canRun } from './installAdapt';
import { parseFlowYaml } from './yaml';
import { validateFlow } from './validation';
import type { TemplateResolveContext } from './templateResolver';

/// Shaped like the published `solve-ticket`: Claude participants, one Codex
/// builder, a Claude rebound critic, and an author comment that has to live.
const SOLVE_TICKET = `name: "Solve a ticket end-to-end"
input: user_prompt
participants:
  - id: scout
    name: Scout
    backend: claude
    model: claude-sonnet-5
    kind: primary
  - id: lead
    name: Lead
    backend: claude
    model: claude-opus-5
    kind: reviewer
  - id: builder
    name: Builder
    backend: codex
    model: gpt-5.6-terra
    kind: worker
steps:
  - id: plan
    participant: lead
    role: planner
    inputs: [user_prompt]
    output: plan.md
  - id: build
    participant: builder
    role: implementer
    inputs: [user_prompt, plan.md]
    rebound:
      critic: { backend: claude, model: claude-opus-5 }
      mode: review
      max_iters: 2
    output: diff
  - id: review
    participant: lead
    role: reviewer
    inputs: [user_prompt, plan.md, diff]
    # A rejecting review goes FORWARD to the fix pass, never back to build.
    on_fail:
      action: goto
      target: build
      max_retries: 1
    output: review.md
`;

const machine = (over: Partial<TemplateResolveContext>): TemplateResolveContext => ({
  healthyBackends: [],
  ollamaModels: [],
  ...over,
});

describe('adaptFlowYamlToMachine', () => {
  it('rebinds every Claude reference on a Codex-only machine, critic included', () => {
    const { yaml, changes } = adaptFlowYamlToMachine(SOLVE_TICKET, machine({ healthyBackends: ['codex'] }));
    const flow = parseFlowYaml({ yaml, id: 'solve', source: 'user', filePath: '' });
    expect(flow).not.toBeNull();
    for (const p of flow!.participants) expect(p.backend).toBe('codex');
    const build = flow!.steps.find((s) => s.id === 'build');
    expect(build?.rebound?.critic.backend).toBe('codex');
    expect(changes.map((c) => c.where)).toEqual([
      'participant Scout',
      'participant Lead',
      'step build critic',
    ]);
  });

  it('produces a flow that still validates', () => {
    const { yaml } = adaptFlowYamlToMachine(SOLVE_TICKET, machine({ healthyBackends: ['codex'] }));
    const flow = parseFlowYaml({ yaml, id: 'solve', source: 'user', filePath: '' });
    expect(validateFlow(flow!).ok).toBe(true);
  });

  it("keeps the author's comments and role names", () => {
    const { yaml } = adaptFlowYamlToMachine(SOLVE_TICKET, machine({ healthyBackends: ['codex'] }));
    expect(yaml).toContain('# A rejecting review goes FORWARD to the fix pass, never back to build.');
    expect(yaml).toContain('name: Scout');
    expect(yaml).toContain('name: Lead');
  });

  it("leaves a reference alone when it already runs here — the author's pick stands", () => {
    const { yaml } = adaptFlowYamlToMachine(SOLVE_TICKET, machine({ healthyBackends: ['codex'] }));
    expect(yaml).toContain('model: gpt-5.6-terra');
  });

  it('returns the input byte-for-byte when the machine runs it as written', () => {
    const out = adaptFlowYamlToMachine(SOLVE_TICKET, machine({ healthyBackends: ['claude', 'codex'] }));
    expect(out.changes).toEqual([]);
    expect(out.yaml).toBe(SOLVE_TICKET);
  });

  it('leaves the flow alone when nothing on the machine could run it either', () => {
    const out = adaptFlowYamlToMachine(SOLVE_TICKET, machine({ healthyBackends: [] }));
    expect(out.changes).toEqual([]);
    expect(out.yaml).toBe(SOLVE_TICKET);
  });

  it('writes the compact "backend:model" form back as the same form', () => {
    const compact = `name: x
input: user_prompt
participants:
  - id: a
    name: A
    backend: codex
    model: gpt-5.6-terra
steps:
  - id: s
    participant: a
    role: implementer
    inputs: [user_prompt]
    rebound:
      critic: "claude:claude-opus-5"
      mode: review
      max_iters: 1
    output: diff
`;
    const { yaml, changes } = adaptFlowYamlToMachine(compact, machine({ healthyBackends: ['codex'] }));
    expect(changes).toHaveLength(1);
    expect(yaml).toMatch(/critic: "?codex:/);
  });
});

describe('adaptFlowYamlToMachine — a step bound to Ollama', () => {
  const LOCAL = `name: Local triage
input: user_prompt
participants:
  - id: triage
    name: Triage
    backend: ollama
    model: qwen2.5-coder:7b
  - id: lead
    name: Lead
    backend: claude
    model: claude-opus-5
steps:
  - id: sort
    participant: triage
    role: planner
    inputs: [user_prompt]
    output: plan.md
`;

  // Ollama being down at install time is no consent to send that step's
  // prompt to a cloud model, permanently.
  it('never moves it to a cloud backend, and says so', () => {
    const out = adaptFlowYamlToMachine(LOCAL, machine({ healthyBackends: ['claude', 'codex'] }));
    expect(out.yaml).toBe(LOCAL);
    expect(out.changes).toEqual([]);
    expect(out.keptLocal).toEqual([{ where: 'participant Triage', model: 'ollama:qwen2.5-coder:7b' }]);
  });

  it('still rebinds the cloud references around it', () => {
    const out = adaptFlowYamlToMachine(LOCAL, machine({ healthyBackends: ['codex'] }));
    expect(out.changes.map((c) => c.where)).toEqual(['participant Lead']);
    expect(out.yaml).toContain('model: qwen2.5-coder:7b');
    expect(out.keptLocal.map((k) => k.where)).toEqual(['participant Triage']);
  });

  it('may move it to another local model that is pulled', () => {
    const out = adaptFlowYamlToMachine(
      LOCAL,
      machine({ healthyBackends: ['ollama', 'claude'], ollamaModels: ['llama3.3:8b'] }),
    );
    expect(out.changes).toEqual([
      { where: 'participant Triage', from: 'ollama:qwen2.5-coder:7b', to: 'ollama:llama3.3:8b' },
    ]);
    expect(out.keptLocal).toEqual([]);
  });
});

describe('adaptFlowYamlToMachine — a reference with no backend line', () => {
  // The parser reads a missing `backend:` as Claude, so on a machine without
  // Claude the line has to be added, not just the model swapped.
  const codexOnly = machine({ healthyBackends: ['codex'] });
  const parse = (yaml: string) => parseFlowYaml({ yaml, id: 'x', source: 'user', filePath: '' });

  it('adds it to a block participant, at that map\'s indentation', () => {
    const src = `name: x
input: user_prompt
participants:
  - id: a
    name: A
    model: claude-opus-5
steps:
  - id: s
    participant: a
    role: planner
    inputs: [user_prompt]
    output: plan.md
`;
    const { yaml, changes } = adaptFlowYamlToMachine(src, codexOnly);
    expect(changes).toHaveLength(1);
    expect(yaml).toMatch(/\n    backend: codex\n    model: /);
    expect(parse(yaml)!.participants[0].backend).toBe('codex');
  });

  it('adds it past the dash when model opens the list item', () => {
    const src = `name: x
input: user_prompt
participants:
  - model: claude-opus-5
    id: a
    name: A
steps:
  - id: s
    participant: a
    role: planner
    inputs: [user_prompt]
    output: plan.md
`;
    const { yaml } = adaptFlowYamlToMachine(src, codexOnly);
    expect(yaml).toContain('  - backend: codex\n    model: ');
    expect(parse(yaml)!.participants[0].backend).toBe('codex');
  });

  it('adds it inside an inline critic map', () => {
    const src = `name: x
input: user_prompt
participants:
  - id: a
    name: A
    backend: codex
    model: gpt-5.6-terra
steps:
  - id: s
    participant: a
    role: implementer
    inputs: [user_prompt]
    rebound:
      critic: { model: claude-opus-5 }
      mode: review
      max_iters: 1
    output: diff
`;
    const { yaml } = adaptFlowYamlToMachine(src, codexOnly);
    expect(yaml).toMatch(/critic: \{ backend: codex, model: /);
    expect(parse(yaml)!.steps[0].rebound!.critic.backend).toBe('codex');
  });
});

it('keeps a quoted model quoted', () => {
  const src = SOLVE_TICKET.replace('model: claude-opus-5\n    kind: reviewer', 'model: "claude-opus-5"\n    kind: reviewer');
  const { yaml } = adaptFlowYamlToMachine(src, machine({ healthyBackends: ['codex'] }));
  expect(yaml).toMatch(/name: Lead\n    backend: codex\n    model: "gpt-/);
});

it('changes no line of a published flow but its model references', () => {
  const { yaml } = adaptFlowYamlToMachine(SOLVE_TICKET, machine({ healthyBackends: ['codex'] }));
  const before = SOLVE_TICKET.split('\n');
  const after = yaml.split('\n');
  expect(after).toHaveLength(before.length);
  before.forEach((line, i) => {
    if (line !== after[i]) expect(line).toMatch(/^\s*(backend|model|critic):/);
  });
});

describe('canRun', () => {
  const ctx = machine({ healthyBackends: ['ollama'], ollamaModels: ['qwen2.5-coder:7b'] });

  it('accepts an exact or untagged ollama model that is pulled', () => {
    expect(canRun({ backend: 'ollama', model: 'qwen2.5-coder:7b' }, ctx)).toBe(true);
    expect(canRun({ backend: 'ollama', model: 'qwen2.5-coder' }, ctx)).toBe(true);
  });

  it('rejects an ollama model that is not pulled, even with ollama running', () => {
    expect(canRun({ backend: 'ollama', model: 'llama3.3' }, ctx)).toBe(false);
  });

  it('rejects a backend that is not healthy', () => {
    expect(canRun({ backend: 'claude', model: 'claude-opus-5' }, ctx)).toBe(false);
  });
});
