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
import { Store } from '../main/store';
import { RunnerManager } from '../main/runner';
import { FlowRuntimeImpl } from '../main/flows/runtime';
import { OrchestratorImpl } from '../main/flows/orchestrator';
import { WorkerEngine } from '../main/flows/workerEngine';
import { pickDrafterBackend, resolveProducerModel } from '../shared/flows/drafterBackend';
import type { MainToRendererEvent } from '../shared/types';
import type { PermissionPolicy } from './args';
import { permissionTap, type PermissionDecision } from './permissions';

export interface HeadlessEngines {
  runner: RunnerManager;
  flowRuntime: FlowRuntimeImpl;
  orchestrator: OrchestratorImpl;
  workerEngine: WorkerEngine;
  dispose: () => void;
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

  const isGitRepo = (projectPath: string) =>
    currentBranch(projectPath).isRepo ||
    Store.load().workspaces.some((w) => w.rootPath === projectPath);

  workerEngine = new WorkerEngine({
    parker: orchestrator,
    isGitRepo,
    emit,
    notify: options.onNotify ?? (() => {}),
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
