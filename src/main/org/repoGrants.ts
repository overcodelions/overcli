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
let base: string[] = [];

/// The serve allow-list to keep up to date. Only `--permissions allow-list`
/// has one; without it nothing is narrowed and nothing is added.
export function bindAllowList(list: string[]): void {
  target = list;
  base = [...list];
}

export function applyRepoGrants(repos: Pick<RepoService, 'codeTools' | 'trustedCommands'>): void {
  setTrustedCommands(repos.trustedCommands());
  if (!target) return;
  const extra = repos.codeTools().filter((t) => !base.includes(t));
  target.splice(0, target.length, ...base, ...extra);
}
