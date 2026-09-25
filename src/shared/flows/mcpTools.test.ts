import { describe, expect, it } from 'vitest';
import { isAccountConnector, isReadOnlyMcpTool, parseMcpToolName, renderMcpToolsSection } from './mcpTools';

describe('isReadOnlyMcpTool', () => {
  it.each([
    'mcp__claude_ai_Gmail__search_threads',
    'mcp__claude_ai_Gmail__get_thread',
    'mcp__claude_ai_Google_Calendar__list_events',
    'mcp__claude_ai_Slack__slack_read_channel',
    'mcp__atlassian__getJiraIssue',
    'mcp__atlassian__searchJiraIssuesUsingJql',
    'mcp__claude_ai_Google_Drive__download_file_content',
  ])('reads: %s', (name) => {
    expect(isReadOnlyMcpTool(name)).toBe(true);
  });

  it.each([
    'mcp__claude_ai_Gmail__send_message',
    'mcp__claude_ai_Gmail__create_draft',
    'mcp__claude_ai_Gmail__label_thread',
    'mcp__claude_ai_Google_Calendar__create_event',
    'mcp__claude_ai_Slack__slack_send_message',
    'mcp__atlassian__editJiraIssue',
    // Says neither: unknown counts as a write.
    'mcp__claude_ai_Google_Calendar__suggest_time',
    // Says both: the write wins.
    'mcp__claude_ai_Gmail__get_and_trash',
    // Not an MCP tool at all.
    'Read',
  ])('does not read only: %s', (name) => {
    expect(isReadOnlyMcpTool(name)).toBe(false);
  });
});

describe('parseMcpToolName', () => {
  it('splits on the double underscore, keeping single ones in the server', () => {
    expect(parseMcpToolName('mcp__claude_ai_Gmail__search_threads')).toEqual({
      server: 'claude_ai_Gmail',
      tool: 'search_threads',
    });
    expect(parseMcpToolName('Bash')).toBeNull();
  });
});

describe('isAccountConnector', () => {
  it('recognises account connectors by name', () => {
    expect(isAccountConnector('claude.ai Gmail')).toBe(true);
    expect(isAccountConnector('atlassian')).toBe(false);
  });
});

describe('renderMcpToolsSection', () => {
  it('groups by server and marks the tools that change something', () => {
    const lines = renderMcpToolsSection([
      'mcp__claude_ai_Gmail__send_message',
      'mcp__claude_ai_Gmail__search_threads',
      'mcp__atlassian__getJiraIssue',
      'Read',
    ]);
    expect(lines).toContain('  atlassian: getJiraIssue');
    expect(lines).toContain('  claude_ai_Gmail: search_threads, send_message*');
  });

  it('is empty when there are no MCP tools', () => {
    expect(renderMcpToolsSection(['Read'])).toEqual([]);
  });
});
