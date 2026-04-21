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
import { loadHistory, migrateClaudeSessionCwd } from './history';
import { probeBackendHealth, listInstalledReviewers, resolveBackendPath } from './health';
import {
  runGit,
  createWorktree,
  createReviewWorktree,
  promoteReviewWorktree,
  switchProjectToBranch,
  removeWorktree,
  checkoutAgentLocally,
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
import { ensureWorkspaceSymlinkRoot, removeWorkspaceSymlinkRoot } from './workspace';
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
  ipcMain.handle('runner:respondPermission', (_e, { conversationId, requestId, approved, addDir }) =>
    runner!.respondPermission(conversationId, requestId, approved, addDir),
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
  ipcMain.handle('fs:readFile', (_e, args: { path: string; rootPath?: string }) => {
    const resolved = resolveFilePath(args?.path ?? '', args?.rootPath);
    if (!resolved) {
      return { ok: false, error: `Could not find "${args?.path ?? ''}" in any registered project.` };
    }
    if (!isPathUnderRegisteredRoot(resolved)) {
      return { ok: false, error: 'File is outside any registered project, workspace, or worktree.' };
    }
    try {
      const stat = fs.statSync(resolved);
      if (stat.size > 5 * 1024 * 1024) {
        return { ok: false, error: `File is ${Math.round(stat.size / 1024 / 1024)} MB. Editor only opens files under 5 MB.` };
      }
      const content = fs.readFileSync(resolved, 'utf-8');
      if (content.includes('\0')) {
        return { ok: false, error: 'Binary file — editor only opens text.' };
      }
      return { ok: true, content, resolvedPath: resolved };
    } catch (err: any) {
      return { ok: false, error: err?.message ?? 'Could not read file' };
    }
  });
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
  ipcMain.handle('fs:openInFinder', (_e, p: string) => {
    if (!isPathUnderRegisteredRoot(p)) return;
    shell.showItemInFolder(p);
  });

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
  ipcMain.handle('git:rescueMainTree', (_e, args) => rescueMainTree(args));
  ipcMain.handle('git:commitStatus', (_e, { cwd }) => commitStatus(cwd));
  ipcMain.handle('git:commitAll', (_e, args) => commitAll(args));

  ipcMain.handle('workspace:ensureSymlinkRoot', (_e, { workspaceId, projects }) =>
    ensureWorkspaceSymlinkRoot(workspaceId, projects),
  );
  ipcMain.handle('workspace:removeSymlinkRoot', (_e, workspaceId: string) =>
    removeWorkspaceSymlinkRoot(workspaceId),
  );

  ipcMain.handle('app:openExternal', (_e, url: string) => {
    if (!isSafeExternalUrl(url)) return;
    return shell.openExternal(url);
  });
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
}

// In-flight Ollama pulls, keyed by model tag. Cancelling is just aborting
// the HTTP request we opened in pullModel.
const pendingPulls = new Map<string, AbortController>();

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
    }
  }
  return [...roots];
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
  const roots = registeredRoots();
  if (roots.length === 0) return false;
  const resolvedTarget = resolveExistingAncestor(path.resolve(target));
  for (const root of roots) {
    let resolvedRoot: string;
    try {
      resolvedRoot = fs.realpathSync(path.resolve(root));
    } catch {
      continue;
    }
    const rel = path.relative(resolvedRoot, resolvedTarget);
    if (rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))) return true;
  }
  return false;
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
      return path.join(fs.realpathSync(current), ...tail);
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
