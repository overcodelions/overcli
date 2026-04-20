// Central renderer store. Holds everything the UI binds to: projects,
// workspaces, conversations, per-conversation runner state (events,
// isRunning, activity), settings, sheet state, file editor state.
//
// Uses Zustand for minimal ceremony. Every UI action is a method on this
// store; components subscribe to the slices they care about via selectors.

import { create } from 'zustand';
import {
  AppSettings,
  Attachment,
  BackendHealth,
  CapabilitiesReport,
  Colosseum,
  Conversation,
  DEFAULT_SETTINGS,
  Project,
  StreamEvent,
  SystemInitInfo,
  UUID,
  Workspace,
  Backend,
  PermissionMode,
  EffortLevel,
  MainToRendererEvent,
} from '@shared/types';
import { FileViewMode, defaultFileViewMode } from './filePreview';
import { workspaceSymlinkNames } from '@shared/workspaceNames';
const ALL_BACKENDS: Backend[] = ['claude', 'codex', 'gemini', 'ollama'];

export type ActiveSheet =
  | { type: 'settings' }
  | { type: 'debug' }
  | { type: 'about' }
  | { type: 'capabilities' }
  | { type: 'newAgent'; projectId: UUID }
  | { type: 'newWorkspace' }
  | { type: 'editWorkspace'; workspaceId: UUID }
  | { type: 'newWorkspaceAgent'; workspaceId: UUID }
  | { type: 'newColosseum'; projectId: UUID }
  | { type: 'colosseumCompare'; colosseumId: UUID }
  | { type: 'worktreeDiff'; convId: UUID }
  | { type: 'workspaceAgentReview'; coordinatorId: UUID }
  | { type: 'archiveConversation'; convId: UUID }
  | { type: 'archiveAllInProject'; projectId: UUID }
  | { type: 'archiveAllInWorkspace'; workspaceId: UUID }
  | { type: 'fileFinder'; rootPath: string }
  | { type: 'quickSwitcher' };

export type DetailMode = 'conversation' | 'stats' | 'local';

export interface OpenFileHighlight {
  startLine: number;
  endLine: number;
  requestId: string;
}

/// Working-tree snapshot for a conversation's cwd (main project or
/// worktree). Mirrors the `git:commitStatus` IPC response so renderer
/// components can consume it directly without reshaping.
export interface GitStatus {
  isRepo: boolean;
  currentBranch: string;
  changes: Array<{ path: string; status: string; additions: number; deletions: number }>;
  insertions: number;
  deletions: number;
}

/// Per-conversation runtime state. Keyed off conversation id.
export interface RunnerState {
  events: StreamEvent[];
  isRunning: boolean;
  activityLabel?: string;
  errorMessage?: string;
  pendingLocalUserIds: Set<UUID>;
  /// Current model as reported by system:init events. May diverge from
  /// conv.currentModel if the user switched mid-session.
  currentModel: string;
  /// History load state — prevents double-loading and drives the
  /// loading indicator in ChatView.
  historyLoaded: boolean;
  historyLoading: boolean;
  /// Codex runtime mode/flags for the currently running subprocess.
  codexRuntimeMode?: 'proto' | 'exec';
  codexSandboxMode?: string;
  codexApprovalPolicy?: string;
}

interface StoreState {
  // Persistent model
  projects: Project[];
  workspaces: Workspace[];
  colosseums: Colosseum[];
  settings: AppSettings;
  lastInit?: SystemInitInfo;

  // Session UI state
  selectedConversationId: UUID | null;
  focusedProjectId: UUID | null;
  focusedWorkspaceId: UUID | null;
  detailMode: DetailMode;
  activeSheet: ActiveSheet | null;
  openFilePath: string | null;
  openFileHighlight: OpenFileHighlight | null;
  openFileMode: FileViewMode;
  showFileTree: boolean;
  showHiddenConversations: boolean;
  sidebarVisible: boolean;
  /// Global toggle: show tool-use / tool-result cards in chat. Off
  /// collapses the chat to just the model's assistant text for a cleaner
  /// reading view. Persisted the next time we save settings.
  showToolActivity: boolean;
  pendingFinderQuery: string;
  conversationDrafts: Record<UUID, string>;
  /// Per-conversation pending attachments (images). Cleared on send, the
  /// same way `conversationDrafts` is. Keyed by a sentinel ID when the
  /// user is on the welcome page and no conversation exists yet.
  conversationAttachments: Record<string, Attachment[]>;
  backendHealth: Record<string, BackendHealth>;
  installedReviewers: Record<string, boolean>;
  capabilities: CapabilitiesReport | null;
  /// Live Ollama server status. Pushed from main via the
  /// `ollamaServerStatus` event. Used to warn users in-chat when they're
  /// talking to an Ollama-backed conversation and the server is down.
  ollamaServerStatus: 'stopped' | 'starting' | 'running' | 'error' | 'unknown';

  // Runtime
  runners: Record<UUID, RunnerState>;
  /// Cached git working-tree status per conversation. Populated on
  /// demand via `refreshGitStatus`. Both the header CommitButton and
  /// the ChangesBar above the composer read from this so they show
  /// the same numbers — the earlier, event-derived count in ChangesBar
  /// could drift from real git state during edit-then-revert loops.
  gitStatusByConv: Record<UUID, GitStatus>;

  // Actions
  init(): Promise<void>;
  selectConversation(id: UUID | null): void;
  startNewConversation(projectId: UUID): void;
  startNewConversationInWorkspace(workspaceId: UUID): void;
  setDetailMode(mode: DetailMode): void;
  openSheet(sheet: ActiveSheet | null): void;
  openFile(path: string, highlight?: OpenFileHighlight, mode?: FileViewMode): void;
  setOpenFileMode(mode: FileViewMode): void;
  closeFile(): void;
  toggleFileTree(): void;
  toggleSidebar(): void;
  toggleToolActivity(): void;
  setDraft(id: UUID, text: string): void;
  addAttachment(key: string, attachment: Attachment): void;
  removeAttachment(key: string, attachmentId: string): void;
  clearAttachments(key: string): void;

  // Persistence bridges
  saveProjects(): Promise<void>;
  saveWorkspaces(): Promise<void>;
  saveColosseums(): Promise<void>;
  saveSettings(next: AppSettings): Promise<void>;

  // Project / workspace mutations
  addProject(project: Project): Promise<void>;
  renameProject(id: UUID, name: string): Promise<void>;
  removeProject(id: UUID): Promise<void>;
  removeWorkspace(id: UUID): Promise<void>;
  pickProject(): Promise<void>;
  newConversation(projectId: UUID): Promise<Conversation>;
  newConversationInWorkspace(workspaceId: UUID): Promise<Conversation | null>;
  newWorkspace(name: string, projectIds: UUID[]): Promise<Workspace | null>;
  updateWorkspaceProjects(workspaceId: UUID, projectIds: UUID[]): Promise<boolean>;
  newWorkspaceAgent(args: {
    workspaceId: UUID;
    name: string;
    /// Per-member base branches, keyed by project id. Each member project
    /// in the workspace branches off its own resolved base, so a repo on
    /// `main` and one on `master` can coexist in the same workspace agent.
    baseBranches: Record<UUID, string>;
  }): Promise<Conversation | null>;
  /// Read-only docs agent that spans every member repo in a workspace.
  /// Creates no worktrees — the coordinator runs in the workspace's
  /// symlink root so it can read every member project at HEAD, and the
  /// auto-fired prompt instructs it to output docs as markdown in chat
  /// for the specific `topic` the user described.
  newWorkspaceDocsAgent(args: {
    workspaceId: UUID;
    name: string;
    topic: string;
  }): Promise<Conversation | null>;
  cancelColosseum(id: UUID): Promise<void>;
  resolveColosseum(id: UUID, winnerId: UUID): Promise<void>;
  removeColosseum(id: UUID): Promise<void>;
  removeConversation(id: UUID): Promise<void>;
  /// Agent-specific teardown: git worktree remove (including branch),
  /// then remove the conversation entry. For workspace-agent
  /// coordinators, removes every member's worktree too.
  removeAgent(id: UUID): Promise<{ ok: boolean; error?: string }>;
  /// Auto-commit the dirty worktree, stash any project-side changes,
  /// remove the worktree (keeping the branch), switch the project repo
  /// onto that branch, and demote the conversation from agent to a normal
  /// project conversation (history preserved, worktree fields cleared).
  checkoutAgentLocally(
    id: UUID,
    commitSubject: string,
    commitBody?: string,
  ): Promise<
    | { ok: true; message: string; stashed: boolean; autoCommitted: boolean }
    | { ok: false; error: string }
  >;
  /// Turn a review agent (detached-HEAD worktree) into a regular agent
  /// by creating a branch at HEAD. Clears the review flag so the header
  /// drops the review-specific buttons.
  promoteReviewAgent(id: UUID): Promise<{ ok: true } | { ok: false; error: string }>;
  /// Switch the main project checkout onto the branch the review was
  /// inspecting and remove the review worktree. The conversation is
  /// demoted to a normal project conversation.
  checkoutReviewBranchLocally(id: UUID): Promise<
    | { ok: true; message: string; stashed: boolean }
    | { ok: false; error: string }
  >;
  setConversationHidden(id: UUID, hidden: boolean): Promise<void>;
  archiveInactiveInProject(projectId: UUID): Promise<number>;
  archiveInactiveInWorkspace(workspaceId: UUID): Promise<number>;
  setPrimaryBackend(id: UUID, backend: Backend): Promise<void>;
  setPermissionMode(id: UUID, mode: PermissionMode): Promise<void>;
  setBackendModel(id: UUID, backend: Backend, model: string): Promise<void>;
  setEffortLevel(id: UUID, effort: EffortLevel): Promise<void>;
  setReviewBackend(id: UUID, backend: string | null): Promise<void>;
  setReviewMode(id: UUID, mode: 'review' | 'collab'): Promise<void>;
  setReviewOllamaModel(id: UUID, model: string | null): Promise<void>;
  renameConversation(id: UUID, name: string): Promise<void>;

  // Runner
  send(conversationId: UUID, prompt: string): Promise<void>;
  stop(conversationId: UUID): Promise<void>;
  resetConversation(conversationId: UUID): Promise<void>;
  respondPermission(
    conversationId: UUID,
    requestId: string,
    approved: boolean,
    addDir?: string,
  ): Promise<void>;
  respondCodexApproval(
    conversationId: UUID,
    callId: string,
    kind: 'exec' | 'patch',
    approved: boolean,
  ): Promise<void>;
  loadHistoryIfNeeded(conversationId: UUID): Promise<void>;

  // Health
  refreshBackendHealth(): Promise<void>;
  refreshInstalledReviewers(): Promise<void>;
  refreshCapabilities(): Promise<void>;
  refreshGitStatus(conversationId: UUID): Promise<void>;

  // Event routing — called from the preload's onMainEvent bridge.
  ingestMainEvent(event: MainToRendererEvent): void;
}

function uuid(): string {
  // crypto.randomUUID is available in Electron's renderer via the browser
  // Crypto API when secure context is enabled; fallback for older runtimes.
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

function newRunnerState(): RunnerState {
  return {
    events: [],
    isRunning: false,
    activityLabel: undefined,
    errorMessage: undefined,
    pendingLocalUserIds: new Set(),
    currentModel: '',
    historyLoaded: false,
    historyLoading: false,
    codexRuntimeMode: undefined,
    codexSandboxMode: undefined,
    codexApprovalPolicy: undefined,
  };
}

function findConversation(state: StoreState, id: UUID): Conversation | null {
  for (const p of state.projects) {
    const c = p.conversations.find((x) => x.id === id);
    if (c) return c;
  }
  for (const w of state.workspaces) {
    const c = w.conversations?.find((x) => x.id === id);
    if (c) return c;
  }
  return null;
}

function isAgentConversation(conv: Conversation): boolean {
  return !!conv.worktreePath || (conv.workspaceAgentMemberIds?.length ?? 0) > 0;
}

/// Ask the main process which Ollama models are actually pulled locally
/// and pick one. Prefers the configured default *only* if it's installed —
/// otherwise falls back to whatever is on disk. Returns null if Ollama
/// detection fails or no models are pulled, so callers can surface a
/// clear error instead of blindly using a tag the server doesn't have.
async function pickInstalledOllamaModel(settings: AppSettings): Promise<string | null> {
  try {
    const det = await window.overcli.invoke('ollama:detect');
    const names = det.models.map((m) => m.name);
    if (names.length === 0) return null;
    const configured = settings.backendDefaultModels.ollama;
    if (configured && names.includes(configured)) return configured;
    return names[0];
  } catch {
    return null;
  }
}

async function ensureWorkspaceRoot(
  projects: Project[],
  workspaceId: UUID,
  projectIds: UUID[],
): Promise<string | null> {
  const refs = projectIds
    .map((pid) => projects.find((p) => p.id === pid))
    .filter((p): p is Project => !!p)
    .map((p) => ({ name: p.name, path: p.path }));
  if (refs.length === 0) return null;
  const res = await window.overcli.invoke('workspace:ensureSymlinkRoot', {
    workspaceId,
    projects: refs,
  });
  if (!res.ok) {
    console.warn(`Failed to create workspace root: ${res.error}`);
    return null;
  }
  return res.rootPath;
}

/// For a coordinator's memberIds, return the list of
/// `{name, worktreePath}` records the main-process helper wants. The
/// name is the project's human name (with numeric dedup on collision)
/// so it matches what the on-disk symlink gets called.
function collectCoordinatorMembers(
  projects: Array<{ name: string; conversations: Array<{ id: string; worktreePath?: string }> }>,
  memberIds: UUID[],
): Array<{ name: string; worktreePath: string }> {
  const out: Array<{ name: string; worktreePath: string }> = [];
  const used = new Set<string>();
  for (const memberId of memberIds) {
    for (const proj of projects) {
      const member = proj.conversations.find((x) => x.id === memberId);
      if (!member?.worktreePath) continue;
      let name = proj.name;
      let i = 2;
      while (used.has(name)) {
        name = `${proj.name}-${i}`;
        i += 1;
      }
      used.add(name);
      out.push({ name, worktreePath: member.worktreePath });
      break;
    }
  }
  return out;
}

function findContainerPath(state: StoreState, convId: UUID): string | null {
  for (const p of state.projects) {
    const c = p.conversations.find((x) => x.id === convId);
    if (c) return c.worktreePath ?? p.path;
  }
  for (const w of state.workspaces) {
    const c = w.conversations?.find((x) => x.id === convId);
    if (c) {
      // Workspace-agent coordinators run out of a dedicated root whose
      // symlinks point at each member's worktree — never the workspace's
      // main-tree symlinks, or edits would land on main and bypass the
      // agent branches.
      return c.coordinatorRootPath ?? c.worktreePath ?? w.rootPath;
    }
  }
  return null;
}

/// Directories we pass to Claude as `--add-dir` so its session-scope check
/// admits them. Covers the conversation's container (project/workspace
/// root + workspace-member projects) plus any dirs the user approved
/// on-the-fly via the permission card.
function computeAllowedDirs(state: StoreState, convId: UUID): string[] {
  const dirs: string[] = [];
  for (const p of state.projects) {
    const c = p.conversations.find((x) => x.id === convId);
    if (c) {
      dirs.push(p.path);
      if (c.worktreePath) dirs.push(c.worktreePath);
      for (const d of c.allowedDirs ?? []) dirs.push(d);
      return dirs;
    }
  }
  for (const w of state.workspaces) {
    const c = w.conversations?.find((x) => x.id === convId);
    if (c) {
      if (c.coordinatorRootPath) {
        // Coordinator: cwd is a root of symlinks to member worktrees.
        // Add the member worktrees explicitly — the main project paths
        // are intentionally NOT listed so the agent doesn't escape back
        // to the main tree.
        dirs.push(c.coordinatorRootPath);
        for (const memberId of c.workspaceAgentMemberIds ?? []) {
          for (const proj of state.projects) {
            const member = proj.conversations.find((x) => x.id === memberId);
            if (member?.worktreePath) dirs.push(member.worktreePath);
          }
        }
      } else {
        dirs.push(w.rootPath);
        for (const pid of w.projectIds) {
          const proj = state.projects.find((p) => p.id === pid);
          if (proj) dirs.push(proj.path);
        }
      }
      if (c.worktreePath) dirs.push(c.worktreePath);
      for (const d of c.allowedDirs ?? []) dirs.push(d);
      return dirs;
    }
  }
  return dirs;
}

function isBackendEnabled(settings: AppSettings, backend: Backend): boolean {
  return settings.disabledBackends?.[backend] !== true;
}

function enabledBackends(settings: AppSettings): Backend[] {
  return ALL_BACKENDS.filter((b) => isBackendEnabled(settings, b));
}

function defaultBackend(settings: AppSettings): Backend {
  return enabledBackends(settings)[0] ?? 'claude';
}

export const useStore = create<StoreState>((set, get) => ({
  projects: [],
  workspaces: [],
  colosseums: [],
  settings: { ...DEFAULT_SETTINGS },
  selectedConversationId: null,
  focusedProjectId: null,
  focusedWorkspaceId: null,
  detailMode: 'conversation',
  activeSheet: null,
  openFilePath: null,
  openFileHighlight: null,
  openFileMode: 'edit',
  showFileTree: false,
  showHiddenConversations: false,
  sidebarVisible: true,
  showToolActivity: false,
  pendingFinderQuery: '',
  conversationDrafts: {},
  conversationAttachments: {},
  backendHealth: {},
  installedReviewers: {},
  capabilities: null,
  ollamaServerStatus: 'unknown',
  runners: {},
  gitStatusByConv: {},

  async init() {
    const state = await window.overcli.invoke('store:load');
    // Reconcile every workspace's symlink root: backfills `rootPath` for
    // workspaces saved before this existed, and refreshes the symlink set
    // when a member project has been added/removed/renamed since launch.
    let workspacesChanged = false;
    const workspaces: Workspace[] = [];
    for (const ws of state.workspaces) {
      const rootPath = await ensureWorkspaceRoot(state.projects, ws.id, ws.projectIds);
      // Backfill coordinator symlink roots for agents saved before the
      // per-coordinator root existed. Without this, existing workspace
      // agents keep writing via workspace-level symlinks into the main
      // tree. We also reconcile links in case a member's worktree moved.
      const reconciledConvs: Conversation[] = [];
      let convsChanged = false;
      for (const conv of ws.conversations ?? []) {
        const memberIds = conv.workspaceAgentMemberIds;
        if (!memberIds?.length) {
          reconciledConvs.push(conv);
          continue;
        }
        const members = collectCoordinatorMembers(state.projects, memberIds);
        if (members.length === 0) {
          reconciledConvs.push(conv);
          continue;
        }
        const res = await window.overcli.invoke('workspace:ensureCoordinatorSymlinkRoot', {
          coordinatorId: conv.id,
          members,
        });
        if (res.ok && res.rootPath !== conv.coordinatorRootPath) {
          reconciledConvs.push({ ...conv, coordinatorRootPath: res.rootPath });
          convsChanged = true;
        } else {
          reconciledConvs.push(conv);
        }
      }
      const nextWs: Workspace = { ...ws };
      if (convsChanged) nextWs.conversations = reconciledConvs;
      if (rootPath && rootPath !== ws.rootPath) nextWs.rootPath = rootPath;
      if (convsChanged || (rootPath && rootPath !== ws.rootPath)) {
        workspacesChanged = true;
        workspaces.push(nextWs);
      } else {
        workspaces.push(ws);
      }
    }
    set({
      projects: state.projects,
      workspaces,
      colosseums: state.colosseums,
      settings: state.settings,
      lastInit: state.lastInit,
      selectedConversationId: state.selectedConversationId ?? null,
    });
    if (workspacesChanged) await get().saveWorkspaces();
    await get().refreshBackendHealth();
    await get().refreshInstalledReviewers();
    void get().refreshCapabilities();
    // Seed Ollama server status once at startup so the conversation
    // banner can tell on first paint whether the local server is up.
    // Live updates flow through `ingestMainEvent` after this.
    void window.overcli
      .invoke('ollama:serverStatus')
      .then((res) => set({ ollamaServerStatus: res.status }))
      .catch(() => {});
    // Preload history for the currently-selected conversation so switching
    // back to it is instant.
    if (state.selectedConversationId) {
      await get().loadHistoryIfNeeded(state.selectedConversationId);
    }
  },

  selectConversation(id) {
    set((s) => ({
      selectedConversationId: id,
      detailMode: id ? 'conversation' : s.detailMode,
      focusedProjectId: id ? null : s.focusedProjectId,
      focusedWorkspaceId: id ? null : s.focusedWorkspaceId,
    }));
    window.overcli.invoke('store:saveSelection', id);
    if (id) void get().loadHistoryIfNeeded(id);
  },

  startNewConversation(projectId) {
    // Show the composer-first WelcomePane for this project instead of
    // materializing an empty conversation. The conversation is created
    // when the user actually sends their first message.
    set({
      selectedConversationId: null,
      detailMode: 'conversation',
      focusedProjectId: projectId,
      focusedWorkspaceId: null,
    });
    window.overcli.invoke('store:saveSelection', null);
  },

  startNewConversationInWorkspace(workspaceId) {
    set({
      selectedConversationId: null,
      detailMode: 'conversation',
      focusedProjectId: null,
      focusedWorkspaceId: workspaceId,
    });
    window.overcli.invoke('store:saveSelection', null);
  },

  setDetailMode(mode) {
    set({ detailMode: mode });
  },

  openSheet(sheet) {
    set({ activeSheet: sheet });
  },

  openFile(path, highlight, mode) {
    set({
      openFilePath: path,
      openFileHighlight: highlight ?? null,
      openFileMode: defaultFileViewMode(path, !!highlight, mode),
    });
  },

  setOpenFileMode(mode) {
    set({ openFileMode: mode });
  },

  closeFile() {
    set({ openFilePath: null, openFileHighlight: null, openFileMode: 'edit' });
  },

  toggleFileTree() {
    set((s) => ({ showFileTree: !s.showFileTree }));
  },

  toggleSidebar() {
    set((s) => ({ sidebarVisible: !s.sidebarVisible }));
  },

  toggleToolActivity() {
    set((s) => ({ showToolActivity: !s.showToolActivity }));
  },

  setDraft(id, text) {
    set((s) => ({ conversationDrafts: { ...s.conversationDrafts, [id]: text } }));
  },

  addAttachment(key, attachment) {
    set((s) => ({
      conversationAttachments: {
        ...s.conversationAttachments,
        [key]: [...(s.conversationAttachments[key] ?? []), attachment],
      },
    }));
  },

  removeAttachment(key, attachmentId) {
    set((s) => ({
      conversationAttachments: {
        ...s.conversationAttachments,
        [key]: (s.conversationAttachments[key] ?? []).filter((a) => a.id !== attachmentId),
      },
    }));
  },

  clearAttachments(key) {
    set((s) => {
      const next = { ...s.conversationAttachments };
      delete next[key];
      return { conversationAttachments: next };
    });
  },

  async saveProjects() {
    await window.overcli.invoke('store:saveProjects', get().projects);
  },
  async saveWorkspaces() {
    await window.overcli.invoke('store:saveWorkspaces', get().workspaces);
  },
  async saveColosseums() {
    await window.overcli.invoke('store:saveColosseums', get().colosseums);
  },
  async saveSettings(next) {
    set({ settings: next });
    await window.overcli.invoke('store:saveSettings', next);
    await get().refreshBackendHealth();
    await get().refreshInstalledReviewers();
  },

  async addProject(project) {
    set((s) => ({ projects: [...s.projects, project] }));
    await get().saveProjects();
  },

  async renameProject(id, name) {
    set((s) => ({
      projects: s.projects.map((p) => (p.id === id ? { ...p, name } : p)),
    }));
    await get().saveProjects();
  },

  async removeProject(id) {
    const state = get();
    const project = state.projects.find((p) => p.id === id);
    if (!project) return;

    const removedConversationIds = new Set(project.conversations.map((c) => c.id));
    const impactedWorkspaces = state.workspaces.filter((w) => w.projectIds.includes(id));
    const deletedWorkspaceIds = new Set(
      impactedWorkspaces
        .filter((w) => w.projectIds.filter((pid) => pid !== id).length === 0)
        .map((w) => w.id),
    );

    const runningIds = new Set<UUID>();
    for (const conv of project.conversations) {
      if (state.runners[conv.id]?.isRunning) runningIds.add(conv.id);
    }
    for (const ws of impactedWorkspaces) {
      for (const conv of ws.conversations ?? []) {
        const touchesProject =
          deletedWorkspaceIds.has(ws.id) ||
          conv.workspaceAgentMemberIds?.some((memberId) => removedConversationIds.has(memberId));
        if (touchesProject && state.runners[conv.id]?.isRunning) runningIds.add(conv.id);
      }
    }
    for (const convId of runningIds) {
      await get().stop(convId);
    }

    for (const colosseum of state.colosseums.filter((c) => c.projectId === id)) {
      await get().removeColosseum(colosseum.id);
    }

    const remainingProject = get().projects.find((p) => p.id === id);
    for (const conv of [...(remainingProject?.conversations ?? [])]) {
      if (isAgentConversation(conv)) await get().removeAgent(conv.id);
      else await get().removeConversation(conv.id);
    }

    for (const ws of impactedWorkspaces.filter((w) => deletedWorkspaceIds.has(w.id))) {
      for (const conv of [...(ws.conversations ?? [])]) {
        if (isAgentConversation(conv)) await get().removeAgent(conv.id);
        else await get().removeConversation(conv.id);
      }
    }
    for (const ws of impactedWorkspaces.filter((w) => deletedWorkspaceIds.has(w.id))) {
      const res = await window.overcli.invoke('workspace:removeSymlinkRoot', ws.id);
      if (!res.ok) console.warn(`Failed to remove workspace root for ${ws.name}: ${res.error}`);
    }

    const current = get();
    const remainingProjects = current.projects.filter((p) => p.id !== id);
    const nextWorkspaces: Workspace[] = [];
    for (const ws of current.workspaces) {
      const nextProjectIds = ws.projectIds.filter((pid) => pid !== id);
      if (nextProjectIds.length === 0) continue;

      const nextConversations = (ws.conversations ?? []).flatMap((conv) => {
        const memberIds = conv.workspaceAgentMemberIds;
        if (!memberIds?.length) return [conv];
        const filtered = memberIds.filter((memberId) => !removedConversationIds.has(memberId));
        if (filtered.length === 0) return [];
        if (filtered.length === memberIds.length) return [conv];
        return [{ ...conv, workspaceAgentMemberIds: filtered }];
      });

      let rootPath = ws.rootPath;
      if (ws.projectIds.includes(id)) {
        rootPath =
          (await ensureWorkspaceRoot(remainingProjects, ws.id, nextProjectIds)) ?? rootPath;
      }

      nextWorkspaces.push({
        ...ws,
        projectIds: nextProjectIds,
        conversations: nextConversations,
        rootPath,
      });
    }

    set((s) => ({
      projects: s.projects.filter((p) => p.id !== id),
      workspaces: nextWorkspaces,
      focusedProjectId: s.focusedProjectId === id ? null : s.focusedProjectId,
      focusedWorkspaceId:
        s.focusedWorkspaceId && !nextWorkspaces.some((w) => w.id === s.focusedWorkspaceId)
          ? null
          : s.focusedWorkspaceId,
    }));
    await get().saveProjects();
    await get().saveWorkspaces();
  },

  async removeWorkspace(id) {
    const workspace = get().workspaces.find((w) => w.id === id);
    if (!workspace) return;

    const runningIds = (workspace.conversations ?? [])
      .filter((conv) => get().runners[conv.id]?.isRunning)
      .map((conv) => conv.id);
    for (const convId of runningIds) {
      await get().stop(convId);
    }

    for (const conv of [...(workspace.conversations ?? [])]) {
      if (isAgentConversation(conv)) await get().removeAgent(conv.id);
      else await get().removeConversation(conv.id);
    }

    const res = await window.overcli.invoke('workspace:removeSymlinkRoot', id);
    if (!res.ok) {
      console.warn(`Failed to remove workspace root for ${workspace.name}: ${res.error}`);
    }

    set((s) => ({
      workspaces: s.workspaces.filter((w) => w.id !== id),
      focusedWorkspaceId: s.focusedWorkspaceId === id ? null : s.focusedWorkspaceId,
    }));
    await get().saveWorkspaces();
  },

  async pickProject() {
    const path = await window.overcli.invoke('fs:pickDirectory');
    if (!path) return;
    const name = path.split('/').filter(Boolean).slice(-1)[0] ?? 'Project';
    const project: Project = {
      id: uuid(),
      name,
      path,
      conversations: [],
      lastOpenedAt: Date.now(),
    };
    await get().addProject(project);
    get().startNewConversation(project.id);
  },

  async newConversation(projectId) {
    const preferred = defaultBackend(get().settings);
    const conv: Conversation = {
      id: uuid(),
      name: 'New conversation',
      createdAt: Date.now(),
      totalCostUSD: 0,
      turnCount: 0,
      currentModel: '',
      permissionMode: get().settings.defaultPermissionMode,
      primaryBackend: preferred,
    };
    set((s) => ({
      projects: s.projects.map((p) =>
        p.id === projectId ? { ...p, conversations: [...p.conversations, conv] } : p,
      ),
    }));
    await get().saveProjects();
    get().selectConversation(conv.id);
    return conv;
  },

  async newWorkspace(name, projectIds) {
    if (!name.trim() || projectIds.length === 0) return null;
    const id = uuid();
    const rootPath = await ensureWorkspaceRoot(get().projects, id, projectIds);
    if (!rootPath) return null;
    const ws: Workspace = {
      id,
      name: name.trim(),
      projectIds,
      rootPath,
      conversations: [],
      createdAt: Date.now(),
    };
    set((s) => ({ workspaces: [...s.workspaces, ws] }));
    await get().saveWorkspaces();
    return ws;
  },

  /// Replace a workspace's member project list. Rebuilds the symlink root
  /// so the new set of project links is materialized on disk before we
  /// persist. Existing agents/conversations inside the workspace are kept
  /// as-is — their worktrees already live under each project's own repo,
  /// so dropping a project here doesn't orphan any state.
  async updateWorkspaceProjects(workspaceId, projectIds) {
    if (projectIds.length === 0) return false;
    const ws = get().workspaces.find((w) => w.id === workspaceId);
    if (!ws) return false;
    const rootPath = await ensureWorkspaceRoot(get().projects, workspaceId, projectIds);
    if (!rootPath) return false;
    set((s) => ({
      workspaces: s.workspaces.map((w) =>
        w.id === workspaceId ? { ...w, projectIds, rootPath } : w,
      ),
    }));
    await get().saveWorkspaces();
    return true;
  },

  async newConversationInWorkspace(workspaceId) {
    const ws = get().workspaces.find((w) => w.id === workspaceId);
    if (!ws) return null;
    const preferred = defaultBackend(get().settings);
    const conv: Conversation = {
      id: uuid(),
      name: 'New conversation',
      createdAt: Date.now(),
      totalCostUSD: 0,
      turnCount: 0,
      currentModel: '',
      permissionMode: get().settings.defaultPermissionMode,
      primaryBackend: preferred,
    };
    set((s) => ({
      workspaces: s.workspaces.map((w) =>
        w.id === workspaceId
          ? { ...w, conversations: [...(w.conversations ?? []), conv] }
          : w,
      ),
    }));
    await get().saveWorkspaces();
    get().selectConversation(conv.id);
    return conv;
  },

  async newWorkspaceAgent(args) {
    const state = get();
    const preferred = defaultBackend(state.settings);
    const ws = state.workspaces.find((w) => w.id === args.workspaceId);
    if (!ws) return null;
    const name = args.name.trim();
    if (!name) return null;
    const agentSlug = name.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '');
    if (!agentSlug) return null;
    const coordinatorId = uuid();
    const memberIds: UUID[] = [];
    const coordinatorMembers: Array<{ name: string; worktreePath: string }> = [];

    // Spawn a git worktree in each member project and create a child
    // agent conversation there. The coordinator itself has no worktree
    // — it's a bookkeeping row that the sidebar renders as the parent
    // and that the user clicks to see the combined review sheet.
    for (const projectId of ws.projectIds) {
      const project = state.projects.find((p) => p.id === projectId);
      if (!project) continue;
      const baseBranch = args.baseBranches[projectId];
      if (!baseBranch) {
        console.warn(`No base branch for ${project.name}; skipping.`);
        continue;
      }
      const res = await window.overcli.invoke('git:createWorktree', {
        projectPath: project.path,
        agentName: agentSlug,
        baseBranch,
        branchPrefix: state.settings.agentBranchPrefix,
      });
      if (!res.ok) {
        console.warn(`Worktree create failed in ${project.name}: ${res.error}`);
        continue;
      }
      const memberId = uuid();
      memberIds.push(memberId);
      coordinatorMembers.push({
        name: project.name,
        worktreePath: res.worktreePath,
      });
      const memberConv: Conversation = {
        id: memberId,
        name: `${name} · ${project.name}`,
        createdAt: Date.now(),
        totalCostUSD: 0,
        turnCount: 0,
        currentModel: '',
        permissionMode: state.settings.defaultPermissionMode,
        primaryBackend: preferred,
        worktreePath: res.worktreePath,
        branchName: res.branchName,
        baseBranch,
        workspaceAgentCoordinatorId: coordinatorId,
        hidden: true, // members are visible under the coordinator, not in the project list
      };
      set((s) => ({
        projects: s.projects.map((p) =>
          p.id === projectId ? { ...p, conversations: [...p.conversations, memberConv] } : p,
        ),
      }));
    }

    if (memberIds.length === 0) {
      return null;
    }

    // Build the coordinator's synthetic cwd: symlinks into each member
    // worktree so agent edits land on the agent branches, not on main.
    let coordinatorRootPath: string | undefined;
    const rootRes = await window.overcli.invoke('workspace:ensureCoordinatorSymlinkRoot', {
      coordinatorId,
      members: coordinatorMembers,
    });
    if (rootRes.ok) {
      coordinatorRootPath = rootRes.rootPath;
    } else {
      console.warn(`Coordinator root create failed: ${rootRes.error}`);
    }

    const coordinator: Conversation = {
      id: coordinatorId,
      name,
      createdAt: Date.now(),
      totalCostUSD: 0,
      turnCount: 0,
      currentModel: '',
      permissionMode: state.settings.defaultPermissionMode,
      primaryBackend: preferred,
      workspaceAgentMemberIds: memberIds,
      branchName: `${state.settings.agentBranchPrefix}${agentSlug}`,
      coordinatorRootPath,
      // No coordinator-level baseBranch: each member branches off its
      // own base, stored on the member conversation.
    };
    set((s) => ({
      workspaces: s.workspaces.map((w) =>
        w.id === args.workspaceId
          ? { ...w, conversations: [...(w.conversations ?? []), coordinator] }
          : w,
      ),
    }));
    await get().saveProjects();
    await get().saveWorkspaces();
    get().selectConversation(coordinatorId);
    return coordinator;
  },

  async newWorkspaceDocsAgent(args) {
    const state = get();
    const preferred = defaultBackend(state.settings);
    const ws = state.workspaces.find((w) => w.id === args.workspaceId);
    if (!ws) return null;
    const name = args.name.trim();
    const topic = args.topic.trim();
    if (!name || !topic) return null;
    const coordinatorId = uuid();
    const projectNames = ws.projectIds
      .map((pid) => state.projects.find((p) => p.id === pid)?.name)
      .filter((n): n is string => !!n);
    const coordinator: Conversation = {
      id: coordinatorId,
      name: `docs · ${name}`,
      createdAt: Date.now(),
      totalCostUSD: 0,
      turnCount: 0,
      currentModel: '',
      permissionMode: state.settings.defaultPermissionMode,
      primaryBackend: preferred,
      reviewAgent: true,
      reviewAgentKind: 'docs',
    };
    set((s) => ({
      workspaces: s.workspaces.map((w) =>
        w.id === args.workspaceId
          ? { ...w, conversations: [...(w.conversations ?? []), coordinator] }
          : w,
      ),
    }));
    await get().saveWorkspaces();
    get().selectConversation(coordinatorId);
    void get().send(coordinatorId, buildWorkspaceDocsPrompt({ topic, projectNames }));
    return coordinator;
  },

  async cancelColosseum(id) {
    const colosseum = get().colosseums.find((c) => c.id === id);
    if (!colosseum) return;
    for (const contenderId of colosseum.contenderIds) {
      await get().stop(contenderId);
    }
    set((s) => ({
      colosseums: s.colosseums.map((c) =>
        c.id === id ? { ...c, status: 'cancelled' } : c,
      ),
    }));
    await get().saveColosseums();
  },

  async resolveColosseum(id, winnerId) {
    set((s) => ({
      colosseums: s.colosseums.map((c) =>
        c.id === id ? { ...c, winnerId, status: 'merged' } : c,
      ),
    }));
    await get().saveColosseums();
  },

  async removeColosseum(id) {
    const colosseum = get().colosseums.find((c) => c.id === id);
    if (!colosseum) return;
    for (const contenderId of colosseum.contenderIds) {
      await get().removeAgent(contenderId);
    }
    set((s) => ({
      colosseums: s.colosseums.filter((c) => c.id !== id),
    }));
    await get().saveColosseums();
  },

  async removeConversation(id) {
    // Snapshot before we drop the row so we can clean up sidecar state
    // that lives outside overcli.json (currently just Ollama transcripts).
    const conv = findConversation(get(), id);
    set((s) => ({
      projects: s.projects.map((p) => ({
        ...p,
        conversations: p.conversations.filter((c) => c.id !== id),
      })),
      workspaces: s.workspaces.map((w) => ({
        ...w,
        conversations: (w.conversations ?? []).filter((c) => c.id !== id),
      })),
      selectedConversationId:
        s.selectedConversationId === id ? null : s.selectedConversationId,
    }));
    await get().saveProjects();
    await get().saveWorkspaces();
    if (conv?.primaryBackend === 'ollama' && conv.sessionId) {
      await window.overcli.invoke('ollama:deleteSession', conv.sessionId);
    }
  },

  async removeAgent(id) {
    const state = get();
    // Resolve the agent conversation and any workspace-member children.
    let conv: Conversation | null = null;
    let ownerProjectPath: string | null = null;
    for (const p of state.projects) {
      const match = p.conversations.find((c) => c.id === id);
      if (match) {
        conv = match;
        ownerProjectPath = p.path;
        break;
      }
    }
    if (!conv) {
      for (const w of state.workspaces) {
        const match = (w.conversations ?? []).find((c) => c.id === id);
        if (match) {
          conv = match;
          break;
        }
      }
    }
    if (!conv) return { ok: false, error: 'conversation not found' };

    const errors: string[] = [];
    // Workspace-agent coordinator: remove every member's worktree, then
    // the coordinator's own symlink root. The coordinator itself has no
    // worktree, just a bookkeeping row + the synthetic root.
    if (conv.workspaceAgentMemberIds && conv.workspaceAgentMemberIds.length > 0) {
      for (const memberId of conv.workspaceAgentMemberIds) {
        for (const p of state.projects) {
          const m = p.conversations.find((c) => c.id === memberId);
          if (!m) continue;
          if (m.worktreePath && m.branchName) {
            const res = await window.overcli.invoke('git:removeWorktree', {
              projectPath: p.path,
              worktreePath: m.worktreePath,
              branchName: m.branchName,
            });
            if (!res.ok && res.error) errors.push(`${p.name}: ${res.error}`);
          }
          await get().removeConversation(memberId);
          break;
        }
      }
      await window.overcli.invoke('workspace:removeCoordinatorSymlinkRoot', id);
      await get().removeConversation(id);
      return { ok: errors.length === 0, error: errors.join('; ') || undefined };
    }

    // Single-project agent: git worktree remove + drop the conversation.
    // Review agents live on a detached HEAD with no branch, so we pass
    // an empty branchName and let git skip the branch-delete step.
    if (conv.worktreePath && ownerProjectPath) {
      const res = await window.overcli.invoke('git:removeWorktree', {
        projectPath: ownerProjectPath,
        worktreePath: conv.worktreePath,
        branchName: conv.branchName ?? '',
      });
      if (!res.ok && res.error) errors.push(res.error);
    }
    await get().removeConversation(id);
    if (conv.colosseumId) {
      set((s) => {
        const next = s.colosseums.flatMap((c) => {
          if (c.id !== conv!.colosseumId) return [c];
          const contenderIds = c.contenderIds.filter((cid) => cid !== id);
          if (contenderIds.length === 0) return [];
          return [
            {
              ...c,
              contenderIds,
              winnerId: c.winnerId === id ? undefined : c.winnerId,
              status:
                c.winnerId === id && c.status !== 'cancelled'
                  ? 'comparing'
                  : c.status,
            },
          ];
        });
        return { colosseums: next };
      });
      await get().saveColosseums();
    }
    return { ok: errors.length === 0, error: errors.join('; ') || undefined };
  },

  async checkoutAgentLocally(id, commitSubject, commitBody) {
    const state = get();
    let conv: Conversation | null = null;
    let ownerProjectPath: string | null = null;
    for (const p of state.projects) {
      const match = p.conversations.find((c) => c.id === id);
      if (match) {
        conv = match;
        ownerProjectPath = p.path;
        break;
      }
    }
    if (!conv || !ownerProjectPath) {
      return { ok: false, error: 'conversation not found' };
    }
    if (!conv.worktreePath || !conv.branchName) {
      return { ok: false, error: 'agent has no worktree to check out' };
    }
    const res = await window.overcli.invoke('git:checkoutAgentLocally', {
      projectPath: ownerProjectPath,
      worktreePath: conv.worktreePath,
      branchName: conv.branchName,
      commitSubject,
      commitBody,
      sessionId: conv.sessionId,
    });
    if (!res.ok) return res;
    // Transfer: strip agent-specific fields so the conversation shows up
    // as a normal project conversation. History and session are preserved
    // so the user can keep chatting about the work they just promoted.
    mutateConversation(set, get, id, (c) => {
      const { worktreePath: _wt, branchName: _bn, baseBranch: _bb, orphaned: _or, ...rest } = c;
      return rest;
    });
    await saveConversationState(get);
    return res;
  },

  async promoteReviewAgent(id) {
    const state = get();
    let conv: Conversation | null = null;
    let ownerProjectPath: string | null = null;
    for (const p of state.projects) {
      const match = p.conversations.find((c) => c.id === id);
      if (match) {
        conv = match;
        ownerProjectPath = p.path;
        break;
      }
    }
    if (!conv || !ownerProjectPath) return { ok: false, error: 'conversation not found' };
    if (!conv.worktreePath || !conv.reviewAgent) {
      return { ok: false, error: 'not a review agent' };
    }
    const agentName = conv.name
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'review';
    const res = await window.overcli.invoke('git:promoteReviewWorktree', {
      projectPath: ownerProjectPath,
      worktreePath: conv.worktreePath,
      agentName,
      branchPrefix: state.settings.agentBranchPrefix,
    });
    if (!res.ok) return res;
    mutateConversation(set, get, id, (c) => ({
      ...c,
      branchName: res.branchName,
      baseBranch: c.reviewTargetBranch ?? c.baseBranch,
      reviewAgent: false,
      reviewTargetBranch: undefined,
    }));
    await saveConversationState(get);
    return { ok: true };
  },

  async checkoutReviewBranchLocally(id) {
    const state = get();
    let conv: Conversation | null = null;
    let ownerProjectPath: string | null = null;
    for (const p of state.projects) {
      const match = p.conversations.find((c) => c.id === id);
      if (match) {
        conv = match;
        ownerProjectPath = p.path;
        break;
      }
    }
    if (!conv || !ownerProjectPath) return { ok: false, error: 'conversation not found' };
    if (!conv.worktreePath || !conv.reviewTargetBranch) {
      return { ok: false, error: 'not a review agent' };
    }
    const res = await window.overcli.invoke('git:switchProjectToBranch', {
      projectPath: ownerProjectPath,
      worktreePath: conv.worktreePath,
      targetBranch: conv.reviewTargetBranch,
    });
    if (!res.ok) return res;
    mutateConversation(set, get, id, (c) => {
      const {
        worktreePath: _wt,
        branchName: _bn,
        baseBranch: _bb,
        reviewAgent: _ra,
        reviewTargetBranch: _rt,
        orphaned: _or,
        ...rest
      } = c;
      return rest;
    });
    await saveConversationState(get);
    return res;
  },

  async setConversationHidden(id, hidden) {
    mutateConversation(set, get, id, (c) => ({ ...c, hidden }));
    await saveConversationState(get);
  },

  async archiveInactiveInProject(projectId) {
    const state = get();
    const project = state.projects.find((p) => p.id === projectId);
    if (!project) return 0;
    const selectedId = state.selectedConversationId;
    const ids = project.conversations
      .filter(
        (c) =>
          !c.hidden &&
          c.id !== selectedId &&
          !(state.runners[c.id]?.isRunning ?? false),
      )
      .map((c) => c.id);
    if (!ids.length) return 0;
    const idSet = new Set(ids);
    set((s) => ({
      projects: s.projects.map((p) =>
        p.id === projectId
          ? {
              ...p,
              conversations: p.conversations.map((c) =>
                idSet.has(c.id) ? { ...c, hidden: true } : c,
              ),
            }
          : p,
      ),
    }));
    await get().saveProjects();
    return ids.length;
  },

  async archiveInactiveInWorkspace(workspaceId) {
    const state = get();
    const workspace = state.workspaces.find((w) => w.id === workspaceId);
    if (!workspace) return 0;
    const selectedId = state.selectedConversationId;
    const ids = (workspace.conversations ?? [])
      .filter(
        (c) =>
          !c.hidden &&
          c.id !== selectedId &&
          !(state.runners[c.id]?.isRunning ?? false),
      )
      .map((c) => c.id);
    if (!ids.length) return 0;
    const idSet = new Set(ids);
    set((s) => ({
      workspaces: s.workspaces.map((w) =>
        w.id === workspaceId
          ? {
              ...w,
              conversations: (w.conversations ?? []).map((c) =>
                idSet.has(c.id) ? { ...c, hidden: true } : c,
              ),
            }
          : w,
      ),
    }));
    await get().saveWorkspaces();
    return ids.length;
  },

  async setPrimaryBackend(id, backend) {
    mutateConversation(set, get, id, (c) => ({ ...c, primaryBackend: backend }));
    await saveConversationState(get);
    // Auto-pick an Ollama model on first switch if none is set, so the
    // user doesn't hit "model required" on the first send.
    if (backend === 'ollama') {
      const s = get();
      const conv = findConversation(s, id);
      if (conv && !conv.ollamaModel) {
        const pick = await pickInstalledOllamaModel(s.settings);
        if (pick) {
          mutateConversation(set, get, id, (c) => ({
            ...c,
            ollamaModel: pick,
            currentModel: pick,
          }));
          await saveConversationState(get);
        }
      }
    }
  },
  async setPermissionMode(id, mode) {
    const prev = (() => {
      const s = get();
      const c = findConversation(s, id);
      return {
        mode: c?.permissionMode ?? 'default',
        pending: c?.pendingPermissionMode,
      };
    })();
    mutateConversation(set, get, id, (c) => {
      if (prev.mode === mode) {
        if (!prev.pending) return c;
        return { ...c, pendingPermissionMode: undefined };
      }
      return { ...c, pendingPermissionMode: mode };
    });
    await saveConversationState(get);
  },
  async setBackendModel(id, backend, model) {
    mutateConversation(set, get, id, (c) => {
      const next = { ...c, currentModel: model };
      if (backend === 'claude') next.claudeModel = model;
      if (backend === 'codex') next.codexModel = model;
      if (backend === 'gemini') next.geminiModel = model;
      if (backend === 'ollama') next.ollamaModel = model;
      return next;
    });
    await saveConversationState(get);
  },
  async setEffortLevel(id, effort) {
    mutateConversation(set, get, id, (c) => ({ ...c, effortLevel: effort }));
    await saveConversationState(get);
  },
  async setReviewBackend(id, backend) {
    mutateConversation(set, get, id, (c) => ({ ...c, reviewBackend: backend }));
    await saveConversationState(get);
  },
  async setReviewMode(id, mode) {
    mutateConversation(set, get, id, (c) => ({
      ...c,
      reviewMode: mode,
      // Seed a sensible default when switching to collab for the first
      // time. Deeper loops rarely help and burn tokens.
      collabMaxTurns: mode === 'collab' && (c.collabMaxTurns == null) ? 3 : c.collabMaxTurns,
    }));
    await saveConversationState(get);
  },
  async setReviewOllamaModel(id, model) {
    mutateConversation(set, get, id, (c) => ({ ...c, reviewOllamaModel: model }));
    await saveConversationState(get);
  },
  async renameConversation(id, name) {
    mutateConversation(set, get, id, (c) => ({ ...c, name }));
    await saveConversationState(get);
  },

  async send(conversationId, prompt) {
    const state = get();
    const conv = findConversation(state, conversationId);
    if (!conv) return;
    const cwd = findContainerPath(state, conversationId);
    if (!cwd) return;
    // Un-archive a hidden conversation — the act of typing is the user
    // bringing it back into focus.
    if (conv.hidden) await state.setConversationHidden(conv.id, false);

    // Snapshot attachments before clearing so they survive the wire call
    // even though we're racing to empty the draft state optimistically.
    const attachments = state.conversationAttachments[conversationId] ?? [];

    // Clear the draft + attachments immediately so the input box resets.
    set((s) => {
      const nextAtts = { ...s.conversationAttachments };
      delete nextAtts[conversationId];
      return {
        conversationDrafts: { ...s.conversationDrafts, [conversationId]: '' },
        conversationAttachments: nextAtts,
      };
    });

    const backend = conv.primaryBackend ?? defaultBackend(state.settings);
    if (!isBackendEnabled(state.settings, backend)) {
      set((s) => ({
        runners: {
          ...s.runners,
          [conversationId]: {
            ...(s.runners[conversationId] ?? newRunnerState()),
            errorMessage: `${backend} is disabled in Settings > Backends.`,
          },
        },
      }));
      return;
    }
    const effectivePermissionMode = conv.pendingPermissionMode ?? conv.permissionMode ?? 'default';

    let model =
      backend === 'codex'
        ? conv.codexModel ?? conv.currentModel
        : backend === 'gemini'
        ? conv.geminiModel ?? conv.currentModel
        : backend === 'ollama'
        ? conv.ollamaModel ?? conv.currentModel
        : conv.claudeModel ?? conv.currentModel;

    // Ollama has no account-level "default model" — the user must name a
    // pulled tag explicitly. If the conversation still has none (common
    // on a fresh convo where Ollama is the default backend), resolve one
    // from the local pull list now so we don't ship the request with an
    // empty model and rely on a hardcoded fallback.
    if (backend === 'ollama' && !model) {
      const pick = await pickInstalledOllamaModel(state.settings);
      if (!pick) {
        set((s) => ({
          runners: {
            ...s.runners,
            [conversationId]: {
              ...(s.runners[conversationId] ?? newRunnerState()),
              errorMessage:
                'No Ollama models pulled yet. Open Settings → Local models to pull one.',
            },
          },
        }));
        return;
      }
      model = pick;
      mutateConversation(set, get, conversationId, (c) => ({
        ...c,
        ollamaModel: pick,
        currentModel: pick,
      }));
    }

    if (conv.pendingPermissionMode) {
      mutateConversation(set, get, conversationId, (c) => ({
        ...c,
        permissionMode: c.pendingPermissionMode ?? c.permissionMode,
        pendingPermissionMode: undefined,
      }));
    }

    await window.overcli.invoke('runner:send', {
      conversationId,
      prompt,
      backend,
      cwd,
      model: model ?? '',
      permissionMode: effectivePermissionMode,
      sessionId: conv.sessionId,
      effortLevel: conv.effortLevel,
      codexRolloutPaths: conv.codexRolloutPaths,
      attachments: attachments.length ? attachments : undefined,
      reviewBackend: conv.reviewBackend ?? null,
      reviewMode: conv.reviewMode ?? null,
      collabMaxTurns: conv.collabMaxTurns ?? null,
      reviewOllamaModel: conv.reviewOllamaModel ?? null,
      allowedDirs: backend === 'claude' ? computeAllowedDirs(get(), conversationId) : undefined,
    });

    mutateConversation(set, get, conversationId, (c) => ({
      ...c,
      lastActiveAt: Date.now(),
      turnCount: c.turnCount + 1,
      name:
        c.name === 'New conversation' && prompt.trim().length > 0
          ? prompt.trim().slice(0, 48)
          : c.name,
    }));
    await saveConversationState(get);
  },

  async stop(conversationId) {
    await window.overcli.invoke('runner:stop', { conversationId });
  },

  async resetConversation(conversationId) {
    await window.overcli.invoke('runner:newConversation', { conversationId });
    set((s) => ({
      runners: { ...s.runners, [conversationId]: newRunnerState() },
    }));
    mutateConversation(set, get, conversationId, (c) => ({
      ...c,
      sessionId: undefined,
      turnCount: 0,
      totalCostUSD: 0,
      codexRolloutPath: undefined,
      codexRolloutPaths: undefined,
    }));
    await saveConversationState(get);
  },

  async respondPermission(conversationId, requestId, approved, addDir) {
    await window.overcli.invoke('runner:respondPermission', {
      conversationId,
      requestId,
      approved,
      addDir,
    });
    if (approved && addDir) {
      mutateConversation(set, get, conversationId, (c) => {
        const existing = c.allowedDirs ?? [];
        if (existing.includes(addDir)) return c;
        return { ...c, allowedDirs: [...existing, addDir] };
      });
      await saveConversationState(get);
    }
    set((s) => {
      const runner = s.runners[conversationId];
      if (!runner) return s;
      const events = runner.events.map((e) => {
        if (e.kind.type === 'permissionRequest' && e.kind.info.requestId === requestId) {
          return {
            ...e,
            revision: e.revision + 1,
            kind: {
              ...e.kind,
              info: { ...e.kind.info, decided: approved ? 'allow' : 'deny' as const },
            } as typeof e.kind,
          };
        }
        return e;
      });
      return { runners: { ...s.runners, [conversationId]: { ...runner, events } } };
    });
  },

  async respondCodexApproval(conversationId, callId, kind, approved) {
    await window.overcli.invoke('runner:respondCodexApproval', {
      conversationId,
      callId,
      kind,
      approved,
    });
    set((s) => {
      const runner = s.runners[conversationId];
      if (!runner) return s;
      const events = runner.events.map((e) => {
        if (e.kind.type === 'codexApproval' && e.kind.info.callId === callId) {
          return {
            ...e,
            revision: e.revision + 1,
            kind: {
              ...e.kind,
              info: { ...e.kind.info, decided: approved ? 'allow' : 'deny' as const },
            } as typeof e.kind,
          };
        }
        return e;
      });
      return { runners: { ...s.runners, [conversationId]: { ...runner, events } } };
    });
  },

  async loadHistoryIfNeeded(conversationId) {
    const state = get();
    const conv = findConversation(state, conversationId);
    if (!conv) return;
    const existing = state.runners[conversationId];
    if (existing && (existing.historyLoaded || existing.historyLoading)) return;
    const cwd = findContainerPath(state, conversationId);
    if (!cwd) return;
    set((s) => ({
      runners: {
        ...s.runners,
        [conversationId]: {
          ...(s.runners[conversationId] ?? newRunnerState()),
          historyLoading: true,
        },
      },
    }));
    const events = await window.overcli.invoke('runner:loadHistory', {
      conversationId,
      backend: conv.primaryBackend ?? defaultBackend(state.settings),
      projectPath: cwd,
      sessionId: conv.sessionId,
      codexRolloutPaths: conv.codexRolloutPaths,
      conversationCreatedAt: conv.createdAt,
      conversationLastActiveAt: conv.lastActiveAt,
    });
    set((s) => {
      const existingRunner = s.runners[conversationId] ?? newRunnerState();
      // History events are inserted at the front; live events (if any came
      // in during the load) stay at the back, in timestamp order.
      const merged = [...events, ...existingRunner.events]
        .filter((e, i, arr) => arr.findIndex((x) => x.id === e.id) === i)
        .sort((a, b) => a.timestamp - b.timestamp);
      return {
        runners: {
          ...s.runners,
          [conversationId]: {
            ...existingRunner,
            events: merged,
            historyLoading: false,
            historyLoaded: true,
          },
        },
      };
    });
  },

  async refreshBackendHealth() {
    const out: Record<string, BackendHealth> = {};
    await Promise.all(
      ALL_BACKENDS.map(async (backend) => {
        if (!isBackendEnabled(get().settings, backend)) {
          out[backend] = { kind: 'unknown', message: 'Disabled in settings' };
          return;
        }
        out[backend] = await window.overcli.invoke('runner:probeHealth', backend);
      }),
    );
    set({ backendHealth: out });
  },

  async refreshInstalledReviewers() {
    const installed = await window.overcli.invoke('runner:listInstalledReviewers');
    set({ installedReviewers: installed });
  },

  async refreshCapabilities() {
    const report = await window.overcli.invoke('capabilities:scan');
    set({ capabilities: report });
  },

  async refreshGitStatus(conversationId) {
    const s = get();
    let cwd: string | null = null;
    for (const p of s.projects) {
      const c = p.conversations.find((x) => x.id === conversationId);
      if (c) {
        cwd = c.worktreePath ?? p.path;
        break;
      }
    }
    // Either the workspace's member projects (plain workspace conv) or
    // the coordinator's member worktrees (workspace agent). Both are
    // aggregated by `git:workspaceCommitStatus`, which runs commitStatus
    // in each listed path and prefixes the returned paths with `name/`.
    let workspaceProjects: Array<{ name: string; path: string }> | null = null;
    if (!cwd) {
      for (const w of s.workspaces) {
        const c = (w.conversations ?? []).find((x) => x.id === conversationId);
        if (!c) continue;
        if (c.worktreePath) {
          cwd = c.worktreePath;
        } else if (c.workspaceAgentMemberIds?.length) {
          const seen = new Set<string>();
          const usedNames = new Set<string>();
          const out: Array<{ name: string; path: string }> = [];
          for (const memberId of c.workspaceAgentMemberIds) {
            for (const proj of s.projects) {
              const member = proj.conversations.find((x) => x.id === memberId);
              if (!member?.worktreePath || seen.has(member.worktreePath)) continue;
              seen.add(member.worktreePath);
              let name = proj.name;
              let i = 2;
              while (usedNames.has(name)) {
                name = `${proj.name}-${i}`;
                i += 1;
              }
              usedNames.add(name);
              out.push({ name, path: member.worktreePath });
            }
          }
          workspaceProjects = out;
        } else {
          const projs = w.projectIds
            .map((pid) => s.projects.find((p) => p.id === pid))
            .filter((p): p is NonNullable<typeof p> => !!p && !!p.path)
            .map((p) => ({ name: p.name, path: p.path }));
          workspaceProjects = workspaceSymlinkNames(projs);
        }
        break;
      }
    }
    let res;
    if (workspaceProjects) {
      res = await window.overcli.invoke('git:workspaceCommitStatus', {
        projects: workspaceProjects,
      });
    } else if (cwd) {
      res = await window.overcli.invoke('git:commitStatus', { cwd });
    } else {
      return;
    }
    set((state) => ({
      gitStatusByConv: { ...state.gitStatusByConv, [conversationId]: res },
    }));
  },

  ingestMainEvent(event) {
    if (event.type === 'stream') {
      // Pull the most recent system:init info out of this batch BEFORE we
      // commit state — the slash-commands, MCP-servers, and plugins
      // sheets all read `lastInit` and without this they silently stay
      // empty because the init event only arrives on the first turn.
      let initForGlobal: SystemInitInfo | undefined;
      for (const e of event.events) {
        if (e.kind.type === 'systemInit') initForGlobal = e.kind.info;
      }

      set((s) => {
        const runner = s.runners[event.conversationId] ?? newRunnerState();
        const nextEvents = mergeIncomingEvents(runner.events, event.events);
        const pending = new Set(runner.pendingLocalUserIds);
        for (const e of event.events) {
          if (e.kind.type === 'localUser') pending.delete(e.id);
        }
        let currentModel = runner.currentModel;
        for (const e of event.events) {
          if (e.kind.type === 'systemInit' && e.kind.info.model) {
            currentModel = e.kind.info.model;
          }
        }
        return {
          runners: {
            ...s.runners,
            [event.conversationId]: {
              ...runner,
              events: nextEvents,
              pendingLocalUserIds: pending,
              currentModel,
            },
          },
          lastInit: initForGlobal ?? s.lastInit,
        };
      });
    } else if (event.type === 'running') {
      // Ignore the menu-sentinel used for Cmd+N; routed separately.
      if (event.conversationId === '__menu_new_conversation__') return;
      set((s) => {
        const runner = s.runners[event.conversationId] ?? newRunnerState();
        return {
          runners: {
            ...s.runners,
            [event.conversationId]: {
              ...runner,
              isRunning: event.isRunning,
              activityLabel: event.activityLabel,
            },
          },
        };
      });
      const state = get();
      const conv = findConversation(state, event.conversationId);
      const colosseumId = conv?.colosseumId;
      if (colosseumId) {
        const colosseum = state.colosseums.find((c) => c.id === colosseumId);
        if (colosseum && colosseum.status !== 'cancelled' && colosseum.status !== 'merged') {
          const allStopped = colosseum.contenderIds.every(
            (cid) => !(get().runners[cid]?.isRunning ?? false),
          );
          const nextStatus = allStopped ? 'comparing' : 'running';
          if (colosseum.status !== nextStatus) {
            set((s) => ({
              colosseums: s.colosseums.map((c) =>
                c.id === colosseumId ? { ...c, status: nextStatus } : c,
              ),
            }));
            void get().saveColosseums();
          }
        }
      }
    } else if (event.type === 'error') {
      set((s) => {
        const runner = s.runners[event.conversationId] ?? newRunnerState();
        return {
          runners: {
            ...s.runners,
            [event.conversationId]: { ...runner, errorMessage: event.message, isRunning: false },
          },
        };
      });
    } else if (event.type === 'sessionConfigured') {
      const store = get();
      const conv = findConversation(store, event.conversationId);
      if (!conv) return;
      mutateConversation(set, get, event.conversationId, (c) => {
        const next = { ...c, sessionId: event.sessionId };
        if (event.rolloutPath) {
          const existing = c.codexRolloutPaths ?? [];
          // Append to the list (not replace) — codex proto spawns a fresh
          // rollout every subprocess; we want to merge them on history load.
          if (existing[existing.length - 1] !== event.rolloutPath) {
            next.codexRolloutPaths = [...existing, event.rolloutPath];
          }
          next.codexRolloutPath = event.rolloutPath;
        }
        return next;
      });
      void saveConversationState(get);
    } else if (event.type === 'codexRuntimeMode') {
      set((s) => {
        const runner = s.runners[event.conversationId] ?? newRunnerState();
        return {
          runners: {
            ...s.runners,
            [event.conversationId]: {
              ...runner,
              codexRuntimeMode: event.mode,
              codexSandboxMode: event.sandbox,
              codexApprovalPolicy: event.approval,
            },
          },
        };
      });
    } else if (event.type === 'ollamaServerStatus') {
      set({ ollamaServerStatus: event.status });
    }
  },
}));

function buildWorkspaceDocsPrompt(args: { topic: string; projectNames: string[] }): string {
  const repoList = args.projectNames.length
    ? args.projectNames.map((n) => `- \`${n}\``).join('\n')
    : '- (the repos in this workspace)';
  return [
    `You are a documentation agent. The user wants end-user documentation for the following feature/topic:`,
    ``,
    `> ${args.topic.split('\n').join('\n> ')}`,
    ``,
    `Your cwd is a workspace symlink root containing these member repos (each reachable as a top-level directory):`,
    ``,
    repoList,
    ``,
    `This feature likely spans more than one repo. **Do not edit files and do not commit anywhere.** Output everything as markdown in this chat.`,
    ``,
    `Investigate first:`,
    ``,
    `1. Search each repo for code related to the topic — names, routes, types, config keys, migrations, UI components. Cast a wide net, then narrow.`,
    `2. For each piece you find, read enough surrounding code to understand what the user-facing contract is: CLI flags, HTTP endpoints, UI controls, library exports, config shape.`,
    `3. Work out how the pieces connect across repos (who calls whom, shared schemas, published packages consumed by siblings).`,
    `4. If you can't find the feature in any repo, say so plainly and ask the user for a hint (a file path, a function name, a branch) rather than inventing content.`,
    ``,
    `Then produce **end-user documentation for this feature**. Structure:`,
    ``,
    `- **Overview** — what the feature is and why it exists, in plain language (2–4 sentences).`,
    `- **How to use it** — the concrete steps an end user follows, end-to-end. Call out which repo/service each step touches when it matters.`,
    `- **Configuration / options** — every user-facing setting or flag the feature exposes. Name, default, effect, which repo it lives in.`,
    `- **Cross-repo flow** — a brief diagram-in-prose (or fenced sketch) showing how the repos cooperate for this feature.`,
    `- **What changed for existing users** — migration notes, behavior deltas, anything that could surprise someone who knew the old flow.`,
    `- **Limitations & known edge cases** — what it doesn't do, rough edges, follow-ups.`,
    ``,
    `Write for end users of the product, not contributors. Keep it skimmable and well-formatted markdown. Cite file:line for specific behavior.`,
  ].join('\n');
}

/// Persist both the projects and workspaces slices. Every path that
/// calls `mutateConversation` needs this, since the conversation might
/// live inside a workspace — saving only projects drops updates like
/// `sessionId`, `turnCount`, model, and settings for workspace
/// conversations on reload (symptom: empty chat pane after clicking a
/// workspace conversation you'd been working in).
async function saveConversationState(get: () => StoreState): Promise<void> {
  await get().saveProjects();
  await get().saveWorkspaces();
}

function mutateConversation(
  set: (fn: (s: StoreState) => Partial<StoreState>) => void,
  _get: () => StoreState,
  id: UUID,
  mutator: (c: Conversation) => Conversation,
): void {
  set((s) => ({
    projects: s.projects.map((p) => ({
      ...p,
      conversations: p.conversations.map((c) => (c.id === id ? mutator(c) : c)),
    })),
    workspaces: s.workspaces.map((w) => ({
      ...w,
      conversations: (w.conversations ?? []).map((c) => (c.id === id ? mutator(c) : c)),
    })),
  }));
}

/// Incoming stream events either append to the tail OR replace an existing
/// assistant slot whose id matches (the partial-assistant slot gets updated
/// in place during streaming so the tail bubble updates without visible
/// flicker). We identify replacements by matching ids, bump revision.
function mergeIncomingEvents(existing: StreamEvent[], incoming: StreamEvent[]): StreamEvent[] {
  const byId = new Map<string, number>();
  existing.forEach((e, i) => byId.set(e.id, i));
  const out = [...existing];
  for (const e of incoming) {
    const idx = byId.get(e.id);
    if (idx != null) {
      const prev = out[idx];
      out[idx] = { ...e, revision: prev.revision + 1 };
    } else {
      byId.set(e.id, out.length);
      out.push(e);
    }
  }
  return out;
}
