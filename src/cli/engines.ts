import fs from 'node:fs';
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

import { isCodingWorker } from '../shared/flows/worker';
import type { ProcessService } from '../main/org/processes';
import path from 'node:path';
import { RunActivity } from '../main/flows/runActivity';
import { workerFilesDir } from '../main/flows/workerFiles';
import { randomUUID } from 'node:crypto';
import { projectIdFor } from '../main/projectIds';
import { loadAllFlows, saveFlow } from '../main/flows/storage';
import { answerOnlyFlow, teamPieceFlow } from '../shared/flows/team';
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
import { isAdmin } from '../shared/org/policy';
import { slackConversations, type SlackConversations } from '../main/slack/conversations';
import { configuredSlackToken } from '../main/slack/slackSettings';
import type { TeamEngine } from '../main/flows/teamEngine';
import type { SlackCommands } from '../main/slack/slackCommands';
import type { SsoService } from '../main/org/sso';
import type { ConnectionsService } from '../main/org/connections';
import type { TriggerService } from '../main/org/triggers';
import { createTeamEngine, runDeliverablesFor } from '../main/flows/teamWire';
import { draftHire, drafterDepsFor, saveDraftedHire } from '../main/org/hireDraft';
import { bindAllowList, refreshAllowList } from '../main/org/repoGrants';
import { baseAllowList, configureAccess, noteRefusal } from '../main/org/workerAccess';
import type { AccessLevel } from '../shared/org/access';
import { BranchLander, LANDED_ARTIFACT, describe as describeLanded, landedBranches, type Landed } from '../main/org/landBranches';
import { flowRunTitle, type FlowRun } from '../shared/flows/schema';
import { runRepoTests } from './repoTests';
import { credentialGitEnv, type ConnectedRepo } from '../main/org/repos';
import { execFile } from 'node:child_process';
import { setSafeFetch } from '../main/safeFetch';
import { setWebReadsTrusted } from '../main/flows/trustedCommands';
import { loadOrgPolicy, orgDir, fileHandbook, jsonOrgStore } from '../main/org/orgStores';
import { CiWatcher, continueBranchOf, type CiWatch } from '../main/org/ciWatch';
import { openPullRequest } from '../main/org/prOpen';
import { openIm, postMessage } from '../main/slack/slackApi';
import { guardCredentials } from '../main/org/credentialGuard';
import { closeToolGateway, openToolGateway, type ToolGateway } from '../main/org/toolGateway';
import { useRemoteToolVault } from '../main/org/tools';
import { readClaudeMcpServers, writeMcpServer, type McpServerConfig } from '../main/mcpConfig';
import { log } from '../main/diagnostics';
import { serverShapedFlow } from '../main/org/serverFlow';
import { ticketFlowId, ticketFlowYaml, ticketKey, ticketOf, ticketPrompt, trackerOf } from '../main/org/ticketFollowUp';
import { parseFlowYaml } from '../shared/flows/yaml';
import type { SecretsService } from '../main/org/secrets/service';
import { teamHireJobDescription } from '../shared/flows/team';
import type { OrgService } from '../main/org/orgService';
import type { AccessService } from '../main/org/accessService';
import { useOverdbWorkerLookup } from '../main/org/overdbBinding';

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
  /// What people asked in Slack and what came of it, for the console.
  slackConversations: SlackConversations;
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
  /// See `ServeOptions.maxAccess`.
  maxAccess?: AccessLevel;
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
  // the org keeps things (Setup → Records), and a week when it keeps forever.
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
  // A flow written on a desktop with Codex or Gemini still runs here: a step
  // on a backend this machine lacks moves to one it has, at the same tier.
  flowRuntime.backendsAvailable = async () => {
    const settings = Store.load().settings;
    const healthy = await healthyBackends(settings.backendPaths);
    return [...healthy].filter((b) => settings.disabledBackends[b] !== true);
  };

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
        return f ? [{ id: f.id, name: f.name, ...(f.description ? { description: f.description } : {}), steps: f.steps.map((s) => s.id), stepTools: f.steps.map((s) => ({ ...(s.role ? { role: s.role } : {}), ...(s.effect ? { effect: s.effect } : {}), ...(s.tools ? { tools: s.tools } : {}) })) }] : [];
      });
    },
    // A team member's piece runs its flow cut down to the piece, as in the app.
    pieceFlow: (flowId, opts) => {
      const flow = loadAllFlows({ projectPaths: Store.load().projects.map((p) => p.path) }).find((f) => f.id === flowId);
      if (!flow) return { ok: false, error: `flow "${flowId}" not found` };
      const piece = teamPieceFlow(flow, { check: opts?.check, readOnly: opts?.readOnly });
      const saved = saveFlow({ flow: piece, target: 'generated' });
      return saved.ok ? { ok: true, flowId: piece.id } : saved;
    },
    // A question no flow covers: draft a read-only flow to find out, as in the
    // app (index.ts), and launch it.
    generatedFlow: async ({ worker, errand, request, runIn, launch }) => {
      const drafted = await draftFlowFromPrompt(
        {
          description:
            `${request}\n\nThis flow exists to ANSWER a question, so it only reads. Give its ` +
            `steps the tools to read files, search the code and its history, and look ` +
            `things up through the tools it has. No commands, edits, writes, commits or ` +
            `pushes: those are taken away, and a step that tries one waits on a person. ` +
            `The final step must output a written answer.`,
        },
        drafterDepsFor(runner),
      );
      if (!drafted.ok) return drafted;
      // Single-use, so a distinct id per errand: reusing one would have a
      // later errand overwrite the flow an earlier run is still executing.
      // Held to reads by its tools, whatever the draft gave it.
      const flow = answerOnlyFlow({ ...drafted.flow, id: `generated-${randomUUID().slice(0, 8)}`, source: 'generated' as const });
      const saved = saveFlow({ flow, target: 'generated' });
      if (!saved.ok) return saved;
      // Parked unless the worker's trust lets it start: on Asks first it waits
      // for its manager like anything else it proposes.
      const parked = await orchestrator.parkDirect({
        title: `[Errand] ${flow.name}`,
        projectPath: worker.projectPath,
        prompt: errand,
        flowId: flow.id,
        runIn,
        maxConcurrent: 1,
        origin: workerOrigin(worker, 'errand', errand),
        note: `Investigate: ${request.replace(/\s+/g, ' ').slice(0, 300)}`,
        autoLaunch: launch,
      });
      if (!parked.ok) return parked;
      return { ok: true, orchestrationId: parked.orchestrationId, flowId: flow.id, queued: parked.queued };
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
  workerEngine.handbook = () => fileHandbook.read();
  flowRuntime.skipsCheckpoints = (id) => workerEngine.get(id)?.caps.skipCheckpoints === true;
  flowRuntime.readsOnlyWorker = (id, projectPath) => {
    const w = workerEngine.get(id);
    return !!w && !isCodingWorker(w) && isGitRepoOrWorkspace(w.projectPath || projectPath);
  };
  flowRuntime.standingGrants = (id, flowId) =>
    (workerEngine.get(id)?.caps.alwaysAllow ?? []).filter((k) => k.startsWith(`${flowId}/`)).map((k) => `step:${k.slice(flowId.length + 1)}`);
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
  // A step that fetches pages needn't stop first unless the rules say ask;
  // on `safe`, each fetch is judged as it happens instead (safeFetch.ts).
  setWebReadsTrusted(() => loadOrgPolicy().policy.webFetch !== 'ask');
  setSafeFetch({ mode: () => loadOrgPolicy().policy.webFetch, ownDomains: () => loadOrgPolicy().policy.ownDomains });
  // Teams fold run and batch events into their tasks, so they hear the same
  // emit every other engine does. Built below, after the engines it drives.
  let teams: TeamEngine | null = null;
  let slackCommands: SlackCommands | null = null;
  const engines = buildEngines({
    ...options,
    // A worker asked a question reads its own tools while it works out the
    // answer; nobody is there to approve a lookup.
    allowToolReads: true,
    // What workers were refused, counted for Setup → Permissions.
    onPermission: (d) => {
      options.onPermission?.(d);
      if (d.approved || d.kind !== 'permission') return;
      const who = workerFor(d.conversationId);
      if (who) noteRefusal({ worker: who, tool: d.toolName, ...(d.detail ? { detail: d.detail } : {}), at: Date.now() });
    },
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
  // The worker behind a conversation: a run's, or its own desk and Slack
  // threads' (where questions are answered).
  function workerFor(conversationId: string): string | undefined {
    const run = flowRuntime.workerForConversation(conversationId as Parameters<typeof flowRuntime.workerForConversation>[0]);
    if (run) return run.workerName;
    return workerEngine.roster().find((w) => w.deskSession?.conversationId === conversationId || Object.values(w.threadSessions ?? {}).some((t) => t.conversationId === conversationId))?.name;
  }

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
  // The allow-list follows the org's access level when one is set
  // (workerAccess.ts), within what the flags allow; repo grants ride on top.
  configureAccess({ managed: options.policy === 'allow-list', allowTools: options.allowTools, ...(options.maxAccess ? { maxAccess: options.maxAccess } : {}), access: () => loadOrgPolicy().policy.workerAccess });
  if (options.policy === 'allow-list') {
    bindAllowList(options.allowTools, baseAllowList);
    setInterval(refreshAllowList, 5_000).unref();
  }
  // Claude's file tools may not read or change credential files
  // (credentialGuard.ts), and with the gateway on, a remote tool's token is
  // in no worker's config (toolGateway.ts). Neither stops a shell command.
  guardCredentials(host().dataDir());
  const toolFile = { read: () => readClaudeMcpServers(), write: (name: string, c: McpServerConfig) => writeMcpServer('claude', name, c) };
  let gateway: ToolGateway | null = null;
  // Whose run the overdb tool is serving, for its query log (overdbBinding.ts).
  useOverdbWorkerLookup((id) => flowRuntime.workerForConversation(id)?.workerName);
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
  const { org, commands, access, sso, triggers, connections, processes, frontDoor } = createOrgControl(
    { runner: engines.runner, flowRuntime, orchestrator, workerEngine, teams: () => teams, runActivity: engines.runActivity, health: () => [updates.health()], version: () => updates.status(), ...(options.secrets ? { secrets: options.secrets } : {}) },
    slack,
  );
  slackCommands = commands;

  // A finished repo or workspace run's change, committed and pushed by the
  // server (landBranches.ts).
  // Git gets the host tokens and nothing else secret; the tests get no secrets at all.
  const gitEnv = credentialGitEnv;
  // A worker's flow on a connected repo or workspace ships through the
  // server: its own push and "did it ship" steps give way to the server's
  // pull-request step, and the server pushes and hands back the links.
  flowRuntime.reshapeFlow = (flow, at) => {
    if (!at.workerId) return flow;
    const list = org.repoList({ name: 'overcli', admin: true });
    if (!list.ok) return flow;
    const places = new Set([...list.repos.map((r: ConnectedRepo) => r.path), ...list.workspaces.map((w: { rootPath: string }) => w.rootPath)]);
    if (!places.has(at.projectPath)) return flow;
    const shaped = serverShapedFlow(flow);
    if (shaped) log('info', 'flows', `"${flow.name}" runs here with the server's push in place of ${flow.steps.length - shaped.steps.length + 1} shipping step(s).`);
    return shaped ?? flow;
  };
  const serverGit = (args: string[], cwd: string) =>
    new Promise<{ ok: true; stdout: string } | { ok: false; error: string }>((resolve) => {
      execFile('git', ['-c', 'core.hooksPath=/dev/null', ...args], { cwd, timeout: 15 * 60_000, maxBuffer: 8 * 1024 * 1024, env: gitEnv() }, (err, stdout, stderr) =>
        resolve(err ? { ok: false, error: `${stderr}${stdout}`.trim() || err.message } : { ok: true, stdout: `${stdout}${stderr}` }),
      );
    });
  const connectedRepos = (): ConnectedRepo[] => {
    const list = org.repoList({ name: 'overcli', admin: true });
    return list.ok ? (list as { repos: ConnectedRepo[] }).repos : [];
  };
  // A follow-up on a change the server already pushed (the same worker, repo
  // and ticket) starts on that change's branch, and its push adds to it
  // (BranchLander.builtOn), so the open pull request gets the new commits.
  // Not once the branch is merged or gone: then it starts fresh.
  orchestrator.continueBranch = async ({ projectPath, workerId, title, prompt }) => {
    const list = org.repoList({ name: 'overcli', admin: true });
    const all = list.ok ? (list as { repos: ConnectedRepo[] }).repos : [];
    const spaces = list.ok ? (list as { workspaces: Array<{ rootPath: string; repos: string[] }> }).workspaces : [];
    // Still there on origin, and not merged yet: worth building on.
    const open = async (repo: ConnectedRepo, branch: string) => {
      await serverGit(['fetch', '--quiet', 'origin', `+refs/heads/${branch}:refs/remotes/origin/${branch}`], repo.path);
      const there = await serverGit(['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${branch}^{commit}`], repo.path);
      if (!there.ok) return false;
      const merged = await serverGit(['merge-base', '--is-ancestor', `refs/remotes/origin/${branch}`, `refs/remotes/origin/${repo.defaultBranch}`], repo.path);
      return !merged.ok;
    };
    // A CI fix names its branch outright (ciWatch.ts). In a workspace each
    // repo starts on it where it has it, and from its default branch where not.
    // Only a branch the watcher asked this worker to fix counts: the marker
    // in any other prompt (a ticket's text, a request) would push the run's
    // work into someone else's pull request.
    const marked = continueBranchOf(prompt);
    const named = marked && ci.fixAskedOn(workerId, marked) ? marked : null;
    const ws = spaces.find((w) => w.rootPath === projectPath);
    if (ws) {
      if (!named) return null;
      for (const r of all.filter((x) => ws.repos.includes(x.name))) if (await open(r, named)) return named;
      return null;
    }
    const repo = all.find((r) => r.path === projectPath);
    if (!repo) return null;
    let branch = named ?? undefined;
    if (!branch) {
      // Otherwise the ticket finds the branch an earlier run pushed for it:
      // the ticket its title names, never one its ask only mentions (a
      // duplicate, the ticket it was cloned from), whose pull request this
      // run's work would land in.
      const ticket = ticketKey(title);
      if (!ticket) return null;
      const earlier = flowRuntime
        .listRuns()
        .find((r) => r.workerId === workerId && r.projectPath === projectPath && !r.workspaceWorktrees?.length && !!r.artifacts?.[LANDED_ARTIFACT] && ticketOf(r) === ticket);
      branch = earlier ? landedBranches(earlier.artifacts![LANDED_ARTIFACT]!.body ?? '')[0] : undefined;
    }
    return branch && (await open(repo, branch)) ? branch : null;
  };
  // What the repo's own CI says about each pushed commit: a red build goes
  // back to the worker to fix on the same branch, a few rounds at most.
  const tellManager = async (workerId: string, text: string): Promise<boolean> => {
    const bot = configuredSlackToken('bot');
    const to = org.managerSlackId(workerId);
    const w = workerEngine.get(workerId);
    if (!bot || !to || !w) return false;
    const im = await openIm(bot, to);
    if (!im.ok) return false;
    const res = await postMessage(bot, { channel: im.data, text, username: w.name, ...(w.avatarUrl ? { iconUrl: w.avatarUrl } : {}) }).then((r) => (!r.ok && r.error === 'missing_scope' ? postMessage(bot, { channel: im.data, text }) : r));
    if (!res.ok) return false;
    // A reply in that DM goes to the worker, with the DM as its context.
    frontDoor.adopt(res.data.channel, res.data.ts, { id: w.id, name: w.name });
    return true;
  };
  const ci = new CiWatcher({
    store: jsonOrgStore<{ watches: CiWatch[] }>('ci-watches.json', () => ({ watches: [] })),
    repo: (name) => connectedRepos().find((r) => r.name === name),
    env: (name) => process.env[name],
    rounds: () => org.ciRounds(),
    followUp: ({ workerId, flowId, title, prompt }) => workerEngine.followUp(workerId, { title, prompt, flowId, kind: 'ci' }),
    tail: (args) => tailRun(args),
    tell: tellManager,
    attach: (runId, name, body) => void flowRuntime.attachArtifact(runId, name, body),
    log: (message) => log('info', 'org.ci', message),
  });
  ci.start();
  const watchCi = async (run: FlowRun, landed: Landed[]) => {
    const w = run.workerId ? workerEngine.get(run.workerId) : undefined;
    if (!w || run.flowId.startsWith('org-ticket-')) return;
    const fixing = !!continueBranchOf(run.userPrompt);
    for (const l of landed) {
      const unchanged = l.skipped === 'no changes';
      if (unchanged ? !fixing : !l.branch || l.skipped || l.error) continue;
      const place = run.workspaceWorktrees?.find((m: { name: string; worktreePath: string }) => m.name === l.repo)?.worktreePath ?? run.worktreePath;
      const head = place ? await serverGit(['rev-parse', 'HEAD'], place) : null;
      if (!head?.ok) continue;
      // A CI fix that changed nothing in a repo: if that repo was the red one, its manager hears.
      if (unchanged) {
        ci.landedNothing(l.repo, head.stdout.trim());
        continue;
      }
      if (!l.branch) continue;
      ci.watch({ runId: run.id, workerId: w.id, workerName: w.name, flowId: run.flowId, title: flowRunTitle(run), repo: l.repo, branch: l.branch, sha: head.stdout.trim() });
    }
  };
  const lander = new BranchLander({
    test: (command, cwd) => runRepoTests(command, cwd),
    git: serverGit,
    repos: connectedRepos,
    attach: (runId, name, body) => void flowRuntime.attachArtifact(runId, name, body),
    log: (message) => options.onNotify?.({ title: 'Push', body: message }),
    branchPrefix: () => Store.load().settings.agentBranchPrefix || 'agent/',
    // The pull request itself, as a draft unless the Repos page says otherwise.
    openPr: async (repo, branch, title, body) => {
      const mode = org.prMode();
      if (mode === 'link') return null;
      const opened = await openPullRequest(repo, { branch, title, body, draft: mode === 'draft' }, { env: (n) => process.env[n] });
      return opened.ok ? { url: opened.url, draft: mode === 'draft', ...(opened.existed ? { existed: true as const } : {}) } : { error: opened.error };
    },
    onNothing: (run, landed) => void watchCi(run, landed).catch((err: unknown) => log('warn', 'org.ci', `Couldn't check the CI fix: ${String(err)}`)),
    // Pushed: the ticket it was for gets the link, from its worker's tracker.
    onLanded: (run, landed) => {
      void watchCi(run, landed).catch((err: unknown) => log('warn', 'org.ci', `Couldn't start watching CI: ${String(err)}`));
      const w = run.workerId ? workerEngine.get(run.workerId) : undefined;
      const ticket = ticketOf(run);
      const server = trackerOf(w?.mcpServers);
      if (!w || !ticket || !server || run.flowId.startsWith('org-ticket-')) return;
      // Only a pull request opened just now is news to the ticket: commits
      // added to one already open (a CI fix, a follow-up) were told when it
      // opened, and telling again is a second comment saying the same.
      if (!landed.some((l) => l.branch && !l.error && !l.skipped && !l.updated && !l.existed)) return;
      const flow = parseFlowYaml({ yaml: ticketFlowYaml(server), id: ticketFlowId(server), source: 'user', filePath: '' });
      const saved = flow ? saveFlow({ flow, target: 'user' }) : { ok: false as const, error: 'the flow did not parse' };
      if (!flow || !saved.ok) return log('warn', 'org.repos', `Couldn't set up the ticket update for ${ticket}: ${saved.ok ? '' : saved.error}`);
      void workerEngine.followUp(w.id, { title: `${ticket}: comment the pull request and move it to review`, prompt: ticketPrompt(run, ticket, landed), flowId: flow.id, kind: 'ticket' }).then((res) => {
        if (!res.ok) log('warn', 'org.repos', `Couldn't start the ticket update for ${ticket}: ${res.error}`);
      });
    },
  });

  // A CI fix carried on in the run that made the change: whoever ran its
  // implementer step, in its own checkout, with its plan and work in front
  // of it. What that turn changes is committed onto the same branch, and CI
  // is watched again on it, as the same run. Refused when its checkout is
  // gone or it has no such step: the watcher starts a fix run instead.
  const tailRun = async ({ runId, prompt, round, repos }: { runId: string; prompt: string; round: number; repos: Array<{ repo: string; branch: string }> }): Promise<{ ok: true } | { ok: false; error: string }> => {
    const run = flowRuntime.getRun(runId);
    const step = run && [...run.flowSnapshot.steps].reverse().find((s) => s.role === 'implementer');
    if (!run || !step) return { ok: false, error: 'that run has no step that changes code' };
    const can = flowRuntime.canChatWithRun(run.id, step.id);
    if (!can.ok) return can;
    const checkout = (repo: string) => run.workspaceWorktrees?.find((m) => m.name === repo)?.worktreePath ?? run.worktreePath;
    const onto: Array<{ repo: string; branch: string; head: string }> = [];
    for (const r of repos) {
      const place = checkout(r.repo);
      const head = place ? await serverGit(['rev-parse', 'HEAD'], place) : null;
      if (!head?.ok) return { ok: false, error: `${r.repo}'s checkout is gone` };
      onto.push({ ...r, head: head.stdout.trim() });
    }
    void (async () => {
      const said = await flowRuntime.chatWithRun({ runId, stepId: step.id, text: prompt, timeoutMs: 45 * 60_000 });
      void flowRuntime.attachArtifact(runId, `ci-fix-${round + 1}.md`, said.ok ? said.reply : `The fix didn't finish: ${said.error}`);
      const landed = await lander.landAgain(run, onto, `${flowRunTitle(run)}: fix CI`);
      const who = run.workerName ?? 'The worker';
      for (const l of landed) {
        const o = onto.find((x) => x.repo === l.repo)!;
        const head = l.branch && !l.error && !l.skipped ? await serverGit(['rev-parse', 'HEAD'], checkout(l.repo)!) : null;
        if (head?.ok && l.branch) {
          ci.watch({ runId, workerId: run.workerId ?? '', workerName: who, flowId: run.flowId, title: flowRunTitle(run), repo: l.repo, branch: l.branch, sha: head.stdout.trim() });
          continue;
        }
        const why = l.skipped && l.skipped !== 'no changes' ? l.skipped : l.error;
        ci.landedNothing(l.repo, o.head, why ? `${who}'s fix wasn't pushed: ${why}` : undefined);
      }
    })().catch((err: unknown) => log('warn', 'org.ci', `The CI fix in run ${runId} stopped: ${String(err)}`));
    return { ok: true };
  };

  // "Push again" on a run whose push was refused, once that's put right.
  org.setRelander(async (runId) => {
    const run = flowRuntime.getRun(runId);
    const places = run ? (run.workspaceWorktrees?.length ? run.workspaceWorktrees.map((m) => m.worktreePath) : run.worktreePath ? [run.worktreePath] : []) : [];
    if (!run || !places.some((p) => fs.existsSync(p))) return null;
    return describeLanded(await lander.land(run));
  });

  flowRuntime.setRunObserver((run) => {
    orchestrator.onRunUpdate(run);
    scheduler.onRunUpdate(run);
    void slack.onRunUpdate(run);
    lander.onRun(run);
  });
  // Runs that finished in the last day without being pushed (a server from
  // before every repo run was pushed here): pushed now, once.
  for (const run of flowRuntime.listRuns()) if (Date.now() - run.createdAt < 86_400_000) lander.onRun(run);

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
    slackConversations: slackConversations({
      log: () => frontDoor.conversations(),
      stats: () => frontDoor.stats(),
      followed: (user) => frontDoor.followedThreads(user),
      unfollow: (channel, threadTs, user) => frontDoor.subscribe(channel, threadTs, user, false),
      botToken: () => configuredSlackToken('bot'),
      admin: (caller) => isAdmin(loadOrgPolicy().policy, caller),
    }),
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
