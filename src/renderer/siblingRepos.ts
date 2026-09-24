import type { Project, StreamEvent } from '@shared/types';

/// Tool names that change files, across the CLIs: Claude's Edit / Write /
/// MultiEdit / NotebookEdit, Gemini's write_file / replace, apply_patch.
const WRITE_TOOL = /edit|write|replace|patch|create/i;

/// A sibling project a conversation has changed, and the first file it
/// changed there — the card says which, so it never appears for no reason.
export interface SiblingEdit {
  project: Project;
  /// Relative to the sibling's folder.
  file: string;
}

/// Other projects a conversation has CHANGED files in. That is the moment a
/// workspace explains itself — the work genuinely spans repos — so the chat
/// offers one right there.
///
/// Typing `@acme-api` deliberately doesn't count: `@` already means "this
/// file" to the composer and the CLIs, and a project name there is text the
/// agent can do nothing with. The composer's project menu is the way to ask.
///
/// Reading doesn't count. Looking at a dependency's source, or a tool whose
/// whole job is operating on other repos (a git client running `git -C` over
/// every checkout), is not cross-repo work, and offering a workspace for it
/// is noise.
///
/// Nested folders don't count either: a project inside the owner (or the
/// owner inside it) is already reachable.
export function siblingProjectsTouched(
  owner: Project,
  projects: readonly Project[],
  events: readonly StreamEvent[],
): SiblingEdit[] {
  const candidates = projects.filter(
    (p) => p.id !== owner.id && !isWithin(p.path, owner.path) && !isWithin(owner.path, p.path),
  );
  if (candidates.length === 0) return [];

  const written: string[] = [];
  for (const e of events) {
    if (e.kind.type === 'patchApply') {
      for (const f of e.kind.info.files) written.push(f.path);
    }
    if (e.kind.type !== 'assistant') continue;
    for (const use of e.kind.info.toolUses) {
      if (!WRITE_TOOL.test(use.name)) continue;
      if (use.filePath) written.push(use.filePath);
      const input = parseInput(use.inputJSON);
      for (const key of ['file_path', 'path', 'notebook_path']) {
        const v = input[key];
        if (typeof v === 'string') written.push(v);
      }
    }
  }

  const out: SiblingEdit[] = [];
  for (const project of candidates) {
    const hit = written.find((path) => isWithin(path, project.path));
    if (hit) out.push({ project, file: relativeTo(hit, project.path) });
  }
  return out;
}

function relativeTo(file: string, folder: string): string {
  const base = folder.endsWith('/') ? folder.slice(0, -1) : folder;
  return file === base ? '.' : file.slice(base.length + 1);
}

function isWithin(child: string, parent: string): boolean {
  if (!child || !parent) return false;
  const base = parent.endsWith('/') ? parent.slice(0, -1) : parent;
  return child === base || child.startsWith(`${base}/`);
}

function parseInput(json: string): Record<string, unknown> {
  try {
    const v = JSON.parse(json);
    return v && typeof v === 'object' ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}
