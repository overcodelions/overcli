import { describe, expect, it } from 'vitest';
import { spawnService } from './adapter';

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function until(check: () => boolean, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (check()) return true;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return check();
}

describe.skipIf(process.platform === 'win32')('spawnService stopping', () => {
  it('still SIGKILLs a child that outlives its leader', async () => {
    // The leader answers SIGTERM at once; the child under it ignores it. The
    // SIGKILL used to be cancelled by the leader's exit, leaving the child
    // running under launchd for the next start to adopt.
    const proc = spawnService(
      {
        command: ['sh', '-c', `sh -c 'trap "" TERM; echo $$; while :; do sleep 0.05; done' & wait`],
        cwd: process.cwd(),
        env: {},
      },
      { graceMs: 300 },
    );
    let child = 0;
    let leaderGone = false;
    proc.onLine((line) => {
      if (/^\d+$/.test(line.trim())) child = Number(line.trim());
    });
    proc.onExit(() => {
      leaderGone = true;
    });
    try {
      expect(await until(() => child > 0, 3_000)).toBe(true);

      proc.kill('SIGTERM');

      expect(await until(() => leaderGone, 2_000)).toBe(true);
      // Past the leader's exit and still there: it ignored the SIGTERM.
      expect(alive(child)).toBe(true);
      expect(await until(() => !alive(child), 3_000)).toBe(true);
    } finally {
      // A failing run must not leave its child behind under launchd.
      if (child > 0 && alive(child)) process.kill(child, 'SIGKILL');
    }
  });
});
