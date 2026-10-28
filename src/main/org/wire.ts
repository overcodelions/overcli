// Build the org control plane over the engines — shared by the app and
// `overcli serve`, like the Slack bridge, so both enforce one set of rules.

import os from 'node:os';
import { checkoutHealth, discardCheckouts, folderBytes, keptCheckouts, sweepWorktrees, volumeOf } from './worktreeSweep';
import type { StorageReport } from './orgService';
import { warmNpxTools } from './npxWarm';
import { ToolHealth, type ToolTrouble } from './toolHealth';
import { setToolWatcher } from '../toolWatch';
import type { FlowRuntimeImpl } from '../flows/runtime';
import type { OrchestratorImpl } from '../flows/orchestrator';
import type { WorkerEngine } from '../flows/workerEngine';
import type { RunnerManager } from '../runner';
import type { TeamEngine } from '../flows/teamEngine';
import { runDeliverablesFor } from '../flows/teamWire';
import { listWorkerFiles, readWorkerFileBytes } from '../flows/workerFiles';
import { loadAllFlows, saveFlow } from '../flows/storage';
import { loadRunSummaries } from '../flows/runSummaryLog';
import { buildWorkerShare, importWorkerYaml } from '../flows/workerShare';
import { appendWorkerJournalEntry } from '../flows/workerJournal';
import { healthyBackends, resolveBackendPath } from '../health';
import { Store } from '../store';
import { isEverydayProject } from '../../shared/everydayProjects';
import type { Worker } from '../../shared/flows/worker';
import { OrgService, type HealthItem, type OrgServiceDeps, type SetupOffer } from './orgService';
import { OVERDB_CONNECTIONS_FILE, OVERDB_TOOL, type OverdbOffer } from './overdb';
import { OVERDB_FILE_VERSION, type OverdbConnectionsFile } from '../../shared/overdbConnection';
import type { ServerVersion } from './updateCheck';
import { draftHire, drafterDepsFor, saveDraftedHire } from './hireDraft';
import { findOverlap } from './hireOverlap';
import { rewriteJob } from './jobRewrite';
import { pickPicture } from './pickPicture';
import { oneShotDraftText } from '../flows/drafter';
import { resolveWorkPlace } from './defaultProject';
import { installTool, listTools, loadToolTemplates, rememberToolTemplates, templateFrom, toolTemplatesFile, uninstallTool, updateToolSettings } from './tools';
import { host } from '../host';
import { readClaudeInit } from '../flows/mcpProbe';
import { readClaudeMcpServers } from '../mcpConfig';
import { mcpServerKey } from '../../shared/flows/toolScope';
import { checkLogin, checkLoginByCall, type LoginResult } from './toolLogin';
import { callTool, listServerTools } from './mcpDirect';
import type { TriggerService } from './triggers';
import { updateOrgFile, fileAskStore, fileAuditStore, fileHireStore, filePublishedStore, fileRatingStore, fileToolRequestStore, fileToolHealthStore, fileWorkerVersionStore, fileHandbook, fileTeamFileStore, jsonOrgStore, listTokens, loadOrgPolicy, orgDir } from './orgStores';
import { RepoService, serverGitNote, type RepoState } from './repos';
import { projectIdFor, repairProjectIds } from '../projectIds';
import { ensureWorkspaceSymlinkRoot, removeWorkspaceSymlinkRoot } from '../workspace';
import { applyRepoGrants } from './repoGrants';
import { changesOfRun } from './runChanges';
import { log } from '../diagnostics';
import type { SecretsService } from './secrets/service';
import type { ConnectionsService } from './connections';
import type { ToolSignIn } from './toolSignIn';
import { parseFlowYaml } from '../../shared/flows/yaml';
import { execFile, spawnSync } from 'node:child_process';
import { ToolchainService, type ToolchainState } from './toolchains';
import { addRunEnv } from '../runEnv';
import fs from 'node:fs';
import path from 'node:path';

export interface OrgEngines {
  runner: RunnerManager;
  flowRuntime: Pick<FlowRuntimeImpl, 'getRun' | 'listRuns' | 'steerRun' | 'resumeRun' | 'abortRun' | 'beforeFork' | 'runNote' | 'chatWithRun'>;
  orchestrator: Pick<OrchestratorImpl, 'get' | 'rejectItem' | 'list' | 'approveBatch'>;
  workerEngine: WorkerEngine;
  /// A getter: the app builds teams after the plane.
  teams?: () => TeamEngine | null;
  /// Extra health lines from the host (the Slack bridge, chiefly).
  health?: () => HealthItem[];
  /// The server's version and any newer release. `overcli serve` only.
  version?: () => ServerVersion;
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
  const carried = landed.result.bundle.carried;
  const saved = workerEngine.save({
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
    ...(carried?.knowledge ? { knowledge: { status: 'ready' as const, body: carried.knowledge, updatedAt: Date.now(), refresh: 'weekly' as const } } : {}),
    ...opts.extra,
    enabled: true,
  });
  if (!saved.ok || !carried) return saved;
  // Its notes and history from where it was, under its new id. Marked
  // imported: they stop it redoing old work, never count toward trust.
  const id = saved.worker.id;
  const lines = [
    ...(carried.journal ?? []).map((e) => ({ ...e })),
    ...(carried.notes ?? []).map((n) => ({ kind: 'note' as const, at: n.at, title: '', note: n.note })),
  ];
  lines.forEach((e, i) => appendWorkerJournalEntry({ ...e, id: `imported-${id}-${i}`, workerId: id, imported: true }));
  return saved;
}

/// Decline a paused worker run the way the desk does: settle its batch item
/// first, while it is still `paused` — aborting first would mark it failed,
/// and a failed item cannot be rejected, so the journal would never learn the
/// idea was turned down.
export function rejectWorkerRun(
  engines: { flowRuntime: Omit<OrgEngines['flowRuntime'], 'chatWithRun' | 'beforeFork' | 'runNote'>; orchestrator: Pick<OrchestratorImpl, 'get' | 'rejectItem'> },
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

/// Where builds keep what they download, under the server's home (on the
/// data volume in the image), shared by every run: Gradle, Maven, npm, pip,
/// uv and Go. Only the downloads: never settings files beside them.
export function buildCacheDirs(home: string): string[] {
  return [
    path.join(home, '.gradle', 'caches'),
    path.join(home, '.gradle', 'wrapper', 'dists'),
    path.join(home, '.m2', 'repository'),
    path.join(home, '.npm', '_cacache'),
    path.join(home, '.cache', 'pip'),
    path.join(home, '.cache', 'uv'),
    path.join(home, '.cache', 'go-build'),
    path.join(home, 'go', 'pkg', 'mod'),
  ];
}

export function createOrgService(
  engines: OrgEngines,
  hooks: Pick<OrgServiceDeps, 'onHireAwaitingApproval' | 'onHireDecided' | 'onToolsWanted' | 'onAskDone' | 'onToolRequest' | 'onToolRequestDecided'> & {
    /// A tool started failing: tell these admins.
    onToolTrouble?(t: ToolTrouble, admins: string[]): void;
  } = {},
): OrgService {
  const { runner, flowRuntime, workerEngine } = engines;
  const repos = createRepoService();
  applyRepoGrants(repos);
  // Java, Node, Python, Go and custom kits on the data volume: on every
  // worker's PATH, the version per repo.
  const toolchains = new ToolchainService({
    dir: path.join(host().dataDir(), 'toolchains'),
    store: jsonOrgStore<ToolchainState>('toolchains.json', () => ({ toolchains: [], defaults: {}, repoPicks: {} })),
    repos: () => repos.list(),
    log: (message) => log('info', 'org.toolchains', message),
  });
  toolchains.recover();
  addRunEnv((env, cwd) => toolchains.env(env, cwd));
  // Runs on a connected repo start from its default branch as origin has it.
  flowRuntime.beforeFork = (paths) => repos.freshen(paths).then((problems) => problems.forEach((p) => log('warn', 'org.repos', p)));
  // ...and every step of a worker's run there is told so, and not to fetch.
  flowRuntime.runNote = (run) => {
    if (!run.workerId) return undefined;
    const at = run.sourceProjectPath ?? run.projectPath;
    const repo = repos.list().find((r) => r.path === at);
    const ws = repo ? undefined : repos.workspaces().find((x) => x.rootPath === at);
    if (!repo && !ws) return undefined;
    const members = repo ? [repo] : repos.list().filter((r) => ws!.repos.includes(r.name));
    return serverGitNote(members.filter((r) => r.testCommand).map((r) => (members.length > 1 ? `${r.testCommand} (in ${r.name})` : r.testCommand!)));
  };
  // The last storage measurement (storage.report).
  let storageCache: StorageReport | null = null;
  let storageInFlight: Promise<StorageReport> | null = null;
  // When the connected repos last caught up with origin.
  let lastRefreshAt: number | undefined;
  // npx tools installed ahead of their first check or run, and a broken
  // install put right; then again every half hour for ones added since.
  const warm = () => {
    const tools = Object.fromEntries(Object.entries(readClaudeMcpServers()).map(([n, c]) => [n, { command: typeof c.command === 'string' ? c.command : undefined, args: Array.isArray(c.args) ? c.args.map(String) : [] }]));
    void warmNpxTools(tools, (level, msg) => log(level, 'org.tools', msg)).catch(() => undefined);
  };
  warm();
  setInterval(warm, 30 * 60_000).unref?.();
  // The connected repos follow origin every hour: readers work in them in
  // place, and coders' checkouts start from them.
  const refresh = () => void repos.freshen(repos.list().map((r) => r.path)).then((problems) => { lastRefreshAt = Date.now(); problems.forEach((p) => log('warn', 'org.repos', p)); }).catch(() => undefined);
  setTimeout(refresh, 2 * 60_000).unref?.();
  setInterval(refresh, 60 * 60_000).unref?.();
  // Finished runs' checkouts, once nothing in them can be lost.
  const sweep = () => void sweepWorktrees(flowRuntime.listRuns(), (level, msg) => log(level, 'org.worktrees', msg));
  setTimeout(sweep, 60_000).unref?.();
  setInterval(sweep, 10 * 60_000).unref?.();
  // Every tool call's outcome, from any run or answer: an expired key or a
  // retired API reaches the admins instead of hiding in run logs.
  const toolHealth = new ToolHealth({
    ...fileToolHealthStore,
    alert: (t) => hooks.onToolTrouble?.(t, loadOrgPolicy().policy.admins),
  });
  setToolWatcher((o) => {
    const worker = o.ok ? undefined : flowRuntime.listRuns().find((r) => Object.values(r.conversationIds ?? {}).includes(o.conversationId))?.workerName;
    toolHealth.observe({ tool: o.server, ok: o.ok, text: o.text, ...(worker ? { worker } : {}) });
  });
  const org = new OrgService({
    workers: {
      roster: () => workerEngine.roster(),
      get: (id) => workerEngine.get(id),
      save: (w) => workerEngine.save(w),
      setEnabled: (id, enabled) => workerEngine.setEnabled(id, enabled),
      remove: (id) => workerEngine.remove(id),
      runErrand: (id, text, attachments, conversation, untrusted, mayLaunch) => workerEngine.runErrand(id, text, attachments, { ...(conversation ? { conversation } : {}), ...(untrusted ? { untrusted: true } : {}), ...(mayLaunch ? { mayLaunch: true } : {}) }),
      changesOf: (id) => workerEngine.changesOf(id),
      flowsOf: (id) => workerEngine.flowsOf(id),
      lookup: (id, args) => workerEngine.lookup(id, args),
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
      chatWithRun: (args) => flowRuntime.chatWithRun(args),
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
    rewriteJob: (args) => rewriteJob(drafterDepsFor(runner), args),
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
      approve: (id, ids, by) =>
        engines.orchestrator.approveBatch({ id, ...(ids === 'all' ? {} : { approve: ids.map((candidateId) => ({ candidateId })), keepUnpicked: true }), ...(by ? { by } : {}) }),
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
      comment: (taskId, input) => engines.teams?.()?.comment(taskId, input) ?? { ok: false, error: 'Teams are not running.' },
      redoPiece: (taskId, workerId, note) => engines.teams?.()?.redoPiece(taskId, workerId, note) ?? { ok: false, error: 'Teams are not running.' },
      accept: (taskId) => engines.teams?.()?.accept(taskId) ?? { ok: false, error: 'Teams are not running.' },
      roomAsk: (taskId, text) => engines.teams?.()?.roomAsk(taskId, text) ?? { ok: false, error: 'Teams are not running.' },
      roomContinue: (taskId) => engines.teams?.()?.roomContinue(taskId) ?? { ok: false, error: 'Teams are not running.' },
      updatePack: (taskId, opts) => engines.teams?.()?.updatePack(taskId, opts) ?? { ok: false, error: 'Teams are not running.' },
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
    overdbOffers: jsonOrgStore<{ offers: OverdbOffer[] }>('overdb-offers.json', () => ({ offers: [] })),
    overdbConnections: jsonOrgStore<OverdbConnectionsFile>(OVERDB_CONNECTIONS_FILE, () => ({ version: OVERDB_FILE_VERSION, connections: [] })),
    overdb: {
      // The Docker image puts overdb here; anywhere else says so in OVERDB_HEADLESS.
      headlessPath: () => {
        const at = process.env.OVERDB_HEADLESS?.trim() || '/opt/overdb/dist/mcp/headless.js';
        return fs.existsSync(at) ? at : null;
      },
      connectionsFile: () => path.join(orgDir(), OVERDB_CONNECTIONS_FILE),
      queryLogFile: () => path.join(orgDir(), 'overdb-queries.jsonl'),
      // The newest part is what the console shows; the rest rotates away (overdb keeps it under 5 MB).
      readQueryLog: () => {
        try {
          return fs.readFileSync(path.join(orgDir(), 'overdb-queries.jsonl'), 'utf-8');
        } catch {
          return '';
        }
      },
      toolEnv: () => {
        const env = readClaudeMcpServers()[OVERDB_TOOL]?.env;
        if (!env || typeof env !== 'object' || Array.isArray(env)) return {};
        return Object.fromEntries(Object.entries(env).filter((e): e is [string, string] => typeof e[1] === 'string'));
      },
    },
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
    toolchains,
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
      testsOff: () => repos.testsOff(),
      ciRounds: () => repos.ciRounds(),
      prMode: () => repos.prMode(),
      setPrMode: (mode) => repos.setPrMode(mode),
      setCiRounds: (n) => repos.setCiRounds(n),
      branchPrefix: () => Store.load().settings.agentBranchPrefix || 'agent/',
      freshen: (paths) => repos.freshen(paths).then((problems) => { lastRefreshAt = Date.now(); return problems; }),
      lastRefreshed: () => lastRefreshAt,
      setBranchPrefix: (prefix) => Store.saveSettings({ ...Store.load().settings, agentBranchPrefix: prefix }),
      changed: () => applyRepoGrants(repos),
    },
    saveFlow: (id, yaml) => {
      const flow = parseFlowYaml({ yaml, id, source: 'user', filePath: '' });
      if (!flow) return { ok: false, error: 'That flow did not parse.' };
      const saved = saveFlow({ flow, target: 'user' });
      return saved.ok ? { ok: true } : saved;
    },
    orchestration: (id) => engines.orchestrator.get(id) ?? null,
    stopBatch: (id) => {
      const abort = (engines.orchestrator as Partial<Pick<OrchestratorImpl, 'abort'>>).abort;
      return abort ? abort.call(engines.orchestrator, { id }) : { ok: false, error: 'Batches can’t be stopped from here.' };
    },
    runDeliverables: runDeliverablesFor((id) => engines.flowRuntime.getRun(id)),
    runChanges: (run, opts) => changesOfRun(run, opts),
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
    models: {
      flows: (ids) => loadAllFlows({ projectPaths: Store.load().projects.map((p) => p.path) }).filter((f) => ids.includes(f.id)),
      save: (flow) => {
        // Written back to the layer it came from, as the desktop's upgrade does.
        const projectPath = flow.source === 'project' ? Store.load().projects.find((p) => flow.filePath.startsWith(p.path + path.sep))?.path : undefined;
        if (flow.source === 'project' && !projectPath) return { ok: false, error: 'Couldn’t find the project it lives in.' };
        const saved = saveFlow({ flow, target: flow.source, ...(projectPath ? { projectPath } : {}) });
        return saved.ok ? { ok: true } : saved;
      },
      healthy: async () => [...(await healthyBackends(Store.load().settings.backendPaths))],
      fallback: () => {
        const s = Store.load().settings;
        return { preferredBackend: s.preferredBackend, modelDefaults: s.flowModelDefaults };
      },
    },
    shareWorker: (worker, carried) => {
      const library = loadAllFlows({ projectPaths: Store.load().projects.map((p) => p.path) });
      return buildWorkerShare({ worker, library, carried });
    },
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
    toolLogins: jsonOrgStore<Record<string, LoginResult>>('tool-logins.json', () => ({})),
    ...(engines.connections ? { connections: engines.connections } : {}),
    ...(engines.toolSignIn ? { toolSignIn: engines.toolSignIn } : {}),
    tools: {
      list: (roster, statuses) => listTools(roster, statuses, loadToolTemplates(toolTemplatesFile(host().dataDir()))),
      remember: (templates, onlyNew) => rememberToolTemplates(toolTemplatesFile(host().dataDir()), templates, onlyNew),
      template: (name) => {
        const config = readClaudeMcpServers()[name];
        return config ? templateFrom(name, config) : null;
      },
      install: installTool,
      uninstall: uninstallTool,
      update: updateToolSettings,
      login: async (name) => {
        const config = readClaudeMcpServers()[name];
        if (!config) return null;
        const env = config.env && typeof config.env === 'object' && !Array.isArray(config.env) ? (config.env as Record<string, string>) : {};
        const now = Date.now();
        return (await checkLogin(env, now)) ?? checkLoginByCall(
          () => listServerTools(config, { schemas: true }),
          async (tool) => {
            const r = await callTool(config, tool, {});
            return r.ok ? { ok: true, text: r.text } : r;
          },
          mcpServerKey(name),
          now,
        );
      },
      check: async () => {
        const binary = resolveBackendPath('claude', Store.load().settings.backendPaths.claude);
        const init = binary ? await readClaudeInit(binary) : null;
        return init ? Object.fromEntries(init.servers.map((s) => [s.name, s.status])) : null;
      },
    },
    ratings: fileRatingStore,
    toolRequests: fileToolRequestStore,
    toolHealth,
    workerVersions: fileWorkerVersionStore,
    storage: {
      // Measuring 20 GB takes a while: once every few minutes is plenty.
      report: async () => {
        if (storageCache && Date.now() - storageCache.measuredAt < 5 * 60_000) return storageCache;
        if (storageInFlight) return storageInFlight;
        storageInFlight = (async () => {
        const home = os.homedir();
        const wtRoot = path.join(home, '.overcli', 'worktrees');
        let count = 0;
        try {
          for (const r of fs.readdirSync(wtRoot)) count += fs.readdirSync(path.join(wtRoot, r)).length;
        } catch {
          // none yet
        }
        const [checkoutBytes, repoBytes, cacheBytes, ...builds] = await Promise.all([folderBytes(wtRoot), folderBytes(path.join(host().dataDir(), 'repos')), folderBytes(path.join(home, '.npm', '_npx')), ...buildCacheDirs(home).map((d) => folderBytes(d))]);
        const buildBytes = builds.some((b) => b !== null) ? builds.reduce<number>((sum, b) => sum + (b ?? 0), 0) : null;
        storageCache = { volume: volumeOf(host().dataDir()), checkouts: { count, bytes: checkoutBytes }, repos: repoBytes, toolCache: cacheBytes, buildCache: buildBytes, kept: keptCheckouts(), measuredAt: Date.now() };
        return storageCache!;
        })().finally(() => { storageInFlight = null; });
        return storageInFlight;
      },
      discard: async (runId) => {
        const run = flowRuntime.getRun(runId);
        if (!run) return { ok: false, error: 'No such run.' };
        if (run.state.kind !== 'done' && run.state.kind !== 'aborted') return { ok: false, error: 'That run is still going.' };
        const removed = await discardCheckouts(run);
        storageCache = null;
        return { ok: true, removed };
      },
      clearToolCache: async () => {
        fs.rmSync(path.join(os.homedir(), '.npm', '_npx'), { recursive: true, force: true });
        storageCache = null;
        warm();
      },
      clearBuildCache: async () => {
        for (const d of buildCacheDirs(os.homedir())) {
          try {
            fs.rmSync(d, { recursive: true, force: true });
          } catch {
            // Go keeps its module cache read-only: make it writable, then again.
            spawnSync('chmod', ['-R', 'u+w', d]);
            fs.rmSync(d, { recursive: true, force: true });
          }
        }
        storageCache = null;
        warm();
      },
    },
    handbook: fileHandbook,
    ...(engines.version ? { version: engines.version } : {}),
    health: (() => {
      const models = backendProbe();
      return () => [...(engines.health?.() ?? []), models(), checkoutHealth()];
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
  // Its runs hear which of their tools the server found won't sign in.
  workerEngine.setToolProblems?.((id) => org.toolProblemsFor(id));
  // Never stops the server: workers keep the flows they have.
  try {
    org.refreshRepoFlows();
  } catch (err) {
    log('warn', 'org.repos', `Couldn't refresh the repo flows: ${(err as Error).message}`);
  }
  return org;
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
    log: (message) => log('info', 'org.repos', message),
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
