// What the org keeps, and for how long.
//
// `retentionDays` in org.json bounds the decision log and finished runs. Run
// once a day by `serve`. A run is only ever deleted through the runtime's own
// delete, which refuses one whose worktree still holds unreviewed work — so
// retention never throws away something nobody has looked at.

import type { FlowRun } from '../../shared/flows/schema';
import type { OrgPolicy } from '../../shared/org/policy';
import type { AuditStore } from './orgStores';

const DAY_MS = 24 * 60 * 60 * 1000;

export interface RetentionDeps {
  policy(): OrgPolicy;
  audit: AuditStore;
  runs: {
    list(): FlowRun[];
    delete(runId: string): { ok: boolean };
  };
  now?(): number;
}

export function applyRetention(deps: RetentionDeps): { auditEntries: number; runs: number } {
  const days = deps.policy().retentionDays;
  if (!days) return { auditEntries: 0, runs: 0 };
  const cutoff = (deps.now?.() ?? Date.now()) - days * DAY_MS;
  const auditEntries = deps.audit.prune?.(cutoff) ?? 0;
  let runs = 0;
  for (const run of deps.runs.list()) {
    const finished = run.state.kind === 'done' || run.state.kind === 'aborted';
    if (!finished || run.createdAt >= cutoff) continue;
    if (deps.runs.delete(run.id).ok) runs++;
  }
  return { auditEntries, runs };
}

/// The decision log as a spreadsheet: one row per decision, oldest first.
export function auditCsv(entries: ReadonlyArray<{ at: number; by: string; slackUserId?: string; what: string }>): string {
  const cell = (v: string) => (/[",\n\r]/.test(v) || /^[=+\-@]/.test(v) ? `"${(/^[=+\-@]/.test(v) ? "'" : '') + v.replace(/"/g, '""')}"` : v);
  const rows = entries.map((e) => [new Date(e.at).toISOString(), e.by, e.slackUserId ?? '', e.what].map(cell).join(','));
  return ['When (UTC),Who,Slack member ID,What', ...rows].join('\r\n') + '\r\n';
}
