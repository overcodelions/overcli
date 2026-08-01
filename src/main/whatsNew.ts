import { app } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { parseChangelog, releasesSince, type ChangelogRelease } from '../shared/changelog';
import type { WhatsNewReport } from '../shared/types';
import { log } from './diagnostics';
import { Store } from './store';

/// Unseen releases rendered at once. A user two versions behind should read
/// both; a user who last opened the app six months ago does not want twelve
/// changelogs in a modal. The remainder is reported as `olderCount` rather
/// than dropped silently, and the full history is a click away on GitHub.
const MAX_RELEASES = 4;

let cached: ChangelogRelease[] | null = null;

/// CHANGELOG.md ships alongside dist/ inside the asar (see `build.files` in
/// package.json). `getAppPath()` resolves to the directory holding
/// package.json in both dev and packaged builds, so one path covers both.
function changelogPath(): string {
  return path.join(app.getAppPath(), 'CHANGELOG.md');
}

function releases(): ChangelogRelease[] {
  if (cached) return cached;
  try {
    cached = parseChangelog(fs.readFileSync(changelogPath(), 'utf-8'));
  } catch (err) {
    // A missing changelog is a packaging problem, not a reason to fail a
    // launch — the panel just stays empty.
    log('warn', 'whatsNew', `could not read ${changelogPath()}`, err);
    cached = [];
  }
  return cached;
}

/// Stamp the baseline on first launch so the panel only ever fires on an
/// actual upgrade.
///
/// An install with no `lastSeenVersion` is either brand new or predates this
/// feature, and nothing distinguishes the two. Both get stamped silently:
/// showing a first-time user the last four changelogs is worse than showing an
/// upgrading user nothing once. From the next update on, both behave the same.
export function seedWhatsNewBaseline(): void {
  const settings = Store.load().settings;
  if (settings.lastSeenVersion) return;
  Store.saveSettings({ ...settings, lastSeenVersion: app.getVersion() });
  log('info', 'whatsNew', `seeded lastSeenVersion = ${app.getVersion()}`);
}

export function getWhatsNew(): WhatsNewReport {
  const currentVersion = app.getVersion();
  const settings = Store.load().settings;
  const lastSeen = settings.lastSeenVersion;
  const unread = releasesSince(releases(), lastSeen, currentVersion);

  // Nightly ships several times a week off `## [Unreleased]`, which carries no
  // version and so never parses into a release. Surfacing a panel there would
  // mostly show the last tagged release over and over; the manual entry point
  // still works, so nothing is unreachable.
  const nightly = settings.updateChannel === 'nightly';
  const unseen = Boolean(lastSeen) && !nightly && unread.length > 0;

  // With nothing unread, the sheet can still be opened deliberately from
  // About — so fall back to recent history rather than handing it an empty
  // panel. `unseen` is what distinguishes "something landed" from "you came
  // looking", and it stays false here.
  const shown = unread.length > 0 ? unread : releasesSince(releases(), undefined, currentVersion);

  return {
    currentVersion,
    releases: shown.slice(0, MAX_RELEASES),
    olderCount: Math.max(0, shown.length - MAX_RELEASES),
    unseen,
  };
}

export function markWhatsNewSeen(): void {
  const settings = Store.load().settings;
  if (settings.lastSeenVersion === app.getVersion()) return;
  Store.saveSettings({ ...settings, lastSeenVersion: app.getVersion() });
}
