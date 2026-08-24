/// "Is this file inside that folder?" — the one answer, for both spellings of
/// a path.
///
/// Main hands paths to the renderer exactly as Node produced them, so on
/// Windows they arrive back-slashed (`C:\Users\…\brief.md`) while every
/// containment check in the UI was written as `startsWith(`${root}/`)`. That
/// test can never pass there, and it fails SILENTLY: an everyday project's
/// own documents stopped counting as being inside it, so auto-save never
/// armed, "ask about this document" found no project, and a version restore
/// cleared no stale buffers. Nothing errored — the feature was simply absent.
///
/// `looksLikeEverydayProjectPath` already splits on `/[\\/]/` for the same
/// reason; these are the containment checks that missed it.
///
/// Comparison stays case-SENSITIVE. Windows and macOS both have
/// case-insensitive filesystems, but every caller here compares two paths
/// that came from the same source (a project record and the files opened out
/// of it), so casing already matches — and folding case would wrongly merge
/// two genuinely distinct roots on Linux.

/// Back-slashes to forward, and no trailing separator, so `C:\Users\x\` and
/// `C:/Users/x` compare equal.
function normalize(p: string): string {
  return p.replace(/\\/g, '/').replace(/\/+$/, '');
}

/// True when `target` sits strictly inside `root` — never when they are equal.
export function isPathUnder(target: string, root: string): boolean {
  if (!target || !root) return false;
  return normalize(target).startsWith(`${normalize(root)}/`);
}

/// True when `target` IS `root` or sits inside it. The common case for
/// "does this project own this file?", where the folder itself counts.
export function isPathAtOrUnder(target: string, root: string): boolean {
  if (!target || !root) return false;
  return normalize(target) === normalize(root) || isPathUnder(target, root);
}
