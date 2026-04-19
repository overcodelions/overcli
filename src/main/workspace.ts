// Workspace symlink-root management. A workspace groups multiple
// projects so the model can be invoked once with cross-project context.
// We materialize that as a directory under userData containing one
// symlink per member project; the conversation's cwd points at this
// directory, so the model's filesystem tools see all member projects
// side by side.

import fs from 'node:fs';
import path from 'node:path';
import { app } from 'electron';

interface ProjectRef {
  name: string;
  path: string;
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
): { ok: true; rootPath: string } | { ok: false; error: string } {
  if (!workspaceId) return { ok: false, error: 'Missing workspaceId' };
  const rootPath = workspaceRootPath(workspaceId);
  try {
    fs.mkdirSync(rootPath, { recursive: true });

    // Build the desired set of symlinks: { linkName -> targetPath }.
    // Naming: project basename, deduplicated with a numeric suffix on
    // collision so two projects sharing a folder name (e.g. "frontend")
    // both get a usable link.
    const desired = new Map<string, string>();
    const usedNames = new Set<string>();
    for (const p of projects) {
      if (!p.path) continue;
      const base = path.basename(p.path) || slugify(p.name) || 'project';
      let name = base;
      let i = 2;
      while (usedNames.has(name)) {
        name = `${base}-${i}`;
        i += 1;
      }
      usedNames.add(name);
      desired.set(name, p.path);
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
          fs.symlinkSync(target, full, 'dir');
        }
      } catch {
        // Not a symlink, or unreadable — replace it.
        try { fs.rmSync(full, { recursive: true, force: true }); } catch { /* ignore */ }
        fs.symlinkSync(target, full, 'dir');
      }
    }

    const present = new Set(existing.map((e) => e.name));
    for (const [name, target] of desired) {
      if (present.has(name)) continue;
      fs.symlinkSync(target, path.join(rootPath, name), 'dir');
    }

    writeWorkspaceContextFiles(rootPath, projects);

    return { ok: true, rootPath };
  } catch (err: any) {
    return { ok: false, error: err?.message ?? 'Could not create workspace root' };
  }
}

/// Write CLAUDE.md / AGENTS.md / GEMINI.md describing this workspace's
/// member projects, so whichever CLI the user runs has an accurate map
/// of what lives under cwd. Without this, asking "what projects are
/// here?" on a fresh turn returns whatever's in the user's global
/// instructions instead of the workspace's real contents.
function writeWorkspaceContextFiles(rootPath: string, projects: ProjectRef[]): void {
  const members = projects
    .filter((p) => p.path)
    .map((p) => `- **${path.basename(p.path) || p.name}** → \`${p.path}\``)
    .join('\n');
  const content = `# Workspace context

This directory is a synthetic overcli workspace root. Each entry listed under "Member projects" is a symlink to a real git repository — treat the workspace as a meta-project spanning all of them.

## Member projects

${members || '_(no members)_'}

Guidelines:
- File paths you read or edit resolve through the symlinks above.
- Each member is an independent git repo with its own branches and history.
- Before answering "what projects are here?" trust this list, not any global instructions.
`;
  for (const name of CONTEXT_FILES) {
    try {
      fs.writeFileSync(path.join(rootPath, name), content, 'utf8');
    } catch {
      // Non-fatal: the symlinks are the load-bearing part of the root;
      // missing context files just means the model falls back to `ls`.
    }
  }
}

function slugify(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '');
}
