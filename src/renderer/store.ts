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
  | { type: 'fileFinder'; rootPath: string }
  | { type: 'quickSwitcher' };

export type DetailMode = 'conversation' | 'stats' | 'local';

export interface OpenFileHighlight {
  startLine: number;
  endLine: number;
  requestId: string;
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
  cancelColosseum(id: UUID): Promise<void>;
  resolveColosseum(id: UUID, winnerId: UUID): Promise<void>;
  removeColosseum(id: UUID): Promise<void>;
  removeConversation(id: UUID): Promise<void>;
  /// Agent-specific teardown: git worktree remove (including branch),
  /// then remove the conversation entry. For workspace-agent
  /// coordinators, removes every member's worktree too.
  removeAgent(id: UUID): Promise<{ ok: boolean; error?: string }>;
  setConversationHidden(id: UUID, hidden: boolean): Promise<void>;
  archiveInactiveInProject(projectId: UUID): Promise<number>;
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
  respondPermission(conversationId: UUID, requestId: string, approved: boolean): Promise<void>;
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

function findContainerPath(state: StoreState, convId: UUID): string | null {
  for (const p of state.projects) {
    const c = p.conversations.find((x) => x.id === convId);
    if (c) return c.worktreePath ?? p.path;
  }
  for (const w of state.workspaces) {
    const c = w.conversations?.find((x) => x.id === convId);
    if (c) return c.worktreePath ?? w.rootPath;
  }
  return null;
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
  showToolActivity: true,
  pendingFinderQuery: '',
  conversationDrafts: {},
  conversationAttachments: {},
  backendHealth: {},
  installedReviewers: {},
  capabilities: null,
  ollamaServerStatus: 'unknown',
  runners: {},

  async init() {
    const state = await window.overcli.invoke('store:load');
    // Reconcile every workspace's symlink root: backfills `rootPath` for
    // workspaces saved before this existed, and refreshes the symlink set
    // when a member project has been added/removed/renamed since launch.
    let workspacesChanged = false;
    const workspaces: Workspace[] = [];
    for (const ws of state.workspaces) {
      const rootPath = await ensureWorkspaceRoot(state.projects, ws.id, ws.projectIds);
      if (rootPath && rootPath !== ws.rootPath) {
        workspaces.push({ ...ws, rootPath });
        workspacesChanged = true;
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
    set((s) => ({ projects: s.projects.filter((p) => p.id !== id) }));
    await get().saveProjects();
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
    // Workspace-agent coordinator: remove every member's worktree. The
    // coordinator itself has no worktree, just a bookkeeping row.
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
      await get().removeConversation(id);
      return { ok: errors.length === 0, error: errors.join('; ') || undefined };
    }

    // Single-project agent: git worktree remove + drop the conversation.
    if (conv.worktreePath && conv.branchName && ownerProjectPath) {
      const res = await window.overcli.invoke('git:removeWorktree', {
        projectPath: ownerProjectPath,
        worktreePath: conv.worktreePath,
        branchName: conv.branchName,
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

  async setPrimaryBackend(id, backend) {
    mutateConversation(set, get, id, (c) => ({ ...c, primaryBackend: backend }));
    await saveConversationState(get);
    // Auto-pick an Ollama model on first switch if none is set, so the
    // user doesn't hit "model required" on the first send. Prefer the
    // user's configured default, else the first pulled tag.
    if (backend === 'ollama') {
      const s = get();
      const conv = findConversation(s, id);
      if (conv && !conv.ollamaModel) {
        try {
          const det = await window.overcli.invoke('ollama:detect');
          const names = det.models.map((m) => m.name);
          const configured = s.settings.backendDefaultModels.ollama;
          const pick =
            configured && names.includes(configured) ? configured : names[0];
          if (pick) {
            mutateConversation(set, get, id, (c) => ({
              ...c,
              ollamaModel: pick,
              currentModel: pick,
            }));
            await saveConversationState(get);
          }
        } catch {
          // Detection failed — user can still set the model manually.
        }
      }
    }
  },
  async setPermissionMode(id, mode) {
    const prevMode = (() => {
      const s = get();
      const c = findConversation(s, id);
      return c?.permissionMode ?? 'default';
    })();
    mutateConversation(set, get, id, (c) => ({ ...c, permissionMode: mode }));
    await saveConversationState(get);

    // claude's --permission-mode is a spawn-time flag; changing it
    // mid-session without respawning leaves the running CLI in the old
    // mode. Tell the runner to tear down its subprocess so the next
    // `send` spawns fresh with the new flag. The CLI's --resume logic
    // in send() restores the conversation transcript on that respawn
    // so the user doesn't lose context.
    if (prevMode !== mode) {
      await window.overcli.invoke('runner:newConversation', { conversationId: id });
    }

    // If the user flipped to a permissive mode while a permission card
    // is waiting for an answer, treat the flip as implicit approval —
    // otherwise claude stays blocked because the card's Allow button
    // was never clicked.
    if (mode === 'acceptEdits' || mode === 'bypassPermissions') {
      const runner = get().runners[id];
      if (runner) {
        for (const e of runner.events) {
          if (e.kind.type === 'permissionRequest' && !e.kind.info.decided) {
            void get().respondPermission(id, e.kind.info.requestId, true);
          } else if (e.kind.type === 'codexApproval' && !e.kind.info.decided) {
            void get().respondCodexApproval(
              id,
              e.kind.info.callId,
              e.kind.info.kind,
              true,
            );
          }
        }
      }
    }
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
    const model =
      backend === 'codex'
        ? conv.codexModel ?? conv.currentModel
        : backend === 'gemini'
        ? conv.geminiModel ?? conv.currentModel
        : backend === 'ollama'
        ? conv.ollamaModel ?? conv.currentModel
        : conv.claudeModel ?? conv.currentModel;

    await window.overcli.invoke('runner:send', {
      conversationId,
      prompt,
      backend,
      cwd,
      model: model ?? '',
      permissionMode: conv.permissionMode ?? 'default',
      sessionId: conv.sessionId,
      effortLevel: conv.effortLevel,
      codexRolloutPaths: conv.codexRolloutPaths,
      attachments: attachments.length ? attachments : undefined,
      reviewBackend: conv.reviewBackend ?? null,
      reviewMode: conv.reviewMode ?? null,
      collabMaxTurns: conv.collabMaxTurns ?? null,
      reviewOllamaModel: conv.reviewOllamaModel ?? null,
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

  async respondPermission(conversationId, requestId, approved) {
    await window.overcli.invoke('runner:respondPermission', {
      conversationId,
      requestId,
      approved,
    });
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
