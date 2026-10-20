import { describe, expect, it } from 'vitest';
import type { Worker } from '../../shared/flows/worker';
import type { FlowRun } from '../../shared/flows/schema';
import { DEFAULT_ORG_POLICY, type OrgCaller } from '../../shared/org/policy';
import { OrgService } from './orgService';

const pat: OrgCaller = { slackUserId: 'U0ACMEPAT', name: 'Pat', admin: false };
const sam: OrgCaller = { slackUserId: 'U0ACMESAM', name: 'Sam', admin: false };

const scout = {
  id: 'scout',
  name: 'Scout',
  jobDescription: 'Writes a weekly report on what acme rivals shipped.',
  projectPath: '/data/Workers',
  cadence: null,
  trust: 'trusted',
  caps: { maxItemsPerShift: 1, runIn: 'worktree' },
  budgetUSDPerMonth: 20,
  heartbeatModel: 'sonnet',
  flowIds: ['scout-flow'],
  enabled: true,
  createdAt: 0,
  manager: { name: 'Pat', slackUserId: 'U0ACMEPAT' },
} as unknown as Worker;

const run = { id: 'run1', workerId: 'scout' } as unknown as FlowRun;

function harness() {
  const read: string[] = [];
  const svc = new OrgService({
    workers: {
      roster: () => [scout],
      get: (id: string) => (id === scout.id ? scout : null),
      save: (w: Worker) => ({ ok: true, worker: w }),
      setEnabled: () => ({ ok: true }),
      remove: () => ({ ok: true }),
      runErrand: async () => ({ ok: false, error: 'no' }),
      journalFor: () => [],
      spentThisMonth: () => new Map(),
      workerNames: () => [scout.name],
    },
    runs: { listRuns: () => [run], getRun: (id: string) => (id === run.id ? run : null), steerRun: () => ({ ok: true }), resumeRun: () => ({ ok: true }) },
    rejectRun: () => ({ ok: true }),
    policy: () => DEFAULT_ORG_POLICY,
    draft: async () => ({ ok: false, error: 'no' }),
    saveHire: () => ({ ok: false, error: 'no' }),
    hires: { list: () => [], save: () => {} },
    runDeliverables: () => [
      { name: 'review.md', body: '# Review' },
      { name: 'reports/acme-weekly.html', sourcePath: '/data/coordinators/run1/reports/acme-weekly.html', bytes: 2048 },
    ],
    readRunFile: (p: string) => {
      read.push(p);
      return Buffer.from('<h1>Weekly</h1>');
    },
  } as unknown as ConstructorParameters<typeof OrgService>[0]);
  return { svc, read };
}

describe('run files', () => {
  it('lists only the files a run wrote, for people who can see its worker', () => {
    const { svc } = harness();
    expect(svc.runFiles(pat, 'run1')).toEqual({ ok: true, files: [{ name: 'reports/acme-weekly.html', bytes: 2048 }] });
    expect(svc.runFiles(sam, 'run1').ok).toBe(false);
  });

  it('reads a file by its listed name, never by a path from the request', () => {
    const { svc, read } = harness();
    const got = svc.runFile(pat, 'run1', 'reports/acme-weekly.html');
    expect(got.ok && got.data.toString()).toBe('<h1>Weekly</h1>');
    expect(svc.runFile(pat, 'run1', '/etc/passwd').ok).toBe(false);
    expect(svc.runFile(pat, 'run1', 'review.md').ok).toBe(false);
    expect(svc.runFile(sam, 'run1', 'reports/acme-weekly.html').ok).toBe(false);
    expect(read).toEqual(['/data/coordinators/run1/reports/acme-weekly.html']);
  });
});
