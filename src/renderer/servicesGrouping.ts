// How the list is arranged: by group, with copies kept beside the service
// they copy.
//
// Both halves are the user's own structure rather than ours. `group` is free
// text — the useful grouping in one shop ("Processors", "MCP servers") is
// meaningless in the next, and a fixed list would be wrong everywhere. Copies
// stay together because five services off one Gradle module are one thing
// with five configurations; the list shows them as plain rows, the way Tilt
// does, rather than under a header of their own.
//
// Pure, so the ordering rules are testable without a pane around them.

import type { ServiceSpec } from '@shared/services';

export interface GroupEntry {
  /// The service, or the base a set of copies share.
  spec: ServiceSpec;
  /// Copies of it, in the order they were added. Empty for an ordinary
  /// service.
  copies: ServiceSpec[];
}

export interface ServiceGroup {
  name: string;
  entries: GroupEntry[];
  /// Services in the group, copies included — what the header counts.
  count: number;
}

/// Services with no group of their own land here rather than in a group called
/// "undefined".
export const UNGROUPED = 'Other';

/// Arrange services into groups, nesting copies under their base.
///
/// Group order follows first appearance, so the order services were added in
/// is the order they stay in — stable, and nobody has to learn a sort.
export function groupServices(services: readonly ServiceSpec[]): ServiceGroup[] {
  const byId = new Map(services.map((s) => [s.id, s]));
  const copiesByBase = new Map<string, ServiceSpec[]>();

  for (const spec of services) {
    if (!spec.copyOf) continue;
    // A copy whose base has been removed is an ordinary service again, not an
    // orphan that vanishes from the list.
    if (!byId.has(spec.copyOf)) continue;
    const list = copiesByBase.get(spec.copyOf) ?? [];
    list.push(spec);
    copiesByBase.set(spec.copyOf, list);
  }

  const groups: ServiceGroup[] = [];
  const index = new Map<string, ServiceGroup>();

  for (const spec of services) {
    // A copy is rendered under its base, not on its own.
    if (spec.copyOf && byId.has(spec.copyOf)) continue;

    const copies = copiesByBase.get(spec.id) ?? [];
    // A base takes its group from its own field; the copies may each say
    // something different, but the set belongs where the base is.
    const name = spec.group?.trim() || UNGROUPED;
    let group = index.get(name);
    if (!group) {
      group = { name, entries: [], count: 0 };
      index.set(name, group);
      groups.push(group);
    }
    group.entries.push({ spec, copies });
    group.count += 1 + copies.length;
  }

  return groups;
}

/// The services that actually run: a base with copies is the module they
/// share, not something to start on its own, so the list never shows it and
/// nothing that offers to start services should either.
export function runnableServices<T extends Pick<ServiceSpec, 'id' | 'copyOf'>>(services: readonly T[]): T[] {
  const ids = new Set(services.map((s) => s.id));
  const bases = new Set(services.flatMap((s) => (s.copyOf && ids.has(s.copyOf) ? [s.copyOf] : [])));
  return services.filter((s) => !bases.has(s.id));
}

/// Every group name in use, for the picker when someone is filing a service.
export function groupNames(services: readonly ServiceSpec[]): string[] {
  const names = new Set<string>();
  for (const spec of services) {
    const name = spec.group?.trim();
    if (name) names.add(name);
  }
  return [...names].sort((a, b) => a.localeCompare(b));
}
