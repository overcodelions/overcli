import { describe, expect, it } from 'vitest';
import type { FlowStep } from '../../shared/flows/schema';
import { resolveStepEffect, runGrantCovers, stepGrantAllows, stepOutsideTools, stepsARunGrantCovers } from './stepEffect';

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

describe('a grant that names the step', () => {
  const file = step('file-proposals', ['mcp__atlassian__jira_add_comment'], { effect: 'external' });
  const run = { externalActionRunGrant: ['step:file-proposals'] };

  it('lets through a tool the step lists by name', () => {
    expect(stepGrantAllows(run, file, 'mcp__atlassian__jira_add_comment')).toBe(true);
  });

  it('lets through any tool of a server the step lists', () => {
    expect(stepGrantAllows(run, step('file-proposals', ['mcp__atlassian']), 'mcp__atlassian__jira_add_comment')).toBe(true);
  });

  it('refuses a tool the step does not list, or a step the grant does not name', () => {
    expect(stepGrantAllows(run, file, 'mcp__atlassian__jira_transition_issue')).toBe(false);
    expect(stepGrantAllows(run, step('file-proposals', ['mcp__atlassian']), 'mcp__atlassian_admin__delete')).toBe(false);
    expect(stepGrantAllows({ externalActionRunGrant: ['step:assess'] }, file, 'mcp__atlassian__jira_add_comment')).toBe(false);
    expect(stepGrantAllows({}, file, 'mcp__atlassian__jira_add_comment')).toBe(false);
  });
});
