// The sidebar list as rows, before any of it is rendered.
//
// Groups and copies come from `groupServices`; this adds what the list does
// with them — collapsing, filtering, and saying a branch only where it tells
// you something — and the flat order a shift-click selects a range over. Pure,
// so all of that is testable without a pane around it.
//
// Your groups are the structure. A workspace usually spans many repositories,
// each on its own default branch, so a branch is only worth showing when it is
// NOT master or main: nineteen `master` chips say nothing, eight on
// `ABC-5185-…` say where the work is. When every service in a group is on the
// same feature branch, the group says it once.

import type { ServiceBinding, ServiceRuntime, ServiceSpec, StackView } from '@shared/services';
import { groupServices, type ServiceGroup } from './servicesGrouping';
import { isServiceLive, logKey } from './servicesStore';

export type StatusFilter = 'all' | 'running' | 'problems';

export interface RowItem {
  kind: 'row';
  /// `logKey(workspaceId, serviceId)` — what selection is keyed by.
  key: string;
  workspaceId: string;
  spec: ServiceSpec;
  runtime: ServiceRuntime;
  binding?: ServiceBinding;
  /// Off the default branch, and not already said by its group.
  showRef: boolean;
}

export interface HeaderItem {
  kind: 'group';
  key: string;
  workspaceId: string;
  name: string;
  /// Every row under this header, collapsed or filtered out or not — what a
  /// header's checkbox, start button and switch act on.
  rows: string[];
  running: number;
  collapsed: boolean;
  /// The feature branch every service in the group is on, if they all are.
  ref?: string;
}

export interface WorkspaceItem {
  kind: 'workspace';
  key: string;
  workspaceId: string;
  name: string;
  /// Every service in the workspace — what its switch moves.
  rows: string[];
  running: number;
  /// Folded: its groups and rows are not listed. Only while names are shown —
  /// with one workspace there is no header to unfold it from.
  collapsed: boolean;
}

export type ListItem = WorkspaceItem | HeaderItem | RowItem;

export interface ServiceList {
  items: ListItem[];
  /// Rows actually on screen, in order.
  visible: string[];
  counts: Record<StatusFilter, number>;
}

export function buildServiceList(input: {
  stacks: { name: string; stack: StackView }[];
  showWorkspaceNames: boolean;
  query: string;
  status: StatusFilter;
  collapsed: Record<string, boolean>;
}): ServiceList {
  const query = input.query.trim().toLowerCase();
  // Filtering opens everything: a match inside a collapsed group that stays
  // hidden is a filter that says "nothing" when the answer is "in there".
  const filtering = query.length > 0 || input.status !== 'all';
  const items: ListItem[] = [];
  const visible: string[] = [];
  const counts: Record<StatusFilter, number> = { all: 0, running: 0, problems: 0 };

  for (const { name: workspaceName, stack } of input.stacks) {
    const workspaceId = stack.workspaceId;
    const runtimeOf = (spec: ServiceSpec): ServiceRuntime =>
      stack.runtimes.find((r) => r.serviceId === spec.id) ?? { serviceId: spec.id, status: 'stopped' };
    const bindingOf = (spec: ServiceSpec) => stack.bindings.find((b) => b.serviceId === spec.id);
    const liveCount = (specs: ServiceSpec[]) => specs.filter((s) => isServiceLive(runtimeOf(s).status)).length;
    const matches = (spec: ServiceSpec, group: string): boolean => {
      const status = runtimeOf(spec).status;
      if (input.status === 'running' && !isServiceLive(status)) return false;
      if (input.status === 'problems' && !isProblem(status)) return false;
      if (!query) return true;
      const ref = bindingOf(spec)?.ref ?? '';
      return [spec.name, group, spec.runner, ref].some((text) => text.toLowerCase().includes(query));
    };

    const groups = groupServices(stack.services);
    const allRows = groups.flatMap(rowsOf);
    for (const spec of allRows) {
      const status = runtimeOf(spec).status;
      counts.all += 1;
      if (isServiceLive(status)) counts.running += 1;
      if (isProblem(status)) counts.problems += 1;
    }

    const wsItems: ListItem[] = [];
    const wsVisible: string[] = [];
    for (const group of groups) {
      const rows = rowsOf(group);
      const shown = rows.filter((s) => matches(s, group.name));
      if (filtering && shown.length === 0) continue;

      const ref = sharedBranch(rows.map((s) => bindingOf(s)?.ref));
      const groupKey = `group:${workspaceId}:${group.name}`;
      const collapsed = !filtering && !!input.collapsed[groupKey];
      wsItems.push({
        kind: 'group',
        key: groupKey,
        workspaceId,
        name: group.name,
        rows: rows.map((s) => logKey(workspaceId, s.id)),
        running: liveCount(rows),
        collapsed,
        ref,
      });
      if (collapsed) continue;

      const row = (spec: ServiceSpec): RowItem => {
        const binding = bindingOf(spec);
        const key = logKey(workspaceId, spec.id);
        wsVisible.push(key);
        return {
          kind: 'row',
          key,
          workspaceId,
          spec,
          runtime: runtimeOf(spec),
          binding,
          showRef: !!binding && !isDefaultBranch(binding.ref) && binding.ref !== ref,
        };
      };

      // Copies sit in their group as rows like any other, as Tilt lists
      // resources: a header for the module they share was a group inside a
      // group, and `acme-proc-*` already says they belong together.
      wsItems.push(...shown.map(row));
    }

    if (wsItems.length === 0) continue;
    const workspaceKey = `workspace:${workspaceId}`;
    const folded = input.showWorkspaceNames && !filtering && !!input.collapsed[workspaceKey];
    if (input.showWorkspaceNames) {
      items.push({
        kind: 'workspace',
        key: workspaceKey,
        workspaceId,
        name: workspaceName,
        rows: allRows.map((s) => logKey(workspaceId, s.id)),
        running: liveCount(allRows),
        collapsed: folded,
      });
    }
    if (folded) continue;
    items.push(...wsItems);
    visible.push(...wsVisible);
  }

  return { items, visible, counts };
}

/// A base with copies is the module they share, not something to run.
function rowsOf(group: ServiceGroup): ServiceSpec[] {
  return group.entries.flatMap((e) => (e.copies.length > 0 ? e.copies : [e.spec]));
}

/// What a repository sits on when nobody is working in it. Not worth a chip.
export function isDefaultBranch(ref: string): boolean {
  return ref === 'master' || ref === 'main';
}

/// The feature branch every one of these is on — or nothing, when they differ,
/// when any is unbound, or when it is only the default branch.
export function sharedBranch(refs: readonly (string | undefined)[]): string | undefined {
  const [first] = refs;
  if (!first || isDefaultBranch(first)) return undefined;
  return refs.every((r) => r === first) ? first : undefined;
}

/// What the Problems filter shows. A service past its readiness allowance is
/// not here: it is still being asked, and slow is not broken.
export function isProblem(status: ServiceRuntime['status']): boolean {
  return status === 'failed';
}

/// Everything between two rows, inclusive, in on-screen order — a shift-click.
export function rangeBetween(visible: readonly string[], from: string, to: string): string[] {
  const a = visible.indexOf(from);
  const b = visible.indexOf(to);
  if (a < 0 || b < 0) return [to];
  return visible.slice(Math.min(a, b), Math.max(a, b) + 1);
}
