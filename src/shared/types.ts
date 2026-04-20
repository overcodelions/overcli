// Shared type definitions used by both the Electron main process and the
// renderer. Modeled on the Swift app's Conversation / Project / StreamEvent
// types so the JSON persistence shape stays compatible where it can.

export type UUID = string;
export type Backend = 'claude' | 'codex' | 'gemini' | 'ollama';
export type PermissionMode = 'default' | 'plan' | 'acceptEdits' | 'bypassPermissions';
export type EffortLevel = 'low' | 'medium' | 'high' | 'max' | '';

export interface ToolUseBlock {
  id: string;
  name: string;
  /// Raw JSON string of the tool's arguments. The Swift app also parsed this
  /// for known tools; we do the same lazily at render time.
  inputJSON: string;
  filePath?: string;
  oldString?: string;
  newString?: string;
}

export interface ToolResultBlock {
  id: string;
  content: string;
  isError: boolean;
}

export interface AssistantEventInfo {
  model: string | null;
  text: string;
  toolUses: ToolUseBlock[];
  thinking: string[];
  /// Opaque (redacted / encrypted) reasoning — visible as a pill but not rendered
  hasOpaqueReasoning?: boolean;
}

export interface SystemInitInfo {
  sessionId: string;
  model: string;
  cwd: string;
  apiKeySource: string;
  tools: string[];
  slashCommands: string[];
  mcpServers: Array<{ name: string; status: string }>;
}

export interface ModelUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
}

export interface ResultInfo {
  subtype: string;
  isError: boolean;
  durationMs: number;
  totalCostUSD: number;
  modelUsage: Record<string, ModelUsage>;
}

export interface RateLimitInfo {
  status: string;
  rateLimitType: string;
  remaining?: number;
  resetsAt?: number;
  limit?: number;
}

export interface PermissionRequestInfo {
  backend?: Backend;
  requestId: string;
  toolName: string;
  description: string;
  toolInput: string;
  decided?: 'allow' | 'deny';
}

export interface CodexApprovalInfo {
  callId: string;
  kind: 'exec' | 'patch';
  command?: string;
  changesSummary?: string;
  reason?: string;
  decided?: 'allow' | 'deny';
}

export interface PatchFileChange {
  id: string;
  path: string;
  kind: 'add' | 'modify' | 'delete' | 'move';
  movedFrom?: string;
  additions: number;
  deletions: number;
  /// Unified-diff text (optional — older patches may only carry summary).
  diff?: string;
}

export interface PatchApplyInfo {
  id: string;
  files: PatchFileChange[];
  success: boolean;
  stderr?: string;
}

export interface ReviewInfo {
  backend: string;
  text: string;
  isRunning: boolean;
  error?: string;
  startedAt: number;
  round: number;
  mode?: string;
  thinking?: string;
  raw?: string;
}

/// Image attachment sent alongside a user prompt. `dataBase64` is the raw
/// file bytes in standard base64 (no `data:` prefix). Each backend encodes
/// this differently on the wire — claude takes base64 inline, codex wants
/// a file path so we write temp files, gemini is text-only today.
export interface Attachment {
  id: string;
  mimeType: string;
  dataBase64: string;
  label?: string;
  size?: number;
}

export type StreamEventKind =
  | { type: 'localUser'; text: string; attachments?: Attachment[] }
  | { type: 'systemInit'; info: SystemInitInfo }
  | { type: 'assistant'; info: AssistantEventInfo }
  | { type: 'toolResult'; results: ToolResultBlock[] }
  | { type: 'result'; info: ResultInfo }
  | { type: 'rateLimit'; info: RateLimitInfo }
  | { type: 'permissionRequest'; info: PermissionRequestInfo }
  | { type: 'codexApproval'; info: CodexApprovalInfo }
  | { type: 'patchApply'; info: PatchApplyInfo }
  | { type: 'reviewResult'; info: ReviewInfo }
  | { type: 'systemNotice'; text: string }
  | { type: 'stderr'; line: string }
  | { type: 'parseError'; message: string }
  | { type: 'streamDelta' }
  | { type: 'other'; label: string };

export interface StreamEvent {
  id: string;
  timestamp: number;
  raw: string;
  kind: StreamEventKind;
  /// Bumps on in-place mutation of the partial-assistant slot so the renderer
  /// can tell a row changed even when its id didn't.
  revision: number;
}

export interface Conversation {
  id: UUID;
  name: string;
  sessionId?: string;
  createdAt: number;
  lastActiveAt?: number;
  totalCostUSD: number;
  turnCount: number;
  currentModel: string;
  permissionMode: PermissionMode;
  worktreePath?: string;
  branchName?: string;
  baseBranch?: string;
  orphaned?: boolean;
  hidden?: boolean;
  reviewBackend?: string | null;
  reviewMode?: 'review' | 'collab' | null;
  collabMaxTurns?: number | null;
  /// Ollama-specific reviewer model override. When the reviewer is
  /// `ollama`, this takes precedence over the app-wide Ollama default.
  reviewOllamaModel?: string | null;
  primaryBackend?: Backend;
  claudeModel?: string;
  codexModel?: string;
  geminiModel?: string;
  ollamaModel?: string;
  codexRolloutPath?: string;
  /// Every rollout file codex has created for this conversation. codex proto
  /// has no --resume, each spawn writes a fresh file — we merge on load.
  codexRolloutPaths?: string[];
  effortLevel?: EffortLevel;
  colosseumId?: UUID;
  workspaceAgentMemberIds?: UUID[];
  workspaceAgentCoordinatorId?: UUID;
}

export interface Project {
  id: UUID;
  name: string;
  path: string;
  conversations: Conversation[];
  lastOpenedAt?: number;
}

export interface Workspace {
  id: UUID;
  name: string;
  projectIds: UUID[];
  rootPath: string;
  conversations: Conversation[];
  createdAt: number;
}

export type ColosseumStatus = 'running' | 'comparing' | 'merged' | 'cancelled';

export interface Colosseum {
  id: UUID;
  name: string;
  prompt: string;
  baseBranch: string;
  projectId: UUID;
  contenderIds: UUID[];
  createdAt: number;
  status: ColosseumStatus;
  winnerId?: UUID;
}

/// Snapshot of the agent worktree's git state relative to its base branch
/// and to the project checkout the worktree was spawned from. Drives the
/// diff/merge/push sheet's status pills and enables/disables action
/// buttons. Computed synchronously on demand — cheap enough since we
/// already shell out to git for the diff.
export type RemoteKind = 'github' | 'other' | 'none';

export interface WorktreeStatus {
  filesChanged: number;
  insertions: number;
  deletions: number;
  commitsAhead: number;
  hasUncommittedChanges: boolean;
  /// Worktree branch is already merged into its base branch (nothing to
  /// re-merge). Computed from `merge-base --is-ancestor`.
  isMergedIntoBase: boolean;
  /// Whatever branch the main project checkout is currently on. `null`
  /// means detached HEAD or a git error.
  currentProjectBranch: string | null;
  remoteKind: RemoteKind;
  /// Count of dirty files in the *main* project checkout — flags the
  /// "agent wrote to the wrong tree" case so the UI can offer a rescue.
  mainTreeDirtyFiles: number;
}

export interface BackendHealth {
  kind: 'ready' | 'unauthenticated' | 'missing' | 'unknown' | 'error';
  message?: string;
}

/// CLI extensions (skills, subagents, slash commands, plugins, MCP
/// servers) discovered by scanning each CLI's on-disk config. Unlike
/// `SystemInitInfo.slashCommands` this is populated at app-start — no
/// first-turn required — and models availability per-CLI so the UI can
/// show which backends expose each item.
export type CapabilityKind = 'skill' | 'agent' | 'command' | 'plugin' | 'mcp';
export type CapabilitySource = 'user' | 'project' | 'plugin' | 'builtin';

export interface CapabilityEntry {
  kind: CapabilityKind;
  /// Stable key across scans, e.g. "skill:atlassian:triage-issue",
  /// "mcp:github". Used for React keys and dedup across CLI sources.
  id: string;
  name: string;
  description?: string;
  source: CapabilitySource;
  /// Plugin bundle this came from, when source === 'plugin'.
  pluginId?: string;
  /// File backing this capability (SKILL.md, agent .md, command .md).
  /// For MCP this is the config file where the server is defined.
  path?: string;
  /// Which CLIs currently expose this capability. MCP servers may appear
  /// in multiple CLIs; skills/agents/commands today are typically one.
  clis: Backend[];
}

export interface CapabilitiesReport {
  generatedAt: number;
  entries: CapabilityEntry[];
  /// Non-fatal scan errors, per source, so the UI can surface them
  /// without failing the whole scan.
  warnings: string[];
}

export interface OllamaModelInfo {
  name: string;
  sizeBytes: number;
  modifiedAt?: string;
}

export interface OllamaDetectionReport {
  installed: boolean;
  running: boolean;
  version?: string;
  binaryPath?: string;
  models: OllamaModelInfo[];
  installHint?: { brewAvailable: boolean; downloadUrl: string };
}

export type OllamaTier = 'tiny' | 'small' | 'medium' | 'large';

export interface OllamaRecommendedModel {
  tag: string;
  displayName: string;
  sizeGB: number;
  license: string;
  note?: string;
}

export interface OllamaHardwareReport {
  platform: string;
  arch: string;
  totalRamGB: number;
  cpuModel: string;
  gpu?: string;
  appleSilicon: boolean;
  recommendedTier: OllamaTier;
  recommendedModels: OllamaRecommendedModel[];
}

export type OllamaPullEvent =
  | { type: 'status'; tag: string; message: string }
  | { type: 'progress'; tag: string; percent: number; completed: number; total: number; message?: string }
  | { type: 'done'; tag: string; success: boolean; message?: string };

export type OllamaServerStatus = 'stopped' | 'starting' | 'running' | 'error';

export interface OllamaServerLogLine {
  stream: 'stdout' | 'stderr' | 'system';
  text: string;
  timestamp: number;
}

export type ThemePreference = 'light' | 'dark' | 'system';

export interface AppSettings {
  backendPaths: Partial<Record<Backend, string>>;
  backendDefaultModels: Partial<Record<Backend, string>>;
  /// Backends hidden/disabled in the UI. Disabled backends are not used as
  /// defaults and are skipped by health probes.
  disabledBackends: Partial<Record<Backend, boolean>>;
  defaultPermissionMode: PermissionMode;
  defaultEffort: EffortLevel;
  agentBranchPrefix: string;
  showCost: boolean;
  autoDowngrade: boolean;
  /// Theme preference. 'system' follows the OS's dark-mode setting via
  /// the `prefers-color-scheme` media query.
  theme: ThemePreference;
  /// Persisted pane widths. Clamped on read to the component's min/max
  /// so a stored-too-large value from a wider monitor doesn't pin the
  /// app's content region to zero.
  sidebarWidth: number;
  editorPaneWidth: number;
}

/// Renderer → main requests. Responses come back via invoke's return value.
export interface IPCInvokeMap {
  'store:load': () => {
    projects: Project[];
    workspaces: Workspace[];
    colosseums: Colosseum[];
    settings: AppSettings;
    selectedConversationId?: UUID;
    lastInit?: SystemInitInfo;
  };
  'store:saveProjects': (projects: Project[]) => void;
  'store:saveWorkspaces': (workspaces: Workspace[]) => void;
  'store:saveColosseums': (colosseums: Colosseum[]) => void;
  'store:saveSettings': (settings: AppSettings) => void;
  'store:saveSelection': (id: UUID | null) => void;
  'runner:send': (args: {
    conversationId: UUID;
    prompt: string;
    backend: Backend;
    cwd: string;
    model: string;
    permissionMode: PermissionMode;
    sessionId?: string;
    effortLevel?: EffortLevel;
    codexRolloutPaths?: string[];
    attachments?: Attachment[];
    /// Reviewer ("rebound") config for this turn. When `reviewBackend` is
    /// set, the runner fires the reviewer after the primary turn
    /// completes and streams reviewResult events back.
    reviewBackend?: string | null;
    reviewMode?: 'review' | 'collab' | null;
    collabMaxTurns?: number | null;
    reviewOllamaModel?: string | null;
  }) => { ok: true } | { ok: false; error: string };
  'runner:stop': (args: { conversationId: UUID }) => void;
  'runner:newConversation': (args: { conversationId: UUID }) => void;
  'runner:respondPermission': (args: {
    conversationId: UUID;
    requestId: string;
    approved: boolean;
  }) => void;
  'runner:respondCodexApproval': (args: {
    conversationId: UUID;
    callId: string;
    kind: 'exec' | 'patch';
    approved: boolean;
  }) => void;
  'runner:loadHistory': (args: {
    conversationId: UUID;
    backend: Backend;
    projectPath: string;
    sessionId?: string;
    codexRolloutPaths?: string[];
    conversationCreatedAt?: number;
    conversationLastActiveAt?: number;
  }) => StreamEvent[];
  'runner:probeHealth': (backend: Backend) => BackendHealth;
  'runner:listInstalledReviewers': () => Record<string, boolean>;
  'capabilities:scan': () => CapabilitiesReport;
  'fs:pickDirectory': () => string | null;
  'fs:readFile': (path: string) => { ok: true; content: string } | { ok: false; error: string };
  'fs:writeFile': (args: { path: string; content: string }) => { ok: true } | { ok: false; error: string };
  'fs:listFiles': (root: string) => string[];
  'fs:openInFinder': (path: string) => void;
  'git:run': (args: { args: string[]; cwd: string }) => {
    stdout: string;
    stderr: string;
    exitCode: number;
  };
  'git:createWorktree': (args: {
    projectPath: string;
    agentName: string;
    baseBranch: string;
    branchPrefix: string;
  }) => { ok: true; worktreePath: string; branchName: string } | { ok: false; error: string };
  'git:removeWorktree': (args: { projectPath: string; worktreePath: string; branchName: string }) => {
    ok: boolean;
    error?: string;
  };
  'git:listBaseBranches': (projectPath: string) => string[];
  'git:detectBaseBranch': (projectPath: string) => string;
  'git:mergeAgent': (args: {
    projectPath: string;
    worktreePath: string;
    branchName: string;
    target: string;
    commitSubject: string;
    commitBody?: string;
  }) => { ok: true; message: string } | { ok: false; error: string };
  'git:rebaseAgent': (args: {
    projectPath: string;
    worktreePath: string;
    branchName: string;
    baseBranch: string;
    commitSubject: string;
    commitBody?: string;
  }) => { ok: true; message: string } | { ok: false; error: string };
  'git:pushBranch': (args: {
    worktreePath: string;
    branchName: string;
    commitSubject: string;
    commitBody?: string;
  }) => { ok: true; message: string; compareUrl?: string } | { ok: false; error: string };
  'git:openPR': (args: {
    worktreePath: string;
    branchName: string;
    baseBranch: string;
    title: string;
    body: string;
    commitSubject: string;
    commitBody?: string;
  }) => { ok: true; message: string; url?: string } | { ok: false; error: string };
  'git:worktreeStatus': (args: {
    projectPath: string;
    worktreePath: string;
    branchName: string;
    baseBranch: string;
  }) => WorktreeStatus;
  'git:rescueMainTree': (args: {
    projectPath: string;
    worktreePath: string;
    branchName: string;
  }) => { ok: true; message: string } | { ok: false; error: string };
  'git:commitStatus': (args: { cwd: string }) => {
    isRepo: boolean;
    currentBranch: string;
    changes: Array<{ path: string; status: string }>;
    insertions: number;
    deletions: number;
  };
  'git:commitAll': (args: { cwd: string; message: string }) =>
    | { ok: true; sha: string; subject: string }
    | { ok: false; error: string };
  'workspace:ensureSymlinkRoot': (args: {
    workspaceId: UUID;
    projects: Array<{ name: string; path: string }>;
  }) => { ok: true; rootPath: string } | { ok: false; error: string };
  'app:openExternal': (url: string) => void;
  'app:showAbout': () => void;
  'app:reloadStats': () => StatsReport;
  'ollama:detect': () => OllamaDetectionReport;
  'ollama:hardware': () => OllamaHardwareReport;
  'ollama:install': () => { started: 'brew' | 'browser'; detail?: string };
  'ollama:startServer': () => { ok: boolean; message: string };
  'ollama:stopServer': () => void;
  'ollama:serverStatus': () => { status: OllamaServerStatus; log: OllamaServerLogLine[] };
  'ollama:pullModel': (args: { tag: string }) => { ok: true } | { ok: false; error: string };
  'ollama:cancelPull': (args: { tag: string }) => void;
}

export interface DailyBackendBucket {
  turns: number;
  inputTokens: number;
  outputTokens: number;
}

export interface DailyBucket {
  /// YYYY-MM-DD key in local time. Days with no activity are still
  /// present with zero counts so the chart has continuous x-axis data.
  day: string;
  turns: number;
  inputTokens: number;
  outputTokens: number;
  /// Per-backend breakdown so the chart can render stacked bars. Keys
  /// match the `Backend` type. Missing keys = zero for that backend.
  byBackend?: Partial<Record<Backend, DailyBackendBucket>>;
}

export interface StatsReport {
  generatedAt: number;
  totalSessions: number;
  totalTurns: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCacheRead: number;
  totalCacheCreation: number;
  byBackend: BackendStats[];
  byProject: ProjectStats[];
  byModel: Array<{
    model: string;
    turns: number;
    inputTokens: number;
    outputTokens: number;
    cacheRead: number;
    cacheCreation: number;
  }>;
  /// Last 30 days of activity for the stats-page chart.
  daily: DailyBucket[];
}

export interface BackendStats {
  backend: Backend;
  sessions: number;
  turns: number;
  inputTokens: number;
  outputTokens: number;
  tokensLast5h: number;
  tokensLast24h: number;
  tokensLast7d: number;
  sessionsToday: number;
  lastActive?: number;
}

export interface ProjectStats {
  id: string;
  name: string;
  sessions: number;
  turns: number;
  inputTokens: number;
  outputTokens: number;
  cacheRead: number;
  cacheCreation: number;
}

/// Main → renderer push events. The runner emits stream events here as they
/// come off the CLI's stdout. Events are tagged with the conversationId so
/// the renderer can route them to the right pane.
export type MainToRendererEvent =
  | {
      type: 'stream';
      conversationId: UUID;
      events: StreamEvent[];
    }
  | {
      type: 'running';
      conversationId: UUID;
      isRunning: boolean;
      activityLabel?: string;
    }
  | {
      type: 'error';
      conversationId: UUID;
      message: string;
    }
  | {
      type: 'sessionConfigured';
      conversationId: UUID;
      sessionId: string;
      rolloutPath?: string;
    }
  | {
      type: 'codexRuntimeMode';
      conversationId: UUID;
      mode: 'proto' | 'exec';
      sandbox: string;
      approval: string;
    }
  | {
      type: 'ollamaPull';
      event: OllamaPullEvent;
    }
  | {
      type: 'ollamaServerLog';
      line: OllamaServerLogLine;
    }
  | {
      type: 'ollamaServerStatus';
      status: OllamaServerStatus;
    };

export const DEFAULT_SETTINGS: AppSettings = {
  backendPaths: {},
  backendDefaultModels: {},
  disabledBackends: {},
  defaultPermissionMode: 'plan',
  defaultEffort: '',
  agentBranchPrefix: 'agent/',
  showCost: false,
  autoDowngrade: true,
  theme: 'system',
  sidebarWidth: 260,
  editorPaneWidth: 540,
};
