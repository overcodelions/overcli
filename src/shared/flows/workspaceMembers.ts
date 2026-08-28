// Workspace membership drift for a live flow run.
//
// A workspace run resolves its members ONCE, at launch, and the agent's cwd is
// a symlink farm built from exactly that set. Add a project to the workspace
// afterwards and the running flow simply cannot see it. The runtime can adopt
// the newcomers (see `adoptWorkspaceMembers`), but it only does so on resume /
// re-run — so the renderer needs to compute the same "what's missing" answer
// to offer the user that adoption before they've clicked anything.
//
// Both sides share the functions here so the banner can never disagree with
// what adoption would actually do.

import type { FlowRun } from './schema';
import type { Project, Workspace } from '../types';
import { isSamePath } from '../pathScope';

/// A workspace member as far as drift is concerned: what to call it, and the
/// project checkout it forks from.
export interface WorkspaceMemberRef {
  name: string;
  path: string;
}

/// Which of a workspace's current members a live run has no worktree for.
///
/// Matching is by project path, not id, so a project re-added under a new id
/// doesn't mint a second worktree over the same repo. Pure so the adoption
/// rule can be tested without git.
export function workspaceMembersMissingFromRun(
  currentMemberPaths: readonly string[],
  runMemberPaths: readonly string[],
): string[] {
  const have = new Set(runMemberPaths);
  const out: string[] = [];
  for (const p of currentMemberPaths) {
    if (!p || have.has(p) || out.includes(p)) continue;
    out.push(p);
  }
  return out;
}

/// Projects added to this run's workspace since it launched, as
/// `{ name, path }`. Empty for anything that isn't a workspace-worktree run —
/// a single-project or `runIn: 'cwd'` run has no member set to drift from.
///
/// Structural parameter types so this is callable from the runtime (which
/// holds full records) and from the renderer store alike, and testable with
/// object literals.
export function pendingWorkspaceMembers(
  run: Pick<FlowRun, 'workspaceWorktrees' | 'sourceProjectPath'>,
  workspaces: readonly Pick<Workspace, 'rootPath' | 'projectIds'>[],
  projects: readonly Pick<Project, 'id' | 'name' | 'path'>[],
): WorkspaceMemberRef[] {
  const minted = run.workspaceWorktrees;
  if (!minted || minted.length === 0 || !run.sourceProjectPath) return [];
  const workspace = workspaces.find((w) => isSamePath(w.rootPath, run.sourceProjectPath!));
  if (!workspace) return [];
  const projectsById = new Map(projects.map((p) => [p.id, p]));
  const current = workspace.projectIds
    .map((pid) => projectsById.get(pid))
    .filter((p): p is NonNullable<typeof p> => !!p && !!p.path);
  const missing = new Set(
    workspaceMembersMissingFromRun(
      current.map((p) => p.path),
      minted.map((m) => m.projectPath),
    ),
  );
  return current.filter((p) => missing.has(p.path)).map((p) => ({ name: p.name, path: p.path }));
}

/// The pending members the banner should actually offer: everything missing
/// from the run, minus what the user has already dismissed.
///
/// Separate from `pendingWorkspaceMembers` on purpose. The runtime's adoption
/// path must keep seeing the FULL pending set — dismissal is about whether we
/// interrupt the user, not about which repos a resume is allowed to bring in.
/// Only the banner filters.
export function undismissedWorkspaceMembers(
  pending: readonly WorkspaceMemberRef[],
  dismissedPaths: readonly string[] | undefined,
): WorkspaceMemberRef[] {
  if (!dismissedPaths || dismissedPaths.length === 0) return [...pending];
  const dismissed = new Set(dismissedPaths);
  return pending.filter((m) => !dismissed.has(m.path));
}
