// Building the same engines the app builds, without the app.
//
// This is `registerIpc` (src/main/index.ts:294) with the renderer removed. The
// construction ORDER is copied deliberately and must stay in step with it:
// runner, then runtime, then orchestrator (which drives the runtime and
// listens to it), then the worker engine (which parks through the
// orchestrator), then the single run observer that fans out to both. Getting
// that order wrong does not fail loudly — it produces an orchestrator that
// never pumps its queue.
//
// The one thing that is genuinely different is the emit tee. In the app it
// ends at `mainWindow.webContents.send`; here it ends at stderr, and the
// permission tap sits in the middle, because a run with nobody watching has to
// answer its own tool prompts. See permissions.ts.

import { currentBranch } from '../main/git';
import { healthyBackends } from '../main/health';
import { setHost } from '../main/host';
import { nodeHost } from '../main/hostNode';
import { withWebhookNotify } from '../main/webhookNotify';
import { Store } from '../main/store';
import { RunnerManager } from '../main/runner';
import { FlowRuntimeImpl } from '../main/flows/runtime';
import { OrchestratorImpl } from '../main/flows/orchestrator';
import { WorkerEngine } from '../main/flows/workerEngine';
import { SchedulerEngine } from '../main/flows/scheduler';
import { pickDrafterBackend, resolveProducerModel } from '../shared/flows/drafterBackend';
import type { MainToRendererEvent } from '../shared/types';
import type { PermissionPolicy } from './args';
import { permissionTap, type PermissionDecision } from './permissions';

export interface HeadlessEngines {
  runner: RunnerManager;
  flowRuntime: FlowRuntimeImpl;
  orchestrator: OrchestratorImpl;
  workerEngine: WorkerEngine;
  /// The emit tee, exposed so `buildDaemonEngines` can hand the scheduler the
  /// SAME one every other engine writes to. Building a second tee would give
  /// the scheduler a channel the permission tap never sees.
  emit: (event: MainToRendererEvent) => void;
  dispose: () => void;
}

/// `buildEngines` plus the one engine a one-shot run never needs: the thing
/// that watches the clock. Everything a daemon does beyond `run` is here.
export interface DaemonEngines extends HeadlessEngines {
  scheduler: SchedulerEngine;
}

/// A workspace root is not itself a git repo, but the runtime mints a worktree
/// per member when a run targets one. Testing only `currentBranch` silently
/// downgrades every scheduled workspace run to `cwd` — unattended edits landing
/// straight in the user's checked-out tree, which is exactly what picking a
/// worktree is supposed to prevent. Copied from index.ts:385-391, and shared by
/// the worker engine and the scheduler so the two cannot disagree.
function isGitRepoOrWorkspace(projectPath: string): boolean {
  return (
    currentBranch(projectPath).isRepo ||
    Store.load().workspaces.some((w) => w.rootPath === projectPath)
  );
}

export interface EngineOptions {
  /// Persistent root. Absent means `$OVERCLI_HOME` / `~/.overcli`.
  stateDir?: string;
  policy: PermissionPolicy;
  allowTools: string[];
  /// See `permissionTap`. The CLI sets this when the file it is running is a
  /// worker whose caps do not include external actions.
  denyCodexApprovals?: boolean;
  /// Every event, after the runtime and worker engine have observed it and
  /// after the permission tap has answered anything it needed to.
  onEvent?: (event: MainToRendererEvent) => void;
  onPermission?: (d: PermissionDecision) => void;
  onNotify?: (args: { title: string; body: string }) => void;
}

export function buildEngines(options: EngineOptions): HeadlessEngines {
  setHost(
    nodeHost({
      dataDir: options.stateDir,
      onNotify: options.onNotify,
    }),
  );

  let runner: RunnerManager;
  let flowRuntime: FlowRuntimeImpl;
  let workerEngine: WorkerEngine;

  // Declared before the engines exist because they all take it, and it has to
  // reach them once they do — the same forward reference `flowAwareEmit` makes
  // in index.ts, for the same reason.
  let answerPermissions: (event: MainToRendererEvent) => void = () => {};

  const emit = (event: MainToRendererEvent) => {
    // Order matters. The runtime's own tap auto-denies external actions on a
    // worker run that was never granted them, and it has to see the event
    // BEFORE our policy does — otherwise `--permissions auto-approve` would
    // quietly overrule a worker's caps.
    flowRuntime?.observeEvent(event);
    workerEngine?.observeEvent(event);
    answerPermissions(event);
    options.onEvent?.(event);
  };

  runner = new RunnerManager(emit, () => Store.load().settings);
  answerPermissions = permissionTap({
    policy: options.policy,
    allowTools: options.allowTools,
    responder: runner,
    onDecision: options.onPermission,
    denyCodexApprovals: options.denyCodexApprovals,
  });

  flowRuntime = new FlowRuntimeImpl(
    runner,
    emit,
    () => Store.load().projects,
    () => Store.load().settings,
    () => Store.load().workspaces,
  );

  const orchestrator = new OrchestratorImpl(
    runner,
    flowRuntime,
    emit,
    () => Store.load().projects,
    () => Store.load().settings,
    {
      unattended: options.policy !== 'auto-approve',
      unattendedAllowedTools: options.policy === 'allow-list' ? options.allowTools : [],
    },
  );

  workerEngine = new WorkerEngine({
    parker: orchestrator,
    isGitRepo: isGitRepoOrWorkspace,
    emit,
    // Wrapped here rather than relying on the host: this notify goes to the
    // engine DIRECTLY and never passes through `host().notify`, so without
    // the wrap a headless worker's approval pause reaches nobody. The host's
    // own wrap (hostNode.ts) covers the paths that do go through it; no
    // notification passes through both, so nothing double-posts.
    notify: withWebhookNotify(options.onNotify ?? (() => {})),
    // Copied from index.ts:360. The worker asks its supervisor a question
    // mid-flow; without this the engine declines every escalation, which
    // headless reads as "the worker refused to answer" rather than "nobody
    // wired the model up".
    supervisorTurn: async ({ worker, prompt, cwd }) => {
      const settings = Store.load().settings;
      const healthy = await healthyBackends(settings.backendPaths);
      const backend = pickDrafterBackend({
        preferred: worker.heartbeatBackend ?? settings.preferredBackend,
        isHealthy: (candidate) => healthy.has(candidate),
        isEnabled: (candidate) => settings.disabledBackends[candidate] !== true,
      });
      if (!backend) return { ok: false, error: 'No signed-in model is available to answer the flow.' };
      return runner.oneShot({
        backend,
        model: resolveProducerModel(backend, worker.heartbeatModel, settings.flowModelDefaults),
        prompt,
        cwd,
        permissionMode: 'plan',
        timeoutMs: 180_000,
        idleTimeoutMs: 60_000,
      });
    },
    deliverablesFor: (runId) => {
      const run = flowRuntime.getRun(runId);
      if (!run) return [];
      const seen = new Set<string>();
      const out: Array<{ name: string; body?: string }> = [];
      for (const step of run.flowSnapshot?.steps ?? []) {
        const art = run.artifacts?.[step.output];
        if (!art || seen.has(art.name)) continue;
        seen.add(art.name);
        out.push({ name: art.name, body: art.body });
      }
      return out;
    },
  });

  flowRuntime.setRunObserver((run) => {
    orchestrator.onRunUpdate(run);
  });

  return {
    runner,
    flowRuntime,
    orchestrator,
    workerEngine,
    emit,
    dispose: () => {
      try {
        runner.killAll();
      } catch {
        // Disposal runs on the way out, including from a signal handler. A
        // backend that already died must not turn a clean exit into a crash.
      }
    },
  };
}

/// The engines `overcli serve` runs on: everything `buildEngines` builds, plus
/// a `SchedulerEngine`, plus the two wirings `run` never needed.
///
/// This is the rest of `registerIpc` (src/main/index.ts:383-404, :585-586) —
/// the half that only matters once the process outlives a single run. Kept as a
/// separate function rather than an option on `buildEngines` so that `run`'s
/// behaviour is untouched by construction: a one-shot run must NOT arm a
/// scheduler and start firing unrelated saved schedules underneath itself.
export function buildDaemonEngines(options: EngineOptions): DaemonEngines {
  const engines = buildEngines(options);
  const { flowRuntime, orchestrator, workerEngine, emit } = engines;

  const scheduler = new SchedulerEngine({
    launcher: flowRuntime,
    parker: orchestrator,
    isGitRepo: isGitRepoOrWorkspace,
    emit,
    // Same reasoning as the worker engine's notify above: this goes to the
    // engine directly and never passes through `host().notify`, so without the
    // wrap a scheduled run finishing on a headless box reaches nobody at all.
    notify: withWebhookNotify(options.onNotify ?? (() => {})),
  });

  // One observer slot on the runtime, two consumers — `setRunObserver` REPLACES
  // (runtime.ts:4067, `this.runObserver = cb`), so this deliberately overwrites
  // the orchestrator-only observer `buildEngines` just installed rather than
  // adding to it. The orchestrator pumps its queue on a terminal child run; the
  // scheduler clears its overlap guard and notifies. Each ignores runs it did
  // not launch, so the fan-out is free.
  flowRuntime.setRunObserver((run) => {
    orchestrator.onRunUpdate(run);
    scheduler.onRunUpdate(run);
  });

  // index.ts:585. Missing from `buildEngines`, which is survivable for `run`
  // (a one-shot `workShiftNow` rarely escalates) but not for a daemon: without
  // it a standing worker that asks its supervisor a question mid-shift gets no
  // answer, and the failure reads as "the worker refused" rather than "nobody
  // wired the model up".
  flowRuntime.setWorkerSupervisor((request) => workerEngine.answerFlowQuestion(request));

  return {
    ...engines,
    scheduler,
    // Ordered: stop the clocks before killing the children, so neither engine
    // can arm a fresh timer or launch a run on the way out. Each step is
    // independently guarded — disposal runs from a signal handler, and one
    // engine that is already dead must not strand the other two.
    dispose: () => {
      try {
        scheduler.dispose();
      } catch {
        // already down
      }
      try {
        workerEngine.dispose();
      } catch {
        // already down
      }
      engines.dispose();
    },
  };
}

/// Make sure the project the run works in is in the store, because
/// `FlowRuntimeImpl` resolves flows and workspaces through
/// `() => Store.load().projects`. In the app the user added it years ago; in
/// CI the store is empty and the checkout is whatever the runner handed us.
export function ensureProject(projectPath: string, name?: string): void {
  const store = Store.load();
  if (store.projects.some((p) => p.path === projectPath)) return;
  Store.saveProjects([
    ...store.projects,
    {
      id: `cli-${Buffer.from(projectPath).toString('hex').slice(0, 24)}`,
      name: name ?? projectPath.split('/').filter(Boolean).pop() ?? 'project',
      path: projectPath,
      conversations: [],
    },
  ]);
}
