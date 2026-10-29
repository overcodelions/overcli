import { describe, expect, it } from 'vitest';
import { ticketFlowId, ticketFlowYaml, ticketOf, ticketPrompt, trackerOf, TICKET_STEP } from './ticketFollowUp';
import { parseFlowYaml } from '../../shared/flows/yaml';
import { validateFlow } from '../../shared/flows/validation';
import { stepShips } from './serverFlow';
import { pauseReasonBeforeStep } from '../flows/runtime';
import type { FlowRun } from '../../shared/flows/schema';

const run = { id: 'r1', flowId: 'solve-ticket', userPrompt: 'Implement ACME-412 end to end', artifacts: { 'pull-request.md': { body: 'Fix the bleed\n\nKeeps the filter local.' }, 'plan.md': { body: 'Cause: the filter went global in a3f9c1e on 2024-05-02.' } }, flowSnapshot: { name: 'Solve', steps: [] } } as unknown as FlowRun;

describe('the ticket follow-up', () => {
  it('finds the ticket and the tracker, and asks with the links', () => {
    expect(ticketOf(run)).toBe('ACME-412');
    expect(trackerOf(['github', 'atlassian'])).toBe('atlassian');
    expect(trackerOf(['github'])).toBeNull();
    const prompt = ticketPrompt(run, 'ACME-412', [{ repo: 'app', branch: 'b', url: 'https://example.test/pr/1' }, { repo: 'web', skipped: 'no changes' }]);
    expect(prompt).toContain('- app: https://example.test/pr/1');
    expect(prompt).not.toContain('web');
    expect(prompt).toContain('Keeps the filter local.');
    // The root cause a transition into review asks for comes along.
    expect(prompt).toContain('a3f9c1e on 2024-05-02');
    expect(prompt).toContain('fill them in the transition');
  });

  it('takes the ticket its title names over one its ask mentions first', () => {
    const cloned = { ...run, orchestrationItemTitle: 'ACME-412: Fix the upload timeout', userPrompt: 'Cloned from ACME-398. Fix ACME-412 end to end.' } as unknown as FlowRun;
    expect(ticketOf(cloned)).toBe('ACME-412');
    // A title with no ticket in it: the ask's, as before.
    expect(ticketOf({ ...run, orchestrationItemTitle: 'Fix the upload timeout', userPrompt: 'Cloned from ACME-398.' } as unknown as FlowRun)).toBe('ACME-398');
  });

  it('fills the fields a transition requires where Jira takes them, and never invents them', () => {
    const yaml = ticketFlowYaml('atlassian');
    expect(yaml).toContain('send them in the transition call itself');
    expect(yaml).toContain('set them with an edit first, then transition');
    expect(yaml).toContain('expand editmeta');
    expect(yaml).toContain('invent a value nothing here supports');
    expect(yaml).not.toContain("Change nothing the request doesn't ask for");
  });

  it("is one step on the tracker alone, asks a worker on probation, and lets a trusted coding worker's named grant through", () => {
    const flow = parseFlowYaml({ yaml: ticketFlowYaml('atlassian'), id: ticketFlowId('atlassian'), source: 'user', filePath: '' })!;
    expect(validateFlow(flow).errors).toEqual([]);
    expect(flow.name).toBe('Ticket actions');
    const step = flow.steps[0];
    expect(step).toMatchObject({ id: TICKET_STEP, tools: ['mcp__atlassian'], effect: 'external' });
    expect(stepShips(step)).toBe(false);
    expect(pauseReasonBeforeStep({ workerId: 'w' }, step)).toBe('externalAction');
    expect(pauseReasonBeforeStep({ workerId: 'w', externalActionRunGrant: ['step:ticket-update'] }, step)).toBeNull();
  });
});
