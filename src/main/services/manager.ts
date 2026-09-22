// One supervisor per workspace, and the things only a process that holds all
// of them can answer.
//
// Several flows run at once on different worktrees, and any of them may want
// the same service. Since every stack lives in this one process, the manager
// is where "who is holding :8080" has an answer — each supervisor is told
// what the OTHERS are holding before it starts anything, so a clash comes
// back as a choice rather than one stack silently taking a port from a flow
// nobody was watching.
//
// It is also the only place that knows about disk and the renderer: the
// supervisor below it is pure orchestration, and the pane above it sees
// events.

import { execFile, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { nodeProbes, spawnService } from './adapter';
import { defaultDebugPort, debugKindFor, ensureGradleDebugInit } from './debug';
import { detectServices, type RepoReader } from './detect';
import {
  factorByModule,
  parseCompose,
  parseIntellijRunConfig,
  parseIntellijWorkspace,
  parseProcfile,
  parseTiltfile,
  parseVsCodeLaunch,
  parseVsCodeTasks,
  withNodeVersion,
  suggestMachineValues,
  applyMachineValues,
  type ImportSet,
  type ImportedService,
} from './importers';
import { resolveOptions, type ResolvedOption } from './options';
import type { PortClaim } from './ports';
import { parseWorktreeList, type WorktreeChoice } from '../../shared/worktrees';
import { parseBranchRefs, type BranchChoice } from '../../shared/refChoices';
import { applyMirror, findLocalConfig, planMirror } from './mirror';
import {
  describeOwners,
  freePort,
  holderKind,
  matchingProcesses,
  portOwners,
  portOwnersFor,
  stopPids,
  type OwnerContext,
} from './portOwners';
import { portInUse, triage } from './triage';
import { buildCommandPrompt, buildExplainPrompt, buildFixPrompt } from './askModel';
import { ensureExcluded } from './projection';
import {
  ensureServiceConfigDir,
  machineValuesFile,
  serviceLogFile,
  loadMachineValues,
  loadStack,
  saveMachineValues,
  saveStack,
} from './store';
import {
  loadSecretCiphertext,
  loadSecretValues,
  saveSecretCiphertext,
  type SecretCipher,
} from './machineSecrets';
import { isSecretName, SECRET_MASK } from '../../shared/machineValues';
import { createLogSink } from './logFile';
import { watchServiceFiles } from './fileWatch';
import type { CaughtException } from '../../shared/exceptions';
import { Supervisor, type SupervisorEvent } from './supervisor';
import { taskPresets } from './taskPresets';
import { normalizeWatchPatterns, startOrder } from './types';
import type {
  MachineEntry,
  MachineValuesView,
  MachineValues,
  ServiceFinding,
  ServiceBinding,
  ServiceOption,
  ServiceProposal,
  ServiceSpec,
  StackConfig,
  StackView,
  TaskRun,
} from './types';
import type { PortHolderKind, ReadinessProbe, RemovedServices, TaskPreset } from '../../shared/services';

export type { StackView };

const execFileAsync = promisify(execFile);

/// How long a scan of a main checkout's ignored files is reused.
const IGNORED_SCAN_TTL_MS = 60_000;

/// How long a checkout's current branch is reused before git is asked again.
/// See `refFor`.
const REF_TTL_MS = 5_000;

/// A machine value's name has to be something `${NAME}` can refer to.
const MACHINE_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

export class ServicesManager {
  /// Main checkout per checkout — see `localConfigScan`.
  private readonly primaries = new Map<string, Promise<string | null>>();
  /// Ignored files per main checkout, with when they were read.
  private readonly ignoredScans = new Map<string, { at: number; files: Promise<string[] | null> }>();
  private readonly supervisors = new Map<string, Supervisor>();
  /// Workspaces already looked at for services that outlived the app.
  private readonly adopted = new Set<string>();
  private readonly stacks = new Map<string, StackConfig>();
  /// The branch and commit each bound checkout was last seen on, with when
  /// they were read.
  private readonly refs = new Map<string, { ref: string; commit: string; at: number }>();

  constructor(
    private readonly dataDir: string,
    private readonly emit: (event: SupervisorEvent & { workspaceId: string }) => void,
    /// Workspace symlink roots, so a service is never launched under one.
    private readonly symlinkRoots: readonly string[] = [],
    /// The keychain secret machine values are encrypted with. Absent means
    /// nothing can be stored as a secret — see `machineSecrets.ts`.
    private readonly cipher?: SecretCipher,
    /// overcli's own checkout when running from source, so its dev server is
    /// never named as something to stop. Absent in a packaged build.
    private readonly appRoot?: string,
  ) {}

  /// What the port-owner lookup needs to tell overcli, a leftover copy of
  /// this service, and anything else apart.
  private ownerContext(workspaceId?: string, serviceId?: string): OwnerContext {
    const binding =
      workspaceId && serviceId
        ? this.stack(workspaceId).bindings.find((b) => b.serviceId === serviceId)
        : undefined;
    return { appRoot: this.appRoot, servicePath: binding?.path };
  }

  /// The stack for a workspace, loading it from disk the first time. Looking
  /// at a workspace with no services must not write anything.
  view(workspaceId: string): StackView {
    const stack = this.refreshRefs(this.stack(workspaceId));
    this.beginAdoption(workspaceId, stack);
    const supervisor = this.supervisors.get(workspaceId);
    return {
      workspaceId,
      services: stack.services,
      // The commit rides along on the view and never into the file — see
      // `ServiceBinding.head`.
      bindings: stack.bindings.map((b) => {
        const head = this.headFor(b.path);
        return head ? { ...b, head } : b;
      }),
      runtimes: stack.services.map((s) => supervisor?.runtime(s.id) ?? { serviceId: s.id, status: 'stopped' }),
    };
  }

  /// Look once per workspace for services still listening from before the app
  /// was reopened — the case `servicesStopOnQuit: false` deliberately creates.
  ///
  /// Fire and forget, and never awaited by `view`: the lookup shells out to
  /// `lsof` and `ps` per service, while `view` runs on every look at the pane.
  /// Each adoption arrives as an ordinary status event, so the pane fills in
  /// as the answers come back.
  private beginAdoption(workspaceId: string, stack: StackConfig): void {
    if (this.adopted.has(workspaceId)) return;
    // Nothing with a port is nothing to find, and creating a supervisor for a
    // workspace that has never run anything would be all cost.
    if (!stack.services.some((s) => !s.task && s.port !== undefined)) return;
    this.adopted.add(workspaceId);
    void this.supervisor(workspaceId).adopt();
  }

  /// Read a checkout's branch now, and remember it. Used where the answer
  /// must be current — straight after overcli checked something out — so the
  /// cached copy agrees with what we just did rather than expiring into it.
  private readRef(path: string): string {
    const state = currentCheckout(path);
    this.refs.set(path, { ...state, at: Date.now() });
    return state.ref;
  }

  /// A checkout's branch and commit, from the cache while it is fresh.
  ///
  /// The TTL is what keeps `view` cheap. Every look at the pane, every
  /// service event it refreshes on, and every `@` typed in the composer runs
  /// this, and each folder cost a synchronous `git rev-parse` on the MAIN
  /// process — ten services is ten process spawns with the whole app blocked
  /// behind them, which is exactly the pause before the mention menu draws.
  /// A branch someone changes in a terminal is still picked up; it is just
  /// not re-read more often than a human could change it. The commit comes
  /// out of the same spawn, so knowing it costs nothing on top.
  private checkoutState(path: string): { ref: string; commit: string } {
    const now = Date.now();
    const hit = this.refs.get(path);
    if (hit && now - hit.at < REF_TTL_MS) return hit;
    // A folder a flow deleted mid-session keeps its last known ref: that
    // is still the best description of where the service was.
    const state = fs.existsSync(path) ? currentCheckout(path) : { ref: '', commit: '' };
    this.refs.set(path, { ...state, at: now });
    return state;
  }

  private refFor(path: string): string {
    return this.checkoutState(path).ref;
  }

  /// The commit a checkout is on, for comparing against what a task published
  /// from. Absent outside a repository, where there is nothing to compare.
  private headFor(path: string): string | undefined {
    return this.checkoutState(path).commit || undefined;
  }

  /// Branches move under us: `git checkout master` in a terminal changes what
  /// a checkout is on, and a binding that only learned its ref when overcli
  /// did the checkout keeps saying the old branch forever. Re-read on every
  /// look — once per folder, not once per service, and no more often than
  /// `refFor`'s TTL allows.
  private refreshRefs(stack: StackConfig): StackConfig {
    let changed = false;
    const bindings = stack.bindings.map((b) => {
      const ref = this.refFor(b.path);
      if (!ref || ref === 'HEAD' || ref === b.ref) return b;
      changed = true;
      return { ...b, ref };
    });
    if (!changed) return stack;
    const next = { ...stack, bindings };
    this.write(next);
    return next;
  }

  /// Every workspace that has services, live state included. The pane shows
  /// all of them at once: a stack you left running in another workspace is
  /// still holding ports, and having to go looking for it is how you end up
  /// with two copies of the same service.
  viewAll(workspaceIds: readonly string[]): StackView[] {
    const seen = new Set([...workspaceIds, ...this.stacks.keys(), ...this.supervisors.keys()]);
    return [...seen].map((id) => this.view(id)).filter((v) => v.services.length > 0);
  }

  log(workspaceId: string, serviceId: string): readonly string[] {
    return this.supervisors.get(workspaceId)?.log(serviceId) ?? [];
  }

  exceptions(workspaceId: string, serviceId: string): CaughtException[] {
    return this.supervisors.get(workspaceId)?.exceptions(serviceId) ?? [];
  }

  /// The full output on disk. Clear empties the pane, not this.
  logFile(workspaceId: string, serviceId: string): string {
    return serviceLogFile(this.dataDir, workspaceId, serviceId);
  }

  clearLog(workspaceId: string, serviceId: string): void {
    this.supervisors.get(workspaceId)?.clearLog(serviceId);
  }

  async start(workspaceId: string, serviceId: string, opts: { offset?: number; ignoreHeld?: boolean } = {}) {
    const supervisor = this.supervisor(workspaceId);
    const spec = this.stack(workspaceId).services.find((s) => s.id === serviceId);

    // Something outside overcli may already be on the port — the service
    // started from a terminal an hour ago, or an unrelated program. We cannot
    // see those in our own claims, so ask the port itself. Without this the
    // service spawns, dies with "address already in use", and the pane can
    // only report the corpse.
    const ports = [
      spec?.port,
      spec?.debugEnabled ? spec.debugPort : undefined,
    ].filter((port): port is number => port !== undefined);
    if (opts.offset === undefined && !opts.ignoreHeld) {
      for (const port of ports) {
        const taken = await nodeProbes.tcpOpen(port, '127.0.0.1');
        const ours = [...this.claims(workspaceId), ...this.foreignClaims(workspaceId)].some(
          (c) => c.port === port,
        );
        if (!taken || ours) continue;
        // Name it. "Another program" is true and useless; `node (pid 96355)`
        // is something a person can decide about — and it is very often a
        // service overcli itself started before the app was killed.
        const owners = await portOwners(port, this.ownerContext(workspaceId, serviceId));
        return {
          started: false,
          lease: {
            kind: 'held' as const,
            claim: {
              port,
              serviceId,
              stackId: 'external',
              // Left empty when nothing could be named, so the pane can say
              // "could not tell" rather than offer to stop a stranger.
              holder: owners.length > 0 ? describeOwners(owners) : undefined,
              holderKind: holderKind(owners),
            },
            alongside: { port: port + 10_000, offset: 1 },
          },
        };
      }
    }
    // Project the service's config directory into existence first, so a
    // projection that points at it resolves on a machine where nothing has
    // been put there yet.
    ensureServiceConfigDir(this.dataDir, workspaceId, serviceId);
    await this.excludeProjectedPaths(workspaceId, serviceId);
    return supervisor.start(serviceId, { foreign: this.foreignClaims(workspaceId), offset: opts.offset });
  }

  async stop(workspaceId: string, serviceId: string): Promise<void> {
    await this.supervisors.get(workspaceId)?.stop(serviceId);
  }

  async restart(workspaceId: string, serviceId: string): Promise<void> {
    await this.supervisor(workspaceId).restart(serviceId);
  }

  async rebind(
    workspaceId: string,
    serviceId: string,
    binding: { ref: string; path: string; portOffset?: number },
  ): Promise<void> {
    await this.supervisor(workspaceId).rebind(serviceId, binding);
    this.persistBinding(workspaceId, { ...binding, serviceId });
    await this.excludeProjectedPaths(workspaceId, serviceId);
  }

  /// Move every unpinned service in one go — the bulk case, since several
  /// services usually share one worktree.
  async rebindAll(
    workspaceId: string,
    targets: readonly { serviceId: string; ref: string; path: string }[],
  ): Promise<string[]> {
    const moved = await this.supervisor(workspaceId).rebindAll(targets);
    for (const target of targets) {
      if (moved.includes(target.serviceId)) this.persistBinding(workspaceId, target);
    }
    return moved;
  }

  /// Ports this workspace's own supervisor is holding.
  private claims(workspaceId: string): PortClaim[] {
    return this.supervisors.get(workspaceId)?.claims() ?? [];
  }

  /// What every other stack is holding, in the shape the lease check wants.
  foreignClaims(workspaceId: string): PortClaim[] {
    const out: PortClaim[] = [];
    for (const [id, supervisor] of this.supervisors) {
      if (id === workspaceId) continue;
      out.push(...supervisor.claims());
    }
    return out;
  }

  // ── editing the stack ────────────────────────────────────────────────────

  addService(workspaceId: string, spec: ServiceSpec, binding?: Omit<ServiceBinding, 'serviceId'>): void {
    const stack = this.stack(workspaceId);
    spec = withDebugDefaults(spec, stack.services.filter((s) => s.id !== spec.id));
    const services = [...stack.services.filter((s) => s.id !== spec.id), spec];
    const bindings = binding
      ? [...stack.bindings.filter((b) => b.serviceId !== spec.id), saved({ ...binding, serviceId: spec.id })]
      : stack.bindings;
    this.write({ ...stack, services, bindings });
  }

  removeService(workspaceId: string, serviceId: string): void {
    this.removeServices(workspaceId, [serviceId]);
  }

  /// Take several services out in one write, stopping any that are running.
  /// What was taken comes back, so the pane can offer to put it back instead
  /// of asking "are you sure" first.
  removeServices(workspaceId: string, serviceIds: readonly string[]): RemovedServices {
    const stack = this.stack(workspaceId);
    const gone = new Set(serviceIds);
    const removed: RemovedServices = {
      services: stack.services.flatMap((spec, index) => (gone.has(spec.id) ? [{ spec, index }] : [])),
      bindings: stack.bindings.filter((b) => gone.has(b.serviceId)),
    };
    this.write({
      ...stack,
      services: stack.services.filter((s) => !gone.has(s.id)),
      bindings: stack.bindings.filter((b) => !gone.has(b.serviceId)),
      // Left off entirely when there is nothing to keep, so a stack that has
      // never run a task is written the way it always was.
      ...remaining(stack.lastRuns, gone),
    });
    return removed;
  }

  /// Undo a removal: each service back at its place in the list, bound to the
  /// checkout it had. Stopped — putting something back is not asking to run it.
  restoreServices(workspaceId: string, removed: RemovedServices): void {
    const stack = this.stack(workspaceId);
    const ids = new Set(removed.services.map((r) => r.spec.id));
    const services = stack.services.filter((s) => !ids.has(s.id));
    for (const { spec, index } of [...removed.services].sort((a, b) => a.index - b.index)) {
      services.splice(Math.min(index, services.length), 0, spec);
    }
    this.write({
      ...stack,
      services,
      bindings: [...stack.bindings.filter((b) => !ids.has(b.serviceId)), ...removed.bindings],
    });
  }

  /// Change what kind of thing this is. Free text, because the useful
  /// grouping in one shop ("Processors", "MCP servers") is meaningless in the
  /// next, and a fixed list would be wrong everywhere.
  setGroup(workspaceId: string, serviceId: string, group: string | undefined): void {
    this.patchService(workspaceId, serviceId, (spec) => ({ ...spec, group: group || undefined }));
  }

  /// Replace a service's own startup options.
  setOptions(workspaceId: string, serviceId: string, options: ServiceOption[]): void {
    this.patchService(workspaceId, serviceId, (spec) => ({ ...spec, options }));
  }

  /// Replace what a service runs — for one imported without a command, or one
  /// whose detected command was wrong. Takes effect on the next start.
  setCommand(workspaceId: string, serviceId: string, command: string[]): void {
    this.patchService(workspaceId, serviceId, (spec) => ({ ...spec, command, commandEdited: true }));
  }

  /// Choose who reacts to source edits. `selfReloads` means the child owns
  /// reloads; watch globs mean Overcli restarts it; neither means leave it.
  setWatch(workspaceId: string, serviceId: string, selfReloads: boolean, watch: string[]): void {
    const cleaned = normalizeWatchPatterns(watch);
    this.patchService(workspaceId, serviceId, (spec) => ({
      ...spec,
      selfReloads,
      watch: selfReloads || cleaned.length === 0 ? undefined : cleaned,
    }));
  }

  /// The spec an import is about to save, with the command someone typed kept.
  ///
  /// Commands set before edits were marked still count: one that matches
  /// neither what detection found nor what this import would save can only
  /// have been typed.
  private keepEditedCommand(
    workspaceId: string,
    spec: ServiceSpec,
    from: { stated: boolean; detected?: readonly string[] },
  ): ServiceSpec {
    const existing = this.stack(workspaceId).services.find((s) => s.id === spec.id);
    if (!existing || existing.command.length === 0) return spec;
    const same = (a: readonly string[], b?: readonly string[]) =>
      !!b && a.length === b.length && a.every((arg, i) => arg === b[i]);
    const typed =
      existing.commandEdited ||
      (!from.stated && !same(existing.command, from.detected) && !same(existing.command, spec.command));
    return typed ? { ...spec, command: existing.command, commandEdited: true } : spec;
  }

  /// Change launch mode, restarting a live service immediately. A flag rather
  /// than an option to retype, since it gets toggled several times an hour.
  async setDebug(workspaceId: string, serviceId: string, enabled: boolean, debugPort?: number): Promise<void> {
    const wasLive = ['starting', 'ready', 'unready'].includes(
      this.supervisors.get(workspaceId)?.runtime(serviceId).status ?? 'stopped',
    );
    const current = this.stack(workspaceId).services.find((s) => s.id === serviceId);
    let port = debugPort ?? current?.debugPort;
    if (enabled && port !== undefined) {
      const claimed = new Set(
        [...this.claims(workspaceId), ...this.foreignClaims(workspaceId)]
          .filter((c) => c.serviceId !== serviceId)
          .map((c) => c.port),
      );
      while (port < 65_535 && (claimed.has(port) || await nodeProbes.tcpOpen(port, '127.0.0.1'))) port++;
    }
    this.patchService(workspaceId, serviceId, (spec) => ({
      ...spec,
      debugEnabled: enabled,
      debugPort: port ?? spec.debugPort,
    }));
    // Changing launch mode is an action, not a preference that mysteriously
    // takes effect some later time. A stopped service stays stopped.
    if (wasLive) await this.restart(workspaceId, serviceId);
  }

  /// What "up" means for this service, and how long it gets before the pane
  /// calls it slow. Takes effect on the next start.
  setReady(
    workspaceId: string,
    serviceId: string,
    ready: ReadinessProbe,
    readyTimeoutSec?: number,
  ): void {
    this.patchService(workspaceId, serviceId, (spec) => ({ ...spec, ready, readyTimeoutSec }));
  }

  /// Whether this runs once and exits rather than staying up. Takes effect on
  /// the next run.
  setTask(workspaceId: string, serviceId: string, task: boolean): void {
    this.patchService(workspaceId, serviceId, (spec) => ({ ...spec, task: task || undefined }));
  }

  /// What this service waits for before it starts.
  ///
  /// A service that already waits on this one is refused rather than saved:
  /// the start order would quietly break the loop, which from the pane looks
  /// exactly like the edit not having worked.
  setDeps(workspaceId: string, serviceId: string, deps: readonly string[]): void {
    const stack = this.stack(workspaceId);
    const ids = new Set(stack.services.map((s) => s.id));
    const kept = [...new Set(deps)].filter(
      (dep) => ids.has(dep) && dep !== serviceId && !startOrder(stack.services, dep).includes(serviceId),
    );
    this.patchService(workspaceId, serviceId, (spec) => ({
      ...spec,
      deps: kept.length > 0 ? kept : undefined,
    }));
  }

  /// One-off tasks worth offering for the checkout this service is bound to.
  taskPresets(workspaceId: string, serviceId: string): TaskPreset[] {
    const stack = this.stack(workspaceId);
    const spec = stack.services.find((s) => s.id === serviceId);
    const binding = stack.bindings.find((b) => b.serviceId === serviceId);
    if (!spec || !binding) return [];
    return taskPresets(fsRepoReader(binding.path), { name: slug(spec.name), subpath: spec.subpath });
  }

  /// A task in the same checkout as this service, and — usually — waited for
  /// by it. Bound where the service is bound, unpinned, so a rebind of the
  /// pair is one decision rather than two.
  addTask(
    workspaceId: string,
    serviceId: string,
    args: { name: string; command: string[]; subpath?: string; runBefore: boolean },
  ): string | null {
    const stack = this.stack(workspaceId);
    const source = stack.services.find((s) => s.id === serviceId);
    const binding = stack.bindings.find((b) => b.serviceId === serviceId);
    const name = args.name.trim();
    if (!source || !binding || !name || args.command.length === 0) return null;

    const id = uniqueId(
      `${source.projectId ?? source.id}-${slug(name)}`,
      new Set(stack.services.map((s) => s.id)),
    );
    const task: ServiceSpec = {
      id,
      name,
      projectId: source.projectId,
      subpath: args.subpath || undefined,
      runner: 'command',
      command: args.command,
      commandEdited: true,
      ready: { kind: 'none' },
      selfReloads: false,
      task: true,
      group: 'Tasks',
      config: {},
    };
    const services = stack.services.map((s) =>
      args.runBefore && s.id === serviceId ? { ...s, deps: [...new Set([...(s.deps ?? []), id])] } : s,
    );
    this.write({
      ...stack,
      services: [...services, task],
      bindings: [...stack.bindings, { serviceId: id, ref: binding.ref, path: binding.path }],
    });
    return id;
  }

  /// Another service off the same module and checkout, differing only in the
  /// options it states. This is how one Gradle module becomes five processors
  /// that can all run at once.
  ///
  /// A copy of a copy is flattened onto the original base: chains would make
  /// "where did this flag come from" a research task, and nothing here needs
  /// them.
  duplicate(
    workspaceId: string,
    serviceId: string,
    args: { name: string; group?: string; options?: ServiceOption[]; debugPort?: number },
  ): string | null {
    const stack = this.stack(workspaceId);
    const source = stack.services.find((s) => s.id === serviceId);
    if (!source) return null;

    const baseId = source.copyOf ?? source.id;
    const id = uniqueId(
      `${baseId}-${slug(args.name)}`,
      new Set(stack.services.map((s) => s.id)),
    );
    const copy: ServiceSpec = {
      ...source,
      id,
      name: args.name,
      copyOf: baseId,
      group: args.group ?? source.group,
      options: args.options ?? [],
      debugPort: args.debugPort ?? nextDebugPort(stack.services),
      debugEnabled: false,
      // The copy points where the source points until someone moves it.
      pinnedRef: source.pinnedRef,
    };

    const binding = stack.bindings.find((b) => b.serviceId === serviceId);
    this.write({
      ...stack,
      services: [...stack.services, copy],
      bindings: binding ? [...stack.bindings, { ...binding, serviceId: id }] : stack.bindings,
    });
    return id;
  }

  /// What a service will actually start with — the base's options and this
  /// one's own, merged, with machine values filled in. The Overrides tab is
  /// the only place the difference between five nearly identical services is
  /// legible, so it reads from the same function the launcher does.
  resolvedOptions(workspaceId: string, serviceId: string): ResolvedOption[] {
    const stack = this.stack(workspaceId);
    const spec = stack.services.find((s) => s.id === serviceId);
    if (!spec) return [];
    // This goes to the renderer, so secrets resolve to a mask. The names still
    // resolve — a missing one stays `${NAME}` and is still visible as missing.
    const masked = { ...this.allMachineValues() };
    for (const name of Object.keys(loadSecretCiphertext(this.dataDir))) {
      if (name in masked) masked[name] = SECRET_MASK;
    }
    return resolveOptions(stack.services, spec, masked);
  }

  /// Why a service failed to start, as far as anything here can tell.
  ///
  /// Deterministic rules over what overcli already knows — the output, the
  /// environment it handed over, the repo, and the config files sitting next
  /// to the service. No model: these answers are cheap, offline and checkable,
  /// and each carries the evidence that produced it.
  async explainFailure(workspaceId: string, serviceId: string): Promise<ServiceFinding[]> {
    const stack = this.stack(workspaceId);
    const spec = stack.services.find((s) => s.id === serviceId);
    const binding = stack.bindings.find((b) => b.serviceId === serviceId);
    if (!spec) return [];

    const lines = [...this.log(workspaceId, serviceId)];
    // Look up the port the output complained about, not the saved one — they
    // differ exactly when the saved one is wrong.
    const inUse = portInUse(lines);
    const takenPort = inUse ? (inUse.port ?? spec.port) : undefined;
    const machine = this.allMachineValues();
    const options = resolveOptions(stack.services, spec, machine);
    const env = { ...(spec.config.inject ?? {}) };
    const configDir = ensureServiceConfigDir(this.dataDir, workspaceId, serviceId);
    for (const key of Object.keys(env)) {
      env[key] = env[key].replace(/\$\{SERVICE_CONFIG_DIR\}/g, configDir);
    }

    // Read once, asynchronously: both rules below want the main checkout's
    // ignored config, and scanning a large repository takes seconds.
    const local = binding ? await this.localConfigScan(binding.path) : null;
    const missingLocalConfig = binding
      ? local
        ? (await planMirror(local.primary, binding.path, local.files)).map((l) => l.relative)
        : []
      : undefined;
    const owners = takenPort === undefined ? [] : await portOwners(takenPort, this.ownerContext(workspaceId, serviceId));
    return triage({
      lines,
      spec,
      env,
      optionCount: options.length,
      binding: binding ? { ref: binding.ref, path: binding.path } : undefined,
      portOwner: takenPort === undefined || owners.length === 0
        ? undefined
        : { port: takenPort, holder: describeOwners(owners), kind: holderKind(owners) },
      missingLocalConfig,
      findDefinitions: binding ? (key) => findPropertyDefinitions(binding.path, key, local) : undefined,
      importOptions: this.importOptionsFor(spec),
    });
  }

  /// Everything a model would need to answer "why did this not start", and
  /// the folder to answer it in.
  ///
  /// Assembled here because only this process knows what was actually handed
  /// to the process — the resolved options, the substituted environment, the
  /// checkout it ran in — and those differing from what the user believes is
  /// the usual bug. Machine values go in as known secrets so the scrubber can
  /// catch them by value, not just by shape.
  async fixPrompt(workspaceId: string, serviceId: string): Promise<{ prompt: string; cwd: string } | undefined> {
    const stack = this.stack(workspaceId);
    const spec = stack.services.find((s) => s.id === serviceId);
    if (!spec) return undefined;
    const binding = stack.bindings.find((b) => b.serviceId === serviceId);
    const machine = this.allMachineValues();

    const env = { ...(spec.config.inject ?? {}) };
    const configDir = ensureServiceConfigDir(this.dataDir, workspaceId, serviceId);
    for (const key of Object.keys(env)) {
      env[key] = env[key].replace(/\$\{SERVICE_CONFIG_DIR\}/g, configDir);
    }

    return {
      prompt: buildFixPrompt({
        spec,
        lines: this.log(workspaceId, serviceId),
        env,
        options: resolveOptions(stack.services, spec, machine),
        binding: binding ? { ref: binding.ref, path: binding.path } : undefined,
        findings: await this.explainFailure(workspaceId, serviceId),
        secrets: [
          ...Object.values(machine),
          // A credential typed straight into a service's injected env is in no
          // machine value, so nothing else would catch it by value.
          ...Object.entries(env).filter(([k]) => isSecretName(k)).map(([, v]) => v),
        ],
      }),
      cwd: binding?.path ?? this.dataDir,
    };
  }

  /// What a model needs to propose a start command for a service that has
  /// none, and the checkout to read while it works one out.
  commandPrompt(workspaceId: string, serviceId: string): { prompt: string; cwd: string } | undefined {
    const stack = this.stack(workspaceId);
    const spec = stack.services.find((s) => s.id === serviceId);
    if (!spec) return undefined;
    const binding = stack.bindings.find((b) => b.serviceId === serviceId);
    return {
      prompt: buildCommandPrompt({
        spec,
        binding: binding ? { ref: binding.ref, path: binding.path } : undefined,
        secrets: Object.values(this.allMachineValues()),
      }),
      cwd: binding?.path ?? this.dataDir,
    };
  }

  /// What a model needs to explain a command someone is reading — the
  /// editor's text, which may not be saved yet.
  explainPrompt(
    workspaceId: string,
    serviceId: string,
    command: string,
  ): { prompt: string; cwd: string } | undefined {
    const stack = this.stack(workspaceId);
    const spec = stack.services.find((s) => s.id === serviceId);
    if (!spec) return undefined;
    const binding = stack.bindings.find((b) => b.serviceId === serviceId);
    return {
      prompt: buildExplainPrompt({
        spec,
        command,
        binding: binding ? { ref: binding.ref, path: binding.path } : undefined,
        secrets: Object.values(this.allMachineValues()),
      }),
      cwd: binding?.path ?? this.dataDir,
    };
  }

  /// The main checkout of the repository `checkout` belongs to, and the local
  /// config it has. Null for the main checkout itself, or outside a repository.
  ///
  /// Both halves shell out to git, and on a large repository both take seconds
  /// — `git ls-files --ignored` measured thirteen. They used to run
  /// synchronously on the main process, once per service per switch, which is
  /// the pinwheel. Now asynchronous, the primary remembered for good (a
  /// worktree's main checkout does not move) and the ignored list for a minute,
  /// shared by every service a switch moves at once.
  private async localConfigScan(
    checkout: string,
    patterns: { include?: readonly string[]; exclude?: readonly string[] } = {},
  ): Promise<{ primary: string; files: string[] } | null> {
    const primary = await this.primaryOf(checkout);
    if (!primary || path.resolve(primary) === path.resolve(checkout)) return null;
    const ignored = await this.ignoredIn(primary);
    return { primary, files: await findLocalConfig(primary, { ...patterns, ignored }) };
  }

  private primaryOf(checkout: string): Promise<string | null> {
    const key = path.resolve(checkout);
    const hit = this.primaries.get(key);
    if (hit) return hit;
    const found = execFileAsync('git', ['worktree', 'list', '--porcelain'], { cwd: checkout, encoding: 'utf8' })
      .then(({ stdout }) => /^worktree (.+)$/m.exec(stdout)?.[1] ?? null)
      .catch(() => null)
      .then((primary) => {
        // Not a repository yet is not a permanent answer.
        if (!primary) this.primaries.delete(key);
        return primary;
      });
    this.primaries.set(key, found);
    return found;
  }

  private ignoredIn(primary: string): Promise<string[] | null> {
    const cached = this.ignoredScans.get(primary);
    if (cached && Date.now() - cached.at < IGNORED_SCAN_TTL_MS) return cached.files;
    const files = execFileAsync(
      'git',
      ['ls-files', '--others', '--ignored', '--exclude-standard', '--directory', '-z'],
      { cwd: primary, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 },
    )
      .then(({ stdout }) => stdout.split('\0').filter(Boolean))
      .catch(() => null);
    this.ignoredScans.set(primary, { at: Date.now(), files });
    return files;
  }

  /// A config file beside the project that carries options this service lacks.
  private importOptionsFor(spec: ServiceSpec): { source: string; count: number } | undefined {
    const binding = this.stacks.get(spec.projectId ?? '')?.bindings;
    void binding;
    const checkout = [...this.stacks.values()]
      .flatMap((s) => s.bindings)
      .find((b) => b.serviceId === spec.id)?.path;
    if (!checkout) return undefined;
    try {
      const sets = discoverImports(checkout);
      let best: { source: string; count: number } | undefined;
      for (const set of sets) {
        for (const service of set.services) {
          // The one describing THIS module is the one worth pointing at.
          const matches =
            service.moduleHint === spec.name ||
            spec.command.some((c) => service.moduleHint && c.includes(service.moduleHint));
          if (!matches || service.options.length === 0) continue;
          if (!best || service.options.length > best.count) {
            best = { source: `the ${set.source} config`, count: service.options.length };
          }
        }
      }
      return best;
    } catch {
      return undefined;
    }
  }

  /// Every checkout of the repository a service is bound to.
  ///
  /// Run here rather than in the renderer: `git worktree` is deliberately
  /// absent from the renderer's git allowlist, so asking from there came back
  /// refused and the pane reported — perfectly politely — that the repo had no
  /// other checkouts. A refusal is not an empty list.
  ///
  /// Asynchronous on purpose. The pane asks for every bound checkout whenever
  /// it reloads, and a synchronous git call holds the whole main process —
  /// every IPC reply, every line of output — until it returns. Fifteen of
  /// those in a row is what made removing a service feel stuck.
  async worktreesFor(checkout: string): Promise<WorktreeChoice[]> {
    try {
      const { stdout } = await execFileAsync('git', ['worktree', 'list', '--porcelain'], {
        cwd: checkout,
        encoding: 'utf8',
      });
      return parseWorktreeList(stdout).map((choice) => {
        if (choice.primary) return choice;
        try {
          const stat = fs.statSync(path.join(choice.path, '.git'));
          // birthtime reads 0 on filesystems that do not record it; mtime is
          // written in the same moment and is the next-best answer.
          return { ...choice, createdAt: stat.birthtimeMs > 0 ? stat.birthtimeMs : stat.mtimeMs };
        } catch {
          // A tree a flow deleted a moment ago. Still listed by git until
          // pruned; it simply has no age to sort by.
          return choice;
        }
      });
    } catch {
      return [];
    }
  }

  /// Everything this service could be pointed at: the checkouts that exist,
  /// and the branches that do not have one yet.
  ///
  /// Both come from the same process for the same reason `worktreesFor` does —
  /// the renderer's git allowlist covers neither, and a refusal there is
  /// indistinguishable from a repository with one branch.
  async refsFor(
    checkout: string,
  ): Promise<{ worktrees: WorktreeChoice[]; branches: BranchChoice[]; defaultBranch?: string }> {
    const worktrees = await this.worktreesFor(checkout);
    let branches: BranchChoice[] = [];
    try {
      branches = parseBranchRefs(
        execFileSync(
          'git',
          [
            'for-each-ref',
            '--sort=-committerdate',
            '--format=%(refname)\t%(committerdate:relative)',
            'refs/heads',
            'refs/remotes',
          ],
          { cwd: checkout, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
        ),
      );
    } catch {
      // Not a repository, or one with no refs yet. The checkouts still stand.
    }
    return { worktrees, branches, defaultBranch: defaultBranch(checkout) };
  }

  /// Check a branch out into the checkout this service is bound to, and follow
  /// it with the binding.
  ///
  /// The heavier half of the picker, and the reason branches are a separate
  /// section from checkouts: this MOVES a working tree that a flow, an editor
  /// or another service may be sitting in. Refused outright on a dirty tree —
  /// discarding someone's uncommitted work to start a service is never a
  /// trade this app gets to make on its own.
  async checkoutRef(
    workspaceId: string,
    serviceId: string,
    ref: string,
  ): Promise<{ ok: true } | { ok: false; reason: string }> {
    const binding = this.stack(workspaceId).bindings.find((b) => b.serviceId === serviceId);
    if (!binding) return { ok: false, reason: 'That service is not bound to a checkout.' };

    let dirty = '';
    try {
      dirty = execFileSync('git', ['status', '--porcelain'], {
        cwd: binding.path,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim();
    } catch {
      return { ok: false, reason: 'That folder is not a git checkout any more.' };
    }
    if (dirty !== '') {
      const count = dirty.split('\n').length;
      return {
        ok: false,
        reason: `${binding.path} has ${count} uncommitted change${count === 1 ? '' : 's'}. Commit or stash them, or run this service from a worktree instead.`,
      };
    }

    try {
      // A remote branch has to become a local one to be checked out at all,
      // and `git checkout origin/x` would otherwise leave a detached head
      // whose ref is a sha nobody can read.
      const local = ref.replace(/^[^/]+\//, '');
      const args = branchExists(binding.path, ref)
        ? ['checkout', ref]
        : ['checkout', '-B', local, '--track', ref];
      execFileSync('git', args, { cwd: binding.path, stdio: 'ignore' });
    } catch {
      return { ok: false, reason: `git could not check out ${ref}.` };
    }

    await this.rebind(workspaceId, serviceId, {
      ref: this.readRef(binding.path),
      path: binding.path,
    });
    return { ok: true };
  }

  /// Stop whatever is listening on a port, and say what was stopped.
  ///
  /// The case this exists for: a service overcli started outlived the app
  /// because it was killed rather than quit, and now nothing can take its port
  /// back without knowing `lsof`. Never automatic — the process there might be
  /// an editor, a database, or work somebody cares about.
  async freePort(port: number): Promise<{ stopped: string[]; refused: string[] }> {
    const result = await freePort(port, { context: this.ownerContext() });
    return {
      stopped: result.stopped.map((o) => `${o.command} (pid ${o.pid})`),
      refused: result.refused.map((o) => `${o.command} (pid ${o.pid})`),
    };
  }

  /// Whether a port is still answering, and who is on it. The pane asks this
  /// again while a "port taken" banner is up, because the thing that held the
  /// port is often on its way out — a banner from a moment ago must not keep
  /// saying so after the port is free.
  async portStatus(
    port: number,
    asking?: { workspaceId: string; serviceId: string },
  ): Promise<{ open: boolean; holder?: string; holderKind?: PortHolderKind }> {
    if (!(await nodeProbes.tcpOpen(port, '127.0.0.1'))) return { open: false };
    const owners = await portOwners(port, this.ownerContext(asking?.workspaceId, asking?.serviceId));
    return {
      open: true,
      holder: owners.length > 0 ? describeOwners(owners) : undefined,
      holderKind: holderKind(owners),
    };
  }

  /// Values shared by every service on this machine, as the pane may see them:
  /// a secret's name and that it is stored, never its value.
  machineValues(): MachineValuesView {
    this.migratePlainSecrets();
    const secret = loadSecretCiphertext(this.dataDir);
    const entries: MachineEntry[] = [
      ...Object.entries(loadMachineValues(this.dataDir))
        .filter(([name]) => !(name in secret))
        .map(([name, value]) => ({ name, secret: false, value })),
      ...Object.keys(secret).map((name) => ({ name, secret: true, stored: true })),
    ];
    entries.sort((a, b) => a.name.localeCompare(b.name));
    return { entries, secureStorage: this.cipher?.available() ?? false, migrationError: this.migrationError, backupPath: this.backupPath };
  }

  /// Replace the machine values. A secret arriving without a value keeps the
  /// one already in the keychain — the pane never had it to send back.
  saveMachineValues(entries: readonly MachineEntry[]): void {
    if (!Array.isArray(entries)) throw new Error('Expected a list of machine values');
    const previous = loadSecretCiphertext(this.dataDir);
    const plain: MachineValues = {};
    const secret: Record<string, string> = {};

    for (const entry of entries) {
      const name = String(entry?.name ?? '').trim();
      if (!MACHINE_NAME_RE.test(name)) continue;
      if (entry.value === undefined) {
        // Nothing typed: keep whatever is stored, in the keychain if it was
        // there. Unmarking a secret without retyping it must not blank it.
        if (previous[name]) secret[name] = previous[name];
        continue;
      }
      if (!entry.secret) {
        plain[name] = String(entry.value);
        continue;
      }
      if (!this.cipher?.available()) {
        throw new Error(
          `This machine has no keychain, so ${name} cannot be stored as a secret. Nothing was saved.`,
        );
      }
      secret[name] = this.cipher.encrypt(String(entry.value));
    }

    // Secrets first: a crash between the two writes then leaves a value in
    // both files, never a password that was in neither.
    saveSecretCiphertext(this.dataDir, secret);
    saveMachineValues(this.dataDir, plain);
    // A supervisor caches the decrypted list; a changed secret must reach the
    // masker on the next line, not the next app start.
    this.secretsChanged();
  }

  deleteMachineBackup(): void {
    const backup = `${machineValuesFile(this.dataDir)}.pre-secrets.bak`;
    // Already gone (removed by hand, or a second click) is the outcome asked for.
    fs.rmSync(backup, { force: true });
    this.backupPath = undefined;
  }

  private secretsChanged(): void {
    for (const supervisor of this.supervisors.values()) supervisor.clearSecretCache();
  }

  /// Machine values these stacks refer to and this machine does not define,
  /// with the services that need each. What the pane walks someone through
  /// right after adding services — a run configuration that says
  /// `${DB_PASSWORD}` has told us a value is needed, never what it is.
  machineValueNeeds(workspaceIds: readonly string[]): { name: string; services: string[] }[] {
    const defined = this.allMachineValues();
    const needs = new Map<string, Set<string>>();
    const note = (text: string | undefined, service: string) => {
      for (const match of (text ?? '').matchAll(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g)) {
        const name = match[1];
        if (name === 'SERVICE_CONFIG_DIR' || name in defined) continue;
        needs.set(name, (needs.get(name) ?? new Set()).add(service));
      }
    };
    for (const workspaceId of workspaceIds) {
      const stack = this.stack(workspaceId);
      for (const spec of stack.services) {
        for (const option of resolveOptions(stack.services, spec, defined)) note(option.value, spec.name);
        for (const value of Object.values(spec.config.inject ?? {})) note(value, spec.name);
      }
    }
    return [...needs.entries()]
      .map(([name, services]) => ({ name, services: [...services].sort() }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  /// Every machine value, secrets decrypted. For launching and for the
  /// scrubber — this must never be handed to the renderer.
  private allMachineValues(): MachineValues {
    this.migratePlainSecrets();
    return { ...loadMachineValues(this.dataDir), ...loadSecretValues(this.dataDir, this.cipher) };
  }

  private migrated = false;
  private migrationError: string | undefined;
  private backupPath: string | undefined;

  /// Move credential-named values out of the plain-text file, once. Values
  /// saved before secrets were encrypted are sitting in `machine.json`; the
  /// user should not have to know that and retype them to get them out.
  /// Paths are left alone — `SSH_KEY_PATH=~/.ssh/id_ed25519` is not a secret.
  /// "A path" means one that exists: an AWS secret key can start with `/`,
  /// and judging by the first character alone left exactly that one in plain
  /// text.
  private migratePlainSecrets(): void {
    if (this.migrated || !this.cipher?.available()) return;
    const plain = loadMachineValues(this.dataDir);
    const isExistingPath = (value: string) => {
      if (!/^(~\/|\/|\.\.?\/)/.test(value)) return false;
      const expanded = value.startsWith('~/') ? path.join(os.homedir(), value.slice(2)) : value;
      return fs.existsSync(expanded);
    };
    const moving = Object.entries(plain).filter(
      ([name, value]) => value !== '' && isSecretName(name) && !isExistingPath(value),
    );
    // Nothing to move is a settled answer, not a retry.
    if (moving.length === 0) {
      this.migrated = true;
      return;
    }
    const secret = loadSecretCiphertext(this.dataDir);
    // One-way and irreversible otherwise: safeStorage ciphertext is bound to
    // this login keychain, so a restored backup or a rollback would have no
    // copy of these values at all. 0600, beside the file it came from.
    try {
      const backup = `${machineValuesFile(this.dataDir)}.pre-secrets.bak`;
      fs.writeFileSync(backup, fs.readFileSync(machineValuesFile(this.dataDir)), { mode: 0o600, flag: 'wx' });
      this.backupPath = backup;
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
        this.backupPath = `${machineValuesFile(this.dataDir)}.pre-secrets.bak`;
      } else {
        this.migrationError = error instanceof Error ? error.message : String(error);
        // No backup, no migration — never delete the only copy.
        this.migrated = true;
        return;
      }
    }
    for (const [name, value] of moving) {
      secret[name] = this.cipher.encrypt(value);
      delete plain[name];
    }
    saveSecretCiphertext(this.dataDir, secret);
    saveMachineValues(this.dataDir, plain);
    this.secretsChanged();
    this.migrated = true;
  }

  /// Pin a service to the ref it is on, or unpin it. This is how "pin the
  /// backends, float the frontend" is set up — one click per service.
  setPinned(workspaceId: string, serviceId: string, pinnedRef: string | undefined): void {
    const stack = this.stack(workspaceId);
    this.write({
      ...stack,
      services: stack.services.map((s) => (s.id === serviceId ? { ...s, pinnedRef } : s)),
    });
  }

  /// Propose services for a set of checkouts. Returns proposals rather than
  /// adding anything: an inference the user has not seen is not a decision
  /// they have made.
  ///
  /// One checkout can yield SEVERAL services — a multi-module build is one
  /// repo holding a dozen modules, of which a handful boot — so each proposal
  /// carries the id it would be added under.
  scan(projects: readonly { id: string; name: string; path: string }[]): {
    projectId: string;
    serviceId: string;
    proposal: ServiceProposal;
  }[] {
    const out: { projectId: string; serviceId: string; proposal: ServiceProposal }[] = [];
    for (const project of projects) {
      for (const proposal of detectServices(fsRepoReader(project.path), project.name)) {
        out.push({
          projectId: project.id,
          serviceId: serviceIdFor(project.id, proposal.spec.name, proposal.spec.subpath),
          proposal,
        });
      }
    }
    return out;
  }

  /// Configuration this project already has, in whatever file it lives in.
  ///
  /// Detection guesses how something boots; an import KNOWS, and it carries
  /// the twenty JVM flags someone spent an afternoon getting right. So this is
  /// offered first whenever a project has any of these files.
  findImports(projects: readonly { id: string; name: string; path: string }[]): {
    projectId: string;
    sets: ImportSet[];
  }[] {
    const out: { projectId: string; sets: ImportSet[] }[] = [];
    for (const project of projects) {
      const sets = discoverImports(project.path);
      if (sets.length > 0) out.push({ projectId: project.id, sets });
    }
    return out;
  }

  /// Add a set of imported services.
  ///
  /// Configurations of the same module become ONE base plus a copy each,
  /// carrying only their differences — which is why importing eleven IntelliJ
  /// configs does not produce eleven copies of the same database password. Any
  /// credential in the shared set is lifted into the machine values, where it
  /// lives once.
  importServices(
    workspaceId: string,
    args: {
      projectId: string;
      projectPath: string;
      projectName: string;
      services: ImportedService[];
      /// The other projects in the workspace. A Tiltfile usually lives in a
      /// repo of its own and describes services that live in others.
      siblings?: readonly { id: string; name: string; path: string }[];
    },
  ): {
    added: string[];
    lifted: string[];
    skipped: { name: string; reason: string }[];
    needsCommand: string[];
  } {
    const added: string[] = [];
    const lifted: string[] = [];
    const skipped: { name: string; reason: string }[] = [];
    const needsCommand: string[] = [];
    // Detection supplies the COMMAND for configurations that name a module
    // rather than a command line — IntelliJ and VS Code Java configs both do,
    // and so does every helper-built Tiltfile resource.
    //
    // Looked for in this project first, then in the rest of the workspace:
    // `microservice('content-svc', 'acme-content-svc', 'content-service', …)` is declared in
    // acme-local-dev and lives in acme-content-svc. Detection runs lazily and
    // once per checkout, so a workspace of fifty projects is only walked as far
    // as it needs to be.
    const places = [
      { id: args.projectId, name: args.projectName, path: args.projectPath },
      ...(args.siblings ?? []).filter((sibling) => sibling.path !== args.projectPath),
    ];
    const detectedIn = new Map<string, ServiceProposal[]>();
    const detectIn = (place: (typeof places)[number]) => {
      let found = detectedIn.get(place.path);
      if (!found) {
        found = detectServices(fsRepoReader(place.path), place.name);
        detectedIn.set(place.path, found);
      }
      return found;
    };
    // The project a file names by folder — `serve_dir=SERVICES_DIR + '/legacy-portal'`
    // — which a name like `admin-console` says nothing about.
    const placeNamed = (repo: string | undefined) =>
      repo === undefined
        ? undefined
        : places.find((p) => path.basename(path.resolve(p.path)) === repo || p.name === repo);
    const locate = (module: string, service: ImportedService | undefined) => {
      const home = placeNamed(service?.repoHint);
      // A file that names the repo is believed: a module of the same name in
      // some other project is a different service.
      for (const place of home ? [home] : places) {
        const found = detectIn(place);
        const match =
          found.find((d) => d.spec.name === module || d.spec.command.some((c) => c.includes(module))) ??
          // `frontend('admin-console', 'acme-admin-console', …, subdir='admin-ui')`:
          // the name is Tilt's, but the folder it runs in is what detection saw.
          (home && service?.subpath
            ? found.find((d) => d.spec.subpath === service.subpath)
            : undefined);
        if (match) return { match, place };
      }
      return home ? { match: undefined, place: home } : undefined;
    };

    // Dependencies arrive as names in the file; they become ids once everything
    // in this import has one.
    const idByName = new Map<string, string>();
    const pendingDeps: { id: string; names: string[] }[] = [];

    for (const { module, factored } of factorByModule(args.services)) {
      const first = factored.perService[0]?.service;
      const located = locate(module, first);
      // A task's command is the file's own. Detection matching `publish` in
      // some module's command would put a dev server's readiness on it.
      const match = first?.task ? undefined : located?.match;
      const place = located?.place ?? places[0];
      // A detected `npm run start` knows nothing of the `nvm use v12` the file
      // runs first — and an Angular 11 app under today's Node does not start.
      const detected = match?.spec.command;
      const stated = first?.command !== undefined;
      // A Tiltfile helper's own shell line comes last: detection knows the
      // module, but Apache-served checkouts and the like have nothing to detect.
      const command =
        first?.command ??
        (detected && first?.nodeVersion ? withNodeVersion(detected, first.nodeVersion) : detected) ??
        first?.helperCommand ??
        [];
      // Whose command ended up on the spec, which is also whose directory it
      // has to run in.
      const usingDetected = !stated && detected !== undefined;
      const names = factored.perService.map((entry) => entry.service.name);

      // Nowhere to put it and nothing to run: a service bound to the wrong
      // checkout is worse than none. Say why, and let the rest go ahead.
      if (!located && command.length === 0) {
        const reason = first?.repoHint
          ? `${first.repoHint} is not a project in this workspace`
          : 'nothing says where it lives or how to start it';
        // Both reasons have the same two fixes, said once in the sheet's footer
        // rather than repeated on every skipped name.
        skipped.push(...names.map((name) => ({ name, reason })));
        continue;
      }
      // Known where it lives but not how it starts — a Tiltfile that builds its
      // command out of string concatenation. Added all the same, so the only
      // thing left is typing the command, not recreating the service by hand.
      if (command.length === 0) needsCommand.push(...names);

      const current = this.machineValues();
      // Every option, not only the shared ones: a module with a single
      // configuration shares nothing at all, and a password that differs
      // between two configurations is still a password.
      const secrets = suggestMachineValues([
        ...factored.shared,
        ...factored.perService.flatMap((entry) => entry.own),
      ]);
      const fresh = secrets.filter((secret) => !current.entries.some((e) => e.name === secret.name));
      if (fresh.length > 0) {
        // Lifted because they look like credentials, so they go straight into
        // the keychain. Only a machine without one keeps the old plain file.
        this.saveMachineValues([
          ...current.entries,
          ...fresh.map((s) => ({ name: s.name, secret: current.secureStorage, value: s.value })),
        ]);
        lifted.push(...fresh.map((s) => s.name));
      }

      const shared = applyMachineValues(factored.shared, secrets);
      const single = factored.perService.length === 1;

      // One base per module holding the shared options. With a single
      // configuration there is nothing to share, so it becomes an ordinary
      // service rather than a base with one copy.
      const baseId = serviceIdFor(place.id, module);
      const baseSpec: ServiceSpec = {
        id: baseId,
        name: single ? (first?.name ?? module) : module,
        projectId: place.id,
        runner: match?.spec.runner ?? 'command',
        command,
        // The cwd has to agree with whose command this is. A detected Gradle
        // module runs `./gradlew` from the repo root and so deliberately has
        // no subpath; inheriting the run config's module directory instead
        // spawns the wrapper somewhere it does not exist.
        subpath: usingDetected ? match?.spec.subpath : (first?.subpath ?? match?.spec.subpath),
        port: first?.port ?? match?.spec.port,
        debugKind: match?.spec.debugKind,
        debugPort: first?.debugPort ?? match?.spec.debugPort,
        ready: match?.spec.ready ?? { kind: 'none' },
        selfReloads: match?.spec.selfReloads ?? false,
        group: first?.group ?? match?.spec.group,
        task: first?.task || undefined,
        options: single ? applyMachineValues(factored.perService[0].own, secrets) : shared,
        config: match?.spec.config ?? {},
        importedFrom: first
          ? { source: first.source, project: args.projectName, excerpt: first.excerpt }
          : undefined,
      };
      this.addService(workspaceId, this.keepEditedCommand(workspaceId, baseSpec, { stated, detected }), {
        ref: this.readRef(place.path),
        path: place.path,
      });
      added.push(baseId);

      if (single) {
        if (first) idByName.set(first.name, baseId);
        if (first?.deps) pendingDeps.push({ id: baseId, names: first.deps });
        continue;
      }

      for (const entry of factored.perService) {
        const id = serviceIdFor(place.id, entry.service.name);
        this.addService(
          workspaceId,
          this.keepEditedCommand(
            workspaceId,
            {
              ...baseSpec,
              id,
              name: entry.service.name,
              copyOf: baseId,
              group: entry.service.group ?? baseSpec.group,
              options: applyMachineValues(entry.own, secrets),
              debugPort: entry.service.debugPort,
            },
            { stated, detected },
          ),
          { ref: this.readRef(place.path), path: place.path },
        );
        added.push(id);
        idByName.set(entry.service.name, id);
        if (entry.service.deps) pendingDeps.push({ id, names: entry.service.deps });
      }
    }

    // A name this import did not bring may be a service already in the list.
    // One found nowhere is dropped: ordering on something absent would refuse
    // nothing and explain nothing.
    const existing = this.stack(workspaceId).services;
    for (const { id, names } of pendingDeps) {
      const deps = names
        .map((name) => idByName.get(name) ?? existing.find((s) => s.name === name)?.id)
        .filter((dep): dep is string => !!dep && dep !== id);
      if (deps.length > 0) this.patchService(workspaceId, id, (spec) => ({ ...spec, deps }));
    }

    return { added, lifted, skipped, needsCommand };
  }

  /// Where a service's own config lives — the directory whose contents are
  /// injected or linked into whichever worktree it is bound to.
  configDir(workspaceId: string, serviceId: string): string {
    return ensureServiceConfigDir(this.dataDir, workspaceId, serviceId);
  }

  /// Whether anything at all is running, so a quit can tell the user what it
  /// is about to stop.
  anyRunning(): boolean {
    return [...this.supervisors.values()].some((s) => s.claims().length > 0);
  }

  /// Stop everything, for app shutdown. A service left running after the
  /// window closes is a port held by a process nobody can see.
  async stopAll(): Promise<void> {
    for (const [workspaceId, supervisor] of this.supervisors) {
      for (const spec of this.stack(workspaceId).services) await supervisor.stop(spec.id);
    }
  }

  // ── internals ────────────────────────────────────────────────────────────

  /// One service, changed in place. Every editing operation goes through here
  /// so none of them can forget to persist or to rebuild the supervisor.
  private patchService(
    workspaceId: string,
    serviceId: string,
    change: (spec: ServiceSpec) => ServiceSpec,
  ): void {
    const stack = this.stack(workspaceId);
    this.write({
      ...stack,
      services: stack.services.map((s) => (s.id === serviceId ? change(s) : s)),
    });
  }

  private stack(workspaceId: string): StackConfig {
    const cached = this.stacks.get(workspaceId);
    if (cached) return cached;

    const loaded = loadStack(this.dataDir, workspaceId);
    // Early bindings recorded the literal word HEAD, which tells nobody
    // anything — every chip in the list read the same. Resolve them to the
    // branch each checkout is actually on, once, and keep it.
    const repaired = loaded.bindings.map((b) =>
      b.ref === 'HEAD' ? { ...b, ref: this.readRef(b.path) } : b,
    );
    // And services detected before Gradle's daemon was turned off still start
    // with it on — so the environment they are given never reaches the JVM,
    // and SPRING_PROFILES_ACTIVE is silently ignored. Fix the saved command
    // rather than asking anyone to delete and re-add.
    const services: ServiceSpec[] = [];
    for (const saved of loaded.services) {
      services.push(withDebugDefaults(gradleRunsFromRoot(daemonOff(saved)), services));
    }
    const changed =
      repaired.some((b, i) => b.ref !== loaded.bindings[i].ref) ||
      services.some((s, i) => s !== loaded.services[i]);
    const stack = changed ? { ...loaded, bindings: repaired, services } : loaded;
    if (changed) saveStack(this.dataDir, stack);

    this.stacks.set(workspaceId, stack);
    return stack;
  }

  private write(stack: StackConfig): void {
    this.stacks.set(stack.workspaceId, stack);
    saveStack(this.dataDir, stack);
    // The supervisor holds its own copy of the specs. Hand it the edit rather
    // than replacing it: a fresh supervisor has no record of what the old one
    // started, so everything running would read as stopped while still holding
    // its port, and every other service's output would be gone.
    this.supervisors.get(stack.workspaceId)?.update(stack.services, stack.bindings);
    this.supervisors.get(stack.workspaceId)?.clearSecretCache();
  }

  private persistBinding(workspaceId: string, binding: ServiceBinding): void {
    const stack = this.stack(workspaceId);
    const next = {
      ...stack,
      bindings: [...stack.bindings.filter((b) => b.serviceId !== binding.serviceId), saved(binding)],
    };
    // Deliberately not `write`: replacing the supervisor here would drop the
    // process we just rebound and the log history attached to it.
    this.stacks.set(workspaceId, next);
    saveStack(this.dataDir, next);
  }

  private supervisor(workspaceId: string): Supervisor {
    const existing = this.supervisors.get(workspaceId);
    if (existing) return existing;
    const stack = this.stack(workspaceId);
    const supervisor = new Supervisor(workspaceId, stack.services, stack.bindings, {
      spawn: spawnService,
      probe: nodeProbes,
      symlinkRoots: this.symlinkRoots,
      configDir: (serviceId) => ensureServiceConfigDir(this.dataDir, workspaceId, serviceId),
      gradleDebugInit: ensureGradleDebugInit(this.dataDir),
      // Read per launch, so editing a machine value takes effect on the next
      // start rather than on the next restart of the app.
      machineValues: () => this.allMachineValues(),
      secretValues: () => [
        ...Object.values(loadSecretValues(this.dataDir, this.cipher)),
        ...Object.entries(loadMachineValues(this.dataDir)).filter(([name]) => isSecretName(name)).map(([, value]) => value),
        ...this.stack(workspaceId).services.flatMap((spec) => Object.entries(spec.config.inject ?? {})
          .filter(([name, value]) => isSecretName(name) && !value.includes('${'))
          .map(([, value]) => value)),
      ],
      mirrorLocalConfig: (serviceId, checkout) => this.mirrorLocalConfig(workspaceId, serviceId, checkout),
      headOf: (checkout) => this.headFor(checkout),
      portOwners: (wanted) => {
        const byPort = new Map(wanted.map((w) => [w.port, w.serviceId]));
        return portOwnersFor(wanted.map((w) => w.port), (port) =>
          this.ownerContext(workspaceId, byPort.get(port)));
      },
      matchProcesses: (targets) => {
        const bindings = this.stack(workspaceId).bindings;
        return matchingProcesses(targets.flatMap((t) => {
          const checkout = bindings.find((b) => b.serviceId === t.serviceId)?.path;
          return checkout ? [{ key: t.serviceId, tokens: t.tokens, checkout }] : [];
        }));
      },
      // The tree, not the pid: an adopted Gradle service is wrapper, daemon
      // and app, and the app is the one holding its ports.
      stopProcess: async (pid) => {
        await stopPids([pid], 2_000, { tree: true });
      },
      stopHolder: async (port, serviceId) => {
        await freePort(port, { context: this.ownerContext(workspaceId, serviceId) });
      },
      logSink: createLogSink((serviceId) => serviceLogFile(this.dataDir, workspaceId, serviceId)),
      watchFiles: watchServiceFiles,
    }, stack.lastRuns);
    supervisor.on((event) => {
      this.rememberRun(workspaceId, event);
      this.emit({ ...event, workspaceId });
    });
    this.supervisors.set(workspaceId, supervisor);
    return supervisor;
  }

  /// Keep what a task installed, past the session that installed it.
  ///
  /// Statuses are in memory, so without this every restart forgets which
  /// commit the jar in the local repository came from — and a task that reads
  /// `stopped` because the app was reopened is indistinguishable from one
  /// that never ran, while what it installed is still there and still what
  /// everything resolves.
  private rememberRun(workspaceId: string, event: SupervisorEvent): void {
    if (event.kind !== 'status') return;
    const { runtime } = event;
    if (runtime.status !== 'done' || !runtime.ranRef) return;
    const stack = this.stack(workspaceId);
    if (!stack.services.find((s) => s.id === event.serviceId)?.task) return;

    const run: TaskRun = {
      ref: runtime.ranRef,
      commit: runtime.ranCommit,
      at: runtime.finishedAt ?? Date.now(),
    };
    const previous = stack.lastRuns?.[event.serviceId];
    if (previous && previous.ref === run.ref && previous.commit === run.commit && previous.at === run.at) return;

    // Deliberately not `write`: this arrives while the supervisor is emitting,
    // and handing it a rebuilt spec list mid-event is how a running process
    // loses the log attached to it.
    const next = { ...stack, lastRuns: { ...stack.lastRuns, [event.serviceId]: run } };
    this.stacks.set(workspaceId, next);
    saveStack(this.dataDir, next);
  }

  /// Bring the main checkout's local config into the bound worktree.
  ///
  /// A gitignored `application-local.properties` exists in the main checkout
  /// and in no worktree, because a worktree gets tracked files and nothing
  /// else. Running from one then fails on a placeholder that has always
  /// resolved — nothing wrong with the branch, the config simply is not there.
  ///
  /// The supervisor calls this before every launch rather than once: a worktree
  /// made five minutes ago has never been mirrored, and the operation is a
  /// no-op when everything is already in place. Returns what it linked.
  private async mirrorLocalConfig(workspaceId: string, serviceId: string, target: string): Promise<string[]> {
    const spec = this.stack(workspaceId).services.find((s) => s.id === serviceId);
    if (!spec || spec.config.mirrorLocalConfig === false) return [];

    try {
      const local = await this.localConfigScan(target, {
        include: spec.config.mirrorInclude,
        exclude: spec.config.mirrorExclude,
      });
      if (!local) return [];
      return applyMirror(await planMirror(local.primary, target, local.files));
    } catch {
      // A repo we cannot read, a read-only worktree. The service may still
      // start; a failure here is not a reason to refuse.
      return [];
    }
  }

  /// Keep projected files out of `git status` in every worktree of the repo.
  /// Cheap and idempotent, so it runs on every start and rebind rather than
  /// being remembered once and lost when a new worktree appears.
  private async excludeProjectedPaths(workspaceId: string, serviceId: string): Promise<void> {
    const stack = this.stack(workspaceId);
    const spec = stack.services.find((s) => s.id === serviceId);
    const binding = stack.bindings.find((b) => b.serviceId === serviceId);
    if (!spec || !binding) return;
    const relatives = [
      ...Object.keys(spec.config.link ?? {}),
      ...Object.keys(spec.config.render ?? {}),
    ].map((rel) => (spec.subpath ? path.join(spec.subpath, rel) : rel));
    try {
      await ensureExcluded(binding.path, relatives);
    } catch {
      // A worktree that has gone is handled with a real message at start; an
      // exclude write is not worth failing anything over.
    }
  }
}

/// A slug fit for an id segment and a directory name.
function slug(text: string): string {
  return text
    .replace(/[^A-Za-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
}

/// `name`, or `name-2`, `name-3`… until it is free.
function uniqueId(candidate: string, taken: ReadonlySet<string>): string {
  if (!taken.has(candidate)) return candidate;
  for (let n = 2; ; n++) {
    const next = `${candidate}-${n}`;
    if (!taken.has(next)) return next;
  }
}

/// The next free debugger port, so a fifth copy does not silently collide
/// with the fourth on attach.
function nextDebugPort(services: readonly ServiceSpec[]): number {
  const taken = new Set(services.map((s) => s.debugPort).filter((p): p is number => !!p));
  for (let port = 6001; port < 6100; port++) if (!taken.has(port)) return port;
  return 6001;
}

/// Give every supported runner an attach endpoint, keeping an imported or
/// hand-set choice and moving upward when another service already owns it.
function withDebugDefaults(spec: ServiceSpec, others: readonly ServiceSpec[]): ServiceSpec {
  const debugKind = debugKindFor(spec);
  if (!debugKind) return spec;
  const taken = new Set(others.map((s) => s.debugPort).filter((p): p is number => p !== undefined));
  let debugPort = spec.debugPort ?? defaultDebugPort(spec.runner, spec.port);
  if (debugPort === undefined) return spec;
  while (taken.has(debugPort) && debugPort < 65_535) debugPort++;
  if (spec.debugKind === debugKind && spec.debugPort === debugPort) return spec;
  return { ...spec, debugKind, debugPort };
}

/// A stable, path-safe id for a proposed service. The project id alone is not
/// enough once one repo contributes several modules, and the id becomes a
/// directory name for the service's config, so it has to stay a bare slug.
export function serviceIdFor(projectId: string, name: string, subpath?: string): string {
  const slug = [name, subpath]
    .filter(Boolean)
    .join('-')
    .replace(/[^A-Za-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return slug ? `${projectId}-${slug}` : projectId;
}

/// The repository's main checkout, which is the first entry `git worktree
/// list` reports. Where the gitignored local config actually lives.
export function primaryCheckout(checkout: string): string | null {
  try {
    const out = execFileSync('git', ['worktree', 'list', '--porcelain'], {
      cwd: checkout,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const first = /^worktree (.+)$/m.exec(out);
    return first ? first[1] : null;
  } catch {
    return null;
  }
}

/// Where a property key is defined in a checkout, and whether that file is
/// actually here. A grep, bounded the same way the mirror's scan is — the
/// answer is always in a properties file a few levels down.
export function findPropertyDefinitions(
  checkout: string,
  key: string,
  local?: { primary: string; files: readonly string[] } | null,
): { file: string; presentInBinding: boolean }[] {
  const out: { file: string; presentInBinding: boolean }[] = [];
  const pattern = new RegExp(`^\\s*${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*[=:]`, 'm');

  const walk = (relative: string, depth: number): void => {
    if (depth > 6) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(relative ? path.join(checkout, relative) : checkout, {
        withFileTypes: true,
      });
    } catch {
      return;
    }
    for (const entry of entries) {
      const next = relative ? path.join(relative, entry.name) : entry.name;
      if (entry.isDirectory()) {
        if (['.git', 'node_modules', 'build', 'dist', 'out', 'target', '.gradle'].includes(entry.name)) {
          continue;
        }
        walk(next, depth + 1);
        continue;
      }
      if (!/\.(properties|ya?ml)$/.test(entry.name)) continue;
      try {
        const text = fs.readFileSync(path.join(checkout, next), 'utf8');
        if (pattern.test(text)) out.push({ file: next, presentInBinding: true });
      } catch {
        // Unreadable is not a definition.
      }
    }
  };

  walk('', 0);

  // The main checkout may define it in a file this one does not have at all —
  // the gitignored case, which is the interesting one.
  try {
    for (const relative of local?.files ?? []) {
      if (out.some((d) => d.file === relative)) continue;
      const text = fs.readFileSync(path.join(local!.primary, relative), 'utf8');
      if (pattern.test(text)) out.push({ file: relative, presentInBinding: false });
    }
  } catch {
    // No repo, or nothing readable. The rules cope with an empty answer.
  }

  return out;
}

/// A Gradle `bootRun` with the daemon left on. The daemon is started once and
/// reused, with the environment it was started with — so a variable set for
/// THIS launch never reaches the forked JVM. Detection has always added the
/// flag since; this catches what was saved before.
/// A Gradle module runs the wrapper from the repo root, so a saved subpath
/// spawns `./gradlew` in a directory that has no wrapper in it — `spawn
/// ./gradlew ENOENT`, every time. Imports before this inherited the run
/// configuration's module directory; repair the saved spec rather than asking
/// anyone to delete and re-add.
export function gradleRunsFromRoot(spec: ServiceSpec): ServiceSpec {
  if (spec.runner !== 'gradle' || !spec.subpath) return spec;
  // Either shape the wrapper appears in: its own argument, or inside the
  // shell line of a service that builds before it runs. Both resolve it
  // against the cwd.
  if (!spec.command.some((c) => c.includes('./gradlew'))) return spec;
  const { subpath: _subpath, ...rooted } = spec;
  return rooted;
}

export function daemonOff(spec: ServiceSpec): ServiceSpec {
  if (spec.runner !== 'gradle') return spec;
  if (!spec.command.some((c) => /(^|:)bootRun$/.test(c))) return spec;
  if (spec.command.includes('-Dorg.gradle.daemon=false')) return spec;
  return { ...spec, command: [...spec.command, '-Dorg.gradle.daemon=false'] };
}

/// Whether a ref resolves in this checkout. Distinguishes "check that branch
/// out" from "make a local branch tracking that remote one".
function branchExists(checkout: string, ref: string): boolean {
  try {
    execFileSync('git', ['rev-parse', '--verify', '--quiet', `refs/heads/${ref}`], {
      cwd: checkout,
      stdio: 'ignore',
    });
    return true;
  } catch {
    return false;
  }
}

/// The repository's default branch, so `master` does not have to be hunted for
/// among eighty siblings. `origin/HEAD` is the honest answer when a clone set
/// it; otherwise whichever of main/master actually exists.
export function defaultBranch(checkout: string): string | undefined {
  try {
    const head = execFileSync('git', ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'], {
      cwd: checkout,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    if (head) return head.replace(/^[^/]+\//, '');
  } catch {
    // No origin, or a clone that never set it. Fall through to the guess.
  }
  for (const candidate of ['main', 'master']) {
    if (branchExists(checkout, candidate)) return candidate;
  }
  return undefined;
}

/// The branch a checkout is on and the commit it points at, or `HEAD` and no
/// commit when it is detached or not a repo.
///
/// Both in one spawn — `rev-parse` takes several arguments and answers them in
/// order — because this runs per bound checkout on every look at the pane, and
/// on the MAIN process. Synchronous on purpose: the answer is needed before
/// anything renders.
export function currentCheckout(checkout: string): { ref: string; commit: string } {
  try {
    // The commit first: `--abbrev-ref` is a mode that applies to every
    // revision AFTER it, so asking the other way round answers the branch
    // twice and never mentions a sha.
    const [commit = '', branch = ''] = execFileSync(
      'git',
      ['rev-parse', 'HEAD', '--abbrev-ref', 'HEAD'],
      { cwd: checkout, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
    ).trim().split('\n').map((line) => line.trim());
    // Detached: the short sha is more use in a list than the word HEAD.
    const ref = branch && branch !== 'HEAD' ? branch : commit.slice(0, 7) || 'HEAD';
    return { ref, commit };
  } catch {
    return { ref: 'HEAD', commit: '' };
  }
}

/// The branch alone, for the callers that only ever wanted that.
export function currentRef(checkout: string): string {
  return currentCheckout(checkout).ref;
}

/// The task records worth keeping after a removal, and nothing at all when
/// that leaves none.
function remaining(
  lastRuns: Record<string, TaskRun> | undefined,
  gone: ReadonlySet<string>,
): Pick<StackConfig, 'lastRuns'> {
  const kept = Object.entries(lastRuns ?? {}).filter(([id]) => !gone.has(id));
  return kept.length > 0 ? { lastRuns: Object.fromEntries(kept) } : {};
}

/// A binding as it goes to disk. `head` is a fact about this minute, filled
/// in on the view — saving it would rewrite the stack file on every commit and
/// then be stale until the next look.
function saved(binding: ServiceBinding): ServiceBinding {
  if (binding.head === undefined) return binding;
  const copy = { ...binding };
  delete copy.head;
  return copy;
}

/// The configuration files a project already has. Order matters: the ones
/// that carry the most detail are offered first.
export function discoverImports(root: string): ImportSet[] {
  const sets: ImportSet[] = [];
  const home = os.homedir();

  // IntelliJ keeps run configurations in either of two folders depending on
  // its age; both are common in the same organisation.
  for (const dir of ['.idea/runConfigurations', '.run']) {
    const full = path.join(root, dir);
    if (!fs.existsSync(full)) continue;
    const services = fs
      .readdirSync(full)
      .filter((f) => f.endsWith('.xml'))
      .map((f) => {
        try {
          return parseIntellijRunConfig(fs.readFileSync(path.join(full, f), 'utf8'), home);
        } catch {
          return null;
        }
      })
      .filter((s): s is ImportedService => !!s);
    if (services.length > 0) sets.push({ source: 'intellij', file: dir, services });
  }

  // And unless someone ticked "Store as project file", IntelliJ keeps them in
  // workspace.xml — which is where most people's run configurations are.
  const workspaceXml = read(path.join(root, '.idea/workspace.xml'));
  if (workspaceXml) {
    const shared = new Set(sets.flatMap((s) => s.services.map((x) => x.name)));
    const services = parseIntellijWorkspace(workspaceXml, home).filter((s) => !shared.has(s.name));
    if (services.length > 0) sets.push({ source: 'intellij', file: '.idea/workspace.xml', services });
  }

  const launch = read(path.join(root, '.vscode/launch.json'));
  if (launch) {
    const services = parseVsCodeLaunch(launch);
    if (services.length > 0) sets.push({ source: 'vscode', file: '.vscode/launch.json', services });
  }

  const tasks = read(path.join(root, '.vscode/tasks.json'));
  if (tasks) {
    const services = parseVsCodeTasks(tasks);
    if (services.length > 0) sets.push({ source: 'vscode-tasks', file: '.vscode/tasks.json', services });
  }

  const tiltfile = read(path.join(root, 'Tiltfile'));
  if (tiltfile) {
    // The Tiltfile's helpers read JVM args out of scripts beside it. Only files
    // under the Tiltfile's own folder — the path comes from the file, and a
    // `../` in it is not a reason to read anywhere else on the machine.
    const services = parseTiltfile(
      tiltfile,
      (relative) => {
        const full = path.resolve(root, relative);
        return full.startsWith(path.resolve(root) + path.sep) ? read(full) : null;
      },
      { dir: root, env: process.env },
    );
    if (services.length > 0) sets.push({ source: 'tiltfile', file: 'Tiltfile', services });
  }

  for (const file of ['compose.yaml', 'compose.yml', 'docker-compose.yml', 'docker-compose.yaml']) {
    const text = read(path.join(root, file));
    if (!text) continue;
    const set = parseCompose(text, file);
    if (set && set.services.length > 0) sets.push(set);
    break;
  }

  const procfile = read(path.join(root, 'Procfile'));
  if (procfile) {
    const services = parseProcfile(procfile);
    if (services.length > 0) sets.push({ source: 'procfile', file: 'Procfile', services });
  }

  return sets;
}

/// One configuration file the user picked, wherever it lives. Discovery only
/// looks at a project's root, and a Tiltfile in `dev/` or a launch.json from
/// another machine's checkout is still a file that states the options. The
/// reader is chosen by the file's name, the way the tool that owns it does.
export function importFile(file: string): { set: ImportSet } | { error: string } {
  const text = read(file);
  if (text === null) return { error: `Could not read ${file}.` };
  const base = path.basename(file);
  const home = os.homedir();
  const set = (source: ImportSet['source'], services: ImportedService[]) =>
    services.length > 0 ? { set: { source, file, services } } : { error: `Nothing to run in ${base}.` };

  if (base === 'Tiltfile' || base.endsWith('.tiltfile')) {
    const dir = path.dirname(file);
    return set(
      'tiltfile',
      parseTiltfile(
        text,
        (relative) => {
          const full = path.resolve(dir, relative);
          return full.startsWith(path.resolve(dir) + path.sep) ? read(full) : null;
        },
        { dir, env: process.env },
      ),
    );
  }
  if (base === 'launch.json') return set('vscode', parseVsCodeLaunch(text));
  if (base === 'tasks.json') return set('vscode-tasks', parseVsCodeTasks(text));
  if (/^(docker-)?compose(\.[\w-]+)?\.ya?ml$/.test(base)) {
    const parsed = parseCompose(text, file);
    return parsed && parsed.services.length > 0 ? { set: parsed } : { error: `Nothing to run in ${base}.` };
  }
  if (base === 'Procfile' || base.startsWith('Procfile.')) return set('procfile', parseProcfile(text));
  if (base.endsWith('.xml')) {
    if (/<component\s+name="RunManager"/.test(text)) return set('intellij', parseIntellijWorkspace(text, home));
    const one = parseIntellijRunConfig(text, home);
    return set('intellij', one ? [one] : []);
  }
  return {
    error: `${base} is not a file overcli reads — pick a Tiltfile, launch.json, tasks.json, compose file, Procfile or IntelliJ run configuration.`,
  };
}

function read(file: string): string | null {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

/// Read a checkout off disk for detection.
export function fsRepoReader(root: string): RepoReader {
  return {
    exists: (relative) => fs.existsSync(path.join(root, relative)),
    read: (relative) => {
      try {
        return fs.readFileSync(path.join(root, relative), 'utf8');
      } catch {
        return null;
      }
    },
    list: (relative) => {
      try {
        return fs.readdirSync(path.join(root, relative));
      } catch {
        return [];
      }
    },
  };
}
