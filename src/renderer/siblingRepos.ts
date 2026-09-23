import type { Project, StreamEvent } from '@shared/types';

/// Tool names that change files, across the CLIs: Claude's Edit / Write /
/// MultiEdit / NotebookEdit, Gemini's write_file / replace, apply_patch.
const WRITE_TOOL = /edit|write|replace|patch|create/i;

/// Other projects a conversation has CHANGED files in, or that the user
/// named with `@acme-api`. That is the moment a workspace explains itself —
/// the work genuinely spans repos — so the chat offers one right there.
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
): Project[] {
  const candidates = projects.filter(
    (p) => p.id !== owner.id && !isWithin(p.path, owner.path) && !isWithin(owner.path, p.path),
  );
  if (candidates.length === 0) return [];

  const written: string[] = [];
  const typed: string[] = [];
  for (const e of events) {
    if (e.kind.type === 'localUser') typed.push(e.kind.text);
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

  return candidates.filter(
    (p) =>
      written.some((path) => isWithin(path, p.path)) ||
      typed.some((t) => mentions(t, p.name)),
  );
}

function isWithin(child: string, parent: string): boolean {
  if (!child || !parent) return false;
  const base = parent.endsWith('/') ? parent.slice(0, -1) : parent;
  return child === base || child.startsWith(`${base}/`);
}

function mentions(text: string, name: string): boolean {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|\\s)@${escaped}(?![\\w-])`, 'i').test(text);
}

function parseInput(json: string): Record<string, unknown> {
  try {
    const v = JSON.parse(json);
    return v && typeof v === 'object' ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}
