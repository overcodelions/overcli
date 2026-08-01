/// Parser for the repo's CHANGELOG.md, which drives the in-app "What's new"
/// panel.
///
/// The changelog is the source rather than the GitHub release body because
/// release.yml publishes with `generate_release_notes: true` — that body is a
/// machine-generated list of PR titles ("Merge pull request #126"), while the
/// changelog carries prose a user can actually read. The file ships inside the
/// app bundle (see `build.files` in package.json), so this parse is local and
/// offline.
///
/// Format is Keep a Changelog: `## [0.12.0] - 2026-07-30` release headers,
/// `### Added` / `### Changed` / `### Fixed` groups, and one markdown bullet
/// per entry. `## [Unreleased]` is skipped — it names no shipped version.

export interface ChangelogSection {
  /// 'Added' | 'Changed' | 'Fixed' | 'Removed' | 'Security' | …
  heading: string;
  /// One markdown bullet each, with the leading `- ` stripped. Wrapped
  /// continuation lines are folded back into a single string so the entry
  /// renders as one paragraph.
  entries: string[];
}

export interface ChangelogRelease {
  version: string;
  /// The `- YYYY-MM-DD` suffix on the header, when present.
  date?: string;
  sections: ChangelogSection[];
}

const RELEASE_HEADER = /^##\s+\[([^\]]+)\]\s*(?:-\s*(.+?))?\s*$/;
const SECTION_HEADER = /^###\s+(.+?)\s*$/;
const BULLET = /^[-*]\s+(.*)$/;

export function parseChangelog(markdown: string): ChangelogRelease[] {
  const releases: ChangelogRelease[] = [];
  let release: ChangelogRelease | null = null;
  let section: ChangelogSection | null = null;
  // Index of the entry currently accepting continuation lines, or -1 when
  // the last line ended an entry (blank line, new heading, new bullet).
  let openEntry = -1;

  for (const raw of markdown.split(/\r?\n/)) {
    const line = raw.trimEnd();

    const releaseMatch = RELEASE_HEADER.exec(line);
    if (releaseMatch) {
      const version = releaseMatch[1].trim();
      section = null;
      openEntry = -1;
      // "Unreleased" is a staging area, not a version anyone is running.
      if (/^unreleased$/i.test(version)) {
        release = null;
        continue;
      }
      release = { version, date: releaseMatch[2]?.trim() || undefined, sections: [] };
      releases.push(release);
      continue;
    }

    if (!release) continue;

    const sectionMatch = SECTION_HEADER.exec(line);
    if (sectionMatch) {
      section = { heading: sectionMatch[1], entries: [] };
      release.sections.push(section);
      openEntry = -1;
      continue;
    }

    if (!line.trim()) {
      openEntry = -1;
      continue;
    }

    const bulletMatch = BULLET.exec(line.trim());
    if (bulletMatch) {
      // A bullet before any `###` still belongs somewhere — file it under an
      // unnamed section rather than dropping it.
      if (!section) {
        section = { heading: '', entries: [] };
        release.sections.push(section);
      }
      section.entries.push(bulletMatch[1].trim());
      openEntry = section.entries.length - 1;
      continue;
    }

    // A wrapped continuation of the bullet above.
    if (section && openEntry >= 0) {
      section.entries[openEntry] += ` ${line.trim()}`;
    }
  }

  // A release header with no bullets under it (or one holding only prose we
  // don't model) would render as an empty card.
  return releases.filter((r) => r.sections.some((s) => s.entries.length > 0));
}

/// Compare two semver-ish version strings. Returns <0, 0 or >0 like a sort
/// comparator. Handles the nightly channel's `0.13.0-nightly.20260731.abc123`
/// stamps: per semver, any prerelease sorts *below* the release it precedes.
export function compareVersions(a: string, b: string): number {
  const split = (v: string) => {
    const [core, ...pre] = v.replace(/^v/, '').split('-');
    return { core: core.split('.').map((n) => parseInt(n, 10) || 0), pre: pre.join('-') };
  };
  const av = split(a);
  const bv = split(b);
  for (let i = 0; i < Math.max(av.core.length, bv.core.length); i++) {
    const diff = (av.core[i] ?? 0) - (bv.core[i] ?? 0);
    if (diff !== 0) return diff < 0 ? -1 : 1;
  }
  if (av.pre === bv.pre) return 0;
  // Absent prerelease outranks any prerelease.
  if (!av.pre) return 1;
  if (!bv.pre) return -1;
  return av.pre < bv.pre ? -1 : 1;
}

/// The releases a user on `lastSeen` hasn't been shown yet, newest first.
///
/// Bounded above by `current` so a stable user never reads notes for a version
/// they aren't running, and bounded below by `lastSeen` exclusive. Someone who
/// skips 0.10 and 0.11 and lands on 0.12 gets all three — that's the case
/// where the panel earns its keep, and showing only the newest would bury two
/// releases of work.
export function releasesSince(
  releases: ChangelogRelease[],
  lastSeen: string | undefined,
  current: string,
): ChangelogRelease[] {
  return releases
    .filter((r) => compareVersions(r.version, current) <= 0)
    .filter((r) => !lastSeen || compareVersions(r.version, lastSeen) > 0)
    .sort((a, b) => compareVersions(b.version, a.version));
}
