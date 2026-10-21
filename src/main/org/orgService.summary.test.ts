import { describe, expect, it } from 'vitest';
import type { FlowRun } from '../../shared/flows/schema';
import type { Worker } from '../../shared/flows/worker';
import { DEFAULT_ORG_POLICY, type OrgCaller, type OrgPolicy } from '../../shared/org/policy';
import { OrgService, type OrgServiceDeps } from './orgService';

const PAT = 'U0ACMEPAT';
const admin: OrgCaller = { name: 'admin', admin: true };
const pat: OrgCaller = { slackUserId: PAT, name: 'Pat', admin: false };

function worker(id: string, over: Partial<Worker> = {}): Worker {
  return {
    id,
    name: id[0].toUpperCase() + id.slice(1),
    jobDescription: 'Watches the acme board and writes a weekly summary.',
    projectPath: '',
    cadence: null,
    trust: 'probation',
    caps: { maxItemsPerShift: 1, runIn: 'worktree', allowExternalActions: false } as Worker['caps'],
    budgetUSDPerMonth: 20,
    heartbeatModel: 'sonnet',
    flowIds: ['f'],
    enabled: true,
    createdAt: 0,
    ...over,
  };
}

const run = (id: string, workerId: string | undefined, state: Record<string, unknown>): FlowRun =>
  ({ id, workerId, workerName: workerId, flowId: 'f', flowSnapshot: { name: 'Check', steps: [{ id: 'a' }] }, userPrompt: 'Check', state, createdAt: 1_000, attempts: [], artifacts: {} }) as unknown as FlowRun;

const batch = (id: string, origin: Record<string, unknown>, statuses: string[]) => ({
  id,
  origin,
  createdAt: 2_000,
  items: statuses.map((status, i) => ({ status, candidate: { id: `${id}-${i}`, title: `Item ${i}` } })),
});

function harness(opts: { shared?: string[] } = {}) {
  const roster: Worker[] = [
    worker('ana', {
      manager: { name: PAT, slackUserId: PAT },
      mcpServers: ['acme-jira', 'acme-wiki'],
      projectPath: '/srv/acme-web',
      visibility: 'org',
    }),
    worker('bo', { enabled: false, reportsTo: 'ana', projectPath: '/srv/acme-suite' }),
    worker('cy', { manager: { name: 'Pat', slackUserId: PAT }, projectPath: '/tmp/acme/notes', toolScopes: { 'acme-drive': { mode: 'read' } } }),
    worker('dee', { manager: { name: 'Sam', slackUserId: 'U0ACMESAM' } }),
    worker('eve', { enabled: false, manager: { name: 'Pat', slackUserId: PAT } }),
  ];
  const runs = [
    run('r1', 'ana', { kind: 'paused', reason: 'needsInput', nextStepId: 'a' }),
    run('r2', 'ana', { kind: 'running', currentStepId: 'a' }),
    run('r3', 'cy', { kind: 'paused', reason: 'failure', nextStepId: 'a' }),
    run('r4', 'bo', { kind: 'paused', reason: 'externalAction', nextStepId: 'a' }),
    run('r5', undefined, { kind: 'paused', reason: 'needsInput', nextStepId: 'a' }),
  ];
  const batches = [
    batch('b1', { kind: 'worker', workerId: 'cy', workerName: 'Cy', task: 'shift' }, ['proposed', 'queued']),
    batch('b2', { kind: 'worker', workerId: 'ana', workerName: 'Ana', task: 'errand' }, ['queued']),
    batch('b3', { kind: 'person' }, ['proposed']),
  ];
  const policy: OrgPolicy = { ...DEFAULT_ORG_POLICY, sharedMcpServers: opts.shared ?? ['acme-drive'] };
  const calls = { snapshots: 0, tools: 0, repos: 0, workspaces: 0, people: 0, listRuns: 0, batches: 0 };
  const deps = {
    workers: {
      roster: () => roster,
      get: (id: string) => roster.find((w) => w.id === id) ?? null,
      journalFor: () => [],
      spentThisMonth: () => new Map([['ana', 3.5]]),
      workerNames: () => roster.map((w) => w.name),
    },
    runs: {
      listRuns: () => {
        calls.listRuns++;
        return runs;
      },
      getRun: () => null,
    },
    policy: () => policy,
    hires: { list: () => [], save: () => {} },
    batches: {
      list: () => {
        calls.batches++;
        return batches;
      },
    },
    snapshots: () => {
      calls.snapshots++;
      return roster.map((w, i) => ({ worker: w, nextShiftAt: 10_000 + i }));
    },
    tools: {
      list: () => {
        calls.tools++;
        return { tools: [{ name: 'acme-jira' }, { name: 'acme-drive' }], missing: [] };
      },
    },
    repos: {
      list: () => {
        calls.repos++;
        return [{ name: 'acme-web', path: '/srv/acme-web' }];
      },
      workspaces: () => {
        calls.workspaces++;
        return [{ id: 'ws-acme-suite', name: 'Acme suite', repos: ['acme-web'], rootPath: '/srv/acme-suite' }];
      },
    },
    people: () => {
      calls.people++;
      return [{ name: 'Pat', slackUserId: PAT, admin: false }];
    },
    planning: (id: string) => (id === 'dee' ? { since: 0, task: 'shift' as const } : null),
  } as unknown as OrgServiceDeps;
  return { svc: new OrgService(deps), roster, calls };
}

describe("one worker's summary", () => {
  it('is the same as its line in the roster, for everyone who can see it', () => {
    const h = harness();
    for (const caller of [admin, pat]) {
      const listed = h.svc.listWorkers(caller);
      for (const w of h.roster) {
        const one = h.svc.getWorker(caller, w.id);
        const line = listed.find((x) => x.id === w.id);
        if (!line) {
          expect(one.ok).toBe(false);
          continue;
        }
        if (!one.ok) throw new Error(one.error);
        expect(one.worker).toEqual(line);
      }
    }
    // The fixture reaches every input: waiting runs and proposals, places,
    // tools, a manager saved under a Slack id, planning and next shifts.
    const all = h.svc.listWorkers(admin);
    const by = (id: string) => all.find((x) => x.id === id)!;
    expect(by('ana')).toMatchObject({ manager: 'Pat', waiting: 1, state: 'waiting', nextRunAt: 10_000, spentThisMonthUSD: 3.5, place: { kind: 'repo', name: 'acme-web' } });
    expect(by('ana').tools.map((t) => [t.name, t.ok])).toEqual([
      ['acme-jira', true],
      ['acme-wiki', false],
      ['acme-drive', true],
    ]);
    expect(by('bo')).toMatchObject({ waiting: 1, state: 'paused', nextRunAt: null, managerInherited: true, reportsTo: { id: 'ana', name: 'Ana' }, place: { kind: 'workspace', name: 'Acme suite' } });
    expect(by('cy')).toMatchObject({ waiting: 1, state: 'stuck', place: { kind: 'folder', name: 'notes' } });
    expect(by('cy').tools).toEqual([{ name: 'acme-drive', ok: true, shared: true, scope: { mode: 'read' }, scopeFrom: 'own' }]);
    expect(by('dee')).toMatchObject({ waiting: 0, state: 'working' });
    expect(h.svc.listWorkers(pat).map((x) => x.id)).not.toContain('dee');
  });

  it('reads only what that worker needs', () => {
    const h = harness({ shared: [] });
    // A paused worker with no tools, no folder and a plain manager name.
    expect(h.svc.getWorker(admin, 'eve').ok).toBe(true);
    expect(h.calls).toMatchObject({ snapshots: 0, tools: 0, repos: 0, workspaces: 0, people: 0, listRuns: 1, batches: 1 });
    // The roster reads each once, however many workers use it.
    h.svc.listWorkers(admin);
    expect(h.calls).toMatchObject({ snapshots: 1, tools: 1, repos: 1, workspaces: 1, people: 1, listRuns: 2, batches: 2 });
  });
});
