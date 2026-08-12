// Grouping + filtering for the flow library, shared by the Flows tab and the
// welcome-screen gallery so both slice the same list the same way.
//
// The axis is PROVENANCE, not tags. Once a handful of registry flows are
// installed, a flat alphabetical grid buries the two flows you wrote
// yourself among twenty you downloaded — and "which ones are mine" is the
// question actually being asked. Tags are the secondary filter on top.

import { flowOrigin, flowStarKey, type Flow } from '@shared/flows/schema';

export type FlowGroupKey = 'starred' | 'mine' | 'project' | 'installed';

export interface FlowGroup {
  key: FlowGroupKey;
  title: string;
  /// Shown under the heading when the group is empty of explanation —
  /// keeps "Installed" from reading as a mystery bucket.
  hint?: string;
  flows: Flow[];
}

const GROUP_ORDER: Array<{ key: FlowGroupKey; title: string; hint?: string }> = [
  { key: 'starred', title: 'Starred' },
  { key: 'mine', title: 'Yours', hint: 'Flows you built' },
  { key: 'project', title: 'This project', hint: 'From .overcli/flows' },
  { key: 'installed', title: 'Installed', hint: 'From a flow registry' },
];

/// Free-text match over the fields a user would plausibly type: name,
/// description, tags, and the step ids that make up the pipeline (the
/// gallery cards show those, so searching for what you can see should
/// work). Case-insensitive substring, no fuzzy scoring — a flow library is
/// tens of entries, not thousands, and predictable beats clever.
export function flowMatchesQuery(flow: Flow, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  const haystack = [
    flow.name,
    flow.id,
    flow.description ?? '',
    ...(flow.tags ?? []),
    ...flow.steps.map((s) => s.id),
  ]
    .join(' ')
    .toLowerCase();
  return q.split(/\s+/).every((term) => haystack.includes(term));
}

/// Same matcher, against a registry index entry. Kept next to
/// `flowMatchesQuery` so one search box can rank local and remote flows by
/// identical rules — a query that finds a flow you have should find the
/// same flow published.
export function registryEntryMatchesQuery(
  entry: { name: string; id: string; description?: string; tags?: string[] },
  query: string,
): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  const haystack = [entry.name, entry.id, entry.description ?? '', ...(entry.tags ?? [])]
    .join(' ')
    .toLowerCase();
  return q.split(/\s+/).every((term) => haystack.includes(term));
}

/// Which registry entries the user actually HAS, as `registryId:id` keys.
///
/// Intersected with the loaded library rather than read straight from
/// settings: `installedRegistryFlows` is bookkeeping that can outlive the
/// file it describes (a flow deleted outside the app, a userData restored
/// from backup). Trusting it alone marks a flow you no longer have as
/// installed and hides it from search — which is exactly when you'd want
/// to reinstall it.
export function installedRegistryKeys(
  flows: readonly Flow[],
  installed: ReadonlyArray<{ filename: string; registryId: string; id: string }> | undefined,
): Set<string> {
  const onDisk = new Set(flows.map((f) => `${f.id}.yaml`));
  return new Set(
    (installed ?? [])
      .filter((i) => onDisk.has(i.filename))
      .map((i) => `${i.registryId}:${i.id}`),
  );
}

export function flowHasTags(flow: Flow, tags: ReadonlySet<string>): boolean {
  if (tags.size === 0) return true;
  const own = new Set(flow.tags ?? []);
  for (const t of tags) if (!own.has(t)) return false;
  return true;
}

/// Tag -> number of local flows carrying it, for the filter chips. Only
/// tags that exist locally are offered, so the chip row never shows a
/// filter that would empty the list.
export function flowTagCounts(flows: readonly Flow[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const f of flows) {
    for (const t of f.tags ?? []) counts.set(t, (counts.get(t) ?? 0) + 1);
  }
  return counts;
}

export function groupFlows(
  flows: readonly Flow[],
  opts: {
    starred: readonly string[];
    installed: ReadonlyArray<{ filename: string }> | undefined;
    query?: string;
    tags?: ReadonlySet<string>;
  },
): FlowGroup[] {
  const starredKeys = new Set(opts.starred);
  const query = opts.query ?? '';
  const tags = opts.tags ?? new Set<string>();

  const buckets = new Map<FlowGroupKey, Flow[]>(
    GROUP_ORDER.map((g) => [g.key, [] as Flow[]]),
  );
  for (const flow of flows) {
    if (!flowMatchesQuery(flow, query) || !flowHasTags(flow, tags)) continue;
    // Starring is a promotion, not a category: a starred flow leaves its
    // origin group entirely so it appears exactly once, at the top.
    const origin = flowOrigin(flow, opts.installed);
    const key: FlowGroupKey = starredKeys.has(flowStarKey(flow)) ? 'starred' : origin;
    buckets.get(key)!.push(flow);
  }

  return GROUP_ORDER.map((g) => ({
    ...g,
    flows: buckets.get(g.key)!.sort((a, b) => a.name.localeCompare(b.name)),
  })).filter((g) => g.flows.length > 0);
}
