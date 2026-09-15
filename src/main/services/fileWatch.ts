import path from 'node:path';
import chokidar from 'chokidar';

import type { ServiceFileWatcher } from './supervisor';
import { normalizeWatchPatterns } from './types';

const IGNORED = [
  '**/.git/**',
  '**/node_modules/**',
  '**/dist/**',
  '**/build/**',
  '**/target/**',
  '**/.gradle/**',
  '**/__pycache__/**',
  '**/.venv/**',
  '**/venv/**',
];

/// Watch only the globs a service opted into. Chokidar is used rather than
/// recursive fs.watch because Linux does not support recursive native watches,
/// while services and their worktrees need identical behaviour on every OS.
export function watchServiceFiles(
  checkout: string,
  patterns: readonly string[],
  onChange: (relativePath: string) => void,
): ServiceFileWatcher {
  const targets = normalizeWatchPatterns(patterns).map((pattern) => path.resolve(checkout, pattern));
  const watcher = chokidar.watch(targets, {
    ignoreInitial: true,
    ignored: IGNORED,
    awaitWriteFinish: { stabilityThreshold: 150, pollInterval: 50 },
  });
  watcher.on('all', (event, changedPath) => {
    if (event !== 'add' && event !== 'change' && event !== 'unlink') return;
    onChange(path.relative(checkout, changedPath) || path.basename(changedPath));
  });
  return { close: () => watcher.close() };
}
