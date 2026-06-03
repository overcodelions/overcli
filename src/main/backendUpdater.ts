// Headless, hidden self-update primer.
//
// Several agent CLIs (claude, codex) update themselves the moment you invoke
// them. We lean on that: on app startup we spawn each one once — detached and
// with all output suppressed — so the CLI's own background updater runs and
// the user never sees a terminal window. This is the genuinely-invisible
// counterpart to the visible `openTerminalAt` launcher in terminal.ts.
//
// Two safety rules drive the design:
//   1. Each trigger command must run to completion and EXIT on its own. We use
//      bounded commands (an explicit `update` subcommand, or `--version`) — not
//      the interactive REPL, which would hang forever with no TTY attached.
//   2. As a backstop against a hung invocation, every spawn gets a timeout that
//      kills the whole process group, so nothing is left running afterward.

import { spawn } from 'node:child_process';
import { Backend } from '../shared/types';
import { backendNeedsShell, buildBackendEnv, resolveBackendPath } from './backendPaths';
import { Store } from './store';
import { log } from './diagnostics';

// Per-backend command that nudges the CLI's own updater and then exits.
// Only backends that self-update on invocation belong here; gemini/ollama/
// copilot are omitted because they don't update this way.
//
// NOTE: `claude update` is an explicit, documented self-update subcommand —
// reliable and bounded. `codex --version` is a best guess at a bounded command
// that still trips codex's startup update check; verify it actually updates and
// swap in codex's real update entrypoint if not.
const UPDATE_TRIGGER: Partial<Record<Backend, string[]>> = {
  claude: ['update'],
  codex: ['--version'],
};

const PRIME_INTERVAL_MS = 24 * 60 * 60 * 1000; // throttle: at most once/day
const PRIME_TIMEOUT_MS = 90_000; // backstop: kill anything still running after 90s

/// Kill the process tree rooted at `pid`. The child is spawned detached, so on
/// POSIX it leads its own process group and a negative pid signals the whole
/// group (taking down anything it forked). Windows has no process groups here,
/// so fall back to taskkill /t.
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

/// Fire each due backend's self-updater once, hidden, fire-and-forget.
/// Throttled per-backend to PRIME_INTERVAL_MS via the Store. Safe to call at
/// app startup (before any session exists); never blocks.
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
}
