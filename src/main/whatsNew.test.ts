// The "What's new" panel's decision logic: when to surface release notes
// unprompted, and when to stay quiet.
//
// The parsing is covered in src/shared/changelog.test.ts. What's tested here
// is everything that could annoy a user: showing a first-time user four
// changelogs, showing an upgrading user the notes for a version they've
// already read, or firing on every nightly build.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppSettings } from '../shared/types';

let version = '0.12.0';
let appPath: string;

vi.mock('electron', () => ({
  app: {
    getVersion: () => version,
    getAppPath: () => appPath,
  },
}));

let settings: AppSettings;
const saved: AppSettings[] = [];

vi.mock('./store', () => ({
  Store: {
    load: () => ({ settings }),
    saveSettings: (s: AppSettings) => {
      settings = s;
      saved.push(s);
    },
  },
}));

vi.mock('./diagnostics', () => ({ log: () => {} }));

const CHANGELOG = `# Changelog

## [Unreleased]

### Added
- Not shipped yet.

## [0.12.0] - 2026-07-30

### Added
- **Twelve.**

## [0.11.0] - 2026-07-20

### Added
- **Eleven.**

## [0.10.0] - 2026-07-10

### Added
- **Ten.**

## [0.9.0] - 2026-07-01

### Added
- **Nine.**

## [0.8.0] - 2026-06-20

### Added
- **Eight.**

## [0.7.0] - 2026-06-10

### Added
- **Seven.**
`;

/// The module caches the parsed changelog in module scope, so each test needs
/// a fresh import to pick up its own fixture and settings.
async function load() {
  vi.resetModules();
  return import('./whatsNew');
}

beforeEach(() => {
  version = '0.12.0';
  saved.length = 0;
  settings = {} as AppSettings;
  appPath = fs.mkdtempSync(path.join(os.tmpdir(), 'overcli-whatsnew-'));
  fs.writeFileSync(path.join(appPath, 'CHANGELOG.md'), CHANGELOG);
});

afterEach(() => {
  fs.rmSync(appPath, { recursive: true, force: true });
});

describe('seedWhatsNewBaseline', () => {
  it('stamps the running version when there is no baseline', async () => {
    const { seedWhatsNewBaseline } = await load();
    seedWhatsNewBaseline();
    expect(settings.lastSeenVersion).toBe('0.12.0');
  });

  it('leaves an existing baseline alone', async () => {
    settings = { lastSeenVersion: '0.10.0' } as AppSettings;
    const { seedWhatsNewBaseline } = await load();
    seedWhatsNewBaseline();
    expect(settings.lastSeenVersion).toBe('0.10.0');
    expect(saved).toHaveLength(0);
  });

  it('leaves the rest of settings untouched', async () => {
    settings = { updateChannel: 'nightly', sidebarWidth: 300 } as AppSettings;
    const { seedWhatsNewBaseline } = await load();
    seedWhatsNewBaseline();
    expect(settings.updateChannel).toBe('nightly');
    expect(settings.sidebarWidth).toBe(300);
  });
});

describe('getWhatsNew', () => {
  it('flags unseen and lists every release the user skipped', async () => {
    settings = { lastSeenVersion: '0.10.0' } as AppSettings;
    const { getWhatsNew } = await load();
    const report = getWhatsNew();
    expect(report.unseen).toBe(true);
    expect(report.releases.map((r) => r.version)).toEqual(['0.12.0', '0.11.0']);
    expect(report.currentVersion).toBe('0.12.0');
  });

  it('stays quiet when the user is current', async () => {
    settings = { lastSeenVersion: '0.12.0' } as AppSettings;
    const { getWhatsNew } = await load();
    expect(getWhatsNew().unseen).toBe(false);
  });

  it('stays quiet on a fresh install, before any baseline exists', async () => {
    const { getWhatsNew } = await load();
    expect(getWhatsNew().unseen).toBe(false);
  });

  it('stays quiet on the nightly channel, which ships off Unreleased', async () => {
    settings = { lastSeenVersion: '0.10.0', updateChannel: 'nightly' } as AppSettings;
    const { getWhatsNew } = await load();
    expect(getWhatsNew().unseen).toBe(false);
  });

  it('still has content to show when nothing is unread, for a deliberate visit', async () => {
    settings = { lastSeenVersion: '0.12.0' } as AppSettings;
    const { getWhatsNew } = await load();
    const report = getWhatsNew();
    expect(report.unseen).toBe(false);
    expect(report.releases[0].version).toBe('0.12.0');
  });

  it('caps a long backlog and reports what it dropped', async () => {
    settings = { lastSeenVersion: '0.7.0' } as AppSettings;
    const { getWhatsNew } = await load();
    const report = getWhatsNew();
    expect(report.releases.map((r) => r.version)).toEqual(['0.12.0', '0.11.0', '0.10.0', '0.9.0']);
    expect(report.olderCount).toBe(1);
  });

  it('never shows notes for a version ahead of the running build', async () => {
    version = '0.10.0';
    settings = { lastSeenVersion: '0.9.0' } as AppSettings;
    const { getWhatsNew } = await load();
    expect(getWhatsNew().releases.map((r) => r.version)).toEqual(['0.10.0']);
  });

  it('degrades to an empty panel when the changelog is missing', async () => {
    fs.rmSync(path.join(appPath, 'CHANGELOG.md'));
    settings = { lastSeenVersion: '0.10.0' } as AppSettings;
    const { getWhatsNew } = await load();
    const report = getWhatsNew();
    expect(report.releases).toEqual([]);
    expect(report.unseen).toBe(false);
  });
});

describe('markWhatsNewSeen', () => {
  it('advances the baseline to the running version', async () => {
    settings = { lastSeenVersion: '0.10.0' } as AppSettings;
    const { getWhatsNew, markWhatsNewSeen } = await load();
    markWhatsNewSeen();
    expect(settings.lastSeenVersion).toBe('0.12.0');
    expect(getWhatsNew().unseen).toBe(false);
  });

  it('does not write when the baseline is already current', async () => {
    settings = { lastSeenVersion: '0.12.0' } as AppSettings;
    const { markWhatsNewSeen } = await load();
    markWhatsNewSeen();
    expect(saved).toHaveLength(0);
  });
});
