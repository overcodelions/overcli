// The seam between the engines and whatever is hosting them.
//
// Everything that actually does the work — runner.ts, flows/runtime.ts,
// flows/workerEngine.ts, scheduler.ts, orchestrator.ts, the parsers, the
// backends — is already headless-shaped: none of it imports electron. What
// tied it to the desktop app was a long tail of small things that did:
// twenty-three `app.getPath('userData')` calls used to compute a directory,
// `safeStorage` for the registry token, and `Notification` for "your shift
// finished". This module is those three surfaces, named and injected, so the
// same engines can run under Electron, under `overcli run` in CI, or under a
// test with a temp directory.
//
// `host()` THROWS when nothing has been installed. That is deliberate and is
// the whole safety property: a code path that reaches for the data directory
// before anyone has said where it is has a bug, and the alternative — quietly
// defaulting to `~/.overcli` — would mean a missed wiring writes a user's real
// worker journal during a test run. Electron installs its host at boot
// (`hostElectron.ts`), the CLI installs one from `--state-dir`/`$OVERCLI_HOME`,
// and tests install one pointed at a temp dir.
//
// Deliberately NOT on this interface, though the design note listed them:
//
//   - `emit`. Every engine already takes its emit callback as a constructor
//     argument (`new RunnerManager(emit, …)`), and the tee that feeds
//     `flowRuntime.observeEvent` has to be built where those objects are.
//     A second, unused emit channel here would be a trap.
//   - `permissionPolicy`. Only the CLI's event tap reads it, and the CLI
//     parses the flag and builds the tap in the same forty lines. It never
//     needs to travel.
//
// Both would be dead members that look load-bearing. If a second caller ever
// appears they belong here; today they do not.

/// What a host has to be able to do for the engines.
export interface HostEnv {
  /// Root of everything Overcli persists: `flows/`, `workers/`, `flow-runs/`,
  /// `worker-journal.jsonl`, `overcli.json`, the coordinator symlink farms.
  /// Under Electron this is `app.getPath('userData')`; headless it is
  /// `$OVERCLI_HOME` or `~/.overcli`; in CI, a directory the pipeline caches.
  dataDir(): string;
  /// Registry bearer tokens. Encrypted at rest under Electron via
  /// `safeStorage`; read from the environment headless, where there is no
  /// keychain and a token in the data directory would be a token in the CI
  /// cache. `set` is a no-op for hosts whose secrets are read-only.
  secrets: HostSecrets;
  /// Tell the user something finished. A desktop notification under
  /// Electron, a log line headless — never a blocking dialog, because the
  /// callers are the scheduler and the worker engine and nobody is there.
  notify(args: { title: string; body: string }): void;
}

export interface HostSecrets {
  get(key: string): string | null;
  /// Returns false when this host cannot persist secrets, so a caller can
  /// tell "saved" from "we dropped it on the floor".
  set(key: string, value: string | null): boolean;
}

// Kept on `globalThis` rather than in a module-level `let`, because the host
// is process-wide state and a module-level binding is only process-wide if the
// module is loaded once. It is not: suites that exercise a store's own caching
// call `vi.resetModules()` and re-import it, which builds a SECOND copy of this
// module whose `current` would be null — so the re-imported store would either
// throw or, worse, fall through to a different directory than the one the test
// installed. A well-known symbol is the one slot both copies agree on.
const SLOT = Symbol.for('overcli.host');

interface HostSlot {
  [SLOT]?: HostEnv | null;
}

function slot(): HostSlot {
  return globalThis as unknown as HostSlot;
}

/// Install the host. Called once at boot by whichever entry point is running:
/// `index.ts` under Electron, `cli/index.ts` headless, the test helper in a
/// spec. Calling it twice is allowed — the last one wins — because tests
/// re-point the data directory between suites.
export function setHost(next: HostEnv): void {
  slot()[SLOT] = next;
}

/// Forget the installed host. Tests only; production installs one and leaves
/// it. Exported so a suite can prove a module fails loudly without a host
/// rather than silently picking one up from a previous suite.
export function clearHost(): void {
  slot()[SLOT] = null;
}

export function hasHost(): boolean {
  return Boolean(slot()[SLOT]);
}

export function host(): HostEnv {
  const current = slot()[SLOT];
  if (!current) {
    throw new Error(
      'No Overcli host installed. The entry point must call setHost() before touching stored state — ' +
        'see src/main/host.ts.',
    );
  }
  return current;
}

/// Whether this process is an Electron binary rather than plain node.
///
/// Reads `process.versions.electron`, which Electron sets on every process it
/// owns — including the ones it boots with ELECTRON_RUN_AS_NODE — so this needs
/// no electron import and is safe on the CLI's path. Distinct from `hasHost()`:
/// that asks who wired us up, this asks what binary we are. `runner.ts` needs
/// the latter to decide whether spawning `process.execPath` will produce a
/// second GUI window.
export function runningUnderElectron(): boolean {
  return Boolean(process.versions.electron);
}
