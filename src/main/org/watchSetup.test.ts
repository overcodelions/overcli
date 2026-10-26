import { describe, expect, it } from 'vitest';
import { generalize, readShape, readToolCall } from './watchSetup';

describe('setting up a watch from one lookup', () => {
  it('reads the call the worker made, matched to the tool installed here', () => {
    expect(readToolCall('Found it.\n{"tool": "mcp__acme-tracker__searchIssues", "args": {"jql": "key in (ACME-412)", "site": "s1"}}', ['acme tracker', 'acme-tracker'])).toEqual({
      server: 'acme-tracker',
      tool: 'searchIssues',
      args: { jql: 'key in (ACME-412)', site: 's1' },
    });
    expect(readToolCall('Done.\n```json\n{"tool": "mcp__acme-tracker__searchIssues", "args": {"jql": "key in (ACME-412)", "fields": ["status"]}}\n```\nIt is In Progress {so far}.', ['acme-tracker'])).toMatchObject({ tool: 'searchIssues', args: { fields: ['status'] } });
    expect(readToolCall('{"tool": null}', [])).toBeNull();
    expect(readToolCall('no json here', [])).toBeNull();
  });

  it('swaps the ticket for {{ids}}, so the same call asks about every tracked one', () => {
    expect(generalize({ jql: 'key = ACME-412', site: 's1' }, 'ACME-412')).toEqual({ args: { jql: 'key in ({{ids}})', site: 's1' }, found: true });
    expect(generalize({ jql: 'issuekey in ("ACME-412") ORDER BY key' }, 'ACME-412').args).toEqual({ jql: 'issuekey in ({{ids}}) ORDER BY key' });
    expect(generalize({ keys: ['ACME-412'] }, 'ACME-412').args).toEqual({ keys: ['{{ids}}'] });
    expect(generalize({ jql: 'project = ACME' }, 'ACME-412').found).toBe(false);
  });

  it('finds the list, the key and the status in a real answer', () => {
    const jira = { total: 1, issues: [{ id: '10001', key: 'ACME-412', fields: { summary: 'Export fails', status: { name: 'In Progress' } } }] };
    expect(readShape(jira, 'acme-412')).toEqual({ itemsPath: 'issues', idPath: 'key', statusPath: 'fields.status.name', status: 'In Progress' });
    const other = { data: { results: [{ ref: { id: 'ACME-412' }, workflowState: 'Doing' }] } };
    expect(readShape(other, 'ACME-412')).toEqual({ itemsPath: 'data.results', idPath: 'ref.id', statusPath: 'workflowState', status: 'Doing' });
    expect(readShape({ issues: [] }, 'ACME-412')).toBeNull();
  });
});
