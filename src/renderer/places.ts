// How the Places sidebar arranges projects and workspaces.
//
// One line per place, in three bands: the ones you pinned, in your order; the
// ones with anything going on — touched in the last two days, running, or
// waiting on you; and everything else behind one "more places" line. A project
// that belongs to a workspace lives under that workspace rather than a second
// time at the top level, unless you pinned it there yourself.
//
// Pure, so the rules are testable without a sidebar around them. Everything
// the store knows is handed in as functions.

import type { Project, Workspace } from '@shared/types';
import { isEverydayProject } from '@shared/everydayProjects';
import { SLEEP_AFTER_MS } from './sidebarSleep';

export type PlaceKind = 'repo' | 'documents' | 'folder' | 'workspace';

export type PlaceRef =
  | { kind: 'project'; project: Project }
  | { kind: 'workspace'; workspace: Workspace; members: Project[] };

/// What is happening inside a place right now — the line a collapsed row
/// shows so a busy place never has to be opened to look busy.
export interface PlaceStatus {
  running: number;
  needsYou: number;
}

export const QUIET: PlaceStatus = { running: 0, needsYou: 0 };

export function placeId(ref: PlaceRef): string {
  return ref.kind === 'project' ? ref.project.id : ref.workspace.id;
}

export function placeName(ref: PlaceRef): string {
  return ref.kind === 'project' ? projectDisplayName(ref.project) : ref.workspace.name;
}

export function placePath(ref: PlaceRef): string {
  return ref.kind === 'project' ? ref.project.path : ref.workspace.rootPath;
}

/// The folder name, which is what people recognise a repo by; the stored
/// name only when the path has none.
export function projectDisplayName(project: Project): string {
  const tail = project.path.split(/[\\/]/).filter(Boolean).pop()?.trim();
  return tail || project.name;
}

/// What kind of place this is, for its icon. `isGitRepo` is the store's probe:
/// `undefined` while unknown, which reads as a repo — the common case, and the
/// icon settles the moment the probe answers.
export function placeKind(ref: PlaceRef, isGitRepo: boolean | undefined): PlaceKind {
  if (ref.kind === 'workspace') return 'workspace';
  if (isEverydayProject(ref.project)) return 'documents';
  return isGitRepo === false ? 'folder' : 'repo';
}

export function isBusy(status: PlaceStatus): boolean {
  return status.running > 0 || status.needsYou > 0;
}

export interface ArrangeInput {
  projects: readonly Project[];
  workspaces: readonly Workspace[];
  /// Pinned place ids, in the order the user wants them.
  pinned: readonly string[];
  activityAt: (ref: PlaceRef) => number;
  status: (ref: PlaceRef) => PlaceStatus;
  /// Never folds away: the place you are inside, or one just added that has
  /// not had a chance to look busy yet.
  keepOut?: (ref: PlaceRef) => boolean;
  now: number;
  /// How long a place stays in Active after it was last touched.
  activeFor?: number;
}

export interface ArrangedPlaces {
  pinned: PlaceRef[];
  active: PlaceRef[];
  more: PlaceRef[];
}

export function workspaceRefs(
  workspaces: readonly Workspace[],
  projects: readonly Project[],
): Array<Extract<PlaceRef, { kind: 'workspace' }>> {
  const byId = new Map(projects.map((p) => [p.id, p]));
  return workspaces.map((workspace) => ({
    kind: 'workspace' as const,
    workspace,
    members: workspace.projectIds.map((id) => byId.get(id)).filter((p): p is Project => !!p),
  }));
}

export function arrangePlaces(input: ArrangeInput): ArrangedPlaces {
  const { projects, workspaces, now } = input;
  const activeFor = input.activeFor ?? SLEEP_AFTER_MS;
  const inWorkspace = new Set(workspaces.flatMap((w) => w.projectIds));
  const pinnedSet = new Set(input.pinned);

  const all: PlaceRef[] = [
    ...workspaceRefs(workspaces, projects),
    ...projects.map((project) => ({ kind: 'project' as const, project })),
  ];
  const byId = new Map(all.map((ref) => [placeId(ref), ref]));

  const pinned = input.pinned.map((id) => byId.get(id)).filter((r): r is PlaceRef => !!r);

  // A workspace member shows under its workspace. Pinning it is asking for it
  // at the top as well, so that is the one way it appears twice.
  const loose = all.filter(
    (ref) =>
      !pinnedSet.has(placeId(ref)) && !(ref.kind === 'project' && inWorkspace.has(ref.project.id)),
  );
  const touched = new Map(loose.map((ref) => [placeId(ref), input.activityAt(ref)]));
  loose.sort((a, b) => touched.get(placeId(b))! - touched.get(placeId(a))!);

  const cutoff = now - activeFor;
  const active: PlaceRef[] = [];
  const more: PlaceRef[] = [];
  for (const ref of loose) {
    const live =
      touched.get(placeId(ref))! >= cutoff || isBusy(input.status(ref)) || (input.keepOut?.(ref) ?? false);
    (live ? active : more).push(ref);
  }
  return { pinned, active, more };
}

export type PlaceSort = 'recent' | 'az' | 'busiest';
export type PlaceFilter = 'all' | 'repos' | 'documents' | 'workspaces' | 'running';

export interface FilterInput {
  query: string;
  sort: PlaceSort;
  filter: PlaceFilter;
  kind: (ref: PlaceRef) => PlaceKind;
  activityAt: (ref: PlaceRef) => number;
  status: (ref: PlaceRef) => PlaceStatus;
  /// How much has happened here — conversations and runs — for "Busiest".
  weight: (ref: PlaceRef) => number;
}

/// Every place, filtered flat for the search box. Matches the name and the
/// path, so a repo is findable by the folder it lives in as well as its name.
export function filterPlaces(
  projects: readonly Project[],
  workspaces: readonly Workspace[],
  input: FilterInput,
): PlaceRef[] {
  const q = input.query.trim().toLowerCase();
  const all: PlaceRef[] = [
    ...workspaceRefs(workspaces, projects),
    ...projects.map((project) => ({ kind: 'project' as const, project })),
  ];
  const kept = all.filter((ref) => {
    if (q && !placeName(ref).toLowerCase().includes(q) && !placePath(ref).toLowerCase().includes(q)) {
      return false;
    }
    switch (input.filter) {
      case 'repos':
        return input.kind(ref) === 'repo' || input.kind(ref) === 'folder';
      case 'documents':
        return input.kind(ref) === 'documents';
      case 'workspaces':
        return ref.kind === 'workspace';
      case 'running':
        return isBusy(input.status(ref));
      default:
        return true;
    }
  });
  const byName = (a: PlaceRef, b: PlaceRef) => placeName(a).localeCompare(placeName(b));
  if (input.sort === 'az') return kept.sort(byName);
  if (input.sort === 'busiest') {
    return kept.sort((a, b) => input.weight(b) - input.weight(a) || byName(a, b));
  }
  // A name that starts with what you typed beats one that merely contains it;
  // within each, most recent first.
  const starts = (ref: PlaceRef) => (q && placeName(ref).toLowerCase().startsWith(q) ? 0 : 1);
  return kept.sort((a, b) => starts(a) - starts(b) || input.activityAt(b) - input.activityAt(a));
}

/// Short "how long ago" for a row's right edge: 2h, 3d, 2w, 4mo.
export function agoLabel(at: number, now: number): string {
  if (!at) return '';
  const mins = Math.max(0, Math.floor((now - at) / 60_000));
  if (mins < 1) return 'now';
  if (mins < 60) return `${mins}m`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.round(hours / 24);
  if (days < 14) return `${days}d`;
  if (days < 60) return `${Math.round(days / 7)}w`;
  return `${Math.round(days / 30)}mo`;
}

/// Add or remove a place from the pinned list, keeping everyone else's order.
export function togglePinned(pinned: readonly string[], id: string): string[] {
  return pinned.includes(id) ? pinned.filter((p) => p !== id) : [...pinned, id];
}

/// Move a pinned place one slot up or down.
export function movePinned(pinned: readonly string[], id: string, direction: -1 | 1): string[] {
  const at = pinned.indexOf(id);
  const to = at + direction;
  if (at < 0 || to < 0 || to >= pinned.length) return [...pinned];
  const next = [...pinned];
  [next[at], next[to]] = [next[to], next[at]];
  return next;
}
