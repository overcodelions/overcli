import { describe, expect, it, vi } from 'vitest';

// wire.ts pulls in the whole main process; only the scheduler is under test.
vi.mock('electron', () => ({ app: { getPath: () => '/tmp', isPackaged: false }, ipcMain: { handle: () => undefined } }));

import { scheduleCheckoutSweep } from './wire';

function fakeTimers() {
  const scheduled: Array<{ kind: 'once' | 'every'; ms: number }> = [];
  return {
    scheduled,
    timers: {
      setTimeout: (_fn: () => void, ms: number) => scheduled.push({ kind: 'once', ms }),
      setInterval: (_fn: () => void, ms: number) => scheduled.push({ kind: 'every', ms }),
    },
  };
}

describe('scheduleCheckoutSweep', () => {
  it('never starts on the desktop, which leaves finished worktrees to Clean up', () => {
    const { scheduled, timers } = fakeTimers();
    const sweep = vi.fn();
    expect(scheduleCheckoutSweep(undefined, sweep, timers)).toBe(false);
    expect(scheduleCheckoutSweep(false, sweep, timers)).toBe(false);
    expect(scheduled).toEqual([]);
    expect(sweep).not.toHaveBeenCalled();
  });

  it('runs a minute after start and every ten minutes when the server asks', () => {
    const { scheduled, timers } = fakeTimers();
    expect(scheduleCheckoutSweep(true, () => undefined, timers)).toBe(true);
    expect(scheduled).toEqual([
      { kind: 'once', ms: 60_000 },
      { kind: 'every', ms: 600_000 },
    ]);
  });
});
