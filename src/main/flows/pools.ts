// Server-wide limits on how much runs at once, across every worker.
//
// Each worker already has its own limits (answersAtOnce, a shift's items),
// but nothing stopped twenty workers each doing their most at the same time
// on one box. Two pools, because the two kinds of work cost the box very
// different things:
//
//   - answers: a worker answering a conversation. One agent process, mostly
//     waiting on the model, so memory bound (a few hundred MB each).
//   - code: a run in its own checkout. Builds, installs and tests, so CPU
//     bound, and a worktree on disk each.
//
// A null cap is no limit: the desktop app, where one person is watching.

import os from 'node:os';

/// A counting semaphore. `take` waits its turn, first come first served;
/// `tryTake` doesn't wait, for callers that come back on their own (the
/// orchestrator's pump).
export class Pool {
  private held = 0;
  private waiters: Array<() => void> = [];

  private readonly capOf: () => number | null;

  /// A number, or a function read each time a place is asked for, so a
  /// changed limit applies without a restart (raised: see `poke`).
  constructor(cap: number | null | (() => number | null)) {
    this.capOf = typeof cap === 'function' ? cap : () => cap;
  }

  get cap(): number | null {
    return this.capOf();
  }

  get inUse(): number {
    return this.held;
  }

  get waiting(): number {
    return this.waiters.length;
  }

  tryTake(): boolean {
    const cap = this.cap;
    if (cap !== null && this.held >= cap) return false;
    this.held++;
    return true;
  }

  /// Resolves with this slot's release, which is safe to call more than once.
  take(): Promise<() => void> {
    const release = this.releaser();
    // Behind anyone already waiting, even with a slot free, so nobody jumps the queue.
    if (this.waiters.length === 0 && this.tryTake()) return Promise.resolve(release);
    return new Promise((resolve) => {
      this.waiters.push(() => resolve(release));
    });
  }

  release(): void {
    this.held = Math.max(0, this.held - 1);
    this.poke();
  }

  /// Let in whoever the limit now has room for: after a release, or after
  /// the limit was raised.
  poke(): void {
    while (this.waiters.length > 0 && this.tryTake()) this.waiters.shift()!();
  }

  private releaser(): () => void {
    let done = false;
    return () => {
      if (done) return;
      done = true;
      this.release();
    };
  }
}

export const ANSWERS_AT_ONCE_ENV = 'OVERCLI_ANSWERS_AT_ONCE';
export const CODE_RUNS_AT_ONCE_ENV = 'OVERCLI_CODE_RUNS_AT_ONCE';

/// Where one limit comes from. `env`: absent when the variable isn't set,
/// null for `0` (no limit). It wins over the console's rule, the way a
/// secret in `.env` does; the rule wins over what the machine can take.
export interface PoolLimit {
  machine: number;
  env?: number | null;
}

export interface PoolLimits {
  answers: PoolLimit;
  code: PoolLimit;
}

/// What the server's machine can take, and what the environment says.
/// Answers: two per GiB after 2 GiB for the server itself, between 4 and 64.
/// Code runs: one per CPU.
export function poolLimits(
  env: Record<string, string | undefined>,
  machine: { cpus: number; memBytes: number } = { cpus: os.availableParallelism(), memBytes: os.totalmem() },
): PoolLimits {
  const gib = machine.memBytes / 1024 ** 3;
  const answers = fromEnv(env[ANSWERS_AT_ONCE_ENV]);
  const code = fromEnv(env[CODE_RUNS_AT_ONCE_ENV]);
  return {
    answers: { machine: Math.max(4, Math.min(64, Math.floor((gib - 2) * 2))), ...(answers !== undefined ? { env: answers } : {}) },
    code: { machine: Math.max(1, machine.cpus), ...(code !== undefined ? { env: code } : {}) },
  };
}

/// The limit now: the environment's, else the rule's, else the machine's.
export function limitNow(limit: PoolLimit, rule: number | undefined): number | null {
  if (limit.env !== undefined) return limit.env;
  return rule ?? limit.machine;
}

/// undefined: not set (or not a number), so the default. null: `0`, no limit.
function fromEnv(raw: string | undefined): number | null | undefined {
  if (raw === undefined || raw.trim() === '') return undefined;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) return undefined;
  return n === 0 ? null : n;
}

/// This server's limits, for the console's Setup → Capacity. Null: not
/// an org server (nothing configured them).
let configured: PoolLimits | null = null;

export function configurePoolLimits(limits: PoolLimits | null): void {
  configured = limits;
}

export function poolLimitsHere(): PoolLimits | null {
  return configured;
}
