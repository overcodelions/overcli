import { describe, expect, it } from 'vitest';

import { connectedMcpTags, scoreRegistryEntry, suggestRegistryFlows } from './registrySuggest';
import type { CapabilitiesReport, FlowRegistryEntry } from '@shared/types';

/// A capability scan reporting the named MCP servers as connected.
function withMcp(...names: string[]): CapabilitiesReport {
  return {
    generatedAt: 0,
    warnings: [],
    entries: names.map((name) => ({
      kind: 'mcp' as const,
      id: `mcp:${name}`,
      name,
      source: 'user' as const,
      clis: ['claude' as const],
    })),
  };
}

function entry(id: string, tags: string[]): FlowRegistryEntry {
  return { registryId: 'official', id, name: id, version: '1.0.0', sha256: 'x', tags };
}

/// A slice of the published registry, in its own (alphabetical) order — the
/// order the welcome screen used to take its first three from.
const REGISTRY: FlowRegistryEntry[] = [
  entry('adr-from-decision', ['design', 'docs', 'claude', 'codex']),
  entry('analyze-stack-trace', ['debugging', 'logs', 'repo', 'claude', 'codex']),
  entry('api-contract-design', ['design', 'api', 'docs', 'backend', 'claude', 'codex']),
  entry('code-review', ['review', 'prs', 'repo', 'claude']),
  entry('coverage-gap-report', ['testing', 'analysis', 'repo', 'claude']),
  entry('estimate-jira-ticket', ['planning', 'tickets', 'mcp-jira', 'claude']),
  entry('security-review', ['security', 'review', 'repo', 'claude']),
  entry('solve-ticket', ['tickets', 'implementation', 'mcp-jira', 'claude', 'codex']),
  entry('spec-to-tickets', ['planning', 'confluence', 'tickets', 'mcp-jira', 'mcp-confluence', 'claude']),
  entry('weekly-status-report', ['communication', 'tickets', 'mcp-jira', 'claude']),
];

describe('suggestRegistryFlows', () => {
  it('opens on code work, not on the alphabetical head', () => {
    const picked = suggestRegistryFlows(REGISTRY).map((e) => e.id);
    expect(picked).toEqual(['security-review', 'code-review', 'coverage-gap-report']);
    // The three the old slice(0, 3) produced: two documents and a diagnosis.
    expect(picked).not.toContain('adr-from-decision');
    expect(picked).not.toContain('api-contract-design');
  });

  it('never suggests a flow that needs an MCP server to someone with none', () => {
    const picked = suggestRegistryFlows(REGISTRY, null, 6).map((e) => e.id);
    expect(picked).not.toContain('spec-to-tickets');
    expect(picked).not.toContain('weekly-status-report');
  });

  it('ranks a repo flow above the same work against a tracker', () => {
    expect(scoreRegistryEntry(entry('a', ['review', 'repo', 'claude']))).toBeGreaterThan(
      scoreRegistryEntry(entry('b', ['review', 'tickets', 'mcp-jira', 'claude'])),
    );
  });

  it('keeps registry order between equally scored entries', () => {
    const tie = [entry('b', ['review', 'repo']), entry('a', ['review', 'repo'])];
    expect(suggestRegistryFlows(tie).map((e) => e.id)).toEqual(['b', 'a']);
  });

  it('leads with solving a ticket once the tracker it needs is connected', () => {
    const picked = suggestRegistryFlows(REGISTRY, withMcp('atlassian')).map((e) => e.id);
    expect(picked[0]).toBe('solve-ticket');
  });

  it('still keeps that flow out of the way when nothing is connected', () => {
    const picked = suggestRegistryFlows(REGISTRY, null).map((e) => e.id);
    expect(picked).not.toContain('solve-ticket');
  });

  it('ranks a flow that writes a diff above one that only writes a report', () => {
    expect(scoreRegistryEntry(entry('a', ['tickets', 'implementation', 'claude']))).toBeGreaterThan(
      scoreRegistryEntry(entry('b', ['review', 'repo', 'claude'])),
    );
  });

  it('reads Jira and Confluence off one Atlassian server, under any name', () => {
    for (const name of ['atlassian', 'jira', 'mcp-atlassian']) {
      expect(connectedMcpTags(withMcp(name)).has('mcp-jira')).toBe(true);
    }
    expect(connectedMcpTags(withMcp('atlassian')).has('mcp-confluence')).toBe(true);
    expect(connectedMcpTags(withMcp('github')).has('mcp-jira')).toBe(false);
    expect(connectedMcpTags(withMcp('github')).has('mcp-github')).toBe(true);
    expect(connectedMcpTags(null).size).toBe(0);
  });

  it('ignores which CLI a flow was published with — install rebinds it', () => {
    // Every registry flow is tagged `claude`; on a Codex-only machine that
    // must neither help nor hurt, because the installed copy runs on Codex.
    expect(scoreRegistryEntry(entry('a', ['review', 'repo', 'claude']))).toBe(
      scoreRegistryEntry(entry('b', ['review', 'repo', 'codex'])),
    );
  });

  it('does not fall over on an entry with no tags at all', () => {
    const untagged: FlowRegistryEntry = {
      registryId: 'official', id: 'bare', name: 'bare', version: '1.0.0', sha256: 'x',
    };
    expect(scoreRegistryEntry(untagged)).toBe(0);
    expect(suggestRegistryFlows([untagged])).toHaveLength(1);
  });
});
