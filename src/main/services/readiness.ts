// "Started" and "ready" are different facts, and only one of them is useful.
//
// A Spring service accepts a TCP connection seconds before it can answer, and
// `ng serve` prints nothing meaningful until it has compiled once. Ordering a
// stack on "the process exists" is how a dependent comes up against a
// half-open app and fails in a way that looks like its own bug. So every
// service carries a probe, and dependents wait on the probe rather than on
// the spawn.
//
// Every side effect arrives through `ProbeDeps`, so the polling logic is
// tested with a fake clock and no sockets.

import type { ReadinessProbe } from './types';

export interface ProbeDeps {
  /// Resolves the HTTP status, or rejects if nothing answered.
  httpStatus(url: string): Promise<number>;
  /// Resolves true when something accepts a connection on the port.
  tcpOpen(port: number, host: string): Promise<boolean>;
  /// Resolves the exit code of a command.
  exitCode(command: readonly string[]): Promise<number>;
  /// Whether the service's output has matched its log pattern yet. Owned by
  /// the supervisor, which is the thing reading the stream.
  logMatched(pattern: string): boolean;
  now(): number;
  sleep(ms: number): Promise<void>;
}

/// One probe attempt. Never throws: a probe that cannot connect is a probe
/// that says "not yet", which is the whole point of polling.
export async function probeOnce(probe: ReadinessProbe, deps: ProbeDeps): Promise<boolean> {
  try {
    switch (probe.kind) {
      case 'none':
        return true;
      case 'http': {
        const ok = probe.okStatuses ?? [200, 201, 204];
        const status = await deps.httpStatus(`http://127.0.0.1:${probe.port}${probe.path}`);
        return ok.includes(status);
      }
      case 'tcp':
        return await deps.tcpOpen(probe.port, '127.0.0.1');
      case 'command':
        return (await deps.exitCode(probe.command)) === 0;
      case 'log':
        return deps.logMatched(probe.pattern);
    }
  } catch {
    return false;
  }
}

export interface ReadyResult {
  ready: boolean;
  /// How long we waited, so the pane can say "passed 14s after start".
  waitedMs: number;
  /// Set when the process died while we were waiting — a different failure
  /// from "still not answering", and one the user should be told about
  /// plainly rather than after a full timeout.
  exited?: boolean;
}

export interface WaitOptions {
  timeoutMs?: number;
  intervalMs?: number;
  /// Lets the wait give up the moment the process dies instead of polling a
  /// corpse for thirty seconds.
  isAlive?: () => boolean;
}

/// Poll until the probe passes, the process dies, or the budget runs out.
export async function waitUntilReady(
  probe: ReadinessProbe,
  deps: ProbeDeps,
  opts: WaitOptions = {},
): Promise<ReadyResult> {
  const timeoutMs = opts.timeoutMs ?? 60_000;
  const intervalMs = opts.intervalMs ?? 500;
  const started = deps.now();

  // A probe of `none` is not a wait at all — the service declares itself
  // ready on spawn, and pretending otherwise would add a delay that means
  // nothing.
  if (probe.kind === 'none') return { ready: true, waitedMs: 0 };

  for (;;) {
    if (opts.isAlive && !opts.isAlive()) {
      return { ready: false, waitedMs: deps.now() - started, exited: true };
    }
    if (await probeOnce(probe, deps)) {
      return { ready: true, waitedMs: deps.now() - started };
    }
    if (deps.now() - started >= timeoutMs) {
      return { ready: false, waitedMs: deps.now() - started };
    }
    await deps.sleep(intervalMs);
  }
}

/// Human wording for a probe, for the service detail pane. Kept here so the
/// renderer never has to switch on the probe shape itself.
export function describeProbe(probe: ReadinessProbe): string {
  switch (probe.kind) {
    case 'http':
      return `GET :${probe.port}${probe.path}`;
    case 'tcp':
      return `:${probe.port} accepts a connection`;
    case 'command':
      return probe.command.join(' ');
    case 'log':
      return `output matches /${probe.pattern}/`;
    case 'none':
      return 'ready as soon as it starts';
  }
}
