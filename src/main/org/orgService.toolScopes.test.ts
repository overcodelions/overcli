import { describe, expect, it } from 'vitest';
import type { Worker } from '../../shared/flows/worker';
import { DEFAULT_ORG_POLICY, type OrgCaller, type OrgPolicy } from '../../shared/org/policy';
import type { ToolScopes } from '../../shared/flows/toolScope';
import { OrgService } from './orgService';

const pat: OrgCaller = { slackUserId: 'U0ACMEPAT', name: 'Pat', admin: false };
const boss: OrgCaller = { slackUserId: 'U0ACMEBOSS', name: 'Bo', admin: true };

function harness(toolDefaults?: ToolScopes) {
  let forge = {
    id: 'forge',
    name: 'Forge',
    jobDescription: 'Turns acme epics into specs and stories for the team.',
    projectPath: '/data/Workers',
    cadence: null,
    trust: 'trusted',
    caps: { maxItemsPerShift: 1, runIn: 'worktree' },
    budgetUSDPerMonth: 20,
    heartbeatModel: 'sonnet',
    flowIds: ['f'],
    enabled: true,
    createdAt: 0,
    mcpServers: ['atlassian'],
    manager: { name: 'Pat', slackUserId: 'U0ACMEPAT' },
  } as unknown as Worker;
  let org: Record<string, unknown> = toolDefaults ? { toolDefaults } : {};
  const activity: Record<string, Array<{ at: number; kind: string; text: string }>> = {
    r1: [
      { at: 1, kind: 'tool', text: 'atlassian: get jira issue (ACME-1)' },
      { at: 2, kind: 'tool', text: 'atlassian: search jira issues using jql' },
      { at: 3, kind: 'denied', text: 'Not allowed: mcp__atlassian__createJiraIssue' },
      { at: 4, kind: 'tool', text: 'Read notes.md' },
    ],
  };
  const svc = new OrgService({
    workers: {
      roster: () => [forge],
      get: (id: string) => (id === forge.id ? forge : null),
      save: (w: Worker) => ((forge = w), { ok: true, worker: w }),
      spentThisMonth: () => new Map(),
    },
    runs: { listRuns: () => [{ id: 'r1', workerId: 'forge', createdAt: Date.now(), state: { kind: 'done', success: true }, flowSnapshot: { steps: [] }, attempts: [] }], getRun: () => null },
    policy: () => ({ ...DEFAULT_ORG_POLICY, admins: ['U0ACMEBOSS'], ...(org.toolDefaults ? { toolDefaults: org.toolDefaults } : {}) }) as OrgPolicy,
    audit: { append: () => {}, list: () => [] },
    updateOrg: (mutate: (raw: Record<string, unknown>) => void) => {
      const next = structuredClone(org);
      mutate(next);
      org = next;
    },
    serverTools: async () => ({ ok: true, tools: [{ name: 'getJiraIssue' }, { name: 'createJiraIssue' }] }),
    runActivity: (id: string) => activity[id] ?? [],
  } as unknown as ConstructorParameters<typeof OrgService>[0]);
  return { svc, forge: () => forge, org: () => org };
}

describe('scoping a worker’s tools', () => {
  it('lets its manager narrow a tool and go back to the default, and shows where a scope comes from', () => {
    const h = harness({ atlassian: { mode: 'read' } });
    expect(h.svc.listWorkers(pat)[0].tools).toEqual([{ name: 'atlassian', ok: true, scope: { mode: 'read' }, scopeFrom: 'default' }]);
    expect(h.svc.update(pat, 'forge', { toolScopes: { atlassian: { mode: 'only', calls: ['getJiraIssue'] } } }).ok).toBe(true);
    expect(h.svc.listWorkers(pat)[0].tools[0]).toMatchObject({ scope: { mode: 'only', calls: ['getJiraIssue'] }, scopeFrom: 'own' });
    expect(h.svc.update(pat, 'forge', { toolScopes: { atlassian: null } }).ok).toBe(true);
    expect(h.forge().toolScopes).toBeUndefined();
  });

  it('needs an admin to give more than the default', () => {
    const h = harness({ atlassian: { mode: 'read' } });
    expect(h.svc.update(pat, 'forge', { toolScopes: { atlassian: { mode: 'full' } } })).toMatchObject({ ok: false });
    expect(h.svc.update(pat, 'forge', { toolScopes: { atlassian: { mode: 'only', calls: ['createJiraIssue'] } } })).toMatchObject({ ok: false });
    expect(h.svc.update(boss, 'forge', { toolScopes: { atlassian: { mode: 'full' } } }).ok).toBe(true);
    expect(h.forge().toolScopes).toEqual({ atlassian: { mode: 'full' } });
  });

  it('refuses a scope that is none of the three', () => {
    const h = harness();
    expect(h.svc.update(pat, 'forge', { toolScopes: { atlassian: { mode: 'everything' } } }).ok).toBe(false);
    expect(h.svc.update(pat, 'forge', { toolScopes: { 'bad/name': { mode: 'read' } } }).ok).toBe(false);
  });
});

describe('a tool’s default scope', () => {
  it('is set by an admin, in place, and the page shows calls, workers and their week', async () => {
    const h = harness();
    expect(h.svc.setToolDefault(pat, 'atlassian', { mode: 'read' }).ok).toBe(false);
    expect(h.svc.setToolDefault(boss, 'atlassian', { mode: 'read' })).toEqual({ ok: true, default: { mode: 'read' } });
    expect(h.org()).toEqual({ toolDefaults: { atlassian: { mode: 'read' } } });
    const page = await h.svc.toolScopePage(boss, 'atlassian');
    expect(page).toMatchObject({
      ok: true,
      default: { mode: 'read' },
      calls: [{ name: 'getJiraIssue', read: true }, { name: 'createJiraIssue', read: false }],
      workers: [{ id: 'forge', name: 'Forge', manager: 'Pat', calls: 2, refused: 1 }],
    });
    expect(h.svc.setToolDefault(boss, 'atlassian', null).ok).toBe(true);
    expect(h.org()).toEqual({});
  });
});
