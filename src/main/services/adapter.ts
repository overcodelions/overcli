// The real node implementation of everything the engine injects.
//
// Kept apart from `supervisor.ts` on purpose: this is the only file in the
// directory that touches child_process, sockets or the clock, so the
// orchestration above it stays testable with fakes and this stays small
// enough to read in one sitting.
//
// Two details here are load-bearing rather than incidental:
//
//   * Every spawned child registers an 'error' listener. Node throws spawn
//     failures (missing binary, bad PATH, deleted cwd) as uncaught exceptions
//     otherwise, and in a packaged build that takes the whole main process
//     down — every conversation, flow run and shift at once.
//   * Children are spawned into their own process group and killed by group.
//     `./mvnw spring-boot:run` forks a java process; killing only the wrapper
//     leaves the real service holding the port, which then looks exactly like
//     the port-clash bug we went to some trouble to make visible.

import { spawn } from 'node:child_process';
import http from 'node:http';
import net from 'node:net';

import type { ProbeDeps } from './readiness';
import type { SpawnRequest, SpawnedProcess } from './supervisor';

/// How long to give a service to shut down politely before SIGKILL. Long
/// enough for a JVM to run its shutdown hooks, short enough that restarting
/// still feels like a click.
const TERM_GRACE_MS = 5_000;

/// Spawn a service. `command` is argv — nothing is handed to a shell, so
/// there are no quoting rules to get wrong and nothing the user typed can be
/// interpreted.
export function spawnService(req: SpawnRequest, opts: { graceMs?: number } = {}): SpawnedProcess {
  const graceMs = opts.graceMs ?? TERM_GRACE_MS;
  const [bin, ...args] = req.command;
  const child = spawn(bin, args, {
    cwd: req.cwd,
    env: { ...process.env, ...req.env },
    // Its own process group, so a kill reaches the whole tree.
    detached: process.platform !== 'win32',
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const lineHandlers: ((line: string) => void)[] = [];
  const exitHandlers: ((code: number | null) => void)[] = [];
  const errorHandlers: ((err: Error) => void)[] = [];

  // Registered immediately, not when a caller gets around to it: the error can
  // arrive before the constructor returns to the supervisor.
  child.on('error', (err) => {
    for (const handler of errorHandlers) handler(err);
  });

  const emitLine = (line: string) => {
    for (const handler of lineHandlers) handler(line);
  };
  pipeLines(child.stdout, emitLine);
  pipeLines(child.stderr, emitLine);

  child.on('exit', (code) => {
    for (const handler of exitHandlers) handler(code);
  });

  // The leader exiting is NOT the tree being gone. `npm` answers SIGTERM at
  // once while the server under it is still closing, or ignoring the signal
  // outright; cancelling the SIGKILL on the leader's exit left that child
  // running, reparented to launchd, where the next start took it for a
  // leftover and adopted it a moment before it exited. So after a kill the
  // group still gets its SIGKILL — by group only, once the leader is gone: a
  // group id is not reused while any member lives, but the leader's pid alone
  // can already belong to someone else. Windows has no groups to outlive.
  let killTimer: NodeJS.Timeout | undefined;
  let leaderExited = false;
  child.on('exit', () => {
    leaderExited = true;
    if (killTimer && process.platform === 'win32') clearTimeout(killTimer);
  });

  return {
    pid: child.pid,
    kill(signal: NodeJS.Signals = 'SIGTERM') {
      killTree(child.pid, signal);
      // A service that ignores SIGTERM still has to let go of its port.
      if (killTimer) clearTimeout(killTimer);
      killTimer = setTimeout(() => {
        if (leaderExited) killGroup(child.pid, 'SIGKILL');
        else killTree(child.pid, 'SIGKILL');
      }, graceMs);
      killTimer.unref?.();
    },
    onLine(cb) {
      lineHandlers.push(cb);
    },
    onExit(cb) {
      exitHandlers.push(cb);
    },
    onError(cb) {
      errorHandlers.push(cb);
    },
  };
}

/// Signal the whole process group, falling back to the single pid where the
/// group kill is refused (Windows, or a child that already reaped).
function killTree(pid: number | undefined, signal: NodeJS.Signals): void {
  if (pid === undefined) return;
  try {
    if (process.platform === 'win32') {
      process.kill(pid, signal);
      return;
    }
    process.kill(-pid, signal);
  } catch {
    try {
      process.kill(pid, signal);
    } catch {
      // Already gone. Nothing to do, and nothing worth saying.
    }
  }
}

/// Signal the process group and nothing else. For after the leader has gone,
/// when falling back to its bare pid could reach an unrelated process.
function killGroup(pid: number | undefined, signal: NodeJS.Signals): void {
  if (pid === undefined || process.platform === 'win32') return;
  try {
    process.kill(-pid, signal);
  } catch {
    // Every member already gone.
  }
}

/// Split a stream into lines, keeping a partial tail until its newline
/// arrives. Without the buffer, a log line that straddles a chunk boundary
/// shows up as two broken halves — which, in a stack trace, is exactly the
/// line you were trying to read.
function pipeLines(stream: NodeJS.ReadableStream | null, emit: (line: string) => void): void {
  if (!stream) return;
  let tail = '';
  stream.setEncoding('utf8');
  stream.on('data', (chunk: string) => {
    const parts = (tail + chunk).split('\n');
    tail = parts.pop() ?? '';
    for (const part of parts) emit(part.replace(/\r$/, ''));
  });
  stream.on('end', () => {
    if (tail) emit(tail);
    tail = '';
  });
}

/// The real probes. Every one of them resolves rather than rejects on a
/// refused connection: "not answering yet" is the expected state for most of
/// a service's startup, not an error.
export const nodeProbes: Omit<ProbeDeps, 'logMatched'> = {
  httpStatus(url: string): Promise<number> {
    return new Promise((resolve, reject) => {
      const req = http.get(url, { timeout: 2_000 }, (res) => {
        // Drain, or the socket is held open and the next poll queues behind it.
        res.resume();
        resolve(res.statusCode ?? 0);
      });
      req.on('timeout', () => req.destroy(new Error('probe timed out')));
      req.on('error', reject);
    });
  },

  tcpOpen(port: number, host: string): Promise<boolean> {
    return new Promise((resolve) => {
      const socket = net.connect({ port, host });
      const done = (open: boolean) => {
        socket.destroy();
        resolve(open);
      };
      socket.setTimeout(2_000);
      socket.on('connect', () => done(true));
      socket.on('timeout', () => done(false));
      socket.on('error', () => done(false));
    });
  },

  exitCode(command: readonly string[]): Promise<number> {
    return new Promise((resolve) => {
      const [bin, ...args] = command;
      const child = spawn(bin, args, { stdio: 'ignore' });
      // Same rule as above: an unguarded spawn error is an uncaught exception.
      child.on('error', () => resolve(-1));
      child.on('exit', (code) => resolve(code ?? -1));
    });
  },

  now: () => Date.now(),
  sleep: (ms: number) => new Promise((resolve) => setTimeout(resolve, ms)),
};
