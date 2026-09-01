// 2026-04-18
// Updated 2026-04-18.
// Electron main process entry. Creates the single main window and
// registers every IPC handler the renderer invokes. Main-process state
// lives here — the Store, the RunnerManager, health probes, stats.

import { randomUUID } from 'node:crypto';

import { app, BrowserWindow, dialog, ipcMain, powerMonitor, session, shell, Menu, nativeTheme } from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { Store, flushStoreSync } from './store';
import { isAgentWrittenPath, recordWritesFromEvents } from './writtenPaths';
import { RunnerManager } from './runner';
import { SymbolLookupManager, resolveSearchRoot } from './symbolLookup';
import { loadHistory, migrateClaudeSessionCwd } from './history';
import {
  probeBackendHealth,
  healthyBackends,
  invalidateHealthCache,
  listInstalledReviewers,
  resolveBackendPath,
} from './health';
import { primeBackendUpdates } from './backendUpdater';
import {
  runGit,
  createWorktree,
  createReviewWorktree,
  promoteReviewWorktree,
  switchProjectToBranch,
  switchBranch,
  removeWorktree,
  checkoutAgentLocally,
  detectBaseBranch,
  listBaseBranches,
  listBaseBranchesFresh,
  mergeAgent,
  rebaseAgent,
  pushBranch,
  openPR,
  worktreeStatus,
  worktreeDiff,
  rescueMainTree,
  commitStatus,
  worktreeChanges,
  resolveDiffBase,
  currentBranch,
  restoreFileToHead,
  workspaceCommitStatus,
  commitAll,
  workspaceCommitAll,
  initRepo,
  removeRepoHistory,
  gitAvailability,
  gitInstallCommand,
  forgetGitAvailability,
  originRemote,
} from './git';
import { copyIntoProject, createEverydayProject, setEverydayMarker, syncProjectMarkers } from './everydayProject';
import { createBlankDocument, createDocumentFromPrompt, listDocuments, reviseDocument } from './documents';
import { checkpointProject, checkpointStatusPorcelain, listVersions, restoreVersion } from './versions';
import { commitAllAsync, readVersionDiff } from './git';
import { scanWorktrees, sweepWorktrees, conversationWorktreeStates } from './worktreeSweep';
import { computeStats } from './stats';
import { refreshClaudeUsage } from './claudeUsage';
import { scanCapabilities } from './capabilities';
import { addMcpServerToTargets, isMcpCli, readMcpServer, writeMcpServer } from './mcpConfig';
import { listMcpCatalog, installMcpCatalogEntry, uninstallMcpCatalogEntry } from './mcpCatalog';
import { loginCodexMcp } from './mcpLogin';
import { isSafeAwsName, readAwsAuthOverview } from './awsProfiles';
import { awsEnv, awsSsoLoginCommand, resolveAwsBinary, runAwsSsoLogin } from './awsSsoLogin';
import { backendNeedsShell, buildBackendEnv } from './backendPaths';
import { resolveFilePath as resolveFilePathIn, resolveWriteTarget } from './resolveFilePath';
import { listFileEntriesAsync, listFileEntriesSync } from './fileWalk';
import { closeAllTreeWatchers, noteRelistCost, unwatchTree, watchTree } from './fileTreeWatch';
import { readHtmlPreviewAssets } from './htmlPreviewAssets';
import { convertOfficeToPreview, officeFamilyForExtension } from './officePreview';
import { buildReactPreviewBundle } from './reactPreviewBundle';
import {
  handlePreviewProtocol,
  publishPreviewDocument,
  registerPreviewScheme,
  type PreviewPolicy,
} from './previewProtocol';
import {
  listMarketplaceSkills,
  installMarketplaceSkill,
  uninstallMarketplaceSkill,
  uninstallSkillByPath,
} from './skillsCatalog';
import {
  OLLAMA_CATALOG,
  brewManagesOllama,
  detectHardware,
  detectOllama,
  deleteModel,
  installOllama,
  ollamaServer,
  pullModel,
} from './ollama';
import { deleteOllamaSession } from './ollamaStore';
import { auditOllama, updateOllama } from './ollamaSecurity';
import { clearSilentLog, listSilentLog, log, type LogLevel } from './diagnostics';
import { initAutoUpdater, refreshUpdateChannel, quitAndInstall } from './updater';
import { getWhatsNew, markWhatsNewSeen, seedWhatsNewBaseline } from './whatsNew';
import { host } from './host';
import { installElectronHost } from './hostElectron';
import {
  configuredWebhookAuthHeader,
  configuredWebhookToken,
  configuredWebhookUrl,
  sendWebhookNotification,
  validateWebhookUrl,
  WEBHOOK_TOKEN_ENV,
  WEBHOOK_TOKEN_KEY,
} from './webhookNotify';
import { loadAllFlows, saveFlow, deleteFlow, validateFlowYaml } from './flows/storage';
import { buildWorkerShare, describeImport, importWorkerYaml } from './flows/workerShare';
import { buildCiDeploy, buildFlowCiDeploy, type CiWorkspace } from '../shared/flows/ciDeploy';
import { serializeFlow } from '../shared/flows/yaml';
import {
  ensureWorkerFilesDir,
  listWorkerFiles,
  readWorkerFile,
  workerFilesDir,
  deleteWorkerFile,
  deliverableFiles,
} from './flows/workerFiles';
import { listToolCatalog } from './flows/toolCatalog';
import { FlowRuntime } from './flows/runtime';
import { OrchestratorImpl } from './flows/orchestrator';
import { SchedulerEngine } from './flows/scheduler';
import { WorkerEngine } from './flows/workerEngine';
import { workerOrigin } from '../shared/flows/worker';
import { pickDrafterBackend, resolveProducerModel } from '../shared/flows/drafterBackend';
import { DEFAULT_TREASURY_USD, allocateTreasury } from '../shared/flows/treasury';
import {
  draftWorkerFromPrompt,
  personalizeImportedWorker,
  reviseWorkerFromPrompt,
} from './flows/workerDrafter';
import { prefillFromProfile, rememberAnswers } from '../shared/flows/personalize';
import {
  forgetProfileFact,
  loadUserProfile,
  saveUserProfile,
} from './flows/userProfileStore';
import { flushRuns } from './flows/runsStore';
import { loadRunSummaries } from './flows/runSummaryLog';
import { renderProvenFlowsSection } from './flows/provenFlows';
import { emptyWorkerReportTotals } from '../shared/flows/workerReport';
import { flowDeletionBlocker } from './flows/flowGuards';
import { listRecentPrompts, recordRecentPrompt, deleteRecentPrompt } from './flows/recentPromptsStore';
import { listWatchSources } from './flows/watch/source';
import {
  listRegistries,
  upsertRegistry,
  removeRegistry,
  browseRegistries,
  installFromRegistry,
  previewRegistryFlow,
} from './flows/registry';
import { FLOW_TEMPLATES } from '../shared/flows/templates';
import { draftFlowFromPrompt, reviseFlowFromPrompt, type DraftDeps } from './flows/drafter';
import {
  ensureWorkspaceSymlinkRoot,
  removeWorkspaceSymlinkRoot,
  ensureCoordinatorSymlinkRoot,
  rebindCoordinatorRootToProjects,
  removeCoordinatorSymlinkRoot,
  looseSyntheticRootFiles,
} from './workspace';
import { openTerminalAt, openTerminalIn, runInTerminal } from './terminal';
import {
  ArtifactPreviewResult,
  Backend,
  MainToRendererEvent,
  ProjectPreviewCommand,
  ProjectPreviewHintsResult,
  StreamEventKind,
  StreamEvent,
} from '../shared/types';

// Dev vs prod: we go to the Vite dev server ONLY when VITE_DEV_SERVER_URL
// is explicitly set (the `dev:electron` npm script sets it). Anything else
// — packaged .app, unpackaged `npm start`, direct `electron .` — loads
// from the built file:// HTML. Earlier this was `!app.isPackaged`, which
// incorrectly sent `npm start` at the Vite URL that wasn't running.
const DEV_URL = process.env.VITE_DEV_SERVER_URL;
const isDev = !!DEV_URL;
const MAX_OPEN_FILE_BYTES = 5 * 1024 * 1024;
const MAX_TEXT_FILE_BYTES = 1 * 1024 * 1024;
const LARGE_TEXT_PREVIEW_BYTES = 256 * 1024;

let mainWindow: BrowserWindow | null = null;
let runner: RunnerManager | null = null;
// FlowRuntime is constructed alongside the RunnerManager so it can drive
// step conversations through the existing send pipeline. Stays null until
// Phase 4 lands the runtime module — until then, the flow runtime IPC
// handlers below short-circuit to "not initialized" so the renderer can
// already load flows and build them without a crash on Run.
let flowRuntime: FlowRuntime | null = null;
let orchestrator: OrchestratorImpl | null = null;
let scheduler: SchedulerEngine | null = null;
let workerEngine: WorkerEngine | null = null;
let symbolLookup: SymbolLookupManager | null = null;

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 840,
    minWidth: 960,
    minHeight: 600,
    title: 'overcli',
    titleBarStyle: 'hiddenInset',
    backgroundColor: '#1c1c21',
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false,
    },
  });

  if (isDev && DEV_URL) {
    mainWindow.loadURL(DEV_URL);
    mainWindow.webContents.openDevTools({ mode: 'undocked' });
  } else {
    mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  }

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  // The navigate/window-open lock that keeps the renderer on its own origin
  // and bounces external links to the browser is NOT installed here. It is
  // installed once, for every webContents, by the `web-contents-created`
  // handler in `whenReady` — which runs before this window exists.
  //
  // This function used to install its own copy as well. `setWindowOpenHandler`
  // is a setter, so that one was harmlessly replaced; `will-navigate` is an
  // event, so BOTH listeners fired and every link that took the navigate path
  // was handed to `shell.openExternal` twice — two browser tabs per click.
  // One registration, one tab.
}

// Allowlist for URLs handed to `shell.openExternal` — anywhere a URL
// flows from the renderer (or from in-page markdown) to the OS. Custom
// URI schemes can trigger privileged actions in other apps (itms-services,
// slack://, file://, etc.), so we only allow plain web + mail + tel.
function isSafeExternalUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' || u.protocol === 'http:' || u.protocol === 'mailto:' || u.protocol === 'tel:';
  } catch {
    return false;
  }
}

function emitToRenderer(event: MainToRendererEvent): void {
  noteAgentWrites(event);
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('main:event', event);
  }
}

/// Watch the event stream for files agents write, so the viewer can open them
/// again afterwards (see writtenPaths.ts). Every backend's events funnel
/// through `emitToRenderer`, which makes it the one place that sees them all
/// — parsing each CLI's own tool-call shape separately would leave whichever
/// backend was added next silently unsupported.
function noteAgentWrites(event: MainToRendererEvent): void {
  if (event.type !== 'stream') return;
  recordWritesFromEvents(event.events);
}

/// Native OS notification. The only way a scheduled run reaches the user when
/// the window is behind everything else or they've walked away — which is the
/// normal case for scheduled work, not the exception.
///
/// The notification itself is the host's job now (`hostElectron.ts`), so the
/// scheduler and the worker engine can hand the same callback to a headless
/// host that writes a log line instead. What stays here is the click, because
/// only this file knows about `mainWindow`.
///
/// The outbound webhook is deliberately NOT added here, even though this
/// function is the choke point for every `deps.notify(...)` site. It sits on
/// the host instead (`hostElectron.ts` / `hostNode.ts` / `cli/engines.ts`),
/// because this file is Electron-only: the watch loop bypasses this function
/// entirely and `overcli serve` never loads this file at all. Adding a second
/// wrap here would double-post every desktop notification. See the header of
/// `webhookNotify.ts`.
function showDesktopNotification(args: { title: string; body: string }): void {
  host().notify(args);
}

/// Bring the window forward when the user clicks a notification. Installed on
/// the host at boot; a notification that does nothing when clicked is worse
/// than no notification.
function focusMainWindow(): void {
  if (mainWindow && !mainWindow.isDestroyed()) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  }
}

// Installed at module scope, before anything can reach for stored state:
// `host()` throws when nothing is installed, and half this file's imports
// read `overcli.json` the moment they are touched. Safe this early because
// `electronHost` only calls `app.getPath` lazily, inside `dataDir()`.
installElectronHost(focusMainWindow);

/// Deps for every AI drafting call. Carries the user's proven flows so a
/// draft copies the shape of what already works here instead of inventing a
/// deeper one.
function drafterDeps(): DraftDeps {
  const store = Store.load();
  return {
    settings: store.settings,
    runner: runner!,
    provenFlows: renderProvenFlowsSection(
      loadAllFlows({ projectPaths: store.projects.map((p) => p.path) }),
      loadRunSummaries(),
    ),
  };
}

// Exported for tests only — production code always reaches this through the
// `app.whenReady()` wiring at the bottom of the file.
export function registerIpc(): void {
  // The flow runtime needs to tap every stream event the runner emits so
  // it can detect step completion + accumulate assistant text for artifact
  // extraction. Wrap the renderer emit callback to tee events into the
  // runtime first; nothing changes for renderer-facing behavior.
  const flowAwareEmit = (event: MainToRendererEvent) => {
    if (flowRuntime) flowRuntime.observeEvent(event);
    // The worker engine folds worker-batch orchestration updates into each
    // worker's journal. Tapped here (not via setRunObserver) because the
    // verdicts it cares about — approve/reject — are batch transitions, not
    // run transitions. It ignores every other event type.
    if (workerEngine) workerEngine.observeEvent(event);
    emitToRenderer(event);
  };
  runner = new RunnerManager(flowAwareEmit, () => Store.load().settings);
  flowRuntime = new FlowRuntime(
    runner,
    flowAwareEmit,
    () => Store.load().projects,
    () => Store.load().settings,
    () => Store.load().workspaces,
  );
  // The orchestrator drives the runtime (launching child runs) and listens
  // to it (pumping the queue when a child finishes). Wire the observer AFTER
  // both exist so the runtime can notify the orchestrator on every terminal
  // run update.
  orchestrator = new OrchestratorImpl(
    runner,
    flowRuntime,
    flowAwareEmit,
    () => Store.load().projects,
    () => Store.load().settings,
  );
  // The scheduler is the other thing that launches runs nobody is watching.
  // It borrows the orchestrator for `orchestrate` targets, which is why it's
  // built after it.
  scheduler = new SchedulerEngine({
    launcher: flowRuntime,
    parker: orchestrator,
    // A workspace root is not itself a git repo, but the runtime mints a
    // worktree per member when a run targets one (see `workspaceWorktrees` in
    // flows/runtime). Testing only `currentBranch` silently downgraded every
    // scheduled workspace run to `cwd` — unattended edits landing straight in
    // the user's checked-out tree, which is exactly what picking a worktree is
    // supposed to prevent.
    isGitRepo: (projectPath) =>
      currentBranch(projectPath).isRepo || Store.load().workspaces.some((w) => w.rootPath === projectPath),
    emit: flowAwareEmit,
    notify: showDesktopNotification,
  });
  // One observer slot on the runtime, two consumers. The orchestrator pumps
  // its queue on a terminal child run; the scheduler clears its overlap guard
  // and notifies. Each ignores runs it didn't launch, so the fan-out is free.
  flowRuntime.setRunObserver((run) => {
    orchestrator?.onRunUpdate(run);
    scheduler?.onRunUpdate(run);
  });
  scheduler.start();
  // Workers park their shifts through the orchestrator exactly like scheduled
  // `orchestrate` targets do, so the engine is one more parkProposal caller —
  // built after the orchestrator for the same reason the scheduler is.
  workerEngine = new WorkerEngine({
    parker: orchestrator,
    isGitRepo: (projectPath) =>
      currentBranch(projectPath).isRepo || Store.load().workspaces.some((w) => w.rootPath === projectPath),
    emit: flowAwareEmit,
    notify: showDesktopNotification,
    supervisorTurn: async ({ worker, prompt, cwd }) => {
      const settings = Store.load().settings;
      const healthy = await healthyBackends(settings.backendPaths);
      const backend = pickDrafterBackend({
        preferred: worker.heartbeatBackend ?? settings.preferredBackend,
        isHealthy: (candidate) => healthy.has(candidate),
        isEnabled: (candidate) => settings.disabledBackends[candidate] !== true,
      });
      if (!backend) {
        return {
          ok: false,
          error: 'No signed-in model is available to answer the flow.',
        };
      }
      const model = resolveProducerModel(backend, worker.heartbeatModel, settings.flowModelDefaults);
      return runner!.oneShot({
        backend,
        model,
        prompt,
        cwd,
        permissionMode: 'plan',
        timeoutMs: 180_000,
        idleTimeoutMs: 60_000,
      });
    },
    clearActivity: (workerId) => {
      let shifts = 0;
      let errands = 0;
      const batches = (orchestrator?.list() ?? []).filter(
        (batch) => batch.origin?.kind === 'worker' && batch.origin.workerId === workerId,
      );
      for (const batch of batches) {
        if (batch.origin?.kind === 'worker' && batch.origin.task === 'errand') errands += 1;
        else shifts += 1; // pre-errand worker batches carry no task and are shifts
        orchestrator?.delete({ id: batch.id });
      }

      const runs = (flowRuntime?.listRuns() ?? []).filter((run) => run.workerId === workerId);
      for (const run of runs) {
        const deleted = flowRuntime?.deleteRun({ runId: run.id, force: true });
        if (deleted?.ok) emitToRenderer({ type: 'flowRunDeleted', runId: run.id });
      }
      return { shifts, errands, runs: runs.length };
    },
    // The single-turn twin of `clearActivity`. Deleting the batch first is
    // what stops anything still in flight — its terminal update would
    // otherwise route to a ledger that no longer exists.
    deleteActivity: (workerId, orchestrationId) => {
      const batch = orchestrator?.get(orchestrationId) ?? null;
      if (!batch || batch.origin?.kind !== 'worker' || batch.origin.workerId !== workerId) {
        return { runs: 0 };
      }
      const runIds = batch.items.map((item) => item.runId).filter((id): id is string => !!id);
      orchestrator?.delete({ id: orchestrationId });
      let runs = 0;
      for (const runId of runIds) {
        const deleted = flowRuntime?.deleteRun({ runId, force: true });
        if (deleted?.ok) {
          emitToRenderer({ type: 'flowRunDeleted', runId });
          runs += 1;
        }
      }
      return { runs };
    },
    // Triage path 3: the errand needs real investigation and no flow on the
    // worker's contract fits. Draft one, file it in the generated bucket (kept
    // out of the library's groups and every picker), and launch it through the
    // orchestrator with the worker's own origin so the run journals and scores
    // like any other work it does.
    // A run's artifacts die with the run (MAX_RETAINED_RUNS). Hand the engine
    // a way to read the deliverable so it can file a copy under the worker.
    deliverablesFor: (runId) => {
      const run = flowRuntime?.getRun(runId);
      if (!run) return [];
      // Step order, so the answer is last and its supporting material reads in
      // the order it was produced.
      const seen = new Set<string>();
      const out: Array<{ name: string; body?: string; sourcePath?: string }> = [];
      for (const step of run.flowSnapshot?.steps ?? []) {
        const art = run.artifacts?.[step.output];
        if (!art || seen.has(art.name)) continue;
        seen.add(art.name);
        out.push({ name: art.name, body: art.body });
      }
      // Plus whatever the run WROTE rather than recorded. A step told to
      // render a dashboard or a chart writes a real file into its working
      // root and hands back a receipt — the receipt is the artifact, so
      // filing artifacts alone kept the note and dropped the thing it
      // described, which then died with the run's coordinator root.
      for (const file of looseSyntheticRootFiles(run.projectPath, {
        since: run.createdAt,
      })) {
        if (seen.has(file.name)) continue;
        seen.add(file.name);
        out.push({ name: file.name, sourcePath: file.path });
      }
      return out;
    },
    // The composer in the run pane keeps talking to a run's last participant
    // after the flow is done, and those turns write into the same run root.
    // This is how the engine recognises one of its own runs behind a bare
    // conversation id so it can file what the turn produced.
    runIdForConversation: (conversationId) =>
      flowRuntime?.listRuns().find((run) => Object.values(run.conversationIds).includes(conversationId))
        ?.id ?? null,
    // Everyday projects checkpoint on boundaries, and a worker filing a
    // document into one is a boundary. Fire-and-forget: the file is already
    // there, and a failed commit is a missing version, not a lost document.
    checkpoint: ({ projectPath, message }) => {
      void checkpointProject(
        { projectPath, message },
        { statusPorcelain: checkpointStatusPorcelain, commit: commitAllAsync },
      )
        .then((res) => {
          if (!res.ok && !res.skipped) {
            log('warn', 'versions.checkpoint', `no version saved for ${projectPath}`, res.error);
          }
        })
        .catch((err) => log('warn', 'versions.checkpoint', `checkpoint threw for ${projectPath}`, err));
    },
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
        drafterDeps(),
      );
      if (!drafted.ok) return drafted;
      // A distinct id per errand: these are single-use, and reusing one would
      // have a later errand silently overwrite the flow an earlier run is
      // still executing.
      const flow = {
        ...drafted.flow,
        id: `generated-${randomUUID().slice(0, 8)}`,
        source: 'generated' as const,
      };
      const saved = saveFlow({ flow, target: 'generated' });
      if (!saved.ok) return saved;
      const launched = await orchestrator!.startBatch({
        title: `[Errand] ${errand.split('\n')[0]?.trim().slice(0, 80) || 'Investigation'}`,
        projectPath: worker.projectPath,
        runIn,
        maxConcurrent: 1,
        // The generated flow is drafted read-only, but `resolveStepEffect` is a
        // heuristic over step text — a "report the answer" step can still read
        // as external. Stamped through the shared helper for the same reason
        // the shift and errand parks are, so one worker doesn't gate on path 3
        // after being waived on paths 1 and 2.
        origin: workerOrigin(worker, 'errand', errand),
        items: [
          {
            candidate: { id: flow.id, title: flow.name, prompt: errand },
            flowId: flow.id,
          },
        ],
      });
      if (!launched.ok) return launched;
      return {
        ok: true,
        orchestrationId: launched.orchestrationId,
        flowId: flow.id,
      };
    },
  });
  flowRuntime.setWorkerSupervisor((request) => workerEngine!.answerFlowQuestion(request));
  workerEngine.start();
  // A sleeping Mac runs no timers. Both engines arm a `setTimeout` for the
  // next due moment, and a host that sleeps across it wakes with the alarm
  // already in the past and no promise about when the runtime will service
  // it. Telling them the moment the host is back turns "some minutes after
  // the lid opens, and we'll call it missed while overcli was closed" into
  // "now, and we know why it was late". Registered once, after both engines
  // exist, because a resume concerns both.
  powerMonitor.on('resume', () => {
    scheduler?.onHostResume();
    workerEngine?.onHostResume();
  });
  // Symbol lookup resolves its backend per call rather than capturing one:
  // the user can change the preferred backend in Settings mid-session, and
  // a lookup is short-lived enough that there's nothing to migrate.
  symbolLookup = new SymbolLookupManager({
    backendFor: () => {
      const settings = Store.load().settings;
      // Only these three take a stdin prompt and a `-m/--model` override
      // (see buildLookupArgs). Copilot wants its prompt in argv; ollama
      // isn't a subprocess at all.
      const supported: Backend[] = ['claude', 'codex', 'gemini'];
      const preferred = settings.preferredBackend;
      const order =
        preferred && supported.includes(preferred)
          ? [preferred, ...supported.filter((b) => b !== preferred)]
          : supported;
      for (const backend of order) {
        if (settings.disabledBackends?.[backend]) continue;
        const binary = resolveBackendPath(backend, settings.backendPaths[backend]);
        if (binary) return { backend, binary };
      }
      return { backend: preferred ?? 'claude', binary: null };
    },
  });

  ipcMain.handle('store:load', async () => {
    const state = Store.load();
    // Restored editor tabs are checked against disk once, here, so the
    // renderer never hydrates a strip of tabs for files that are gone.
    await Store.pruneFileTabs();
    return state;
  });
  ipcMain.handle('store:saveProjects', (_e, projects) => Store.saveProjects(projects));
  ipcMain.handle('store:saveWorkspaces', (_e, workspaces) => Store.saveWorkspaces(workspaces));
  ipcMain.handle('store:patchConversation', (_e, { id, patch }) => Store.patchConversation(id, patch));
  ipcMain.handle('store:saveColosseums', (_e, colosseums) => Store.saveColosseums(colosseums));
  ipcMain.handle('store:saveSettings', (_e, settings) => {
    Store.saveSettings(settings);
    refreshUpdateChannel();
  });
  ipcMain.handle('store:saveSelection', (_e, id) => Store.saveSelection(id));
  ipcMain.handle('store:saveView', (_e, view) => Store.saveView(view));
  ipcMain.handle('store:saveFileTabs', (_e, tabs) => Store.saveFileTabs(tabs));
  ipcMain.handle('notify:testWebhook', async (_e, input) => {
    const raw = input?.url ?? configuredWebhookUrl() ?? '';
    const checked = validateWebhookUrl(raw);
    if (!checked.ok) return { ok: false, error: checked.error };
    // `token` is three-valued: absent means "use what is saved", while an
    // explicit null/'' means "test with no auth at all". `??` alone would
    // collapse those two, making an unauthenticated test impossible while a
    // token is stored — which is exactly the comparison a user needs when
    // the authenticated call is the one failing.
    const token =
      input && 'token' in input ? (input.token?.trim() || null) : configuredWebhookToken();
    const header = input?.header?.trim() || configuredWebhookAuthHeader();
    return await sendWebhookNotification(
      checked.url,
      {
        title: 'overcli test notification',
        body: 'If you can read this, overcli can reach you when you are away from the desktop.',
      },
      token ? { header, token } : null,
    );
  });
  ipcMain.handle('notify:webhookTokenStatus', () => ({
    configured: configuredWebhookToken() !== null,
    fromEnv: Boolean(process.env[WEBHOOK_TOKEN_ENV]?.trim()),
  }));
  ipcMain.handle('notify:setWebhookToken', (_e, token) => {
    const trimmed = token?.trim();
    try {
      return { ok: host().secrets.set(WEBHOOK_TOKEN_KEY, trimmed ? trimmed : null) };
    } catch (err) {
      log('warn', 'webhook.notify', `Could not store the webhook auth token: ${String(err)}`);
      return { ok: false };
    }
  });
  ipcMain.handle('update:quitAndInstall', () => quitAndInstall());
  ipcMain.handle('app:whatsNew', () => getWhatsNew());
  ipcMain.handle('app:markWhatsNewSeen', () => markWhatsNewSeen());
  ipcMain.handle('app:version', () => app.getVersion());

  ipcMain.handle('runner:send', (_e, args) => runner!.send(args));
  ipcMain.handle('runner:prewarm', (_e, args) => runner!.prewarm({ ...args, prompt: '' }));
  ipcMain.handle('runner:stop', (_e, { conversationId }) => runner!.stop(conversationId));
  ipcMain.handle('runner:newConversation', (_e, { conversationId }) => runner!.newConversation(conversationId));
  ipcMain.handle('runner:release', (_e, { conversationId, onlyIfIdle }) =>
    runner!.release(conversationId, { onlyIfIdle }),
  );
  ipcMain.handle('runner:respondPermission', (_e, { conversationId, requestId, approved, addDir, scope, toolName }) =>
      runner!.respondPermission(conversationId, requestId, approved, addDir, scope, toolName),
  );
  ipcMain.handle('runner:respondCodexApproval', (_e, { conversationId, callId, kind, approved }) =>
      runner!.respondCodexApproval(conversationId, callId, kind, approved),
  );
  ipcMain.handle('runner:respondUserInput', (_e, { conversationId, requestId, answers }) =>
    runner!.respondUserInput(conversationId, requestId, answers),
  );
  ipcMain.handle('runner:runningSnapshot', () => runner?.runningSnapshot() ?? []);
  ipcMain.handle('runner:loadHistory', (_e, args) => loadHistory(args));
  ipcMain.handle('runner:probeHealth', (_e, backend: Backend) => {
    const settings = Store.load().settings;
    return probeBackendHealth(backend, settings.backendPaths[backend]);
  });
  ipcMain.handle('runner:listInstalledReviewers', () => listInstalledReviewers());
  // Drop the probe cache so the next refresh re-executes the CLIs. The
  // sign-in banner polls through this while the user finishes an OAuth
  // round-trip in Terminal, where a cached "unauthenticated" would leave the
  // badge stale for up to the TTL.
  ipcMain.handle('health:invalidate', () => invalidateHealthCache());
  ipcMain.handle('capabilities:scan', () => scanCapabilities());
  ipcMain.handle('skills:listMarketplace', () => listMarketplaceSkills());
  ipcMain.handle('skills:installMarketplace', (_e, { skillId, targets }) => installMarketplaceSkill(skillId, targets));
  ipcMain.handle('skills:uninstallMarketplace', (_e, { skillId, targets }) =>
    uninstallMarketplaceSkill(skillId, targets),
  );
  ipcMain.handle('skills:uninstallByPath', (_e, { path: p }) => uninstallSkillByPath(p));
  ipcMain.handle('capabilities:copyMcp', (_e, { name, fromCli, toCli }) => {
    if (!isMcpCli(fromCli) || !isMcpCli(toCli)) {
      return { ok: false as const, error: `Unsupported CLI for MCP copy.` };
    }
    if (fromCli === toCli) {
      return {
        ok: false as const,
        error: `Source and target CLI are the same.`,
      };
    }
    try {
      const config = readMcpServer(fromCli, name);
      if (!config) {
        return {
          ok: false as const,
          error: `MCP server "${name}" not found in ${fromCli} config.`,
        };
      }
      writeMcpServer(toCli, name, config);
      return { ok: true as const };
    } catch (err: any) {
      return { ok: false as const, error: err?.message ?? String(err) };
    }
  });
  ipcMain.handle('capabilities:addMcp', (_e, args) => addMcpServerToTargets(args));
  ipcMain.handle('mcp:listCatalog', () => listMcpCatalog());
  ipcMain.handle('mcp:installCatalog', (_e, { id, targets, secrets }) => installMcpCatalogEntry(id, targets, secrets));
  ipcMain.handle('mcp:uninstallCatalog', (_e, { id, targets }) => uninstallMcpCatalogEntry(id, targets));
  ipcMain.handle('mcp:login', async (_e, { cli, name }) => {
    if (cli !== 'codex') {
      return {
        ok: false as const,
        error:
          cli === 'claude'
            ? 'Claude logs in to remote MCP servers from inside a session — open a Claude chat and run /mcp.'
            : `overcli can't trigger login for ${cli} yet.`,
      };
    }
    const settings = Store.load().settings;
    const binary = resolveBackendPath('codex', settings.backendPaths.codex);
    if (!binary) {
      return {
        ok: false as const,
        error: 'Codex binary not found. Set its path in Settings.',
      };
    }
    return loginCodexMcp({
      binary,
      name,
      env: buildBackendEnv(process.env, binary),
      useShell: backendNeedsShell(binary),
      onUrl: (url) => {
        if (isSafeExternalUrl(url)) shell.openExternal(url);
      },
    });
  });

  // Config-file reads and an existsSync probe only — deliberately no
  // `aws --version`, which costs ~800ms of blocked main thread for a string
  // the panel doesn't show.
  ipcMain.handle('aws:listSsoTargets', () => readAwsAuthOverview({ cliPath: resolveAwsBinary() }));

  ipcMain.handle('aws:ssoLogin', async (_e, { target, kind, mode }) => {
    // This handler is the trust boundary: `target` reaches both `spawn`
    // argv and — in terminal mode — an AppleScript `do script`. Validate
    // here, not only in the renderer.
    if (typeof target !== 'string' || !isSafeAwsName(target)) {
      return { ok: false as const, error: 'That profile name has characters overcli won\'t pass to a command.' };
    }
    if (kind !== 'profile' && kind !== 'sso-session') {
      return { ok: false as const, error: 'Unknown login target.' };
    }
    const binary = resolveAwsBinary();
    if (!binary) {
      return {
        ok: false as const,
        error: 'AWS CLI not found. Install aws-cli v2, then reopen this panel.',
      };
    }
    const command = awsSsoLoginCommand(binary, target, kind);
    if (mode === 'terminal') {
      const launched = await runInTerminal(command, 'aws-sso-login');
      return launched.ok
        ? { ok: true as const, output: `Running \`${command}\` in Terminal.` }
        : { ok: false as const, error: launched.error, command };
    }
    const res = await runAwsSsoLogin({
      binary,
      target,
      kind,
      env: awsEnv(),
      onUrl: (url) => {
        if (isSafeExternalUrl(url)) shell.openExternal(url);
      },
    });
    // A failure carries the command so the panel can offer it as a copyable
    // block — same convention as TerminalLaunchResult.
    return res.ok ? res : { ...res, command };
  });

  ipcMain.handle('fs:pickDirectory', async () => {
    if (!mainWindow) return null;
    const res = await dialog.showOpenDialog(mainWindow, {
      properties: ['openDirectory', 'multiSelections'],
    });
    if (res.canceled || res.filePaths.length === 0) return null;
    return res.filePaths;
  });
  ipcMain.handle('fs:fileInfo', (_e, args: { path: string; rootPath?: string }) =>
    fileInfo(args?.path ?? '', args?.rootPath),
  );
  ipcMain.handle('fs:readFile', (_e, args: { path: string; rootPath?: string }) => {
    const hint = args?.path ?? '';
    const resolved = resolveFilePath(hint, args?.rootPath);
    if (!resolved) {
      // Distinguish "file isn't on disk" from "file isn't under a known
      // root" — the old shared message blamed the project list even when
      // the real cause was a missing/renamed file the agent claimed to
      // have written.
      if (path.isAbsolute(hint) && isReadablePath(hint)) {
        return { ok: false, error: `File not found at ${hint}.` };
      }
      return {
        ok: false,
        error: `Could not find "${hint}" in any registered project.`,
      };
    }
    if (!isReadablePath(resolved)) {
      return {
        ok: false,
        error: 'File is outside any registered project, workspace, or worktree.',
      };
    }
    try {
      const stat = fs.statSync(resolved);
      if (stat.size > MAX_OPEN_FILE_BYTES) {
        return { ok: false, error: fileTooLargeMessage(stat.size) };
      }
      if (isKnownBinaryExtension(resolved) || isLikelyBinaryFile(resolved, stat.size)) {
        return {
          ok: false,
          error: 'This file cannot be previewed in Overcli. Open it with the system app or reveal it in Finder.',
        };
      }
      const content = fs.readFileSync(resolved, 'utf-8');
      if (content.includes('\0')) {
        return {
          ok: false,
          error: 'This file cannot be previewed in Overcli. Open it with the system app or reveal it in Finder.',
        };
      }
      return { ok: true, content, resolvedPath: resolved };
    } catch (err: any) {
      return { ok: false, error: err?.message ?? 'Could not read file' };
    }
  });
  ipcMain.handle('fs:readLargeTextPreview', (_e, args: { path: string; rootPath?: string }) =>
    readLargeTextPreview(args?.path ?? '', args?.rootPath),
  );
  ipcMain.handle('fs:readArtifactPreview', async (_e, args: { path: string; rootPath?: string }) =>
    readArtifactPreview(args?.path ?? '', args?.rootPath),
  );
  ipcMain.handle('fs:writeFile', (_e, { path: p, content, rootPath }) => {
    // Tabs opened from a workspace/flow diff keep their member-prefixed
    // relative path (`<member>/src/foo.ts`) so the ChangesBar and diff
    // logic can peel the prefix — reads already run that through the
    // resolver, and saving has to as well. Writing the hint as given made
    // `path.resolve` fall back to the main process cwd, which ENOENTs at
    // best and lands in an unrelated tree at worst.
    //
    // `resolveWriteTarget`, not the read cascade: see the note there for
    // why a write anchors on the caller's root instead of searching.
    const target = resolveWriteTarget(p, rootPath);
    if (!target) {
      return {
        ok: false,
        error: `Could not place "${p}" — no project root for this file.`,
      };
    }
    if (!isPathUnderRegisteredRoot(target)) {
      return {
        ok: false,
        error: 'File is outside any registered project, workspace, or worktree.',
      };
    }
    try {
      fs.writeFileSync(target, content, 'utf-8');
      return { ok: true };
    } catch (err: any) {
      return { ok: false, error: err?.message ?? 'Could not write file' };
    }
  });
  ipcMain.handle('fs:listFiles', (_e, root: string) => {
    if (!isPathUnderRegisteredRoot(root)) return [];
    return listFilesRecursive(root);
  });
  ipcMain.handle('fs:listFileEntries', (_e, root: string) => {
    if (!isPathUnderRegisteredRoot(root)) return Promise.resolve([]);
    return listFileEntriesShared(root);
  });
  // Live tree watching. The renderer's file tree lists its root once per
  // mount; without this, a file the agent writes only appears after the pane
  // is closed and reopened. The returned `key` is the resolved root the
  // change events carry.
  ipcMain.handle('fs:watchTree', (_e, root: string) => {
    if (!isPathUnderRegisteredRoot(root)) return { ok: false, key: path.resolve(root) };
    return watchTree(root, (key) => {
      // The walk's own cache would otherwise hand the renderer the same
      // stale listing it already has.
      fileListCache.delete(key);
      emitToRenderer({ type: 'fileTreeChanged', root: key });
    });
  });
  ipcMain.handle('fs:unwatchTree', (_e, root: string) => {
    unwatchTree(root);
  });
  ipcMain.handle('fs:openInFinder', (_e, p: string) => {
    if (!isReadablePath(p)) return;
    shell.showItemInFolder(p);
  });
  ipcMain.handle('fs:openPath', async (_e, p: string) => {
    const resolved = resolveFilePath(p);
    if (!resolved || !isReadablePath(resolved)) {
      return {
        ok: false,
        error: 'File is outside any registered project, workspace, or worktree.',
      };
    }
    const error = await shell.openPath(resolved);
    return error ? { ok: false, error } : { ok: true };
  });
  ipcMain.handle('fs:saveToDownloads', async (_e, p: string) => {
    const resolved = resolveFilePath(p);
    if (!resolved || !isReadablePath(resolved)) {
      return {
        ok: false,
        error: 'File is outside any registered project, workspace, or worktree.',
      };
    }
    try {
      const downloads = app.getPath('downloads');
      const parsed = path.parse(resolved);
      // Never clobber an existing download — same convention browsers use.
      let target = path.join(downloads, parsed.base);
      let n = 2;
      while (fs.existsSync(target)) {
        target = path.join(downloads, `${parsed.name} (${n})${parsed.ext}`);
        n += 1;
      }
      // Async copy, not copyFileSync: a large artifact would otherwise
      // freeze every IPC channel and the window for the whole copy.
      await fs.promises.copyFile(resolved, target);
      return { ok: true, savedPath: target };
    } catch (err: any) {
      return {
        ok: false,
        error: err?.message ?? 'Could not save to Downloads',
      };
    }
  });
  /// Shared guard for both symbol entry points: the file and the project
  /// root both have to be inside something the user registered.
  const resolveSymbolArgs = (
    args: { cwd?: string; filePath?: string; symbol?: string; line?: number } | undefined,
  ): { ok: true; cwd: string; filePath: string; symbol: string; line: number } | { ok: false; error: string } => {
    const filePath = resolveFilePath(args?.filePath ?? '');
    if (!filePath || !isReadablePath(filePath)) {
      return { ok: false, error: 'File is outside any registered project.' };
    }
    // The renderer sends the *conversation's* root. In a flow run that is
    // routinely not the tree the open file lives in — worktree runs mint a
    // worktree outside the project, and workspace/coordinator roots are
    // directories of symlinks. Searching the root as sent finds nothing
    // there, so resolve to the tree the file actually belongs to and
    // validate that, since it's the one we read.
    const cwd = resolveSearchRoot(filePath, args?.cwd ?? '');
    if (!cwd || !isPathUnderRegisteredRoot(cwd)) {
      return { ok: false, error: 'Project root is not registered.' };
    }
    if (!symbolLookup) {
      return { ok: false, error: 'Symbol lookup is not available.' };
    }
    return {
      ok: true,
      cwd,
      filePath,
      symbol: args?.symbol ?? '',
      line: args?.line ?? 1,
    };
  };

  ipcMain.handle('symbols:findDefinition', async (_e, args) => {
    const checked = resolveSymbolArgs(args);
    if (!checked.ok) return { ok: false as const, error: checked.error };
    return symbolLookup!.find(checked);
  });
  ipcMain.handle('symbols:refineDefinition', async (_e, args) => {
    const checked = resolveSymbolArgs(args);
    if (!checked.ok) return { ok: false as const, error: checked.error };
    return symbolLookup!.refine(checked);
  });
  ipcMain.handle(
    'flows:openArtifact',
    async (_e, { name, kind, body }: { name: string; kind: string; body: string }) => {
      // Flow artifacts have no on-disk path — materialize the body in a
      // temp dir and hand it to the OS default app. The name is sanitized
      // to a safe basename so it can't escape the temp dir.
      const ext = kind === 'markdown' ? '.md' : kind === 'diff' ? '.diff' : '.txt';
      const safeBase = (name || 'artifact').replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 80);
      const base = safeBase.toLowerCase().endsWith(ext) ? safeBase : `${safeBase}${ext}`;
      try {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'overcli-artifact-'));
        const file = path.join(dir, base);
        fs.writeFileSync(file, body, 'utf-8');
        const error = await shell.openPath(file);
        return error ? { ok: false, error } : { ok: true };
      } catch (err: any) {
        return { ok: false, error: err?.message ?? 'Could not open artifact' };
      }
    },
  );
  ipcMain.handle('preview:htmlAssets', (_e, args: { path: string; rootPath?: string; refs: string[] }) =>
      readHtmlPreviewAssets(
        {
          path: resolveFilePath(args?.path ?? '', args?.rootPath) ?? '',
          rootPath: args?.rootPath,
          refs: args?.refs ?? [],
        },
        isReadablePath,
      ),
  );
  ipcMain.handle('preview:reactBundle', (_e, args: { path: string; rootPath?: string; contents?: string }) =>
      buildReactPreviewBundle(
        {
          path: resolveFilePath(args?.path ?? '', args?.rootPath) ?? '',
          rootPath: args?.rootPath,
          contents: args?.contents,
        },
        { isReadable: isReadablePath },
      ),
  );
  ipcMain.handle('preview:publishDocument', (_e, args: { html: string; policy?: PreviewPolicy }) =>
      publishPreviewDocument(args?.html ?? '', args?.policy),
  );
  ipcMain.handle('preview:projectHints', (_e, args: { path: string; rootPath?: string }) =>
    projectPreviewHints(args?.path ?? '', args?.rootPath),
  );
  ipcMain.handle('preview:runProjectCommand', (_e, { cwd, command }: { cwd: string; command: string }) => {
      if (!isPathUnderRegisteredRoot(cwd)) {
      return {
        ok: false,
        error: 'Preview command cwd is outside registered project roots.',
      };
      }
      if (!/^[A-Za-z0-9 .:_/-]+$/.test(command)) {
      return {
        ok: false,
        error: 'Preview command contains unsupported characters.',
      };
      }
      return openTerminalAt(cwd, command, 'workspace-command');
  });

  ipcMain.handle('git:run', (_e, { args, cwd }) => {
    if (!isRendererSafeGitInvocation(args, cwd)) {
      return {
        stdout: '',
        stderr: 'Refused: git args outside the renderer allowlist.',
        exitCode: 1,
      };
    }
    return runGit(args, cwd);
  });
  ipcMain.handle('git:createWorktree', (_e, args) => createWorktree(args));
  ipcMain.handle('git:createReviewWorktree', (_e, args) => createReviewWorktree(args));
  ipcMain.handle('git:promoteReviewWorktree', (_e, args) => promoteReviewWorktree(args));
  ipcMain.handle('git:switchProjectToBranch', (_e, args) => switchProjectToBranch(args));
  ipcMain.handle('git:switchBranch', (_e, args) => switchBranch(args));
  ipcMain.handle('git:removeWorktree', (_e, args) => removeWorktree(args));
  // The renderer supplies conversation worktrees (it owns that state); the
  // flow runtime is asked here so a run's tree is never reported as an
  // orphan just because the renderer doesn't track runs.
  ipcMain.handle('git:scanWorktrees', (_e, args) => {
    const runPaths: string[] = [];
    for (const run of flowRuntime ? flowRuntime.listRuns() : []) {
      if (run.worktreePath) runPaths.push(run.worktreePath);
      for (const m of run.workspaceWorktrees ?? []) runPaths.push(m.worktreePath);
    }
    return scanWorktrees({ ...args, runPaths }, (p) => emitToRenderer({ type: 'worktreeScanProgress', ...p }));
  });
  ipcMain.handle('git:sweepWorktrees', (_e, args) => sweepWorktrees(args));
  ipcMain.handle('git:conversationWorktreeStates', (_e, args) => conversationWorktreeStates(args));
  ipcMain.handle('git:checkoutAgentLocally', (_e, args) => {
    const res = checkoutAgentLocally(args);
    if (!res.ok) return res;
    // Re-home the Claude session file from the worktree's cwd slug to the
    // project's cwd slug, so history replay and `--resume` still find it
    // now that the conversation's cwd has changed. No-op for non-Claude
    // backends (no file under that slug).
    if (args.sessionId) {
      migrateClaudeSessionCwd({
        worktreePath: args.worktreePath,
        projectPath: args.projectPath,
        sessionId: args.sessionId,
      });
    }
    return res;
  });
  ipcMain.handle('git:listBaseBranches', (_e, projectPath: string) => listBaseBranches(projectPath));
  ipcMain.handle('git:listBaseBranchesFresh', (_e, projectPath: string) => listBaseBranchesFresh(projectPath));
  ipcMain.handle('git:detectBaseBranch', (_e, projectPath: string) => detectBaseBranch(projectPath));
  ipcMain.handle('git:mergeAgent', (_e, args) => mergeAgent(args));
  ipcMain.handle('git:rebaseAgent', (_e, args) => rebaseAgent(args));
  ipcMain.handle('git:pushBranch', (_e, args) => pushBranch(args));
  ipcMain.handle('git:openPR', (_e, args) => openPR(args));
  ipcMain.handle('git:worktreeStatus', (_e, args) => worktreeStatus(args));
  ipcMain.handle('git:worktreeDiff', (_e, args) => worktreeDiff(args));
  ipcMain.handle('git:rescueMainTree', (_e, args) => rescueMainTree(args));
  ipcMain.handle('git:commitStatus', (_e, { cwd }) => commitStatus(cwd));
  ipcMain.handle('git:worktreeChanges', (_e, args) => worktreeChanges(args));
  ipcMain.handle('git:resolveDiffBase', (_e, args) => resolveDiffBase(args));
  ipcMain.handle('git:currentBranch', (_e, { cwd }) => currentBranch(cwd));
  ipcMain.handle('git:restoreFile', (_e, { cwd, path }) => {
    // Destructive git write — re-validate the cwd here rather than trusting
    // the renderer, mirroring the `git:run` allowlist gate.
    if (typeof cwd !== 'string' || typeof path !== 'string' || !isPathUnderRegisteredRoot(cwd)) {
      return {
        ok: false as const,
        error: 'Refused: path outside a registered project root.',
      };
    }
    return restoreFileToHead({ cwd, path });
  });
  ipcMain.handle('git:workspaceCommitStatus', (_e, { projects }) => workspaceCommitStatus(projects));
  ipcMain.handle('git:commitAll', (_e, args) => commitAll(args));
  ipcMain.handle('git:workspaceCommitAll', (_e, args) => workspaceCommitAll(args));
  ipcMain.handle('git:initRepo', async (_e, args) => {
    if (typeof args?.projectPath !== 'string' || !isPathUnderRegisteredRoot(args.projectPath)) {
      return {
        ok: false as const,
        error: 'Refused: path outside a registered project root.',
      };
    }
    return initRepo(args);
  });
  /// "Is git here?" — asked by any surface that promises undo, so it can say
  /// what is wrong before the user hits a raw git error.
  ipcMain.handle('git:availability', (_e, args) => gitAvailability({ refresh: args?.refresh === true }));
  /// Install git the same way Overcli installs everything else the user
  /// needs: a visible Terminal window they can watch and answer. On Linux
  /// there is no single command, so `runInTerminal` opens nothing and the
  /// caller shows the guidance instead.
  ipcMain.handle('git:install', async () => {
    const command = gitInstallCommand();
    if (!command) {
      return {
        ok: false as const,
        error: 'Install Git with your distribution’s package manager, then reopen this project.',
      };
    }
    const launched = await runInTerminal(command, 'git-install');
    // The install runs on in that window long after osascript returns, so
    // re-probing here would just re-cache "missing". Forget instead, and let
    // the next surface that cares ask a fresh question.
    forgetGitAvailability();
    return launched.ok ? { ok: true as const, command } : { ...launched, command };
  });
  ipcMain.handle('git:removeHistory', (_e, args) => {
    if (typeof args?.projectPath !== 'string' || !isPathUnderRegisteredRoot(args.projectPath)) {
      return {
        ok: false as const,
        error: 'Refused: path outside a registered project root.',
      };
    }
    return removeRepoHistory(args);
  });
  // Scaffold AND prepare in one handler. Doing the init here means the folder
  // is already a repo before the renderer registers it, so `addProject`'s own
  // git-status probe sees the truth on its first look.
  ipcMain.handle('fs:syncProjectMarkers', (_e, args) =>
    syncProjectMarkers(
      (Array.isArray(args?.projects) ? args.projects : []).filter(
        (p: { path?: unknown }) => typeof p?.path === 'string' && isPathUnderRegisteredRoot(p.path),
      ),
    ),
  );
  ipcMain.handle('fs:listDocuments', (_e, args) => {
    if (typeof args?.dirPath !== 'string' || !isPathUnderRegisteredRoot(args.dirPath)) {
      return {
        ok: false as const,
        error: 'Refused: path outside a registered project root.',
      };
    }
    return listDocuments(args);
  });
  ipcMain.handle('versions:checkpoint', (_e, args) => {
    if (typeof args?.projectPath !== 'string' || !isPathUnderRegisteredRoot(args.projectPath)) {
      return {
        ok: false as const,
        error: 'Refused: path outside a registered project root.',
      };
    }
    return checkpointProject(args, {
      statusPorcelain: checkpointStatusPorcelain,
      commit: commitAllAsync,
    });
  });
  ipcMain.handle('versions:list', (_e, args) => {
    if (typeof args?.projectPath !== 'string' || !isPathUnderRegisteredRoot(args.projectPath)) {
      return {
        ok: false as const,
        error: 'Refused: path outside a registered project root.',
      };
    }
    return listVersions(args);
  });
  ipcMain.handle('versions:diff', (_e, args) => {
    if (typeof args?.projectPath !== 'string' || !isPathUnderRegisteredRoot(args.projectPath)) {
      return {
        ok: false as const,
        error: 'Refused: path outside a registered project root.',
      };
    }
    if (typeof args?.sha !== 'string' || !/^[0-9a-f]{7,40}$/i.test(args.sha)) {
      return { ok: false as const, error: 'Refused: not a valid version id.' };
    }
    return readVersionDiff({
      cwd: args.projectPath,
      sha: args.sha,
      file: args.file,
    });
  });
  ipcMain.handle('versions:restore', (_e, args) => {
    if (typeof args?.projectPath !== 'string' || !isPathUnderRegisteredRoot(args.projectPath)) {
      return {
        ok: false as const,
        error: 'Refused: path outside a registered project root.',
      };
    }
    return restoreVersion(args);
  });
  ipcMain.handle('fs:cancelRevise', (_e, args) => {
    const requestId = typeof args?.requestId === 'string' ? args.requestId : '';
    return {
      stopped: requestId ? (runner?.cancelOneShot(requestId) ?? false) : false,
    };
  });
  ipcMain.handle('fs:reviseDocument', (_e, args) => {
    if (typeof args?.path !== 'string' || !isPathUnderRegisteredRoot(args.path)) {
      return {
        ok: false as const,
        error: 'Refused: path outside a registered project root.',
      };
    }
    if (args.rootPath !== undefined) {
      if (typeof args.rootPath !== 'string' || !isPathUnderRegisteredRoot(args.rootPath)) {
        return {
          ok: false as const,
          error: 'Refused: path outside a registered project root.',
        };
      }
      const rel = path.relative(args.rootPath, args.path);
      if (rel.startsWith('..') || path.isAbsolute(rel)) {
        return {
          ok: false as const,
          error: 'Refused: path outside a registered project root.',
        };
      }
    }
    const requestId = typeof args?.requestId === 'string' ? args.requestId : '';
    return reviseDocument(drafterDeps(), args, (text) => {
      if (requestId) flowAwareEmit({ type: 'documentRevise', requestId, text });
    });
  });
  ipcMain.handle('fs:createBlankDocument', (_e, args) => {
    if (typeof args?.dirPath !== 'string' || !isPathUnderRegisteredRoot(args.dirPath)) {
      return {
        ok: false as const,
        error: 'Refused: path outside a registered project root.',
      };
    }
    return createBlankDocument(args);
  });
  ipcMain.handle('fs:createDocumentFromPrompt', (_e, args) => {
    if (typeof args?.dirPath !== 'string' || !isPathUnderRegisteredRoot(args.dirPath)) {
      return {
        ok: false as const,
        error: 'Refused: path outside a registered project root.',
      };
    }
    return createDocumentFromPrompt(drafterDeps(), args);
  });
  ipcMain.handle('fs:copyIntoProject', (_e, args) => {
    if (typeof args?.projectPath !== 'string' || !isPathUnderRegisteredRoot(args.projectPath)) {
      return {
        ok: false as const,
        error: 'Refused: path outside a registered project root.',
      };
    }
    return copyIntoProject(args);
  });
  ipcMain.handle('fs:setEverydayMarker', (_e, args) => {
    if (typeof args?.projectPath !== 'string' || !isPathUnderRegisteredRoot(args.projectPath)) {
      return {
        ok: false as const,
        error: 'Refused: path outside a registered project root.',
      };
    }
    return setEverydayMarker(args.projectPath, args.everyday === true);
  });
  ipcMain.handle('fs:createEverydayProject', async (_e, args) => {
    const made = createEverydayProject({
      title: String(args?.title ?? ''),
      goal: String(args?.goal ?? ''),
    });
    if (!made.ok) return made;
    const init = await initRepo({ projectPath: made.path });
    // The folder is real either way — the caller registers it and starts a
    // conversation. `historyReason` is what lets the sheet explain the
    // missing undo honestly instead of inventing a cause.
    return init.ok
      ? { ...made, historyOn: true as const }
      : {
          ...made,
          historyOn: false as const,
          historyReason: init.reason,
          historyError: init.error,
        };
  });

  ipcMain.handle('workspace:ensureSymlinkRoot', (_e, { workspaceId, projects, instructions }) =>
    ensureWorkspaceSymlinkRoot(workspaceId, projects, instructions),
  );
  ipcMain.handle('workspace:removeSymlinkRoot', (_e, workspaceId: string) => removeWorkspaceSymlinkRoot(workspaceId));
  ipcMain.handle('workspace:ensureCoordinatorSymlinkRoot', (_e, { coordinatorId, members }) =>
    ensureCoordinatorSymlinkRoot(coordinatorId, members),
  );
  ipcMain.handle('workspace:rebindCoordinatorRootToProjects', (_e, { coordinatorId, projects }) =>
      rebindCoordinatorRootToProjects(coordinatorId, projects),
  );
  ipcMain.handle('workspace:removeCoordinatorSymlinkRoot', (_e, coordinatorId: string) =>
    removeCoordinatorSymlinkRoot(coordinatorId),
  );

  ipcMain.handle('app:openExternal', (_e, url: string) => {
    if (!isSafeExternalUrl(url)) return;
    return shell.openExternal(url);
  });
  ipcMain.handle('app:showAbout', () => {
    dialog.showMessageBox({
      type: 'info',
      title: 'About overcli',
      message: 'overcli',
      detail: 'Electron GUI wrapper around the Claude CLI.\nPorted from the Swift/SwiftUI build.',
    });
  });
  ipcMain.handle('app:reloadStats', () => computeStats());
  ipcMain.handle('app:refreshClaudeUsage', async () => (await refreshClaudeUsage()) !== null);

  // Cross-platform "an agent finished, look at me" attention nudge.
  // Skipped when the window is focused (the sidebar checkmark is enough)
  // and debounced so a batch of completions doesn't flash repeatedly.
  let lastAttentionAt = 0;
  const ATTENTION_DEBOUNCE_MS = 10_000;
  ipcMain.handle('app:notifyCompleted', () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    if (mainWindow.isFocused()) return;
    const now = Date.now();
    if (now - lastAttentionAt < ATTENTION_DEBOUNCE_MS) return;
    lastAttentionAt = now;
    if (process.platform === 'darwin') {
      // app.dock is undefined on Win/Linux; the platform check above
      // guards this, but we keep the optional chain for safety.
      app.dock?.bounce('informational');
    } else {
      // flashFrame(true) starts the flash; the OS clears it when the
      // user focuses the window. No need to flashFrame(false) on a
      // timer — that would steal the attention prematurely.
      mainWindow.flashFrame(true);
    }
  });

  ipcMain.handle('auth:openCliLogin', (_e, backend: Backend) => {
    if (backend === 'ollama') {
      return {
        ok: false,
        error: 'Ollama does not need CLI login — start the server from the banner.',
      };
    }
    const settings = Store.load().settings;
    const bin = resolveBackendPath(backend, settings.backendPaths[backend]);
    // Prefer the resolved absolute path so Terminal.app (which inherits a
    // different PATH than Electron) still finds the binary. If we couldn't
    // resolve it, fall back to the bare command — better than nothing.
    const cmd = bin ?? backend;
    const quoted = cmd.includes(' ') ? `"${cmd}"` : cmd;
    const args = backend === 'claude' ? 'auth login' : backend === 'codex' ? 'login' : 'auth login';
    return runInTerminal(`${quoted} ${args}`, 'agent-launch');
  });

  ipcMain.handle(
    'terminal:popConversation',
    (_e, { cwd, backend, sessionId, model }: { cwd: string; backend: Backend; sessionId?: string; model?: string }) => {
      if (backend === 'ollama') {
        return {
          ok: false,
          error: 'Ollama runs in-app — there is no CLI to resume in a terminal.',
        };
      }
      if (!isPathUnderRegisteredRoot(cwd)) {
        return {
          ok: false,
          error: 'Workspace path is not inside a registered project root.',
        };
      }
      // Only Claude/Gemini support `--resume`; Codex ignores sessionId
      // entirely when popping to terminal. Validate only the backends that
      // actually embed the ID into the shell command.
      const needsResumeId = backend === 'claude' || backend === 'gemini';
      // Session IDs come from backend CLIs (UUID-like for claude/gemini).
      // Anything with shell metacharacters is rejected so it can't escape
      // into the `do script` line as a separate command.
      if (needsResumeId && sessionId && !/^[A-Za-z0-9._-]+$/.test(sessionId)) {
        return {
          ok: false,
          error: 'Session ID contains unexpected characters.',
        };
      }
      const settings = Store.load().settings;
      const bin = resolveBackendPath(backend, settings.backendPaths[backend]);
      const cmd = bin ?? backend;
      const quoted = cmd.includes(' ') ? `"${cmd}"` : cmd;
      // Codex has no --resume flag; just drop the user into the interactive
      // TUI in the workspace and they can pick up from there.
      const resumeSuffix = sessionId && needsResumeId ? ` --resume ${sessionId}` : '';
      // Carry the session's model across. Without it the CLI resumes on its own
      // default and silently swaps the model out from under the conversation.
      // Same metacharacter guard as the session id — this lands in a `do script`
      // line, so anything exotic is dropped rather than escaped.
      const modelFlag = backend === 'claude' || backend === 'copilot' ? '--model' : '-m';
      const modelSuffix = model && /^[A-Za-z0-9._-]+$/.test(model) ? ` ${modelFlag} ${model}` : '';
      return openTerminalAt(cwd, `${quoted}${resumeSuffix}${modelSuffix}`, 'agent-launch');
    },
  );

  ipcMain.handle('terminal:openFolder', async (_e, { path: target }: { path: string }) => {
    // Same containment rule as popping a conversation out: only folders
    // inside a project, workspace or worktree the user has registered.
    if (!isPathUnderRegisteredRoot(target)) {
      return {
        ok: false,
        error: 'That folder is not inside a registered project root.',
      };
    }
    try {
      const stat = await fs.promises.stat(target);
      if (!stat.isDirectory()) {
        return { ok: false, error: 'That path is not a folder.' };
      }
    } catch {
      return { ok: false, error: 'That folder no longer exists.' };
    }
    return openTerminalIn(target, 'file-tree');
  });

  ipcMain.handle('ollama:detect', () => detectOllama());
  ipcMain.handle('ollama:hardware', () => detectHardware());
  ipcMain.handle('ollama:catalog', () => OLLAMA_CATALOG);
  ipcMain.handle('ollama:install', () =>
      installOllama((url) => {
        void shell.openExternal(url);
      }),
  );
  ipcMain.handle('ollama:startServer', () => ollamaServer.start());
  ipcMain.handle('ollama:stopServer', () => ollamaServer.requestStop());
  ipcMain.handle('ollama:serverStatus', () => ({
    status: ollamaServer.getStatus(),
    log: ollamaServer.getLog(),
  }));

  // Forward server log + status changes to the renderer as push events.
  ollamaServer.onLog((line) => emitToRenderer({ type: 'ollamaServerLog', line }));
  ollamaServer.onStatusChange((status) => emitToRenderer({ type: 'ollamaServerStatus', status }));
  ipcMain.handle('ollama:pullModel', async (_e, { tag }: { tag: string }) => {
    const controller = new AbortController();
    pendingPulls.set(tag, controller);
    const res = await pullModel(
      tag,
      (ev) => {
        emitToRenderer({
          type: 'ollamaPull',
          event: { ...ev, tag },
        });
      },
      controller.signal,
    );
    pendingPulls.delete(tag);
    return res;
  });
  ipcMain.handle('ollama:cancelPull', (_e, { tag }: { tag: string }) => {
    pendingPulls.get(tag)?.abort();
    pendingPulls.delete(tag);
  });
  ipcMain.handle('ollama:deleteModel', async (_e, { tag }: { tag: string }) => {
    return deleteModel(tag);
  });
  ipcMain.handle('ollama:deleteSession', (_e, sessionId: string) => {
    deleteOllamaSession(sessionId);
  });
  ipcMain.handle('ollama:securityAudit', async (_e, args?: { force?: boolean }) => {
    // Always re-derive via detectOllama() rather than trusting a path from
    // the renderer — the binary path here is spawned via spawnSync, and this
    // module has no business executing a path it did not find itself.
    const det = await detectOllama();
    return auditOllama({
      serverVersion: det.version,
      binaryPath: det.binaryPath,
      serverRunning: det.running,
      serverManaged: ollamaServer.isManaged(),
      force: args?.force,
    });
  });

  ipcMain.handle('ollama:applyFix', async (_e, { fixId }: { fixId: 'update-ollama' | 'restart-loopback' }) => {
      if (fixId === 'update-ollama') {
        // detectOllama() only fills installHint when Ollama is MISSING, so ask
        // Homebrew directly — a Mac that has brew but installed Ollama from
        // the .dmg must not be told to run `brew upgrade`.
        return updateOllama((url) => {
          void shell.openExternal(url);
        }, brewManagesOllama());
      }
      if (!ollamaServer.isManaged()) {
        return {
          ok: false,
          message: 'That server was started outside overcli — quit it, then start the server here.',
        };
      }
      ollamaServer.stop();
      await new Promise((r) => setTimeout(r, 1200));
      const res = await ollamaServer.start();
    return {
      ok: res.ok,
      message: `Restarted bound to 127.0.0.1 only. ${res.message}`,
    };
  });
  ipcMain.handle('diagnostics:list', () => listSilentLog());
  ipcMain.handle('diagnostics:clear', () => clearSilentLog());
  ipcMain.handle('diagnostics:log', (_e, args) => {
    // Renderer payload is untrusted: coerce scope/message and let log()
    // normalize the level so a malformed entry can't be silently dropped.
    const { level, scope, message } = (args ?? {}) as {
      level?: LogLevel;
      scope?: unknown;
      message?: unknown;
    };
    log(level ?? 'info', String(scope ?? 'renderer'), String(message ?? ''));
  });

  // Flows: library CRUD + tool catalog. The runtime handlers
  // (startRun/listRuns/etc.) are stubbed until Phase 4 wires
  // FlowRuntime; this gives the renderer something safe to call
  // through the IPC contract.
  ipcMain.handle('flows:list', (_e, args: { projectPaths?: string[] } = {}) =>
    loadAllFlows({ projectPaths: args.projectPaths }),
  );
  ipcMain.handle('flows:save', (_e, args) => saveFlow(args));
  ipcMain.handle('flows:runCounts', () => {
    const counts: Record<string, { count: number; lastAt: number }> = {};
    for (const s of loadRunSummaries()) {
      const c = counts[s.flowId] ?? (counts[s.flowId] = { count: 0, lastAt: 0 });
      c.count += 1;
      c.lastAt = Math.max(c.lastAt, s.terminalAt);
    }
    return counts;
  });
  ipcMain.handle('flows:delete', (_e, args) => {
    const blocker = flowDeletionBlocker(
      args.flowId,
      workerEngine?.list().map((r) => r.worker) ?? [],
      scheduler?.list() ?? [],
    );
    if (blocker) return { ok: false, error: blocker } as const;
    return deleteFlow(args);
  });
  ipcMain.handle('flows:validate', (_e, args) => validateFlowYaml(args));
  ipcMain.handle('flows:toolCatalog', (_e, args) => listToolCatalog(args));
  ipcMain.handle('flows:listTemplates', () => FLOW_TEMPLATES);
  ipcMain.handle('flows:draftFromPrompt', (_e, args) => draftFlowFromPrompt(args, drafterDeps()));
  ipcMain.handle('flows:reviseFromPrompt', (_e, args) => reviseFlowFromPrompt(args, drafterDeps()));
  ipcMain.handle('flows:startRun', (_e, args) =>
    flowRuntime ? flowRuntime.startRun(args) : ({ ok: false, error: 'Flow runtime not initialized.' } as const),
  );
  ipcMain.handle('flows:listRuns', async () =>
    flowRuntime
      ? {
          runs: flowRuntime.listRuns(),
          unreviewedRunIds: await flowRuntime.unreviewedDoneRunIds(),
        }
      : { runs: [], unreviewedRunIds: [] },
  );
  ipcMain.handle('flows:listUnreviewedRuns', async () => (flowRuntime ? await flowRuntime.unreviewedDoneRunIds() : []));
  ipcMain.handle('flows:getRun', (_e, { runId }) => (flowRuntime ? flowRuntime.getRun(runId) : null));
  ipcMain.handle('flows:resumeRun', (_e, args) =>
    flowRuntime ? flowRuntime.resumeRun(args) : ({ ok: false, error: 'Flow runtime not initialized.' } as const),
  );
  ipcMain.handle('flows:rerunFromStep', (_e, args) =>
    flowRuntime ? flowRuntime.rerunFromStep(args) : ({ ok: false, error: 'Flow runtime not initialized.' } as const),
  );
  ipcMain.handle('flows:adoptWorkspaceMembers', (_e, { runId }) =>
    flowRuntime
      ? flowRuntime.adoptPendingWorkspaceMembers(runId)
      : ({ ok: false, error: 'Flow runtime not initialized.' } as const),
  );
  ipcMain.handle('flows:dismissWorkspaceMembers', (_e, { runId }) =>
    flowRuntime
      ? flowRuntime.dismissWorkspaceMembers(runId)
      : ({ ok: false, error: 'Flow runtime not initialized.' } as const),
  );
  ipcMain.handle('flows:checkoutRunLocally', (_e, args) =>
    flowRuntime
      ? flowRuntime.checkoutRunLocally(args)
      : ({ ok: false, error: 'Flow runtime not initialized.' } as const),
  );
  ipcMain.handle('flows:abortRun', (_e, args) =>
    flowRuntime ? flowRuntime.abortRun(args) : ({ ok: false, error: 'Flow runtime not initialized.' } as const),
  );
  ipcMain.handle('flows:setModelOverride', (_e, { runId, participantId, model }) =>
    flowRuntime
      ? flowRuntime.setModelOverride(runId, participantId, model)
      : ({ ok: false, error: 'Flow runtime not initialized.' } as const),
  );
  ipcMain.handle('flows:renameRun', (_e, args) =>
    flowRuntime ? flowRuntime.renameRun(args) : ({ ok: false, error: 'Flow runtime not initialized.' } as const),
  );
  ipcMain.handle('flows:noteUserTurn', (_e, args) =>
    flowRuntime ? flowRuntime.noteUserTurn(args) : ({ ok: false, error: 'Flow runtime not initialized.' } as const),
  );
  ipcMain.handle('flows:steerRun', (_e, args) =>
    flowRuntime ? flowRuntime.steerRun(args) : ({ ok: false, error: 'Flow runtime not initialized.' } as const),
  );
  ipcMain.handle('flows:enterWatch', (_e, args) =>
    flowRuntime ? flowRuntime.enterWatch(args) : ({ ok: false, error: 'Flow runtime not initialized.' } as const),
  );
  ipcMain.handle('flows:archiveRun', (_e, args) =>
    flowRuntime ? flowRuntime.archiveRun(args) : ({ ok: false, error: 'Flow runtime not initialized.' } as const),
  );
  ipcMain.handle('flows:listWatchSources', () => listWatchSources());
  ipcMain.handle('flows:deleteRun', (_e, args) => {
    if (!flowRuntime) return { ok: false, error: 'Flow runtime not initialized.' } as const;
    const result = flowRuntime.deleteRun(args);
    if (result.ok) {
      emitToRenderer({ type: 'flowRunDeleted', runId: args.runId });
    }
    return result;
  });
  ipcMain.handle('flows:listRegistries', () => listRegistries());
  ipcMain.handle('flows:upsertRegistry', (_e, args) => upsertRegistry(args));
  ipcMain.handle('flows:removeRegistry', (_e, args) => removeRegistry(args));
  ipcMain.handle('flows:browseRegistry', (_e, args) => browseRegistries(args ?? {}));
  ipcMain.handle('flows:installFromRegistry', (_e, args) => installFromRegistry(args));
  ipcMain.handle('flows:previewRegistryFlow', (_e, args) => previewRegistryFlow(args));

  // Orchestrator: producer turn + batch dispatch over flows.
  ipcMain.handle('orchestrator:propose', (_e, args) =>
    orchestrator ? orchestrator.propose(args) : ({ ok: false, error: 'Orchestrator not initialized.' } as const),
  );
  ipcMain.handle('orchestrator:startBatch', (_e, args) =>
    orchestrator ? orchestrator.startBatch(args) : ({ ok: false, error: 'Orchestrator not initialized.' } as const),
  );
  ipcMain.handle('orchestrator:list', () => (orchestrator ? orchestrator.list() : []));
  ipcMain.handle('orchestrator:get', (_e, { id }) => (orchestrator ? orchestrator.get(id) : null));
  ipcMain.handle('orchestrator:abort', (_e, args) =>
    orchestrator ? orchestrator.abort(args) : ({ ok: false, error: 'Orchestrator not initialized.' } as const),
  );
  ipcMain.handle('orchestrator:retry', (_e, args) =>
    orchestrator ? orchestrator.retry(args) : ({ ok: false, error: 'Orchestrator not initialized.' } as const),
  );
  ipcMain.handle('orchestrator:approveBatch', (_e, args) =>
    orchestrator ? orchestrator.approveBatch(args) : ({ ok: false, error: 'Orchestrator not initialized.' } as const),
  );
  ipcMain.handle('orchestrator:rejectItem', (_e, args) =>
    orchestrator ? orchestrator.rejectItem(args) : ({ ok: false, error: 'Orchestrator not initialized.' } as const),
  );
  ipcMain.handle('orchestrator:delete', (_e, args) =>
    orchestrator ? orchestrator.delete(args) : ({ ok: false, error: 'Orchestrator not initialized.' } as const),
  );
  // Recent producer prompts live in their own tiny store, independent of
  // whether the orchestrator engine is up — they're just a UI convenience.
  ipcMain.handle('orchestrator:recentPrompts', () => listRecentPrompts());
  ipcMain.handle('orchestrator:recordRecentPrompt', (_e, { text }) => recordRecentPrompt(text));
  ipcMain.handle('orchestrator:deleteRecentPrompt', (_e, { text }) => deleteRecentPrompt(text));

  ipcMain.handle('schedules:list', () =>
    scheduler
      ? scheduler.list().map((schedule) => ({
          schedule,
          nextFireAt: scheduler!.nextFireAt(schedule.id),
        }))
      : [],
  );
  ipcMain.handle('schedules:save', (_e, { schedule }) =>
    scheduler ? scheduler.save(schedule) : ({ ok: false, error: 'Scheduler not initialized.' } as const),
  );
  ipcMain.handle('schedules:setEnabled', (_e, { id, enabled }) =>
    scheduler ? scheduler.setEnabled(id, enabled) : ({ ok: false, error: 'Scheduler not initialized.' } as const),
  );
  ipcMain.handle('schedules:delete', (_e, { id }) =>
    scheduler ? scheduler.remove(id) : ({ ok: false, error: 'Scheduler not initialized.' } as const),
  );
  ipcMain.handle('schedules:runNow', (_e, { id }) =>
    scheduler ? scheduler.runNow(id) : ({ ok: false, error: 'Scheduler not initialized.' } as const),
  );

  // Workers: standing personas that plan their own shifts.
  ipcMain.handle('workers:list', () => (workerEngine ? workerEngine.list() : []));
  ipcMain.handle('workers:save', (_e, { worker }) =>
    workerEngine ? workerEngine.save(worker) : ({ ok: false, error: 'Worker engine not initialized.' } as const),
  );
  ipcMain.handle('workers:note', (_e, { id, orchestrationId, note }) =>
    workerEngine
      ? workerEngine.note(id, orchestrationId, note)
      : ({ ok: false, error: 'Worker engine not initialized.' } as const),
  );
  ipcMain.handle('workers:setEnabled', (_e, { id, enabled }) =>
    workerEngine
      ? workerEngine.setEnabled(id, enabled)
      : ({ ok: false, error: 'Worker engine not initialized.' } as const),
  );
  ipcMain.handle('workers:setAutoRender', (_e, { id, autoRender }) =>
    workerEngine
      ? workerEngine.setAutoRender(id, autoRender)
      : ({ ok: false, error: 'Worker engine not initialized.' } as const),
  );
  ipcMain.handle('workers:setTrust', (_e, { id, trust }) =>
    workerEngine ? workerEngine.setTrust(id, trust) : ({ ok: false, error: 'Worker engine not initialized.' } as const),
  );
  ipcMain.handle('workers:delete', (_e, { id }) =>
    workerEngine ? workerEngine.remove(id) : ({ ok: false, error: 'Worker engine not initialized.' } as const),
  );
  ipcMain.handle('workers:workShiftNow', (_e, { id }) =>
    workerEngine ? workerEngine.workShiftNow(id) : ({ ok: false, error: 'Worker engine not initialized.' } as const),
  );
  ipcMain.handle('workers:runErrand', (_e, { id, instruction, attachments }) =>
    workerEngine
      ? workerEngine.runErrand(id, instruction, attachments)
      : ({ ok: false, error: 'Worker engine not initialized.' } as const),
  );
  ipcMain.handle('workers:reorder', (_e, { ids }) =>
    workerEngine ? workerEngine.reorder(ids) : ({ ok: true } as const),
  );
  ipcMain.handle('workers:treasury', () =>
    workerEngine
      ? workerEngine.treasury()
      : {
          treasury: { monthlyUSD: DEFAULT_TREASURY_USD },
          allocation: allocateTreasury([], () => 0, DEFAULT_TREASURY_USD),
        },
  );
  ipcMain.handle('workers:report', (_e, { sinceMs }) =>
    workerEngine
      ? workerEngine.report(sinceMs)
      : {
          generatedAt: Date.now(),
          sinceMs,
          byWorker: [],
          totals: emptyWorkerReportTotals(),
          daily: [],
        },
  );
  ipcMain.handle('workers:setTreasury', (_e, { monthlyUSD }) =>
    workerEngine
      ? workerEngine.setTreasury(monthlyUSD)
      : ({ ok: false, error: 'Worker engine not initialized.' } as const),
  );
  ipcMain.handle('workers:distributeFunds', () =>
    workerEngine ? workerEngine.distributeFunds() : ({ ok: false, error: 'Worker engine not initialized.' } as const),
  );
  ipcMain.handle('workers:files', (_e, { id }) => ({
    root: workerFilesDir(id),
    files: listWorkerFiles(id),
  }));
  ipcMain.handle('workers:file', (_e, { id, name }) => readWorkerFile(id, name));
  ipcMain.handle('workers:deleteFile', (_e, { id, name }) => deleteWorkerFile(id, name));
  ipcMain.handle('workers:deliverables', (_e, { id, task, label, title, at }) =>
    deliverableFiles({ workerId: id, task, label, title, at }),
  );
  ipcMain.handle('workers:deliverablesBatch', (_e, { requests }) =>
    (requests as Array<{ id: string; task: any; label: string; title: string; at: number }>).map((r) =>
      deliverableFiles({ workerId: r.id, task: r.task, label: r.label, title: r.title, at: r.at }),
    ),
  );
  ipcMain.handle('workers:revealFiles', (_e, { id }) => {
    try {
      shell.openPath(ensureWorkerFilesDir(id));
      return { ok: true } as const;
    } catch (err) {
      return {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      } as const;
    }
  });
  // Sharing a worker. The file is the JOB — see workerShare.ts for what is
  // deliberately left behind, and why an import lands in the hire editor
  // rather than on the roster.
  ipcMain.handle('workers:share', (_e, { id }) => {
    const worker = workerEngine?.list().find((row) => row.worker.id === id)?.worker;
    if (!worker) return { ok: false, error: 'No such worker.' } as const;
    const store = Store.load();
    const share = buildWorkerShare({
      worker,
      library: loadAllFlows({
        projectPaths: store.projects.map((p) => p.path),
      }),
    });
    return {
      ok: true,
      yaml: share.yaml,
      filename: share.filename,
      missingFlowIds: share.missingFlowIds,
    } as const;
  });
  ipcMain.handle('workers:shareToFile', async (_e, { id }) => {
    const worker = workerEngine?.list().find((row) => row.worker.id === id)?.worker;
    if (!worker) return { ok: false, error: 'No such worker.' } as const;
    const store = Store.load();
    const share = buildWorkerShare({
      worker,
      library: loadAllFlows({
        projectPaths: store.projects.map((p) => p.path),
      }),
    });
    if (!mainWindow) return { ok: false, error: 'No window to open a dialog from.' } as const;
    const res = await dialog.showSaveDialog(mainWindow, {
      title: `Share ${worker.name}`,
      defaultPath: share.filename,
      filters: [{ name: 'Worker', extensions: ['yaml', 'yml'] }],
    });
    if (res.canceled || !res.filePath) return { ok: true, filePath: null } as const;
    try {
      fs.writeFileSync(res.filePath, share.yaml, 'utf-8');
    } catch (err) {
      return {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      } as const;
    }
    return { ok: true, filePath: res.filePath } as const;
  });
  // Deploying a worker as a CI job. Shares the same bundle as workers:share;
  // ciPlanFor additionally resolves the worker's flows so buildCiDeploy can
  // see what backends they need.
  /// Which of a plan's files already exist with DIFFERENT contents, so the
  /// preview can say "replaces" before the write rather than reporting it
  /// afterwards. Same contents is not a replacement — re-deploying an
  /// unchanged worker should not look destructive.
  function existingOf(projectPath: string, files: Array<{ path: string; contents: string }>): string[] {
    if (!projectPath) return [];
    const out: string[] = [];
    for (const f of files) {
      try {
        const abs = path.join(projectPath, f.path);
        if (fs.existsSync(abs) && fs.readFileSync(abs, 'utf-8') !== f.contents) out.push(f.path);
      } catch {
        // Unreadable is not "will be replaced" — the write will report it.
      }
    }
    return out;
  }
  /// The workspace a worker is scoped to, resolved to something a pipeline can
  /// check out.
  ///
  /// Compared case-insensitively on macOS and Windows, and that is load-bearing
  /// rather than pedantic: a worker can hold
  /// `.../Application Support/overcli/workspaces/<id>` while the store holds
  /// `.../Application Support/Overcli/workspaces/<id>` — same directory on a
  /// case-insensitive volume, different string. A strict `===` reports every
  /// such worker as an ordinary project one.
  ///
  /// Members without a git remote are separated out rather than dropped: a
  /// local-only project cannot be reproduced on a runner, and a job that
  /// silently covered less of the workspace than it claimed would be worse
  /// than one that says so.
  function workspaceFor(projectPath: string): CiWorkspace | undefined {
    if (!projectPath) return undefined;
    const fold = (p: string) =>
      (process.platform === 'darwin' || process.platform === 'win32' ? p.toLowerCase() : p).replace(
        /\/+$/,
        '',
      );
    const target = fold(path.resolve(projectPath));
    const store = Store.load();
    const ws = store.workspaces.find((w) => w.rootPath && fold(path.resolve(w.rootPath)) === target);
    if (!ws) return undefined;

    const byId = new Map(store.projects.map((p) => [p.id, p]));
    const members: CiWorkspace['members'] = [];
    const unreachable: string[] = [];
    const seenDirs = new Set<string>();
    for (const pid of ws.projectIds ?? []) {
      const project = byId.get(pid);
      if (!project?.path) continue;
      const remote = originRemote(project.path);
      if (!remote) {
        unreachable.push(project.name);
        continue;
      }
      // Directory names must be unique and path-safe: two projects called
      // "api" in different orgs would otherwise check out over each other.
      let dir = project.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'member';
      let n = 2;
      while (seenDirs.has(dir)) dir = `${dir}-${n++}`;
      seenDirs.add(dir);
      members.push({ name: project.name, dir, remote });
    }
    return { name: ws.name, members, unreachable };
  }

  function ciPlanFor(
    id: string,
    target: 'github' | 'jenkins',
    permissionPolicy?: import('../shared/flows/ciDeploy').WorkerCiPermissionPolicy,
  ) {
    const worker = workerEngine?.list().find((row) => row.worker.id === id)?.worker;
    if (!worker) return { ok: false as const, error: 'No such worker.' };
    const store = Store.load();
    const library = loadAllFlows({ projectPaths: store.projects.map((p) => p.path) });
    const share = buildWorkerShare({ worker, library });
    const flows = worker.flowIds
      .map((fid) => library.find((f) => f.id === fid))
      .filter((f): f is NonNullable<typeof f> => Boolean(f));
    return {
      ok: true as const,
      worker,
      plan: buildCiDeploy({
        worker,
        flows,
        target,
        permissionPolicy,
        workerYaml: share.yaml,
        missingFlowIds: share.missingFlowIds,
        workspace: workspaceFor(worker.projectPath),
      }),
    };
  }
  ipcMain.handle('workers:ciDeploy', (_e, { id, target, permissionPolicy }) => {
    const res = ciPlanFor(id, target, permissionPolicy);
    if (!res.ok) return res;
    return {
      ok: true,
      files: res.plan.files,
      steps: res.plan.steps,
      notes: res.plan.notes,
      warnings: res.plan.warnings,
      toolNotice: res.plan.toolNotice,
      block: res.plan.block ?? null,
      existing: existingOf(res.worker.projectPath, res.plan.files),
      projectPath: res.worker.projectPath,
    } as const;
  });
  ipcMain.handle('workers:ciDeployWrite', (_e, { id, target, permissionPolicy }) => {
    const res = ciPlanFor(id, target, permissionPolicy);
    if (!res.ok) return res;
    if (!res.worker.projectPath) {
      return { ok: false, error: 'This worker has no project to write into.' } as const;
    }
    // Enforced here as well as in the UI: the renderer disables the button,
    // but the handler is what actually touches the disk.
    if (res.plan.block) {
      return { ok: false, error: res.plan.block.reason } as const;
    }
    const written: string[] = [];
    // Every generated file says "Safe to edit" in its own header, so a
    // second Preview → Write is a real hazard: it would silently clobber
    // whatever the user changed since the first write. Reported rather than
    // blocked — this dialog has no "cancel", and the files ARE regenerated
    // from the worker on every write — but the caller needs to know which
    // ones it just replaced.
    const overwritten: string[] = [];
    try {
      for (const file of res.plan.files) {
        const abs = path.join(res.worker.projectPath, file.path);
        if (fs.existsSync(abs)) {
          const prior = fs.readFileSync(abs, 'utf-8');
          if (prior !== file.contents) overwritten.push(file.path);
        }
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        fs.writeFileSync(abs, file.contents, 'utf-8');
        written.push(file.path);
      }
    } catch (err) {
      return {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      } as const;
    }
    return { ok: true, written, overwritten } as const;
  });
  // The flow twin of workers:ciDeploy. Simpler because a flow has no cadence,
  // trust, journal or budget — see buildFlowCiDeploy.
  function flowCiPlanFor(
    flowId: string,
    target: 'github' | 'jenkins',
    prompt?: string,
    /// Project path OR workspace root the job should cover.
    scope = '',
  ) {
    const store = Store.load();
    const flow = loadAllFlows({ projectPaths: store.projects.map((p) => p.path) }).find(
      (f) => f.id === flowId,
    );
    if (!flow) return { ok: false as const, error: `Flow "${flowId}" not found.` };
    return {
      ok: true as const,
      plan: buildFlowCiDeploy({
        flow,
        target,
        flowYaml: serializeFlow(flow),
        prompt,
        // The chosen target may be a workspace rather than a project — a flow
        // that reads across sixteen repos is exactly the shape a runner suits.
        workspace: workspaceFor(scope),
      }),
    };
  }
  ipcMain.handle('flows:ciDeploy', (_e, { flowId, target, projectPath, prompt }) => {
    const res = flowCiPlanFor(flowId, target, prompt, projectPath);
    if (!res.ok) return res;
    return {
      ok: true,
      files: res.plan.files,
      steps: res.plan.steps,
      notes: res.plan.notes,
      warnings: res.plan.warnings,
      toolNotice: res.plan.toolNotice,
      block: res.plan.block ?? null,
      existing: existingOf(projectPath, res.plan.files),
    } as const;
  });
  ipcMain.handle('flows:ciDeployWrite', (_e, { flowId, target, projectPath, prompt }) => {
    const res = flowCiPlanFor(flowId, target, prompt, projectPath);
    if (!res.ok) return res;
    if (!projectPath) return { ok: false, error: 'No project to write into.' } as const;
    // A workspace root is not a repository — enforced here as well as in the
    // UI, because this handler is what touches the disk.
    if (res.plan.block) return { ok: false, error: res.plan.block.reason } as const;
    const written: string[] = [];
    const overwritten: string[] = [];
    try {
      for (const file of res.plan.files) {
        const abs = path.join(projectPath, file.path);
        if (fs.existsSync(abs) && fs.readFileSync(abs, 'utf-8') !== file.contents) {
          overwritten.push(file.path);
        }
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        fs.writeFileSync(abs, file.contents, 'utf-8');
        written.push(file.path);
      }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) } as const;
    }
    return { ok: true, written, overwritten } as const;
  });
  ipcMain.handle('ci:saveFile', async (_e, { defaultName, contents }) => {
    if (!mainWindow) return { ok: false, error: 'No window to open a dialog from.' } as const;
    const res = await dialog.showSaveDialog(mainWindow, {
      title: `Save ${defaultName}`,
      defaultPath: defaultName,
    });
    if (res.canceled || !res.filePath) return { ok: true, filePath: null } as const;
    try {
      fs.writeFileSync(res.filePath, contents, 'utf-8');
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) } as const;
    }
    return { ok: true, filePath: res.filePath } as const;
  });
  ipcMain.handle('workers:import', (_e, { yaml }) => receiveWorkerYaml(yaml));
  ipcMain.handle('workers:importFromFile', async () => {
    if (!mainWindow) return { ok: false, error: 'No window to open a dialog from.' } as const;
    const res = await dialog.showOpenDialog(mainWindow, {
      title: 'Import a worker',
      properties: ['openFile'],
      filters: [{ name: 'Worker', extensions: ['yaml', 'yml'] }],
    });
    if (res.canceled || res.filePaths.length === 0) return { ok: true, canceled: true } as const;
    let body: string;
    try {
      body = fs.readFileSync(res.filePaths[0], 'utf-8');
    } catch (err) {
      return {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      } as const;
    }
    return receiveWorkerYaml(body);
  });
  ipcMain.handle('workers:journal', (_e, { id }) => (workerEngine ? workerEngine.journalFor(id) : []));
  ipcMain.handle('workers:deleteActivity', (_e, { id, orchestrationId }) =>
    workerEngine
      ? workerEngine.forgetActivity(id, orchestrationId)
      : ({ ok: false, error: 'Workers are not running.' } as const),
  );
  ipcMain.handle('workers:redoShift', (_e, { id, orchestrationId }) =>
    workerEngine
      ? workerEngine.redoShift(id, orchestrationId)
      : ({ ok: false, error: 'Workers are not running.' } as const),
  );
  ipcMain.handle('workers:resetMemory', (_e, { id }) =>
    workerEngine ? workerEngine.resetMemory(id) : ({ ok: false, error: 'Workers are not running.' } as const),
  );
  ipcMain.handle('workers:personalizeScan', async (_e, { name, jobDescription, flowId }) => {
    const store = Store.load();
    const flow = flowId
      ? loadAllFlows({ projectPaths: store.projects.map((p) => p.path) }).find((f) => f.id === flowId)
      : undefined;
    const res = await personalizeImportedWorker({ name, jobDescription, flow }, drafterDeps());
    if (!res.ok) return res;
    // Pre-fill in main rather than shipping the whole profile to the renderer:
    // the profile is the only personal record this app keeps, and the only
    // thing the import form needs from it is the answers to the questions it
    // is about to ask.
    return {
      ok: true,
      questions: prefillFromProfile(res.questions, loadUserProfile()),
      note: res.note,
    } as const;
  });
  ipcMain.handle('workers:rememberProfile', (_e, { questions }) => ({
    ok: true,
    profile: saveUserProfile(rememberAnswers(loadUserProfile(), questions ?? [], Date.now())),
  }));
  ipcMain.handle('workers:profile', () => ({ ok: true, profile: loadUserProfile() }));
  ipcMain.handle('workers:forgetProfile', (_e, { key } = {}) => ({
    ok: true,
    profile: forgetProfileFact(key),
  }));
  ipcMain.handle('workers:draftFromPrompt', (_e, { jobDescription, attachments }) => {
    const store = Store.load();
    return draftWorkerFromPrompt(
      {
        jobDescription,
        attachments,
        flows: loadAllFlows({
          projectPaths: store.projects.map((p) => p.path),
        }).map((f) => ({
          id: f.id,
          name: f.name,
          description: f.description,
        })),
        // Workspaces first: a job that names one should land on the whole
        // workspace, not one member repo that happens to share the name.
        projects: [
          ...store.workspaces.map((w) => ({
            name: w.name,
            path: w.rootPath,
            kind: 'workspace' as const,
          })),
          ...store.projects.map((p) => ({
            name: p.name,
            path: p.path,
            kind: 'project' as const,
          })),
        ],
      },
      drafterDeps(),
    );
  });
  ipcMain.handle(
    'workers:reviseFromPrompt',
    (_e, { jobDescription, flowId, flow: unsavedFlow, instruction, attachments }) => {
      const store = Store.load();
      // An unsaved ride-along flow (hire-drafted, or already revised once)
      // is the freshest state and can't be found on disk — prefer it.
      const flow =
        unsavedFlow ??
        (flowId
          ? loadAllFlows({
              projectPaths: store.projects.map((p) => p.path),
            }).find((f) => f.id === flowId)
          : undefined);
      return reviseWorkerFromPrompt({ jobDescription, instruction, flow, attachments }, drafterDeps());
    },
  );
}

// In-flight Ollama pulls, keyed by model tag. Cancelling is just aborting
// the HTTP request we opened in pullModel.
const pendingPulls = new Map<string, AbortController>();

function fileInfo(hint: string, rootPath?: string) {
  const resolved = resolveFilePath(hint, rootPath);
  if (!resolved) {
    if (path.isAbsolute(hint) && isReadablePath(hint)) {
      return { ok: false, missing: true, error: `File not found at ${hint}.` };
    }
    return {
      ok: false,
      missing: true,
      error: `Could not find "${hint}" in any registered project.`,
    };
  }
  if (!isReadablePath(resolved)) {
    return {
      ok: false,
      error: 'File is outside any registered project, workspace, or worktree.',
    };
  }
  try {
    const stat = fs.statSync(resolved);
    if (!stat.isFile()) return { ok: false, error: 'Path is not a regular file.' };
    const artifactPreview =
      isArtifactPreviewExtension(resolved) || isDesignCanvasFile(resolved, stat.size);
    const largeText = !artifactPreview && stat.size > MAX_TEXT_FILE_BYTES && stat.size <= MAX_OPEN_FILE_BYTES;
    const tooLarge = stat.size > MAX_OPEN_FILE_BYTES;
    const unsupportedBinary =
      !artifactPreview && (isKnownBinaryExtension(resolved) || isLikelyBinaryFile(resolved, stat.size));
    return {
      ok: true,
      resolvedPath: resolved,
      sizeBytes: stat.size,
      tooLarge,
      largeText,
      unsupportedBinary,
      error: tooLarge
        ? fileTooLargeMessage(stat.size)
        : unsupportedBinary
          ? 'This file cannot be previewed in Overcli. Open it with the system app or reveal it in Finder.'
          : undefined,
    };
  } catch (err: any) {
    if (err?.code === 'ENOENT') {
      return {
        ok: false,
        missing: true,
        error: `File not found at ${resolved}.`,
      };
    }
    return { ok: false, error: err?.message ?? 'Could not inspect file' };
  }
}

function readLargeTextPreview(hint: string, rootPath?: string) {
  const resolved = resolveFilePath(hint, rootPath);
  if (!resolved)
    return {
      ok: false,
      error: `Could not find "${hint}" in any registered project.`,
    };
  if (!isReadablePath(resolved)) {
    return {
      ok: false,
      error: 'File is outside any registered project, workspace, or worktree.',
    };
  }
  try {
    const stat = fs.statSync(resolved);
    if (stat.size > MAX_OPEN_FILE_BYTES) return { ok: false, error: fileTooLargeMessage(stat.size) };
    if (isKnownBinaryExtension(resolved) || isLikelyBinaryFile(resolved, stat.size)) {
      return {
        ok: false,
        error: 'This file cannot be previewed in Overcli. Open it with the system app or reveal it in Finder.',
      };
    }
    const fd = fs.openSync(resolved, 'r');
    try {
      const size = Math.min(stat.size, LARGE_TEXT_PREVIEW_BYTES);
      const buffer = Buffer.alloc(size);
      const bytesRead = fs.readSync(fd, buffer, 0, size, 0);
      return {
        ok: true,
        content: buffer.subarray(0, bytesRead).toString('utf-8'),
        resolvedPath: resolved,
        truncated: stat.size > bytesRead,
        totalBytes: stat.size,
        previewBytes: bytesRead,
      };
    } finally {
      fs.closeSync(fd);
    }
  } catch (err: any) {
    return {
      ok: false,
      error: err?.message ?? 'Could not read large text preview',
    };
  }
}

async function readArtifactPreview(hint: string, rootPath?: string): Promise<ArtifactPreviewResult> {
  const resolved = resolveFilePath(hint, rootPath);
  if (!resolved)
    return {
      ok: false,
      error: `Could not find "${hint}" in any registered project.`,
    };
  if (!isReadablePath(resolved)) {
    return {
      ok: false,
      error: 'File is outside any registered project, workspace, or worktree.',
    };
  }
  try {
    const stat = fs.statSync(resolved);
    const ext = path.extname(resolved).slice(1).toLowerCase();
    const officeFamily = officeFamilyForExtension(ext);
    if (officeFamily) {
      const converted = await convertOfficeToPreview(resolved, officeFamily, MAX_OPEN_FILE_BYTES);
      return {
        ok: true,
        kind: 'office',
        resolvedPath: resolved,
        sizeBytes: stat.size,
        extension: ext,
        family: officeFamily,
        ...converted,
      };
    }

    const mimeType = mimeForPreviewExtension(ext);
    if (!mimeType)
      return {
        ok: false,
        error: `No artifact preview available for .${ext || 'file'}.`,
      };
    if (stat.size > MAX_OPEN_FILE_BYTES) return { ok: false, error: fileTooLargeMessage(stat.size) };
    if (mimeType === 'application/pdf') {
      const data = fs.readFileSync(resolved).toString('base64');
      return {
        ok: true,
        kind: 'pdf',
        resolvedPath: resolved,
        sizeBytes: stat.size,
        mimeType,
        fileUrl: pathToFileUrl(resolved),
        dataUrl: `data:${mimeType};base64,${data}`,
      };
    }
    const data = fs.readFileSync(resolved).toString('base64');
    return {
      ok: true,
      kind: 'image',
      resolvedPath: resolved,
      sizeBytes: stat.size,
      mimeType,
      dataUrl: `data:${mimeType};base64,${data}`,
    };
  } catch (err: any) {
    return {
      ok: false,
      error: err?.message ?? 'Could not read artifact preview',
    };
  }
}

function pathToFileUrl(filePath: string): string {
  const normalized = path.resolve(filePath).replace(/\\/g, '/');
  const prefixed = normalized.startsWith('/') ? normalized : `/${normalized}`;
  return encodeURI(`file://${prefixed}`);
}

function fileTooLargeMessage(bytes: number): string {
  return `File is ${formatMegabytes(bytes)} MB. Overcli only opens files under 5 MB.`;
}

function formatMegabytes(bytes: number): string {
  return Math.max(1, Math.ceil(bytes / 1024 / 1024)).toString();
}

const BINARY_EXTENSIONS = new Set([
  '7z',
  'a',
  'app',
  'avi',
  'bin',
  'bz2',
  'class',
  'dmg',
  'dll',
  'dylib',
  'eot',
  'exe',
  'gz',
  'icns',
  'jar',
  'mov',
  'mp3',
  'mp4',
  'o',
  'otf',
  'pkg',
  'rar',
  'so',
  'sqlite',
  'sqlite3',
  'tar',
  'tgz',
  'ttf',
  'war',
  'wasm',
  'woff',
  'woff2',
  'xz',
  'zip',
]);

function isKnownBinaryExtension(filePath: string): boolean {
  const ext = path.extname(filePath).slice(1).toLowerCase();
  return BINARY_EXTENSIONS.has(ext);
}

function isArtifactPreviewExtension(filePath: string): boolean {
  const ext = path.extname(filePath).slice(1).toLowerCase();
  return !!mimeForPreviewExtension(ext) || !!officeFamilyForExtension(ext);
}

/// A design canvas published by Claude Code's `/design` skill: one HTML file
/// holding both the canvas editor and the design content (the `.dc.html`
/// artboards live in a JSON script block inside it). The editor alone is
/// ~2.4 MB, so every canvas trips the large-text cap and would render as a
/// truncated wall of minified source instead of as the design it is.
///
/// Sniffed rather than assumed from the extension, because the thing we want
/// to exempt is this specific generated shape, not every large .html on disk.
/// Both markers sit in the head, inside the first kilobyte.
function isDesignCanvasFile(filePath: string, sizeBytes: number): boolean {
  if (path.extname(filePath).toLowerCase() !== '.html') return false;
  if (sizeBytes === 0) return false;
  let fd: number | null = null;
  try {
    fd = fs.openSync(filePath, 'r');
    const sample = Buffer.alloc(Math.min(sizeBytes, 4096));
    const bytesRead = fs.readSync(fd, sample, 0, sample.length, 0);
    const head = sample.subarray(0, bytesRead).toString('utf8');
    return head.includes('appifact-capabilities') || head.includes('design canvas published from Claude Code');
  } catch {
    return false;
  } finally {
    if (fd !== null) fs.closeSync(fd);
  }
}

function isLikelyBinaryFile(filePath: string, sizeBytes: number): boolean {
  if (sizeBytes === 0) return false;
  const fd = fs.openSync(filePath, 'r');
  try {
    const sample = Buffer.alloc(Math.min(sizeBytes, 4096));
    const bytesRead = fs.readSync(fd, sample, 0, sample.length, 0);
    if (sample.subarray(0, bytesRead).includes(0)) return true;
    let controlBytes = 0;
    for (let i = 0; i < bytesRead; i += 1) {
      const byte = sample[i];
      const allowedWhitespace = byte === 9 || byte === 10 || byte === 12 || byte === 13;
      if (byte < 32 && !allowedWhitespace) controlBytes += 1;
    }
    return bytesRead > 0 && controlBytes / bytesRead > 0.08;
  } catch {
    return false;
  } finally {
    fs.closeSync(fd);
  }
}

function projectPreviewHints(hint: string, rootPath?: string): ProjectPreviewHintsResult {
  const resolved = resolveFilePath(hint, rootPath);
  if (!resolved)
    return {
      ok: false,
      error: `Could not find "${hint}" in any registered project.`,
    };
  const packageRoot = findNearestPackageRoot(path.dirname(resolved));
  if (!packageRoot) return { ok: false, error: 'No package.json found for this component.' };
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(packageRoot, 'package.json'), 'utf-8'));
    const scripts = typeof pkg?.scripts === 'object' && pkg.scripts ? pkg.scripts : {};
    const packageManager = detectPackageManager(packageRoot);
    const commands = previewCommandsForScripts(scripts, packageManager);
    if (commands.length === 0) {
      return {
        ok: false,
        error: 'No dev, preview, Storybook, or visual test scripts found.',
      };
    }
    return { ok: true, rootPath: packageRoot, packageManager, commands };
  } catch (err: any) {
    return {
      ok: false,
      error: err?.message ?? 'Could not read package preview scripts.',
    };
  }
}

/// Take a worker share file: install the flows it carries that this library
/// is missing, and hand back the worker for the hire editor. Nothing is
/// hired here — see src/main/flows/workerShare.ts.
function receiveWorkerYaml(yaml: string) {
  const store = Store.load();
  const library = loadAllFlows({
    projectPaths: store.projects.map((p) => p.path),
  });
  const res = importWorkerYaml({
    yaml: typeof yaml === 'string' ? yaml : '',
    existingFlowIds: library.map((f) => f.id),
    // User-global, like any other flow you install from a registry: the
    // importer has not told us which project this worker will watch yet, so
    // there is no project directory to write it into.
    saveFlow: (flow) => {
      const saved = saveFlow({ flow, target: 'user' });
      return saved.ok ? ({ ok: true } as const) : ({ ok: false, error: saved.error } as const);
    },
  });
  if (!res.ok) return { ok: false, error: res.error } as const;
  return {
    ok: true,
    worker: res.result.bundle.worker,
    notes: res.result.notes,
    summary: describeImport(res.result.notes),
  } as const;
}

function findNearestPackageRoot(start: string): string | null {
  let current = path.resolve(start);
  while (isPathUnderRegisteredRoot(current)) {
    if (fs.existsSync(path.join(current, 'package.json'))) return current;
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return null;
}

function detectPackageManager(root: string): 'npm' | 'pnpm' | 'yarn' {
  if (fs.existsSync(path.join(root, 'pnpm-lock.yaml'))) return 'pnpm';
  if (fs.existsSync(path.join(root, 'yarn.lock'))) return 'yarn';
  return 'npm';
}

function previewCommandsForScripts(
  scripts: Record<string, unknown>,
  packageManager: 'npm' | 'pnpm' | 'yarn',
): ProjectPreviewCommand[] {
  const commands: ProjectPreviewCommand[] = [];
  const add = (id: string, label: string, kind: ProjectPreviewCommand['kind']) => {
    if (typeof scripts[id] !== 'string') return;
    commands.push({
      id,
      label,
      kind,
      command: scriptCommand(packageManager, id),
    });
  };
  add('dev', 'Run dev server', 'dev');
  add('start', 'Run start', 'dev');
  add('storybook', 'Run Storybook', 'storybook');
  add('preview', 'Run preview server', 'preview');
  add('test:visual', 'Run visual tests', 'test');
  add('test:e2e', 'Run e2e tests', 'test');
  return commands;
}

function scriptCommand(packageManager: 'npm' | 'pnpm' | 'yarn', script: string): string {
  if (packageManager === 'yarn') return `yarn ${script}`;
  if (packageManager === 'pnpm') return `pnpm run ${script}`;
  return script === 'start' ? 'npm start' : `npm run ${script}`;
}

function mimeForPreviewExtension(ext: string): string | null {
  switch (ext) {
    case 'pdf':
      return 'application/pdf';
    case 'png':
      return 'image/png';
    case 'jpg':
    case 'jpeg':
      return 'image/jpeg';
    case 'gif':
      return 'image/gif';
    case 'webp':
      return 'image/webp';
    case 'svg':
      return 'image/svg+xml';
    case 'bmp':
      return 'image/bmp';
    case 'ico':
      return 'image/x-icon';
    default:
      return null;
  }
}

// Collect every directory the user has explicitly registered with the app
// (projects, workspaces, worktrees). Filesystem IPC handlers treat these
// as the only legal roots — a compromised renderer can't reach into
// `~/.ssh/` or `~/Library/LaunchAgents/` because those aren't registered.
function registeredRoots(): string[] {
  const state = Store.load();
  const roots = new Set<string>();
  for (const project of state.projects) {
    if (project.path) roots.add(project.path);
    for (const c of project.conversations ?? []) {
      if (c.worktreePath) roots.add(c.worktreePath);
    }
  }
  for (const workspace of state.workspaces) {
    if (workspace.rootPath) roots.add(workspace.rootPath);
    for (const c of workspace.conversations ?? []) {
      if (c.worktreePath) roots.add(c.worktreePath);
      if (c.coordinatorRootPath) roots.add(c.coordinatorRootPath);
    }
  }
  // Flow runs launched in a worktree live outside the project/workspace
  // tree — single-project runs fork a worktree, workspace runs fork one
  // PER member and front them with a coordinator symlink root. None of
  // these are registered above, so opening a ChangesBar file (which
  // realpaths through the coordinator symlink to the worktree) would be
  // rejected as "outside any registered root". Register every live run's
  // cwd + worktree paths so the file viewer/diff can reach them.
  if (flowRuntime) {
    for (const run of flowRuntime.listRuns()) {
      if (run.projectPath) roots.add(run.projectPath);
      if (run.worktreePath) roots.add(run.worktreePath);
      for (const w of run.workspaceWorktrees ?? []) {
        if (w.worktreePath) roots.add(w.worktreePath);
      }
    }
  }
  // Each worker's own directory. It lives under userData rather than in a
  // project, so nothing above registers it and the file viewer rejected every
  // deliverable a worker filed — the Files tab could list them and not open
  // one. Registered PER WORKER, never by the shared parent: the editor is
  // already scoped to one worker's root, and registering `worker-files/`
  // itself would make every colleague's directory legal to read through a
  // path that merely resolves inside it.
  if (workerEngine) {
    for (const workerId of workerEngine.workerIds()) {
      try {
        roots.add(workerFilesDir(workerId));
      } catch {
        // An id that isn't path-safe can't have a directory to register.
      }
    }
  }
  return [...roots];
}

// Containment checks compare a target against the realpath'd form of every
// registered root. Computing that means a `realpathSync` per root on EVERY
// file IPC call (open / preview / diff / git) — and each syscall is
// intercepted by on-access antivirus, so on a busy machine these dominate
// file-open latency.
//
// `realpath` of a registered directory is effectively immutable for the app's
// lifetime, so memoize it per raw path. The root *set* is NOT cached —
// `registeredRoots()` is recomputed fresh each call (cheap: in-memory store
// state only, no syscalls) — so a newly-added project or flow-run
// worktree is recognized immediately and a removed one drops out at once.
// Only successful realpaths are memoized; a root not yet on disk (a worktree
// registered just before it's created) is retried each call until it exists.
const rootRealpathMemo = new Map<string, string>();

function realpathRoot(root: string): string | null {
  const key = path.resolve(root);
  const memo = rootRealpathMemo.get(key);
  if (memo !== undefined) return memo;
  try {
    // `.native` (vs plain realpathSync) canonicalizes CASE on case-insensitive
    // filesystems (macOS/Windows). A registered root persisted with different
    // casing than the live userData dir — e.g. `.../overcli/…` vs the on-disk
    // `.../Overcli/…` after an app-name case change — resolves to the same
    // directory, and normalizing both sides here lets the case-sensitive
    // `path.relative` containment check still recognize files under it.
    const real = fs.realpathSync.native(key);
    rootRealpathMemo.set(key, real);
    return real;
  } catch {
    return null; // not memoized — the directory may appear later
  }
}

function resolvedRegisteredRoots(): string[] {
  const resolved: string[] = [];
  const seen = new Set<string>();
  for (const root of registeredRoots()) {
    const real = realpathRoot(root);
    if (real && !seen.has(real)) {
      seen.add(real);
      resolved.push(real);
    }
  }
  return resolved;
}

// The renderer only needs a handful of read-oriented git subcommands to
// power the file editor, diff sheets, and branch pickers. Anything else —
// `clone`, `fetch`, `push`, `-c core.sshCommand=…`, `-C /some/dir` — is
// refused here and routed instead through the typed worktree helpers
// (git.ts exports like `mergeAgent`, `pushBranch`), which build argv
// themselves and never take free-form input.
const RENDERER_GIT_ALLOWLIST = new Set([
  'status',
  'branch',
  'diff',
  'for-each-ref',
  'rev-parse',
  'log',
  'show',
  'ls-files',
]);
function isRendererSafeGitInvocation(args: unknown, cwd: unknown): boolean {
  if (!Array.isArray(args) || args.length === 0) return false;
  if (typeof cwd !== 'string' || !cwd) return false;
  if (!isPathUnderRegisteredRoot(cwd)) return false;
  const first = args[0];
  if (typeof first !== 'string') return false;
  // Reject pre-subcommand flags that alter git's behavior globally
  // (`-c core.sshCommand=…` is the classic RCE, `-C dir` hops cwd,
  // `--exec-path` points at an attacker binary).
  if (first.startsWith('-')) return false;
  if (!RENDERER_GIT_ALLOWLIST.has(first)) return false;
  for (const a of args) {
    if (typeof a !== 'string') return false;
  }
  return true;
}

// Validate that `target` resolves inside one of the registered roots.
// Resolves symlinks via realpath on the nearest existing ancestor so a
// symlink planted inside a project can't point out to an unrelated file.
function isPathUnderRegisteredRoot(target: string): boolean {
  if (!target) return false;
  // A relative path would be resolved against the main process cwd, which
  // in a dev build is the overcli checkout itself — a registered project.
  // That let unresolved hints pass containment and then fail (or write)
  // somewhere the caller never meant. Callers resolve before validating.
  if (!path.isAbsolute(target)) return false;
  const roots = resolvedRegisteredRoots();
  if (roots.length === 0) return false;
  const resolvedTarget = resolveExistingAncestor(path.resolve(target));
  for (const resolvedRoot of roots) {
    const rel = path.relative(resolvedRoot, resolvedTarget);
    if (rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))) return true;
  }
  return false;
}

// Read-only carve-out for `~/.claude/plans/`. Claude writes plan files
// here from inside overcli, but the directory is never registered as a
// project/workspace/worktree so the normal validator rejects it. Allow
// reads (preview, info, large-text, artifact) but keep writes routed
// through `isPathUnderRegisteredRoot` — a compromised renderer should
// not be able to overwrite the user's plans, and the rest of `~/.claude/`
// (settings, auth, memory) stays off-limits.
function isReadablePlanPath(target: string): boolean {
  if (!target) return false;
  const plansRoot = path.join(os.homedir(), '.claude', 'plans');
  const resolvedTarget = resolveExistingAncestor(path.resolve(target));
  let resolvedRoot: string;
  try {
    resolvedRoot = fs.realpathSync.native(plansRoot);
  } catch {
    return false;
  }
  const rel = path.relative(resolvedRoot, resolvedTarget);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/// Readable is deliberately wider than writable. `isPathUnderRegisteredRoot`
/// is the rule for changing a file; for SHOWING one it would hide an agent's
/// own scratch output (a `/tmp` chunk it just wrote) behind an error, while
/// protecting nothing — the run made that file and its contents already
/// reached the user. `isAgentWrittenPath` opens exactly those, by provenance:
/// a path this session watched a tool create. Writes keep the strict rule.
function isReadablePath(target: string): boolean {
  return isPathUnderRegisteredRoot(target) || isReadablePlanPath(target) || isAgentWrittenPath(target);
}

// `fs.realpathSync` throws if any segment is missing (e.g. a file about
// to be created). Walk up the chain until a realpathable ancestor is
// found, resolve that, then re-attach the non-existing tail. Uses
// `path.dirname` rather than splitting on `path.sep` so Windows drive
// roots (`C:\`) and POSIX root (`/`) both terminate cleanly.
function resolveExistingAncestor(p: string): string {
  const absolute = path.resolve(p);
  const tail: string[] = [];
  let current = absolute;
  while (true) {
    try {
      // `.native` canonicalizes case on case-insensitive filesystems so this
      // matches the same-cased roots from `realpathRoot` (see note there).
      return path.join(fs.realpathSync.native(current), ...tail);
    } catch {
      const parent = path.dirname(current);
      if (parent === current) return absolute;
      tail.unshift(path.basename(current));
      current = parent;
    }
  }
}

/// Thin wrapper over the injected-fs resolver in `resolveFilePath.ts` —
/// see that file for the cascade and why the caller's own root wins.
function resolveFilePath(hint: string, rootPath?: string): string | null {
  return resolveFilePathIn(hint, {
    rootPath,
    roots: registeredRoots(),
    scopeRoots: searchScope(rootPath),
    exists: (c) => fs.existsSync(c),
    listFiles: listFilesRecursive,
  });
}

/// The roots a recursive basename search may walk for a click that came
/// from `rootPath`: that root itself, plus the project (or workspace, and
/// its member projects) the conversation was forked from. Nothing else —
/// a file mentioned in one conversation belongs to that conversation's
/// checkout or the repo behind it, never to an unrelated project's tree.
///
/// This is deliberately NOT `registeredRoots()`. That set is a security
/// allowlist and holds one entry per conversation that ever forked a
/// worktree, so it only grows; searching it meant a full recursive walk of
/// every tree the user had ever opened (hundreds, ~500k files) on any hint
/// that didn't resolve — e.g. clicking the chip for a deleted file.
///
/// Returns undefined when the click has no root context, which leaves the
/// resolver searching every root as it did before.
function searchScope(rootPath?: string): string[] | undefined {
  if (!rootPath) return undefined;
  const canon = (p: string) => realpathRoot(p) ?? path.resolve(p);
  const target = canon(rootPath);
  const scope = new Set<string>([rootPath]);
  const add = (p?: string) => {
    if (p) scope.add(p);
  };
  const isTarget = (p?: string) => !!p && canon(p) === target;

  const state = Store.load();
  for (const project of state.projects) {
    if (isTarget(project.path) || (project.conversations ?? []).some((c) => isTarget(c.worktreePath))) {
      add(project.path);
    }
  }
  for (const workspace of state.workspaces) {
    const owns =
      isTarget(workspace.rootPath) ||
      (workspace.conversations ?? []).some((c) => isTarget(c.worktreePath) || isTarget(c.coordinatorRootPath));
    if (!owns) continue;
    add(workspace.rootPath);
    // Workspace roots front their members through symlinks, but a hint can
    // name a member's real path — keep the member checkouts in scope too.
    for (const id of workspace.projectIds ?? []) {
      add(state.projects.find((p) => p.id === id)?.path);
    }
  }
  if (flowRuntime) {
    for (const run of flowRuntime.listRuns()) {
      const owns =
        isTarget(run.projectPath) ||
        isTarget(run.worktreePath) ||
        (run.workspaceWorktrees ?? []).some((w) => isTarget(w.worktreePath));
      if (!owns) continue;
      add(run.projectPath);
      add(run.worktreePath);
    }
  }
  return [...scope];
}

// A recursive walk costs a readdir per directory, each one antivirus-taxed,
// so the same tree getting listed twice in a second (resolver cascade, then
// the file finder mounting) is worth avoiding. Short TTL: long enough to
// collapse those bursts, short enough that a file the agent just wrote shows
// up in the finder without the user wondering why it's missing.
const FILE_LIST_TTL_MS = 15_000;
const fileListCache = new Map<string, { at: number; files: string[] }>();

// The tree can be mounted twice over the same root (standalone explorer and
// a conversation's right pane), and both relist on the same watcher event.
// Sharing the in-flight walk halves that without ever serving a stale
// listing the way a TTL cache would — the whole point of the event is that
// what's on disk just changed.
const inFlightEntryWalks = new Map<string, Promise<Array<{ path: string; sizeBytes: number }>>>();

function listFileEntriesShared(root: string): Promise<Array<{ path: string; sizeBytes: number }>> {
  const key = path.resolve(root);
  const running = inFlightEntryWalks.get(key);
  if (running) return running;
  const startedAt = Date.now();
  const walk = listFileEntriesAsync(root)
    .then((entries) => {
      // What the walk cost is what paces the watcher: a root that takes half
      // a second to list doesn't get relisted every 1.5s.
      noteRelistCost(root, Date.now() - startedAt);
      return entries;
    })
    .finally(() => {
      inFlightEntryWalks.delete(key);
    });
  inFlightEntryWalks.set(key, walk);
  return walk;
}

function listFilesRecursive(root: string): string[] {
  const key = path.resolve(root);
  const hit = fileListCache.get(key);
  const now = Date.now();
  if (hit && now - hit.at < FILE_LIST_TTL_MS) return hit.files;
  const files = listFileEntriesSync(root).map((entry) => entry.path);
  fileListCache.set(key, { at: now, files });
  return files;
}

function buildMenu(): void {
  const isMac = process.platform === 'darwin';
  const template: Electron.MenuItemConstructorOptions[] = [
    ...(isMac
      ? [
          {
            label: app.name,
            submenu: [
              { role: 'about' },
              { type: 'separator' },
              { role: 'services' },
              { type: 'separator' },
              { role: 'hide' },
              { role: 'hideOthers' },
              { role: 'unhide' },
              { type: 'separator' },
              { role: 'quit' },
            ],
          } as Electron.MenuItemConstructorOptions,
        ]
      : []),
    {
      label: 'File',
      submenu: [
        {
          label: 'New Conversation',
          accelerator: 'CmdOrCtrl+N',
          click: () =>
            emitToRenderer({
              type: 'running',
              conversationId: '__menu_new_conversation__',
              isRunning: false,
            }),
        },
        { type: 'separator' },
        { role: 'close' },
      ],
    },
    {
      // Spelled out instead of `role: 'editMenu'` so we can stop the
      // native Undo/Redo accelerators from swallowing Cmd/Ctrl+Z before
      // it reaches the web content. The native role runs
      // document.execCommand('undo'), which is a no-op inside CodeMirror
      // (it manages its own history), so the menu was silently eating the
      // keystroke and undo looked broken in the file editor. With
      // `registerAccelerator: false` the shortcut is still shown in the
      // menu but the keydown falls through to CodeMirror's / the browser's
      // own undo handling.
      label: 'Edit',
      submenu: [
        {
          role: 'undo',
          accelerator: 'CmdOrCtrl+Z',
          registerAccelerator: false,
        },
        {
          role: 'redo',
          accelerator: 'Shift+CmdOrCtrl+Z',
          registerAccelerator: false,
        },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        ...(isMac
          ? ([
              { role: 'pasteAndMatchStyle' },
              { role: 'delete' },
              { role: 'selectAll' },
            ] as Electron.MenuItemConstructorOptions[])
          : ([
              { role: 'delete' },
              { type: 'separator' },
              { role: 'selectAll' },
            ] as Electron.MenuItemConstructorOptions[])),
      ],
    },
    { role: 'viewMenu' },
    { role: 'windowMenu' },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// Skia Graphite (Chromium's Metal GPU backend, default on macOS) produces
// "Graphite insertRecording failed" GPU-process crashes and visible render
// glitches on older Intel Macs. Apple Silicon handles it fine and benefits
// from it, so only opt Intel Macs out. Mirrors the appleSilicon check in
// ollama.ts. Must run before app `ready`.
if (process.platform === 'darwin' && process.arch !== 'arm64') {
  app.commandLine.appendSwitch('disable-features', 'SkiaGraphite');
}

/// In dev the renderer is served over HTTP by Vite, and HMR appends a fresh
/// `?t=<timestamp>` cache-buster to every module on every edit. Chromium
/// treats each of those as a brand-new, permanently-cacheable URL, so the
/// HTTP cache (and the V8 code cache keyed off it) grows without bound —
/// months of dev had accumulated ~32k entries and 1.6GB of userData. Prod
/// loads from `file://` and never enters this cache, so this is dev-only.
async function clearDevHttpCache(): Promise<void> {
  if (!isDev) return;
  try {
    await session.defaultSession.clearCodeCaches({ urls: [] });
    await session.defaultSession.clearCache();
    log('info', 'main.devCache', 'Cleared dev HTTP + code caches');
  } catch (err) {
    log('warn', 'main.devCache', 'Failed to clear dev caches', err);
  }
}

// Scheme privileges are only accepted before the app is ready, so this
// cannot move into whenReady below.
registerPreviewScheme();

app.whenReady().then(() => {
  nativeTheme.themeSource = 'dark';
  handlePreviewProtocol();
  void clearDevHttpCache();
  // In dev the dock shows Electron's default icon because we're running the
  // Electron binary directly (no .app bundle). Override it so dev matches prod.
  if (isDev && process.platform === 'darwin' && app.dock) {
    const devIcon = path.join(__dirname, '..', '..', 'build', 'icon.png');
    if (fs.existsSync(devIcon)) app.dock.setIcon(devIcon);
  }
  // Apply navigation + window-open locks to every webContents — not just
  // mainWindow — so any future child contents inherits the same clamps.
  app.on('web-contents-created', (_e, contents) => {
    contents.setWindowOpenHandler(({ url }) => {
      if (isSafeExternalUrl(url)) shell.openExternal(url);
      return { action: 'deny' };
    });
    contents.on('will-navigate', (event, url) => {
      const current = contents.getURL();
      if (url === current) return;
      event.preventDefault();
      if (isSafeExternalUrl(url)) shell.openExternal(url);
    });
  });
  registerIpc();
  buildMenu();
  // Before the window exists, so the renderer's first `app:whatsNew` call
  // already sees a baseline and a fresh install isn't handed four changelogs.
  seedWhatsNewBaseline();
  createWindow();

  // Nudge self-updating CLIs (claude, codex) in the background, hidden, so
  // they're on the latest version next time the user runs a turn. Throttled
  // to once/day and fire-and-forget — never blocks window creation.
  primeBackendUpdates();

  // Self-update the app itself from the GitHub Releases feed. No-op in dev and
  // on unsigned macOS builds (Squirrel rejects those).
  initAutoUpdater(() => mainWindow);

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  runner?.killAll();
  if (process.platform !== 'darwin') app.quit();
});

let flushedRuns = false;
app.on('before-quit', (event) => {
  runner?.killAll();
  symbolLookup?.dispose();
  closeAllTreeWatchers();
  // Drop the pending timers so a quit can't fire a schedule or a worker
  // shift into a runtime that's already tearing its subprocesses down.
  scheduler?.dispose();
  workerEngine?.dispose();
  ollamaServer.stop();
  // Store writes are debounced now (see store.save). Take the freshest
  // snapshot synchronously so a quit inside the debounce window can't drop
  // the last mutation.
  flushStoreSync();
  // Run writes are async now (see runsStore.saveRun). Defer the first quit
  // long enough to flush any in-flight checkpoint to disk, then quit for real.
  // Writes are sub-10ms, so the delay is imperceptible.
  if (!flushedRuns) {
    event.preventDefault();
    void flushRuns().finally(() => {
      flushedRuns = true;
      app.quit();
    });
  }
});

// Silence "uncaught exception" dialogs during dev — errors still land in
// the devtools console. Don't do this in prod where a real crash should
// surface.
if (isDev) {
  process.on('uncaughtException', (err) => {
    log('error', 'main.uncaughtException', 'Uncaught main-process exception', err);
  });
}
