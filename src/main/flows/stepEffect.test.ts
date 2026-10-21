import { describe, expect, it } from 'vitest';
import type { FlowStep } from '../../shared/flows/schema';
import { resolveStepEffect, runGrantCovers, stepOutsideTools, stepsARunGrantCovers } from './stepEffect';

const step = (id: string, tools: string[], extra: Partial<FlowStep> = {}): FlowStep =>
  ({ id, role: 'researcher', output: `${id}.md`, tools, systemPromptOverride: 'Count the issues by month.', ...extra }) as unknown as FlowStep;

describe('what reaches outside', () => {
  it('names the tools that make a step external, and nothing for a local one', () => {
    expect(stepOutsideTools(step('gather', ['Read', 'Bash', 'mcp__atlassian__searchJiraIssuesUsingJql']))).toEqual(['bash']);
    expect(stepOutsideTools(step('answer', ['Read', 'Write']))).toEqual([]);
    expect(resolveStepEffect(step('answer', ['Read', 'Write']))).toBe('local');
  });

  it('gives no tools for a step that is external for another reason', () => {
    expect(stepOutsideTools(step('ship', ['Bash'], { role: 'shipper' } as Partial<FlowStep>))).toBeNull();
    expect(stepOutsideTools(step('post', ['Bash'], { systemPromptOverride: 'Post the chart to the Slack channel.' }))).toBeNull();
    expect(stepOutsideTools(step('any', []))).toBeNull();
  });
});

describe('approving for the run', () => {
  const steps = [
    step('gather', ['Read', 'Bash']),
    step('choose', ['Read', 'Bash', 'Glob']),
    step('chart', ['Read', 'Write']),
    step('post', ['Bash'], { systemPromptOverride: 'Send the chart to Slack.' }),
    step('edit', ['Bash', 'mcp__atlassian__editJiraIssue']),
  ];

  it('covers later steps that need only the same tools, and nothing new or worded as an outside action', () => {
    expect(stepsARunGrantCovers(steps, 'gather')).toEqual(['choose']);
    const run = { externalActionRunGrant: ['bash'] };
    expect(runGrantCovers(run, steps[1])).toBe(true);
    expect(runGrantCovers(run, steps[3])).toBe(false);
    expect(runGrantCovers(run, steps[4])).toBe(false);
    expect(runGrantCovers({}, steps[1])).toBe(false);
  });
});
