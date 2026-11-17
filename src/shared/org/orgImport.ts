// What importing an org file did, or with `dryRun` would do. Shared so the
// app's Settings can show it (src/main/org/orgBundle.ts reads the file).

import type { WorkerTrustLevel } from '../flows/worker';

export type OrgSetupKind = 'rules' | 'handbook' | 'tool' | 'repo' | 'workspace' | 'database' | 'api';

/// What an import did, or with `dryRun`, would do.
export interface OrgImportReport {
  dryRun: boolean;
  /// Whether trust, managers and reporting lines came along, and why.
  keepsTrust: boolean;
  trustWhy: string;
  workers: Array<{
    name: string;
    sourceId: string;
    status: 'added' | 'alreadyHere' | 'failed';
    id?: string;
    trust: WorkerTrustLevel;
    manager: string;
    paused: boolean;
    error?: string;
    /// What came with it and what didn't, as the import says it.
    notes: string[];
  }>;
  teams: Array<{ name: string; status: 'added' | 'updated' | 'failed'; error?: string }>;
  processes: Array<{ name: string; status: 'added' | 'updated' | 'failed'; error?: string }>;
  /// The org's setup: its rules and handbook, applied; its tools, repos,
  /// workspaces, databases and APIs, each left waiting for an admin to add
  /// its keys where that kind is set up (`where`).
  setup: Array<{ kind: OrgSetupKind; name: string; status: 'added' | 'updated' | 'alreadyHere' | 'waiting' | 'skipped' | 'failed'; where?: string; note?: string }>;
  /// Tools the workers use that aren't set up on this server: each waits for
  /// its keys on the Tools page, and its workers can't use it until then.
  needsKeys: Array<{ tool: string; workers: string[] }>;
  notes: string[];
}
