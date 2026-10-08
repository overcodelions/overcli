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

/// What one attempt saw. `status` is kept even when it failed the probe: a
/// 401 is the app saying it is up and this path is not for us, which is a
/// different conversation from a refused connection.
export interface ProbeAttempt {
  ok: boolean;
  /// The HTTP status, for an http probe that got an answer.
  status?: number;
  /// Why nothing answered, when nothing did.
  error?: string;
}

/// One probe attempt, with what it saw. Never throws: a probe that cannot
/// connect is a probe that says "not yet", which is the whole point of polling.
export async function probeAttempt(probe: ReadinessProbe, deps: ProbeDeps): Promise<ProbeAttempt> {
  try {
    switch (probe.kind) {
      case 'none':
        return { ok: true };
      case 'http': {
        const ok = probe.okStatuses ?? [200, 201, 204];
        const status = await deps.httpStatus(`http://127.0.0.1:${probe.port}${probe.path}`);
        return { ok: ok.includes(status), status };
      }
      case 'tcp':
        return { ok: await deps.tcpOpen(probe.port, '127.0.0.1') };
      case 'command':
        return { ok: (await deps.exitCode(probe.command)) === 0 };
      case 'log':
        return { ok: deps.logMatched(probe.pattern) };
    }
  } catch (err) {
    return { ok: false, error: (err as Error)?.message };
  }
}

/// One probe attempt, reduced to yes or no.
export async function probeOnce(probe: ReadinessProbe, deps: ProbeDeps): Promise<boolean> {
  return (await probeAttempt(probe, deps)).ok;
}

export interface ReadyResult {
  ready: boolean;
  /// How long we waited, so the pane can say "passed 14s after start".
  waitedMs: number;
  /// Set when the process died while we were waiting — a different failure
  /// from "still not answering", and one the user should be told about
  /// plainly rather than after a full timeout.
  exited?: boolean;
  /// The HTTP status of the last attempt, when it got one. What turns "slow to
  /// start" into "up, but this path answers 401".
  lastStatus?: number;
}

export interface WaitOptions {
  timeoutMs?: number;
  /// A fixed gap between attempts. Unset means `backoffDelay`: quick at first,
  /// when a fast service is about to answer, and rarely once it clearly isn't.
  intervalMs?: number;
  /// Lets the wait give up the moment the process dies instead of polling a
  /// corpse for thirty seconds.
  isAlive?: () => boolean;
}

/// The gaps between attempts when none was asked for. Every attempt is a
/// request the app serves and usually logs — a secured app logs a full stack
/// trace for each 401 — so a probe that fails twice a second for three
/// minutes buries the log it exists to help with. Most services answer within
/// the first few steps; one that has not by then gains little from being
/// asked more often than every ten seconds.
export const BACKOFF_MS = [1_000, 2_000, 5_000, 10_000] as const;

/// The gap after the `attempt`th failure (zero-based), capped at the last step.
export function backoffDelay(attempt: number): number {
  return BACKOFF_MS[Math.min(Math.max(0, attempt), BACKOFF_MS.length - 1)];
}

/// Poll until the probe passes, the process dies, or the budget runs out.
export async function waitUntilReady(
  probe: ReadinessProbe,
  deps: ProbeDeps,
  opts: WaitOptions = {},
): Promise<ReadyResult> {
  const timeoutMs = opts.timeoutMs ?? 60_000;
  const started = deps.now();

  // A probe of `none` is not a wait at all — the service declares itself
  // ready on spawn, and pretending otherwise would add a delay that means
  // nothing.
  if (probe.kind === 'none') return { ready: true, waitedMs: 0 };

  let lastStatus: number | undefined;
  for (let attempt = 0; ; attempt++) {
    if (opts.isAlive && !opts.isAlive()) {
      return { ready: false, waitedMs: deps.now() - started, exited: true, lastStatus };
    }
    const seen = await probeAttempt(probe, deps);
    if (seen.ok) {
      return { ready: true, waitedMs: deps.now() - started };
    }
    // A refused connection after a 401 does not erase the 401: it is still
    // the most useful thing this wait learned.
    if (seen.status !== undefined) lastStatus = seen.status;
    const waited = deps.now() - started;
    if (waited >= timeoutMs) {
      return { ready: false, waitedMs: waited, lastStatus };
    }
    // Never sleep past the budget: a 60s allowance should be judged at 60s,
    // not at whatever the next backoff step happens to land on.
    const gap = opts.intervalMs ?? backoffDelay(attempt);
    await deps.sleep(Math.min(gap, Math.max(1, timeoutMs - waited)));
  }
}

/// Statuses that mean the app is up and refusing this request — a probe
/// getting one of these will not start passing by being asked again.
export function isRefusalStatus(status: number | undefined): boolean {
  return status === 401 || status === 403;
}

/// One sentence on why a probe is not passing, for the pane and the log.
/// Undefined when there is nothing more to say than "not answering yet".
export function describeProbeFailure(probe: ReadinessProbe, lastStatus: number | undefined): string | undefined {
  if (probe.kind !== 'http' || lastStatus === undefined) return undefined;
  const where = `${lastStatus} on ${probe.path}`;
  if (isRefusalStatus(lastStatus)) {
    return `probe failing: ${where} — the app is up but this path needs auth; pick another probe`;
  }
  if (lastStatus === 404) {
    return `probe failing: ${where} — the app is up but nothing is served there; pick another probe`;
  }
  if (lastStatus === 503) {
    return `probe failing: ${where} — the app reports itself unhealthy (often a database or other dependency)`;
  }
  return `probe failing: ${where}`;
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
