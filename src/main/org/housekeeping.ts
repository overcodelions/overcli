// What `serve` does on its own, every few minutes, for the org.
//
//   - The org's time zone: org.json's `timezone` is applied while running, and
//     the schedules re-armed, so a changed zone does not wait for a restart.
//     Only when the zone came from org.json — an operator's TZ always wins.
//   - The shared pool: the org-wide budget, or, without one, what every
//     worker together is allowed — so a new hire is never starved by a pool
//     sized for the roster as it was the day the server first started.
//   - Spend warnings: a worker's manager when it passes `alertAtPercent` of
//     its budget, the admins when the org does. Once a month each.
//   - Retention, once a day.

import fs from 'node:fs';
import path from 'node:path';
import type { OrgPolicy } from '../../shared/org/policy';
import type { FlowRun } from '../../shared/flows/schema';
import { applyRetention } from './retention';
import type { AuditStore } from './orgStores';

export const HOUSEKEEPING_EVERY_MS = 5 * 60 * 1000;

export interface HousekeepingWorker {
  id: string;
  name: string;
  enabled: boolean;
  budgetUSDPerMonth: number;
  spentThisMonthUSD: number;
}

export interface HousekeepingDeps {
  policy(): OrgPolicy;
  workers(): HousekeepingWorker[];
  managerSlackId(workerId: string): string | undefined;
  pool: { get(): number; set(monthlyUSD: number): { ok: boolean } };
  /// Re-arm every schedule against the clock as it now reads.
  rearm(): void;
  notify(to: string[], title: string, body: string): void;
  audit: AuditStore;
  runs: { list(): FlowRun[]; delete(runId: string): { ok: boolean } };
  /// Where to remember which warnings went out this month.
  stateFile: string;
  log(message: string): void;
  /// Whether TZ was set from org.json at start (and so may follow it).
  zoneFromOrg: boolean;
  now?(): number;
}

interface AlertState {
  month: string;
  sent: string[];
  retentionDay?: string;
}

const monthKey = (ms: number) => new Date(ms).toISOString().slice(0, 7);
const dayKey = (ms: number) => new Date(ms).toISOString().slice(0, 10);

export function runHousekeeping(deps: HousekeepingDeps): void {
  const now = deps.now?.() ?? Date.now();
  const policy = deps.policy();

  if (deps.zoneFromOrg && policy.timezone && process.env.TZ !== policy.timezone) {
    const was = process.env.TZ;
    process.env.TZ = policy.timezone;
    deps.rearm();
    deps.log(`org: time zone is now ${policy.timezone}${was ? ` (was ${was})` : ''}; schedules re-armed.`);
  }

  const workers = deps.workers();
  const pool = policy.orgBudgetUSD ?? workers.filter((w) => w.enabled).reduce((sum, w) => sum + w.budgetUSDPerMonth, 0);
  if (pool > 0 && Math.abs(deps.pool.get() - pool) > 0.005) deps.pool.set(Math.round(pool * 100) / 100);

  const state = readState(deps.stateFile, monthKey(now));
  const before = state.sent.length;
  const pct = policy.alertAtPercent;
  if (pct > 0) {
    for (const w of workers) {
      if (!w.enabled || w.budgetUSDPerMonth <= 0) continue;
      const share = (w.spentThisMonthUSD / w.budgetUSDPerMonth) * 100;
      const key = `worker:${w.id}`;
      if (share < pct || state.sent.includes(key)) continue;
      const to = deps.managerSlackId(w.id);
      if (!to) continue;
      state.sent.push(key);
      deps.notify(
        [to],
        `${w.name} has used ${Math.floor(share)}% of its budget`,
        `$${w.spentThisMonthUSD.toFixed(2)} of $${w.budgetUSDPerMonth.toFixed(0)} this month. At its budget it stops until the month turns, unless you raise it.`,
      );
    }
    const cap = policy.orgBudgetUSD;
    if (cap) {
      const spent = workers.reduce((sum, w) => sum + w.spentThisMonthUSD, 0);
      const share = (spent / cap) * 100;
      if (share >= pct && !state.sent.includes('org') && policy.admins.length) {
        state.sent.push('org');
        deps.notify(
          policy.admins,
          `The org's workers have used ${Math.floor(share)}% of the monthly budget`,
          `$${spent.toFixed(2)} of $${cap.toFixed(0)}. At the cap, scheduled runs stop until the month turns. Raise it on Admin → Rules, or pause some workers.`,
        );
      }
    }
  }

  if (policy.retentionDays && state.retentionDay !== dayKey(now)) {
    state.retentionDay = dayKey(now);
    const gone = applyRetention({ policy: () => policy, audit: deps.audit, runs: deps.runs, now: () => now });
    if (gone.auditEntries || gone.runs) {
      deps.log(`org: retention removed ${gone.auditEntries} decision log entr${gone.auditEntries === 1 ? 'y' : 'ies'} and ${gone.runs} finished run${gone.runs === 1 ? '' : 's'} older than ${policy.retentionDays} days.`);
    }
    writeState(deps.stateFile, state);
  } else if (state.sent.length !== before) {
    writeState(deps.stateFile, state);
  }
}

export function startHousekeeping(deps: HousekeepingDeps): { stop(): void } {
  const tick = () => {
    try {
      runHousekeeping(deps);
    } catch (err) {
      deps.log(`org: housekeeping failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  };
  tick();
  const timer = setInterval(tick, HOUSEKEEPING_EVERY_MS);
  timer.unref?.();
  return { stop: () => clearInterval(timer) };
}

function readState(file: string, month: string): AlertState {
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as AlertState;
    if (raw && raw.month === month && Array.isArray(raw.sent)) return raw;
    return { month, sent: [], ...(raw?.retentionDay ? { retentionDay: raw.retentionDay } : {}) };
  } catch {
    return { month, sent: [] };
  }
}

function writeState(file: string, state: AlertState): void {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(state), { mode: 0o600 });
    fs.renameSync(tmp, file);
  } catch {
    // A warning sent twice is better than a server that stops for a disk error.
  }
}
