// OS-enforced write jail for flow-step agent processes (macOS Seatbelt).
//
// A flow step's backend CLI runs unattended, usually under
// `bypassPermissions`, with the user's full environment. Before this module
// its only containment was "cwd happens to be a git worktree" — nothing
// stopped an absolute-path write to ~/.ssh, ~/Desktop or another project.
// `riskScan.ts` is a text heuristic and says so; this is the boundary.
//
// Mechanism: spawn `/usr/bin/sandbox-exec -f <profile> <binary> <args…>`
// where the profile allows everything except file writes, then re-allows
// writes under an explicit list of roots. Verified empirically on macOS 26
// (see seatbeltProfile.live.test.ts), including two traps the textbook
// profile misses:
//   - Seatbelt matches REAL paths. /tmp is /private/tmp and $TMPDIR lives
//     under /private/var/folders, so every root is realpath'd first; a
//     root spelled through a symlink silently matches nothing.
//   - `(deny file-write* (subpath "/"))` also denies /dev/null and ttys,
//     which breaks nearly every shell command. Those are re-allowed.
// Later rules win over earlier ones, which is what lets the allow list
// punch holes in the blanket deny and the deny list (git hooks, git
// config) re-close holes inside an allowed root.
//
// Deliberately NOT restricted: file reads and network egress. Only macOS is
// supported; elsewhere the caller spawns unwrapped and logs once.

import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Backend } from '../../shared/types';

export const SANDBOX_EXEC = '/usr/bin/sandbox-exec';

export function sandboxSupported(platform: NodeJS.Platform = process.platform): boolean {
  return platform === 'darwin';
}

export interface SeatbeltRoots {
  /// Canonical directories (or files) the process may write under.
  writable: string[];
  /// Canonical paths re-denied even when inside a writable root. Emitted
  /// after the allows, so they win.
  denied: string[];
}

/// Device nodes every CLI and shell writes to. Denying `/` takes these too.
const DEVICE_RULES = [
  '(allow file-write* (literal "/dev/null") (literal "/dev/zero") (literal "/dev/dtracehelper")',
  '  (regex #"^/dev/tty") (regex #"^/dev/fd/") (regex #"^/dev/ptmx$") (regex #"^/dev/ttys"))',
];

function sbplString(p: string): string {
  return `"${p.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;
}

/// Pure: the SBPL text for these roots. Paths are used verbatim — pass them
/// through `canonicalRoots` first.
export function buildSeatbeltProfile(roots: SeatbeltRoots): string {
  const lines = [
    '(version 1)',
    '(allow default)',
    '(deny file-write* (subpath "/"))',
    ...DEVICE_RULES,
  ];
  for (const root of roots.writable) lines.push(`(allow file-write* (subpath ${sbplString(root)}))`);
  for (const root of roots.denied) lines.push(`(deny file-write* (subpath ${sbplString(root)}))`);
  return lines.join('\n') + '\n';
}

/// Resolve each path to its real location and drop duplicates, preserving
/// order. Seatbelt only matches real paths, so a root spelled through a
/// symlink (/tmp, /var) would silently match nothing. A path that does not
/// exist YET keeps its missing tail under its deepest real ancestor: a CLI
/// creates its state dirs on first use (claude's transcript dir for a fresh
/// worktree is the case that matters — drop it and `--resume` breaks on the
/// next step).
export function canonicalRoots(paths: readonly string[]): string[] {
  const out: string[] = [];
  for (const p of paths) {
    if (!p || !path.isAbsolute(p)) continue;
    const real = realpathAllowingMissing(path.resolve(p));
    if (real && !out.includes(real)) out.push(real);
  }
  return out;
}

function realpathAllowingMissing(p: string): string | null {
  const tail: string[] = [];
  let cur = p;
  for (;;) {
    try {
      return path.join(fs.realpathSync.native(cur), ...tail.reverse());
    } catch {
      const parent = path.dirname(cur);
      if (parent === cur) return null;
      tail.push(path.basename(cur));
      cur = parent;
    }
  }
}

/// Claude's per-project transcript directory name: every non-alphanumeric
/// character of the real cwd becomes `-` (observed: `/private/tmp/a.b_c` →
/// `-private-tmp-a-b-c`). overcli's own `claudeProjectSlug` only rewrites
/// `/ . space`; both spellings are granted so neither drifts us into a
/// broken `--resume`.
export function claudeTranscriptSlugs(cwd: string): string[] {
  let real = cwd;
  try {
    real = fs.realpathSync.native(cwd);
  } catch {
    /* keep raw */
  }
  const cliSlug = real.replace(/[^a-zA-Z0-9]/g, '-');
  const overcliSlug = real.replaceAll('/', '-').replaceAll('.', '-').replaceAll(' ', '-');
  return cliSlug === overcliSlug ? [cliSlug] : [cliSlug, overcliSlug];
}

/// The minimum per-CLI state each backend needs to write to function,
/// determined by running each CLI under a cwd+tmp-only profile and reading
/// the Seatbelt deny log (`log show --predicate 'eventMessage CONTAINS
/// "deny"'`). Without these: claude cannot `--resume` its own session
/// (transcript write denied), codex refuses to start ("failed to initialize
/// in-process app-server client"), gemini hangs on its oauth/projects lock,
/// and copilot cannot persist session events.
///
/// Claude is scoped per-subdirectory on purpose: `~/.claude/settings.json`,
/// `~/.claude/hooks`, `~/.claude.json` (user MCP servers) and other
/// projects' transcript/memory dirs stay read-only, so a jailed step cannot
/// plant config that the user's next unsandboxed chat would execute. Claude
/// tolerates the `~/.claude.json` write being denied (verified: `-p` and
/// `--resume` both work). The other three CLIs keep config and state in one
/// directory, so their whole dot-dir is granted — a known residual.
export function backendStateDirs(backend: Backend, home: string, cwd: string): string[] {
  const claude = path.join(home, '.claude');
  // MCP servers are commonly launched through npx/uvx, which write caches.
  const launchers = [
    path.join(home, '.npm', '_cacache'),
    path.join(home, '.npm', '_logs'),
    path.join(home, '.npm', '_npx'),
    path.join(home, '.cache', 'uv'),
  ];
  switch (backend) {
    case 'claude':
      return [
        ...claudeTranscriptSlugs(cwd).map((slug) => path.join(claude, 'projects', slug)),
        path.join(claude, 'sessions'),
        path.join(claude, 'session-env'),
        path.join(claude, 'todos'),
        path.join(claude, 'shell-snapshots'),
        path.join(claude, 'statsig'),
        path.join(claude, 'debug'),
        path.join(claude, 'file-history'),
        path.join(claude, 'plugins', 'cache'),
        path.join(home, '.local', 'state', 'claude'),
        path.join(home, 'Library', 'Caches', 'claude-cli-nodejs'),
        ...launchers,
      ];
    case 'codex':
      return [path.join(home, '.codex'), ...launchers];
    case 'gemini':
      return [path.join(home, '.gemini'), ...launchers];
    case 'copilot':
      return [path.join(home, '.copilot'), ...launchers];
    default:
      return [];
  }
}

/// The repository's shared git directory for a worktree. A linked worktree
/// writes commits, refs and its index into the MAIN checkout's `.git`
/// (`.git/worktrees/<name>`, `.git/objects`, `.git/refs`), so a jail
/// that only allows the worktree would make every committing step fail.
export function gitCommonDir(cwd: string): string | null {
  try {
    const res = spawnSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], {
      cwd,
      encoding: 'utf-8',
      timeout: 5000,
    });
    if (res.status !== 0) return null;
    const dir = res.stdout.trim();
    return dir ? dir : null;
  } catch {
    return null;
  }
}

export interface SandboxRootsInput {
  backend: Backend;
  cwd: string;
  /// Extra directories the step legitimately writes (the flow attachment dir).
  extraWritable?: readonly string[];
  /// Extra git checkouts the step writes (workspace member worktrees reached
  /// through symlinks in cwd). Like cwd, each one's git common dir is
  /// granted. Kept apart from `extraWritable` so a non-repo dir never
  /// picks up the git dir of whatever repository happens to enclose it.
  extraRepos?: readonly string[];
  home?: string;
  tmpdir?: string;
  /// Injectable for tests.
  gitCommonDirFor?: (dir: string) => string | null;
}

/// Every root a sandboxed flow step may write, canonicalised.
///
/// Git hooks and git config under each common dir are re-denied: both are
/// executed/read by the user's later, unsandboxed `git` — a planted hook or
/// `core.hooksPath` is a way out of the jail.
export function sandboxRootsFor(input: SandboxRootsInput): SeatbeltRoots {
  const home = input.home ?? os.homedir();
  const tmp = input.tmpdir ?? os.tmpdir();
  const commonDirOf = input.gitCommonDirFor ?? gitCommonDir;
  let userTmpParent: string | null = null;
  try {
    // $TMPDIR is /var/folders/xx/yyyy/T; its parent also holds the per-user
    // cache dir (C) that node and the CLIs use.
    userTmpParent = path.dirname(fs.realpathSync.native(tmp));
  } catch {
    /* no tmpdir — nothing extra */
  }
  const repoDirs = [input.cwd, ...(input.extraRepos ?? [])];
  const commonDirs = canonicalRoots(
    repoDirs.map((d) => commonDirOf(d)).filter((d): d is string => !!d),
  );
  const writable = canonicalRoots([
    ...repoDirs,
    ...(input.extraWritable ?? []),
    ...commonDirs,
    tmp,
    '/private/tmp',
    ...(userTmpParent ? [userTmpParent] : []),
    ...backendStateDirs(input.backend, home, input.cwd),
  ]);
  const denied = canonicalRoots(
    commonDirs.flatMap((d) => [path.join(d, 'hooks'), path.join(d, 'config')]),
  );
  return { writable, denied };
}

/// Write the profile and return its path. `dir` MUST lie outside every
/// writable root — a jailed step that could edit the profile file would
/// rewrite the jail of the next step. The name is content-addressed, but the
/// file is rewritten every time so a stale or tampered copy never survives.
export function writeSeatbeltProfile(roots: SeatbeltRoots, dir: string): string {
  const text = buildSeatbeltProfile(roots);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, `${createHash('sha256').update(text).digest('hex').slice(0, 16)}.sb`);
  fs.writeFileSync(file, text, { mode: 0o600 });
  return file;
}

/// The argv that runs `binary args…` inside the profile.
export function sandboxedCommand(
  binary: string,
  args: readonly string[],
  profilePath: string,
): { command: string; args: string[] } {
  return { command: SANDBOX_EXEC, args: ['-f', profilePath, binary, ...args] };
}
