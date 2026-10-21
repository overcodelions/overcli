// Which of the checkout's changes did *this* conversation make?
//
// The ChangesBar is fed by `git status`, which knows what changed but not
// who changed it. A worktree conversation owns its tree, so everything git
// reports is its own. Plain conversations all share the project's main
// checkout, and without this every one of them shows every other one's
// edits as if it had made them.
//
// Git stays the source of the numbers; the transcript only decides which
// rows belong here. A file counts as touched when the conversation ran an
// Edit/Write on it, applied a patch to it, or a shell command's measured
// `fileChanges` include it.

import type { StreamEvent } from '@shared/types';
import type { FileChangeSummary } from './components/ChangesBar';

const EDIT_TOOLS = new Set(['Edit', 'MultiEdit', 'Write', 'NotebookEdit']);

/// Every path the conversation wrote to, as the transcript spelled it —
/// absolute for most backends, sometimes relative to the cwd.
export function touchedPaths(events: readonly StreamEvent[] | null | undefined): Set<string> {
  const out = new Set<string>();
  if (!events) return out;
  for (const e of events) {
    const k = e.kind;
    if (k.type === 'assistant') {
      for (const u of k.info.toolUses) {
        if (EDIT_TOOLS.has(u.name) && u.filePath) out.add(u.filePath);
      }
    } else if (k.type === 'patchApply') {
      for (const f of k.info.files) {
        out.add(f.path);
        if (f.movedFrom) out.add(f.movedFrom);
      }
    } else if (k.type === 'toolResult') {
      for (const r of k.results) {
        for (const f of r.fileChanges ?? []) out.add(f.path);
      }
    }
  }
  return out;
}

function normalize(p: string): string {
  return p.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '');
}

/// Git reports repo-root-relative paths (prefixed `<member>/` in a
/// workspace); the transcript mostly has absolute ones, sometimes through a
/// symlinked root. Matching on a path-segment suffix sidesteps both without
/// needing to know where the repo root is.
function samePath(changePath: string, touched: string): boolean {
  const a = normalize(changePath);
  const b = normalize(touched);
  if (!a || !b) return false;
  return a === b || b.endsWith(`/${a}`) || a.endsWith(`/${b}`);
}

function isTouched(changePath: string, touched: readonly string[]): boolean {
  if (touched.some((t) => samePath(changePath, t))) return true;
  // Workspace rows carry the member's symlink name, which needn't match the
  // project's folder name on disk — retry without it.
  const slash = changePath.indexOf('/');
  if (slash <= 0) return false;
  const rest = changePath.slice(slash + 1);
  return touched.some((t) => samePath(rest, t));
}

/// Split the checkout's changes into the ones this conversation made and a
/// count of everything else that's dirty in the same tree.
export function splitOwnChanges(
  changes: readonly FileChangeSummary[],
  touched: ReadonlySet<string>,
): { own: FileChangeSummary[]; others: number } {
  const list = [...touched];
  const own: FileChangeSummary[] = [];
  let others = 0;
  for (const c of changes) {
    if (isTouched(c.path, list)) own.push(c);
    else others += 1;
  }
  return { own, others };
}
