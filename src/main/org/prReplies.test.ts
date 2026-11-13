import { describe, expect, it } from 'vitest';
import type { FlowRun } from '../../shared/flows/schema';
import { parseFlowYaml } from '../../shared/flows/yaml';
import { gitHostOf, repliesFlowId, repliesFlowYaml, repliesPrompt } from './prReplies';

describe('pull request replies', () => {
  it('finds the git host among its tools', () => {
    expect(gitHostOf(['atlassian', 'bitbucket'])).toBe('bitbucket');
    expect(gitHostOf(['atlassian'])).toBeNull();
  });

  it('is one external step holding only the host’s tools', () => {
    const flow = parseFlowYaml({ yaml: repliesFlowYaml('bitbucket'), id: repliesFlowId('bitbucket'), source: 'user', filePath: '' });
    expect(flow?.steps).toHaveLength(1);
    expect(flow?.steps[0]).toMatchObject({ id: 'pr-replies', effect: 'external', tools: ['mcp__bitbucket'] });
  });

  it('tells it the pull request, what it fixed and the commit', () => {
    const run = {
      orchestrationItemTitle: 'PR #42: address the review',
      userPrompt: 'PR #42 in acme-web. Comment 991: rename the helper.\n[continue-branch: feature/ACME-9-sort]',
      artifacts: { 'pull-request.md': { body: 'Renamed sortRows to sortByDate (comment 991).' } },
    } as unknown as FlowRun;
    const prompt = repliesPrompt(run, [
      { repo: 'acme-web', branch: 'feature/ACME-9-sort', updated: true, commit: 'abc123def456' },
      { repo: 'acme-api', skipped: 'no changes' },
    ]);
    expect(prompt).toContain('- acme-web: added to feature/ACME-9-sort as commit abc123def456');
    expect(prompt).not.toContain('acme-api');
    expect(prompt).toContain('Comment 991');
    expect(prompt).toContain('Renamed sortRows');
  });
});
