import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { compareVersions, parseChangelog, releasesSince } from './changelog';

const SAMPLE = `# Changelog

All notable changes are documented here.

## [Unreleased]

### Added
- Something still in flight.

## [0.12.0] - 2026-07-30

### Added
- **File editor tabs.** Opening a second file replaced the first ([#126](https://example.com/126)).
- **Open files come back.** Tabs are scoped per conversation.

### Fixed
- **The context meter no longer overstates occupancy.**

## [0.11.0] - 2026-07-20

### Added
- **Context-window occupancy in the footer.**
`;

describe('parseChangelog', () => {
  it('skips Unreleased and keeps shipped versions newest-first as written', () => {
    const releases = parseChangelog(SAMPLE);
    expect(releases.map((r) => r.version)).toEqual(['0.12.0', '0.11.0']);
  });

  it('captures the release date', () => {
    expect(parseChangelog(SAMPLE)[0].date).toBe('2026-07-30');
  });

  it('groups entries under their section heading', () => {
    const [latest] = parseChangelog(SAMPLE);
    expect(latest.sections.map((s) => s.heading)).toEqual(['Added', 'Fixed']);
    expect(latest.sections[0].entries).toHaveLength(2);
    expect(latest.sections[1].entries).toHaveLength(1);
  });

  it('keeps the bullet markdown, including links', () => {
    const entry = parseChangelog(SAMPLE)[0].sections[0].entries[0];
    expect(entry).toContain('**File editor tabs.**');
    expect(entry).toContain('[#126](https://example.com/126)');
    expect(entry.startsWith('- ')).toBe(false);
  });

  it('folds a wrapped bullet into one entry', () => {
    const releases = parseChangelog(
      '## [1.0.0] - 2026-01-01\n\n### Added\n- A bullet that\n  wraps across lines.\n',
    );
    expect(releases[0].sections[0].entries).toEqual(['A bullet that wraps across lines.']);
  });

  it('separates bullets that a blank line splits', () => {
    const releases = parseChangelog(
      '## [1.0.0]\n\n### Added\n- First.\n\n- Second.\n',
    );
    expect(releases[0].sections[0].entries).toEqual(['First.', 'Second.']);
  });

  it('files a bullet with no section under an unnamed one', () => {
    const releases = parseChangelog('## [1.0.0] - 2026-01-01\n\n- Loose bullet.\n');
    expect(releases[0].sections).toEqual([{ heading: '', entries: ['Loose bullet.'] }]);
  });

  it('drops a release header with no entries under it', () => {
    const releases = parseChangelog('## [1.0.0] - 2026-01-01\n\nJust prose.\n\n## [0.9.0]\n\n### Added\n- Real.\n');
    expect(releases.map((r) => r.version)).toEqual(['0.9.0']);
  });

  it('returns nothing for an empty or headerless document', () => {
    expect(parseChangelog('')).toEqual([]);
    expect(parseChangelog('# Changelog\n\nNothing here yet.\n')).toEqual([]);
  });
});

describe('compareVersions', () => {
  it('orders by numeric component, not lexically', () => {
    expect(compareVersions('0.9.0', '0.10.0')).toBeLessThan(0);
    expect(compareVersions('1.0.0', '0.99.99')).toBeGreaterThan(0);
    expect(compareVersions('0.12.0', '0.12.0')).toBe(0);
  });

  it('treats a missing component as zero', () => {
    expect(compareVersions('1.0', '1.0.0')).toBe(0);
    expect(compareVersions('1.0', '1.0.1')).toBeLessThan(0);
  });

  it('tolerates a leading v', () => {
    expect(compareVersions('v0.12.0', '0.12.0')).toBe(0);
  });

  it('sorts a nightly prerelease below the release it precedes', () => {
    expect(compareVersions('0.13.0-nightly.20260731.abc', '0.13.0')).toBeLessThan(0);
    expect(compareVersions('0.13.0-nightly.20260731.abc', '0.12.0')).toBeGreaterThan(0);
  });

  it('orders two nightlies of the same base by their stamp', () => {
    expect(
      compareVersions('0.13.0-nightly.20260730.aaa', '0.13.0-nightly.20260731.aaa'),
    ).toBeLessThan(0);
  });
});

describe('releasesSince', () => {
  const releases = parseChangelog(SAMPLE);

  it('returns only versions newer than lastSeen', () => {
    expect(releasesSince(releases, '0.11.0', '0.12.0').map((r) => r.version)).toEqual(['0.12.0']);
  });

  it('returns every skipped release when the user jumped versions', () => {
    expect(releasesSince(releases, '0.10.0', '0.12.0').map((r) => r.version)).toEqual([
      '0.12.0',
      '0.11.0',
    ]);
  });

  it('returns nothing when lastSeen is already current', () => {
    expect(releasesSince(releases, '0.12.0', '0.12.0')).toEqual([]);
  });

  it('never returns notes for a version ahead of the running build', () => {
    // Changelog committed ahead of the release the user actually has.
    expect(releasesSince(releases, '0.10.0', '0.11.0').map((r) => r.version)).toEqual(['0.11.0']);
  });

  it('returns everything up to current when lastSeen is unknown', () => {
    expect(releasesSince(releases, undefined, '0.12.0').map((r) => r.version)).toEqual([
      '0.12.0',
      '0.11.0',
    ]);
  });

  it('sorts newest-first regardless of file order', () => {
    const outOfOrder = parseChangelog(
      '## [0.11.0]\n\n### Added\n- Old.\n\n## [0.12.0]\n\n### Added\n- New.\n',
    );
    expect(releasesSince(outOfOrder, undefined, '0.12.0').map((r) => r.version)).toEqual([
      '0.12.0',
      '0.11.0',
    ]);
  });
});

describe('the real CHANGELOG.md', () => {
  const md = fs.readFileSync(path.resolve(__dirname, '..', '..', 'CHANGELOG.md'), 'utf-8');
  const releases = parseChangelog(md);

  it('parses into releases with entries', () => {
    expect(releases.length).toBeGreaterThan(3);
    for (const r of releases) {
      expect(r.version).toMatch(/^\d+\.\d+\.\d+$/);
      expect(r.sections.some((s) => s.entries.length > 0)).toBe(true);
    }
  });

  it('covers the version in package.json, so a release ships its own notes', () => {
    const pkg = JSON.parse(
      fs.readFileSync(path.resolve(__dirname, '..', '..', 'package.json'), 'utf-8'),
    ) as { version: string };
    expect(releases.map((r) => r.version)).toContain(pkg.version);
  });
});
