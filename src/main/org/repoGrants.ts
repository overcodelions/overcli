// Keeps the server's allow-list in step with its connected repos: a PR flow's
// git and gh commands, and each repo's test command, are granted while a repo
// is connected and taken back when the last one goes.
//
// The list is the very array `overcli serve` handed its engines (see
// engines.ts), changed in place, so runs launched after a repo is connected
// get the grants without a restart.

import { setTrustedCommands } from '../flows/trustedCommands';
import type { RepoService } from './repos';

let target: string[] | null = null;
let base: () => string[] = () => [];
let extra: string[] = [];

/// The serve allow-list to keep up to date. Only `--permissions allow-list`
/// has one; without it nothing is narrowed and nothing is added.
/// `baseOf`: what the list is before repo grants — the flags it was started
/// with, or the org's access level (workerAccess.ts), read again on refresh.
export function bindAllowList(list: string[], baseOf?: () => string[]): void {
  target = list;
  const start = [...list];
  base = baseOf ?? (() => start);
  refreshAllowList();
}

export function applyRepoGrants(repos: Pick<RepoService, 'codeTools' | 'trustedCommands'>): void {
  setTrustedCommands(repos.trustedCommands());
  extra = repos.codeTools();
  refreshAllowList();
}

/// Rebuild the list in place: its base as it is now, then the repos' grants.
export function refreshAllowList(): void {
  if (!target) return;
  const now = base();
  const next = [...now, ...extra.filter((t) => !now.includes(t))];
  if (next.length === target.length && next.every((t, i) => t === target![i])) return;
  target.splice(0, target.length, ...next);
}
