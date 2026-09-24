import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { anyRunJustFinished, createUnreviewedRefresher } from './unreviewedRefresh';

const GAP = 5_000;

const at = (kind: string) => ({ state: { kind } }) as never;

describe('anyRunJustFinished', () => {
  it('fires when a run it already knew turns done', () => {
    expect(anyRunJustFinished({ a: at('done') }, { a: at('running') })).toBe(true);
    expect(anyRunJustFinished({ a: at('done') }, { a: at('paused') })).toBe(true);
  });

  it('ignores a run that was already done', () => {
    expect(anyRunJustFinished({ a: at('done') }, { a: at('done') })).toBe(false);
  });

  it('ignores a run it sees for the first time, so hydration does not rescan', () => {
    expect(anyRunJustFinished({ a: at('done'), b: at('done') }, {})).toBe(false);
  });

  it('ignores runs that change without finishing', () => {
    expect(anyRunJustFinished({ a: at('paused') }, { a: at('running') })).toBe(false);
    expect(anyRunJustFinished({ a: at('aborted') }, { a: at('running') })).toBe(false);
  });

  it('is false for the same map', () => {
    const runs = { a: at('done') };
    expect(anyRunJustFinished(runs, runs)).toBe(false);
  });
});

describe('createUnreviewedRefresher', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  /// A scan that stays pending until the test resolves it, so "in flight" is
  /// something the test controls.
  function harness() {
    const pending: ((ids: string[]) => void)[] = [];
    const scan = vi.fn(() => new Promise<string[]>((resolve) => pending.push(resolve)));
    const apply = vi.fn();
    const refresher = createUnreviewedRefresher({ scan, apply, gapMs: GAP });
    const finish = async (ids: string[] = []) => {
      pending.shift()?.(ids);
      await vi.advanceTimersByTimeAsync(0);
    };
    return { scan, apply, refresher, finish };
  }

  it('scans and hands the ids over', async () => {
    const { scan, apply, refresher, finish } = harness();
    expect(refresher.refresh()).toBe(true);
    await finish(['r1']);
    expect(scan).toHaveBeenCalledTimes(1);
    expect(apply).toHaveBeenCalledWith(['r1']);
  });

  it('never starts a second scan while one is running', async () => {
    const { scan, refresher } = harness();
    refresher.refresh();
    await vi.advanceTimersByTimeAsync(GAP * 3);
    expect(refresher.refresh()).toBe(false);
    expect(scan).toHaveBeenCalledTimes(1);
  });

  it('keeps the gap from the END of the last scan', async () => {
    const { scan, refresher, finish } = harness();
    refresher.refresh();
    await vi.advanceTimersByTimeAsync(GAP * 2); // a slow scan
    await finish();
    expect(refresher.refresh()).toBe(false);
    await vi.advanceTimersByTimeAsync(GAP);
    expect(refresher.refresh()).toBe(true);
    expect(scan).toHaveBeenCalledTimes(2);
  });

  it('refreshSoon scans at once when nothing stands in the way, and parks nothing', async () => {
    const { scan, refresher, finish } = harness();
    refresher.refreshSoon();
    expect(scan).toHaveBeenCalledTimes(1);
    await finish();
    await vi.advanceTimersByTimeAsync(GAP * 5);
    expect(scan).toHaveBeenCalledTimes(1);
  });

  it('does not lose a finish the throttle turned away', async () => {
    const { scan, refresher, finish } = harness();
    refresher.refresh();
    await finish();
    // A run finishes a moment after a scan: the gap turns it away...
    refresher.refreshSoon();
    expect(scan).toHaveBeenCalledTimes(1);
    // ...and the parked retry picks it up once the gap is over.
    await vi.advanceTimersByTimeAsync(GAP);
    expect(scan).toHaveBeenCalledTimes(2);
  });

  it('parks one retry however many runs finish meanwhile', async () => {
    const { scan, refresher, finish } = harness();
    refresher.refresh();
    await finish();
    refresher.refreshSoon();
    refresher.refreshSoon();
    refresher.refreshSoon();
    await vi.advanceTimersByTimeAsync(GAP);
    expect(scan).toHaveBeenCalledTimes(2);
    await finish();
    await vi.advanceTimersByTimeAsync(GAP * 5);
    expect(scan).toHaveBeenCalledTimes(2);
  });

  it('keeps retrying while a slow scan outlives the wait', async () => {
    const { scan, refresher, finish } = harness();
    refresher.refresh(); // still running when the finish arrives
    refresher.refreshSoon();
    await vi.advanceTimersByTimeAsync(GAP * 3);
    expect(scan).toHaveBeenCalledTimes(1);
    await finish();
    await vi.advanceTimersByTimeAsync(GAP * 2);
    expect(scan).toHaveBeenCalledTimes(2);
  });

  it('survives a scan that fails', async () => {
    const scan = vi.fn().mockRejectedValueOnce(new Error('ipc down')).mockResolvedValue(['r1']);
    const apply = vi.fn();
    const refresher = createUnreviewedRefresher({ scan, apply, gapMs: GAP });
    refresher.refresh();
    await vi.advanceTimersByTimeAsync(0);
    expect(apply).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(GAP);
    expect(refresher.refresh()).toBe(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(apply).toHaveBeenCalledWith(['r1']);
  });

  it('stops for good once disposed', async () => {
    const { scan, apply, refresher, finish } = harness();
    refresher.refresh();
    refresher.refreshSoon(); // parks a retry
    refresher.dispose();
    await finish(['r1']);
    expect(apply).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(GAP * 5);
    expect(refresher.refresh()).toBe(false);
    expect(scan).toHaveBeenCalledTimes(1);
  });
});
