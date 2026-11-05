import { describe, expect, it } from 'vitest';
import { roleNamed, roleRunNote, roleToolsFor } from './roleTools';
import { inToolScope } from '../flows/toolScope';

const roles = [
  { name: 'QA', job: 'Tests tickets.', tools: ['test-systems', 'atlassian'], budgetUSDPerMonth: 100 },
  { name: 'Analyst', job: 'Answers questions from data.', tools: ['overdb'], budgetUSDPerMonth: 75 },
];

describe('a worker’s role tools', () => {
  it('come from its role, by name in any case, less the ones turned off for it', () => {
    expect(roleNamed(roles, 'qa')?.name).toBe('QA');
    expect(roleToolsFor({ role: 'QA' }, roles)).toEqual(['test-systems', 'atlassian']);
    expect(roleToolsFor({ role: 'qa', roleToolsOff: ['atlassian'] }, roles)).toEqual(['test-systems']);
    expect(roleToolsFor({}, roles)).toEqual([]);
    expect(roleToolsFor({ role: 'Astronaut' }, roles)).toEqual([]);
  });

  it('can still be narrowed by the worker’s own scope', () => {
    const scopes = { 'test-systems': { mode: 'read' as const } };
    expect(inToolScope(scopes, 'mcp__test-systems__list_systems')).toBe(true);
    expect(inToolScope(scopes, 'mcp__test-systems__open_system')).toBe(false);
  });
});

describe('what a worker’s run is told', () => {
  it('names its role’s tools, says what test-systems is for, and how to tell people', () => {
    const note = roleRunNote(['test-systems', 'custom-thing']);
    expect(note).toContain('test-systems (open an app signed in');
    expect(note).toContain('custom-thing');
    expect(note).toContain('overgo tool’s notify call'.replace('’', "'"));
    expect(roleRunNote([])).not.toContain("YOUR ROLE'S TOOLS");
    expect(roleRunNote([])).toContain('never look for a token');
  });
});

