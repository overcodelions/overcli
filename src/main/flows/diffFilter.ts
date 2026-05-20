// Strip high-noise / low-signal hunks from a unified diff so the bytes
// we hand to a reviewer/critic are actually about the code being
// changed. The motivating case: a routine `npm install` rewrites
// `package-lock.json` end-to-end (e.g. when the registry URL changes),
// producing a 500 KB+ diff that swamps every other file. Reviewers
// truncate against their context budget and end up "seeing" nothing but
// lockfile churn.
//
// The filter recognises common lockfiles and minified outputs by exact
// basename. Generated directories (`dist/`, `build/`, etc.) are
// intentionally NOT filtered — those are project-specific and
// occasionally meaningful to review.

const NOISY_BASENAMES = new Set([
  'package-lock.json',
  'yarn.lock',
  'pnpm-lock.yaml',
  'npm-shrinkwrap.json',
  'Cargo.lock',
  'Gemfile.lock',
  'composer.lock',
  'Pipfile.lock',
  'poetry.lock',
  'go.sum',
  'mix.lock',
]);

const NOISY_SUFFIXES = ['.min.js', '.min.css', '.min.mjs'];

export function isNoisyPath(p: string): boolean {
  if (!p) return false;
  const base = p.split('/').pop() ?? p;
  if (NOISY_BASENAMES.has(base)) return true;
  const lower = base.toLowerCase();
  for (const suf of NOISY_SUFFIXES) {
    if (lower.endsWith(suf)) return true;
  }
  return false;
}

interface FilterResult {
  diff: string;
  /// Paths that were dropped, in document order, deduped. Empty if
  /// nothing was filtered.
  filtered: string[];
}

/// Split a unified diff into per-file blocks and drop any whose target
/// path matches a known-noise pattern. The returned `diff` keeps a
/// summary footer naming what was dropped so the reviewer can see (and
/// the user can audit) what we removed.
export function filterNoiseFromDiff(diff: string): FilterResult {
  if (!diff) return { diff, filtered: [] };

  // Per-file blocks start with `diff --git a/<path> b/<path>`. Split on
  // that marker while preserving the marker itself at the head of each
  // chunk. Anything before the first marker is preamble we keep
  // verbatim (rare — `git diff` doesn't usually emit one, but the
  // workspace branch concatenates per-repo headers).
  const lines = diff.split('\n');
  const blocks: Array<{ header: string; path: string | null; body: string[] }> = [];
  let current: { header: string; path: string | null; body: string[] } | null = null;
  for (const line of lines) {
    if (line.startsWith('diff --git ')) {
      if (current) blocks.push(current);
      const path = extractDiffGitPath(line);
      current = { header: line, path, body: [line] };
    } else if (current) {
      current.body.push(line);
    } else {
      // Preamble before any `diff --git` — carry it as a synthetic
      // block with no path so it's never filtered.
      current = { header: '', path: null, body: [line] };
    }
  }
  if (current) blocks.push(current);

  const filtered: string[] = [];
  const kept: string[] = [];
  for (const block of blocks) {
    if (block.path && isNoisyPath(block.path)) {
      if (!filtered.includes(block.path)) filtered.push(block.path);
      continue;
    }
    kept.push(block.body.join('\n'));
  }

  let out = kept.join('\n');
  if (filtered.length > 0) {
    const summary =
      `# overcli: filtered ${filtered.length} noisy file(s) from diff ` +
      `(lockfiles/minified). Dropped: ${filtered.join(', ')}\n`;
    out = out + (out.endsWith('\n') ? '' : '\n') + summary;
  }
  return { diff: out, filtered };
}

/// Pull the `b/<path>` (target) out of a `diff --git a/foo b/foo` line.
/// Falls back to the `a/` side when `b/` is missing. Paths with spaces
/// are surfaced verbatim — git quotes those, and our basename check is
/// resilient to surrounding quotes.
function extractDiffGitPath(line: string): string | null {
  // Match `diff --git a/<a> b/<b>` — both sides may be quoted by git
  // when they contain whitespace or unprintable chars.
  const m = /^diff --git (?:"a\/(.+?)"|a\/(\S+)) (?:"b\/(.+?)"|b\/(\S+))\s*$/.exec(line);
  if (!m) return null;
  return m[3] || m[4] || m[1] || m[2] || null;
}
