// `overcli serve` — the daemon.
//
// Everything else in this directory is one-shot: parse a file, run it, exit.
// This is the opposite shape, and the difference is the whole point. The
// scheduler and the standing workers you built in the app have only ever
// existed inside `registerIpc` (src/main/index.ts), so closing the Electron
// window stopped them. Here they run on a box you own, with no window.
//
// There is still no second runtime. `buildDaemonEngines` constructs the same
// engines the app constructs, in the same order; this file only starts them,
// keeps the process alive, and takes them down cleanly on a signal.

import fs from 'node:fs';
import path from 'node:path';

import { host } from '../main/host';
import { buildDaemonEngines, type DaemonEngines } from './engines';
import type { ServeOptions } from './args';
import { EXIT } from './run';

/// Node's timer ceiling is 2^31-1 ms; stay comfortably under it.
const KEEP_ALIVE_MS = 1 << 30;

export const LOCK_FILE = 'serve.lock';

export interface ServeHandle {
  engines: DaemonEngines;
  /// Resolves once a signal has been handled and both engines are disposed.
  /// `main` returns this, which is what keeps the process alive: nothing else
  /// is holding the event loop open on purpose.
  done: Promise<number>;
  /// The signal handler. Exposed so a test can fire it directly instead of
  /// signalling the test runner's own process, which would kill vitest.
  shutdown: (signal: string) => void;
}

export interface ServeDeps {
  /// Where the startup and shutdown lines go. stdout in production.
  out: (line: string) => void;
  /// Escalation for a second signal. Defaults to a real `process.exit`; a test
  /// passes its own so it can assert the escalation without dying.
  forceExit?: (code: number) => void;
}

/// Refuse to run two daemons against one state directory.
///
/// Nothing else in overcli guards this, and the failure is silent and bad:
/// both processes `loadAllSchedules()` from the same directory and both arm
/// timers, so every schedule fires TWICE — two worktrees, two branches, two
/// sets of API spend — while both append to the same worker journal and
/// treasury. A stale lock (the holder crashed) is not an error and is taken
/// over; `process.kill(pid, 0)` is the liveness probe, and it throws ESRCH for
/// a pid that is gone.
export function acquireLock(dataDir: string): { ok: true; release: () => void } | { ok: false; heldBy: number } {
  const file = path.join(dataDir, LOCK_FILE);
  try {
    const held = Number(fs.readFileSync(file, 'utf-8').trim());
    if (Number.isInteger(held) && held > 0 && held !== process.pid) {
      try {
        process.kill(held, 0);
        return { ok: false, heldBy: held };
      } catch {
        // ESRCH — the holder is gone, the lock is stale, take it.
      }
    }
  } catch {
    // No lock file, or an unreadable one. Either way it is ours to write.
  }
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(file, `${process.pid}\n`, 'utf-8');
  return {
    ok: true,
    release: () => {
      try {
        // Only drop it if it is still ours — never delete a lock another
        // process took over after we went stale.
        if (Number(fs.readFileSync(file, 'utf-8').trim()) === process.pid) fs.unlinkSync(file);
      } catch {
        // Nothing to release.
      }
    },
  };
}

/// Build, start, and hold. Returns without waiting, so the caller decides how
/// signals reach `shutdown`.
export function startDaemon(
  opts: ServeOptions,
  deps: ServeDeps,
): { ok: true; handle: ServeHandle } | { ok: false; exitCode: number; error: string } {
  const engines = buildDaemonEngines({
    stateDir: opts.stateDir,
    policy: opts.permissions,
    allowTools: opts.allowTools,
  });

  // Read AFTER the engines exist: `buildDaemonEngines` installs the host, and
  // `dataDir()` is what resolves --state-dir / $OVERCLI_HOME / ~/.overcli.
  const dataDir = host().dataDir();

  const lock = acquireLock(dataDir);
  if (!lock.ok) {
    engines.dispose();
    return {
      ok: false,
      exitCode: EXIT.RUN_FAILED,
      error:
        `Another overcli serve (pid ${lock.heldBy}) is already using ${dataDir}.\n` +
        'Two daemons on one state directory fire every schedule twice. Stop that one first.',
    };
  }

  engines.scheduler.start();
  engines.workerEngine.start();

  const schedules = engines.scheduler.list();
  const enabled = schedules.filter((s) => s.enabled).length;
  const workers = engines.workerEngine.workerIds().length;
  deps.out(
    `overcli serve — ${schedules.length} schedule(s) (${enabled} enabled), ` +
      `${workers} worker(s) from ${dataDir}`,
  );
  deps.out(`permissions: ${opts.permissions}; pid ${process.pid}; Ctrl-C or SIGTERM to stop`);

  // Without this the process exits immediately on an empty state directory.
  // `SchedulerEngine.arm()` returns early with `// nothing enabled — no timer
  // at all` (scheduler.ts:289) when no schedule is due, and the worker engine
  // does the same, so with nothing to run neither engine holds the event loop
  // open and node would fall straight out of `main`. A daemon with no work yet
  // still has to be up — the user may add a schedule from the app.
  const keepAlive = setInterval(() => {}, KEEP_ALIVE_MS);

  let resolveDone: (code: number) => void;
  const done = new Promise<number>((resolve) => {
    resolveDone = resolve;
  });

  let shuttingDown = false;
  const shutdown = (signal: string): void => {
    if (shuttingDown) {
      // The first shutdown is still in flight and the user asked again. They
      // are entitled to an exit now, even if that strands a backend process.
      deps.out(`${signal} again — forcing exit.`);
      (deps.forceExit ?? ((code: number) => process.exit(code)))(EXIT.OK);
      return;
    }
    shuttingDown = true;
    deps.out(`${signal} — stopping schedules and workers.`);
    clearInterval(keepAlive);
    try {
      engines.dispose();
    } finally {
      lock.release();
    }
    resolveDone(EXIT.OK);
  };

  return { ok: true, handle: { engines, done, shutdown } };
}

/// The command as `main` calls it: start, wire real signals, wait forever.
export async function serveCommand(opts: ServeOptions, deps: ServeDeps): Promise<number> {
  const started = startDaemon(opts, deps);
  if (!started.ok) {
    process.stderr.write(`${started.error}\n`);
    return started.exitCode;
  }
  // systemd sends SIGTERM on `systemctl stop`; Ctrl-C sends SIGINT. Both mean
  // the same thing here. Exit 0 rather than the 128+n convention because a
  // clean, intentional stop is a success, and systemd would otherwise need
  // SuccessExitStatus configured to agree.
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => started.handle.shutdown(signal));
  }
  return started.handle.done;
}
