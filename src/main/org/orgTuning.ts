// Setup → Tuning: what goes wrong across the org's workers, found by counting
// what their runs already record, each with the org-level fix one click away.
//
// Worker Tuning fixes one worker's job and flows. These are the problems no
// single worker's page can see or fix: a tool refused across workers, a rule
// that makes every manager ask an admin for the same thing, a step that stops
// for an OK on every run and is approved every time. A manager lost an
// afternoon to the first: his worker lacked a tool, its runs were refused,
// and nothing anywhere said "give it the tool".
//
// No model reads anything here: plain counts over the last weeks of runs, the
// same answer every time. Each suggestion is about the org as it is NOW, so
// it goes away by itself once its fix is in (the tool given, the rule set,
// the step allowed): there is nothing to dismiss or keep in step.

import { parseMcpToolName } from '../../shared/flows/mcpTools';

export const ORG_TUNING_DAYS = 30;
/// A step stopped for an OK in at least this many runs…
export const PAUSE_MIN_RUNS = 3;
/// …and was approved in at least this share of them.
export const PAUSE_APPROVED_SHARE = 0.8;

export interface OrgTuningRun {
  id: string;
  workerId: string;
  flowId: string;
  createdAt: number;
  refusedTools?: string[];
  /// Of those, the servers it had but wasn't let use in that run.
  refusedHeld?: string[];
  pausedSteps?: Array<{ stepId: string; reason: string; at: number }>;
  /// The steps it ran, in order (an attempt each).
  ranSteps: string[];
  /// A step's label by id, from its flow.
  stepLabels: Record<string, string>;
  flowName: string;
}

export interface OrgTuningWorker {
  id: string;
  name: string;
  /// Who manages it: one manager's workers share one key.
  managerKey: string;
  /// What its runs may use: its role's tools and its own.
  tools: string[];
  roleToolsAlways: boolean;
  alwaysAllow: string[];
}

export type OrgTuningAction =
  | { kind: 'giveTool'; tool: string; workerIds: string[] }
  | { kind: 'clearTool'; tool: string }
  | { kind: 'useOwnTools'; workerIds: string[] }
  | { kind: 'alwaysAllowStep'; workerId: string; key: string };

export interface OrgTuningSuggestion {
  /// Stable while the problem stands: what Apply names.
  id: string;
  title: string;
  why: string;
  /// The button's words.
  apply: string;
  action: OrgTuningAction;
  runs: number;
  workers: string[];
  lastAt: number;
}

export function orgTuning(input: {
  now: number;
  runs: OrgTuningRun[];
  workers: OrgTuningWorker[];
  /// Tools any manager may give (OrgPolicy.allowedMcpServers).
  cleared: string[];
  /// Tools installed on this server. Absent: no registry to ask, so any.
  installed?: string[];
}): OrgTuningSuggestion[] {
  const since = input.now - ORG_TUNING_DAYS * 86_400_000;
  const runs = input.runs.filter((r) => r.createdAt >= since);
  const byId = new Map(input.workers.map((w) => [w.id, w]));
  const names = (ids: Iterable<string>) => [...ids].map((id) => byId.get(id)?.name ?? 'a retired worker');
  const out: OrgTuningSuggestion[] = [];

  // ---- Tools its runs were refused ----
  const refused = new Map<string, { runs: Set<string>; workers: Set<string>; lastAt: number }>();
  for (const r of runs) {
    if (!byId.has(r.workerId)) continue;
    const servers = new Set((r.refusedTools ?? []).map((t) => parseMcpToolName(t)?.server).filter((s): s is string => !!s));
    for (const s of servers) {
      const e = refused.get(s) ?? { runs: new Set(), workers: new Set(), lastAt: 0 };
      e.runs.add(r.id);
      e.workers.add(r.workerId);
      e.lastAt = Math.max(e.lastAt, r.createdAt);
      refused.set(s, e);
    }
  }
  const installed = input.installed ? new Set(input.installed) : null;
  const cleared = new Set(input.cleared);
  for (const [tool, e] of refused) {
    const runsOf = (ids: string[]) => runs.filter((r) => ids.includes(r.workerId) && e.runs.has(r.id)).length;
    const lacking = [...e.workers].filter((id) => !byId.get(id)!.tools.includes(tool));
    // Refused one it HAD at the time (not one given since), and still not
    // let use its tools on its own.
    const heldIn = (id: string) => runs.some((r) => r.workerId === id && e.runs.has(r.id) && (r.refusedHeld ?? []).includes(tool));
    const holding = [...e.workers].filter((id) => byId.get(id)!.tools.includes(tool) && !byId.get(id)!.roleToolsAlways && heldIn(id));
    if (lacking.length && (!installed || installed.has(tool))) {
      const n = runsOf(lacking);
      const who = names(lacking);
      out.push({
        id: `give:${tool}`,
        title: `Give ${tool} to ${list(who)}`,
        why: `${plural(n, 'run')} by ${list(who)} ${n === 1 ? 'was' : 'were'} refused ${tool} in the last ${ORG_TUNING_DAYS} days because ${lacking.length === 1 ? 'it doesn’t' : 'they don’t'} have it. Nothing in a flow can fix that; giving the tool does.`,
        apply: lacking.length === 1 ? `Give ${who[0]} ${tool}` : `Give all ${lacking.length} ${tool}`,
        action: { kind: 'giveTool', tool, workerIds: lacking },
        runs: n,
        workers: who,
        lastAt: e.lastAt,
      });
      // Several managers' workers need it, and each would have to ask an
      // admin: let any manager give it.
      const managers = new Set(lacking.map((id) => byId.get(id)!.managerKey));
      if (managers.size >= 2 && !cleared.has(tool)) {
        out.push({
          id: `clear:${tool}`,
          title: `Let any manager give ${tool}`,
          why: `Workers of ${managers.size} different managers were refused ${tool}. Each of those managers has to ask an admin for it today.`,
          apply: `Let managers give ${tool}`,
          action: { kind: 'clearTool', tool },
          runs: n,
          workers: who,
          lastAt: e.lastAt,
        });
      }
    }
    if (holding.length) {
      const n = runsOf(holding);
      const who = names(holding);
      out.push({
        id: `own:${tool}:${holding.slice().sort().join(',')}`,
        title: `Let ${list(who)} use ${holding.length === 1 ? 'its' : 'their'} tools on ${holding.length === 1 ? 'its' : 'their'} own`,
        why: `${list(who)} ${holding.length === 1 ? 'has' : 'have'} ${tool}, but ${plural(n, 'run')} that started without a person’s OK ${n === 1 ? 'was' : 'were'} refused it.`,
        apply: holding.length === 1 ? `Let ${who[0]} use its tools` : `Let all ${holding.length} use their tools`,
        action: { kind: 'useOwnTools', workerIds: holding },
        runs: n,
        workers: who,
        lastAt: e.lastAt,
      });
    }
  }

  // ---- Steps that stop for an OK every time, and get it ----
  const stops = new Map<string, { workerId: string; key: string; label: string; flowName: string; paused: number; approved: number; lastAt: number }>();
  for (const r of runs) {
    const w = byId.get(r.workerId);
    if (!w) continue;
    const seen = new Set<string>();
    for (const p of r.pausedSteps ?? []) {
      // Only the outside-action stop: a flow's own checkpoint and a risky
      // step's look are meant to be looked at, whatever the record says.
      if (p.reason !== 'externalAction' || seen.has(p.stepId)) continue;
      seen.add(p.stepId);
      const key = `${r.flowId}/${p.stepId}`;
      if (w.alwaysAllow.includes(key)) continue;
      const id = `${w.id}|${key}`;
      const e = stops.get(id) ?? { workerId: w.id, key, label: r.stepLabels[p.stepId] ?? p.stepId, flowName: r.flowName, paused: 0, approved: 0, lastAt: 0 };
      e.paused += 1;
      if (r.ranSteps.includes(p.stepId)) e.approved += 1;
      e.lastAt = Math.max(e.lastAt, p.at);
      stops.set(id, e);
    }
  }
  for (const e of stops.values()) {
    if (e.paused < PAUSE_MIN_RUNS || e.approved / e.paused < PAUSE_APPROVED_SHARE) continue;
    const name = byId.get(e.workerId)!.name;
    out.push({
      id: `allow:${e.workerId}|${e.key}`,
      title: `Let ${name} run “${e.label}” without asking`,
      why: `${name} stopped for an OK before “${e.label}” (${e.flowName}) in ${plural(e.paused, 'run')}, and it was approved ${e.approved === e.paused ? 'every time' : `${e.approved} times`}. Each stop waits on a person.`,
      apply: 'Always allow this step',
      action: { kind: 'alwaysAllowStep', workerId: e.workerId, key: e.key },
      runs: e.paused,
      workers: [name],
      lastAt: e.lastAt,
    });
  }

  return out.sort((a, b) => b.runs - a.runs || b.lastAt - a.lastAt);
}

function plural(n: number, one: string): string {
  return `${n} ${one}${n === 1 ? '' : 's'}`;
}

function list(xs: string[]): string {
  if (xs.length <= 2) return xs.join(' and ');
  if (xs.length <= 4) return `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`;
  return `${xs.slice(0, 3).join(', ')} and ${xs.length - 3} more`;
}
