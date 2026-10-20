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

import type { ProcessService } from '../main/org/processes';
import path from 'node:path';
import { RunActivity } from '../main/flows/runActivity';
import { workerFilesDir } from '../main/flows/workerFiles';
import { randomUUID } from 'node:crypto';
import { projectIdFor } from '../main/projectIds';
import { loadAllFlows, saveFlow } from '../main/flows/storage';
import { teamPieceFlow } from '../shared/flows/team';
import { draftFlowFromPrompt } from '../main/flows/drafter';
import { workerOrigin } from '../shared/flows/worker';
import { currentBranch } from '../main/git';
import { healthyBackends } from '../main/health';
import { UpdateCheck, serverVersion } from '../main/org/updateCheck';
import { effectiveScopes } from '../shared/flows/toolScope';
import { host, setHost, type NotifyArgs } from '../main/host';
import { nodeHost } from '../main/hostNode';
import { withWebhookNotify } from '../main/webhookNotify';
import { Store } from '../main/store';
import { RunnerManager } from '../main/runner';
import { FlowRuntimeImpl } from '../main/flows/runtime';
import { OrchestratorImpl } from '../main/flows/orchestrator';
import { WorkerEngine } from '../main/flows/workerEngine';
import { SchedulerEngine } from '../main/flows/scheduler';
import { pickDrafterBackend, resolveProducerModel } from '../shared/flows/drafterBackend';
import { runHandoffOutputs } from '../shared/flows/worker';
import type { MainToRendererEvent } from '../shared/types';
import type { PermissionPolicy } from './args';
import { permissionTap, type PermissionDecision } from './permissions';
import type { SlackBridge } from '../main/slack/slackBridge';
import { createOrgControl, createSlackBridge } from '../main/slack/wire';
import type { TeamEngine } from '../main/flows/teamEngine';
import type { SlackCommands } from '../main/slack/slackCommands';
import type { SsoService } from '../main/org/sso';
import type { ConnectionsService } from '../main/org/connections';
import type { TriggerService } from '../main/org/triggers';
import { createTeamEngine, runDeliverablesFor } from '../main/flows/teamWire';
import { draftHire, drafterDepsFor, saveDraftedHire } from '../main/org/hireDraft';
import { bindAllowList } from '../main/org/repoGrants';
import { BranchLander } from '../main/org/landBranches';
import { runRepoTests } from './repoTests';
import { credentialGitEnv, type ConnectedRepo } from '../main/org/repos';
import { execFile } from 'node:child_process';
import { setWebReadsTrusted } from '../main/flows/trustedCommands';
import { loadOrgPolicy, orgDir } from '../main/org/orgStores';
import { guardCredentials } from '../main/org/credentialGuard';
import { closeToolGateway, openToolGateway, type ToolGateway } from '../main/org/toolGateway';
import { useRemoteToolVault } from '../main/org/tools';
import { readClaudeMcpServers, writeMcpServer, type McpServerConfig } from '../main/mcpConfig';
import { log } from '../main/diagnostics';
import type { SecretsService } from '../main/org/secrets/service';
import { teamHireJobDescription } from '../shared/flows/team';
import type { OrgService } from '../main/org/orgService';
import type { AccessService } from '../main/org/accessService';

export interface HeadlessEngines {
  runner: RunnerManager;
  flowRuntime: FlowRuntimeImpl;
  orchestrator: OrchestratorImpl;
  workerEngine: WorkerEngine;
  /// What each run is doing, step by step, for the console.
  runActivity: RunActivity;
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
  /// Built but not started: `serve` starts it after taking the state-dir
  /// lock, so a second daemon refused at the lock never opens a Slack socket
  /// that would steal the first one's replies.
  slack: SlackBridge;
  /// Team tasks. Started by `serve` with the other engines.
  teams: TeamEngine;
  /// The org control plane: what `--control` serves and the Slack commands
  /// act through.
  org: OrgService;
  /// Invites, join requests and pairing the overcli app.
  access: AccessService;
  /// The Slack commands and DMs the org layer sends through.
  commands: SlackCommands;
  /// Signing in with the company's identity provider.
  sso: SsoService;
  /// People's own connected accounts (their Google Drive).
  connections: ConnectionsService;
  /// Workers acting on business events. Started by `serve`.
  triggers: TriggerService;
  processes: ProcessService;
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
  /// Let a tool call that only reads through the allow-list (the org server:
  /// see `permissionTap`).
  allowToolReads?: boolean;
  /// Every event, after the runtime and worker engine have observed it and
  /// after the permission tap has answered anything it needed to.
  onEvent?: (event: MainToRendererEvent) => void;
  onPermission?: (d: PermissionDecision) => void;
  onNotify?: (args: NotifyArgs) => void;
  /// Secrets managed from the console (`overcli serve`), loaded before the
  /// engines start so everything reads them from the environment.
  secrets?: SecretsService;
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

  // What each run is doing, step by step, for the console. Kept as long as
  // the org keeps things (Setup → Rules), and a week when it keeps forever.
  const runActivity = new RunActivity(
    (conversationId) => flowRuntime?.listRuns().find((r) => Object.values(r.conversationIds).includes(conversationId))?.id,
    { dir: path.join(host().dataDir(), 'run-activity'), keepDays: () => loadOrgPolicy().policy.retentionDays ?? 7 },
  );
  runActivity.prune();
  const pruneTimer = setInterval(() => runActivity.prune(), 6 * 60 * 60 * 1000);
  pruneTimer.unref?.();

  const emit = (event: MainToRendererEvent) => {
    // Order matters. The runtime's own tap auto-denies external actions on a
    // worker run that was never granted them, and it has to see the event
    // BEFORE our policy does — otherwise `--permissions auto-approve` would
    // quietly overrule a worker's caps.
    flowRuntime?.observeEvent(event);
    workerEngine?.observeEvent(event);
    answerPermissions(event);
    runActivity.observe(event);
    options.onEvent?.(event);
  };

  runner = new RunnerManager(emit, () => Store.load().settings);
  answerPermissions = permissionTap({
    policy: options.policy,
    allowTools: options.allowTools,
    responder: runner,
    onDecision: options.onPermission,
    denyCodexApprovals: options.denyCodexApprovals,
    // A worker looking at its own files with ls and cat, which the allow-list
    // would otherwise refuse.
    readOnlyRoots: (conversationId) => {
      const workerId = flowRuntime?.listRuns().find((r) => Object.values(r.conversationIds).includes(conversationId))?.workerId;
      return workerId ? [workerFilesDir(workerId)] : [];
    },
    ...(options.allowToolReads ? { allowToolReads: true } : {}),
  });

  flowRuntime = new FlowRuntimeImpl(
    runner,
    emit,
    () => Store.load().projects,
    () => Store.load().settings,
    () => Store.load().workspaces,
    // A cost-ceiling abort is the one notification a headless run cannot
    // afford to lose — under `overcli serve` there is nobody at the machine
    // by definition. Wrapped here for the same reason the worker engine's
    // notify below is: this goes to the runtime DIRECTLY and never passes
    // through `host().notify`, so without the wrap it reaches nobody. No
    // notification passes through two wraps, so nothing double-posts.
    withWebhookNotify(options.onNotify ?? (() => {})),
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
    // What the worker already has under way, so a question asked mid-run
    // isn't planned as the same work again.
    // Tools the org gives every worker (Setup → Tools → Who can use it).
    sharedMcpServers: () => loadOrgPolicy().policy.sharedMcpServers ?? [],
    toolDefaults: () => loadOrgPolicy().policy.toolDefaults,
    activeRuns: (workerId) => flowRuntime.listRuns().filter((r) => r.workerId === workerId && (r.state.kind === 'running' || r.state.kind === 'paused')),
    // Copied from index.ts: which flows a worker has, so its planning turn
    // can send each candidate to the one that fits. Without it every item
    // ran through the worker's first flow — a worker given a repo's flow
    // still answered with its research flow.
    flowsFor: (ids) => {
      const byId = new Map(loadAllFlows({ projectPaths: Store.load().projects.map((p) => p.path) }).map((f) => [f.id, f]));
      return ids.flatMap((id) => {
        const f = byId.get(id);
        return f ? [{ id: f.id, name: f.name, ...(f.description ? { description: f.description } : {}) }] : [];
      });
    },
    // A team member's piece runs its flow cut down to the piece, as in the app.
    pieceFlow: (flowId, opts) => {
      const flow = loadAllFlows({ projectPaths: Store.load().projects.map((p) => p.path) }).find((f) => f.id === flowId);
      if (!flow) return { ok: false, error: `flow "${flowId}" not found` };
      const piece = teamPieceFlow(flow, { check: opts?.check });
      const saved = saveFlow({ flow: piece, target: 'generated' });
      return saved.ok ? { ok: true, flowId: piece.id } : saved;
    },
    // A question no flow covers: draft a read-only flow to find out, as in the
    // app (index.ts), and launch it.
    generatedFlow: async ({ worker, errand, request, runIn }) => {
      const drafted = await draftFlowFromPrompt(
        {
          description:
            `${request}\n\nThis flow exists to ANSWER a question, so it must not change ` +
            `anything — but it may do whatever it takes to find the answer. Give its ` +
            `steps the tools to read files, search, query services, and run commands ` +
            `whose only effect is reporting: the test suite, a build, a linter, a ` +
            `type-check. Running a command is fine; changing the project is not — no ` +
            `edits, no writes, no commits, no pushes. The final step must output a ` +
            `written answer.`,
        },
        drafterDepsFor(runner),
      );
      if (!drafted.ok) return drafted;
      const flow = { ...drafted.flow, id: `generated-${randomUUID().slice(0, 8)}`, source: 'generated' as const };
      const saved = saveFlow({ flow, target: 'generated' });
      if (!saved.ok) return saved;
      const launched = await orchestrator.startBatch({
        title: `[Errand] ${errand.split('\n')[0]?.trim().slice(0, 80) || 'Investigation'}`,
        projectPath: worker.projectPath,
        runIn,
        maxConcurrent: 1,
        origin: workerOrigin(worker, 'errand', errand),
        items: [{ candidate: { id: flow.id, title: flow.name, prompt: errand }, flowId: flow.id }],
      });
      if (!launched.ok) return launched;
      return { ok: true, orchestrationId: launched.orchestrationId, flowId: flow.id };
    },
    // The shared reading, as the desktop uses: what each step recorded and
    // the files the run wrote. A copy here filed only the first, so an HTML
    // report a worker rendered never reached its Files and died with the
    // run's scratch folder.
    deliverablesFor: runDeliverablesFor((id) => flowRuntime.getRun(id)),
    runHandoffOutputs: (runId) => {
      const run = flowRuntime.getRun(runId);
      return run ? runHandoffOutputs(run) : [];
    },
  });

  // A worker's tool scopes, enforced on its runs (toolScope.ts).
  flowRuntime.setToolScopes((id) => effectiveScopes(workerEngine.get(id)?.toolScopes, loadOrgPolicy().policy.toolDefaults));
  flowRuntime.setRunObserver((run) => {
    orchestrator.onRunUpdate(run);
  });

  return {
    runner,
    flowRuntime,
    orchestrator,
    workerEngine,
    runActivity,
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
  // Research without asking, unless the org's rules say to ask. Before the
  // engines: restoring runs at startup already decides which steps ask.
  setWebReadsTrusted(() => !loadOrgPolicy().policy.webNeedsApproval);
  // Teams fold run and batch events into their tasks, so they hear the same
  // emit every other engine does. Built below, after the engines it drives.
  let teams: TeamEngine | null = null;
  let slackCommands: SlackCommands | null = null;
  const engines = buildEngines({
    ...options,
    // A worker asked a question reads its own tools while it works out the
    // answer; nobody is there to approve a lookup.
    allowToolReads: true,
    onNotify: (args) => {
      options.onNotify?.(args);
      slackCommands?.onNotice(args);
    },
    onEvent: (event) => {
      options.onEvent?.(event);
      teams?.observeEvent(event);
      slackCommands?.onEvent(event);
    },
  });
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
  // Built before the observer so the fan-out below can reach it. Inert until
  // `serve` calls `start()`.
  // Team tasks run here exactly as on the desktop. A team that needs a new
  // member hires it the way an unattended hire is made: drafted, on demand,
  // on probation, with no connectors.
  teams = createTeamEngine({
    emit,
    notify: withWebhookNotify(options.onNotify ?? (() => {})),
    runner: engines.runner,
    flowRuntime,
    orchestrator,
    workerEngine,
    drafterDeps: () => drafterDepsFor(engines.runner),
    hire: async (req) => {
      const drafted = await draftHire({
        runner: engines.runner,
        crew: workerEngine.workerNames(),
        jobDescription: teamHireJobDescription(req),
        interview: false,
      });
      if (!drafted.ok) return drafted;
      if (drafted.kind !== 'drafted') return { ok: false, error: 'The hire drafter asked a question instead of drafting.' };
      return saveDraftedHire(workerEngine, drafted.drafted, {
        projectPath: req.projectPath,
        extra: { hiredFor: { teamName: req.teamName.trim() || 'New team', ...(req.teamId ? { teamId: req.teamId } : {}) } },
      });
    },
  });

  // Connected repos add their PR commands to this list as they come and go.
  if (options.policy === 'allow-list') bindAllowList(options.allowTools);
  // No process this server spawns may read or change credential files
  // (credentialGuard.ts), and with the gateway on, none holds a remote
  // tool's credentials at all (toolGateway.ts).
  guardCredentials(host().dataDir());
  const toolFile = { read: () => readClaudeMcpServers(), write: (name: string, c: McpServerConfig) => writeMcpServer('claude', name, c) };
  let gateway: ToolGateway | null = null;
  if (process.env.OVERCLI_TOOL_GATEWAY === '1') {
    openToolGateway(
      {
        dir: orgDir,
        callerFor: (id) => flowRuntime.workerForConversation(id),
        onCall: (c) => log(c.allowed ? 'info' : 'warn', 'org.tools', `${c.who} ${c.allowed ? 'called' : 'was refused'} ${c.tool}.${c.call}`),
        log: (message) => log('warn', 'org.tools', message),
      },
      toolFile,
    ).then(
      (opened) => {
        gateway = opened;
        useRemoteToolVault(opened);
      },
      (err) => log('error', 'org.tools', `tool gateway did not start: ${err instanceof Error ? err.message : String(err)}`),
    );
  } else {
    try {
      closeToolGateway(orgDir(), toolFile);
    } catch (err) {
      log('error', 'org.tools', `could not put tools back from the gateway's vault: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  const slack = createSlackBridge({ flowRuntime, orchestrator, workerEngine });
  // The server's version, and whether a newer release is out (Readiness).
  const updates = new UpdateCheck({ current: serverVersion(), enabled: () => process.env.OVERCLI_UPDATE_CHECK !== '0' });
  updates.start();
  const { org, commands, access, sso, triggers, connections, processes } = createOrgControl(
    { runner: engines.runner, flowRuntime, orchestrator, workerEngine, teams: () => teams, runActivity: engines.runActivity, health: () => [updates.health()], ...(options.secrets ? { secrets: options.secrets } : {}) },
    slack,
  );
  slackCommands = commands;

  // A finished repo or workspace run's change, committed and pushed by the
  // server (landBranches.ts).
  // Git gets the host tokens and nothing else secret; the tests get no secrets at all.
  const gitEnv = credentialGitEnv;
  const lander = new BranchLander({
    test: (command, cwd) => runRepoTests(command, cwd),
    git: (args, cwd) =>
      new Promise((resolve) => {
        execFile('git', ['-c', 'core.hooksPath=/dev/null', ...args], { cwd, timeout: 15 * 60_000, maxBuffer: 8 * 1024 * 1024, env: gitEnv() }, (err, stdout, stderr) =>
          resolve(err ? { ok: false, error: `${stderr}${stdout}`.trim() || err.message } : { ok: true, stdout: `${stdout}${stderr}` }),
        );
      }),
    repos: () => org.repoList({ name: 'overcli', admin: true }).ok ? (org.repoList({ name: 'overcli', admin: true }) as { repos: ConnectedRepo[] }).repos : [],
    attach: (runId, name, body) => void flowRuntime.attachArtifact(runId, name, body),
    log: (message) => options.onNotify?.({ title: 'Push', body: message }),
  });

  flowRuntime.setRunObserver((run) => {
    orchestrator.onRunUpdate(run);
    scheduler.onRunUpdate(run);
    void slack.onRunUpdate(run);
    lander.onRun(run);
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
    slack,
    org,
    access,
    commands,
    sso,
    connections,
    triggers,
    processes,
    teams,
    // Ordered: stop the clocks before killing the children, so neither engine
    // can arm a fresh timer or launch a run on the way out. Each step is
    // independently guarded — disposal runs from a signal handler, and one
    // engine that is already dead must not strand the other two.
    dispose: () => {
      try {
        slack.stop();
      } catch {
        // already down
      }
      useRemoteToolVault(null);
      gateway?.stop();
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
      id: projectIdFor('cli', projectPath),
      name: name ?? projectPath.split('/').filter(Boolean).pop() ?? 'project',
      path: projectPath,
      conversations: [],
    },
  ]);
}
