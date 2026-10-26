import { describe, expect, it } from 'vitest';
import { FLOW_TEMPLATES } from '../../shared/flows/templates';
import { parseFlowYaml } from '../../shared/flows/yaml';
import { validateFlow } from '../../shared/flows/validation';
import { serverShapedFlow, stepShips, SERVER_PR_STEP } from './serverFlow';

const template = (id: string) => parseFlowYaml({ yaml: FLOW_TEMPLATES.find((t) => t.id === id)!.yaml, id, source: 'user', filePath: '' })!;

describe('serverShapedFlow', () => {
  it("keeps a ticket flow's thinking and checking steps, and ends it with the server's pull request in place of its own shipping", () => {
    const flow = template('solve-ticket');
    const shaped = serverShapedFlow(flow)!;
    expect(shaped).not.toBeNull();
    expect(validateFlow(shaped).errors).toEqual([]);
    const ids = shaped.steps.map((s) => s.id);
    expect(ids.at(-1)).toBe(SERVER_PR_STEP);
    expect(shaped.steps.filter((s) => s.id !== SERVER_PR_STEP).some((s) => stepShips(s))).toBe(false);
    for (const kept of flow.steps.filter((s) => !stepShips(s) && ids.includes(s.id))) expect(ids).toContain(kept.id);
    expect(shaped.steps.at(-1)).toMatchObject({ effect: 'external', output: 'pull-request.md', tools: ['Read', 'Grep', 'Glob'] });
    // The stored flow is untouched.
    expect(flow.steps.map((s) => s.id)).not.toContain(SERVER_PR_STEP);
  });

  it('leaves alone a flow with nothing that ships, and the server\'s own repo flows', () => {
    const review = template('review-my-branch');
    expect(serverShapedFlow(review)).toBeNull();
    expect(serverShapedFlow({ ...template('solve-ticket'), id: 'org-pr-app' })).toBeNull();
  });

  it('reads "do not push" as not shipping', () => {
    expect(stepShips({ id: 'build', role: 'implementer', output: 'diff', tools: ['Edit'], systemPromptOverride: 'Make the change. Do not commit, branch or push: overcli does.' })).toBe(false);
    expect(stepShips({ id: 'push', role: 'custom', output: 'pr_url', tools: ['Bash'], systemPromptOverride: 'Push the branch and open a pull request.' })).toBe(true);
  });
});
