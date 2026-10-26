// npx tools, installed before anyone needs them. A tool run as `npx -y pkg`
// downloads itself the first time it starts, inside a check or a worker's
// run, with that run's short start-up budget. Cut off part-way, npm leaves a
// package half-written in its cache (a folder with no package.json), and
// every start after that fails with "Cannot find module" until someone
// deletes it by hand. So: install each one here first, with time to spare,
// and if an install is broken, remove it and install it again.

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/// The package an `npx` command runs, as written (`zd-mcp-server@0.6.1`).
/// Null for anything else, or an npx line this doesn't read plainly.
export function npxSpec(command: string, args: string[] = []): string | null {
  if (path.basename(command) !== 'npx') return null;
  if (args.some((a) => a === '-p' || a.startsWith('--package') || a === '-c' || a === '--call')) return null;
  const first = args.find((a) => a !== '-y' && a !== '--yes' && a !== '-q' && a !== '--quiet');
  return first && !first.startsWith('-') ? first : null;
}

/// Where npx keeps a package: npm names the folder from the spec's hash.
export function npxDirFor(spec: string, cacheRoot = npmCache()): string {
  return path.join(cacheRoot, '_npx', createHash('sha512').update(spec).digest('hex').slice(0, 16));
}

function npmCache(): string {
  return process.env.npm_config_cache || path.join(os.homedir(), '.npm');
}

/// Installed and whole: npm's record of what it installed is there, and
/// every package it lists has its package.json. A cut-off install fails one.
export function installWhole(dir: string): boolean {
  const lock = path.join(dir, 'node_modules', '.package-lock.json');
  let listed: Record<string, unknown>;
  try {
    listed = (JSON.parse(fs.readFileSync(lock, 'utf8')) as { packages?: Record<string, unknown> }).packages ?? {};
  } catch {
    return false;
  }
  return Object.keys(listed).every((p) => !p || fs.existsSync(path.join(dir, p, 'package.json')));
}

const INSTALL_MS = 10 * 60_000;

function install(spec: string): Promise<boolean> {
  return new Promise((resolve) => {
    // `-p` installs the package and runs something else: here, nothing.
    const child = spawn('npx', ['-y', '-p', spec, 'node', '-e', '0'], { stdio: 'ignore', env: process.env });
    const timer = setTimeout(() => child.kill('SIGKILL'), INSTALL_MS);
    child.on('error', () => { clearTimeout(timer); resolve(false); });
    child.on('exit', (code) => { clearTimeout(timer); resolve(code === 0); });
  });
}

let running: Promise<void> | null = null;

/// Every npx tool installed and whole, one at a time. Cheap when they are:
/// only a look at the cache. Calls while one is going wait on that one.
export function warmNpxTools(
  tools: Record<string, { command?: string; args?: string[] }>,
  log: (level: 'info' | 'warn', msg: string) => void,
): Promise<void> {
  if (running) return running;
  running = (async () => {
    for (const [name, t] of Object.entries(tools)) {
      const spec = t.command ? npxSpec(t.command, t.args) : null;
      if (!spec) continue;
      const dir = npxDirFor(spec);
      if (fs.existsSync(dir) && installWhole(dir)) continue;
      if (fs.existsSync(dir)) {
        log('warn', `${name}: its install (${spec}) was broken; installing it again.`);
        fs.rmSync(dir, { recursive: true, force: true });
      }
      const ok = await install(spec);
      if (ok && installWhole(dir)) log('info', `${name}: installed ${spec}.`);
      else {
        log('warn', `${name}: couldn't install ${spec}; it will be tried again.`);
        if (fs.existsSync(dir) && !installWhole(dir)) fs.rmSync(dir, { recursive: true, force: true });
      }
    }
  })().finally(() => {
    running = null;
  });
  return running;
}
