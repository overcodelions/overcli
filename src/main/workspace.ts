// Workspace symlink-root management. A workspace groups multiple
// projects so the model can be invoked once with cross-project context.
// We materialize that as a directory under userData containing one
// symlink per member project; the conversation's cwd points at this
// directory, so the model's filesystem tools see all member projects
// side by side.

import fs from 'node:fs';
import path from 'node:path';
import { app } from 'electron';
import { workspaceSymlinkNames } from '../shared/workspaceNames';

export { workspaceSymlinkNames };

interface ProjectRef {
  name: string;
  path: string;
}

/// Create a link from `linkPath` → `target` that works on Windows too.
/// On macOS/Linux plain directory symlinks are fine. On Windows,
/// `fs.symlinkSync(target, link, 'dir')` needs Developer Mode or admin
/// rights, which most users don't have — so try a junction first
/// (privilege-free for absolute dir targets on the same volume) and
/// fall back to a symlink. On POSIX, 'junction' is silently treated as
/// 'dir' by libuv, so there's no downside to preferring it everywhere
/// for dir targets, but we keep the platform check explicit for clarity.
function linkDir(target: string, linkPath: string): void {
  if (process.platform === 'win32') {
    try {
      fs.symlinkSync(target, linkPath, 'junction');
      return;
    } catch (err) {
      // Junction creation is nearly always allowed on Windows; if it
      // still fails (e.g. cross-volume target), fall through and try a
      // real symlink so the user sees the privilege error rather than
      // a silent no-op.
    }
  }
  fs.symlinkSync(target, linkPath, 'dir');
}

/// Context files (CLAUDE.md / AGENTS.md / GEMINI.md) live in the root
/// alongside the symlinks and must survive reconciliation. Each backend's
/// CLI auto-loads its own filename from cwd, so writing all three lets
/// the user switch backends per-conversation without losing context.
const CONTEXT_FILES = ['CLAUDE.md', 'AGENTS.md', 'GEMINI.md'] as const;

export function workspaceRootPath(workspaceId: string): string {
  return path.join(app.getPath('userData'), 'workspaces', workspaceId);
}

export function ensureWorkspaceSymlinkRoot(
  workspaceId: string,
  projects: ProjectRef[],
  instructions?: string,
): { ok: true; rootPath: string } | { ok: false; error: string } {
  if (!workspaceId) return { ok: false, error: 'Missing workspaceId' };
  const rootPath = workspaceRootPath(workspaceId);
  try {
    fs.mkdirSync(rootPath, { recursive: true });

    const desired = new Map<string, string>();
    for (const { name, path: target } of workspaceSymlinkNames(projects)) {
      desired.set(name, target);
    }

    // Reconcile: drop entries not in `desired` (or pointing elsewhere),
    // then create any missing ones. Context files are preserved — they're
    // overwritten explicitly below.
    const preserved = new Set<string>(CONTEXT_FILES);
    const existing = fs.readdirSync(rootPath, { withFileTypes: true });
    for (const entry of existing) {
      if (preserved.has(entry.name)) continue;
      const full = path.join(rootPath, entry.name);
      const target = desired.get(entry.name);
      if (!target) {
        try { fs.unlinkSync(full); } catch { /* ignore */ }
        continue;
      }
      try {
        const current = fs.readlinkSync(full);
        if (current !== target) {
          fs.unlinkSync(full);
          linkDir(target, full);
        }
      } catch {
        // Not a symlink, or unreadable — replace it.
        try { fs.rmSync(full, { recursive: true, force: true }); } catch { /* ignore */ }
        linkDir(target, full);
      }
    }

    const present = new Set(existing.map((e) => e.name));
    for (const [name, target] of desired) {
      if (present.has(name)) continue;
      linkDir(target, path.join(rootPath, name));
    }

    writeWorkspaceContextFiles(rootPath, projects, instructions);

    return { ok: true, rootPath };
  } catch (err: any) {
    return { ok: false, error: err?.message ?? 'Could not create workspace root' };
  }
}

export function removeWorkspaceSymlinkRoot(
  workspaceId: string,
): { ok: true } | { ok: false; error: string } {
  if (!workspaceId) return { ok: false, error: 'Missing workspaceId' };
  try {
    fs.rmSync(workspaceRootPath(workspaceId), { recursive: true, force: true });
    return { ok: true };
  } catch (err: any) {
    return { ok: false, error: err?.message ?? 'Could not remove workspace root' };
  }
}

export function coordinatorRootPath(coordinatorId: string): string {
  return path.join(app.getPath('userData'), 'coordinators', coordinatorId);
}

/// A workspace-agent coordinator needs its own synthetic root whose
/// symlinks point at each member's per-project WORKTREE rather than the
/// main project tree. Without this the agent would edit files via the
/// workspace's symlinks-to-main-tree, bypassing the worktree branch
/// entirely. Returns the created root path so the coordinator
/// conversation can set it as cwd.
export function ensureCoordinatorSymlinkRoot(
  coordinatorId: string,
  members: Array<{ name: string; worktreePath: string }>,
): { ok: true; rootPath: string } | { ok: false; error: string } {
  if (!coordinatorId) return { ok: false, error: 'Missing coordinatorId' };
  const rootPath = coordinatorRootPath(coordinatorId);
  try {
    fs.mkdirSync(rootPath, { recursive: true });

    const desired = new Map<string, string>();
    const usedNames = new Set<string>();
    for (const m of members) {
      if (!m.worktreePath || !m.name) continue;
      let name = m.name;
      let i = 2;
      while (usedNames.has(name)) {
        name = `${m.name}-${i}`;
        i += 1;
      }
      usedNames.add(name);
      desired.set(name, m.worktreePath);
    }

    const preserved = new Set<string>(CONTEXT_FILES);
    const existing = fs.readdirSync(rootPath, { withFileTypes: true });
    for (const entry of existing) {
      if (preserved.has(entry.name)) continue;
      const full = path.join(rootPath, entry.name);
      const target = desired.get(entry.name);
      if (!target) {
        try { fs.unlinkSync(full); } catch { /* ignore */ }
        continue;
      }
      try {
        const current = fs.readlinkSync(full);
        if (current !== target) {
          fs.unlinkSync(full);
          linkDir(target, full);
        }
      } catch {
        try { fs.rmSync(full, { recursive: true, force: true }); } catch { /* ignore */ }
        linkDir(target, full);
      }
    }

    const present = new Set(existing.map((e) => e.name));
    for (const [name, target] of desired) {
      if (present.has(name)) continue;
      linkDir(target, path.join(rootPath, name));
    }

    writeCoordinatorContextFiles(rootPath, [...desired.entries()].map(([name, target]) => ({
      name,
      worktreePath: target,
    })));

    return { ok: true, rootPath };
  } catch (err: any) {
    return { ok: false, error: err?.message ?? 'Could not create coordinator root' };
  }
}

/// After the user ran "Check out all locally", the per-member worktrees
/// are gone but the agent's branches are now checked out in each
/// project's main tree. Rebind the coordinator's symlink root to point
/// at those project roots instead of the removed worktrees — the
/// resumed coordinator conversation then operates against real repos.
/// Rewrites the context files to warn the agent that its prior
/// worktree paths are stale and any per-project branch may have been
/// switched by the user after the handoff.
export function rebindCoordinatorRootToProjects(
  coordinatorId: string,
  projects: Array<{ name: string; projectPath: string; branchName?: string | null }>,
): { ok: true; rootPath: string } | { ok: false; error: string } {
  if (!coordinatorId) return { ok: false, error: 'Missing coordinatorId' };
  const rootPath = coordinatorRootPath(coordinatorId);
  try {
    fs.mkdirSync(rootPath, { recursive: true });

    const desired = new Map<string, { target: string; branchName: string | null }>();
    const usedNames = new Set<string>();
    for (const p of projects) {
      if (!p.projectPath || !p.name) continue;
      let name = p.name;
      let i = 2;
      while (usedNames.has(name)) {
        name = `${p.name}-${i}`;
        i += 1;
      }
      usedNames.add(name);
      desired.set(name, { target: p.projectPath, branchName: p.branchName ?? null });
    }

    const preserved = new Set<string>(CONTEXT_FILES);
    const existing = fs.readdirSync(rootPath, { withFileTypes: true });
    for (const entry of existing) {
      if (preserved.has(entry.name)) continue;
      const full = path.join(rootPath, entry.name);
      const spec = desired.get(entry.name);
      if (!spec) {
        try { fs.unlinkSync(full); } catch { /* ignore */ }
        continue;
      }
      try {
        const current = fs.readlinkSync(full);
        if (current !== spec.target) {
          fs.unlinkSync(full);
          linkDir(spec.target, full);
        }
      } catch {
        try { fs.rmSync(full, { recursive: true, force: true }); } catch { /* ignore */ }
        linkDir(spec.target, full);
      }
    }

    const present = new Set(existing.map((e) => e.name));
    for (const [name, spec] of desired) {
      if (present.has(name)) continue;
      linkDir(spec.target, path.join(rootPath, name));
    }

    writeContinuedLocallyContextFiles(
      rootPath,
      [...desired.entries()].map(([name, spec]) => ({
        name,
        projectPath: spec.target,
        branchName: spec.branchName,
      })),
    );

    return { ok: true, rootPath };
  } catch (err: any) {
    return { ok: false, error: err?.message ?? 'Could not rebind coordinator root' };
  }
}

function writeContinuedLocallyContextFiles(
  rootPath: string,
  projects: Array<{ name: string; projectPath: string; branchName: string | null }>,
): void {
  const list = projects
    .map((p) => {
      const branch = p.branchName ? ` (agent branch: \`${p.branchName}\`)` : '';
      return `- **${p.name}** → \`${p.projectPath}\`${branch}`;
    })
    .join('\n');
  const content = `# Workspace agent context (continued locally)

This coordinator's per-project worktrees were checked out into the users's main project repos — the symlinks below now point at those main repos, NOT at worktrees. The agent branches that were previously under worktrees are now checked out in each project's main tree.

## Member projects

${list || '_(no members)_'}

Guidelines:
- File paths you read or edit resolve through the symlinks above into each project's main working tree.
- Each project may or may not still be on the agent branch listed above — the user might have switched branches after the handoff. If you're about to make edits, verify the current branch with \`git -C <symlinked-path> rev-parse --abbrev-ref HEAD\` first and ask the user before writing to an unexpected branch.
- Any paths or shell commands you remember from earlier in this conversation that reference the old worktree directories are stale; translate them to the new paths above.
`;
  for (const name of CONTEXT_FILES) {
    try {
      fs.writeFileSync(path.join(rootPath, name), content, 'utf8');
    } catch {
      // Non-fatal.
    }
  }
}

export function removeCoordinatorSymlinkRoot(
  coordinatorId: string,
): { ok: true } | { ok: false; error: string } {
  if (!coordinatorId) return { ok: false, error: 'Missing coordinatorId' };
  try {
    fs.rmSync(coordinatorRootPath(coordinatorId), { recursive: true, force: true });
    return { ok: true };
  } catch (err: any) {
    return { ok: false, error: err?.message ?? 'Could not remove coordinator root' };
  }
}

function writeCoordinatorContextFiles(
  rootPath: string,
  members: Array<{ name: string; worktreePath: string }>,
): void {
  const list = members
    .map((m) => `- **${m.name}** → \`${m.worktreePath}\``)
    .join('\n');
  const content = `# Workspace agent context

This directory is a synthetic overcli coordinator root for a workspace agent. Each entry listed under "Member worktrees" is a symlink to a per-project git worktree on this agent's branch — edits you make here land on that branch, not on the project's main tree.

## Member worktrees

${list || '_(no members)_'}

Guidelines:
- File paths you read or edit resolve through the symlinks above, into per-project worktrees.
- Each member is an independent git repo on its own agent branch.
- Do NOT reach out to the projects' main trees (e.g. under \`~/git-services/<project>\`) — those are the user's working copies. Stick to the paths under this cwd.
`;
  for (const name of CONTEXT_FILES) {
    try {
      fs.writeFileSync(path.join(rootPath, name), content, 'utf8');
    } catch {
      // Non-fatal.
    }
  }
}

/// Write CLAUDE.md / AGENTS.md / GEMINI.md describing this workspace's
/// member projects, so whichever CLI the user runs has an accurate map
/// of what lives under cwd. Without this, asking "what projects are
/// here?" on a fresh turn returns whatever's in the user's global
/// instructions instead of the workspace's real contents.
function writeWorkspaceContextFiles(
  rootPath: string,
  projects: ProjectRef[],
  instructions?: string,
): void {
  const members = projects
    .filter((p) => p.path)
    .map((p) => `- **${path.basename(p.path) || p.name}** → \`${p.path}\``)
    .join('\n');
  const trimmedInstructions = instructions?.trim();
  const instructionsSection = trimmedInstructions
    ? `\n## Workspace instructions\n\n${trimmedInstructions}\n`
    : '';
  const content = `# Workspace context

This directory is a synthetic overcli workspace root. Each entry listed under "Member projects" is a symlink to a real git repository — treat the workspace as a meta-project spanning all of them.

## Member projects

${members || '_(no members)_'}

Guidelines:
- File paths you read or edit resolve through the symlinks above.
- Each member is an independent git repo with its own branches and history.
- Before answering "what projects are here?" trust this list, not any global instructions.
${instructionsSection}`;
  for (const name of CONTEXT_FILES) {
    try {
      fs.writeFileSync(path.join(rootPath, name), content, 'utf8');
    } catch {
      // Non-fatal: the symlinks are the load-bearing part of the root;
      // missing context files just means the model falls back to `ls`.
    }
  }
}

