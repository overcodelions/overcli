// Build the org control plane over the engines — shared by the app and
// `overcli serve`, like the Slack bridge, so both enforce one set of rules.

import type { FlowRuntimeImpl } from '../flows/runtime';
import type { OrchestratorImpl } from '../flows/orchestrator';
import type { WorkerEngine } from '../flows/workerEngine';
import type { RunnerManager } from '../runner';
import type { TeamEngine } from '../flows/teamEngine';
import { runDeliverablesFor } from '../flows/teamWire';
import { listWorkerFiles, readWorkerFileBytes } from '../flows/workerFiles';
import { loadAllFlows, saveFlow } from '../flows/storage';
import { loadRunSummaries } from '../flows/runSummaryLog';
import { importWorkerYaml } from '../flows/workerShare';
import { healthyBackends, resolveBackendPath } from '../health';
import { Store } from '../store';
import { isEverydayProject } from '../../shared/everydayProjects';
import type { Worker } from '../../shared/flows/worker';
import { OrgService, type HealthItem, type OrgServiceDeps, type SetupOffer } from './orgService';
import { draftHire, drafterDepsFor, saveDraftedHire } from './hireDraft';
import { findOverlap } from './hireOverlap';
import { pickPicture } from './pickPicture';
import { oneShotDraftText } from '../flows/drafter';
import { resolveWorkPlace } from './defaultProject';
import { installTool, listTools, loadToolTemplates, rememberToolTemplates, toolTemplatesFile, uninstallTool } from './tools';
import { host } from '../host';
import { readClaudeInit } from '../flows/mcpProbe';
import { readClaudeMcpServers } from '../mcpConfig';
import { callTool, listServerTools } from './mcpDirect';
import type { TriggerService } from './triggers';
import { updateOrgFile, fileAskStore, fileAuditStore, fileHireStore, filePublishedStore, fileRatingStore, fileTeamFileStore, jsonOrgStore, listTokens, loadOrgPolicy } from './orgStores';
import { RepoService, type RepoState } from './repos';
import { projectIdFor, repairProjectIds } from '../projectIds';
import { ensureWorkspaceSymlinkRoot, removeWorkspaceSymlinkRoot } from '../workspace';
import { applyRepoGrants } from './repoGrants';
import type { SecretsService } from './secrets/service';
import type { ConnectionsService } from './connections';
import type { ToolSignIn } from './toolSignIn';
import { parseFlowYaml } from '../../shared/flows/yaml';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export interface OrgEngines {
  runner: RunnerManager;
  flowRuntime: Pick<FlowRuntimeImpl, 'getRun' | 'listRuns' | 'steerRun' | 'resumeRun' | 'abortRun'>;
  orchestrator: Pick<OrchestratorImpl, 'get' | 'rejectItem' | 'list' | 'approveBatch'>;
  workerEngine: WorkerEngine;
  /// A getter: the app builds teams after the plane.
  teams?: () => TeamEngine | null;
  /// Extra health lines from the host (the Slack bridge, chiefly).
  health?: () => HealthItem[];
  /// A getter: triggers are built after the plane they act through.
  triggers?: () => TriggerService | null;
  /// Secrets admins manage from the console. `overcli serve` only.
  secrets?: SecretsService;
  /// People's own connected accounts (their Google Drive). Absent: none.
  connections?: ConnectionsService;
  /// Remote tools signed in once for the org. Absent: tools take pasted tokens only.
  toolSignIn?: ToolSignIn;
  /// What each run is doing, step by step. `overcli serve` only.
  runActivity?: { list(runId: string, after?: number): Array<{ at: number; kind: 'tool' | 'said' | 'error' | 'denied'; text: string }> };
}

/// Which model CLIs are signed in, re-checked every few minutes — a probe
/// spawns each CLI, far too slow to run on every console load.
function backendProbe(): () => HealthItem {
  let last: HealthItem = { name: 'Models', ok: null, detail: 'Checking which models are signed in…' };
  const refresh = () => {
    void healthyBackends(Store.load().settings.backendPaths)
      .then((healthy) => {
        const names = [...healthy];
        last = names.length
          ? { name: 'Models', ok: true, detail: `Signed in: ${names.join(', ')}.` }
          : { name: 'Models', ok: false, detail: 'No model CLI is signed in on this server, so workers cannot run. See deploy/README.md.' };
      })
      .catch(() => {});
  };
  refresh();
  setInterval(refresh, 10 * 60_000).unref?.();
  return () => last;
}

/// Land a worker share file on this roster: its flows into the library, then
/// the worker on probation with no external authority, as any import does.
function importSharedWorker(
  workerEngine: WorkerEngine,
  yaml: string,
  opts: { projectPath?: string; mcpServers: string[]; extra: Partial<Pick<Worker, 'manager' | 'reportsTo' | 'visibility'>> },
): { ok: true; worker: Worker } | { ok: false; error: string } {
  const store = Store.load();
  const library = loadAllFlows({ projectPaths: store.projects.map((p) => p.path) });
  const landed = importWorkerYaml({
    yaml,
    existingFlowIds: library.map((f) => f.id),
    saveFlow: (flow) => saveFlow({ flow, target: 'user' }),
  });
  if (!landed.ok) return landed;
  const w = landed.result.bundle.worker;
  const missing = new Set(landed.result.notes.missingFlowIds);
  const flowIds = w.flowIds.filter((id) => !missing.has(id));
  if (flowIds.length === 0) return { ok: false, error: `${w.name} arrived without any flow it can run.` };
  const place = resolveWorkPlace(store, opts.projectPath);
  if (!place.ok) return place;
  const projectPath = place.path;
  const everyday = store.projects.find((p) => p.path === projectPath)?.everyday;
  return workerEngine.save({
    name: w.name,
    ...(w.description ? { tagline: w.description } : {}),
    jobDescription: w.jobDescription,
    projectPath,
    cadence: w.cadence,
    caps: {
      ...w.caps,
      runIn: 'worktree',
      allowExternalActions: false,
      canDelegate: false,
      fileIntoProject: isEverydayProject({ path: projectPath, everyday }),
    },
    budgetUSDPerMonth: w.budgetUSDPerMonth,
    heartbeatModel: w.heartbeatModel,
    ...(w.heartbeatBackend ? { heartbeatBackend: w.heartbeatBackend } : {}),
    flowIds,
    mcpServers: opts.mcpServers,
    ...(w.autoRender ? { autoRender: w.autoRender } : {}),
    ...opts.extra,
    enabled: true,
  });
}

/// Decline a paused worker run the way the desk does: settle its batch item
/// first, while it is still `paused` — aborting first would mark it failed,
/// and a failed item cannot be rejected, so the journal would never learn the
/// idea was turned down.
export function rejectWorkerRun(
  engines: { flowRuntime: OrgEngines['flowRuntime']; orchestrator: Pick<OrchestratorImpl, 'get' | 'rejectItem'> },
  runId: string,
): { ok: true } | { ok: false; error: string } {
  const { flowRuntime, orchestrator } = engines;
  const run = flowRuntime.getRun(runId);
  const batch = run?.parentOrchestrationId ? orchestrator.get(run.parentOrchestrationId) : null;
  const item = batch?.items.find((i) => i.runId === runId);
  if (batch && item) {
    const rejected = orchestrator.rejectItem({ id: batch.id, candidateId: item.candidate.id });
    if (!rejected.ok) return rejected;
  }
  return flowRuntime.abortRun({ runId });
}

export function createOrgService(
  engines: OrgEngines,
  hooks: Pick<OrgServiceDeps, 'onHireAwaitingApproval' | 'onHireDecided' | 'onAskDone'> = {},
): OrgService {
  const { runner, flowRuntime, workerEngine } = engines;
  const repos = createRepoService();
  applyRepoGrants(repos);
  return new OrgService({
    workers: {
      roster: () => workerEngine.roster(),
      get: (id) => workerEngine.get(id),
      save: (w) => workerEngine.save(w),
      setEnabled: (id, enabled) => workerEngine.setEnabled(id, enabled),
      remove: (id) => workerEngine.remove(id),
      runErrand: (id, text, attachments, conversation, untrusted) => workerEngine.runErrand(id, text, attachments, { ...(conversation ? { conversation } : {}), ...(untrusted ? { untrusted: true } : {}) }),
      journalFor: (id) => workerEngine.journalFor(id),
      remember: (id, text) => workerEngine.remember(id, text),
      forgetNote: (id, entryId) => workerEngine.forgetNote(id, entryId),
      spentThisMonth: () => workerEngine.spendThisMonth(),
      workerNames: () => workerEngine.workerNames(),
    },
    runs: {
      listRuns: () => flowRuntime.listRuns(),
      getRun: (id) => flowRuntime.getRun(id),
      steerRun: (args) => flowRuntime.steerRun(args),
      resumeRun: (args) => flowRuntime.resumeRun(args),
    },
    rejectRun: (runId) => rejectWorkerRun(engines, runId),
    stopRun: (runId) => {
      const run = flowRuntime.getRun(runId);
      const batch = run?.parentOrchestrationId ? engines.orchestrator.get(run.parentOrchestrationId) : null;
      const abort = batch ? (engines.orchestrator as Partial<Pick<OrchestratorImpl, 'abort'>>).abort : undefined;
      return abort ? abort.call(engines.orchestrator, { id: batch!.id }) : flowRuntime.abortRun({ runId });
    },
    report: (sinceMs) => workerEngine.report(sinceMs),
    policy: () => loadOrgPolicy().policy,
    draft: (args) => draftHire({ runner, ...args }),
    overlap: (job, workers) => findOverlap(drafterDepsFor(runner), job, workers),
    pickPicture: (worker, taken) =>
      pickPicture(
        (system, message) =>
          oneShotDraftText(drafterDepsFor(runner), {
            buildSystemPrompt: () => system,
            userMessage: message,
            verb: 'pick a picture',
            timeouts: { timeoutMs: 60_000, idleTimeoutMs: 45_000 },
            permissionMode: 'plan',
          }).then((r) => (r.ok ? r.text : null)),
        worker,
        taken,
      ),
    // A hire through the org may only work where an operator said workers
    // can: never a path from the request, nor one the drafter made up.
    saveHire: (drafted, opts) => {
      const place = resolveWorkPlace(Store.load(), opts.projectPath, drafted.contract.projectPath);
      return place.ok ? saveDraftedHire(workerEngine, drafted, { ...opts, projectPath: place.path }) : place;
    },
    hires: fileHireStore,
    snapshots: () => workerEngine.list().map((s) => ({ worker: s.worker, nextShiftAt: s.nextShiftAt })),
    batches: {
      list: () => engines.orchestrator.list(),
      approve: (id, ids) =>
        engines.orchestrator.approveBatch(ids === 'all' ? { id } : { id, approve: ids.map((candidateId) => ({ candidateId })), keepUnpicked: true }),
      reject: (id, candidateId) => engines.orchestrator.rejectItem({ id, candidateId }),
    },
    runNow: (id) => workerEngine.workShiftNow(id),
    planning: (id) => workerEngine.planning(id),
    setTrust: (id, trust) => workerEngine.setTrust(id, trust),
    note: (id, orchestrationId, text) => {
      const tied = workerEngine.note(id, orchestrationId, text);
      return tied.ok ? tied : workerEngine.remember(id, text);
    },
    runCost: (() => {
      // Summaries are a whole-file read; a console load asks for many runs.
      let cache: { at: number; byId: Map<string, number> } | null = null;
      return (runId: string) => {
        if (!cache || Date.now() - cache.at > 30_000) {
          cache = { at: Date.now(), byId: new Map(loadRunSummaries().map((s) => [s.id, s.costUSD])) };
        }
        return cache.byId.get(runId);
      };
    })(),
    teams: {
      list: () => engines.teams?.()?.list() ?? { teams: [], tasks: [] },
      brief: (teamId, text, attachments, projectPath, opts) =>
        engines.teams?.()?.brief(teamId, text, attachments, projectPath, opts) ?? { ok: false, error: 'Teams are not running.' },
      answer: (taskId, answers) => engines.teams?.()?.answer(taskId, answers) ?? { ok: false, error: 'Teams are not running.' },
      approve: (taskId) => engines.teams?.()?.approve(taskId) ?? { ok: false, error: 'Teams are not running.' },
      revise: (taskId, feedback) => engines.teams?.()?.revise(taskId, feedback) ?? { ok: false, error: 'Teams are not running.' },
      continueTask: (taskId) => engines.teams?.()?.continueTask(taskId) ?? { ok: false, error: 'Teams are not running.' },
      cancel: (taskId) => engines.teams?.()?.cancel(taskId) ?? { ok: false, error: 'Teams are not running.' },
      retryPiece: (taskId, workerId) => engines.teams?.()?.retryPiece(taskId, workerId) ?? { ok: false, error: 'Teams are not running.' },
      accept: (taskId) => engines.teams?.()?.accept(taskId) ?? { ok: false, error: 'Teams are not running.' },
      learn: (teamId, opts) => engines.teams?.()?.learn(teamId, opts) ?? { ok: false, error: 'Teams are not running.' },
      planAsTask: (taskId) => engines.teams?.()?.planAsTask(taskId) ?? { ok: false, error: 'Teams are not running.' },
      setKnowledgeRefresh: (teamId, mode) => engines.teams?.()?.setKnowledgeRefresh(teamId, mode) ?? { ok: false, error: 'Teams are not running.' },
      disband: (teamId, by) => engines.teams?.()?.disband(teamId, by) ?? { ok: false, error: 'Teams are not running.' },
      remove: (teamId) => engines.teams?.()?.remove(teamId) ?? { ok: false, error: 'Teams are not running.' },
      save: (input) => engines.teams?.()?.save(input) ?? { ok: false, error: 'Teams are not running.' },
      pushCode: (taskId, projectPath) => engines.teams?.()?.pushCode(taskId, projectPath) ?? { ok: false, error: 'Teams are not running.' },
      readFile: (taskId, name) => engines.teams?.()?.readFile(taskId, name) ?? { ok: false, error: 'Teams are not running.' },
      draftRoster: (args) => engines.teams?.()?.draftRoster(args) ?? Promise.resolve({ ok: false as const, error: 'Teams are not running.' }),
    },
    published: filePublishedStore,
    runActivity: (runId, after) => engines.runActivity?.list(runId, after) ?? [],
    setupOffers: jsonOrgStore<{ offers: SetupOffer[] }>('setup-offers.json', () => ({ offers: [] })),
    ...(engines.secrets
      ? (() => {
          const secrets = engines.secrets;
          return {
            secrets: {
              store: secrets.store,
              status: (neededBy: (name: string) => string[]) => secrets.status(neededBy),
              set: (name: string, value: string, by: string) => secrets.set(name, value, by),
              remove: (name: string) => secrets.remove(name),
            },
          };
        })()
      : {}),
    repos: {
      list: () => repos.list(),
      connect: (input, by) => repos.connect(input, by),
      disconnect: (name) => repos.disconnect(name),
      canPush: (repo) => repos.canPush(repo),
      tokenFor: (repo) => repos.tokenFor(repo),
      workspaces: () => repos.workspaces(),
      createWorkspace: (input, by) => repos.createWorkspace(input, by),
      updateWorkspace: (id, patch) => repos.updateWorkspace(id, patch),
      removeWorkspace: (id) => repos.removeWorkspace(id),
      changed: () => applyRepoGrants(repos),
    },
    saveFlow: (id, yaml) => {
      const flow = parseFlowYaml({ yaml, id, source: 'user', filePath: '' });
      if (!flow) return { ok: false, error: 'That flow did not parse.' };
      const saved = saveFlow({ flow, target: 'user' });
      return saved.ok ? { ok: true } : saved;
    },
    orchestration: (id) => engines.orchestrator.get(id) ?? null,
    runDeliverables: runDeliverablesFor((id) => engines.flowRuntime.getRun(id)),
    workerFiles: {
      list: (id) => listWorkerFiles(id),
      read: (id, name) => readWorkerFileBytes(id, name, 16 * 1024 * 1024),
    },
    updateOrg: (mutate) => updateOrgFile(mutate),
    readRunFile: (file) => {
      try {
        return fs.readFileSync(file);
      } catch {
        return null;
      }
    },
    importWorker: (yaml, opts) => importSharedWorker(workerEngine, yaml, opts),
    audit: fileAuditStore,
    asks: fileAskStore,
    triggers: engines.triggers,
    serverTools: async (name) => {
      const config = readClaudeMcpServers()[name];
      return config ? listServerTools(config) : { ok: false, error: `${name} isn't installed on this server.` };
    },
    serverToolSchemas: async (name) => {
      const config = readClaudeMcpServers()[name];
      return config ? listServerTools(config, { schemas: true }) : { ok: false, error: `${name} isn't installed on this server.` };
    },
    callServerTool: async (server, tool, args) => {
      const config = readClaudeMcpServers()[server];
      return config ? callTool(config, tool, args) : { ok: false, error: `${server} isn't installed on this server.` };
    },
    teamFiles: fileTeamFileStore,
    ...(engines.connections ? { connections: engines.connections } : {}),
    ...(engines.toolSignIn ? { toolSignIn: engines.toolSignIn } : {}),
    tools: {
      list: (roster, statuses) => listTools(roster, statuses, loadToolTemplates(toolTemplatesFile(host().dataDir()))),
      remember: (templates, onlyNew) => rememberToolTemplates(toolTemplatesFile(host().dataDir()), templates, onlyNew),
      install: installTool,
      uninstall: uninstallTool,
      check: async () => {
        const binary = resolveBackendPath('claude', Store.load().settings.backendPaths.claude);
        const init = binary ? await readClaudeInit(binary) : null;
        return init ? Object.fromEntries(init.servers.map((s) => [s.name, s.status])) : null;
      },
    },
    ratings: fileRatingStore,
    health: (() => {
      const models = backendProbe();
      return () => [...(engines.health?.() ?? []), models()];
    })(),
    people: () =>
      listTokens().map((t) => ({
        id: t.id,
        ...(t.device ? { device: t.device } : {}),
        name: t.name,
        ...(t.slackUserId ? { slackUserId: t.slackUserId } : {}),
        admin: t.admin,
        ...(t.lastUsedAt ? { lastUsedAt: t.lastUsedAt } : {}),
      })),
    ...hooks,
  });
}

/// Connected repos, cloned under the data directory and registered as
/// projects, so a worker can be pointed at one like any other.
function createRepoService(): RepoService {
  const repaired = repairProjectIds(Store.load());
  if (repaired) {
    Store.saveProjects(repaired.projects);
    Store.saveWorkspaces(repaired.workspaces);
  }
  const service = new RepoService({
    store: jsonOrgStore<RepoState>('repos.json', () => ({ repos: [], workspaces: [] })),
    reposDir: path.join(host().dataDir(), 'repos'),
    git: (args, cwd) =>
      new Promise((resolve) => {
        execFile('git', args, { cwd, timeout: 10 * 60_000, maxBuffer: 4 * 1024 * 1024, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } }, (err, stdout, stderr) => {
          resolve(err ? { ok: false, error: (stderr || err.message).trim() } : { ok: true, stdout });
        });
      }),
    registerProject: (projectPath, name) => {
      const store = Store.load();
      if (store.projects.some((p) => p.path === projectPath)) return;
      Store.saveProjects([
        ...store.projects,
        { id: projectIdFor('repo', projectPath), name, path: projectPath, conversations: [] },
      ]);
    },
    env: (name) => process.env[name],
    registerWorkspace: (ws) => {
      const store = Store.load();
      const others = store.workspaces.filter((w) => w.id !== ws.id);
      if ('remove' in ws) {
        removeWorkspaceSymlinkRoot(ws.id);
        Store.saveWorkspaces(others);
        return { ok: true, rootPath: '' };
      }
      const root = ensureWorkspaceSymlinkRoot(ws.id, ws.repos, ws.instructions);
      if (!root.ok) return root;
      const prior = store.workspaces.find((w) => w.id === ws.id);
      Store.saveWorkspaces([
        ...others,
        {
          id: ws.id,
          name: ws.name,
          projectIds: ws.repos.map((r) => store.projects.find((p) => p.path === r.path)?.id).filter((id): id is string => !!id),
          rootPath: root.rootPath,
          conversations: prior?.conversations ?? [],
          createdAt: prior?.createdAt ?? Date.now(),
          ...(ws.instructions ? { instructions: ws.instructions } : {}),
        },
      ]);
      return { ok: true, rootPath: root.rootPath };
    },
  });
  service.rebuildWorkspaces();
  service.refreshHooks();
  return service;
}
