// Running the services, and moving them between worktrees.
//
// The one operation that matters here is `rebind`: this service now means
// that checkout. Everything you do during a session is that — a flow finishes
// on a branch, you point the frontend at it, look, and point it back. So a
// rebind is a single call that stops the process, reprojects the config into
// the new checkout, restarts, and re-waits for readiness, leaving the
// identity, the log history and the dependency edges exactly where they were.
//
// Two restraints worth stating, because both are easy to get wrong and
// expensive to undo:
//
//   * Dependency edges order STARTUP. They do not propagate restarts. A
//     backend restarting does not take the frontend down; HTTP clients
//     reconnect, which is what they are for.
//   * A self-reloading runner is left alone on file changes. `ng serve` and
//     vite patch a running process better than an outside supervisor can.
//
// Processes and clocks arrive through `SupervisorDeps`, so all of this is
// tested without spawning anything.

import path from 'node:path';

import { buildCommand, missingMachineValues, resolveOptions } from './options';
import { debugLaunch } from './debug';
import { leaseFor, portForOffset, type LeaseDecision, type PortClaim } from './ports';
import type { PortOwner, ProcessMatch } from './portOwners';
import { applyProjection, planProjection, type ProjectionFs } from './projection';
import type { LogSink } from './logFile';
import { waitUntilReady, type ProbeDeps } from './readiness';
import type { LaunchGate, ReleaseSlot } from './launchGate';
import type { ServiceBinding, ServiceRuntime, ServiceSpec, TaskRun } from './types';
import { normalizeWatchPatterns, restartDependents, shouldRestartOnChange, startOrder } from './types';
import { describeDrift, driftedTasks } from '../../shared/taskDrift';
import { buildsOnJvm, defaultReadyTimeoutSec } from '../../shared/services';
import { missingMachineError, SECRET_MASK } from '../../shared/machineValues';
import {
  emptyExceptionLog,
  feedException,
  listExceptions,
  type CaughtException,
  type ExceptionLog,
} from '../../shared/exceptions';

/// A running child, reduced to what the supervisor actually needs.
export interface SpawnedProcess {
  pid?: number;
  kill(signal?: NodeJS.Signals): void;
  /// One callback per output line, stdout and stderr merged — the pane shows
  /// one stream, and interleaving is the truth of what happened.
  onLine(cb: (line: string) => void): void;
  onExit(cb: (code: number | null) => void): void;
  /// Spawn itself failing — a missing binary, a bad PATH, a cwd that went
  /// away between the projection and the launch. Node emits this on the child
  /// rather than throwing, and an adapter that ignores it takes the whole main
  /// process down with an uncaught exception.
  onError(cb: (err: Error) => void): void;
}

export interface SpawnRequest {
  command: readonly string[];
  cwd: string;
  env: Record<string, string>;
}

export interface ServiceFileWatcher {
  close(): void | Promise<void>;
}

export interface SupervisorDeps {
  spawn(req: SpawnRequest): SpawnedProcess;
  probe: Omit<ProbeDeps, 'logMatched'>;
  fs?: ProjectionFs;
  /// Workspace symlink roots. A process must never be launched under one —
  /// see `resolveLaunchCwd`.
  symlinkRoots?: readonly string[];
  /// Where each service's own config lives, substituted into projections as
  /// `${SERVICE_CONFIG_DIR}`.
  configDir(serviceId: string): string;
  /// Values shared by every service on this machine — a database user, an SQS
  /// prefix, a path — filled into any `${NAME}` in an option or an injected
  /// variable. Read at launch rather than held, so editing them takes effect
  /// on the next start without a restart of the app.
  machineValues?(): Record<string, string>;
  /// Secrets that are stored but the keychain would not open, so absent from
  /// `machineValues`. Named apart in the launch error: "missing" sends
  /// someone to a sheet that shows the value as already set.
  unreadableSecrets?(): readonly string[];
  /// The environment the user's login shell would give it — JAVA_HOME, AWS
  /// settings, PATH — which an app opened from the Dock never saw. Under the
  /// service's own variables, over the app's. `undefined` keeps the app's.
  shellEnv?(): Promise<Record<string, string> | undefined>;
  /// The values among those that are secrets. A service that logs its own
  /// configuration at boot — Spring does — would otherwise print the password
  /// straight into the pane, and into anything the log is copied to.
  secretValues?(): readonly string[];
  /// Gradle init script that injects JDWP into bootRun without depending on a
  /// project's private -PjvmArgs convention.
  gradleDebugInit?: string;
  /// Where every line also goes, past the in-memory cap — the file an agent
  /// is pointed at when asked what went wrong.
  logSink?: LogSink;
  /// Bring the main checkout's gitignored local config into the checkout about
  /// to be launched from. Called from `launch`, so a start, a restart, a
  /// rebind, a dependency brought up first and a dependent restarted after all
  /// get it — the manager calling it on some of those paths is how a branch
  /// switch came to start without its local properties. Returns what it linked.
  mirrorLocalConfig?(serviceId: string, checkout: string): Promise<readonly string[]> | readonly string[];
  /// Who is listening on each of these ports and what they are to the service
  /// that wants it. A LIST, answered in one pass: a lookup per service is two
  /// `lsof`s and a `ps` each, and a stack's worth of them started together
  /// time each other out. Without it nothing is adopted, which is the right
  /// default for a host that cannot tell a leftover from a database.
  /// `tokens` is what the service would launch, so a leftover's root is a
  /// process running that and not whatever else was started in the checkout.
  portOwners?(
    wanted: readonly { port: number; serviceId: string; tokens?: readonly string[] }[],
  ): Promise<ReadonlyMap<number, readonly PortOwner[]>>;
  /// Which process, if any, is already running each of these services — for
  /// the ones with no port, where the command line and the checkout are the
  /// only evidence there is. See `matchingProcesses`. Always asked about the
  /// whole stack, even to find one service: a process that fits two of them
  /// is refused, and that check cannot fire on a list of one.
  matchProcesses?(
    targets: readonly { serviceId: string; tokens: readonly string[]; subpath?: string }[],
  ): Promise<ReadonlyMap<string, ProcessMatch>>;
  /// When a process started — see `processStarted`. A string while it runs,
  /// `null` once it has gone, `undefined` where this host cannot tell. What
  /// keeps a Stop from tree-killing whatever the OS gave an adopted pid to
  /// after the leftover exited. Without it adopted pids go unchecked.
  processStarted?(pid: number): Promise<string | null | undefined>;
  /// Stop a process by pid, SIGTERM then SIGKILL. The portless counterpart of
  /// `stopHolder`.
  stopProcess?(pid: number): Promise<void>;
  /// Stop whatever holds a port: SIGTERM, then SIGKILL for the one that
  /// ignores it. Only ever used on an adopted process, which this supervisor
  /// has no handle to kill.
  stopHolder?(port: number, serviceId: string): Promise<void>;
  /// The commit a checkout is on, for recording what a task published from
  /// and for noticing later that it has moved. Optional: without it a task
  /// still records its branch, and only the commit comparison goes quiet.
  headOf?(checkout: string): string | undefined;
  /// Watch paths relative to a service's bound checkout. Optional keeps the
  /// supervisor deterministic in tests and usable by non-Electron hosts.
  watchFiles?(
    checkout: string,
    patterns: readonly string[],
    onChange: (relativePath: string) => void,
  ): ServiceFileWatcher;
  /// Shared by every stack, so a JVM build waits its turn behind the ones
  /// already compiling rather than starting beside all of them. See
  /// `LaunchGate`. Without it everything starts at once.
  launchGate?: LaunchGate;
}

export type SupervisorEvent =
  | { kind: 'status'; serviceId: string; runtime: ServiceRuntime }
  | { kind: 'line'; serviceId: string; line: string }
  /// A marker written into the log where the binding changed, so "this broke
  /// when I switched branches" is visible rather than remembered.
  | { kind: 'rebound'; serviceId: string; from: string; to: string };

/// How many lines of output to keep per service. Enough to cover a startup
/// and the failure after it; the full history goes to `logSink`.
export const LOG_LIMIT = 20_000;
const LOG_TRIM_BLOCK = 1_000;

/// How long a stop waits for the process to actually exit. The adapter sends
/// SIGKILL after five seconds, so this is that and a margin. Without the wait a
/// restart launched straight away beside a JVM still holding its port, and a
/// port probe then called the NEW process ready on the old one's socket.
const STOP_WAIT_MS = 7_000;
const CHANGE_DEBOUNCE_MS = 500;
/// How often an adopted process is checked for still being there. There is no
/// exit event for a process we did not start, so this is the only way its row
/// stops saying `ready` after it has gone.
export const ADOPTED_POLL_MS = 5_000;

export class Supervisor {
  private readonly procs = new Map<string, SpawnedProcess>();
  /// Which launch of each service is the current one, while it waits for a
  /// turn at the gate.
  private readonly currentLaunch = new Map<string, object>();
  private readonly runtimes = new Map<string, ServiceRuntime>();
  /// Each task's last successful run. The runtime above is overwritten by a
  /// failed re-run, and drift has to be measured against what is installed.
  private readonly lastRuns: Record<string, TaskRun> = {};
  private readonly logs = new Map<string, string[]>();
  /// Exceptions seen in each log, kept past the line cap that drops their lines.
  private readonly caught = new Map<string, ExceptionLog>();
  private readonly listeners = new Set<(e: SupervisorEvent) => void>();
  /// Tasks still running, settled when they exit however they exit.
  private readonly finishing = new Map<string, Promise<void>>();
  /// Settles when each service's current process has exited, however it exits.
  private readonly exits = new Map<string, Promise<void>>();
  private readonly watchers = new Map<string, ServiceFileWatcher>();
  private readonly changeTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly restartingFromChange = new Set<string>();
  private readonly queuedChanges = new Map<string, string>();
  /// What each adopted pid was when it was adopted — see `processStarted`.
  private readonly adoptedAs = new Map<string, { pid: number; started: string }>();
  private readonly adoptedPolls = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(
    readonly stackId: string,
    private specs: ServiceSpec[],
    private bindings: ServiceBinding[],
    private readonly deps: SupervisorDeps,
    /// What each task last installed, from the stack file. Statuses are
    /// otherwise a fresh sheet every launch — and a task reading `stopped`
    /// after a restart says nothing about the jar it left behind, which is
    /// still what everything here resolves.
    lastRuns: Readonly<Record<string, TaskRun>> = {},
  ) {
    for (const [serviceId, run] of Object.entries(lastRuns)) {
      if (!this.spec(serviceId)?.task) continue;
      this.lastRuns[serviceId] = run;
      this.runtimes.set(serviceId, {
        serviceId,
        status: 'done',
        ranRef: run.ref,
        ranCommit: run.commit,
        finishedAt: run.at,
      });
    }
  }

  on(listener: (e: SupervisorEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  runtime(serviceId: string): ServiceRuntime {
    return this.runtimes.get(serviceId) ?? { serviceId, status: 'stopped' };
  }

  log(serviceId: string): readonly string[] {
    const lines = this.logs.get(serviceId) ?? [];
    return lines.length > LOG_LIMIT ? lines.slice(lines.length - LOG_LIMIT) : lines;
  }

  exceptions(serviceId: string): CaughtException[] {
    const log = this.caught.get(serviceId);
    return log ? listExceptions(log) : [];
  }

  /// Empties the buffer. The process, if any, keeps running and writing.
  clearLog(serviceId: string): void {
    this.logs.delete(serviceId);
    this.caught.delete(serviceId);
  }

  /// Ports this supervisor is holding, in the shape the lease check wants.
  claims(): PortClaim[] {
    const out: PortClaim[] = [];
    for (const [serviceId, runtime] of this.runtimes) {
      if (runtime.status === 'stopped' || runtime.status === 'failed') continue;
      if (runtime.port !== undefined) {
        out.push({ port: runtime.port, serviceId, stackId: this.stackId, since: runtime.startedAt });
      }
      if (runtime.debugPort !== undefined) {
        out.push({ port: runtime.debugPort, serviceId, stackId: this.stackId, since: runtime.startedAt });
      }
    }
    return out;
  }

  /// Start a service, first bringing up anything it waits on. `foreign` is
  /// what other stacks are holding; a clash is RETURNED, never resolved
  /// quietly, because silently stealing a port from a flow you weren't
  /// watching is worse than refusing to start.
  async start(
    serviceId: string,
    opts: { foreign?: readonly PortClaim[]; offset?: number } = {},
  ): Promise<{ started: boolean; lease?: LeaseDecision }> {
    const spec = this.spec(serviceId);
    if (!spec) return { started: false };

    if (opts.offset === undefined) {
      const claims = [...this.claims(), ...(opts.foreign ?? [])];
      const lease = leaseFor(spec, this.stackId, claims);
      if (lease.kind !== 'free') return { started: false, lease };
      if (spec.debugEnabled && spec.debugPort !== undefined) {
        const debugLease = leaseFor({ ...spec, port: spec.debugPort }, this.stackId, claims);
        if (debugLease.kind !== 'free') return { started: false, lease: debugLease };
      }
    }

    // A task already running is waited for, not launched a second time beside
    // itself — two Gradle publishes into one `~/.m2` is a corrupt jar.
    const running = this.finishing.get(serviceId);
    if (spec.task && running) {
      await running;
      return { started: true };
    }

    for (const depId of startOrder(this.specs, serviceId)) {
      // An adopted dependency reads `ready` from when it was adopted. Asked
      // again now, or this starts against a leftover that has since exited.
      if (this.runtime(depId).adopted) await this.verifyAdopted(depId);
      if (this.satisfied(depId)) continue;
      const dep = this.spec(depId);
      // Starting, from the moment Start is pressed: a backend can take a minute
      // to come up, and a row that still reads stopped all that time looks as
      // though the press did nothing.
      this.setStatus(serviceId, {
        status: 'starting',
        waitingOn: dep?.name ?? depId,
        exitCode: undefined,
        lastError: undefined,
      });
      await this.start(depId, { foreign: opts.foreign });
      // Stopped while it waited. There was no process to kill, so this is the
      // only thing that keeps the stop from being undone by the launch below.
      if (this.runtime(serviceId).status !== 'starting') return { started: false };
      // The one dependency worth refusing over. A backend that is not up yet
      // gets reconnected to; a publish that failed means starting against
      // whatever jars were there before, which fails later and misleadingly.
      if (dep?.task && !this.satisfied(depId)) {
        this.setStatus(serviceId, {
          status: 'failed',
          lastError: `${dep.name} did not finish, so this was not started.`,
        });
        return { started: false };
      }
    }

    this.noteTaskRefs(spec);
    await this.launch(spec, opts.offset ?? 0);
    return { started: true };
  }

  /// Take back the services still running from before the app was reopened.
  ///
  /// Statuses live in memory and start empty, but a service left running by a
  /// quit that was asked not to stop it is still there, still holding its
  /// port. Reading every row as `stopped` is worse than merely wrong: the
  /// first Start hits the busy port and offers to kill the thing that was
  /// working.
  ///
  /// Only a holder that is a leftover of THIS service is taken. `other` is
  /// someone's terminal or their database, `self` is overcli, and neither is
  /// ours to claim — the same three-way rule the port lookup already applies
  /// before offering to stop anything.
  ///
  /// What cannot be taken back is the output. Its stdout was piped to a
  /// process that no longer exists, so the log holds what is on disk and
  /// nothing new arrives until a restart. Said in the log rather than left to
  /// be discovered.
  async adopt(): Promise<void> {
    const lookup = this.deps.portOwners;
    if (!lookup) return;

    const wanted = this.specs.flatMap((spec) =>
      !spec.task && spec.port !== undefined && this.adoptable(spec.id)
        ? [{ port: spec.port, serviceId: spec.id, tokens: this.launchTokens(spec) }]
        : [],
    );
    if (wanted.length === 0) return;
    const held = await lookup(wanted);

    for (const spec of this.specs) {
      if (spec.task || spec.port === undefined) continue;
      const owners = held.get(spec.port) ?? [];
      if (owners.length === 0 || !owners.every((o) => o.kind === 'stale')) continue;
      // The lookup shells out; a start may have happened while it ran.
      if (!this.adoptable(spec.id)) continue;

      // The port is held, which for a port check IS the readiness check. A log
      // match cannot be rerun against output we never received, so the held
      // port stands in for it rather than reporting a service that is up as
      // never having come up.
      const probe = { ...this.deps.probe, logMatched: () => true };
      const ready = await waitUntilReady(spec.ready, probe, { isAlive: () => true, timeoutMs: 2_000 });

      const pid = owners[0].root ?? owners[0].pid;
      const started = await this.identify(pid);
      if (started === null || !this.adoptable(spec.id)) continue;
      const at = this.deps.probe.now();
      this.append(spec.id, `── adopted · pid ${pid} was already listening on :${spec.port} ──`);
      this.append(spec.id, '── its output went to the process that started it; restart to get it back ──');
      this.setStatus(spec.id, {
        status: ready.ready ? 'ready' : 'unready',
        adopted: true,
        pid,
        port: spec.port,
        startedAt: at,
        readyAt: ready.ready ? at : undefined,
        exitCode: undefined,
        lastError: undefined,
      });
      this.trackAdopted(spec.id, pid, started);
    }

    await this.adoptPortless();
  }

  /// The same, for services that listen on nothing.
  ///
  /// These are the ones a double launch actually hurts: two copies of a queue
  /// consumer both take work, and nothing complains the way a taken port does.
  /// `leaseFor` cannot help — a service that binds nothing collides with
  /// nothing — so the command line and the checkout have to stand in for the
  /// port, and a match is only accepted when it is unambiguous.
  private async adoptPortless(): Promise<void> {
    const match = this.deps.matchProcesses;
    if (!match) return;

    const portless = this.specs.filter((spec) => !spec.task && spec.port === undefined && this.adoptable(spec.id));
    if (portless.length === 0) return;

    // Asked about the whole stack, adopted only for the portless: a process
    // that also fits a service with a port is ambiguous, and has to be seen
    // to be refused.
    for (const [serviceId, found] of await match(this.matchTargets())) {
      if (!portless.some((spec) => spec.id === serviceId)) continue;
      if (found.kind !== 'stale' || !this.adoptable(serviceId)) continue;
      const pid = found.root ?? found.pid;
      const started = await this.identify(pid);
      if (started === null || !this.adoptable(serviceId)) continue;
      this.append(serviceId, `── adopted · pid ${pid} was already running this ──`);
      this.append(serviceId, '── its output went to the process that started it; restart to get it back ──');
      this.setStatus(serviceId, {
        status: 'ready',
        adopted: true,
        pid,
        startedAt: this.deps.probe.now(),
        readyAt: this.deps.probe.now(),
        exitCode: undefined,
        lastError: undefined,
      });
      this.trackAdopted(serviceId, pid, started);
    }
  }

  /// Whether this service is already running, in which case it is taken over
  /// rather than started again. A process that is somebody's own run is left
  /// alone and said out loud: starting beside it is their call to make, but
  /// not one to make without being told.
  private async claimRunning(spec: ServiceSpec): Promise<boolean> {
    const found = await this.findRunning(spec);
    if (!found) return false;
    if (found.kind !== 'stale') {
      // Somebody's own run. A port clash explains itself when the start fails;
      // a portless second copy would not, so say it before starting one.
      if (spec.port === undefined) {
        this.append(spec.id, `── pid ${found.pid} is already running this from outside overcli; starting another ──`);
      }
      return false;
    }

    const pid = found.root ?? found.pid;
    // Gone between the scan and now: nothing to take over, so start one.
    const started = await this.identify(pid);
    if (started === null) return false;
    const at = this.deps.probe.now();
    this.append(spec.id, `── already running as pid ${pid}; adopted rather than started a second time ──`);
    this.append(spec.id, '── its output went to the process that started it; restart to get it back ──');
    this.setStatus(spec.id, {
      status: 'ready',
      adopted: true,
      pid,
      port: spec.port,
      startedAt: at,
      readyAt: at,
      exitCode: undefined,
      lastError: undefined,
    });
    this.trackAdopted(spec.id, pid, started);
    return true;
  }

  /// A running copy of this service, by its command line first — that finds a
  /// leftover still booting, before it has bound anything — and then by its
  /// port.
  ///
  /// Every service in the stack is asked about, and this one's answer read
  /// out. Asking about this one alone let `web` adopt `admin`'s leftover when
  /// both run `npm run dev`: with one service in the question, a process that
  /// fits two of them can never be seen to.
  private async findRunning(spec: ServiceSpec): Promise<ProcessMatch | undefined> {
    const byCommand = await this.deps.matchProcesses?.(this.matchTargets());
    const match = byCommand?.get(spec.id);
    if (match) return match;

    if (spec.port === undefined || !this.deps.portOwners) return undefined;
    const owners = (await this.deps.portOwners([
      { port: spec.port, serviceId: spec.id, tokens: this.launchTokens(spec) },
    ])).get(spec.port) ?? [];
    if (owners.length === 0) return undefined;
    const first = owners[0];
    return owners.every((o) => o.kind === 'stale')
      ? { pid: first.pid, command: first.command, kind: 'stale', root: first.root }
      : { pid: first.pid, command: first.command, kind: 'other' };
  }

  /// What this service's command line would be, options included — the part
  /// that tells four copies of one processor apart. Without the projection or
  /// the debugger wrapper, which is why a match is containment rather than
  /// equality: everything here appears in the real argv, with more around it.
  private launchTokens(spec: ServiceSpec): string[] {
    const machine = this.deps.machineValues?.() ?? {};
    try {
      return buildCommand(spec, resolveOptions(this.specs, spec, machine));
    } catch {
      return [...spec.command];
    }
  }

  /// Every service in the stack, as `matchProcesses` wants them.
  private matchTargets(): { serviceId: string; tokens: string[]; subpath?: string }[] {
    return this.specs.map((spec) => ({
      serviceId: spec.id,
      tokens: this.launchTokens(spec),
      ...(spec.subpath ? { subpath: spec.subpath } : {}),
    }));
  }

  /// When `pid` started, if this host can tell — `null` when it has gone.
  private async identify(pid: number): Promise<string | null | undefined> {
    return this.deps.processStarted ? this.deps.processStarted(pid) : undefined;
  }

  /// Remember what an adopted pid was, and keep checking that it still is.
  private trackAdopted(serviceId: string, pid: number, started: string | undefined): void {
    this.forgetAdopted(serviceId);
    if (started === undefined) return;
    this.adoptedAs.set(serviceId, { pid, started });
    this.pollAdopted(serviceId);
  }

  private forgetAdopted(serviceId: string): void {
    this.adoptedAs.delete(serviceId);
    const timer = this.adoptedPolls.get(serviceId);
    if (timer) clearTimeout(timer);
    this.adoptedPolls.delete(serviceId);
  }

  private pollAdopted(serviceId: string): void {
    const timer = setTimeout(() => {
      this.adoptedPolls.delete(serviceId);
      void this.verifyAdopted(serviceId).then((same) => {
        if (same && this.adoptedAs.has(serviceId) && !this.adoptedPolls.has(serviceId)) this.pollAdopted(serviceId);
      });
    }, ADOPTED_POLL_MS);
    timer.unref?.();
    this.adoptedPolls.set(serviceId, timer);
  }

  /// Whether an adopted service's pid is still the process that was adopted.
  /// When it is not — exited, or exited and its pid handed on — the row goes
  /// to `stopped` and nothing is signalled: the leftover is not there to stop,
  /// and whatever holds its pid now is not ours. True when there is nothing to
  /// check, or no way to.
  async verifyAdopted(serviceId: string): Promise<boolean> {
    const known = this.adoptedAs.get(serviceId);
    const runtime = this.runtime(serviceId);
    if (!known || !runtime.adopted || runtime.pid !== known.pid || !this.deps.processStarted) return true;
    const now = await this.deps.processStarted(known.pid);
    if (now === undefined) return true;
    // Stopped, restarted or adopted afresh while `ps` ran: that owns it now.
    if (this.adoptedAs.get(serviceId) !== known) return true;
    if (now === known.started) return true;

    this.append(
      serviceId,
      now === null
        ? `── the adopted process, pid ${known.pid}, has exited ──`
        : `── pid ${known.pid} is no longer the adopted process (it started ${now}, not ${known.started}); left alone ──`,
    );
    this.setStatus(serviceId, {
      status: 'stopped', adopted: undefined, pid: undefined, port: undefined, readyAt: undefined,
      debugKind: undefined, debugPort: undefined,
    });
    return false;
  }

  /// Nothing of ours already running or on its way up.
  private adoptable(serviceId: string): boolean {
    return !this.procs.has(serviceId) && this.runtime(serviceId).status === 'stopped';
  }

  /// Take an edited stack in place. Replacing the supervisor used to be how an
  /// edit took effect, and it cost far more than the edit: every other
  /// service's output went with it, and anything still running lost its
  /// supervisor — holding its port while the pane called it stopped. A service
  /// no longer listed is stopped and forgotten; everything else carries on.
  update(specs: ServiceSpec[], bindings: ServiceBinding[]): void {
    const kept = new Set(specs.map((s) => s.id));
    for (const id of [...this.procs.keys()]) {
      if (!kept.has(id)) void this.stop(id);
    }
    for (const id of [...this.runtimes.keys()]) {
      if (!kept.has(id)) {
        this.forgetAdopted(id);
        this.runtimes.delete(id);
      }
    }
    for (const id of [...this.logs.keys()]) {
      if (!kept.has(id)) {
        this.logs.delete(id);
        this.caught.delete(id);
        this.deps.logSink?.close(id);
      }
    }
    this.specs = specs;
    this.bindings = bindings;
    // A settings edit can turn watching on/off or change its globs without
    // bouncing the service merely to apply the watcher configuration.
    for (const [id, proc] of this.procs) this.startWatcher(id, proc);
  }

  async stop(serviceId: string): Promise<void> {
    this.stopWatcher(serviceId);
    const proc = this.procs.get(serviceId);
    if (!proc) {
      const runtime = this.runtime(serviceId);
      // Adopted: there is no child of ours to signal, so the port is what we
      // have to go on — the same stop the pane offers for a leftover copy.
      // By pid whenever there is one: that is the root of the leftover's tree,
      // and stopping the tree is what frees everything it holds. Through the
      // port only as a fallback, which reaches the listener and nothing above.
      if (runtime.adopted && runtime.pid && this.deps.stopProcess) {
        // The pid was a leftover's when it was adopted. Signalling it — and
        // everything under it — is only right while it still is.
        if (!(await this.verifyAdopted(serviceId))) return;
        this.append(serviceId, `── stopping the adopted process, pid ${runtime.pid}, and everything under it ──`);
        await this.deps.stopProcess(runtime.pid);
        this.setStatus(serviceId, {
          status: 'stopped', adopted: undefined, pid: undefined,
          debugKind: undefined, debugPort: undefined,
        });
        return;
      }
      if (runtime.adopted && runtime.port !== undefined && this.deps.stopHolder) {
        this.append(serviceId, `── stopping the adopted process on :${runtime.port} ──`);
        await this.deps.stopHolder(runtime.port, serviceId);
        this.setStatus(serviceId, {
          status: 'stopped', adopted: undefined, pid: undefined, port: undefined,
          debugKind: undefined, debugPort: undefined,
        });
        return;
      }
      // Waiting on something it depends on, or for a turn to build: nothing to
      // kill yet, but the start has to be called off.
      if (runtime.waitingOn || runtime.queued) this.setStatus(serviceId, { status: 'stopped' });
      return;
    }
    this.procs.delete(serviceId);
    const exited = this.exits.get(serviceId);
    proc.kill('SIGTERM');
    this.setStatus(serviceId, {
      status: 'stopped', pid: undefined, port: undefined,
      debugKind: undefined, debugPort: undefined,
    });
    if (exited) await Promise.race([exited, this.deps.probe.sleep(STOP_WAIT_MS)]);
  }

  async restart(serviceId: string): Promise<void> {
    const offset = this.runtime(serviceId).port
      ? offsetOf(this.spec(serviceId)?.port, this.runtime(serviceId).port)
      : 0;
    await this.stop(serviceId);
    const spec = this.spec(serviceId);
    // Launched fresh, never adopted: what the stop just signalled can still be
    // on its way out — a child reparented to launchd while it shuts down — and
    // looks exactly like a leftover. Taking it over marked the service ready a
    // moment before it exited.
    if (spec) await this.launch(spec, offset, { fresh: true });

    // Only where an edge was explicitly marked. The default is that nothing
    // else moves.
    for (const dependentId of restartDependents(this.specs, serviceId)) {
      await this.restart(dependentId);
    }
  }

  /// Point a service at a different checkout. The identity, its log and its
  /// place in the graph are untouched — only where it looks for code.
  async rebind(serviceId: string, binding: Omit<ServiceBinding, 'serviceId'>): Promise<void> {
    const spec = this.spec(serviceId);
    if (!spec) return;
    if (spec.pinnedRef && spec.pinnedRef !== binding.ref) return;

    const previous = this.binding(serviceId);
    const wasRunning = this.procs.has(serviceId);
    await this.stop(serviceId);

    this.bindings = [
      ...this.bindings.filter((b) => b.serviceId !== serviceId),
      { ...binding, serviceId },
    ];

    this.append(serviceId, `── rebound ${previous?.ref ?? '(unbound)'} → ${binding.ref} ──`);
    this.emit({ kind: 'rebound', serviceId, from: previous?.ref ?? '', to: binding.ref });

    // A service that was not running stays not running: rebinding is not a
    // request to start something you had deliberately stopped.
    // Fresh for the same reason as a restart: the copy just stopped is still
    // going away.
    if (wasRunning) await this.launch(spec, binding.portOffset ?? 0, { fresh: true });
    // Not relaunched, but the checkout should still have its local config for
    // the next start, or for running it from an IDE.
    else await this.mirrorInto(serviceId, binding.path);
  }

  /// Move every unpinned service to a ref at once — the bulk case, since
  /// several services usually share one worktree.
  async rebindAll(
    targets: readonly { serviceId: string; ref: string; path: string }[],
  ): Promise<string[]> {
    const moved: string[] = [];
    for (const target of targets) {
      const spec = this.spec(target.serviceId);
      // A pin holds a service to ONE ref, so it only refuses a move somewhere
      // else — the same rule `rebind` applies. Refusing every pinned service
      // made "switch to master and pin there" a silent no-op for anything
      // already pinned to master but bound elsewhere: the pin wrote, the move
      // did not, and running it again could never repair it, because the pin
      // that blocked the move was the one the move had just written.
      if (!spec || (spec.pinnedRef && spec.pinnedRef !== target.ref)) continue;
      await this.rebind(target.serviceId, { ref: target.ref, path: target.path });
      moved.push(target.serviceId);
    }
    return moved;
  }

  // ── internals ────────────────────────────────────────────────────────────

  private async launch(spec: ServiceSpec, offset: number, opts: { fresh?: boolean } = {}): Promise<void> {
    const binding = this.binding(spec.id);
    if (!binding) {
      this.setStatus(spec.id, { status: 'failed', lastError: 'No worktree bound' });
      return;
    }

    // Nothing to run. An import used to save services like this, and spawn()
    // throws SYNCHRONOUSLY on an undefined program — straight out through the
    // IPC handler as a stack trace, where the 'error' listener never sees it.
    // A failed status is something the pane can explain.
    if (spec.command.length === 0 || !spec.command[0]) {
      this.setStatus(spec.id, {
        status: 'failed',
        lastError:
          'This service has no command to run. Set one under Settings → Command.',
      });
      return;
    }

    // Already running from before the app was reopened? Then take it over
    // rather than start a second copy. Not only the portless: adoption looks
    // once, when the pane first opens, and a leftover still booting then — a
    // JVM a minute from binding its port — is invisible to it. `leaseFor`
    // cannot catch it either; it only knows about ports overcli handed out.
    // So the check that matters is this one, at the moment of starting — but
    // not straight after stopping this service, see `restart`.
    if (!spec.task && !opts.fresh && (await this.claimRunning(spec))) return;

    const port = spec.port === undefined ? undefined : portForOffset(spec.port, offset);
    // Read now, not on exit: a commit made while a ten-minute publish runs is
    // not in what it published.
    const ranCommit = spec.task ? this.deps.headOf?.(binding.path) : undefined;

    let plan;
    try {
      plan = await planProjection(spec, binding, {
        symlinkRoots: this.deps.symlinkRoots,
        fs: this.deps.fs,
        port,
        configDir: this.deps.configDir(spec.id),
      });
    } catch (err) {
      // The common cause is a worktree that has gone — flows commit into the
      // main checkout and delete the scratch tree mid-session, so this is a
      // routine event with a real remedy, not a crash.
      this.setStatus(spec.id, { status: 'failed', lastError: (err as Error).message });
      return;
    }

    const env = plan.env;
    try {
      await applyProjection(plan, { fs: this.deps.fs });
    } catch (err) {
      // A permission problem, a read-only checkout, a link that cannot be
      // written. The service has failed to start, which is a status with a
      // message — not an exception out of the IPC handler, which reaches the
      // user as a stack trace in a terminal they may not be watching.
      this.setStatus(spec.id, {
        status: 'failed',
        lastError: `Could not put the local config in place: ${(err as Error).message}`,
      });
      return;
    }

    this.setStatus(spec.id, {
      status: 'starting',
      waitingOn: undefined,
      port,
      startedAt: this.deps.probe.now(),
      exitCode: undefined,
      lastError: undefined,
      ranRef: undefined,
      ranCommit: undefined,
      adopted: undefined,
      debugKind: undefined,
      debugPort: undefined,
    });

    // After the status says starting: finding the local config reads the main
    // checkout's ignored files, which takes seconds on a large repository.
    if (this.deps.mirrorLocalConfig) {
      await this.mirrorInto(spec.id, binding.path);
      // Stopped, restarted or rebound while that ran — that call owns it now.
      if (this.runtime(spec.id).status !== 'starting' || this.procs.has(spec.id)) return;
    }

    // Read once per app run and usually done long before anyone presses
    // start, but a first start straight after launch can wait on it.
    const shell = this.deps.shellEnv ? await this.deps.shellEnv() : undefined;
    if (this.deps.shellEnv && (this.runtime(spec.id).status !== 'starting' || this.procs.has(spec.id))) return;

    // Options are resolved at launch, not stored resolved: a copy inherits its
    // base's set, and editing the base has to reach every copy without anyone
    // re-saving them.
    const machine = this.deps.machineValues?.() ?? {};
    const options = resolveOptions(this.specs, spec, machine);
    const missing = missingMachineValues(options);
    if (missing.length > 0) {
      // Naming what is missing beats a stack trace from a service that started
      // with a literal `${DB_USER}` in its arguments.
      this.setStatus(spec.id, {
        status: 'failed',
        lastError: missingMachineError(missing, this.deps.unreadableSecrets?.() ?? []),
      });
      return;
    }
    const baseCommand = buildCommand({ ...spec, command: plan.command }, options);
    const preferredDebugPort = spec.debugEnabled ? spec.debugPort : undefined;
    const actualDebugPort = preferredDebugPort === undefined
      ? undefined
      : portForOffset(preferredDebugPort, offset);
    const debug = debugLaunch(
      spec,
      baseCommand,
      env,
      actualDebugPort,
      this.deps.gradleDebugInit,
    );
    if (debug.kind && debug.port) {
      this.append(spec.id, `── ${debug.kind} debugger listening on 127.0.0.1:${debug.port} ──`);
      this.setStatus(spec.id, { debugKind: debug.kind, debugPort: debug.port });
    }

    // A service in a subfolder runs from that subfolder — `npm run start` in
    // the repo root of acme-admin-console finds no package.json. Projection has
    // always used the subpath; the spawn has to agree with it.
    const cwd = spec.subpath ? path.join(plan.cwd, spec.subpath) : plan.cwd;

    // Held from the spawn until it is ready, gives up, or exits: the build and
    // the boot are the expensive part, not the running afterwards.
    let release: ReleaseSlot = () => {};
    const gate = this.deps.launchGate;
    if (gate && buildsOnJvm(spec)) {
      // A token rather than the status: a restart while this waited sets the
      // status back to starting, and both launches would then spawn.
      const token = {};
      this.currentLaunch.set(spec.id, token);
      if (gate.full) this.setStatus(spec.id, { queued: true });
      release = await gate.acquire();
      if (this.runtime(spec.id).queued) this.setStatus(spec.id, { queued: undefined });
      if (
        this.currentLaunch.get(spec.id) !== token ||
        this.runtime(spec.id).status !== 'starting' ||
        this.procs.has(spec.id)
      ) {
        release();
        return;
      }
    }

    // File only: the pane already shows the status, but a log read later by an
    // agent needs to know where one run ends and the next begins.
    this.writeLog(spec.id, `── start ${binding.ref} · ${cwd} · ${debug.command.join(' ')} ──`);
    const proc = this.deps.spawn({ command: debug.command, cwd, env: { ...shell, ...debug.env } });
    this.procs.set(spec.id, proc);

    // Settled on ANY exit, including one a stop caused — which the handlers
    // below otherwise ignore — or a dependent waiting on it would wait forever.
    let finish = () => {};
    const finished = new Promise<void>((resolve) => (finish = resolve));
    this.exits.set(spec.id, finished);

    let matchedLog = false;
    proc.onLine((line) => {
      if (spec.ready.kind === 'log' && new RegExp(spec.ready.pattern).test(line)) matchedLog = true;
      this.append(spec.id, line);
    });
    // Only the process this service is CURRENTLY running speaks for it. One
    // that was stopped — by a restart, a rebind, a removal — exits a moment
    // later, and letting that exit through marked the new process failed and
    // dropped it from `procs`, or brought a removed service back as a status.
    proc.onError((err) => {
      finish();
      release();
      if (this.procs.get(spec.id) !== proc) return;
      this.stopWatcher(spec.id);
      this.procs.delete(spec.id);
      this.setStatus(spec.id, {
        status: 'failed', lastError: err.message, pid: undefined,
        debugKind: undefined, debugPort: undefined,
      });
    });
    proc.onExit((code) => {
      finish();
      release();
      if (this.procs.get(spec.id) !== proc) return;
      this.stopWatcher(spec.id);
      this.procs.delete(spec.id);
      if (spec.task && code === 0) {
        const finishedAt = this.deps.probe.now();
        this.lastRuns[spec.id] = { ref: binding.ref, commit: ranCommit, at: finishedAt };
        this.setStatus(spec.id, {
          status: 'done',
          exitCode: code,
          pid: undefined,
          ranRef: binding.ref,
          ranCommit,
          finishedAt,
          debugKind: undefined,
          debugPort: undefined,
        });
        return;
      }
      this.setStatus(spec.id, {
        status: code === 0 ? 'stopped' : 'failed', exitCode: code, pid: undefined,
        debugKind: undefined, debugPort: undefined,
      });
    });

    this.setStatus(spec.id, { pid: proc.pid });
    this.startWatcher(spec.id, proc);

    // A task has nothing to probe: it is ready when it is finished.
    if (spec.task) {
      this.finishing.set(spec.id, finished);
      await finished;
      if (this.finishing.get(spec.id) === finished) this.finishing.delete(spec.id);
      return;
    }

    const probe = { ...this.deps.probe, logMatched: () => matchedLog };
    // Alive means THIS process is still the one running: a restart during a
    // long wait must not let the old wait report on the new process.
    const isAlive = () => this.procs.get(spec.id) === proc;
    const result = await waitUntilReady(spec.ready, probe, {
      isAlive,
      timeoutMs: (spec.readyTimeoutSec ?? defaultReadyTimeoutSec(spec)) * 1000,
    });
    // Ready or slow, it has had its turn; one that never answers must not
    // hold the queue behind it.
    release();

    // A process that died on its way up has already set `failed` from
    // `onExit`; don't overwrite that with the vaguer `unready`.
    if (result.exited) return;
    if (result.ready) {
      this.setStatus(spec.id, { status: 'ready', readyAt: this.deps.probe.now() });
      return;
    }

    // Past its allowance and still running. Slow is not broken, so say so and
    // keep asking — less often — until it answers or dies. Not awaited: the
    // start has reported all it can, and a slow service must not hold up the
    // ones queued behind it.
    this.setStatus(spec.id, { status: 'unready' });
    void waitUntilReady(spec.ready, probe, {
      isAlive,
      timeoutMs: Number.POSITIVE_INFINITY,
      intervalMs: 3_000,
    }).then((late) => {
      if (late.ready && isAlive()) {
        this.setStatus(spec.id, { status: 'ready', readyAt: this.deps.probe.now() });
      }
    });
  }

  /// Whether a dependency needs nothing more before its dependent starts. A
  /// task is satisfied only by a finish on the ref it is bound to NOW: after a
  /// rebind, what it published came from somewhere else.
  ///
  /// The commit is deliberately not part of this. Re-running a publish costs
  /// minutes, and doing it on its own because someone pulled would be a worse
  /// surprise than the stale jar — so a task that has moved on within its
  /// branch is reported by `noteTaskRefs` and by the pane, beside a button,
  /// and left for whoever is looking to decide.
  private satisfied(serviceId: string): boolean {
    const runtime = this.runtime(serviceId);
    if (!this.spec(serviceId)?.task) return runtime.status === 'ready';
    return runtime.status === 'done' && runtime.ranRef === this.binding(serviceId)?.ref;
  }

  /// Say so in the output when what a task this service waits on published is
  /// not what its checkout says now. `~/.m2` holds one copy of each artifact
  /// for the whole machine, so this service is about to build against
  /// whatever the task last put there — another branch, or the same branch
  /// several commits ago. Legitimate when a task is pinned to master, and
  /// baffling when nobody meant it, which is why it is said rather than acted
  /// on. The same comparison the pane shows, from the same rule.
  ///
  /// Only the checkouts the comparison reads: this service's and its tasks'.
  /// `headOf` can be a synchronous git call, and asking it for every binding
  /// in the stack put one per service on each start.
  private noteTaskRefs(spec: ServiceSpec): void {
    const involved = new Set([spec.id, ...(spec.deps ?? [])]);
    const bindings = this.bindings
      .filter((b) => involved.has(b.serviceId))
      .map((b) => ({ ...b, head: this.deps.headOf?.(b.path) }));
    const runtimes = this.specs.map((s) => this.runtime(s.id));
    for (const { task, drift } of driftedTasks(spec, this.specs, runtimes, bindings, this.lastRuns)) {
      this.append(spec.id, `── ${describeDrift(task.name, drift)} ──`);
    }
  }

  private async mirrorInto(serviceId: string, checkout: string): Promise<void> {
    const mirrored = (await this.deps.mirrorLocalConfig?.(serviceId, checkout)) ?? [];
    if (mirrored.length > 0) {
      this.append(
        serviceId,
        `── brought ${mirrored.length} local config file${mirrored.length === 1 ? '' : 's'} in from the main checkout ──`,
      );
    }
  }

  private startWatcher(serviceId: string, proc: SpawnedProcess): void {
    this.stopWatcher(serviceId);
    const spec = this.spec(serviceId);
    const binding = this.binding(serviceId);
    if (
      !spec || spec.task || !binding || !this.deps.watchFiles ||
      !shouldRestartOnChange(spec) || this.procs.get(serviceId) !== proc
    ) return;
    const patterns = normalizeWatchPatterns(spec.watch ?? []);
    if (patterns.length === 0) return;
    const watcher = this.deps.watchFiles(binding.path, patterns, (changedPath) => {
      if (this.procs.get(serviceId) !== proc) return;
      this.scheduleChangeRestart(serviceId, changedPath);
    });
    this.watchers.set(serviceId, watcher);
  }

  private stopWatcher(serviceId: string): void {
    const timer = this.changeTimers.get(serviceId);
    if (timer) clearTimeout(timer);
    this.changeTimers.delete(serviceId);
    this.queuedChanges.delete(serviceId);
    const watcher = this.watchers.get(serviceId);
    this.watchers.delete(serviceId);
    if (watcher) void watcher.close();
  }

  private scheduleChangeRestart(serviceId: string, changedPath: string): void {
    if (this.restartingFromChange.has(serviceId)) {
      this.queuedChanges.set(serviceId, changedPath);
      return;
    }
    const previous = this.changeTimers.get(serviceId);
    if (previous) clearTimeout(previous);
    this.changeTimers.set(serviceId, setTimeout(() => {
      this.changeTimers.delete(serviceId);
      void this.restartForChange(serviceId, changedPath);
    }, CHANGE_DEBOUNCE_MS));
  }

  private async restartForChange(serviceId: string, changedPath: string): Promise<void> {
    const spec = this.spec(serviceId);
    if (!spec || !shouldRestartOnChange(spec) || !this.procs.has(serviceId)) return;
    this.restartingFromChange.add(serviceId);
    this.append(serviceId, `── code changed · ${changedPath} · restarting ──`);
    try {
      await this.restart(serviceId);
    } finally {
      this.restartingFromChange.delete(serviceId);
      const queued = this.queuedChanges.get(serviceId);
      this.queuedChanges.delete(serviceId);
      // A save that landed while the process was relaunching deserves one
      // more restart, but a compile burst before it began was debounced into
      // the restart we just completed.
      if (queued && this.procs.has(serviceId)) this.scheduleChangeRestart(serviceId, queued);
    }
  }

  private spec(serviceId: string): ServiceSpec | undefined {
    return this.specs.find((s) => s.id === serviceId);
  }

  private binding(serviceId: string): ServiceBinding | undefined {
    return this.bindings.find((b) => b.serviceId === serviceId);
  }

  private setStatus(serviceId: string, patch: Partial<ServiceRuntime>): void {
    const next = { ...this.runtime(serviceId), ...patch, serviceId };
    // Waiting is a kind of starting; any other status ends it.
    if (next.status !== 'starting') {
      next.waitingOn = undefined;
      next.queued = undefined;
    }
    // No longer adopted, however that came about: nothing left to watch.
    if (!next.adopted) this.forgetAdopted(serviceId);
    this.runtimes.set(serviceId, next);
    if (patch.status === 'failed' || patch.status === 'stopped' || patch.status === 'done') {
      const detail = [
        patch.exitCode !== undefined && patch.exitCode !== null ? `exit ${patch.exitCode}` : '',
        patch.lastError ?? '',
      ].filter(Boolean).join(' · ');
      this.writeLog(serviceId, `── ${patch.status}${detail ? ` · ${detail}` : ''} ──`);
    }
    this.emit({ kind: 'status', serviceId, runtime: next });
  }

  /// Decrypting a machine secret is an OS keychain round-trip. Calling the
  /// thunk per log line put thousands of them per second on the thread that
  /// paints every window. Read once; `clearSecretCache` drops it when the
  /// secret store is written.
  private secretCache: readonly string[] | undefined;
  private maskCache: readonly string[] | undefined;

  private secrets(): readonly string[] {
    if (this.secretCache === undefined) this.secretCache = this.deps.secretValues?.() ?? [];
    return this.secretCache;
  }

  clearSecretCache(): void {
    this.secretCache = undefined;
    this.maskCache = undefined;
  }

  private mask(raw: string): string {
    if (this.maskCache === undefined) this.maskCache = [...this.secrets()].sort((a, b) => b.length - a.length);
    return maskSecretsSorted(raw, this.maskCache);
  }

  private append(serviceId: string, raw: string): void {
    const line = this.mask(raw);
    const lines = this.logs.get(serviceId) ?? [];
    lines.push(line);
    // Trimming one element off a 20k array per line is an O(20k) memmove per
    // line, forever. Trim in blocks; the reader slices to the exact cap.
    if (lines.length > LOG_LIMIT + LOG_TRIM_BLOCK) lines.splice(0, lines.length - LOG_LIMIT);
    this.logs.set(serviceId, lines);
    this.writeLog(serviceId, line);
    this.caught.set(serviceId, feedException(this.caught.get(serviceId) ?? emptyExceptionLog(), line, Date.now()));
    this.emit({ kind: 'line', serviceId, line });
  }

  private emit(event: SupervisorEvent): void {
    for (const listener of this.listeners) listener(event);
  }

  private writeLog(serviceId: string, raw: string): void {
    this.deps.logSink?.write(serviceId, this.mask(raw));
  }
}

/// Shorter than this and a "secret" is also a substring of ordinary words;
/// masking every `root` in a log protects nothing and shreds the output.
const MIN_MASKED_LEN = 6;

/// Replace every occurrence of a known secret in a log line. Longest first, so
/// a value that contains another is not split into a masked half and a
/// readable one. `split`/`join` rather than a regex: a password can contain
/// any regex metacharacter.
export function maskSecrets(line: string, secrets: readonly string[]): string {
  return maskSecretsSorted(line, [...secrets].sort((a, b) => b.length - a.length));
}

function maskSecretsSorted(line: string, secrets: readonly string[]): string {
  let out = line;
  for (const secret of secrets) {
    if (secret.length < MIN_MASKED_LEN || !out.includes(secret)) continue;
    out = out.split(secret).join(SECRET_MASK);
  }
  return out;
}

/// Recover which offset a running port represents, so a restart comes back on
/// the same one rather than fighting whoever holds the base port.
function offsetOf(basePort: number | undefined, runningPort: number | undefined): number {
  if (basePort === undefined || runningPort === undefined) return 0;
  const diff = runningPort - basePort;
  return diff > 0 && diff % 10_000 === 0 ? diff / 10_000 : 0;
}
