// Pure filter/sort helpers for the flow library list — kept separate from
// the component so the toolbar counts and the list can never disagree, and
// so the rules are testable without a DOM.

import { flowOrigin, flowStarKey, type Flow } from '@shared/flows/schema';
import { flowHasTags, flowMatchesQuery } from './flowGrouping';

export type FlowScope =
  | 'all' | 'starred' | 'mine' | 'project' | 'installed' | 'generated' | 'archived';
export type FlowSort = 'usage' | 'name' | 'recent' | 'steps';

export interface FlowUsage { count: number; lastAt: number }

export const SCOPES: Array<{ key: FlowScope; label: string }> = [
  { key: 'all', label: 'All' },
  { key: 'starred', label: 'Starred' },
  { key: 'mine', label: 'Yours' },
  { key: 'project', label: 'Project' },
  { key: 'installed', label: 'Installed' },
  { key: 'generated', label: 'Generated' },
  { key: 'archived', label: 'Archived' },
];

export const SORTS: Array<{ key: FlowSort; label: string }> = [
  { key: 'usage', label: 'Most used' },
  { key: 'recent', label: 'Recently run' },
  { key: 'name', label: 'Name' },
  { key: 'steps', label: 'Steps' },
];

interface ScopeOpts {
  starred: readonly string[];
  installed: ReadonlyArray<{ filename: string }> | undefined;
}

/// `all` deliberately excludes archived AND worker-generated flows: those
/// two buckets are the clutter the scopes exist to hold back.
export function flowInScope(flow: Flow, scope: FlowScope, opts: ScopeOpts): boolean {
  if (flow.archived) return scope === 'archived';
  if (flow.source === 'generated') return scope === 'generated';
  if (scope === 'archived' || scope === 'generated') return false;
  if (scope === 'all') return true;
  if (scope === 'starred') return opts.starred.includes(flowStarKey(flow));
  return flowOrigin(flow, opts.installed) === scope;
}

export function filterFlows(
  flows: readonly Flow[],
  opts: ScopeOpts & { scope: FlowScope; query: string; tags: ReadonlySet<string> },
): Flow[] {
  return flows.filter(
    (f) =>
      flowInScope(f, opts.scope, opts) &&
      flowMatchesQuery(f, opts.query) &&
      flowHasTags(f, opts.tags),
  );
}

export function scopeCounts(
  flows: readonly Flow[],
  opts: ScopeOpts & { query: string; tags: ReadonlySet<string> },
): Record<FlowScope, number> {
  const out = {} as Record<FlowScope, number>;
  for (const s of SCOPES) {
    out[s.key] = filterFlows(flows, { ...opts, scope: s.key }).length;
  }
  return out;
}

export function sortFlows(
  flows: readonly Flow[],
  sort: FlowSort,
  usage: Record<string, FlowUsage>,
): Flow[] {
  const byName = (a: Flow, b: Flow) => a.name.localeCompare(b.name);
  return [...flows].sort((a, b) => {
    if (sort === 'name') return byName(a, b);
    if (sort === 'steps') return b.steps.length - a.steps.length || byName(a, b);
    if (sort === 'recent') {
      return (usage[b.id]?.lastAt ?? 0) - (usage[a.id]?.lastAt ?? 0) || byName(a, b);
    }
    return (usage[b.id]?.count ?? 0) - (usage[a.id]?.count ?? 0) || byName(a, b);
  });
}
