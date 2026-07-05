// 2026-04-18
// Updated 2026-04-18.
// Electron main process entry. Creates the single main window and
// registers every IPC handler the renderer invokes. Main-process state
// lives here — the Store, the RunnerManager, health probes, stats.

import { app, BrowserWindow, dialog, ipcMain, shell, Menu, nativeTheme } from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Store } from './store';
import { RunnerManager } from './runner';
import { loadHistory, migrateClaudeSessionCwd } from './history';
import { probeBackendHealth, listInstalledReviewers, resolveBackendPath } from './health';
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
  mergeAgent,
  rebaseAgent,
  pushBranch,
  openPR,
  worktreeStatus,
  worktreeDiff,
  rescueMainTree,
  commitStatus,
  currentBranch,
  workspaceCommitStatus,
  commitAll,
  workspaceCommitAll,
} from './git';
import { computeStats } from './stats';
import { scanCapabilities } from './capabilities';
import { addMcpServerToTargets, isMcpCli, readMcpServer, writeMcpServer } from './mcpConfig';
import {
  listMcpCatalog,
  installMcpCatalogEntry,
  uninstallMcpCatalogEntry,
} from './mcpCatalog';
import { loginCodexMcp } from './mcpLogin';
import { backendNeedsShell, buildBackendEnv } from './backendPaths';
import {
  listMarketplaceSkills,
  installMarketplaceSkill,
  uninstallMarketplaceSkill,
  uninstallSkillByPath,
} from './skillsCatalog';
import {
  OLLAMA_CATALOG,
  detectHardware,
  detectOllama,
  deleteModel,
  installOllama,
  ollamaServer,
  pullModel,
} from './ollama';
import { deleteOllamaSession } from './ollamaStore';
import { clearSilentLog, listSilentLog, log, type LogLevel } from './diagnostics';
import { initAutoUpdater, refreshUpdateChannel, quitAndInstall } from './updater';
import { loadAllFlows, saveFlow, deleteFlow, validateFlowYaml } from './flows/storage';
import { listToolCatalog } from './flows/toolCatalog';
import { FlowRuntime } from './flows/runtime';
import { OrchestratorImpl } from './flows/orchestrator';
import { flushRuns } from './flows/runsStore';
import {
  listRecentPrompts,
  recordRecentPrompt,
  deleteRecentPrompt,
} from './flows/recentPromptsStore';
import { listWatchSources } from './flows/watch/source';
import { listRegistries, upsertRegistry, removeRegistry, browseRegistries, installFromRegistry, previewRegistryFlow } from './flows/registry';
import { FLOW_TEMPLATES } from '../shared/flows/templates';
import { draftFlowFromPrompt } from './flows/drafter';
import {
  ensureWorkspaceSymlinkRoot,
  removeWorkspaceSymlinkRoot,
  ensureCoordinatorSymlinkRoot,
  rebindCoordinatorRootToProjects,
  removeCoordinatorSymlinkRoot,
} from './workspace';
import { openTerminalAt, runInTerminal } from './terminal';
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
const execFileAsync = promisify(execFile);
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

  // Lock the renderer to its initial origin. Any attempt to navigate (a
  // rogue link, a redirect in an iframe, a window.open) is denied and
  // bounced to the user's default browser if it's a plain http(s) URL.
  mainWindow.webContents.on('will-navigate', (event, url) => {
    const current = mainWindow?.webContents.getURL();
    if (url === current) return;
    event.preventDefault();
    if (isSafeExternalUrl(url)) shell.openExternal(url);
  });
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (isSafeExternalUrl(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
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
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('main:event', event);
  }
}

function registerIpc(): void {
  // The flow runtime needs to tap every stream event the runner emits so
  // it can detect step completion + accumulate assistant text for artifact
  // extraction. Wrap the renderer emit callback to tee events into the
  // runtime first; nothing changes for renderer-facing behavior.
  const flowAwareEmit = (event: MainToRendererEvent) => {
    if (flowRuntime) flowRuntime.observeEvent(event);
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
  flowRuntime.setRunObserver((run) => orchestrator?.onRunUpdate(run));

  ipcMain.handle('store:load', () => Store.load());
  ipcMain.handle('store:saveProjects', (_e, projects) => Store.saveProjects(projects));
  ipcMain.handle('store:saveWorkspaces', (_e, workspaces) => Store.saveWorkspaces(workspaces));
  ipcMain.handle('store:saveColosseums', (_e, colosseums) => Store.saveColosseums(colosseums));
  ipcMain.handle('store:saveSettings', (_e, settings) => {
    Store.saveSettings(settings);
    refreshUpdateChannel();
  });
  ipcMain.handle('store:saveSelection', (_e, id) => Store.saveSelection(id));
  ipcMain.handle('update:quitAndInstall', () => quitAndInstall());

  ipcMain.handle('runner:send', (_e, args) => runner!.send(args));
  ipcMain.handle('runner:stop', (_e, { conversationId }) => runner!.stop(conversationId));
  ipcMain.handle('runner:newConversation', (_e, { conversationId }) =>
    runner!.newConversation(conversationId),
  );
  ipcMain.handle(
    'runner:respondPermission',
    (_e, { conversationId, requestId, approved, addDir, scope, toolName }) =>
      runner!.respondPermission(conversationId, requestId, approved, addDir, scope, toolName),
  );
  ipcMain.handle(
    'runner:respondCodexApproval',
    (_e, { conversationId, callId, kind, approved }) =>
      runner!.respondCodexApproval(conversationId, callId, kind, approved),
  );
  ipcMain.handle('runner:respondUserInput', (_e, { conversationId, requestId, answers }) =>
    runner!.respondUserInput(conversationId, requestId, answers),
  );
  ipcMain.handle('runner:loadHistory', (_e, args) => loadHistory(args));
  ipcMain.handle('runner:probeHealth', (_e, backend: Backend) => {
    const settings = Store.load().settings;
    return probeBackendHealth(backend, settings.backendPaths[backend]);
  });
  ipcMain.handle('runner:listInstalledReviewers', () => listInstalledReviewers());
  ipcMain.handle('capabilities:scan', () => scanCapabilities());
  ipcMain.handle('skills:listMarketplace', () => listMarketplaceSkills());
  ipcMain.handle('skills:installMarketplace', (_e, { skillId, targets }) =>
    installMarketplaceSkill(skillId, targets),
  );
  ipcMain.handle('skills:uninstallMarketplace', (_e, { skillId, targets }) =>
    uninstallMarketplaceSkill(skillId, targets),
  );
  ipcMain.handle('skills:uninstallByPath', (_e, { path: p }) => uninstallSkillByPath(p));
  ipcMain.handle('capabilities:copyMcp', (_e, { name, fromCli, toCli }) => {
    if (!isMcpCli(fromCli) || !isMcpCli(toCli)) {
      return { ok: false as const, error: `Unsupported CLI for MCP copy.` };
    }
    if (fromCli === toCli) {
      return { ok: false as const, error: `Source and target CLI are the same.` };
    }
    try {
      const config = readMcpServer(fromCli, name);
      if (!config) {
        return { ok: false as const, error: `MCP server "${name}" not found in ${fromCli} config.` };
      }
      writeMcpServer(toCli, name, config);
      return { ok: true as const };
    } catch (err: any) {
      return { ok: false as const, error: err?.message ?? String(err) };
    }
  });
  ipcMain.handle('capabilities:addMcp', (_e, args) => addMcpServerToTargets(args));
  ipcMain.handle('mcp:listCatalog', () => listMcpCatalog());
  ipcMain.handle('mcp:installCatalog', (_e, { id, targets, secrets }) =>
    installMcpCatalogEntry(id, targets, secrets),
  );
  ipcMain.handle('mcp:uninstallCatalog', (_e, { id, targets }) =>
    uninstallMcpCatalogEntry(id, targets),
  );
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
      return { ok: false as const, error: 'Codex binary not found. Set its path in Settings.' };
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

  ipcMain.handle('fs:pickDirectory', async () => {
    if (!mainWindow) return null;
    const res = await dialog.showOpenDialog(mainWindow, {
      properties: ['openDirectory', 'multiSelections'],
    });
    if (res.canceled || res.filePaths.length === 0) return null;
    return res.filePaths;
  });
  ipcMain.handle('fs:fileInfo', (_e, args: { path: string; rootPath?: string }) => fileInfo(args?.path ?? '', args?.rootPath));
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
      return { ok: false, error: `Could not find "${hint}" in any registered project.` };
    }
    if (!isReadablePath(resolved)) {
      return { ok: false, error: 'File is outside any registered project, workspace, or worktree.' };
    }
    try {
      const stat = fs.statSync(resolved);
      if (stat.size > MAX_OPEN_FILE_BYTES) {
        return { ok: false, error: fileTooLargeMessage(stat.size) };
      }
      if (isKnownBinaryExtension(resolved) || isLikelyBinaryFile(resolved, stat.size)) {
        return { ok: false, error: 'This file cannot be previewed in Overcli. Open it with the system app or reveal it in Finder.' };
      }
      const content = fs.readFileSync(resolved, 'utf-8');
      if (content.includes('\0')) {
        return { ok: false, error: 'This file cannot be previewed in Overcli. Open it with the system app or reveal it in Finder.' };
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
  ipcMain.handle('fs:writeFile', (_e, { path: p, content }) => {
    if (!isPathUnderRegisteredRoot(p)) {
      return { ok: false, error: 'File is outside any registered project, workspace, or worktree.' };
    }
    try {
      fs.writeFileSync(p, content, 'utf-8');
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
    if (!isPathUnderRegisteredRoot(root)) return [];
    return listFileEntriesRecursive(root);
  });
  ipcMain.handle('fs:openInFinder', (_e, p: string) => {
    if (!isReadablePath(p)) return;
    shell.showItemInFolder(p);
  });
  ipcMain.handle('fs:openPath', async (_e, p: string) => {
    const resolved = resolveFilePath(p);
    if (!resolved || !isReadablePath(resolved)) {
      return { ok: false, error: 'File is outside any registered project, workspace, or worktree.' };
    }
    const error = await shell.openPath(resolved);
    return error ? { ok: false, error } : { ok: true };
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
  ipcMain.handle('preview:projectHints', (_e, args: { path: string; rootPath?: string }) =>
    projectPreviewHints(args?.path ?? '', args?.rootPath),
  );
  ipcMain.handle(
    'preview:runProjectCommand',
    (_e, { cwd, command }: { cwd: string; command: string }) => {
      if (!isPathUnderRegisteredRoot(cwd)) {
        return { ok: false, error: 'Preview command cwd is outside registered project roots.' };
      }
      if (!/^[A-Za-z0-9 .:_/-]+$/.test(command)) {
        return { ok: false, error: 'Preview command contains unsupported characters.' };
      }
      return openTerminalAt(cwd, command);
    },
  );

  ipcMain.handle('git:run', (_e, { args, cwd }) => {
    if (!isRendererSafeGitInvocation(args, cwd)) {
      return { stdout: '', stderr: 'Refused: git args outside the renderer allowlist.', exitCode: 1 };
    }
    return runGit(args, cwd);
  });
  ipcMain.handle('git:createWorktree', (_e, args) => createWorktree(args));
  ipcMain.handle('git:createReviewWorktree', (_e, args) => createReviewWorktree(args));
  ipcMain.handle('git:promoteReviewWorktree', (_e, args) => promoteReviewWorktree(args));
  ipcMain.handle('git:switchProjectToBranch', (_e, args) => switchProjectToBranch(args));
  ipcMain.handle('git:switchBranch', (_e, args) => switchBranch(args));
  ipcMain.handle('git:removeWorktree', (_e, args) => removeWorktree(args));
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
  ipcMain.handle('git:detectBaseBranch', (_e, projectPath: string) =>
    detectBaseBranch(projectPath),
  );
  ipcMain.handle('git:mergeAgent', (_e, args) => mergeAgent(args));
  ipcMain.handle('git:rebaseAgent', (_e, args) => rebaseAgent(args));
  ipcMain.handle('git:pushBranch', (_e, args) => pushBranch(args));
  ipcMain.handle('git:openPR', (_e, args) => openPR(args));
  ipcMain.handle('git:worktreeStatus', (_e, args) => worktreeStatus(args));
  ipcMain.handle('git:worktreeDiff', (_e, args) => worktreeDiff(args));
  ipcMain.handle('git:rescueMainTree', (_e, args) => rescueMainTree(args));
  ipcMain.handle('git:commitStatus', (_e, { cwd }) => commitStatus(cwd));
  ipcMain.handle('git:currentBranch', (_e, { cwd }) => currentBranch(cwd));
  ipcMain.handle('git:workspaceCommitStatus', (_e, { projects }) => workspaceCommitStatus(projects));
  ipcMain.handle('git:commitAll', (_e, args) => commitAll(args));
  ipcMain.handle('git:workspaceCommitAll', (_e, args) => workspaceCommitAll(args));

  ipcMain.handle('workspace:ensureSymlinkRoot', (_e, { workspaceId, projects, instructions }) =>
    ensureWorkspaceSymlinkRoot(workspaceId, projects, instructions),
  );
  ipcMain.handle('workspace:removeSymlinkRoot', (_e, workspaceId: string) =>
    removeWorkspaceSymlinkRoot(workspaceId),
  );
  ipcMain.handle('workspace:ensureCoordinatorSymlinkRoot', (_e, { coordinatorId, members }) =>
    ensureCoordinatorSymlinkRoot(coordinatorId, members),
  );
  ipcMain.handle(
    'workspace:rebindCoordinatorRootToProjects',
    (_e, { coordinatorId, projects }) =>
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
      return { ok: false, error: 'Ollama does not need CLI login — start the server from the banner.' };
    }
    const settings = Store.load().settings;
    const bin = resolveBackendPath(backend, settings.backendPaths[backend]);
    // Prefer the resolved absolute path so Terminal.app (which inherits a
    // different PATH than Electron) still finds the binary. If we couldn't
    // resolve it, fall back to the bare command — better than nothing.
    const cmd = bin ?? backend;
    const quoted = cmd.includes(' ') ? `"${cmd}"` : cmd;
    const args = backend === 'claude' ? 'auth login' : backend === 'codex' ? 'login' : 'auth login';
    return runInTerminal(`${quoted} ${args}`);
  });

  ipcMain.handle(
    'terminal:popConversation',
    (_e, { cwd, backend, sessionId }: { cwd: string; backend: Backend; sessionId?: string }) => {
      if (backend === 'ollama') {
        return { ok: false, error: 'Ollama runs in-app — there is no CLI to resume in a terminal.' };
      }
      if (!isPathUnderRegisteredRoot(cwd)) {
        return { ok: false, error: 'Workspace path is not inside a registered project root.' };
      }
      // Only Claude/Gemini support `--resume`; Codex ignores sessionId
      // entirely when popping to terminal. Validate only the backends that
      // actually embed the ID into the shell command.
      const needsResumeId = backend === 'claude' || backend === 'gemini';
      // Session IDs come from backend CLIs (UUID-like for claude/gemini).
      // Anything with shell metacharacters is rejected so it can't escape
      // into the `do script` line as a separate command.
      if (needsResumeId && sessionId && !/^[A-Za-z0-9._-]+$/.test(sessionId)) {
        return { ok: false, error: 'Session ID contains unexpected characters.' };
      }
      const settings = Store.load().settings;
      const bin = resolveBackendPath(backend, settings.backendPaths[backend]);
      const cmd = bin ?? backend;
      const quoted = cmd.includes(' ') ? `"${cmd}"` : cmd;
      // Codex has no --resume flag; just drop the user into the interactive
      // TUI in the workspace and they can pick up from there.
      const resumeSuffix = sessionId && needsResumeId ? ` --resume ${sessionId}` : '';
      return openTerminalAt(cwd, `${quoted}${resumeSuffix}`);
    },
  );

  ipcMain.handle('ollama:detect', () => detectOllama());
  ipcMain.handle('ollama:hardware', () => detectHardware());
  ipcMain.handle('ollama:catalog', () => OLLAMA_CATALOG);
  ipcMain.handle('ollama:install', () => installOllama((url) => shell.openExternal(url)));
  ipcMain.handle('ollama:startServer', () => ollamaServer.start());
  ipcMain.handle('ollama:stopServer', () => ollamaServer.stop());
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
  ipcMain.handle('flows:delete', (_e, args) => deleteFlow(args));
  ipcMain.handle('flows:validate', (_e, args) => validateFlowYaml(args));
  ipcMain.handle('flows:toolCatalog', (_e, args) => listToolCatalog(args));
  ipcMain.handle('flows:listTemplates', () => FLOW_TEMPLATES);
  ipcMain.handle('flows:draftFromPrompt', (_e, args) =>
    draftFlowFromPrompt(args, { settings: Store.load().settings, runner: runner! }),
  );
  ipcMain.handle('flows:startRun', (_e, args) =>
    flowRuntime ? flowRuntime.startRun(args) : ({ ok: false, error: 'Flow runtime not initialized.' } as const),
  );
  ipcMain.handle('flows:listRuns', () => (flowRuntime ? flowRuntime.listRuns() : []));
  ipcMain.handle('flows:getRun', (_e, { runId }) =>
    flowRuntime ? flowRuntime.getRun(runId) : null,
  );
  ipcMain.handle('flows:resumeRun', (_e, args) =>
    flowRuntime ? flowRuntime.resumeRun(args) : ({ ok: false, error: 'Flow runtime not initialized.' } as const),
  );
  ipcMain.handle('flows:rerunFromStep', (_e, args) =>
    flowRuntime ? flowRuntime.rerunFromStep(args) : ({ ok: false, error: 'Flow runtime not initialized.' } as const),
  );
  ipcMain.handle('flows:abortRun', (_e, args) =>
    flowRuntime ? flowRuntime.abortRun(args) : ({ ok: false, error: 'Flow runtime not initialized.' } as const),
  );
  ipcMain.handle('flows:setModelOverride', (_e, { runId, participantId, model }) =>
    flowRuntime
      ? flowRuntime.setModelOverride(runId, participantId, model)
      : ({ ok: false, error: 'Flow runtime not initialized.' } as const),
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
    orchestrator
      ? orchestrator.propose(args)
      : ({ ok: false, error: 'Orchestrator not initialized.' } as const),
  );
  ipcMain.handle('orchestrator:startBatch', (_e, args) =>
    orchestrator
      ? orchestrator.startBatch(args)
      : ({ ok: false, error: 'Orchestrator not initialized.' } as const),
  );
  ipcMain.handle('orchestrator:list', () => (orchestrator ? orchestrator.list() : []));
  ipcMain.handle('orchestrator:get', (_e, { id }) => (orchestrator ? orchestrator.get(id) : null));
  ipcMain.handle('orchestrator:abort', (_e, args) =>
    orchestrator
      ? orchestrator.abort(args)
      : ({ ok: false, error: 'Orchestrator not initialized.' } as const),
  );
  ipcMain.handle('orchestrator:retry', (_e, args) =>
    orchestrator
      ? orchestrator.retry(args)
      : ({ ok: false, error: 'Orchestrator not initialized.' } as const),
  );
  ipcMain.handle('orchestrator:delete', (_e, args) =>
    orchestrator
      ? orchestrator.delete(args)
      : ({ ok: false, error: 'Orchestrator not initialized.' } as const),
  );
  // Recent producer prompts live in their own tiny store, independent of
  // whether the orchestrator engine is up — they're just a UI convenience.
  ipcMain.handle('orchestrator:recentPrompts', () => listRecentPrompts());
  ipcMain.handle('orchestrator:recordRecentPrompt', (_e, { text }) => recordRecentPrompt(text));
  ipcMain.handle('orchestrator:deleteRecentPrompt', (_e, { text }) => deleteRecentPrompt(text));
}

// In-flight Ollama pulls, keyed by model tag. Cancelling is just aborting
// the HTTP request we opened in pullModel.
const pendingPulls = new Map<string, AbortController>();

function fileInfo(hint: string, rootPath?: string) {
  const resolved = resolveFilePath(hint, rootPath);
  if (!resolved) {
    if (path.isAbsolute(hint) && isReadablePath(hint)) {
      return { ok: false, error: `File not found at ${hint}.` };
    }
    return { ok: false, error: `Could not find "${hint}" in any registered project.` };
  }
  if (!isReadablePath(resolved)) {
    return { ok: false, error: 'File is outside any registered project, workspace, or worktree.' };
  }
  try {
    const stat = fs.statSync(resolved);
    if (!stat.isFile()) return { ok: false, error: 'Path is not a regular file.' };
    const artifactPreview = isArtifactPreviewExtension(resolved);
    const largeText =
      !artifactPreview && stat.size > MAX_TEXT_FILE_BYTES && stat.size <= MAX_OPEN_FILE_BYTES;
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
    return { ok: false, error: err?.message ?? 'Could not inspect file' };
  }
}

function readLargeTextPreview(hint: string, rootPath?: string) {
  const resolved = resolveFilePath(hint, rootPath);
  if (!resolved) return { ok: false, error: `Could not find "${hint}" in any registered project.` };
  if (!isReadablePath(resolved)) {
    return { ok: false, error: 'File is outside any registered project, workspace, or worktree.' };
  }
  try {
    const stat = fs.statSync(resolved);
    if (stat.size > MAX_OPEN_FILE_BYTES) return { ok: false, error: fileTooLargeMessage(stat.size) };
    if (isKnownBinaryExtension(resolved) || isLikelyBinaryFile(resolved, stat.size)) {
      return { ok: false, error: 'This file cannot be previewed in Overcli. Open it with the system app or reveal it in Finder.' };
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
    return { ok: false, error: err?.message ?? 'Could not read large text preview' };
  }
}

async function readArtifactPreview(hint: string, rootPath?: string): Promise<ArtifactPreviewResult> {
  const resolved = resolveFilePath(hint, rootPath);
  if (!resolved) return { ok: false, error: `Could not find "${hint}" in any registered project.` };
  if (!isReadablePath(resolved)) {
    return { ok: false, error: 'File is outside any registered project, workspace, or worktree.' };
  }
  try {
    const stat = fs.statSync(resolved);
    const ext = path.extname(resolved).slice(1).toLowerCase();
    const officeFamily = officeFamilyForExtension(ext);
    if (officeFamily) {
      const converted = await convertOfficeToPdfPreview(resolved);
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
    if (!mimeType) return { ok: false, error: `No artifact preview available for .${ext || 'file'}.` };
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
    return { ok: false, error: err?.message ?? 'Could not read artifact preview' };
  }
}

function pathToFileUrl(filePath: string): string {
  const normalized = path.resolve(filePath).replace(/\\/g, '/');
  const prefixed = normalized.startsWith('/') ? normalized : `/${normalized}`;
  return encodeURI(`file://${prefixed}`);
}

async function convertOfficeToPdfPreview(
  filePath: string,
): Promise<Pick<
  Extract<ArtifactPreviewResult, { ok: true; kind: 'office' }>,
  'convertedPdfDataUrl' | 'convertedPdfSizeBytes' | 'converterPath' | 'conversionError'
>> {
  const converterPath = findLibreOfficeBinary();
  if (!converterPath) return { conversionError: 'LibreOffice/soffice was not found.' };
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'overcli-office-preview-'));
  try {
    await execFileAsync(
      converterPath,
      ['--headless', '--convert-to', 'pdf', '--outdir', outDir, filePath],
      { timeout: 30_000, maxBuffer: 1024 * 1024 },
    );
    const expected = path.join(outDir, `${path.basename(filePath, path.extname(filePath))}.pdf`);
    const pdfPath = fs.existsSync(expected)
      ? expected
      : fs.readdirSync(outDir).find((name) => name.toLowerCase().endsWith('.pdf'));
    const resolvedPdfPath = pdfPath && path.isAbsolute(pdfPath) ? pdfPath : pdfPath ? path.join(outDir, pdfPath) : '';
    if (!resolvedPdfPath || !fs.existsSync(resolvedPdfPath)) {
      return { converterPath, conversionError: 'LibreOffice did not produce a PDF preview.' };
    }
    const stat = fs.statSync(resolvedPdfPath);
    if (stat.size > MAX_OPEN_FILE_BYTES) {
      return { converterPath, conversionError: 'Converted PDF is over the 5 MB preview cap.' };
    }
    const data = fs.readFileSync(resolvedPdfPath).toString('base64');
    return {
      converterPath,
      convertedPdfDataUrl: `data:application/pdf;base64,${data}`,
      convertedPdfSizeBytes: stat.size,
    };
  } catch (err: any) {
    return { converterPath, conversionError: err?.message ?? 'LibreOffice conversion failed.' };
  } finally {
    fs.rmSync(outDir, { recursive: true, force: true });
  }
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

function findLibreOfficeBinary(): string | null {
  const candidates =
    process.platform === 'darwin'
      ? [
          '/Applications/LibreOffice.app/Contents/MacOS/soffice',
          '/opt/homebrew/bin/soffice',
          '/usr/local/bin/soffice',
          'soffice',
          'libreoffice',
        ]
      : ['soffice', 'libreoffice'];
  for (const candidate of candidates) {
    if (candidate.includes(path.sep) && fs.existsSync(candidate)) return candidate;
    if (!candidate.includes(path.sep) && commandExists(candidate)) return candidate;
  }
  return null;
}

function commandExists(command: string): boolean {
  const paths = (process.env.PATH ?? '').split(path.delimiter).filter(Boolean);
  return paths.some((dir) => {
    try {
      return fs.existsSync(path.join(dir, command));
    } catch {
      return false;
    }
  });
}

function projectPreviewHints(hint: string, rootPath?: string): ProjectPreviewHintsResult {
  const resolved = resolveFilePath(hint, rootPath);
  if (!resolved) return { ok: false, error: `Could not find "${hint}" in any registered project.` };
  const packageRoot = findNearestPackageRoot(path.dirname(resolved));
  if (!packageRoot) return { ok: false, error: 'No package.json found for this component.' };
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(packageRoot, 'package.json'), 'utf-8'));
    const scripts = typeof pkg?.scripts === 'object' && pkg.scripts ? pkg.scripts : {};
    const packageManager = detectPackageManager(packageRoot);
    const commands = previewCommandsForScripts(scripts, packageManager);
    if (commands.length === 0) {
      return { ok: false, error: 'No dev, preview, Storybook, or visual test scripts found.' };
    }
    return { ok: true, rootPath: packageRoot, packageManager, commands };
  } catch (err: any) {
    return { ok: false, error: err?.message ?? 'Could not read package preview scripts.' };
  }
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
    commands.push({ id, label, kind, command: scriptCommand(packageManager, id) });
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

function officeFamilyForExtension(ext: string): 'document' | 'spreadsheet' | 'presentation' | null {
  if (ext === 'doc' || ext === 'docx') return 'document';
  if (ext === 'xls' || ext === 'xlsx') return 'spreadsheet';
  if (ext === 'ppt' || ext === 'pptx') return 'presentation';
  return null;
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
// state + a list walk, no syscalls) — so a newly-added project or flow-run
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

function isReadablePath(target: string): boolean {
  return isPathUnderRegisteredRoot(target) || isReadablePlanPath(target);
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

// Tool output (grep, glob, etc.) emits paths relative to the conversation
// cwd — and the renderer's path-link handler strips trailing `:LINE`
// suffixes, so by the time a click lands here we often get something like
// `src/main/index.ts` or even just `store.ts`. Neither resolves against
// Electron's cwd, so `fs.readFileSync` ENOENTs.
//
// Resolution cascade:
//   1. absolute + exists,
//   2. join against the caller's rootPath (conversation cwd),
//   3. join against each registered root,
//   4. Command-P-style basename search across registered roots, tie-broken
//      by how many trailing path segments match the hint (so a hint of
//      `renderer/store.ts` prefers `.../src/renderer/store.ts` over
//      `.../some/other/store.ts`), then by shortest full path.
function resolveFilePath(hint: string, rootPath?: string): string | null {
  if (!hint) return null;
  if (path.isAbsolute(hint) && fs.existsSync(hint)) return hint;

  const tried = new Set<string>();
  const tryCandidate = (c: string): string | null => {
    if (tried.has(c)) return null;
    tried.add(c);
    return fs.existsSync(c) ? c : null;
  };

  if (rootPath) {
    const direct = tryCandidate(path.resolve(rootPath, hint));
    if (direct) return direct;
  }
  const roots = registeredRoots();
  for (const root of roots) {
    const direct = tryCandidate(path.resolve(root, hint));
    if (direct) return direct;
  }

  const hintSegments = hint.split(/[\\/]/).filter(Boolean);
  const basename = hintSegments[hintSegments.length - 1];
  if (!basename) return null;

  // An absolute hint that didn't resolve to an existing file in the direct
  // checks above won't be found by scanning for a same-named file elsewhere —
  // and silently redirecting an absolute path to a different file would be
  // wrong. Skip the recursive walk (each readdir/stat is antivirus-taxed and
  // covers up to 20k files per root) for absolute hints.
  if (path.isAbsolute(hint)) return null;

  const searchRoots: string[] = [];
  const seenRoot = new Set<string>();
  const pushRoot = (r: string | undefined) => {
    if (!r || seenRoot.has(r)) return;
    seenRoot.add(r);
    searchRoots.push(r);
  };
  pushRoot(rootPath);
  for (const r of roots) pushRoot(r);

  type Match = { file: string; suffixScore: number };
  let best: Match | null = null;
  for (const root of searchRoots) {
    let files: string[];
    try {
      files = listFilesRecursive(root);
    } catch {
      continue;
    }
    for (const file of files) {
      if (path.basename(file) !== basename) continue;
      const fileSegments = file.split(path.sep);
      let score = 0;
      for (let i = 0; i < hintSegments.length && i < fileSegments.length; i++) {
        if (fileSegments[fileSegments.length - 1 - i] === hintSegments[hintSegments.length - 1 - i]) {
          score++;
        } else {
          break;
        }
      }
      if (
        !best ||
        score > best.suffixScore ||
        (score === best.suffixScore && file.length < best.file.length)
      ) {
        best = { file, suffixScore: score };
      }
    }
  }
  return best?.file ?? null;
}

function listFilesRecursive(root: string): string[] {
  return listFileEntriesRecursive(root).map((entry) => entry.path);
}

function listFileEntriesRecursive(root: string): Array<{ path: string; sizeBytes: number }> {
  const skipDirs = new Set([
    '.git',
    'node_modules',
    '.build',
    'build',
    'bin',
    'dist',
    '.next',
    '.venv',
    'venv',
    '__pycache__',
    '.DS_Store',
    'DerivedData',
    '.swiftpm',
    // IDE + JVM build output: on large multi-project checkouts these dwarf
    // the actual source and used to push the walk past its 20k cap, leaving
    // the tree both slow and silently truncated.
    'out',
    'target',
    '.gradle',
    '.idea',
    '.metadata',
    '.settings',
    '.angular',
    'coverage',
  ]);
  const out: Array<{ path: string; sizeBytes: number }> = [];
  const stack: string[] = [root];
  while (stack.length) {
    const cur = stack.pop()!;
    let entries: fs.Dirent[];
    try {
      // withFileTypes lets us classify dirs from the readdir result alone,
      // so we only pay a per-entry statSync on files (for size) instead of
      // on every node in the tree — roughly halving syscalls on a big repo.
      entries = fs.readdirSync(cur, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const name = entry.name;
      if (skipDirs.has(name)) continue;
      const full = path.join(cur, name);
      if (entry.isDirectory()) {
        stack.push(full);
        continue;
      }
      if (entry.isSymbolicLink()) {
        // Symlinks (e.g. workspace roots that symlink several projects)
        // need a follow-stat to resolve their real type and size.
        let stat: fs.Stats;
        try {
          stat = fs.statSync(full);
        } catch {
          continue;
        }
        if (stat.isDirectory()) {
          stack.push(full);
        } else if (stat.isFile()) {
          out.push({ path: full, sizeBytes: stat.size });
          if (out.length > 20000) return out; // safety cap
        }
        continue;
      }
      if (entry.isFile()) {
        let size = 0;
        try {
          size = fs.statSync(full).size;
        } catch {
          continue;
        }
        out.push({ path: full, sizeBytes: size });
        if (out.length > 20000) return out; // safety cap
      }
    }
  }
  return out;
}

function buildMenu(): void {
  const isMac = process.platform === 'darwin';
  const template: Electron.MenuItemConstructorOptions[] = [
    ...(isMac
      ? ([
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
        ])
      : []),
    {
      label: 'File',
      submenu: [
        {
          label: 'New Conversation',
          accelerator: 'CmdOrCtrl+N',
          click: () => emitToRenderer({ type: 'running', conversationId: '__menu_new_conversation__', isRunning: false }),
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
        { role: 'undo', accelerator: 'CmdOrCtrl+Z', registerAccelerator: false },
        { role: 'redo', accelerator: 'Shift+CmdOrCtrl+Z', registerAccelerator: false },
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

app.whenReady().then(() => {
  nativeTheme.themeSource = 'dark';
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
  ollamaServer.stop();
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
