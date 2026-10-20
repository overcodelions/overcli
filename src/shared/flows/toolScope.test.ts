import { describe, expect, it } from 'vitest';
import { describeScope, inToolScope, parseToolScope, scopeDenies, scopeRefusal } from './toolScope';

const scopes = { atlassian: { mode: 'read' as const }, 'claude.ai Acme Docs': { mode: 'only' as const, calls: ['search', 'fetch'] } };

describe('tool scopes', () => {
  it('lets reads through a read-only tool and only the picked calls through the other', () => {
    expect(inToolScope(scopes, 'mcp__atlassian__searchJiraIssuesUsingJql')).toBe(true);
    expect(inToolScope(scopes, 'mcp__atlassian__createJiraIssue')).toBe(false);
    expect(inToolScope(scopes, 'mcp__claude_ai_Acme_Docs__fetch')).toBe(true);
    expect(inToolScope(scopes, 'mcp__claude_ai_Acme_Docs__update')).toBe(false);
    // Not scoped, or not a tool call at all: not this rule's to refuse.
    expect(inToolScope(scopes, 'mcp__puppeteer__puppeteer_click')).toBe(true);
    expect(inToolScope(scopes, 'Bash')).toBe(true);
  });

  it('lists every known call outside the scopes, for the CLI to refuse', () => {
    const known = ['mcp__atlassian__getJiraIssue', 'mcp__atlassian__editJiraIssue', 'mcp__claude_ai_Acme_Docs__search', 'mcp__claude_ai_Acme_Docs__delete', 'mcp__puppeteer__puppeteer_click'];
    expect(scopeDenies(scopes, known)).toEqual(['mcp__atlassian__editJiraIssue', 'mcp__claude_ai_Acme_Docs__delete']);
    expect(scopeDenies(undefined, known)).toEqual([]);
  });

  it('says why, reads input safely, and describes a scope in a word or two', () => {
    expect(scopeRefusal(scopes, 'mcp__atlassian__createJiraIssue', 'Forge')).toBe('Refused: Forge may use atlassian read only, and createJiraIssue is outside that.');
    expect(parseToolScope({ mode: 'read', calls: ['x'] })).toEqual({ mode: 'read' });
    expect(parseToolScope({ mode: 'only', calls: ['search', 'search', 'bad name!', 7] })).toEqual({ mode: 'only', calls: ['search'] });
    expect(parseToolScope({ mode: 'write' })).toBeUndefined();
    expect(describeScope(undefined)).toBe('whole tool');
    expect(describeScope({ mode: 'only', calls: ['a', 'b'] })).toBe('2 calls');
  });
});

describe('defaults and what fits inside them', () => {
  it('lays a worker’s own scope over the org’s default, dropping the whole tool', async () => {
    const { effectiveScopes } = await import('./toolScope');
    expect(effectiveScopes({ slack: { mode: 'full' } }, { atlassian: { mode: 'read' }, slack: { mode: 'read' } })).toEqual({ atlassian: { mode: 'read' } });
    expect(effectiveScopes(undefined, undefined)).toBeUndefined();
  });

  it('says whether a scope gives no more than the default', async () => {
    const { withinScope } = await import('./toolScope');
    expect(withinScope({ mode: 'full' }, undefined, 'atlassian')).toBe(true);
    expect(withinScope({ mode: 'full' }, { mode: 'read' }, 'atlassian')).toBe(false);
    expect(withinScope({ mode: 'only', calls: ['getJiraIssue'] }, { mode: 'read' }, 'atlassian')).toBe(true);
    expect(withinScope({ mode: 'only', calls: ['createJiraIssue'] }, { mode: 'read' }, 'atlassian')).toBe(false);
    expect(withinScope({ mode: 'read' }, { mode: 'only', calls: ['getJiraIssue'] }, 'atlassian')).toBe(false);
    expect(withinScope({ mode: 'only', calls: ['a'] }, { mode: 'only', calls: ['a', 'b'] }, 'atlassian')).toBe(true);
  });
});
