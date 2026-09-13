// Everything that could be added, in the order worth offering it.
//
// The screen this replaces was a wall: every project in the workspace, each
// with its own "Look for services" and "Add by hand" buttons, and the import
// offers wedged in between rows. It made the reader take the same decision
// twenty-four times before seeing a single service, and it buried the one
// thing that actually knows how these services are configured.
//
// So the pane scans everything once, up front, and shows a RESULT. This module
// is the ranking, and the ranking is the whole argument:
//
//   A CONFIG FILE the user already maintains — an IntelliJ run configuration,
//     a Tiltfile, a launch.json — states the options. It is evidence.
//   DETECTION reads a build file and works out a command. It is a guess, and
//     a guess that cannot know the fifty-seven `-D` flags the service needs.
//
// Evidence first, guesses last, and each group says which it is.

import type { ImportSource, ImportSet, ImportedService } from '@shared/servicesImport';
import { IMPORT_SOURCE_LABELS } from '@shared/servicesImport';
import type { ServiceProposal } from '@shared/services';

/// One thing that could become a service.
export interface Candidate {
  /// Stable across re-renders and unique across every group.
  key: string;
  stackId: string;
  projectId: string;
  projectName: string;
  name: string;
  module?: string;
  command: string;
  port?: number;
  /// The right-hand column: what is known about how to configure it.
  detail: string;
  /// Detection that wants a second look before being trusted.
  uncertain?: boolean;
  /// Exactly one of these is set, and it decides how the add is performed.
  imported?: ImportedService;
  proposal?: { projectId: string; serviceId: string; proposal: ServiceProposal };
}

export interface CandidateGroup {
  id: string;
  title: string;
  /// The file it came from, when it came from one.
  file?: string;
  /// True when the source states the options rather than guessing the command.
  stated: boolean;
  source?: ImportSource;
  stackId: string;
  projectId: string;
  /// Said in the header: two projects each with a launch.json otherwise read
  /// as the same group twice.
  projectName?: string;
  items: Candidate[];
}

/// Config sources in the order they earn trust. IntelliJ and VS Code carry
/// full launch options; a Tiltfile carries the command and a little more; a
/// compose file or Procfile carries a command and not much else.
const SOURCE_RANK: Record<ImportSource, number> = {
  intellij: 0,
  vscode: 1,
  'vscode-tasks': 1,
  tiltfile: 2,
  compose: 3,
  procfile: 4,
};

function optionsDetail(count: number): string {
  if (count === 0) return 'no options';
  return `${count} option${count === 1 ? '' : 's'}`;
}

export function buildCandidates(args: {
  imports: {
    stackId: string;
    projectId: string;
    projectName: string;
    sets: ImportSet[];
  }[];
  detected: {
    stackId: string;
    projectId: string;
    projectName: string;
    found: { projectId: string; serviceId: string; proposal: ServiceProposal }[];
  }[];
  /// Service ids already in a stack. A detected service that is already added
  /// is not a candidate, and offering it again is how duplicates happen.
  existing: ReadonlySet<string>;
}): CandidateGroup[] {
  const groups: CandidateGroup[] = [];

  for (const entry of args.imports) {
    for (const set of entry.sets) {
      const items = set.services.map((service, i) => ({
        key: `import:${entry.stackId}:${entry.projectId}:${set.source}:${set.file}:${i}`,
        stackId: entry.stackId,
        projectId: entry.projectId,
        projectName: entry.projectName,
        name: service.name,
        module: service.moduleHint,
        command: (service.command ?? service.helperCommand)?.join(' ') ?? service.moduleHint ?? '',
        port: service.port,
        detail: optionsDetail(service.options.length),
        imported: service,
      }));
      if (items.length === 0) continue;
      groups.push({
        id: `${entry.stackId}:${entry.projectId}:${set.source}:${set.file}`,
        title: `Your ${IMPORT_SOURCE_LABELS[set.source]}`,
        file: set.file,
        stated: true,
        source: set.source,
        stackId: entry.stackId,
        projectId: entry.projectId,
        projectName: entry.projectName,
        items,
      });
    }
  }

  groups.sort((a, b) => SOURCE_RANK[a.source!] - SOURCE_RANK[b.source!]);

  // One detection group for the whole sweep rather than one per project. The
  // distinction that matters here is "read from a build file", and which
  // project it came from is a column, not a heading.
  const found: Candidate[] = [];
  for (const entry of args.detected) {
    for (const item of entry.found) {
      if (args.existing.has(item.serviceId)) continue;
      found.push({
        key: `detect:${entry.stackId}:${item.serviceId}`,
        stackId: entry.stackId,
        projectId: item.projectId,
        projectName: entry.projectName,
        name: item.proposal.spec.name,
        command: item.proposal.spec.command.join(' '),
        port: item.proposal.spec.port,
        detail: optionsDetail(item.proposal.spec.options?.length ?? 0),
        uncertain: item.proposal.confidence === 'low',
        proposal: item,
      });
    }
  }
  if (found.length > 0) {
    groups.push({
      id: 'detected',
      title: 'Read from your build files',
      stated: false,
      stackId: '',
      projectId: '',
      items: found,
    });
  }

  return groups;
}

/// Narrow by what the user typed. A group with no surviving rows disappears
/// rather than sitting there empty — the count in its header would be a lie.
export function filterCandidates(groups: CandidateGroup[], query: string): CandidateGroup[] {
  const needle = query.trim().toLowerCase();
  if (needle === '') return groups;
  return groups
    .map((g) => ({
      ...g,
      items: g.items.filter((it) =>
        [it.name, it.module, it.command, it.projectName]
          .filter((f): f is string => !!f)
          .some((f) => f.toLowerCase().includes(needle)),
      ),
    }))
    .filter((g) => g.items.length > 0);
}

/// The adds to perform, grouped so an imported set stays a set: importing five
/// IntelliJ configurations of one module together is what factors them into a
/// base plus four differences. Sent one at a time they would be five unrelated
/// services repeating the same forty options.
export function planAdds(
  groups: CandidateGroup[],
  selected: ReadonlySet<string>,
): {
  imports: { stackId: string; projectId: string; services: ImportedService[] }[];
  detected: { stackId: string; item: NonNullable<Candidate['proposal']> }[];
} {
  const imports: { stackId: string; projectId: string; services: ImportedService[] }[] = [];
  const detected: { stackId: string; item: NonNullable<Candidate['proposal']> }[] = [];

  for (const group of groups) {
    const chosen = group.items.filter((it) => selected.has(it.key));
    if (chosen.length === 0) continue;
    if (group.stated) {
      imports.push({
        stackId: group.stackId,
        projectId: group.projectId,
        services: chosen.map((it) => it.imported!).filter(Boolean),
      });
      continue;
    }
    for (const item of chosen) {
      if (item.proposal) detected.push({ stackId: item.stackId, item: item.proposal });
    }
  }
  return { imports, detected };
}
