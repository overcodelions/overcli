// Who a worker's month went on. A run's cost is charged to the worker that ran
// it. Here each run is traced back to why it ran: someone's ask, or a team task
// someone gave. What can't be traced is its own schedule, its manager's own
// work, or a run from before runs recorded where they came from.

/// One finished run's cost, from the run summaries.
export interface RunCost {
  id: string;
  workerId: string;
  costUSD: number;
  parentOrchestrationId?: string;
}

export interface SpendAsk {
  workerId: string;
  orchestrationId?: string;
  by: string;
  slackUserId?: string;
}

export interface SpendTeamRun {
  runId: string;
  teamName: string;
  by?: string;
  slackUserId?: string;
}

export interface WorkerUser {
  /// A person, or a team's task on behalf of one.
  label: string;
  by: string;
  slackUserId?: string;
  spentUSD: number;
}

const personKey = (p: { by: string; slackUserId?: string }) => p.slackUserId ?? `name:${p.by.trim().toLowerCase()}`;

/// Each worker's month by who caused it, biggest first. Runs traced to nobody
/// aren't listed: they're what's left of the worker's total.
export function usersByWorker(runs: readonly RunCost[], asks: readonly SpendAsk[], teamRuns: readonly SpendTeamRun[]): Map<string, WorkerUser[]> {
  const askBy = new Map<string, SpendAsk>();
  for (const a of asks) if (a.orchestrationId) askBy.set(a.orchestrationId, a);
  const teamBy = new Map(teamRuns.map((t) => [t.runId, t]));
  const out = new Map<string, Map<string, WorkerUser>>();
  for (const r of runs) {
    const team = teamBy.get(r.id);
    const ask = r.parentOrchestrationId ? askBy.get(r.parentOrchestrationId) : undefined;
    const who = team?.by ? { by: team.by, slackUserId: team.slackUserId } : ask;
    if (!who && !team) continue;
    const by = who?.by ?? 'someone';
    const key = team ? `team:${team.teamName}:${personKey({ by, slackUserId: who?.slackUserId })}` : personKey({ by, slackUserId: who?.slackUserId });
    const users = out.get(r.workerId) ?? new Map<string, WorkerUser>();
    const row = users.get(key) ?? { label: team ? `${team.teamName}, for ${by}` : by, by, ...(who?.slackUserId ? { slackUserId: who.slackUserId } : {}), spentUSD: 0 };
    row.spentUSD += r.costUSD;
    users.set(key, row);
    out.set(r.workerId, users);
  }
  return new Map([...out].map(([id, users]) => [id, [...users.values()].sort((a, b) => b.spentUSD - a.spentUSD)]));
}

/// What one person has cost one worker this month, across their asks and the
/// team tasks they gave.
export function personSpendOn(users: readonly WorkerUser[] | undefined, person: { name: string; slackUserId?: string }): number {
  const key = personKey({ by: person.name, slackUserId: person.slackUserId });
  return (users ?? []).filter((u) => personKey(u) === key).reduce((sum, u) => sum + u.spentUSD, 0);
}

/// Where someone stands against the limit on a worker that isn't theirs.
export function limitState(spentUSD: number, limitUSD: number | null, alertAtPercent: number): 'ok' | 'warn' | 'stop' {
  if (limitUSD === null) return 'ok';
  if (spentUSD >= limitUSD) return 'stop';
  return alertAtPercent > 0 && spentUSD >= limitUSD * (alertAtPercent / 100) ? 'warn' : 'ok';
}

/// One manager's row on an org's budgets: what they've committed against what
/// they may, and what's been spent. Who has no Slack id has no allowance to set.
export interface ManagerBudget {
  name: string;
  slackUserId?: string;
  /// They answer to no allowance: an admin, or nobody the rule can name.
  exempt: boolean;
  allowanceUSD?: number;
  /// Set just for them, rather than the org's default.
  ownAllowance: boolean;
  capsUSD: number;
  spentUSD: number;
  paceUSD?: number;
  over: boolean;
  workerIds: string[];
}

/// Workers grouped by who answers for them, biggest commitment first.
export function managerBudgets(
  workers: ReadonlyArray<{ id: string; manager?: string; managerSlackUserId?: string; capUSD: number; spentUSD: number }>,
  rules: { allowanceFor(slackUserId: string): number; ownAllowance(slackUserId: string): boolean; isAdmin(slackUserId: string): boolean },
  now: number,
): ManagerBudget[] {
  const rows = new Map<string, ManagerBudget>();
  for (const w of workers) {
    const id = w.managerSlackUserId;
    const key = id ?? `name:${w.manager ?? ''}`;
    const exempt = !id || rules.isAdmin(id);
    const row = rows.get(key) ?? {
      name: w.manager ?? 'No manager',
      ...(id ? { slackUserId: id } : {}),
      exempt,
      ...(id && !exempt ? { allowanceUSD: rules.allowanceFor(id) } : {}),
      ownAllowance: !!id && rules.ownAllowance(id),
      capsUSD: 0,
      spentUSD: 0,
      over: false,
      workerIds: [],
    };
    row.capsUSD += w.capUSD;
    row.spentUSD += w.spentUSD;
    row.workerIds.push(w.id);
    rows.set(key, row);
  }
  return [...rows.values()]
    .map((r) => {
      const pace = paceFor(r.spentUSD, now);
      return { ...r, ...(pace !== null ? { paceUSD: pace } : {}), over: r.allowanceUSD !== undefined && r.capsUSD > r.allowanceUSD };
    })
    .sort((a, b) => b.capsUSD - a.capsUSD || a.name.localeCompare(b.name));
}

/// Where the month ends at this rate. Null in its first two days: a day's
/// spend says little about a month.
export function paceFor(spentUSD: number, now: number): number | null {
  const d = new Date(now);
  const start = new Date(d.getFullYear(), d.getMonth(), 1).getTime();
  const end = new Date(d.getFullYear(), d.getMonth() + 1, 1).getTime();
  const elapsed = now - start;
  if (elapsed < 2 * 86_400_000) return null;
  return spentUSD * ((end - start) / elapsed);
}

/// A run's cost and when it finished.
export interface DatedRunCost {
  workerId: string;
  costUSD: number;
  at: number;
}

export interface SpendDay {
  /// The viewer's calendar day, YYYY-MM-DD.
  date: string;
  totalUSD: number;
  /// Largest first.
  byWorker: Array<{ workerId: string; costUSD: number }>;
}

/// The longest range the chart draws, in days.
export const MAX_SPEND_DAYS = 366;

const DAY_MS = 86_400_000;
const YMD = /^\d{4}-\d{2}-\d{2}$/;

/// The instants a range of the viewer's days covers. `tzOffsetMin` is as
/// `Date#getTimezoneOffset` gives it: minutes behind UTC (New York is 300).
/// Null when the dates aren't real, run backwards or span too long.
export function spendDayWindow(from: string, to: string, tzOffsetMin: number): { fromMs: number; toMs: number; days: number } | null {
  if (!YMD.test(from) || !YMD.test(to) || !Number.isFinite(tzOffsetMin) || Math.abs(tzOffsetMin) > 14 * 60) return null;
  const a = Date.parse(`${from}T00:00:00Z`);
  const b = Date.parse(`${to}T00:00:00Z`);
  if (Number.isNaN(a) || Number.isNaN(b) || b < a) return null;
  if (new Date(a).toISOString().slice(0, 10) !== from || new Date(b).toISOString().slice(0, 10) !== to) return null;
  const days = Math.round((b - a) / DAY_MS) + 1;
  if (days > MAX_SPEND_DAYS) return null;
  const shift = tzOffsetMin * 60_000;
  return { fromMs: a + shift, toMs: b + DAY_MS + shift, days };
}

/// Spend per day over the range, every day present (a quiet day is zero).
export function spendByDay(runs: readonly DatedRunCost[], from: string, to: string, tzOffsetMin: number): SpendDay[] {
  const win = spendDayWindow(from, to, tzOffsetMin);
  if (!win) return [];
  const start = Date.parse(`${from}T00:00:00Z`);
  const days = new Map<string, Map<string, number>>();
  const order: string[] = [];
  for (let i = 0; i < win.days; i++) {
    const d = new Date(start + i * DAY_MS).toISOString().slice(0, 10);
    order.push(d);
    days.set(d, new Map());
  }
  for (const r of runs) {
    if (r.at < win.fromMs || r.at >= win.toMs) continue;
    const d = new Date(r.at - tzOffsetMin * 60_000).toISOString().slice(0, 10);
    const per = days.get(d);
    if (per) per.set(r.workerId, (per.get(r.workerId) ?? 0) + r.costUSD);
  }
  return order.map((date) => {
    const per = days.get(date)!;
    const byWorker = [...per].map(([workerId, costUSD]) => ({ workerId, costUSD })).sort((x, y) => y.costUSD - x.costUSD);
    return { date, totalUSD: byWorker.reduce((n, w) => n + w.costUSD, 0), byWorker };
  });
}
