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
import { applyProjection, planProjection, type ProjectionFs } from './projection';
import type { LogSink } from './logFile';
import { waitUntilReady, type ProbeDeps } from './readiness';
import type { ServiceBinding, ServiceRuntime, ServiceSpec } from './types';
import { normalizeWatchPatterns, restartDependents, shouldRestartOnChange, startOrder } from './types';
import { DEFAULT_READY_TIMEOUT_SEC } from '../../shared/services';
import { SECRET_MASK } from '../../shared/machineValues';
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
  /// Watch paths relative to a service's bound checkout. Optional keeps the
  /// supervisor deterministic in tests and usable by non-Electron hosts.
  watchFiles?(
    checkout: string,
    patterns: readonly string[],
    onChange: (relativePath: string) => void,
  ): ServiceFileWatcher;
}

export type SupervisorEvent =
  | { kind: 'status'; serviceId: string; runtime: ServiceRuntime }
  | { kind: 'line'; serviceId: string; line: string }
  /// A marker written into the log where the binding changed, so "this broke
  /// when I switched branches" is visible rather than remembered.
  | { kind: 'rebound'; serviceId: string; from: string; to: string };

/// How many lines of output to keep per service. Enough to cover a startup
/// and the failure after it; the full history goes to `logSink`.
const LOG_LIMIT = 20_000;

/// How long a stop waits for the process to actually exit. The adapter sends
/// SIGKILL after five seconds, so this is that and a margin. Without the wait a
/// restart launched straight away beside a JVM still holding its port, and a
/// port probe then called the NEW process ready on the old one's socket.
const STOP_WAIT_MS = 7_000;
const CHANGE_DEBOUNCE_MS = 500;

export class Supervisor {
  private readonly procs = new Map<string, SpawnedProcess>();
  private readonly runtimes = new Map<string, ServiceRuntime>();
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

  constructor(
    readonly stackId: string,
    private specs: ServiceSpec[],
    private bindings: ServiceBinding[],
    private readonly deps: SupervisorDeps,
  ) {}

  on(listener: (e: SupervisorEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  runtime(serviceId: string): ServiceRuntime {
    return this.runtimes.get(serviceId) ?? { serviceId, status: 'stopped' };
  }

  log(serviceId: string): readonly string[] {
    return this.logs.get(serviceId) ?? [];
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
      if (!kept.has(id)) this.runtimes.delete(id);
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
      // Waiting on something it depends on: nothing to kill yet, but the
      // start has to be called off.
      if (this.runtime(serviceId).waitingOn) this.setStatus(serviceId, { status: 'stopped' });
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
    if (spec) await this.launch(spec, offset);

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
    if (wasRunning) await this.launch(spec, binding.portOffset ?? 0);
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
      if (!spec || spec.pinnedRef) continue;
      await this.rebind(target.serviceId, { ref: target.ref, path: target.path });
      moved.push(target.serviceId);
    }
    return moved;
  }

  // ── internals ────────────────────────────────────────────────────────────

  private async launch(spec: ServiceSpec, offset: number): Promise<void> {
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

    const port = spec.port === undefined ? undefined : portForOffset(spec.port, offset);

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
        lastError: `Missing machine value${missing.length === 1 ? '' : 's'}: ${missing.join(', ')}`,
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
    // File only: the pane already shows the status, but a log read later by an
    // agent needs to know where one run ends and the next begins.
    this.deps.logSink?.write(
      spec.id,
      `── start ${binding.ref} · ${cwd} · ${debug.command.join(' ')} ──`,
    );
    const proc = this.deps.spawn({ command: debug.command, cwd, env: debug.env });
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
      if (this.procs.get(spec.id) !== proc) return;
      this.stopWatcher(spec.id);
      this.procs.delete(spec.id);
      if (spec.task && code === 0) {
        this.setStatus(spec.id, {
          status: 'done',
          exitCode: code,
          pid: undefined,
          ranRef: binding.ref,
          finishedAt: this.deps.probe.now(),
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
      timeoutMs: (spec.readyTimeoutSec ?? DEFAULT_READY_TIMEOUT_SEC) * 1000,
    });

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
  private satisfied(serviceId: string): boolean {
    const runtime = this.runtime(serviceId);
    if (!this.spec(serviceId)?.task) return runtime.status === 'ready';
    return runtime.status === 'done' && runtime.ranRef === this.binding(serviceId)?.ref;
  }

  /// Say so in the output when a task this service waits on ran from a
  /// different branch of the same project. `~/.m2` holds one copy of each
  /// artifact for the whole machine, so this service is about to build
  /// against the task's branch, not its own — legitimate when the task is
  /// pinned to master, and baffling when nobody meant it.
  private noteTaskRefs(spec: ServiceSpec): void {
    const ref = this.binding(spec.id)?.ref;
    if (!ref || !spec.projectId) return;
    for (const depId of spec.deps ?? []) {
      const dep = this.spec(depId);
      const ran = this.runtime(depId).ranRef;
      if (!dep?.task || dep.projectId !== spec.projectId || !ran || ran === ref) continue;
      this.append(spec.id, `── ${dep.name} last ran from ${ran}; this starts from ${ref} ──`);
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
    if (next.status !== 'starting') next.waitingOn = undefined;
    this.runtimes.set(serviceId, next);
    if (patch.status === 'failed' || patch.status === 'stopped' || patch.status === 'done') {
      const detail = [
        patch.exitCode !== undefined && patch.exitCode !== null ? `exit ${patch.exitCode}` : '',
        patch.lastError ?? '',
      ].filter(Boolean).join(' · ');
      this.deps.logSink?.write(serviceId, `── ${patch.status}${detail ? ` · ${detail}` : ''} ──`);
    }
    this.emit({ kind: 'status', serviceId, runtime: next });
  }

  private append(serviceId: string, raw: string): void {
    const line = maskSecrets(raw, this.deps.secretValues?.() ?? []);
    const lines = this.logs.get(serviceId) ?? [];
    lines.push(line);
    if (lines.length > LOG_LIMIT) lines.splice(0, lines.length - LOG_LIMIT);
    this.logs.set(serviceId, lines);
    this.deps.logSink?.write(serviceId, line);
    this.caught.set(serviceId, feedException(this.caught.get(serviceId) ?? emptyExceptionLog(), line, Date.now()));
    this.emit({ kind: 'line', serviceId, line });
  }

  private emit(event: SupervisorEvent): void {
    for (const listener of this.listeners) listener(event);
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
  let out = line;
  for (const secret of [...secrets].sort((a, b) => b.length - a.length)) {
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
