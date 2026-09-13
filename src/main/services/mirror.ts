// Local config that lives in the main checkout and nowhere else.
//
// A Spring module reads `application-local.properties` from its own resources
// directory; a Node app reads `.env`; a .NET one `appsettings.Development.json`.
// Those files are gitignored — they hold a database password and a path that
// is true only on one machine — so they exist in the main checkout and in NO
// worktree, because a worktree gets tracked files and nothing else.
//
// Point a service at a worktree and it fails on a placeholder it has always
// been able to resolve: `Could not resolve placeholder 'proc.database.ip'`.
// Nothing is wrong with the branch; the config simply is not there.
//
// So: mirror it. Every gitignored config file present in the main checkout and
// missing from the bound worktree is symlinked across at the same relative
// path. One source of truth, no copies to drift, and editing it in the main
// checkout reaches every worktree at once. A real file already in the worktree
// is never touched — that one is the user's own and may be deliberately
// different.
//
// What counts as "not in git" is git's answer, not a list of names guessed at:
// the ignored files, narrowed to the ones that look like configuration.
//
// The Tiltfile this pane was modelled on does exactly this, for exactly this
// reason. It is not a workaround; it is what running from a worktree requires.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

/// The names mirrored when git cannot say what is ignored. The old rule, kept
/// as the fallback because it is always safe.
export const LOCAL_CONFIG_NAMES = [
  'application-local.properties',
  'application-local.yml',
  'application-local.yaml',
  '.env.local',
];

/// Extensions of files that configure a running service.
const CONFIG_EXTENSIONS = new Set([
  '.properties',
  '.yml',
  '.yaml',
  '.json',
  '.toml',
  '.ini',
  '.xml',
  '.conf',
  '.cfg',
  '.env',
]);

/// Files a package manager writes, whatever their extension.
const LOCKFILES = new Set(['package-lock.json', 'npm-shrinkwrap.json', 'pnpm-lock.yaml', 'composer.lock']);

/// Directories never worth walking into or linking out of. Build output and
/// dependencies dwarf the source and hold no hand-written config; editor and
/// agent folders are per-person, not per-service.
const SKIP = new Set([
  '.git',
  'node_modules',
  'build',
  'dist',
  'out',
  'target',
  '.gradle',
  '.idea',
  '.vscode',
  '.settings',
  '.metadata',
  '.claude',
  'bin',
  'coverage',
  'tmp',
  'temp',
  'logs',
  '.next',
  '.nuxt',
  '.cache',
  '.turbo',
  '__pycache__',
  '.venv',
  'venv',
]);

/// How far into a wholly ignored folder (`config/` ignored as a whole) the
/// scan looks, and how many files it takes from one before giving up on it.
const IGNORED_DIR_DEPTH = 3;
const IGNORED_DIR_FILES = 200;

export interface MirrorFs {
  existsSync(p: string): boolean;
  readdirSync(p: string, opts: { withFileTypes: true }): { name: string; isDirectory(): boolean }[];
  lstatSync(p: string): { isSymbolicLink(): boolean };
  mkdirSync(p: string, opts: { recursive: true }): void;
  symlinkSync(target: string, linkPath: string, type: 'file'): void;
}

const realFs = fs as unknown as MirrorFs;

export interface MirrorPatterns {
  /// Globs always mirrored when ignored, whatever their extension —
  /// `run-*-local.sh`. A pattern with no `/` matches the file name anywhere.
  include?: readonly string[];
  /// Globs never mirrored, even when they look like config.
  exclude?: readonly string[];
}

/// Whether an ignored file, relative to the checkout, is local config worth
/// linking into a worktree.
export function isLocalConfig(relative: string, patterns: MirrorPatterns = {}): boolean {
  const parts = relative.split(/[\\/]/).filter(Boolean);
  const name = parts[parts.length - 1];
  if (!name) return false;
  if (parts.slice(0, -1).some((dir) => SKIP.has(dir))) return false;
  if (patterns.exclude?.some((glob) => globMatches(glob, relative))) return false;
  if (patterns.include?.some((glob) => globMatches(glob, relative))) return true;
  // Lockfiles are JSON and YAML, and ignored in some repos, but they are what
  // an install wrote — linking one would share a dependency tree, not config.
  if (LOCKFILES.has(name) || /[.-]lock$/.test(name)) return false;
  if (name === '.env' || name.startsWith('.env.')) return true;
  return CONFIG_EXTENSIONS.has(path.extname(name).toLowerCase());
}

/// Every local config file under a checkout, as paths relative to it.
///
/// Git lists what is ignored — collapsed to one entry per wholly ignored
/// folder, so a monorepo's build output costs a line, not a walk. When git
/// cannot answer (not a repo, no git), the fixed names are looked for instead,
/// depth-limited because the answer is always a few levels down.
export function findLocalConfig(
  root: string,
  opts: MirrorPatterns & {
    fs?: MirrorFs;
    /// What git says is ignored; `null` for "git could not say". Read from
    /// git when left out.
    ignored?: readonly string[] | null;
    maxDepth?: number;
  } = {},
): string[] {
  const io = opts.fs ?? realFs;
  const listed = opts.ignored !== undefined ? opts.ignored : listIgnored(root);
  if (listed === null) return findByName(root, io, opts.maxDepth ?? 6);

  const found = new Set<string>();
  for (const entry of listed) {
    if (!entry.endsWith('/')) {
      if (isLocalConfig(entry, opts)) found.add(entry);
      continue;
    }
    // A whole folder ignored. Looked into only when it is not one of the
    // folders that never hold config, and only so far.
    const dir = entry.replace(/\/+$/, '');
    if (dir.split('/').some((part) => SKIP.has(part))) continue;
    for (const file of filesUnder(root, dir, io)) {
      if (isLocalConfig(file, opts)) found.add(file);
    }
  }
  return [...found].sort();
}

/// Ignored, untracked paths as git reports them; directories end in `/`.
function listIgnored(root: string): string[] | null {
  try {
    const out = execFileSync(
      'git',
      ['ls-files', '--others', '--ignored', '--exclude-standard', '--directory', '-z'],
      { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 32 * 1024 * 1024 },
    );
    return out.split('\0').filter(Boolean);
  } catch {
    return null;
  }
}

function filesUnder(root: string, dir: string, io: MirrorFs): string[] {
  const out: string[] = [];
  const walk = (relative: string, depth: number): void => {
    if (out.length >= IGNORED_DIR_FILES) return;
    let entries: { name: string; isDirectory(): boolean }[];
    try {
      entries = io.readdirSync(path.join(root, relative), { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const next = path.join(relative, entry.name);
      if (entry.isDirectory()) {
        if (depth < IGNORED_DIR_DEPTH && !SKIP.has(entry.name)) walk(next, depth + 1);
      } else if (out.length < IGNORED_DIR_FILES) {
        out.push(next);
      }
    }
  };
  walk(dir, 1);
  return out;
}

function findByName(root: string, io: MirrorFs, maxDepth: number): string[] {
  const names = new Set(LOCAL_CONFIG_NAMES);
  const found: string[] = [];

  function walk(relative: string, depth: number): void {
    let entries: { name: string; isDirectory(): boolean }[];
    try {
      entries = io.readdirSync(relative ? path.join(root, relative) : root, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const next = relative ? path.join(relative, entry.name) : entry.name;
      if (entry.isDirectory()) {
        if (depth >= maxDepth || SKIP.has(entry.name)) continue;
        walk(next, depth + 1);
        continue;
      }
      if (names.has(entry.name)) found.push(next);
    }
  }

  walk('', 0);
  return found.sort();
}

/// `*` within a segment, `**` across them, `?` one character. A glob with no
/// `/` is matched against the file name alone.
function globMatches(glob: string, relative: string): boolean {
  const target = glob.includes('/') ? relative : path.basename(relative);
  let source = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*' && glob[i + 1] === '*') {
      source += '.*';
      i++;
      if (glob[i + 1] === '/') i++;
    } else if (c === '*') {
      source += '[^/]*';
    } else if (c === '?') {
      source += '[^/]';
    } else {
      source += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
  }
  return new RegExp(`^${source}$`).test(target);
}

export interface MirrorLink {
  /// Absolute path in the main checkout.
  from: string;
  /// Absolute path in the worktree.
  to: string;
  relative: string;
}

/// What mirroring would do. Pure, so the pane can say "4 files" before
/// anything is written and this can be tested without a filesystem.
export function planMirror(
  primary: string,
  target: string,
  relatives: readonly string[],
  opts: { fs?: MirrorFs } = {},
): MirrorLink[] {
  const io = opts.fs ?? realFs;
  // Mirroring a checkout into itself is the ordinary case for a service on the
  // main branch, and it must do nothing at all.
  if (path.resolve(primary) === path.resolve(target)) return [];

  const out: MirrorLink[] = [];
  for (const relative of relatives) {
    const to = path.join(target, relative);
    // Anything already there — a real file the user wrote, or a link from a
    // previous run — is left alone. This never overwrites.
    if (lexists(io, to)) continue;
    out.push({ from: path.join(primary, relative), to, relative });
  }
  return out;
}

/// Carry out the plan. Returns what was linked, for the log.
export function applyMirror(links: readonly MirrorLink[], opts: { fs?: MirrorFs } = {}): string[] {
  const io = opts.fs ?? realFs;
  const done: string[] = [];
  for (const link of links) {
    try {
      io.mkdirSync(path.dirname(link.to), { recursive: true });
      io.symlinkSync(link.from, link.to, 'file');
      done.push(link.relative);
    } catch {
      // A race with the build, a read-only tree. One file failing is not worth
      // refusing to start over.
    }
  }
  return done;
}

/// `existsSync` follows symlinks, so a link left pointing at something that
/// has gone reads as absent and would be created again over itself.
function lexists(io: MirrorFs, p: string): boolean {
  try {
    io.lstatSync(p);
    return true;
  } catch {
    return false;
  }
}
