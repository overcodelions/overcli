// Which feed the app follows, and — the part that actually bit users — which
// direction it is allowed to move along it.
//
// electron-updater's `channel` setter flips `allowDowngrade` to true as a
// side effect, so a build that resolved an older version installed it
// silently: a machine switched to nightly walked itself back to stable on the
// next check. The mock reproduces that setter faithfully; the tests pin both
// the resulting flags and the order they're written in.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppSettings } from '../shared/types';

let version = '0.16.1';

vi.mock('electron', () => ({
  app: {
    isPackaged: true,
    getVersion: () => version,
  },
}));

let settings: AppSettings;

vi.mock('./store', () => ({
  Store: { load: () => ({ settings }) },
}));

vi.mock('./diagnostics', () => ({ log: () => {} }));

// Hoisted, so a plain top-level `import` of the module under test is enough:
// `vi.mock`'s factory runs when that import resolves, which is before an
// ordinary `const` here would have initialized. The alternative — a top-level
// `await import(...)` — does not compile under the main process's tsconfig.
const { autoUpdater } = vi.hoisted(() => ({
  autoUpdater: {
    _channel: null as string | null,
    allowPrerelease: false,
    allowDowngrade: false,
    autoDownload: false,
    autoInstallOnAppQuit: false,
    logger: null as unknown,
    get channel() {
      return this._channel;
    },
    // Mirrors AppUpdater's real setter, side effect and all.
    set channel(value: string | null) {
      this._channel = value;
      this.allowDowngrade = true;
    },
    on: () => {},
    checkForUpdates: () => Promise.resolve(null),
    quitAndInstall: () => {},
  },
}));

vi.mock('electron-updater', () => ({ autoUpdater }));

import { initAutoUpdater, refreshUpdateChannel } from './updater';

function init(channel: 'stable' | 'nightly', currentVersion: string) {
  version = currentVersion;
  settings = { updateChannel: channel } as AppSettings;
  autoUpdater._channel = null;
  autoUpdater.allowPrerelease = false;
  autoUpdater.allowDowngrade = false;
  initAutoUpdater(() => null);
}

describe('update channel', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  it('follows the latest feed on stable', () => {
    init('stable', '0.16.1');
    expect(autoUpdater.channel).toBe('latest');
    expect(autoUpdater.allowPrerelease).toBe(false);
  });

  it('follows the nightly prerelease feed on nightly', () => {
    init('nightly', '0.16.2-nightly.20260829.abc');
    expect(autoUpdater.channel).toBe('nightly');
    expect(autoUpdater.allowPrerelease).toBe(true);
  });

  it('never downgrades a stable build', () => {
    init('stable', '0.16.1');
    expect(autoUpdater.allowDowngrade).toBe(false);
  });

  // The regression: nightly sorts above the stable release it was built from,
  // so anything the feed offers going backwards is a build the user did not
  // ask for.
  it('never downgrades a nightly build off the nightly channel', () => {
    init('nightly', '0.16.2-nightly.20260829.abc');
    expect(autoUpdater.allowDowngrade).toBe(false);
  });

  // The one intentional way back: the user picks Stable while running a
  // nightly, which is a downgrade by definition.
  it('downgrades a nightly build when the user asks for stable', () => {
    init('stable', '0.16.2-nightly.20260829.abc');
    expect(autoUpdater.allowDowngrade).toBe(true);
  });

  it('re-applies the flags when the setting changes mid-session', () => {
    init('stable', '0.16.1');
    settings = { updateChannel: 'nightly' } as AppSettings;
    refreshUpdateChannel();
    expect(autoUpdater.channel).toBe('nightly');
    expect(autoUpdater.allowPrerelease).toBe(true);
    expect(autoUpdater.allowDowngrade).toBe(false);
  });
});
