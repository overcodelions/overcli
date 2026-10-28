// A stack someone else can run: the portable file behind Share and Import.
//
// `stack.json` cannot be handed to anyone. It names checkouts by absolute
// path, services by ids derived from this machine's project ids, and carries
// whatever was typed into an option — passwords included. This is the same
// stack with all three taken out:
//
//   * a checkout becomes a repo, named by its git remote, which the importer
//     matches against their own clones;
//   * deps and copies point at service NAMES, which are ids again on import;
//   * a value that reads as a credential becomes `${NAME}`, and every name the
//     stack refers to is listed, so the importer is asked for each one.
//
// Data only, like `services.ts`: the engine reads and writes these, the pane
// renders them.

import type { ServiceSpec } from './services';

export const SHARED_STACK_FORMAT = 'overcli-stack/1';

/// Where a group of services lives. `remote` is how an importer finds their
/// own clone; `name` is the folder name, the fallback when there is no remote.
export interface SharedRepo {
  name: string;
  /// Normalised — `github.com/acme/billing` — so ssh and https clones match.
  remote?: string;
}

/// A service with everything about this machine taken out.
export type SharedService = Omit<
  ServiceSpec,
  'id' | 'projectId' | 'deps' | 'copyOf' | 'importedFrom' | 'debugEnabled'
> & {
  /// Key into `SharedStack.repos`.
  repo: string;
  /// By name, not id: ids are made from the exporter's project ids.
  deps?: string[];
  copyOf?: string;
};

export interface SharedStack {
  format: typeof SHARED_STACK_FORMAT;
  name: string;
  exportedAt: string;
  repos: Record<string, SharedRepo>;
  services: SharedService[];
  /// Every `${NAME}` the services refer to: machine values the exporter had
  /// and secrets taken out on the way. Names only — never a value.
  values: string[];
}

/// What an export did not carry, said in the sheet so nobody is surprised by
/// what is missing on the other end.
export interface SharePreview {
  stack: SharedStack;
  text: string;
  /// Credentials typed straight into an option or variable, now `${NAME}`.
  scrubbed: { name: string; from: { service: string; key: string }[] }[];
  /// One line each: "2 linked config files", "pins on 3 services".
  dropped: string[];
}

/// One repo of an incoming stack and where it was found on this machine.
export interface SharedRepoMatch {
  key: string;
  repo: SharedRepo;
  /// The services that live in it.
  services: number;
  match?: { projectId?: string; path: string };
}
