import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { Backend } from '../shared/types';

function existsExecutable(p: string): boolean {
  // On Windows, every readable file has X_OK (there's no executable bit),
  // so X_OK would return true for spurious matches like `.txt` files. We
  // rely on the candidate list already targeting likely binary locations
  // and platform-appropriate file extensions (.exe/.cmd) — presence is
  // sufficient. On POSIX, X_OK filters out non-executable files.
  try {
    if (process.platform === 'win32') {
      const stat = fs.statSync(p);
      return stat.isFile();
    }
    fs.accessSync(p, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function unique(values: string[]): string[] {
  return Array.from(new Set(values.filter(Boolean)));
}

function commandNames(backend: Backend): string[] {
  if (process.platform !== 'win32') return [backend];
  return [`${backend}.cmd`, `${backend}.exe`, `${backend}.bat`, backend];
}

function nodeVersionBins(root: string, binFromVersionDir: (versionDir: string) => string): string[] {
  let versions: string[];
  try {
    versions = fs.readdirSync(root);
  } catch {
    return [];
  }
  // Sort newest-first by version number. A naive `.sort().reverse()` is
  // lexicographic — "v8.9.0" > "v22.16.0" because '8' > '2' character-wise —
  // which puts ancient nvm versions ahead of modern ones on PATH and breaks
  // shebangs like `#!/usr/bin/env node`.
  return versions
    .slice()
    .sort(compareNodeVersionsDesc)
    .map((version) => binFromVersionDir(path.join(root, version)));
}

function compareNodeVersionsDesc(a: string, b: string): number {
  const pa = parseVersionTuple(a);
  const pb = parseVersionTuple(b);
  for (let i = 0; i < 3; i++) {
    if (pa[i] !== pb[i]) return pb[i] - pa[i];
  }
  // Same numeric tuple: fall back to lexicographic so prereleases are stable.
  return b.localeCompare(a);
}

function parseVersionTuple(name: string): [number, number, number] {
  const match = name.match(/(\d+)(?:\.(\d+))?(?:\.(\d+))?/);
  if (!match) return [-1, -1, -1];
  return [Number(match[1] ?? 0), Number(match[2] ?? 0), Number(match[3] ?? 0)];
}

function commonBinDirs(backend: Backend): string[] {
  const home = os.homedir();
  if (process.platform === 'win32') {
    const appdata = process.env.APPDATA ?? path.join(home, 'AppData', 'Roaming');
    const localAppdata = process.env.LOCALAPPDATA ?? path.join(home, 'AppData', 'Local');
    const programFiles = process.env.ProgramFiles ?? 'C:\\Program Files';
    const programFilesX86 = process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)';
    return unique([
      // npm global (default: %APPDATA%\npm)
      path.join(appdata, 'npm'),
      path.join(localAppdata, 'npm'),
      // scoop shims
      path.join(home, 'scoop', 'shims'),
      // chocolatey
      'C:\\ProgramData\\chocolatey\\bin',
      // volta
      path.join(localAppdata, 'Volta', 'bin'),
      // pnpm global
      path.join(localAppdata, 'pnpm'),
      // yarn global
      path.join(home, 'AppData', 'Local', 'Yarn', 'bin'),
      // node in Program Files
      path.join(programFiles, 'nodejs'),
      path.join(programFilesX86, 'nodejs'),
      // bun
      path.join(home, '.bun', 'bin'),
      // backend-specific conventions
      ...(backend === 'claude' ? [path.join(home, '.claude', 'local')] : []),
      ...(backend === 'codex' ? [path.join(home, '.codex', 'bin')] : []),
    ]);
  }
  return unique([
    `${home}/.local/bin`,
    ...(backend === 'claude' ? [`${home}/.claude/local`] : []),
    ...(backend === 'codex' ? [`${home}/.codex/bin`] : []),
    `${home}/.npm-global/bin`,
    `${home}/.volta/bin`,
    `${home}/.asdf/shims`,
    `${home}/.bun/bin`,
    ...nodeVersionBins(`${home}/.nvm/versions/node`, (dir) => path.join(dir, 'bin')),
    ...nodeVersionBins(`${home}/.fnm/node-versions`, (dir) => path.join(dir, 'installation', 'bin')),
    ...nodeVersionBins(`${home}/.local/share/fnm/node-versions`, (dir) =>
      path.join(dir, 'installation', 'bin'),
    ),
    ...nodeVersionBins(`${home}/.asdf/installs/nodejs`, (dir) => path.join(dir, 'bin')),
    '/opt/homebrew/bin',
    '/usr/local/bin',
  ]);
}

function pathBinCandidates(backend: Backend, env: NodeJS.ProcessEnv = process.env): string[] {
  const dirs = (env.PATH ?? '')
    .split(path.delimiter)
    .map((dir) => dir.trim().replace(/^"(.*)"$/, '$1'))
    .filter(Boolean);
  return dirs.flatMap((dir) => commandNames(backend).map((name) => path.join(dir, name)));
}

function commonBinCandidates(backend: Backend): string[] {
  return commonBinDirs(backend).flatMap((dir) => commandNames(backend).map((name) => path.join(dir, name)));
}

function whereCandidates(backend: Backend, env: NodeJS.ProcessEnv = process.env): string[] {
  if (process.platform !== 'win32') return [];
  const out: string[] = [];
  for (const name of commandNames(backend)) {
    const res = spawnSync('where', [name], { encoding: 'utf-8', timeout: 2000, env });
    if (res.status !== 0 || !res.stdout) continue;
    for (const line of res.stdout.split(/\r?\n/)) {
      const candidate = line.trim();
      if (candidate) out.push(candidate);
    }
  }
  return out;
}

export function resolveBackendPath(
  backend: Backend,
  override?: string,
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  if (override && existsExecutable(override)) return override;

  for (const candidate of unique([
    ...pathBinCandidates(backend, env),
    ...commonBinCandidates(backend),
    ...whereCandidates(backend, env),
  ])) {
    if (existsExecutable(candidate)) return candidate;
  }
  return null;
}

/// Returns every executable backend candidate visible to the resolver,
/// in priority order (PATH → common dirs → platform `where`). Used by
/// callers that need to pick a *specific* candidate from the list (e.g.
/// codex preferring an app-server-capable binary when several versions
/// are installed) rather than the first match `resolveBackendPath`
/// would return.
export function listBackendPathCandidates(
  backend: Backend,
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  return unique([
    ...pathBinCandidates(backend, env),
    ...commonBinCandidates(backend),
    ...whereCandidates(backend, env),
  ]).filter(existsExecutable);
}

export function buildBackendEnv(
  env: NodeJS.ProcessEnv = process.env,
  preferredBinary?: string | null,
): NodeJS.ProcessEnv {
  const preferredDir =
    preferredBinary && path.dirname(preferredBinary) !== '.' ? path.dirname(preferredBinary) : undefined;
  const extra = unique([
    ...(preferredDir ? [preferredDir] : []),
    ...commonBinDirs('claude'),
    ...commonBinDirs('codex'),
    ...commonBinDirs('gemini'),
  ]);
  const current = env.PATH ?? '';
  return {
    ...env,
    PATH: unique([...extra, ...current.split(path.delimiter)]).join(path.delimiter),
  };
}

export function backendNeedsShell(binary: string): boolean {
  if (process.platform !== 'win32') return false;
  const ext = path.extname(binary).toLowerCase();
  return ext === '.cmd' || ext === '.bat';
}
