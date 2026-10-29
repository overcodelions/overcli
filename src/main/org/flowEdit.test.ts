import { describe, expect, it } from 'vitest';
import type { Flow, FlowStep } from '../../shared/flows/schema';
import { copyFlowId, describeFlowEdit, holdFlowEdit, stepLabel, stepsOf } from './flowEdit';

function step(id: string, over: Partial<FlowStep> = {}): FlowStep {
  return { id, participantId: 'primary', role: 'implementer', inputs: ['user_prompt'], tools: ['Read', 'Edit'], output: `${id}.md`, ...over };
}

function flow(steps: FlowStep[]): Flow {
  return {
    id: 'fix',
    name: 'Fix a ticket',
    input: 'user_prompt',
    participants: [{ id: 'primary', name: 'Claude', backend: 'claude', model: 'claude-sonnet-5-5', kind: 'primary' }],
    steps,
    source: 'user',
    filePath: '/data/flows/fix.yaml',
  };
}

const push = step('push', { tools: ['Read', 'Bash(git push:*)'], effect: 'external', pauseBefore: true });
const before = flow([step('plan'), step('change'), push]);

describe('a flow changed by saying so', () => {
  it('reads as plain steps', () => {
    expect(stepLabel({ id: 'run_tests' })).toBe('Run tests');
    expect(stepsOf(before)).toEqual([
      { id: 'plan', label: 'Plan', tools: ['Read', 'Edit'], checkpoint: false, external: false, onlyIfChanged: false },
      { id: 'change', label: 'Change', tools: ['Read', 'Edit'], checkpoint: false, external: false, onlyIfChanged: false },
      { id: 'push', label: 'Push', tools: ['Read', 'Bash(git push:*)'], checkpoint: true, external: true, onlyIfChanged: false },
    ]);
  });

  it('takes a new step built from tools it already had, and says so', () => {
    const after = flow([step('plan'), step('change'), step('check', { onlyIfChanged: true }), push]);
    const held = holdFlowEdit(before, after, { admin: false });
    if (!held.ok) throw new Error(held.error);
    expect(describeFlowEdit(before, held.flow)).toEqual(['Adds “Check” after “Change”.']);
  });

  it('refuses a tool none of its steps had', () => {
    const after = flow([step('plan', { tools: ['Read', 'WebFetch'] }), step('change'), push]);
    expect(holdFlowEdit(before, after, { admin: false })).toEqual({ ok: false, error: expect.stringContaining('WebFetch') });
  });

  it('refuses a step that names no tools', () => {
    expect(holdFlowEdit(before, flow([step('plan', { tools: [] }), step('change'), push]), { admin: false }).ok).toBe(false);
  });

  it('keeps an outside step asking, and the models it had', () => {
    const after = flow([step('plan'), step('change'), { ...push, effect: 'local', model: { backend: 'claude', model: 'claude-opus-5-5' }, participantId: 'nobody' }]);
    after.participants = [{ id: 'primary', name: 'Big', backend: 'claude', model: 'claude-opus-5-5', kind: 'primary' }];
    const held = holdFlowEdit(before, after, { admin: false });
    if (!held.ok) throw new Error(held.error);
    const p = held.flow.steps[2];
    expect(p.effect).toBe('external');
    expect(p.model).toBeUndefined();
    expect(p.participantId).toBe('primary');
    expect(held.flow.participants[0].model).toBe('claude-sonnet-5-5');
  });

  it('drops a wider permission mode', () => {
    const held = holdFlowEdit(before, flow([step('plan', { permissionMode: 'bypassPermissions' }), step('change'), push]), { admin: false });
    expect(held.ok && held.flow.steps[0].permissionMode).toBeUndefined();
  });

  it('lets only an admin take a checkpoint out', () => {
    const after = flow([step('plan'), step('change'), { ...push, pauseBefore: false }]);
    expect(holdFlowEdit(before, after, { admin: false })).toEqual({ ok: false, error: 'Only an admin can take out the stop before “Push”.' });
    expect(holdFlowEdit(before, flow([step('plan'), step('change')]), { admin: false }).ok).toBe(false);
    const held = holdFlowEdit(before, after, { admin: true });
    expect(held.ok && describeFlowEdit(before, held.flow)).toEqual(['No longer stops before “Push”.']);
  });

  it('keeps its id, file and inputs whatever comes back', () => {
    const held = holdFlowEdit(before, { ...flow([step('plan'), step('change'), push]), id: 'other', filePath: '/elsewhere.yaml', source: 'project' }, { admin: false });
    expect(held.ok && [held.flow.id, held.flow.filePath, held.flow.source]).toEqual(['fix', '/data/flows/fix.yaml', 'user']);
  });

  it('says when nothing changed, and when the order did', () => {
    expect(describeFlowEdit(before, before)).toEqual([]);
    expect(describeFlowEdit(before, flow([step('change'), step('plan'), push]))).toEqual(['Puts the steps in a new order.']);
  });

  it('names a copy after the worker, clear of ones taken', () => {
    expect(copyFlowId('fix', 'Ada Lovelace', () => false)).toBe('fix-ada-lovelace');
    expect(copyFlowId('fix', 'Ada', (id) => id === 'fix-ada')).toBe('fix-ada-2');
  });
});
