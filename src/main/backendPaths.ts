import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
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
  return [`${backend}.cmd`, `${backend}.exe`, backend];
}

function nodeVersionBins(root: string, binFromVersionDir: (versionDir: string) => string): string[] {
  let versions: string[];
  try {
    versions = fs.readdirSync(root);
  } catch {
    return [];
  }
  return versions
    .sort()
    .reverse()
    .map((version) => binFromVersionDir(path.join(root, version)));
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
    '/opt/homebrew/bin',
    '/usr/local/bin',
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
  ]);
}

function pathBinCandidates(backend: Backend, env: NodeJS.ProcessEnv = process.env): string[] {
  const dirs = (env.PATH ?? '').split(path.delimiter).filter(Boolean);
  return dirs.flatMap((dir) => commandNames(backend).map((name) => path.join(dir, name)));
}

function commonBinCandidates(backend: Backend): string[] {
  return commonBinDirs(backend).flatMap((dir) => commandNames(backend).map((name) => path.join(dir, name)));
}

export function resolveBackendPath(
  backend: Backend,
  override?: string,
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  if (override && existsExecutable(override)) return override;

  for (const candidate of unique([...pathBinCandidates(backend, env), ...commonBinCandidates(backend)])) {
    if (existsExecutable(candidate)) return candidate;
  }
  return null;
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
