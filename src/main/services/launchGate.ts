// How many heavy starts run at once.
//
// A JVM service's start is a build JVM, often a second one forked to honour
// its settings, then the app — and "switch everything" asks for ten of them in
// the same second. On a ten-core machine that is thirty JVMs fighting for the
// same cores, and a service that boots in forty seconds on its own takes three
// minutes and reads "slow" the whole time. Queued, the first few are up in
// under a minute and the rest follow, which is sooner for all but the last.
//
// One gate for the whole app, not one per stack: the cores are shared.

export type ReleaseSlot = () => void;

export class LaunchGate {
  private running = 0;
  private readonly waiting: Array<() => void> = [];

  constructor(readonly limit: number) {}

  /// Resolves once a slot is free. The release it hands back is safe to call
  /// more than once, because every way a start can end — ready, slow, exited,
  /// failed to spawn — calls it, and some of those overlap.
  acquire(): Promise<ReleaseSlot> {
    return new Promise((resolve) => {
      const grant = () => {
        this.running++;
        let released = false;
        resolve(() => {
          if (released) return;
          released = true;
          this.running--;
          this.waiting.shift()?.();
        });
      };
      if (this.running < this.limit) grant();
      else this.waiting.push(grant);
    });
  }

  /// Whether a start asked for now would have to wait.
  get full(): boolean {
    return this.running >= this.limit;
  }
}

/// Enough to keep the machine busy without drowning it: a third of the cores,
/// never fewer than two.
export function defaultLaunchLimit(cores: number): number {
  return Math.max(2, Math.floor(cores / 3));
}
