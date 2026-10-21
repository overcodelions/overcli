import { describe, expect, it } from 'vitest';
import type { Worker } from '../../shared/flows/worker';
import { DEFAULT_ORG_POLICY, type OrgCaller, type OrgPolicy } from '../../shared/org/policy';
import { OrgService } from './orgService';

const boss: OrgCaller = { slackUserId: 'U0ACMEBOSS', name: 'Bo', admin: true };
const pat: OrgCaller = { slackUserId: 'U0ACMEPAT', name: 'Pat', admin: false };

function harness(installed: string[]) {
  let vantage = {
    id: 'vantage',
    name: 'Vantage',
    flowIds: ['f'],
    enabled: true,
    mcpServers: ['claude.ai Atlassian', 'slack'],
    toolScopes: { 'claude.ai Atlassian': 'read' },
    manager: { name: 'Pat', slackUserId: 'U0ACMEPAT' },
  } as unknown as Worker;
  const tools = new Set(installed);
  const svc = new OrgService({
    workers: { roster: () => [vantage], get: () => vantage, save: (w: Worker) => ((vantage = w), { ok: true, worker: w }), spentThisMonth: () => new Map() },
    runs: { listRuns: () => [], getRun: () => null },
    policy: () => ({ ...DEFAULT_ORG_POLICY, admins: ['U0ACMEBOSS'] }) as OrgPolicy,
    audit: { append: () => {}, list: () => [] },
    tools: {
      list: (roster: Worker[]) => ({
        tools: [...tools].map((name) => ({ name, kind: 'http', target: 'https://mcp.acme.example', secrets: [], usedBy: [] })),
        missing: [...new Set(roster.flatMap((w) => w.mcpServers ?? []))].filter((n) => !tools.has(n)).map((name) => ({ name, workers: ['Vantage'] })),
      }),
      install: (t: { name: string }) => (tools.add(t.name), { ok: true }),
    },
  } as unknown as ConstructorParameters<typeof OrgService>[0]);
  return { svc, vantage: () => vantage };
}

describe('a connector from a Claude account', () => {
  it('asks for the catalog tool that stands in for it', () => {
    const { svc } = harness(['slack']);
    const r = svc.tools(boss);
    if (!r.ok) throw new Error(r.error);
    expect(r.missing).toEqual([expect.objectContaining({ name: 'claude.ai Atlassian', connector: { title: 'Atlassian', tool: 'atlassian', installed: false }, template: expect.objectContaining({ name: 'atlassian', kind: 'http' }) })]);
  });

  it('switches the workers over when that tool is installed, scope and all', () => {
    const { svc, vantage } = harness(['slack']);
    expect(svc.installTool(boss, { name: 'atlassian', kind: 'http', url: 'https://mcp.atlassian.com/v2/mcp' }).ok).toBe(true);
    expect(vantage().mcpServers).toEqual(['atlassian', 'slack']);
    expect(vantage().toolScopes).toEqual({ atlassian: 'read' });
  });

  it('switches them to one already installed, for an admin only', () => {
    const { svc, vantage } = harness(['slack', 'atlassian']);
    const r = svc.tools(boss);
    expect(r.ok && r.missing[0].connector?.installed).toBe(true);
    expect(svc.useToolForConnectors(pat, 'atlassian').ok).toBe(false);
    expect(svc.useToolForConnectors(boss, 'atlassian')).toEqual({ ok: true, workers: ['Vantage'] });
    expect(vantage().mcpServers).toEqual(['atlassian', 'slack']);
  });
});
