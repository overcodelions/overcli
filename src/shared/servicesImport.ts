// The shape of an imported configuration, shared with the pane.
//
// Kept apart from `services.ts` because these are not part of the service
// model — they are what a file SAID before anyone accepted it. The pane needs
// the types to render the offer; nothing else does.

import type { ServiceOption } from './services';

/// Where a set of imported services came from, for the sentence offering them.
export type ImportSource = 'intellij' | 'vscode' | 'vscode-tasks' | 'tiltfile' | 'compose' | 'procfile';

export interface ImportedService {
  name: string;
  /// Command as argv, when the file states one. Absent for IntelliJ and
  /// VS Code Java configs, which name a main class instead — those are paired
  /// with a detected module to work out how to actually start.
  command?: string[];
  options: ServiceOption[];
  env: Record<string, string>;
  subpath?: string;
  port?: number;
  /// Attach port stated by the source, such as Tilt's debug_port parameter.
  debugPort?: number;
  group?: string;
  /// The IntelliJ module or compose service name, matched against detection.
  moduleHint?: string;
  /// The folder name of the repo the file says it runs in — a Tiltfile's
  /// `serve_dir`, or the `repo` its helper was handed. Decides which project
  /// the service belongs to when its name says nothing about that.
  repoHint?: string;
  /// The Node version the file switches to before starting it (a Tiltfile
  /// helper's `node_version`), for a detected command that would otherwise
  /// run under whatever Node the app launched with.
  nodeVersion?: string;
  /// The text in the file that defines it, for a model asked why it will not
  /// start — the real start line often lives there and nowhere else.
  excerpt?: string;
  /// Runs once and exits — a Tiltfile `local_resource` with `cmd=` and no
  /// `serve_cmd=`.
  task?: boolean;
  /// Names of what must be up or done first, as the file states them (Tilt's
  /// `resource_deps`). Names, not ids: the ids exist only once imported.
  deps?: string[];
  source: ImportSource;
}

export interface ImportSet {
  source: ImportSource;
  /// Path relative to the project, for the "found this" sentence.
  file: string;
  services: ImportedService[];
}

/// What to call each source on screen.
export const IMPORT_SOURCE_LABELS: Record<ImportSource, string> = {
  intellij: 'IntelliJ run configurations',
  vscode: 'VS Code launch configurations',
  'vscode-tasks': 'VS Code tasks',
  tiltfile: 'Tiltfile resources',
  compose: 'Docker Compose services',
  procfile: 'Procfile entries',
};
