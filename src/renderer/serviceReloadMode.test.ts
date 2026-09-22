import { describe, expect, it } from 'vitest';
import { DEFAULT_WATCH, reloadModeOf, watchForMode } from './serviceReloadMode';

describe('reloadModeOf', () => {
  it('reads a service that has never been told what to watch as off', () => {
    // The shape every service imported before watching existed is in: no
    // `watch` at all. It must not read as though it were watching something.
    expect(reloadModeOf({ selfReloads: false })).toBe('off');
    expect(reloadModeOf({ selfReloads: false, watch: [] })).toBe('off');
  });

  it('reads patterns as restart-on-change, and self-reloading first', () => {
    expect(reloadModeOf({ selfReloads: false, watch: ['src/**'] })).toBe('restart');
    // A runner that patches its own process is never restarted for a change,
    // whatever globs were left behind on it.
    expect(reloadModeOf({ selfReloads: true, watch: ['src/**'] })).toBe('self');
  });
});

describe('watchForMode', () => {
  it('keeps the patterns a service already had', () => {
    // Switching a service off and back on must not silently widen what it
    // watches to the default — the globs are the part someone wrote.
    expect(watchForMode({ watch: ['api/**', 'config/**'] }, 'restart')).toEqual({
      selfReloads: false,
      watch: ['api/**', 'config/**'],
    });
  });

  it('falls back to the default only when there is nothing to keep', () => {
    expect(watchForMode({}, 'restart').watch).toEqual(DEFAULT_WATCH);
    expect(watchForMode({ watch: [] }, 'restart').watch).toEqual(DEFAULT_WATCH);
  });

  it('does not hand back the default array itself', () => {
    // Two services set in one bulk action would otherwise share it, and an
    // edit to one service's globs would reach the other.
    const first = watchForMode({}, 'restart').watch;
    const second = watchForMode({}, 'restart').watch;
    first.push('extra/**');
    expect(second).toEqual(['src/**']);
    expect(DEFAULT_WATCH).toEqual(['src/**']);
  });

  it('clears the globs for both of the not-watching modes', () => {
    expect(watchForMode({ watch: ['src/**'] }, 'self')).toEqual({ selfReloads: true, watch: [] });
    expect(watchForMode({ watch: ['src/**'] }, 'off')).toEqual({ selfReloads: false, watch: [] });
  });
});
