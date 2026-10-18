import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_ORG_POLICY, type OrgPolicy } from '../../shared/org/policy';
import { runHousekeeping, type HousekeepingWorker } from './housekeeping';
import { applyRetention, auditCsv } from './retention';
import { fleetStatus } from './fleet';
import type { AuditEntry } from './orgStores';

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 9, 20, 12);
const savedTz = process.env.TZ;
afterEach(() => {
  if (savedTz === undefined) delete process.env.TZ;
  else process.env.TZ = savedTz;
});

function harness(policy: Partial<OrgPolicy>, workers: HousekeepingWorker[], opts: { zoneFromOrg?: boolean } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'overcli-hk-'));
  let pool = 100;
  const sent: string[] = [];
  const logs: string[] = [];
  let rearmed = 0;
  let audit: AuditEntry[] = [];
  const deps = {
    policy: () => ({ ...DEFAULT_ORG_POLICY, admins: ['U0ACMEBOSS'], ...policy }),
    workers: () => workers,
    managerSlackId: (id: string) => (id === 'w1' ? 'U0ACMEPAT' : undefined),
    pool: { get: () => pool, set: (usd: number) => ((pool = usd), { ok: true }) },
    rearm: () => rearmed++,
    notify: (to: string[], title: string) => sent.push(`${to.join(',')}:${title}`),
    audit: {
      append: (e: AuditEntry) => audit.push(e),
      recent: () => audit,
      prune: (before: number) => {
        const n = audit.length;
        audit = audit.filter((e) => e.at >= before);
        return n - audit.length;
      },
    },
    runs: { list: () => [], delete: () => ({ ok: true }) },
    stateFile: path.join(dir, 'hk.json'),
    log: (m: string) => logs.push(m),
    zoneFromOrg: opts.zoneFromOrg ?? true,
    now: () => NOW,
  };
  return { deps, sent, logs, pool: () => pool, rearmed: () => rearmed, audit: () => audit, setAudit: (a: AuditEntry[]) => (audit = a) };
}

const w = (id: string, budget: number, spent: number, enabled = true): HousekeepingWorker => ({ id, name: id.toUpperCase(), enabled, budgetUSDPerMonth: budget, spentThisMonthUSD: spent });

describe('housekeeping', () => {
  it('sizes the pool to the org budget, or to every worker\'s budget without one', () => {
    const capped = harness({ orgBudgetUSD: 500 }, [w('w1', 50, 0)]);
    runHousekeeping(capped.deps);
    expect(capped.pool()).toBe(500);
    const open = harness({}, [w('w1', 50, 0), w('w2', 70, 0), w('w3', 999, 0, false)]);
    runHousekeeping(open.deps);
    expect(open.pool()).toBe(120);
  });

  it('warns a manager once a month when a worker passes the threshold, and the admins for the org', () => {
    const h = harness({ orgBudgetUSD: 100, alertAtPercent: 80 }, [w('w1', 50, 45), w('w2', 50, 40)]);
    runHousekeeping(h.deps);
    runHousekeeping(h.deps);
    expect(h.sent).toEqual(['U0ACMEPAT:W1 has used 90% of its budget', "U0ACMEBOSS:The org's workers have used 85% of the monthly budget"]);
  });

  it('says nothing with warnings off', () => {
    const h = harness({ alertAtPercent: 0 }, [w('w1', 50, 50)]);
    runHousekeeping(h.deps);
    expect(h.sent).toEqual([]);
  });

  it('follows the org time zone while running, unless the operator set TZ', () => {
    process.env.TZ = 'UTC';
    const h = harness({ timezone: 'America/New_York' }, []);
    runHousekeeping(h.deps);
    expect(process.env.TZ).toBe('America/New_York');
    expect(h.rearmed()).toBe(1);
    runHousekeeping(h.deps);
    expect(h.rearmed()).toBe(1);
    process.env.TZ = 'UTC';
    const theirs = harness({ timezone: 'America/New_York' }, [], { zoneFromOrg: false });
    runHousekeeping(theirs.deps);
    expect(process.env.TZ).toBe('UTC');
  });

  it('prunes the decision log past the retention, once a day', () => {
    const h = harness({ retentionDays: 30 }, []);
    h.setAudit([{ at: NOW - 40 * DAY, by: 'Bo', what: 'Old.' }, { at: NOW - DAY, by: 'Bo', what: 'New.' }]);
    runHousekeeping(h.deps);
    expect(h.audit().map((e) => e.what)).toEqual(['New.']);
  });
});

describe('retention', () => {
  it('deletes only finished runs older than the window, through the runtime', () => {
    const deleted: string[] = [];
    const run = (id: string, kind: string, age: number) => ({ id, createdAt: NOW - age * DAY, state: { kind } }) as never;
    applyRetention({
      policy: () => ({ ...DEFAULT_ORG_POLICY, retentionDays: 30 }),
      audit: { append: () => {}, recent: () => [] },
      runs: { list: () => [run('old', 'done', 40), run('new', 'done', 2), run('stuck', 'paused', 90)], delete: (id) => (deleted.push(id), { ok: true }) },
      now: () => NOW,
    });
    expect(deleted).toEqual(['old']);
  });

  it('writes a spreadsheet a formula cannot hide in', () => {
    const csv = auditCsv([{ at: NOW, by: 'Bo', what: '=HYPERLINK("x")' }, { at: NOW, by: 'Pat, Lee', what: 'Hired Ana.' }]);
    expect(csv.split('\r\n')[1]).toContain(`"'=HYPERLINK(""x"")"`);
    expect(csv.split('\r\n')[2]).toContain('"Pat, Lee"');
  });
});

describe('other servers', () => {
  it('reads each server\'s health with its token, and says which are not connected', async () => {
    const seen: string[] = [];
    const fetchImpl = async (url: string, init?: RequestInit) => {
      seen.push(`${url}:${(init?.headers as Record<string, string>).Authorization}`);
      return Response.json({ ok: true, org: { name: 'Acme Sales' }, spend: { spentUSD: 42, orgBudgetUSD: 300 }, items: [{ name: 'Slack', ok: false, detail: 'Not connected.' }, { name: 'Workers', ok: true, detail: '3 working' }] });
    };
    const out = await fleetStatus(
      [{ name: 'Sales', url: 'https://sales.acme.example' }, { name: 'Ops', url: 'https://ops.acme.example' }, { name: 'Plain', url: 'http://plain.acme.example' }],
      { 'https://sales.acme.example': 'ocli_s', 'http://plain.acme.example': 'ocli_p' },
      fetchImpl as never,
    );
    expect(seen).toEqual(['https://sales.acme.example/api/admin/health:Bearer ocli_s']);
    expect(out[0]).toMatchObject({ connected: true, ok: false, org: 'Acme Sales', spentUSD: 42, orgBudgetUSD: 300, workers: '3 working', problems: ['Slack: Not connected.'] });
    expect(out[1]).toMatchObject({ connected: false });
    expect(out[2]).toMatchObject({ ok: false, error: expect.stringMatching(/https/) });
  });
});
