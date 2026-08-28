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

/// Do these two strings name the same location? Case-FOLDED off Linux, unlike
/// the containment checks above.
///
/// The exception is earned by a specific failure. Both sides of a containment
/// check come from the same source, so their casing already agrees. An owner
/// lookup is the opposite: it matches a path persisted with a flow run,
/// possibly months ago, against one the store holds now — and the spelling of
/// the userData directory has changed under those records. Runs made before
/// `productName` was declared hold `…/Application Support/overcli/workspaces/<id>`
/// while the workspace record holds `…/Overcli/…`. One directory on a
/// case-insensitive volume, two strings, and `===` reports the workspace as
/// unknown: the sidebar lane loses its name and prints the bare uuid.
///
/// `main/workspace.ts` already folds case for the same reason, and additionally
/// resolves symlinks — it can, having `fs`. This is the lexical half, for the
/// renderer and for shared code.
export function isSamePath(a: string, b: string): boolean {
  if (!a || !b) return false;
  const x = normalize(a);
  const y = normalize(b);
  return caseSensitiveFs() ? x === y : x.toLowerCase() === y.toLowerCase();
}

/// Linux only. Detected from whichever global is present: `process` in main
/// and in tests, `navigator` in the renderer, where contextIsolation keeps
/// `process` out. Neither means we are somewhere unusual — assume the
/// forgiving answer, since folding case can only merge two paths that a
/// case-insensitive volume had already merged.
function caseSensitiveFs(): boolean {
  if (typeof process !== 'undefined' && process.platform) return process.platform === 'linux';
  if (typeof navigator !== 'undefined' && navigator.platform) {
    return /linux/i.test(navigator.platform);
  }
  return false;
}

/// Rewrite `p` to the canonical spelling of `root` when the two differ only
/// in how the root itself is spelled.
///
/// Overcli's userData directory changed name — runs written before the app
/// declared its `productName` hold `…/Application Support/overcli/…` where it
/// is now `…/Overcli/…`. On a case-insensitive volume that is one directory
/// with two names, so the files are all still there and nothing looks broken;
/// what breaks is every `===` between a path read off an old record and one
/// built from `dataDir()` today. `isSamePath` papers over that at each
/// comparison. This closes it at the source, so records stop carrying the old
/// spelling forward.
///
/// Returns `p` untouched unless it sits at or under `root` under the same
/// case rules as `isSamePath` — which means this is a no-op on Linux, where
/// the two spellings really are two directories.
export function canonicalizeUnderRoot(p: string, root: string): string {
  if (!p || !root) return p;
  // A trailing separator on `root` would shift every offset below by one and
  // turn the whole function into a silent no-op.
  const base = root.replace(/[\\/]+$/, '');
  if (!base) return p;
  if (isPathAtOrUnder(p, base)) return p; // already canonical
  if (!isSamePath(p.slice(0, base.length), base)) return p;
  const rest = p.slice(base.length);
  if (rest && rest[0] !== '/' && rest[0] !== '\\') return p; // matched mid-segment
  return base + rest;
}
