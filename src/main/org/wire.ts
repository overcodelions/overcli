// Build the org control plane over the engines — shared by the app and
// `overcli serve`, like the Slack bridge, so both enforce one set of rules.

import type { FlowRuntimeImpl } from '../flows/runtime';
import type { OrchestratorImpl } from '../flows/orchestrator';
import type { WorkerEngine } from '../flows/workerEngine';
import type { RunnerManager } from '../runner';
import type { TeamEngine } from '../flows/teamEngine';
import { loadAllFlows, saveFlow } from '../flows/storage';
import { loadRunSummaries } from '../flows/runSummaryLog';
import { importWorkerYaml } from '../flows/workerShare';
import { healthyBackends, resolveBackendPath } from '../health';
import { Store } from '../store';
import { isEverydayProject } from '../../shared/everydayProjects';
import type { Worker } from '../../shared/flows/worker';
import { OrgService, type HealthItem, type OrgServiceDeps } from './orgService';
import { draftHire, saveDraftedHire } from './hireDraft';
import { resolveWorkPlace } from './defaultProject';
import { installTool, listTools, loadToolTemplates, rememberToolTemplates, toolTemplatesFile, uninstallTool } from './tools';
import { host } from '../host';
import { readClaudeInit } from '../flows/mcpProbe';
import { readClaudeMcpServers } from '../mcpConfig';
import { listServerTools } from './mcpDirect';
import type { TriggerService } from './triggers';
import { fileAskStore, fileAuditStore, fileHireStore, fileRatingStore, listTokens, loadOrgPolicy } from './orgStores';

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
  return new OrgService({
    workers: {
      roster: () => workerEngine.roster(),
      get: (id) => workerEngine.get(id),
      save: (w) => workerEngine.save(w),
      setEnabled: (id, enabled) => workerEngine.setEnabled(id, enabled),
      remove: (id) => workerEngine.remove(id),
      runErrand: (id, text) => workerEngine.runErrand(id, text),
      journalFor: (id) => workerEngine.journalFor(id),
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
    policy: () => loadOrgPolicy().policy,
    draft: (args) => draftHire({ runner, ...args }),
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
    },
    importWorker: (yaml, opts) => importSharedWorker(workerEngine, yaml, opts),
    audit: fileAuditStore,
    asks: fileAskStore,
    triggers: engines.triggers,
    serverTools: async (name) => {
      const config = readClaudeMcpServers()[name];
      return config ? listServerTools(config) : { ok: false, error: `${name} isn't installed on this server.` };
    },
    tools: {
      list: (roster, statuses) => listTools(roster, statuses, loadToolTemplates(toolTemplatesFile(host().dataDir()))),
      remember: (templates) => rememberToolTemplates(toolTemplatesFile(host().dataDir()), templates),
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
