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
import { mcpServerKey } from '../../shared/flows/toolScope';

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
  /// Its job description: what says a tool is meant for its runs.
  job?: string;
  /// Its flows' steps: the tools each lists (absent: it may use any) and
  /// the step's own instructions.
  flows?: Array<{ name: string; steps: Array<{ id: string; tools?: string[]; text: string }> }>;
}

export type OrgTuningAction =
  | { kind: 'giveTool'; tool: string; workerIds: string[] }
  | { kind: 'clearTool'; tool: string }
  | { kind: 'useOwnTools'; workerIds: string[] }
  | { kind: 'alwaysAllowStep'; workerId: string; key: string }
  | { kind: 'shareWorker'; workerId: string; people: string[] }
  /// A flow change, not a switch: opens the worker's own Tuning with `ask`.
  | { kind: 'tuneFlow'; workerId: string; tool: string; ask: string };

/// Someone asked the Slack front door for a worker by name that isn't
/// shared with them, so it went to another worker.
export interface OrgTuningMiss {
  workerId: string;
  /// Their Slack id, and their name as read then.
  user: string;
  by: string;
  at: number;
}

/// Asked for a worker they can't use at least this many times…
export const MISS_MIN_ASKS = 2;

export interface OrgTuningSuggestion {
  /// Stable while the problem stands: what Apply names.
  id: string;
  title: string;
  why: string;
  /// The button's words.
  apply: string;
  action: OrgTuningAction;
  runs: number;
  /// What `runs` counts, when not runs.
  unit?: 'asks';
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
  /// Asks for a worker that still isn't shared with the asker.
  missed?: OrgTuningMiss[];
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

  // ---- Workers people ask for by name but can't use ----
  // Each such ask went to some other worker, often one that does a worse
  // job of it, and the person may never learn why.
  const wanted = new Map<string, Map<string, { by: string; n: number; lastAt: number }>>();
  for (const m of input.missed ?? []) {
    if (m.at < since || !byId.has(m.workerId)) continue;
    const people = wanted.get(m.workerId) ?? new Map();
    const p = people.get(m.user) ?? { by: m.by, n: 0, lastAt: 0 };
    p.n += 1;
    p.lastAt = Math.max(p.lastAt, m.at);
    p.by = m.by;
    people.set(m.user, p);
    wanted.set(m.workerId, people);
  }
  for (const [workerId, people] of wanted) {
    const askers = [...people.entries()].filter(([, p]) => p.n >= MISS_MIN_ASKS);
    if (!askers.length) continue;
    const name = byId.get(workerId)!.name;
    const who = askers.map(([, p]) => p.by);
    const n = askers.reduce((s, [, p]) => s + p.n, 0);
    out.push({
      id: `share:${workerId}:${askers.map(([u]) => u).sort().join(',')}`,
      title: `Share ${name} with ${list(who)}`,
      why: `${list(who)} asked for ${name} by name ${plural(n, 'time')} in the last ${ORG_TUNING_DAYS} days, but ${name} isn’t shared with ${who.length === 1 ? 'them' : 'them all'}, so each ask went to another worker. Sharing changes who can ask ${name}, so check with its manager first.`,
      apply: who.length === 1 ? `Share ${name} with ${who[0]}` : `Share ${name} with all ${who.length}`,
      action: { kind: 'shareWorker', workerId, people: askers.map(([u]) => u) },
      runs: n,
      unit: 'asks',
      workers: [name],
      lastAt: Math.max(...askers.map(([, p]) => p.lastAt)),
    });
  }

  // ---- A tool its job names that no step of its flow uses ----
  // Holding a tool isn't using it: a step with its own tool list and its own
  // checklist does what those say. A ranking worker's job said to read the
  // roadmap tool; its gather step listed every other tool and never that one,
  // so every run ranked without it, and the worker said it had no access.
  for (const w of input.workers) {
    const steps = (w.flows ?? []).flatMap((f) => f.steps.map((s) => ({ ...s, flow: f.name })));
    // A step with no list may use any tool it holds: nothing is skipped.
    if (!steps.length || !w.job?.trim() || steps.some((s) => s.tools === undefined)) continue;
    const mine = runs.filter((r) => r.workerId === w.id);
    if (!mine.length) continue;
    for (const tool of w.tools) {
      if (!namedIn(w.job, tool)) continue;
      const key = mcpServerKey(tool);
      const listed = steps.some((s) => (s.tools ?? []).some((t) => (parseMcpToolName(t)?.server ?? /^mcp__(.+)$/.exec(t)?.[1]) === key));
      // Named in a step that can reach outside tools; a step that only reads
      // files ("rank by its insight count") uses what another step fetched.
      if (listed || steps.some((s) => (s.tools ?? []).some((t) => t.startsWith('mcp__')) && namedIn(s.text, tool))) continue;
      const flows = [...new Set(steps.map((s) => s.flow))];
      out.push({
        id: `unused:${w.id}:${tool}`,
        title: `${w.name}’s job uses ${tool}, but no step of its flow does`,
        why: `${w.name} has ${tool} and its job says to use it, but each step of ${list(flows.map((f) => `“${f}”`))} lists its own tools and follows its own instructions, and none names ${tool}. So its runs never call it, and work that needs it goes without. Add it to the step that should use it, and say in that step what to get from it.`,
        apply: `Change ${w.name}’s flow`,
        action: {
          kind: 'tuneFlow',
          workerId: w.id,
          tool,
          ask: `My job says to use ${tool}, but no step of my flow lists it or says what to do with it, so my runs never call it. Add ${tool} to the step that gathers what the job needs from it (read calls only) and say in that step exactly what to get from it and where to record it, so later steps can use it.`,
        },
        runs: mine.length,
        workers: [w.name],
        lastAt: Math.max(...mine.map((r) => r.createdAt)),
      });
    }
  }

  return out.sort((a, b) => b.runs - a.runs || b.lastAt - a.lastAt);
}

/// Whether text names a tool: by its name, or by its last distinctive word
/// (`overapi-productboard` is the job's "Productboard").
function namedIn(text: string, tool: string): boolean {
  const t = text.toLowerCase();
  const name = tool.toLowerCase();
  if (t.includes(name)) return true;
  const last = name.split(/[^a-z0-9]+/).filter(Boolean).pop() ?? '';
  return last.length >= 6 && last !== name && new RegExp(`(^|[^a-z0-9])${last}($|[^a-z0-9])`).test(t);
}

function plural(n: number, one: string): string {
  return `${n} ${one}${n === 1 ? '' : 's'}`;
}

function list(xs: string[]): string {
  if (xs.length <= 2) return xs.join(' and ');
  if (xs.length <= 4) return `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`;
  return `${xs.slice(0, 3).join(', ')} and ${xs.length - 3} more`;
}
