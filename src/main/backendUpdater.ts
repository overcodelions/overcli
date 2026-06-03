// Background CLI updater. Keeps the agent CLIs on their latest version
// without the user having to think about it, on app startup.
//
// Two update styles, because the CLIs differ:
//
//   • Silent self-update (claude): invoking `claude update` runs a bounded,
//     non-interactive self-updater that exits on its own. We spawn it
//     detached with all output suppressed — the user never sees a window.
//     This is the genuinely-invisible counterpart to the visible
//     `openTerminalAt` launcher in terminal.ts.
//
//   • Hidden npm update with visible fallback (codex): codex's *own* updater
//     is an interactive "update now?" prompt that blocks on stdin (this is
//     what timed out the codex health probe and red-boxed preflight). We
//     can't answer that headless — so instead we update the npm package
//     directly with `npm i -g @openai/codex@latest`, which is fully
//     non-interactive. If that fails (global prefix needs sudo, or codex
//     wasn't npm-installed), we fall back to opening a Terminal running the
//     same command so the user can complete it. The duplicate-install
//     hazard is a non-issue here: runner's pickCodexBinary() already prefers
//     the freshest (app-server-capable) codex on PATH.
//
// Everything is throttled to roughly once/day via the Store and is
// fire-and-forget — it never blocks window creation.

import { spawn, spawnSync } from 'node:child_process';
import https from 'node:https';
import { Backend } from '../shared/types';
import { backendNeedsShell, buildBackendEnv, resolveBackendPath } from './backendPaths';
import { runInTerminal } from './terminal';
import { Store } from './store';
import { log } from './diagnostics';

// Per-backend command that nudges the CLI's own updater and then exits.
// Only backends whose updater runs NON-INTERACTIVELY and exits on its own
// belong here. Codex is handled separately (see updateCodexIfOutdated)
// because its self-updater prompts interactively.
const UPDATE_TRIGGER: Partial<Record<Backend, string[]>> = {
  claude: ['update'],
};

const CODEX_NPM_PKG = '@openai/codex';

const PRIME_INTERVAL_MS = 24 * 60 * 60 * 1000; // throttle: at most once/day
const PRIME_TIMEOUT_MS = 90_000; // backstop: kill a hung self-updater after 90s
const NPM_UPDATE_TIMEOUT_MS = 180_000; // npm global installs can be slow
const REGISTRY_TIMEOUT_MS = 4_000; // version lookup is best-effort

/// Kill the process tree rooted at `pid`. Callers pass detached children, so on
/// POSIX the child leads its own process group and a negative pid signals the
/// whole group (taking down anything it forked). Windows has no process groups
/// here, so fall back to taskkill /t.
function killTree(pid: number): void {
  try {
    if (process.platform === 'win32') {
      spawn('taskkill', ['/pid', String(pid), '/t', '/f'], { stdio: 'ignore' });
    } else {
      process.kill(-pid, 'SIGKILL');
    }
  } catch {
    // Already exited — nothing to kill.
  }
}

function primeBackend(backend: Backend, argv: string[]): boolean {
  const bin = resolveBackendPath(backend);
  if (!bin) return false; // not installed — nothing to update
  const env = buildBackendEnv(process.env, bin);
  const shell = backendNeedsShell(bin);

  let child;
  try {
    child = spawn(bin, argv, { detached: true, stdio: 'ignore', env, shell });
  } catch (err) {
    log('warn', 'backendUpdater', `Failed to spawn ${backend} self-update`, err);
    return false;
  }

  const pid = child.pid;
  const timer = setTimeout(() => {
    if (pid) killTree(pid);
  }, PRIME_TIMEOUT_MS);
  // Don't let the stray timer or child handle keep the event loop / app alive.
  timer.unref?.();
  child.on('exit', () => clearTimeout(timer));
  child.on('error', (err) => {
    clearTimeout(timer);
    log('warn', 'backendUpdater', `${backend} self-update errored`, err);
  });
  child.unref();
  return true;
}

/// Parse the first dotted version triple out of arbitrary CLI/registry text.
function parseSemver(text: string): [number, number, number] | null {
  const m = text.match(/(\d+)\.(\d+)\.(\d+)/);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

/// True iff `a` is strictly older than `b`. Unparseable inputs → false, so we
/// never trigger an update on garbage.
function isOlder(a: string, b: string): boolean {
  const pa = parseSemver(a);
  const pb = parseSemver(b);
  if (!pa || !pb) return false;
  for (let i = 0; i < 3; i++) {
    if (pa[i] !== pb[i]) return pa[i] < pb[i];
  }
  return false;
}

/// Run `<bin> --version` with stdin closed (so an interactive update prompt
/// can't hang it) and return the version string, or null on any failure.
function readInstalledVersion(bin: string, env: NodeJS.ProcessEnv): string | null {
  const res = spawnSync(bin, ['--version'], {
    encoding: 'utf-8',
    timeout: 4000,
    env,
    shell: backendNeedsShell(bin),
    input: '',
  });
  if (res.error || res.status !== 0) return null;
  const out = `${res.stdout ?? ''}${res.stderr ?? ''}`;
  return parseSemver(out) ? out.match(/\d+\.\d+\.\d+/)![0] : null;
}

/// Look up a package's latest published version from the npm registry.
/// Best-effort: resolves null on any network/parse error or non-200.
function fetchNpmLatest(pkg: string): Promise<string | null> {
  return new Promise((resolve) => {
    const req = https.get(
      `https://registry.npmjs.org/${pkg}/latest`,
      { timeout: REGISTRY_TIMEOUT_MS },
      (res) => {
        if (res.statusCode !== 200) {
          res.resume();
          resolve(null);
          return;
        }
        let data = '';
        res.setEncoding('utf-8');
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => {
          try {
            resolve(JSON.parse(data).version ?? null);
          } catch {
            resolve(null);
          }
        });
      },
    );
    req.on('error', () => resolve(null));
    req.on('timeout', () => {
      req.destroy();
      resolve(null);
    });
  });
}

/// Run `npm i -g <pkg>@latest` hidden. Resolves true only on a clean exit 0.
function npmUpdateHidden(pkg: string, env: NodeJS.ProcessEnv): Promise<boolean> {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn('npm', ['install', '-g', `${pkg}@latest`], {
        detached: true,
        stdio: 'ignore',
        env,
        shell: process.platform === 'win32', // npm is npm.cmd on Windows
      });
    } catch {
      resolve(false);
      return;
    }
    const pid = child.pid;
    const timer = setTimeout(() => {
      if (pid) killTree(pid);
      resolve(false);
    }, NPM_UPDATE_TIMEOUT_MS);
    timer.unref?.();
    child.on('exit', (code) => {
      clearTimeout(timer);
      resolve(code === 0);
    });
    child.on('error', () => {
      clearTimeout(timer);
      resolve(false);
    });
  });
}

/// Codex update path: detect outdated, try a hidden npm update, and only fall
/// back to a visible Terminal if that fails (e.g. the global prefix needs
/// sudo). Throttled via the 'codex' key. Best-effort and self-contained.
async function updateCodexIfOutdated(now: number): Promise<void> {
  const checks = { ...(Store.load().backendUpdateChecks ?? {}) };
  if (now - (checks['codex'] ?? 0) < PRIME_INTERVAL_MS) return;

  const bin = resolveBackendPath('codex');
  if (!bin) return; // not installed
  const env = buildBackendEnv(process.env, bin);

  const installed = readInstalledVersion(bin, env);
  if (!installed) return; // couldn't read version — leave it alone

  const latest = await fetchNpmLatest(CODEX_NPM_PKG);
  if (!latest) return; // offline / registry down — retry next launch (no throttle write)

  // We have a definitive answer now; record the check so we don't re-probe
  // the registry on every launch today.
  checks['codex'] = now;
  Store.setBackendUpdateChecks(checks);

  if (!isOlder(installed, latest)) {
    log('info', 'backendUpdater', `codex ${installed} is current (latest ${latest})`);
    return;
  }

  log('info', 'backendUpdater', `codex ${installed} < ${latest}; updating via npm (hidden)`);
  if (await npmUpdateHidden(CODEX_NPM_PKG, env)) {
    log('info', 'backendUpdater', `codex updated to ${latest} silently`);
    return;
  }

  // Hidden update failed — almost always a global prefix that needs sudo, or
  // a non-npm install. Open a Terminal so the user can finish it themselves.
  log('warn', 'backendUpdater', 'hidden codex update failed; opening terminal for manual update');
  runInTerminal(`npm install -g ${CODEX_NPM_PKG}@latest`);
}

/// Fire each due backend's updater once. Silent self-updaters run hidden;
/// codex follows the hidden-npm-then-visible-fallback path. Throttled
/// per-backend to PRIME_INTERVAL_MS via the Store. Safe to call at app startup
/// (before any session exists); never blocks.
export function primeBackendUpdates(): void {
  const now = Date.now();
  const checks = { ...(Store.load().backendUpdateChecks ?? {}) };
  let changed = false;

  for (const [backend, argv] of Object.entries(UPDATE_TRIGGER) as [Backend, string[]][]) {
    if (now - (checks[backend] ?? 0) < PRIME_INTERVAL_MS) continue;
    if (primeBackend(backend, argv)) {
      checks[backend] = now;
      changed = true;
    }
  }

  if (changed) Store.setBackendUpdateChecks(checks);

  // Codex runs its own async path (network version check) — fire and forget.
  void updateCodexIfOutdated(now).catch((err) =>
    log('warn', 'backendUpdater', 'codex update check failed', err),
  );
}
