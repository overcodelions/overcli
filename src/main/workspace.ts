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

/// Workspace/coordinator ids are `crypto.randomUUID()` values, but they
/// arrive over IPC and are joined straight into a path that gets
/// `rmSync(recursive, force)`d — an id of `../../Documents` would delete
/// the user's home folder. Reject anything that isn't a bare slug so a
/// traversal can never reach the path builders below.
const ID_RE = /^[A-Za-z0-9_-]+$/;

export function workspaceRootPath(workspaceId: string): string {
  if (!ID_RE.test(workspaceId)) throw new Error('Invalid workspace id');
  return path.join(app.getPath('userData'), 'workspaces', workspaceId);
}

export function ensureWorkspaceSymlinkRoot(
  workspaceId: string,
  projects: ProjectRef[],
  instructions?: string,
): { ok: true; rootPath: string } | { ok: false; error: string } {
  if (!ID_RE.test(workspaceId)) return { ok: false, error: 'Missing or invalid workspaceId' };
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
        // No current member/project owns this name. Only reclaim entries
        // WE manage — symlinks (stale links from an earlier reconcile). NEVER
        // delete regular files or directories: agents write standalone
        // deliverables / scratch notes at this root, and this reconcile
        // re-runs on every app launch/reload — so unlinking unknown entries
        // silently destroys the agent's work "between edits". Leave anything
        // that isn't one of our symlinks alone.
        if (entry.isSymbolicLink()) {
          try { fs.unlinkSync(full); } catch { /* ignore */ }
        }
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
  if (!ID_RE.test(workspaceId)) return { ok: false, error: 'Missing or invalid workspaceId' };
  try {
    fs.rmSync(workspaceRootPath(workspaceId), { recursive: true, force: true });
    return { ok: true };
  } catch (err: any) {
    return { ok: false, error: err?.message ?? 'Could not remove workspace root' };
  }
}

export function coordinatorRootPath(coordinatorId: string): string {
  if (!ID_RE.test(coordinatorId)) throw new Error('Invalid coordinator id');
  return path.join(app.getPath('userData'), 'coordinators', coordinatorId);
}

/// Files an agent wrote at a synthetic root — the loose output a run left
/// behind that belongs to no repository.
///
/// A workspace or coordinator root is a folder of project symlinks plus the
/// three context files. Regular files and regular directories were put there
/// by a run. Reports are usually loose top-level files, but flow prompts also
/// commonly name a relative path such as `reports/weekly.html`; ignoring
/// directories makes that visible in the run and then silently lose it when
/// the disposable coordinator root is removed.
///
/// Walk nested regular directories with hard depth/entry/file-count/size
/// bounds. Symlinked project checkouts are never followed, and only files
/// touched during this run are returned, so this cannot turn into a recursive
/// copy of a member repository or an old workspace scratch tree.
export interface LooseRootFile {
  name: string;
  path: string;
  bytes: number;
  modifiedAt: number;
}

/// Enough for "the report, its data, and a couple of images"; a run that
/// littered a hundred files at the root is scratch, not a deliverable.
const MAX_LOOSE_FILES = 20;
/// Big enough for a self-contained HTML page with inlined images, small
/// enough that a stray database dump is not silently copied into userData.
const MAX_LOOSE_FILE_BYTES = 16 * 1024 * 1024;
const MAX_LOOSE_SCAN_DEPTH = 4;
const MAX_LOOSE_SCAN_ENTRIES = 2_000;

export function looseSyntheticRootFiles(
  rootPath: string,
  opts?: { since?: number },
): LooseRootFile[] {
  if (!isSyntheticRootPath(rootPath)) return [];
  const since = opts?.since ?? 0;
  const out: LooseRootFile[] = [];
  let scanned = 0;

  const walk = (dir: string, relDir: string, depth: number): void => {
    if (depth > MAX_LOOSE_SCAN_DEPTH || scanned >= MAX_LOOSE_SCAN_ENTRIES) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (++scanned > MAX_LOOSE_SCAN_ENTRIES) return;
      if (entry.name.startsWith('.')) continue;
      if (!relDir && (CONTEXT_FILES as readonly string[]).includes(entry.name)) continue;
      const full = path.join(dir, entry.name);
      const rel = relDir ? `${relDir}/${entry.name}` : entry.name;

      // Dirent lets us reject a project checkout symlink before any stat or
      // recursion can follow it.
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        walk(full, rel, depth + 1);
        continue;
      }
      if (!entry.isFile()) continue;
      try {
        const stat = fs.lstatSync(full);
        if (!stat.isFile()) continue;
        // A workspace root outlives any one run, so without this an old run's
        // leftovers would be filed again under whatever ran most recently.
        if (stat.mtimeMs < since) continue;
        if (stat.size > MAX_LOOSE_FILE_BYTES) continue;
        out.push({ name: rel, path: full, bytes: stat.size, modifiedAt: stat.mtimeMs });
      } catch {
        // Raced with a delete, or unreadable — not a deliverable either way.
      }
    }
  };

  walk(rootPath, '', 0);
  return out.sort((a, b) => a.modifiedAt - b.modifiedAt).slice(-MAX_LOOSE_FILES);
}

/// True for a root Overcli itself created under userData — a workspace or
/// coordinator symlink farm, and only at the depth we create them. The check
/// is what makes the sweep above safe to run blind: a real project checkout
/// never matches, so no source file can be swept up as agent output.
export function isSyntheticRootPath(candidate: string): boolean {
  if (!candidate) return false;
  let userData: string;
  try {
    userData = app.getPath('userData');
  } catch {
    return false;
  }
  const resolved = path.resolve(candidate);
  for (const bucket of ['workspaces', 'coordinators']) {
    if (!samePath(path.dirname(resolved), path.join(userData, bucket))) continue;
    return ID_RE.test(path.basename(resolved));
  }
  return false;
}

/// Two paths naming the same directory. Compared case-insensitively off
/// Linux because the stored path and `app.getPath` disagree in practice —
/// a run records `…/Application Support/overcli/coordinators/<id>` while
/// userData reports `…/Overcli` — and on a case-insensitive volume those
/// are one directory. Symlinks are resolved first where the path exists,
/// so a userData under a linked home still matches.
function samePath(a: string, b: string): boolean {
  const real = (p: string) => {
    let out = path.resolve(p);
    try {
      out = fs.realpathSync.native(out);
    } catch {
      // Not created yet — the lexical form is the best answer available.
    }
    return process.platform === 'linux' ? out : out.toLowerCase();
  };
  return real(a) === real(b);
}

/// Resolve the symlinks directly under `cwd` to their absolute target
/// dirs. Used to expand a coordinator-style cwd (a folder of symlinks
/// pointing at each member worktree) into a list of writable roots a
/// codex sandbox needs, since codex's workspace-write only grants
/// access to the cwd subtree — a write through a symlink resolves to
/// the symlink's target path, which sits outside that subtree and
/// would otherwise be denied. Returns an empty array if cwd doesn't
/// exist, isn't a directory, or contains no link targets.
export function resolveSymlinkWritableRoots(cwd: string): string[] {
  if (!cwd) return [];
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(cwd, { withFileTypes: true });
  } catch {
    return [];
  }
  const out = new Set<string>();
  for (const e of entries) {
    if (!e.isSymbolicLink()) continue;
    const link = path.join(cwd, e.name);
    try {
      const target = fs.realpathSync(link);
      // Only directory targets matter for codex's writable-roots; a
      // symlink to a file would just need its parent dir, but coordinator
      // roots only ever link to dirs in practice.
      const stat = fs.statSync(target);
      if (stat.isDirectory()) out.add(target);
    } catch {
      // broken symlink — skip; codex will surface the error if the agent
      // tries to use it.
    }
  }
  return [...out];
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
  if (!ID_RE.test(coordinatorId)) return { ok: false, error: 'Missing or invalid coordinatorId' };
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
        // No current member/project owns this name. Only reclaim entries
        // WE manage — symlinks (stale links from an earlier reconcile). NEVER
        // delete regular files or directories: agents write standalone
        // deliverables / scratch notes at this root, and this reconcile
        // re-runs on every app launch/reload — so unlinking unknown entries
        // silently destroys the agent's work "between edits". Leave anything
        // that isn't one of our symlinks alone.
        if (entry.isSymbolicLink()) {
          try { fs.unlinkSync(full); } catch { /* ignore */ }
        }
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
  if (!ID_RE.test(coordinatorId)) return { ok: false, error: 'Missing or invalid coordinatorId' };
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
        // Only reclaim our own stale symlinks — never delete regular files
        // or directories the agent wrote at this root (see the note in
        // ensureCoordinatorSymlinkRoot). This runs on every app reload.
        if (entry.isSymbolicLink()) {
          try { fs.unlinkSync(full); } catch { /* ignore */ }
        }
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
  if (!ID_RE.test(coordinatorId)) return { ok: false, error: 'Missing or invalid coordinatorId' };
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
- When generating standalone deliverables (reports, cheat sheets, briefs, exports, scratch notes — anything that isn't source for a member project), write them at this workspace root (cwd). Do NOT write to \`~/Documents\`, \`~/Desktop\`, or any other directory outside cwd — overcli's file viewer can only open files under registered roots, and the user can't click through to anything you place elsewhere.
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
- When generating standalone deliverables (reports, cheat sheets, briefs, exports, scratch notes — anything that isn't source code for a member project), write them at this workspace root (cwd). Do NOT write to \`~/Documents\`, \`~/Desktop\`, or any other directory outside cwd — overcli's file viewer can only open files under registered roots, and the user can't click through to anything you place elsewhere.
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
