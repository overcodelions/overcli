import { describe, expect, it } from 'vitest';
import { readConnectors, whatItChanges } from './readsOnly';

describe('whether a worker only reads', () => {
  it('finds nothing to change in a flow that searches and reads', () => {
    expect(whatItChanges([{ tools: ['mcp__claude_ai_Acme_Tracker__searchIssuesUsingJql', 'mcp__claude_ai_Acme_Tracker__getIssue', 'Read', 'Bash(git log:*)'] }], false)).toEqual([]);
  });

  it('names what could change: a write tool, a shipping step, a command, acting outside', () => {
    const changes = whatItChanges([{ role: 'shipper', tools: ['mcp__claude_ai_Acme_Chat__send_message', 'Bash(npm publish)'] }, { effect: 'external' }], true);
    expect(changes).toEqual([
      'it may act outside the server',
      'a step ships its work (a push, a message or a publish)',
      'it can use claude_ai_Acme_Chat → send_message',
      'it runs npm publish',
      'a step is marked as acting outside the server',
    ]);
  });

  it('gives a quick turn the connectors a flow reads through, with their writing tools denied', () => {
    expect(readConnectors([{ tools: ['mcp__claude_ai_Acme_Tracker__getIssue', 'mcp__claude_ai_Acme_Tracker__createIssue', 'mcp__acme-wiki__search'] }])).toEqual({
      servers: ['claude.ai Acme Tracker'],
      denied: ['mcp__claude_ai_Acme_Tracker__createIssue'],
    });
  });
});
