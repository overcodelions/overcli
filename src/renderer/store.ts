// Central renderer store. Holds everything the UI binds to: projects,
// workspaces, conversations, per-conversation runner state (events,
// isRunning, activity), settings, sheet state, file editor state.
//
// Uses Zustand for minimal ceremony. Every UI action is a method on this
// store; components subscribe to the slices they care about via selectors.
//
// Slice plan: pure-UI fields (sheets, file editor, sidebar, tool-activity
// toggle) live in `uiSlice.ts` and are spread in below. Future slices to
// extract: runners (events/isRunning/currentModel — the hot path), data
// (projects/workspaces/conversations + persistence), settings.

import { create } from 'zustand';
import {
  AppSettings,
  Attachment,
  BackendHealth,
  CapabilitiesReport,
  Colosseum,
  Conversation,
  DEFAULT_SETTINGS,
  MarketplaceSkill,
  Project,
  SkillTarget,
  StreamEvent,
  SystemInitInfo,
  UUID,
  Workspace,
  Backend,
  PermissionMode,
  EffortLevel,
  PersonaKey,
  ReviewPreset,
  MainToRendererEvent,
} from '@shared/types';
import { TIERS, modelTier, resolvePreset } from '@shared/reboundPresets';
import { FileViewMode } from './filePreview';
import { workspaceSymlinkNames, pathBasename } from '@shared/workspaceNames';
import {
  findConversation as findConversationFromIndex,
  findContainerPath as findContainerPathFromIndex,
  findConvWithProjectPath,
  findOwnerProject,
  isActiveConversation,
} from './conversationLookup';
import { createUiSlice, uiSliceInitialState } from './uiSlice';
import { useRunnersStore, getRunner, getAllRunners } from './runnersStore';
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
  | { type: 'projectDiff'; convId: UUID }
  | { type: 'workspaceDiff'; convId: UUID }
  | { type: 'workspaceAgentReview'; coordinatorId: UUID }
  | { type: 'archiveConversation'; convId: UUID }
  | { type: 'archiveAllInProject'; projectId: UUID }
  | { type: 'archiveAllInWorkspace'; workspaceId: UUID }
  | { type: 'bulkConversationActions' }
  | { type: 'fileFinder'; rootPath: string }
  | { type: 'quickSwitcher' }
  | { type: 'shortcutsHelp' };

export type DetailMode = 'conversation' | 'stats' | 'local' | 'explorer';

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

// RunnerState + newRunnerState live in ./runnersStore.ts. Re-exported
// here for now so existing imports (`import { RunnerState } from '../store'`)
// keep working during the migration.
export type { RunnerState } from './runnersStore';

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
  /// Root directory for the standalone file explorer view. Set by
  /// `openExplorer`; consumed by ExplorerPane when detailMode is
  /// 'explorer'. Unlike conversation-scoped file browsing, this is
  /// independent of any runner/worktree.
  explorerRootPath: string | null;
  showHiddenConversations: boolean;
  sidebarVisible: boolean;
  /// Global toggle: show tool-use / tool-result cards in chat. Off
  /// collapses the chat to just the model's assistant text for a cleaner
  /// reading view. Seeded from `settings.defaultShowToolActivity` at
  /// launch; the in-session flip is intentionally transient so users can
  /// toggle it per task without editing Settings.
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
  marketplaceSkills: MarketplaceSkill[] | null;
  /// Live Ollama server status. Pushed from main via the
  /// `ollamaServerStatus` event. Used to warn users in-chat when they're
  /// talking to an Ollama-backed conversation and the server is down.
  ollamaServerStatus: 'stopped' | 'starting' | 'running' | 'error' | 'unknown';
  /// Monotonic counter bumped every time the user expresses intent to
  /// start a new conversation (sidebar "+", Cmd+N, etc.). The
  /// WelcomePane subscribes to this so the composer textarea grabs focus
  /// even when the pane was already mounted (e.g., user clicks "+" while
  /// already on welcome) — the initial autoFocus on mount can't catch
  /// that case on its own.
  welcomeFocusToken: number;

  // Runtime
  // (per-conversation runner state has moved to ./runnersStore.ts —
  //  components subscribe via useRunner / useRunnerEvents / etc.)
  /// Session-scoped "most recently selected" timestamps, used by the
  /// command palette to sort its default (empty-query) ordering.
  /// Transient; resets on app restart.
  lastSelectedAt: Record<UUID, number>;
  /// Cached git working-tree status per conversation. Populated on
  /// demand via `refreshGitStatus`. Both the header CommitButton and
  /// the ChangesBar above the composer read from this so they show
  /// the same numbers — the earlier, event-derived count in ChangesBar
  /// could drift from real git state during edit-then-revert loops.
  gitStatusByConv: Record<UUID, GitStatus>;
  /// Whether a project's root path is a git working tree. Probed on
  /// init and whenever a project is added. Agents require a worktree,
  /// so the sidebar hides the "+ agent" affordance when this is false.
  /// Undefined means "not yet probed" — treat as unknown, not false.
  projectIsGitRepo: Record<UUID, boolean>;

  // Actions
  init(): Promise<void>;
  selectConversation(id: UUID | null): void;
  startNewConversation(projectId: UUID): void;
  startNewConversationInWorkspace(workspaceId: UUID): void;
  setDetailMode(mode: DetailMode): void;
  openExplorer(rootPath: string): void;
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
  newWorkspace(name: string, projectIds: UUID[], instructions?: string): Promise<Workspace | null>;
  updateWorkspaceProjects(workspaceId: UUID, projectIds: UUID[]): Promise<boolean>;
  updateWorkspaceInstructions(workspaceId: UUID, instructions: string): Promise<boolean>;
  newWorkspaceAgent(args: {
    workspaceId: UUID;
    name: string;
    /// Per-member base branches, keyed by project id. Each member project
    /// in the workspace branches off its own resolved base, so a repo on
    /// `main` and one on `master` can coexist in the same workspace agent.
    baseBranches: Record<UUID, string>;
    /// Optional progress reporter — worktree creation across many member
    /// repos can take seconds per repo, so the sheet shows a live status.
    onProgress?: (message: string) => void;
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
  /// Workspace-coordinator variant of checkoutAgentLocally: demote every
  /// live member in one shot so the coordinator's members don't end up in
  /// a mixed (partly-demoted, partly-agent) state. Collects per-member
  /// errors but continues so a single failing project doesn't block the
  /// rest. Marks the coordinator itself `checkedOutLocally` when all
  /// members land successfully.
  checkoutWorkspaceLocally(
    coordinatorId: UUID,
    commitSubject: string,
    commitBody?: string,
  ): Promise<{
    ok: boolean;
    results: Array<{ memberId: UUID; projectName: string; ok: boolean; message?: string; error?: string }>;
  }>;
  /// After a coordinator has been `checkedOutLocally`, rebind its
  /// symlink root to point at each project's main repo and mark it
  /// `continuedLocally`. Next message on the coordinator resumes the
  /// prior session (via --resume on the CLI) so the chat context
  /// carries over, while file tools now operate against the real
  /// project repos that have the agent branches checked out.
  continueWorkspaceLocally(
    coordinatorId: UUID,
  ): Promise<{ ok: true } | { ok: false; error: string }>;
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
  setReviewModel(id: UUID, model: string | null): Promise<void>;
  setReviewPersona(id: UUID, persona: PersonaKey | null): Promise<void>;
  /// Apply a curated rebound preset. Resolves the preset against the
  /// conversation's current primary backend and writes all the
  /// underlying review* fields in one shot. Pass 'off' to clear the
  /// reviewer entirely; pass 'custom' to mark that the user is editing
  /// the underlying fields directly without a preset.
  setReviewPreset(id: UUID, preset: ReviewPreset | 'off'): Promise<void>;
  setCollabMaxTurns(id: UUID, turns: number): Promise<void>;
  setReviewOllamaModel(id: UUID, model: string | null): Promise<void>;
  setReviewYolo(id: UUID, yolo: boolean): Promise<void>;
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
    scope?: 'once' | 'always',
    toolName?: string,
  ): Promise<void>;
  respondCodexApproval(
    conversationId: UUID,
    callId: string,
    kind: 'exec' | 'patch',
    approved: boolean,
  ): Promise<void>;
  respondUserInput(
    conversationId: UUID,
    requestId: string,
    answers: Record<string, { answers: string[] }>,
  ): Promise<void>;
  loadHistoryIfNeeded(conversationId: UUID): Promise<void>;

  // Health
  refreshBackendHealth(): Promise<void>;
  refreshInstalledReviewers(): Promise<void>;
  refreshCapabilities(): Promise<void>;
  refreshMarketplaceSkills(): Promise<void>;
  installMarketplaceSkill(skillId: string, targets: SkillTarget[]): Promise<{ ok: true } | { ok: false; error: string }>;
  uninstallMarketplaceSkill(skillId: string, targets: SkillTarget[]): Promise<{ ok: true } | { ok: false; error: string }>;
  removeInstalledSkill(skillPath: string): Promise<{ ok: true } | { ok: false; error: string }>;
  copyMcpToCli(name: string, fromCli: Backend, toCli: Backend): Promise<{ ok: true } | { ok: false; error: string }>;
  refreshGitStatus(conversationId: UUID): Promise<void>;
  refreshProjectGitStatus(projectId: UUID): Promise<void>;

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

// newRunnerState is imported from ./runnersStore — kept as a single
// source of truth for the initial shape.

/// How long the green completion checkmark stays visible after the user
/// is on the conversation when it finishes (or selects it once finished).
/// Long enough to register, short enough to feel like a flash.
const COMPLETION_FLASH_MS = 3000;

/// Clear the completion marker after a brief flash, but only if the
/// conversation hasn't completed *again* in the meantime — comparing
/// the captured timestamp avoids racing a fresh completion that landed
/// during the timeout.
function scheduleClearCompletion(conversationId: UUID, completedAt: number): void {
  setTimeout(() => {
    const runner = getRunner(conversationId);
    if (runner?.completedAt === completedAt) {
      useRunnersStore.getState().patchRunner(conversationId, { completedAt: null });
    }
  }, COMPLETION_FLASH_MS);
}

function findConversation(state: StoreState, id: UUID): Conversation | null {
  return findConversationFromIndex(state, id);
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
  // The Ollama server can bind :11434 a beat before `/api/tags` lists the
  // on-disk models, so a send right after a "start server" prompt may race
  // an empty list. One short retry covers that without blocking any other
  // failure mode (no models pulled, server truly down) for long.
  const detectOnce = async (): Promise<string[]> => {
    try {
      const det = await window.overcli.invoke('ollama:detect');
      return det.models.map((m) => m.name);
    } catch {
      return [];
    }
  };
  let names = await detectOnce();
  if (names.length === 0) {
    await new Promise((r) => setTimeout(r, 800));
    names = await detectOnce();
  }
  if (names.length === 0) return null;
  const configured = settings.backendDefaultModels.ollama;
  if (configured && names.includes(configured)) return configured;
  return names[0];
}

async function ensureWorkspaceRoot(
  projects: Project[],
  workspaceId: UUID,
  projectIds: UUID[],
  instructions?: string,
): Promise<string | null> {
  const refs = projectIds
    .map((pid) => projects.find((p) => p.id === pid))
    .filter((p): p is Project => !!p)
    .map((p) => ({ name: p.name, path: p.path }));
  if (refs.length === 0) return null;
  const res = await window.overcli.invoke('workspace:ensureSymlinkRoot', {
    workspaceId,
    projects: refs,
    instructions,
  });
  if (!res.ok) {
    console.warn(`Failed to create workspace root: ${res.error}`);
    return null;
  }
  return res.rootPath;
}

/// Format the in-band notice prepended to the next user prompt when a
/// workspace's project list changes mid-conversation. Shape mirrors the
/// CLAUDE.md / AGENTS.md guidance so the agent treats it as authoritative
/// context, not as a user instruction to act on.
function buildWorkspaceUpdateNotice(
  rootPath: string,
  added: Array<{ name: string; path: string }>,
  removed: Array<{ name: string; path: string }>,
): string {
  const lines: string[] = ['[Workspace context update]'];
  if (added.length) {
    lines.push('Added member projects:');
    for (const p of added) lines.push(`- ${p.name} → ${p.path}`);
  }
  if (removed.length) {
    if (added.length) lines.push('');
    lines.push('Removed member projects:');
    for (const p of removed) lines.push(`- ${p.name}`);
  }
  lines.push('');
  lines.push(
    `The workspace CLAUDE.md / AGENTS.md / GEMINI.md at ${rootPath} have been refreshed with the current member list. Treat the change above as the authoritative diff, since the live session was already running when the rewrite happened.`,
  );
  return lines.join('\n');
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
  return findContainerPathFromIndex(state, convId);
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
      if (c.worktreePath) {
        dirs.push(c.worktreePath);
        // Include the sibling-worktrees container (~/.overcli/worktrees/<slug>)
        // so subagents inspecting adjacent branches' worktrees don't trip
        // the add-dir gate on a path the user would obviously expect to
        // be in scope.
        const parent = parentDir(c.worktreePath);
        if (parent) dirs.push(parent);
      }
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
      if (c.worktreePath) {
        dirs.push(c.worktreePath);
        const parent = parentDir(c.worktreePath);
        if (parent) dirs.push(parent);
      }
      for (const d of c.allowedDirs ?? []) dirs.push(d);
      return dirs;
    }
  }
  return dirs;
}

function parentDir(p: string): string | null {
  const idx = p.lastIndexOf('/');
  if (idx <= 0) return null;
  return p.slice(0, idx);
}

function isBackendEnabled(settings: AppSettings, backend: Backend): boolean {
  return settings.disabledBackends?.[backend] !== true;
}

function enabledBackends(settings: AppSettings): Backend[] {
  return ALL_BACKENDS.filter((b) => isBackendEnabled(settings, b));
}

function defaultBackend(settings: AppSettings): Backend {
  const preferred = settings.preferredBackend;
  if (preferred && isBackendEnabled(settings, preferred)) return preferred;
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
  ...uiSliceInitialState,
  showHiddenConversations: false,
  pendingFinderQuery: '',
  conversationDrafts: {},
  conversationAttachments: {},
  backendHealth: {},
  installedReviewers: {},
  capabilities: null,
  marketplaceSkills: null,
  ollamaServerStatus: 'unknown',
  welcomeFocusToken: 0,
  lastSelectedAt: {},
  gitStatusByConv: {},
  projectIsGitRepo: {},
  ...createUiSlice<StoreState>(set),

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
      showToolActivity: state.settings.defaultShowToolActivity ?? false,
    });
    if (workspacesChanged) await get().saveWorkspaces();
    await get().refreshBackendHealth();
    await get().refreshInstalledReviewers();
    void get().refreshCapabilities();
    void get().refreshMarketplaceSkills();
    for (const p of state.projects) void get().refreshProjectGitStatus(p.id);
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
    // Skip the project's lastOpenedAt bump when the owning project
    // already has *any* active conv (running or recently-active) — its
    // sort position is already pinned by that conv, so re-selecting
    // shouldn't shuffle the Projects list. We only bump when the
    // project would otherwise be dormant, e.g. the user dug into it
    // from "More projects" and we want it to surface.
    const before = get();
    const owningProject = id ? findOwnerProject(before, id) : null;
    const projectAlreadyActive = owningProject
      ? owningProject.conversations.some(
          (c) => !c.hidden && isActiveConversation(c, !!getRunner(c.id)?.isRunning),
        )
      : false;
    const bumpProject = !!id && !!owningProject && !projectAlreadyActive;
    set((s) => ({
      selectedConversationId: id,
      detailMode: id ? 'conversation' : s.detailMode,
      focusedProjectId: id ? null : s.focusedProjectId,
      focusedWorkspaceId: id ? null : s.focusedWorkspaceId,
      openFilePath: null,
      openFileHighlight: null,
      openFileMode: 'edit',
      lastSelectedAt: id ? { ...s.lastSelectedAt, [id]: Date.now() } : s.lastSelectedAt,
      projects: bumpProject
        ? s.projects.map((p) =>
            p.conversations.some((c) => c.id === id) ? { ...p, lastOpenedAt: Date.now() } : p,
          )
        : s.projects,
    }));
    window.overcli.invoke('store:saveSelection', id);
    if (bumpProject) {
      void get().saveProjects();
    }
    if (id) {
      void get().loadHistoryIfNeeded(id);
      const completedAt = getRunner(id)?.completedAt;
      if (completedAt) scheduleClearCompletion(id, completedAt);
    }
  },

  startNewConversation(projectId) {
    // Show the composer-first WelcomePane for this project instead of
    // materializing an empty conversation. The conversation is created
    // when the user actually sends their first message.
    set((s) => ({
      selectedConversationId: null,
      detailMode: 'conversation',
      focusedProjectId: projectId,
      focusedWorkspaceId: null,
      openFilePath: null,
      openFileHighlight: null,
      openFileMode: 'edit',
      welcomeFocusToken: s.welcomeFocusToken + 1,
    }));
    window.overcli.invoke('store:saveSelection', null);
  },

  startNewConversationInWorkspace(workspaceId) {
    set((s) => ({
      selectedConversationId: null,
      detailMode: 'conversation',
      focusedProjectId: null,
      focusedWorkspaceId: workspaceId,
      openFilePath: null,
      openFileHighlight: null,
      openFileMode: 'edit',
      welcomeFocusToken: s.welcomeFocusToken + 1,
    }));
    window.overcli.invoke('store:saveSelection', null);
  },

  // setDetailMode, openSheet, openFile/setOpenFileMode/closeFile,
  // toggleFileTree, toggleSidebar, toggleToolActivity now live in
  // ./uiSlice.ts and are spread into the store above.

  openExplorer(rootPath) {
    set({
      detailMode: 'explorer',
      explorerRootPath: rootPath,
      selectedConversationId: null,
      focusedProjectId: null,
      focusedWorkspaceId: null,
      openFilePath: null,
      openFileHighlight: null,
      openFileMode: 'edit',
    });
    window.overcli.invoke('store:saveSelection', null);
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
    void get().refreshProjectGitStatus(project.id);
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

    const allRunners = getAllRunners();
    const runningIds = new Set<UUID>();
    for (const conv of project.conversations) {
      if (allRunners[conv.id]?.isRunning) runningIds.add(conv.id);
    }
    for (const ws of impactedWorkspaces) {
      for (const conv of ws.conversations ?? []) {
        const touchesProject =
          deletedWorkspaceIds.has(ws.id) ||
          conv.workspaceAgentMemberIds?.some((memberId) => removedConversationIds.has(memberId));
        if (touchesProject && allRunners[conv.id]?.isRunning) runningIds.add(conv.id);
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

    set((s) => {
      const nextGitRepo = { ...s.projectIsGitRepo };
      delete nextGitRepo[id];
      return {
        projects: s.projects.filter((p) => p.id !== id),
        workspaces: nextWorkspaces,
        projectIsGitRepo: nextGitRepo,
        focusedProjectId: s.focusedProjectId === id ? null : s.focusedProjectId,
        focusedWorkspaceId:
          s.focusedWorkspaceId && !nextWorkspaces.some((w) => w.id === s.focusedWorkspaceId)
            ? null
            : s.focusedWorkspaceId,
      };
    });
    await get().saveProjects();
    await get().saveWorkspaces();
  },

  async removeWorkspace(id) {
    const workspace = get().workspaces.find((w) => w.id === id);
    if (!workspace) return;

    const allRunners = getAllRunners();
    const runningIds = (workspace.conversations ?? [])
      .filter((conv) => allRunners[conv.id]?.isRunning)
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
    const paths = await window.overcli.invoke('fs:pickDirectory');
    if (!paths || paths.length === 0) return;
    const existing = new Set(get().projects.map((p) => p.path));
    const fresh = paths.filter((p) => !existing.has(p));
    if (fresh.length === 0) return;
    const added: Project[] = fresh.map((p) => ({
      id: uuid(),
      name: pathBasename(p) || 'Project',
      path: p,
      conversations: [],
      lastOpenedAt: Date.now(),
    }));
    for (const project of added) {
      await get().addProject(project);
    }
    get().startNewConversation(added[added.length - 1].id);
  },

  async newConversation(projectId) {
    const preferred = defaultBackend(get().settings);
    // Capture the project's current branch so the conversation header can
    // warn if the working tree drifts onto a different branch later. Best
    // effort — a non-git project just leaves it undefined.
    let baseBranch: string | undefined;
    const project = get().projects.find((p) => p.id === projectId);
    if (project?.path) {
      try {
        const status = await window.overcli.invoke('git:commitStatus', { cwd: project.path });
        if (status.isRepo && status.currentBranch) baseBranch = status.currentBranch;
      } catch {
        /* leave baseBranch undefined */
      }
    }
    const conv: Conversation = {
      id: uuid(),
      name: 'New conversation',
      createdAt: Date.now(),
      totalCostUSD: 0,
      turnCount: 0,
      currentModel: '',
      permissionMode: get().settings.defaultPermissionMode,
      primaryBackend: preferred,
      baseBranch,
    };
    set((s) => ({
      projects: s.projects.map((p) =>
        p.id === projectId
          ? { ...p, conversations: [...p.conversations, conv], lastOpenedAt: Date.now() }
          : p,
      ),
    }));
    await get().saveProjects();
    get().selectConversation(conv.id);
    return conv;
  },

  async newWorkspace(name, projectIds, instructions) {
    if (!name.trim() || projectIds.length === 0) return null;
    const id = uuid();
    const trimmed = instructions?.trim() || undefined;
    const rootPath = await ensureWorkspaceRoot(get().projects, id, projectIds, trimmed);
    if (!rootPath) return null;
    const ws: Workspace = {
      id,
      name: name.trim(),
      projectIds,
      rootPath,
      conversations: [],
      createdAt: Date.now(),
      instructions: trimmed,
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
    const rootPath = await ensureWorkspaceRoot(
      get().projects,
      workspaceId,
      projectIds,
      ws.instructions,
    );
    if (!rootPath) return false;

    // Compute the project-list diff so we can queue an in-band notice for
    // each running conversation in the workspace. The MD files have been
    // rewritten by ensureWorkspaceRoot, but live CLI subprocesses already
    // read them at session start and won't re-read mid-session.
    const oldIds = new Set(ws.projectIds);
    const newIds = new Set(projectIds);
    const projectsById = new Map(get().projects.map((p) => [p.id, p]));
    const added = projectIds
      .filter((id) => !oldIds.has(id))
      .map((id) => projectsById.get(id))
      .filter((p): p is NonNullable<typeof p> => !!p);
    const removed = ws.projectIds
      .filter((id) => !newIds.has(id))
      .map((id) => projectsById.get(id))
      .filter((p): p is NonNullable<typeof p> => !!p);
    const notice = added.length || removed.length
      ? buildWorkspaceUpdateNotice(rootPath, added, removed)
      : null;

    set((s) => ({
      workspaces: s.workspaces.map((w) => {
        if (w.id !== workspaceId) return w;
        const conversations = notice
          ? (w.conversations ?? []).map((c) => ({
              ...c,
              pendingContextUpdate: c.pendingContextUpdate
                ? `${c.pendingContextUpdate}\n\n${notice}`
                : notice,
            }))
          : w.conversations;
        return { ...w, projectIds, rootPath, conversations };
      }),
    }));
    await get().saveWorkspaces();
    return true;
  },

  /// Update a workspace's freeform instructions and re-materialize the
  /// context files so the new text reaches every backend's CLAUDE.md /
  /// AGENTS.md / GEMINI.md on disk. Future turns pick it up automatically
  /// since the CLIs reload their instructions file per invocation.
  async updateWorkspaceInstructions(workspaceId, instructions) {
    const ws = get().workspaces.find((w) => w.id === workspaceId);
    if (!ws) return false;
    const trimmed = instructions.trim() || undefined;
    const rootPath = await ensureWorkspaceRoot(
      get().projects,
      workspaceId,
      ws.projectIds,
      trimmed,
    );
    if (!rootPath) return false;
    const instructionsChanged = (ws.instructions ?? '') !== (trimmed ?? '');
    const notice = instructionsChanged
      ? `[Workspace context update]\nThe workspace instructions in CLAUDE.md / AGENTS.md / GEMINI.md at ${rootPath} have been updated. Re-read them before answering subsequent questions.`
      : null;
    set((s) => ({
      workspaces: s.workspaces.map((w) => {
        if (w.id !== workspaceId) return w;
        const conversations = notice
          ? (w.conversations ?? []).map((c) => ({
              ...c,
              pendingContextUpdate: c.pendingContextUpdate
                ? `${c.pendingContextUpdate}\n\n${notice}`
                : notice,
            }))
          : w.conversations;
        return { ...w, instructions: trimmed, rootPath, conversations };
      }),
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
    const memberProjects = ws.projectIds
      .map((pid) => state.projects.find((p) => p.id === pid))
      .filter((p): p is NonNullable<typeof p> => !!p);

    // Spawn a git worktree in each member project and create a child
    // agent conversation there. The coordinator itself has no worktree
    // — it's a bookkeeping row that the sidebar renders as the parent
    // and that the user clicks to see the combined review sheet.
    for (let i = 0; i < memberProjects.length; i++) {
      const project = memberProjects[i];
      const projectId = project.id;
      const baseBranch = args.baseBranches[projectId];
      if (!baseBranch) {
        console.warn(`No base branch for ${project.name}; skipping.`);
        continue;
      }
      args.onProgress?.(
        `Creating worktree in ${project.name} (${i + 1} of ${memberProjects.length})…`,
      );
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
    args.onProgress?.('Linking coordinator workspace…');
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
    const hit = findConvWithProjectPath(state, id);
    if (!hit) return { ok: false, error: 'conversation not found' };
    const conv: Conversation = hit.conv;
    const ownerProjectPath = hit.ownerProjectPath;

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
    const hit = findConvWithProjectPath(get(), id);
    if (!hit?.ownerProjectPath) {
      return { ok: false, error: 'conversation not found' };
    }
    const { conv, ownerProjectPath } = hit;
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
    // Transfer: drop worktree-specific fields so the conversation shows
    // up as a normal project conversation. `branchName` is preserved
    // (the project repo is now ON that branch) and `checkedOutLocally`
    // is set so a workspace-agent coordinator's review sheet can render
    // a "demoted" card for this member instead of a stuck spinner.
    // `baseBranch` is preserved so the file-diff view can still compare
    // the agent's commits against where they branched from.
    mutateConversation(set, get, id, (c) => {
      const { worktreePath: _wt, orphaned: _or, ...rest } = c;
      return { ...rest, checkedOutLocally: true };
    });
    await saveConversationState(get);
    return res;
  },

  async checkoutWorkspaceLocally(coordinatorId, commitSubject, commitBody) {
    const state = get();
    let coordinator: Conversation | null = null;
    for (const ws of state.workspaces) {
      const match = (ws.conversations ?? []).find((c) => c.id === coordinatorId);
      if (match) {
        coordinator = match;
        break;
      }
    }
    if (!coordinator) {
      return { ok: false, results: [] };
    }
    const memberIds = coordinator.workspaceAgentMemberIds ?? [];
    const results: Array<{
      memberId: UUID;
      projectName: string;
      ok: boolean;
      message?: string;
      error?: string;
    }> = [];
    // Process sequentially so checkout ops in different project repos
    // don't race each other if they ever touch shared state (global git
    // config, credential helper, etc.).
    for (const memberId of memberIds) {
      let projectName = '(unknown project)';
      let member: Conversation | null = null;
      for (const p of get().projects) {
        const m = p.conversations.find((c) => c.id === memberId);
        if (m) {
          member = m;
          projectName = p.name;
          break;
        }
      }
      if (!member) {
        results.push({ memberId, projectName, ok: false, error: 'member not found' });
        continue;
      }
      if (!member.worktreePath || !member.branchName) {
        // Already demoted or never had a worktree — nothing to do, but
        // don't fail the aggregate.
        results.push({ memberId, projectName, ok: true, message: 'already checked out' });
        continue;
      }
      const res = await get().checkoutAgentLocally(memberId, commitSubject, commitBody);
      if (res.ok) {
        results.push({ memberId, projectName, ok: true, message: res.message });
      } else {
        results.push({ memberId, projectName, ok: false, error: res.error });
      }
    }
    const allOk = results.every((r) => r.ok);
    if (allOk) {
      // Demote the coordinator so the workspace review sheet reads as
      // "wrapped up" and the header drops live-agent affordances. Keep
      // the conversation + its members listed so the chat history and
      // per-project branches remain accessible.
      mutateConversation(set, get, coordinatorId, (c) => ({ ...c, checkedOutLocally: true }));
      await saveConversationState(get);
    }
    return { ok: allOk, results };
  },

  async continueWorkspaceLocally(coordinatorId) {
    const state = get();
    let coordinator: Conversation | null = null;
    for (const ws of state.workspaces) {
      const match = (ws.conversations ?? []).find((c) => c.id === coordinatorId);
      if (match) {
        coordinator = match;
        break;
      }
    }
    if (!coordinator) return { ok: false, error: 'coordinator not found' };
    if (!coordinator.checkedOutLocally) {
      return {
        ok: false,
        error: 'coordinator has not been checked out locally — run "Check out all locally" first',
      };
    }
    const memberIds = coordinator.workspaceAgentMemberIds ?? [];
    const projects: Array<{ name: string; projectPath: string; branchName?: string | null }> = [];
    const used = new Set<string>();
    for (const memberId of memberIds) {
      for (const p of state.projects) {
        const m = p.conversations.find((c) => c.id === memberId);
        if (!m) continue;
        let name = p.name;
        let i = 2;
        while (used.has(name)) {
          name = `${p.name}-${i}`;
          i += 1;
        }
        used.add(name);
        projects.push({ name, projectPath: p.path, branchName: m.branchName ?? null });
        break;
      }
    }
    if (projects.length === 0) {
      return { ok: false, error: 'no member projects resolved — nothing to rebind' };
    }
    const res = await window.overcli.invoke('workspace:rebindCoordinatorRootToProjects', {
      coordinatorId,
      projects,
    });
    if (!res.ok) return res;
    // Keep coordinatorRootPath as-is (the path didn't change — only what
    // its symlinks point at and its CLAUDE.md/AGENTS.md context files).
    // Clear checkedOutLocally so the review sheet stops rendering the
    // coordinator as wrapped up, and flip continuedLocally so the UI
    // can show a "continued locally" label.
    mutateConversation(set, get, coordinatorId, (c) => ({
      ...c,
      checkedOutLocally: false,
      continuedLocally: true,
    }));
    await saveConversationState(get);
    return { ok: true };
  },

  async promoteReviewAgent(id) {
    const state = get();
    const hit = findConvWithProjectPath(state, id);
    if (!hit?.ownerProjectPath) return { ok: false, error: 'conversation not found' };
    const { conv, ownerProjectPath } = hit;
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
    const hit = findConvWithProjectPath(get(), id);
    if (!hit?.ownerProjectPath) return { ok: false, error: 'conversation not found' };
    const { conv, ownerProjectPath } = hit;
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
    const allRunners = getAllRunners();
    const ids = project.conversations
      .filter(
        (c) =>
          !c.hidden &&
          c.id !== selectedId &&
          !(allRunners[c.id]?.isRunning ?? false),
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
    const allRunners = getAllRunners();
    const ids = (workspace.conversations ?? [])
      .filter(
        (c) =>
          !c.hidden &&
          c.id !== selectedId &&
          !(allRunners[c.id]?.isRunning ?? false),
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
    mutateConversation(set, get, id, (c) => {
      const next = { ...c, primaryBackend: backend };
      // `auto` is Claude-only; switching to a non-Claude backend silently
      // demotes it to `default` so the picker label and the actual
      // mapped behaviour stay in sync.
      if (backend !== 'claude') {
        if (next.permissionMode === 'auto') next.permissionMode = 'default';
        if (next.pendingPermissionMode === 'auto') next.pendingPermissionMode = undefined;
      }
      // Re-resolve any non-custom rebound preset against the new
      // primary. Needed because presets like 'half-finished' say "same
      // CLI as primary" — without this, switching primary mid-convo
      // would leave the resolved reviewBackend pointing at the old CLI.
      if (next.reviewPreset && next.reviewPreset !== 'custom') {
        const resolved = resolvePreset(next.reviewPreset, backend);
        if (resolved) {
          next.reviewBackend = resolved.reviewBackend;
          next.reviewMode = resolved.reviewMode;
          next.reviewModel = resolved.reviewModel;
          next.reviewPersona = resolved.reviewPersona;
        }
      }
      return next;
    });
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
    mutateConversation(set, get, id, (c) => {
      const next = { ...c, reviewBackend: backend };
      // Re-map the reviewer model to the new CLI's equivalent tier.
      // Without this, switching CLI in Advanced strands the model on
      // the previous CLI's id (e.g. `gpt-5.5` after switching to
      // claude), which doesn't match any of the new CLI's tier rows
      // and makes the picker look unselected. Strategy: detect the
      // previous tier (cheap/smart) using the previous backend; map
      // to the new backend's same tier. Fall back to null (CLI
      // default) when the previous model isn't a recognized tier or
      // the new backend has no tier table (ollama).
      if (backend && c.reviewBackend && c.reviewModel) {
        const prevBackend = c.reviewBackend as Backend;
        const prevTier = modelTier(prevBackend, c.reviewModel);
        const newTiers = TIERS[backend as Backend];
        next.reviewModel = prevTier && newTiers ? newTiers[prevTier] : null;
      } else if (backend && !TIERS[backend as Backend]) {
        // Switching to a backend with no tier table (ollama) — clear.
        next.reviewModel = null;
      }
      return next;
    });
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
  async setCollabMaxTurns(id, turns) {
    mutateConversation(set, get, id, (c) => ({ ...c, collabMaxTurns: turns }));
    await saveConversationState(get);
  },
  async setReviewOllamaModel(id, model) {
    mutateConversation(set, get, id, (c) => ({ ...c, reviewOllamaModel: model }));
    await saveConversationState(get);
  },
  async setReviewYolo(id, yolo) {
    mutateConversation(set, get, id, (c) => ({ ...c, reviewYolo: yolo }));
    await saveConversationState(get);
  },
  async setReviewModel(id, model) {
    // Manual edit — preset no longer describes the configuration.
    mutateConversation(set, get, id, (c) => ({ ...c, reviewModel: model, reviewPreset: 'custom' }));
    await saveConversationState(get);
  },
  async setReviewPersona(id, persona) {
    mutateConversation(set, get, id, (c) => ({ ...c, reviewPersona: persona, reviewPreset: 'custom' }));
    await saveConversationState(get);
  },
  async setReviewPreset(id, preset) {
    mutateConversation(set, get, id, (c) => {
      if (preset === 'off') {
        return {
          ...c,
          reviewPreset: null,
          reviewBackend: null,
          reviewMode: null,
          reviewModel: null,
          reviewPersona: null,
        };
      }
      if (preset === 'custom') {
        // No field changes — just mark the configuration as user-edited
        // so the picker shows "Custom…" instead of pinning a preset
        // name on something the user has since modified.
        return { ...c, reviewPreset: 'custom' };
      }
      const primary = c.primaryBackend ?? 'claude';
      const resolved = resolvePreset(preset, primary);
      // resolvePreset returns null when the preset can't apply (e.g. a
      // tier-based preset on Ollama). Leave fields unchanged in that
      // case — the renderer should have disabled the row.
      if (!resolved) return c;
      return {
        ...c,
        reviewPreset: preset,
        reviewBackend: resolved.reviewBackend,
        reviewMode: resolved.reviewMode,
        reviewModel: resolved.reviewModel,
        reviewPersona: resolved.reviewPersona,
      };
    });
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
    // Also clear any stale error notice from a prior attempt and flip the
    // runner to running optimistically so the Composer swaps to Stop before
    // the backend's first `running: true` event lands (avoids a double-send
    // window on slow first turns like Gemini ACP startup). We also push a
    // local `localUser` event into events[] so the user's bubble appears
    // instantly and the empty-conversation intro disappears — without this
    // the intro flashes for the IPC roundtrip. The optimistic id is
    // tracked in `pendingLocalUserIds` so `mergeIncomingEvents` can fold
    // in the main-emitted localUser when it arrives instead of double-rendering.
    const optimisticUserId = `local-${uuid()}`;
    const optimisticEvent: StreamEvent = {
      id: optimisticUserId,
      timestamp: Date.now(),
      raw: prompt,
      kind: {
        type: 'localUser',
        text: prompt,
        attachments: attachments.length ? attachments : undefined,
      },
      revision: 0,
    };
    set((s) => {
      const nextAtts = { ...s.conversationAttachments };
      delete nextAtts[conversationId];
      return {
        conversationDrafts: { ...s.conversationDrafts, [conversationId]: '' },
        conversationAttachments: nextAtts,
      };
    });
    useRunnersStore.getState().patchRunner(conversationId, (runner) => {
      const nextPending = new Set(runner.pendingLocalUserIds);
      nextPending.add(optimisticUserId);
      return {
        events: [...runner.events, optimisticEvent],
        pendingLocalUserIds: nextPending,
        errorMessage: undefined,
        isRunning: true,
        activityLabel: runner.activityLabel ?? 'Thinking…',
        completedAt: null,
      };
    });

    const backend = conv.primaryBackend ?? defaultBackend(state.settings);
    if (!isBackendEnabled(state.settings, backend)) {
      useRunnersStore.getState().patchRunner(conversationId, {
        errorMessage: `${backend} is disabled in Settings > Backends.`,
        isRunning: false,
        activityLabel: undefined,
      });
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
        useRunnersStore.getState().patchRunner(conversationId, {
          errorMessage:
            'No Ollama models pulled yet. Open Settings → Local models to pull one.',
          isRunning: false,
          activityLabel: undefined,
        });
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

    // If this conversation was forked from another, prepend the captured
    // transcript so the new CLI sees the prior thread once. Cleared after
    // this turn — subsequent sends don't re-ship it.
    let outgoingPrompt = conv.forkPreamble
      ? `${conv.forkPreamble}\n\nNew user message:\n\n${prompt}`
      : prompt;
    // Workspace-context updates queued while this conv was running (e.g.
    // a project added to the workspace). Same one-shot prepend pattern as
    // forkPreamble — the live CLI subprocess only reads CLAUDE.md /
    // AGENTS.md / GEMINI.md at session start, so an in-band notice is
    // the practical way to surface mid-session workspace edits to the
    // agent without restarting the thread.
    if (conv.pendingContextUpdate) {
      outgoingPrompt = `${conv.pendingContextUpdate}\n\n${outgoingPrompt}`;
    }
    if (conv.forkPreamble || conv.pendingContextUpdate) {
      mutateConversation(set, get, conversationId, (c) => ({
        ...c,
        forkPreamble: undefined,
        pendingContextUpdate: undefined,
      }));
    }

    await window.overcli.invoke('runner:send', {
      conversationId,
      prompt: outgoingPrompt,
      backend,
      localUserId: optimisticUserId,
      cwd,
      model: model ?? '',
      permissionMode: effectivePermissionMode,
      sessionId: conv.sessionId,
      effortLevel: conv.effortLevel,
      codexRolloutPaths: conv.codexRolloutPaths,
      attachments: attachments.length ? attachments : undefined,
      reviewBackend: conv.reviewBackend ?? null,
      reviewMode: conv.reviewMode ?? null,
      reviewModel: conv.reviewModel ?? null,
      reviewPersona: conv.reviewPersona ?? null,
      reviewerSessionIds: conv.reviewerSessionIds,
      collabMaxTurns: conv.collabMaxTurns ?? null,
      reviewOllamaModel: conv.reviewOllamaModel ?? null,
      reviewYolo: conv.reviewYolo ?? null,
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
    useRunnersStore.getState().resetRunner(conversationId);
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

  async respondPermission(conversationId, requestId, approved, addDir, scope, toolName) {
    await window.overcli.invoke('runner:respondPermission', {
      conversationId,
      requestId,
      approved,
      addDir,
      scope,
      toolName,
    });
    if (approved && addDir) {
      mutateConversation(set, get, conversationId, (c) => {
        const existing = c.allowedDirs ?? [];
        if (existing.includes(addDir)) return c;
        return { ...c, allowedDirs: [...existing, addDir] };
      });
      await saveConversationState(get);
    }
    const r = getRunner(conversationId);
    if (r) {
      const events = r.events.map((e) => {
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
      useRunnersStore.getState().patchRunner(conversationId, { events });
    }
  },

  async respondCodexApproval(conversationId, callId, kind, approved) {
    await window.overcli.invoke('runner:respondCodexApproval', {
      conversationId,
      callId,
      kind,
      approved,
    });
    const r = getRunner(conversationId);
    if (r) {
      const events = r.events.map((e) => {
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
      useRunnersStore.getState().patchRunner(conversationId, { events });
    }
  },

  async respondUserInput(conversationId, requestId, answers) {
    await window.overcli.invoke('runner:respondUserInput', {
      conversationId,
      requestId,
      answers,
    });
    const r = getRunner(conversationId);
    if (r) {
      const events = r.events.map((e) => {
        if (e.kind.type === 'userInputRequest' && e.kind.info.requestId === requestId) {
          return {
            ...e,
            revision: e.revision + 1,
            kind: {
              ...e.kind,
              info: { ...e.kind.info, submitted: true },
            } as typeof e.kind,
          };
        }
        return e;
      });
      useRunnersStore.getState().patchRunner(conversationId, {
        events,
        activityLabel: 'Continuing…',
      });
    }
  },

  async loadHistoryIfNeeded(conversationId) {
    const state = get();
    const conv = findConversation(state, conversationId);
    if (!conv) return;
    const existing = getRunner(conversationId);
    if (existing && (existing.historyLoaded || existing.historyLoading)) return;
    const cwd = findContainerPath(state, conversationId);
    if (!cwd) return;
    useRunnersStore.getState().patchRunner(conversationId, { historyLoading: true });
    const events = await window.overcli.invoke('runner:loadHistory', {
      conversationId,
      backend: conv.primaryBackend ?? defaultBackend(state.settings),
      projectPath: cwd,
      sessionId: conv.sessionId,
      codexRolloutPaths: conv.codexRolloutPaths,
      conversationCreatedAt: conv.createdAt,
      conversationLastActiveAt: conv.lastActiveAt,
      syntheticPrompts: conv.syntheticPrompts,
    });
    useRunnersStore.getState().patchRunner(conversationId, (existingRunner) => {
      // History events are inserted at the front; live events (if any came
      // in during the load) stay at the back, in timestamp order.
      const merged = [...events, ...existingRunner.events]
        .filter((e, i, arr) => arr.findIndex((x) => x.id === e.id) === i)
        .sort((a, b) => a.timestamp - b.timestamp);
      return {
        events: merged,
        historyLoading: false,
        historyLoaded: true,
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

  async refreshMarketplaceSkills() {
    const list = await window.overcli.invoke('skills:listMarketplace');
    set({ marketplaceSkills: list });
  },

  async installMarketplaceSkill(skillId, targets) {
    const res = await window.overcli.invoke('skills:installMarketplace', { skillId, targets });
    if (res.ok) {
      await get().refreshMarketplaceSkills();
      await get().refreshCapabilities();
    }
    return res;
  },

  async uninstallMarketplaceSkill(skillId, targets) {
    const res = await window.overcli.invoke('skills:uninstallMarketplace', { skillId, targets });
    if (res.ok) {
      await get().refreshMarketplaceSkills();
      await get().refreshCapabilities();
    }
    return res;
  },

  async removeInstalledSkill(skillPath) {
    const res = await window.overcli.invoke('skills:uninstallByPath', { path: skillPath });
    if (res.ok) {
      await get().refreshCapabilities();
      await get().refreshMarketplaceSkills();
    }
    return res;
  },

  async copyMcpToCli(name, fromCli, toCli) {
    const res = await window.overcli.invoke('capabilities:copyMcp', { name, fromCli, toCli });
    if (res.ok) await get().refreshCapabilities();
    return res;
  },

  async refreshProjectGitStatus(projectId) {
    const project = get().projects.find((p) => p.id === projectId);
    if (!project?.path) return;
    try {
      const res = await window.overcli.invoke('git:commitStatus', { cwd: project.path });
      set((s) => ({
        projectIsGitRepo: { ...s.projectIsGitRepo, [projectId]: !!res.isRepo },
      }));
    } catch {
      set((s) => ({
        projectIsGitRepo: { ...s.projectIsGitRepo, [projectId]: false },
      }));
    }
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
      useRunnersStore.getState().patchRunner(event.conversationId, (runner) => {
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
        return { events: nextEvents, pendingLocalUserIds: pending, currentModel };
      });
      if (initForGlobal) set({ lastInit: initForGlobal });
    } else if (event.type === 'running') {
      // Ignore the menu-sentinel used for Cmd+N; routed separately.
      if (event.conversationId === '__menu_new_conversation__') return;
      const wasRunning = getRunner(event.conversationId)?.isRunning ?? false;
      const justCompleted = wasRunning && !event.isRunning;
      const justStarted = !wasRunning && event.isRunning;
      const completedAt = justCompleted ? Date.now() : justStarted ? null : undefined;
      useRunnersStore.getState().patchRunner(event.conversationId, {
        isRunning: event.isRunning,
        activityLabel: event.activityLabel,
        ...(completedAt !== undefined ? { completedAt } : {}),
      });
      if (justCompleted && get().selectedConversationId === event.conversationId) {
        scheduleClearCompletion(event.conversationId, completedAt as number);
      }
      if (justCompleted) {
        // Bump lastActiveAt so the sidebar's "Active" 10-min window
        // restarts at finish time, not at the original prompt — long
        // runs were dropping off the list the instant they finished.
        mutateConversation(set, get, event.conversationId, (c) => ({
          ...c,
          lastActiveAt: Date.now(),
        }));
        void saveConversationState(get);
        // Main-side guard skips the bounce if the window is focused or
        // we already nudged in the last 10s, so this is safe to fire on
        // every completion regardless of view state.
        void window.overcli.invoke('app:notifyCompleted');
      }
      const state = get();
      const conv = findConversation(state, event.conversationId);
      const colosseumId = conv?.colosseumId;
      if (colosseumId) {
        const colosseum = state.colosseums.find((c) => c.id === colosseumId);
        if (colosseum && colosseum.status !== 'cancelled' && colosseum.status !== 'merged') {
          const runners = getAllRunners();
          const allStopped = colosseum.contenderIds.every(
            (cid) => !(runners[cid]?.isRunning ?? false),
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
      useRunnersStore.getState().patchRunner(event.conversationId, {
        errorMessage: event.message,
        isRunning: false,
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
    } else if (event.type === 'reviewerSessionConfigured') {
      // Persist the captured reviewer session id on the conversation so
      // the next review can resume the same warm thread — survives app
      // restart. Keyed by reviewer backend; today only `claude` fires
      // this, but the keyed shape leaves room for codex/others later.
      const store = get();
      const conv = findConversation(store, event.conversationId);
      if (!conv) return;
      mutateConversation(set, get, event.conversationId, (c) => {
        const ids = { ...(c.reviewerSessionIds ?? {}) };
        ids[event.reviewBackend] = event.sessionId;
        return { ...c, reviewerSessionIds: ids };
      });
      void saveConversationState(get);
    } else if (event.type === 'codexRuntimeMode') {
      useRunnersStore.getState().patchRunner(event.conversationId, {
        codexRuntimeMode: event.mode,
        codexSandboxMode: event.sandbox,
        codexApprovalPolicy: event.approval,
      });
    } else if (event.type === 'syntheticPrompt') {
      // Record the hash on the conversation so history replay can skip
      // the matching `role: 'user'` entry the primary CLI persisted —
      // otherwise the wrapped reviewer feedback resurfaces as a
      // misattributed user-style bubble after restart.
      mutateConversation(set, get, event.conversationId, (c) => {
        const existing = c.syntheticPrompts ?? [];
        if (existing.includes(event.hash)) return c;
        return { ...c, syntheticPrompts: [...existing, event.hash] };
      });
      void saveConversationState(get);
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
