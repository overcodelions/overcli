// Path resolution for clicked file links. Lives outside index.ts (which
// imports electron and can't be unit tested) with its filesystem access
// injected, so the resolution cascade can be exercised against fakes.

import path from 'node:path';

export interface ResolveFilePathDeps {
  /// The conversation / explorer cwd the click came from, when known.
  rootPath?: string;
  /// Every project, worktree, workspace and live flow-run root.
  roots: string[];
  exists: (candidate: string) => boolean;
  /// Recursive file listing for a root, already pruned of node_modules
  /// and friends. May throw — callers treat that as "no files".
  listFiles: (root: string) => string[];
}

// Tool output (grep, glob, etc.) emits paths relative to the conversation
// cwd — and the renderer's path-link handler strips trailing `:LINE`
// suffixes, so by the time a click lands here we often get something like
// `src/main/index.ts` or even just `store.ts`. Neither resolves against
// Electron's cwd, so `fs.readFileSync` ENOENTs.
//
// Resolution cascade:
//   1. absolute + exists,
//   2. join against the caller's rootPath (conversation cwd),
//   3. basename search *inside* rootPath, accepting only a match that
//      covers the whole hint (see the comment at the call site),
//   4. join against each registered root,
//   5. Command-P-style basename search across the remaining roots,
//      tie-broken by how many trailing path segments match the hint (so a
//      hint of `renderer/store.ts` prefers `.../src/renderer/store.ts`
//      over `.../some/other/store.ts`), then by shortest full path.
export function resolveFilePath(hint: string, deps: ResolveFilePathDeps): string | null {
  const { rootPath, roots, exists, listFiles } = deps;
  if (!hint) return null;
  if (path.isAbsolute(hint) && exists(hint)) return hint;

  const tried = new Set<string>();
  const tryCandidate = (c: string): string | null => {
    if (tried.has(c)) return null;
    tried.add(c);
    return exists(c) ? c : null;
  };

  const hintSegments = hint.split(/[\\/]/).filter(Boolean);
  const relative = !path.isAbsolute(hint);

  // The caller's own root gets exhausted before any other root is
  // considered. A workspace conversation that prints `main.py` means the
  // `main.py` under one of ITS members — resolving that to an unrelated
  // registered project's top-level `main.py` (which the direct-join loop
  // below would happily do) opens a file the user has never seen.
  //
  // Only a candidate matching the *whole* hint as a path suffix wins here:
  // a partial match inside our root is no stronger evidence than an exact
  // join somewhere else, so those keep falling through the cascade.
  let ownBest: Match | null = null;
  if (rootPath) {
    const direct = tryCandidate(path.resolve(rootPath, hint));
    if (direct) return direct;
    if (relative && hintSegments.length > 0) {
      ownBest = bestBasenameMatch(rootPath, hintSegments, listFiles, null);
      if (ownBest && ownBest.suffixScore >= hintSegments.length) return ownBest.file;
    }
  }

  for (const root of roots) {
    const direct = tryCandidate(path.resolve(root, hint));
    if (direct) return direct;
  }

  if (hintSegments.length === 0) return null;

  // An absolute hint that didn't resolve to an existing file in the direct
  // checks above won't be found by scanning for a same-named file elsewhere —
  // and silently redirecting an absolute path to a different file would be
  // wrong. Skip the recursive walk (each readdir/stat is antivirus-taxed and
  // covers up to 20k files per root) for absolute hints.
  if (!relative) return null;

  // Seeded with the caller's-root scan above so we never walk that tree
  // twice; its partial matches are still in the running, they just don't
  // get to short-circuit the cascade.
  let best = ownBest;
  const seen = new Set<string>(rootPath ? [rootPath] : []);
  for (const root of roots) {
    if (seen.has(root)) continue;
    seen.add(root);
    best = bestBasenameMatch(root, hintSegments, listFiles, best);
  }
  return best?.file ?? null;
}

interface Match {
  file: string;
  suffixScore: number;
}

/// Scan one root for files whose basename matches the hint's, returning
/// whichever of `best` and the root's candidates ranks highest.
function bestBasenameMatch(
  root: string,
  hintSegments: string[],
  listFiles: (root: string) => string[],
  best: Match | null,
): Match | null {
  const basename = hintSegments[hintSegments.length - 1];
  let files: string[];
  try {
    files = listFiles(root);
  } catch {
    return best;
  }
  for (const file of files) {
    if (path.basename(file) !== basename) continue;
    const fileSegments = file.split(path.sep);
    let score = 0;
    for (let i = 0; i < hintSegments.length && i < fileSegments.length; i++) {
      if (fileSegments[fileSegments.length - 1 - i] === hintSegments[hintSegments.length - 1 - i]) {
        score++;
      } else {
        break;
      }
    }
    if (
      !best ||
      score > best.suffixScore ||
      (score === best.suffixScore && file.length < best.file.length)
    ) {
      best = { file, suffixScore: score };
    }
  }
  return best;
}
