// 2026-04-18
// Updated 2026-04-18.
// Electron main process entry. Creates the single main window and
// registers every IPC handler the renderer invokes. Main-process state
// lives here — the Store, the RunnerManager, health probes, stats.

import { app, BrowserWindow, dialog, ipcMain, shell, Menu, nativeTheme } from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { Store } from './store';
import { RunnerManager } from './runner';
import { loadHistory } from './history';
import { probeBackendHealth, listInstalledReviewers, resolveBackendPath } from './health';
import {
  runGit,
  createWorktree,
  removeWorktree,
  detectBaseBranch,
  listBaseBranches,
  mergeAgent,
  rebaseAgent,
  pushBranch,
  openPR,
  worktreeStatus,
  rescueMainTree,
  commitStatus,
  commitAll,
} from './git';
import { computeStats } from './stats';
import { scanCapabilities } from './capabilities';
import { detectHardware, detectOllama, installOllama, ollamaServer, pullModel } from './ollama';
import { ensureWorkspaceSymlinkRoot } from './workspace';
import { runInTerminal } from './terminal';
import { Backend, MainToRendererEvent, StreamEventKind, StreamEvent } from '../shared/types';

// Dev vs prod: we go to the Vite dev server ONLY when VITE_DEV_SERVER_URL
// is explicitly set (the `dev:electron` npm script sets it). Anything else
// — packaged .app, unpackaged `npm start`, direct `electron .` — loads
// from the built file:// HTML. Earlier this was `!app.isPackaged`, which
// incorrectly sent `npm start` at the Vite URL that wasn't running.
const DEV_URL = process.env.VITE_DEV_SERVER_URL;
const isDev = !!DEV_URL;

let mainWindow: BrowserWindow | null = null;
let runner: RunnerManager | null = null;

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 840,
    minWidth: 960,
    minHeight: 600,
    title: 'OverCLI',
    titleBarStyle: 'hiddenInset',
    backgroundColor: '#1c1c21',
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
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
}

function emitToRenderer(event: MainToRendererEvent): void {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('main:event', event);
  }
}

function registerIpc(): void {
  runner = new RunnerManager(emitToRenderer, () => Store.load().settings);

  ipcMain.handle('store:load', () => Store.load());
  ipcMain.handle('store:saveProjects', (_e, projects) => Store.saveProjects(projects));
  ipcMain.handle('store:saveWorkspaces', (_e, workspaces) => Store.saveWorkspaces(workspaces));
  ipcMain.handle('store:saveColosseums', (_e, colosseums) => Store.saveColosseums(colosseums));
  ipcMain.handle('store:saveSettings', (_e, settings) => Store.saveSettings(settings));
  ipcMain.handle('store:saveSelection', (_e, id) => Store.saveSelection(id));

  ipcMain.handle('runner:send', (_e, args) => runner!.send(args));
  ipcMain.handle('runner:stop', (_e, { conversationId }) => runner!.stop(conversationId));
  ipcMain.handle('runner:newConversation', (_e, { conversationId }) =>
    runner!.newConversation(conversationId),
  );
  ipcMain.handle('runner:respondPermission', (_e, { conversationId, requestId, approved }) =>
    runner!.respondPermission(conversationId, requestId, approved),
  );
  ipcMain.handle(
    'runner:respondCodexApproval',
    (_e, { conversationId, callId, kind, approved }) =>
      runner!.respondCodexApproval(conversationId, callId, kind, approved),
  );
  ipcMain.handle('runner:loadHistory', (_e, args) => loadHistory(args));
  ipcMain.handle('runner:probeHealth', (_e, backend: 'claude' | 'codex' | 'gemini' | 'ollama') => {
    const settings = Store.load().settings;
    return probeBackendHealth(backend, settings.backendPaths[backend]);
  });
  ipcMain.handle('runner:listInstalledReviewers', () => listInstalledReviewers());
  ipcMain.handle('capabilities:scan', () => scanCapabilities());

  ipcMain.handle('fs:pickDirectory', async () => {
    if (!mainWindow) return null;
    const res = await dialog.showOpenDialog(mainWindow, {
      properties: ['openDirectory'],
    });
    if (res.canceled || res.filePaths.length === 0) return null;
    return res.filePaths[0];
  });
  ipcMain.handle('fs:readFile', (_e, filePath: string) => {
    try {
      const stat = fs.statSync(filePath);
      if (stat.size > 5 * 1024 * 1024) {
        return { ok: false, error: `File is ${Math.round(stat.size / 1024 / 1024)} MB. Editor only opens files under 5 MB.` };
      }
      const content = fs.readFileSync(filePath, 'utf-8');
      if (content.includes('\0')) {
        return { ok: false, error: 'Binary file — editor only opens text.' };
      }
      return { ok: true, content };
    } catch (err: any) {
      return { ok: false, error: err?.message ?? 'Could not read file' };
    }
  });
  ipcMain.handle('fs:writeFile', (_e, { path: p, content }) => {
    try {
      fs.writeFileSync(p, content, 'utf-8');
      return { ok: true };
    } catch (err: any) {
      return { ok: false, error: err?.message ?? 'Could not write file' };
    }
  });
  ipcMain.handle('fs:listFiles', (_e, root: string) => listFilesRecursive(root));
  ipcMain.handle('fs:openInFinder', (_e, p: string) => {
    shell.showItemInFolder(p);
  });

  ipcMain.handle('git:run', (_e, { args, cwd }) => runGit(args, cwd));
  ipcMain.handle('git:createWorktree', (_e, args) => createWorktree(args));
  ipcMain.handle('git:removeWorktree', (_e, args) => removeWorktree(args));
  ipcMain.handle('git:listBaseBranches', (_e, projectPath: string) => listBaseBranches(projectPath));
  ipcMain.handle('git:detectBaseBranch', (_e, projectPath: string) =>
    detectBaseBranch(projectPath),
  );
  ipcMain.handle('git:mergeAgent', (_e, args) => mergeAgent(args));
  ipcMain.handle('git:rebaseAgent', (_e, args) => rebaseAgent(args));
  ipcMain.handle('git:pushBranch', (_e, args) => pushBranch(args));
  ipcMain.handle('git:openPR', (_e, args) => openPR(args));
  ipcMain.handle('git:worktreeStatus', (_e, args) => worktreeStatus(args));
  ipcMain.handle('git:rescueMainTree', (_e, args) => rescueMainTree(args));
  ipcMain.handle('git:commitStatus', (_e, { cwd }) => commitStatus(cwd));
  ipcMain.handle('git:commitAll', (_e, args) => commitAll(args));

  ipcMain.handle('workspace:ensureSymlinkRoot', (_e, { workspaceId, projects }) =>
    ensureWorkspaceSymlinkRoot(workspaceId, projects),
  );

  ipcMain.handle('app:openExternal', (_e, url: string) => shell.openExternal(url));
  ipcMain.handle('app:showAbout', () => {
    dialog.showMessageBox({
      type: 'info',
      title: 'About OverCLI',
      message: 'OverCLI',
      detail: 'Electron GUI wrapper around the Claude CLI.\nPorted from the Swift/SwiftUI build.',
    });
  });
  ipcMain.handle('app:reloadStats', () => computeStats());

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

  ipcMain.handle('ollama:detect', () => detectOllama());
  ipcMain.handle('ollama:hardware', () => detectHardware());
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
}

// In-flight Ollama pulls, keyed by model tag. Cancelling is just aborting
// the HTTP request we opened in pullModel.
const pendingPulls = new Map<string, AbortController>();

function listFilesRecursive(root: string): string[] {
  const skipDirs = new Set([
    '.git',
    'node_modules',
    '.build',
    'build',
    'dist',
    '.next',
    '.venv',
    'venv',
    '__pycache__',
    '.DS_Store',
    'DerivedData',
    '.swiftpm',
  ]);
  const out: string[] = [];
  const stack: string[] = [root];
  while (stack.length) {
    const cur = stack.pop()!;
    let entries: string[];
    try {
      entries = fs.readdirSync(cur);
    } catch {
      continue;
    }
    for (const name of entries) {
      if (skipDirs.has(name)) continue;
      const full = path.join(cur, name);
      let stat: fs.Stats;
      try {
        stat = fs.statSync(full);
      } catch {
        continue;
      }
      if (stat.isDirectory()) {
        stack.push(full);
      } else if (stat.isFile()) {
        out.push(full);
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
    { role: 'editMenu' },
    { role: 'viewMenu' },
    { role: 'windowMenu' },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

app.whenReady().then(() => {
  nativeTheme.themeSource = 'dark';
  registerIpc();
  buildMenu();
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  runner?.killAll();
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  runner?.killAll();
  ollamaServer.stop();
});

// Silence "uncaught exception" dialogs during dev — errors still land in
// the devtools console. Don't do this in prod where a real crash should
// surface.
if (isDev) {
  process.on('uncaughtException', (err) => {
    console.error('Uncaught main-process exception:', err);
  });
}
