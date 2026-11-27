import { describe, expect, it } from 'vitest';
import { changesFromTranscript, describeChange } from './runChanges';
import { isReadOnlyMcpTool } from './mcpTools';

describe('what a past run changed, read back from its transcript', () => {
  const at = (s: number) => new Date(Date.UTC(2026, 10, 24, 12, 0, s)).toISOString();
  const use = (id: string, name: string, input: unknown, s: number) => JSON.stringify({ type: 'assistant', timestamp: at(s), message: { content: [{ type: 'tool_use', id, name, input }] } });
  const result = (id: string, isError: boolean, s: number) => JSON.stringify({ type: 'user', timestamp: at(s), message: { content: [{ type: 'tool_result', tool_use_id: id, is_error: isError, content: 'ok' }] } });
  const from = Date.UTC(2026, 10, 24, 12, 0, 0), to = Date.UTC(2026, 10, 24, 12, 0, 50);

  it('keeps the calls that changed something and came back without an error, in its time', () => {
    const lines = [
      use('a', 'mcp__atlassian__getJiraIssue', { issueIdOrKey: 'ACME-1' }, 1), result('a', false, 2),
      use('b', 'mcp__atlassian__addCommentToJiraIssue', { issueIdOrKey: 'ACME-1', commentBody: 'Done' }, 3), result('b', false, 4),
      use('c', 'mcp__atlassian__transitionJiraIssue', { issueIdOrKey: 'ACME-1', transition: { id: '9' } }, 5), result('c', true, 6),
      use('d', 'Bash', { command: 'git push' }, 7), result('d', false, 8),
      use('e', 'mcp__atlassian__editJiraIssue', { issueIdOrKey: 'ACME-1', fields: { labels: [] } }, 55), result('e', false, 56),
      'not json',
    ];
    expect(changesFromTranscript(lines, from, to, isReadOnlyMcpTool).map((c) => [c.kind, c.target])).toEqual([['comment', 'ACME-1']]);
  });
});

const call = (tool: string, input: unknown) => describeChange(tool, JSON.stringify(input), 1);

describe('what a run changed, in words', () => {
  it('says a comment, a status move and fields set on a ticket', () => {
    expect(call('mcp__atlassian__addCommentToJiraIssue', { issueIdOrKey: 'ACME-7799', commentBody: 'Fixed in **acme-web#26622**, see the PR.' }))
      .toMatchObject({ kind: 'comment', server: 'atlassian', target: 'ACME-7799', detail: 'Fixed in acme-web#26622, see the PR.' });
    expect(call('mcp__atlassian__transitionJiraIssue', { issueIdOrKey: 'ACME-7799', transition: { id: '273' } }))
      .toMatchObject({ kind: 'status', target: 'ACME-7799', detail: 'transition 273' });
    expect(call('mcp__atlassian__editJiraIssue', { issueIdOrKey: 'ACME-7799', fields: { customfield_10086: 'x', customfield_10090: 'y', labels: ['bug'], priority: { name: 'High' } } }))
      .toMatchObject({ kind: 'fields', target: 'ACME-7799', detail: '4 fields: labels, priority' });
  });

  it('reads the operation of a generic tool from its arguments', () => {
    expect(call('mcp__claude_ai_Atlassian__executeWrite', { name: 'addCommentToJiraIssue', cloudId: 'c', inputs: { issueIdOrKey: 'ENG-412', commentBody: 'Done' } }))
      .toMatchObject({ kind: 'comment', target: 'ENG-412', detail: 'Done' });
    expect(call('mcp__bitbucket__bb_post', { path: '/repositories/acme/acme-web/pullrequests/88/comments', body: { content: { raw: 'Resolved the conflict' } } }))
      .toMatchObject({ kind: 'comment', target: 'acme-web#88' });
    expect(call('mcp__bitbucket__bb_post', { path: '/repositories/acme/acme-web/pullrequests/88/approve' }))
      .toMatchObject({ kind: 'pullRequest', target: 'acme-web#88', detail: 'approved' });
  });

  it('says a message, something created, and anything else by its name', () => {
    expect(call('mcp__slack__slack_post_message', { channel_id: 'C123', text: 'Deploy is green' })).toMatchObject({ kind: 'message', target: 'C123', detail: 'Deploy is green' });
    expect(call('mcp__atlassian__createJiraIssue', { projectKey: 'ACME', summary: 'Login loops on SSO' })).toMatchObject({ kind: 'created', detail: 'Login loops on SSO' });
    expect(call('mcp__acme__frobnicateWidget', { id: 3 })).toMatchObject({ kind: 'other', detail: 'frobnicate widget' });
  });

  it('copes with arguments cut off at their cap', () => {
    expect(describeChange('mcp__atlassian__transitionJiraIssue', '{"issueIdOrKey":"ACME-1","transi', 1)).toMatchObject({ kind: 'status', target: 'ACME-1' });
  });
});
