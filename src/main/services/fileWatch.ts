import path from 'node:path';
import chokidar from 'chokidar';
import picomatch from 'picomatch';

import type { ServiceFileWatcher } from './supervisor';
import { normalizeWatchPatterns } from './types';

/// Folders never watched, wherever they sit. Matched by name: chokidar 4
/// takes no globs, so `**/node_modules/**` became "any segment called
/// node_modules".
const IGNORED_DIRS = new Set(['.git', 'node_modules', 'dist', 'build', 'target', '.gradle', '__pycache__', '.venv', 'venv']);

/// The folders (or files) to hand chokidar for `patterns`: each glob's fixed
/// prefix, deduped, and dropped when a parent is already watched.
export function watchRoots(checkout: string, patterns: readonly string[]): string[] {
  const roots = [...new Set(patterns.map((p) => path.resolve(checkout, picomatch.scan(p).base || '.')))].sort();
  return roots.filter((root, i) => !roots.slice(0, i).some((parent) => root.startsWith(parent + path.sep)));
}

/// Whether a path under `checkout` is one the service opted into.
export function serviceFileMatcher(checkout: string, patterns: readonly string[]): (absolutePath: string) => boolean {
  const normalized = normalizeWatchPatterns(patterns);
  const isMatch = picomatch(normalized, { dot: true });
  return (absolutePath) => {
    const rel = path.relative(checkout, absolutePath).split(path.sep).join('/');
    if (!rel || rel.startsWith('..')) return false;
    if (rel.split('/').some((segment) => IGNORED_DIRS.has(segment))) return false;
    return isMatch(rel);
  };
}

/// Watch only the globs a service opted into. Chokidar is used rather than
/// recursive fs.watch because Linux does not support recursive native watches,
/// while services and their worktrees need identical behaviour on every OS.
/// Chokidar 4 watches paths, not globs: it watches each glob's base folder
/// and the matcher decides which changes count.
export function watchServiceFiles(
  checkout: string,
  patterns: readonly string[],
  onChange: (relativePath: string) => void,
): ServiceFileWatcher {
  const normalized = normalizeWatchPatterns(patterns);
  const matches = serviceFileMatcher(checkout, normalized);
  const watcher = chokidar.watch(watchRoots(checkout, normalized), {
    ignoreInitial: true,
    ignored: (candidate) => path.relative(checkout, candidate).split(path.sep).some((segment) => IGNORED_DIRS.has(segment)),
    awaitWriteFinish: { stabilityThreshold: 150, pollInterval: 50 },
  });
  watcher.on('all', (event, changedPath) => {
    if (event !== 'add' && event !== 'change' && event !== 'unlink') return;
    if (!matches(changedPath)) return;
    onChange(path.relative(checkout, changedPath) || path.basename(changedPath));
  });
  return { close: () => watcher.close() };
}
