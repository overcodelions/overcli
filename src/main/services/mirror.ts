// Local config that lives in the main checkout and nowhere else.
//
// A Spring module reads `application-local.properties` from its own resources
// directory. That file is gitignored — it holds a database password and a path
// that is true only on one machine — so it exists in the main checkout and in
// NO worktree, because a worktree gets tracked files and nothing else.
//
// Point a service at a worktree and it fails on a placeholder it has always
// been able to resolve: `Could not resolve placeholder 'proc.database.ip'`.
// Nothing is wrong with the branch; the config simply is not there.
//
// So: mirror it. Every local config file present in the main checkout and
// missing from the bound worktree is symlinked across at the same relative
// path. One source of truth, no copies to drift, and editing it in the main
// checkout reaches every worktree at once. A real file already in the worktree
// is never touched — that one is the user's own and may be deliberately
// different.
//
// The Tiltfile this pane was modelled on does exactly this, for exactly this
// reason. It is not a workaround; it is what running from a worktree requires.

import fs from 'node:fs';
import path from 'node:path';

/// Files worth mirroring. Deliberately a short list of exact names rather than
/// a pattern: the point is local configuration that cannot be committed, and
/// guessing more widely would start linking things people meant to keep apart.
export const LOCAL_CONFIG_NAMES = [
  'application-local.properties',
  'application-local.yml',
  'application-local.yaml',
  '.env.local',
];

/// Directories never worth walking into. A monorepo's build output dwarfs its
/// source, and none of it holds hand-written local config.
const SKIP = new Set([
  '.git',
  'node_modules',
  'build',
  'dist',
  'out',
  'target',
  '.gradle',
  '.idea',
  'bin',
  'coverage',
]);

export interface MirrorFs {
  existsSync(p: string): boolean;
  readdirSync(p: string, opts: { withFileTypes: true }): { name: string; isDirectory(): boolean }[];
  lstatSync(p: string): { isSymbolicLink(): boolean };
  mkdirSync(p: string, opts: { recursive: true }): void;
  symlinkSync(target: string, linkPath: string, type: 'file'): void;
}

const realFs = fs as unknown as MirrorFs;

/// Every local config file under a checkout, as paths relative to it.
///
/// Depth-limited because the answer is always a few levels down — a module's
/// `src/main/resources` — and an unbounded walk of a large monorepo on every
/// start is a cost nobody agreed to.
export function findLocalConfig(
  root: string,
  opts: { fs?: MirrorFs; names?: readonly string[]; maxDepth?: number } = {},
): string[] {
  const io = opts.fs ?? realFs;
  const names = new Set(opts.names ?? LOCAL_CONFIG_NAMES);
  const maxDepth = opts.maxDepth ?? 6;
  const found: string[] = [];

  function walk(relative: string, depth: number): void {
    let entries: { name: string; isDirectory(): boolean }[];
    try {
      entries = io.readdirSync(relative ? path.join(root, relative) : root, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const next = relative ? path.join(relative, entry.name) : entry.name;
      if (entry.isDirectory()) {
        if (depth >= maxDepth || SKIP.has(entry.name)) continue;
        walk(next, depth + 1);
        continue;
      }
      if (names.has(entry.name)) found.push(next);
    }
  }

  walk('', 0);
  return found.sort();
}

export interface MirrorLink {
  /// Absolute path in the main checkout.
  from: string;
  /// Absolute path in the worktree.
  to: string;
  relative: string;
}

/// What mirroring would do. Pure, so the pane can say "4 files" before
/// anything is written and this can be tested without a filesystem.
export function planMirror(
  primary: string,
  target: string,
  relatives: readonly string[],
  opts: { fs?: MirrorFs } = {},
): MirrorLink[] {
  const io = opts.fs ?? realFs;
  // Mirroring a checkout into itself is the ordinary case for a service on the
  // main branch, and it must do nothing at all.
  if (path.resolve(primary) === path.resolve(target)) return [];

  const out: MirrorLink[] = [];
  for (const relative of relatives) {
    const to = path.join(target, relative);
    // Anything already there — a real file the user wrote, or a link from a
    // previous run — is left alone. This never overwrites.
    if (lexists(io, to)) continue;
    out.push({ from: path.join(primary, relative), to, relative });
  }
  return out;
}

/// Carry out the plan. Returns what was linked, for the log.
export function applyMirror(links: readonly MirrorLink[], opts: { fs?: MirrorFs } = {}): string[] {
  const io = opts.fs ?? realFs;
  const done: string[] = [];
  for (const link of links) {
    try {
      io.mkdirSync(path.dirname(link.to), { recursive: true });
      io.symlinkSync(link.from, link.to, 'file');
      done.push(link.relative);
    } catch {
      // A race with the build, a read-only tree. One file failing is not worth
      // refusing to start over.
    }
  }
  return done;
}

/// `existsSync` follows symlinks, so a link left pointing at something that
/// has gone reads as absent and would be created again over itself.
function lexists(io: MirrorFs, p: string): boolean {
  try {
    io.lstatSync(p);
    return true;
  } catch {
    return false;
  }
}
