// Files no worker on an org server should read or change.
//
// A worker trusted to act runs in bypassPermissions, where nothing asks before
// a Read. These go to Claude as `--disallowedTools` rules, which hold for its
// file tools in every mode: the CLIs' config (tool addresses and keys), the
// CLIs' own sign-ins, git and ssh credentials, other processes' environments,
// and the server's state (people's tokens, the audit log, the sealed secrets
// and their keys), and every run's MCP config in the temp folder
// (overcli-perm-*), which holds tool keys and the overdb tool's passwords.
// Change is denied as well as reading: a worker that could
// edit the CLIs' config or org.json could give itself tools or people admin
// rights.
//
// A guard, not a wall: the rules don't reach Claude's shell, Codex or Gemini
// get none, and Linux has no OS sandbox yet, so a worker running shell
// commands unasked can still read these as the server's user. The deploy
// docs (security.md) say so.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let rules: string[] = [];

/// What a rule names a path by: `~/…` under home, `//…` from the root.
function rulePath(p: string): string {
  return p.startsWith('~/') ? p : `/${path.resolve(p)}`;
}

/// The deny rules for these paths, read and change both.
export function credentialRules(dataDir: string): string[] {
  const read = [
    '~/.claude.json',
    '~/.claude.json.*',
    '~/.claude/.credentials.json',
    '~/.codex/**',
    '~/.gemini/**',
    '~/.config/gh/**',
    '~/.git-credentials',
    '~/.ssh/**',
    '/proc/**',
    path.join(dataDir, 'org', '**'),
    path.join(dataDir, 'secrets*'),
    path.join(dataDir, 'org.json'),
  ].map(rulePath);
  const tmp = new Set([os.tmpdir()]);
  try { tmp.add(fs.realpathSync(os.tmpdir())); } catch { /* keep the plain path */ }
  const runConfigs = [...tmp].map((t) => rulePath(path.join(t, 'overcli-perm-*')));
  return [...read, ...runConfigs].flatMap((p) => [`Read(${p})`, `Edit(${p})`]);
}

/// Turn the guard on for every Claude process this server spawns.
export function guardCredentials(dataDir: string): void {
  rules = credentialRules(dataDir);
}

export function credentialDenyRules(): string[] {
  return rules;
}
