// What the launch spinner says while a workspace's worktrees are prepared.

/// How many repos check out at once. The launch used to start every member
/// together; 8 is what was measured to run well (8 repos: 2.4s together, 7.8s
/// one by one). Larger pools have not been measured.
export const MAX_CONCURRENT_WORKTREE_FORKS = 8;

/// Names the repos still going once only a few remain, because those are the
/// ones holding the launch up. The repo that just finished never is.
export function launchProgressMessage(args: {
  justFinished: string;
  ok: boolean;
  pending: readonly string[];
}): string {
  if (!args.ok) return `Worktree failed for ${args.justFinished}`;
  if (args.pending.length === 0) return 'Worktrees ready';
  if (args.pending.length <= 3) return `Waiting on ${args.pending.join(', ')}`;
  return `Prepared worktree for ${args.justFinished}`;
}

/// One log line for a whole launch, so a slow one can be explained afterwards.
export function launchTimingSummary(timings: ReadonlyArray<{ name: string; ms: number }>, totalMs: number): string {
  const seconds = (ms: number) => `${(ms / 1000).toFixed(1)}s`;
  const slowest = [...timings]
    .sort((a, b) => b.ms - a.ms)
    .slice(0, 3)
    .map((t) => `${t.name} ${seconds(t.ms)}`)
    .join(', ');
  return `Prepared ${timings.length} worktrees in ${seconds(totalMs)}; slowest: ${slowest}`;
}
