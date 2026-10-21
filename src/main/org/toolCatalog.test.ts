import { describe, expect, it } from 'vitest';
import { catalogFor, TOOL_CATALOG } from './toolCatalog';
import { TOOL_NAME } from './tools';

describe('the tool catalog', () => {
  it('lists each tool once, under a name workers can list', () => {
    const names = TOOL_CATALOG.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
    for (const t of TOOL_CATALOG) {
      expect(t.name).toMatch(TOOL_NAME);
      expect(t.docs).toMatch(/^https:\/\//);
      if (t.kind === 'http') expect(new URL(t.url!).protocol).toBe('https:');
      else expect(t.command).toBeTruthy();
    }
  });

  it('only explains settings the form asks for, and carries no values', () => {
    for (const t of TOOL_CATALOG) {
      const asked = [...t.envKeys, ...t.headerKeys];
      for (const k of Object.keys(t.settings ?? {})) expect(asked).toContain(k);
      expect(JSON.stringify(t)).not.toMatch(/(xox[bp]-[A-Za-z0-9]|sk_live_|ghp_[A-Za-z0-9])/);
    }
  });

  it('offers a key for every tool that signs in through a browser, but the ones that only sign in', () => {
    const signInOnly = TOOL_CATALOG.filter((t) => t.kind === 'http' && !t.open && !t.headerKeys.length && !t.withToken).map((t) => t.name);
    expect(signInOnly).toEqual(['vercel']);
    for (const t of TOOL_CATALOG.filter((x) => x.withToken)) {
      const w = t.withToken!;
      expect(w.kind === 'command' ? w.command : w.url).toBeTruthy();
      for (const k of Object.keys(w.settings ?? {})) expect([...w.envKeys, ...w.headerKeys]).toContain(k);
    }
  });

  it('finds a common tool by the name a worker lists, in any case', () => {
    expect(catalogFor('GitHub')?.title).toBe('GitHub');
    expect(catalogFor('acme-crm')).toBeUndefined();
  });
});

describe('connectors from a Claude account', () => {
  it('names the server tool that stands in for one', async () => {
    const { connectorTitle, connectorTool } = await import('./toolCatalog');
    expect(connectorTitle('claude.ai Atlassian')).toBe('Atlassian');
    expect(connectorTool('claude.ai Atlassian')).toBe('atlassian');
    expect(connectorTool('claude_ai_Brave')).toBe('brave-search');
    expect(connectorTool('claude.ai Google Drive')).toBe('google-drive');
    expect(connectorTool('atlassian')).toBeUndefined();
  });
});
