// Per-conversation subprocess manager. Holds one long-lived `claude` or
// `codex proto` process per conversation. Parses line-delimited JSON off
// stdout, emits typed StreamEvents to the renderer via the `mainEmitter`
// supplied at construction, and buffers a writer handle on stdin so we can
// feed new user turns without respawning.

import { spawn, spawnSync, ChildProcessWithoutNullStreams } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  Backend,
  PermissionMode,
  EffortLevel,
  StreamEvent,
  ToolUseBlock,
  UUID,
  StreamEventKind,
  MainToRendererEvent,
  AppSettings,
  Attachment,
  UserInputAnswer,
} from '../shared/types';
// Claude parser internals now live behind backends/claude.ts. The runner
// only sees opaque parserState on ActiveProcess and dispatches via spec.
import {
  CodexAppServerParserState,
  makeCodexAppServerParserState,
  parseCodexAppServerNotification,
  translateApprovalRequest,
  translateUserInputRequest,
} from './parsers/codex-app-server';
import {
  CodexAppServerApprovalPolicy,
  CodexAppServerClient,
  CodexAppServerSandboxMode,
} from './codex-app-server';
import {
  makeAssistantEvent,
  makeAssistantEventWithTools,
  makeErrorEvent,
  makeResultEvent,
  makeSystemInitEvent,
  makeToolResultEvent,
} from './parsers/ollama';
import {
  backendNeedsShell,
  buildBackendEnv,
  listBackendPathCandidates,
  resolveBackendPath,
} from './backendPaths';
import {
  OLLAMA_CATALOG,
  OllamaChatMessage,
  OllamaToolCall,
  detectOllama,
  streamChat,
} from './ollama';
import { OLLAMA_BUILTIN_TOOLS, executeOllamaTool, extractInlineToolCalls } from './ollamaTools';
import { loadOllamaSession, saveOllamaSession } from './ollamaStore';
import { ReviewerManager } from './reviewer';
import { GeminiAcpClient } from './geminiAcp';
import { ClaudePermissionBroker, ApprovalRequest } from './claudePermissionBroker';
import {
  appendClaudeAllowRule,
  codexTransportPermissions,
  extractRequestedPath,
  geminiPermissionMapping,
  isInsideAllowedDirs,
  normalizeAllowedDirs,
} from './permissionRules';
import { summarizeToolUse } from './toolDescription';
import { collapsePartialAssistants } from './streamSnapshot';
import { getBackendSpec } from './backends';
import { codexExecSnapshotText } from './backends/codex';
import type { BackendCtx, BackendSendArgs } from './backends';
import { resolveSymlinkWritableRoots } from './workspace';

type Emit = (event: MainToRendererEvent) => void;

/// SHA-256 hex of a synthetic collab pingPrompt, used to mark it for
/// skip-on-replay. Hashing keeps `Conversation.syntheticPrompts` bounded
/// at 64 chars/entry regardless of prompt size, so a long collab
/// session can't bloat persisted state.
function hashSyntheticPrompt(prompt: string): string {
  return createHash('sha256').update(prompt, 'utf8').digest('hex');
}

interface SendArgs {
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
  reviewBackend?: string | null;
  reviewMode?: 'review' | 'collab' | null;
  collabMaxTurns?: number | null;
  reviewOllamaModel?: string | null;
  reviewYolo?: boolean | null;
  allowedDirs?: string[];
  localUserId?: string;
}

interface PermissionResponse {
  requestId: string;
  approved: boolean;
}

interface ActiveProcess {
  proc?: ChildProcessWithoutNullStreams;
  backend: Backend;
  sessionId?: string;
  launchModel: string;
  launchPermissionMode: PermissionMode;
  stdoutBuffer: string;
  stderrBuffer: string;
  codexAppServerState?: CodexAppServerParserState;
  codexAppServer?: CodexAppServerClient;
  codexMode?: 'exec' | 'app-server';
  /// Pending permission/approval handlers indexed by requestId / callId.
  /// We look them up on response so the renderer's allow/deny decisions
  /// reach the live subprocess.
  pendingPermissions: Map<string, (approved: boolean) => void>;
  pendingCodexApprovals: Map<string, (approved: boolean) => void>;
  pendingUserInputs: Map<string, (answers: Record<string, UserInputAnswer>) => void>;
  /// Accumulated context for the current turn so we can feed the
  /// reviewer ("rebound") a digest of what the primary just did when the
  /// turn completes. Reset on each `result` event.
  currentUserPrompt: string;
  currentAssistantText: string;
  currentToolActivity: string[];
  /// Snapshot of the rebound config that came in with this turn. The
  /// renderer passes it on send; we stash it here so the turn-complete
  /// hook can fire the reviewer without having to re-fetch store state.
  reviewBackend: Backend | null;
  reviewMode: 'review' | 'collab' | null;
  collabMaxTurns: number;
  /// User-picked Ollama model for the reviewer (when `reviewBackend`
  /// is `ollama`). When null, we fall back to the app-wide default then
  /// the first pulled model.
  reviewOllamaModel: string | null;
  /// Codex-only yolo toggle — see SendArgs.reviewYolo.
  reviewYolo: boolean;
  /// Bumps on each human-originated send so collab loops that kick off
  /// on a stale burst don't keep ping-ponging after the user has moved
  /// on. Reviewer completion compares this to its captured snapshot.
  collabBurst: number;
  /// Number of collab rounds fired in the current burst. Ping-pong
  /// stops when this hits `collabMaxTurns`.
  collabRoundsInBurst: number;
  cwd: string;
  /// Directories this Claude subprocess was launched with `--add-dir` for.
  /// Used by handleClaudeApproval to decide whether a requested path is
  /// already inside the session's scope.
  allowedDirs: string[];
  /// Tool names the user "always allowed" during this subprocess's life.
  /// The settings.json write takes effect on the NEXT spawn; this set
  /// covers the narrower case where Claude re-invokes the same tool later
  /// in the current turn.
  sessionAllowedTools: Set<string>;
  /// Opaque per-backend parser state, owned by the spec via
  /// `BackendSpec.makeParserState()`. The runner only stores it; the
  /// spec's `parseChunk` reads/writes it. Backends that haven't been
  /// migrated to parseChunk yet (codex/gemini) continue to read their
  /// state from named ActiveProcess fields below.
  parserState?: unknown;
  /// Stashed args from the most recent user-initiated send. Used by the
  /// Allow+Add Dir auto-resume path to respawn Claude with updated
  /// `--add-dir` flags and `--resume` the session without making the
  /// user type a fresh message.
  lastSendArgs?: SendArgs;
}

interface GeminiAcpSession {
  client: GeminiAcpClient;
  sessionId?: string;
  initialized: boolean;
  promptInFlight: boolean;
  /// Follow-up prompts typed while `promptInFlight` is true queue here
  /// instead of racing a second session/prompt alongside the first (Gemini
  /// ACP serializes prompts per-session; an overlapping call would reset
  /// the streaming snapshot and confuse the UI).
  queuedPrompt?: { args: SendArgs; syntheticFromCollab: boolean };
  closing: boolean;
  stderrBuffer: string;
  currentModelId: string;
  currentModeId: string;
  currentAssistantEventId?: string;
  currentAssistantText: string;
  currentThinkingText: string;
  currentToolUses: ToolUseBlock[];
  currentToolUseIndex: Map<string, number>;
  currentAssistantNeedsSplit: boolean;
  currentUserPrompt: string;
  currentToolActivity: string[];
  reviewBackend: Backend | null;
  reviewMode: 'review' | 'collab' | null;
  collabMaxTurns: number;
  reviewOllamaModel: string | null;
  reviewYolo: boolean;
  collabBurst: number;
  collabRoundsInBurst: number;
  cwd: string;
  turnStartedAt: number;
  pendingPermissions: Map<
    string,
    {
      requestId: string;
      toolCallId: string;
      options: Array<{ optionId: string; kind: string; name: string }>;
      resolve: (approved: boolean) => void;
    }
  >;
}

/// Ollama sessions are HTTP-based — no child process, no stdin. We keep
/// the chat history in-memory and replay it on every /api/chat call
/// (Ollama has no server-side session state of its own).
interface OllamaSession {
  messages: OllamaChatMessage[];
  /// Parallel to `messages` — index-aligned per-message wallclock
  /// timestamps used when we write the persisted transcript. Necessary
  /// so `loadHistory` can replay messages with monotonically increasing
  /// StreamEvent timestamps after an app restart.
  messageTimestamps: number[];
  inFlight?: AbortController;
  sessionId: string;
  lastModel: string;
  initEmitted: boolean;
  /// Parallel to ActiveProcess.collabBurst — bumps on every
  /// human-originated send so stale collab ping-pongs abort when the
  /// user moves on.
  collabBurst: number;
  collabRoundsInBurst: number;
}

export class RunnerManager {
  private procs = new Map<UUID, ActiveProcess>();
  private ollamaSessions = new Map<UUID, OllamaSession>();
  private geminiAcpSessions = new Map<UUID, GeminiAcpSession>();
  private geminiAcpSupported: boolean | null = null;
  private emit: Emit;
  private settingsProvider: () => AppSettings;
  private reviewer: ReviewerManager;
  private codexCapabilities = new Map<string, { hasAppServer: boolean }>();
  /// codex exec has no --resume: every turn spawns a fresh session that
  /// knows nothing about prior exchanges. The exec fallback (used for
  /// pre-0.30 codex binaries that lack app-server) stitches context back
  /// by prepending the accumulated transcript to the next prompt.
  /// Cleared on newConversation().
  private codexExecTranscriptByConversation = new Map<
    UUID,
    { user: string; assistant: string }[]
  >();
  private claudeBroker: ClaudePermissionBroker;
  /// Per-conversation temp --mcp-config path for Claude's permission-prompt-tool.
  /// Present while the Claude subprocess is alive; cleared on close/kill.
  private claudeMcpByConv = new Map<UUID, string>();
  /// Conversations whose next Claude turn has been requested but hasn't yet
  /// reached the synchronous `sendSubprocess` step (broker prep in flight).
  /// While set, swallow stray `running: false` emits from the *previous*
  /// turn's subprocess close — otherwise a fast follow-up that arrives in
  /// the gap between the old proc exiting and the new one spawning gets
  /// its optimistic "Thinking…" strip clobbered.
  private claudeSendPending = new Set<UUID>();

  constructor(emit: Emit, settingsProvider: () => AppSettings) {
    this.emit = emit;
    this.settingsProvider = settingsProvider;
    this.reviewer = new ReviewerManager(emit);
    this.claudeBroker = new ClaudePermissionBroker((req) => this.handleClaudeApproval(req));
  }

  /// Trim a SendArgs to the subset BackendSpec implementations need. Keeps
  /// the spec interface free of fields only the runner cares about
  /// (reviewer config, codex rollout paths, optimistic localUserId).
  private toBackendArgs(args: SendArgs): BackendSendArgs {
    return {
      conversationId: args.conversationId,
      prompt: args.prompt,
      cwd: args.cwd,
      model: args.model,
      permissionMode: args.permissionMode,
      sessionId: args.sessionId,
      effortLevel: args.effortLevel,
      attachments: args.attachments,
      allowedDirs: args.allowedDirs,
    };
  }

  /// Lookups the runner exposes to BackendSpec implementations. Holds
  /// the per-conv state that specs occasionally need to weave into their
  /// args/envelope (Claude's MCP config path, Codex's transcript-replay
  /// for the no-resume exec path).
  private backendCtx(): BackendCtx {
    return {
      mcpConfigPathFor: (id) => this.claudeMcpByConv.get(id),
      codexExecTranscriptFor: (id) => this.codexExecTranscriptByConversation.get(id),
    };
  }

  /// Broker handler: a Claude-hosted MCP helper asked us for permission.
  /// Emit a PermissionRequest the renderer can show, and register a
  /// resolver in pendingPermissions so the user's Allow/Deny routes back
  /// through respondPermission → broker → helper → Claude.
  private handleClaudeApproval(req: ApprovalRequest): void {
    const active = this.procs.get(req.conversationId);
    if (!active) {
      this.claudeBroker.resolve(req.conversationId, req.requestId, {
        behavior: 'deny',
        message: 'no active overcli session',
      });
      return;
    }
    if (active.sessionAllowedTools.has(req.toolName)) {
      this.claudeBroker.resolve(req.conversationId, req.requestId, {
        behavior: 'allow',
        updatedInput: req.toolInput,
      });
      return;
    }
    active.pendingPermissions.set(req.requestId, (approved: boolean) => {
      this.claudeBroker.resolve(
        req.conversationId,
        req.requestId,
        approved
          ? { behavior: 'allow', updatedInput: req.toolInput }
          : { behavior: 'deny', message: 'denied by user' },
      );
    });
    const toolInputStr =
      typeof req.toolInput === 'string' ? req.toolInput : JSON.stringify(req.toolInput, null, 2);
    const requestedPath = extractRequestedPath(req.toolName, req.toolInput);
    const outsideAllowedDirs =
      !!requestedPath && !isInsideAllowedDirs(requestedPath, active.cwd, active.allowedDirs);
    this.emit({
      type: 'stream',
      conversationId: req.conversationId,
      events: [
        {
          id: randomUUID(),
          timestamp: Date.now(),
          raw: JSON.stringify({ toolName: req.toolName, toolInput: req.toolInput }),
          kind: {
            type: 'permissionRequest',
            info: {
              backend: 'claude',
              requestId: req.requestId,
              toolName: req.toolName,
              description: '',
              toolInput: toolInputStr,
              requestedPath: requestedPath ?? undefined,
              outsideAllowedDirs: outsideAllowedDirs || undefined,
            },
          },
          revision: 0,
        },
      ],
    });
  }

  /// Ensure the Claude subprocess we're about to spawn has a registered
  /// MCP permission broker session. Idempotent when the existing proc's
  /// launch parameters still match.
  private async prepareClaudeBroker(args: SendArgs): Promise<void> {
    if (args.backend !== 'claude') return;
    const convId = args.conversationId;
    const existing = this.procs.get(convId);
    const paramsMatch =
      !!existing &&
      existing.backend === 'claude' &&
      existing.launchPermissionMode === args.permissionMode &&
      existing.launchModel === args.model &&
      existing.cwd === args.cwd;
    if (paramsMatch && this.claudeMcpByConv.has(convId)) return;
    const helperScript = path.join(__dirname, 'claudePermissionHelper.js');
    const { configPath } = await this.claudeBroker.registerSession(
      convId,
      helperScript,
      process.execPath,
      { ELECTRON_RUN_AS_NODE: '1' },
    );
    this.claudeMcpByConv.set(convId, configPath);
  }

  /// Spawn (or reuse) a subprocess for this conversation, write the prompt
  /// onto its stdin in the backend's native envelope format, and return
  /// once the write completes. All events stream back async via `emit`.
  send(
    args: SendArgs,
    options: { suppressLocalUser?: boolean } = {},
  ): { ok: true } | { ok: false; error: string } {
    args = materializeNonImageAttachments(args);
    const convId = args.conversationId;
    // Switching backends mid-conversation tears down whatever runtime was
    // holding this conversation's state (subprocess or Ollama session).
    const existing = this.procs.get(convId);
    if (existing && existing.backend !== args.backend) {
      this.killProc(convId);
    }
    const existingOllama = this.ollamaSessions.get(convId);
    if (existingOllama && args.backend !== 'ollama') {
      this.killOllama(convId);
    }
    const existingGeminiAcp = this.geminiAcpSessions.get(convId);
    if (existingGeminiAcp && args.backend !== 'gemini') {
      this.killGeminiAcp(convId);
    }
    if (args.backend === 'ollama') {
      return this.sendOllama(args);
    }

    const userEventAlreadyEmitted = !!options.suppressLocalUser;

    // Prefer Gemini ACP when available. If a legacy Gemini subprocess is
    // already bound to this conversation (fallback path), keep using it
    // until the conversation is reset or switched away.
    if (args.backend === 'gemini' && !(existing && existing.backend === 'gemini') && this.geminiAcpSupported !== false) {
      if (!userEventAlreadyEmitted) {
        this.emitLocalUser(convId, args.prompt, args.attachments, args.localUserId);
      }
      void this.sendGeminiAcp(args, { syntheticFromCollab: false, userEventAlreadyEmitted: true });
      return { ok: true };
    }

    if (args.backend === 'claude') {
      // Claude needs an MCP permission-prompt server registered before the
      // subprocess starts so `--permission-prompt-tool` has something to
      // call. Do that async, then hand off to the standard subprocess path.
      this.claudeSendPending.add(args.conversationId);
      void (async () => {
        try {
          await this.prepareClaudeBroker(args);
        } catch (err) {
          this.claudeSendPending.delete(args.conversationId);
          this.emit({
            type: 'error',
            conversationId: args.conversationId,
            message: `Failed to set up Claude permission broker: ${(err as Error).message}`,
          });
          this.emit({ type: 'running', conversationId: args.conversationId, isRunning: false });
          return;
        }
        this.claudeSendPending.delete(args.conversationId);
        this.sendSubprocess(args, { syntheticFromCollab: false, userEventAlreadyEmitted });
      })();
      return { ok: true };
    }

    return this.sendSubprocess(args, { syntheticFromCollab: false, userEventAlreadyEmitted });
  }

  stop(conversationId: UUID): void {
    this.cancelGeminiAcp(conversationId);
    this.killProc(conversationId);
    this.killOllama(conversationId);
    // Also halt any rebounding reviewer in flight; otherwise a Stop click
    // during the "Rebounding…" phase doesn't actually stop the reviewer
    // subprocess, and a collab-mode reviewer would still queue a next
    // round when it finished after the user asked to stop.
    this.reviewer.stop(conversationId);
    this.emit({ type: 'running', conversationId, isRunning: false });
  }

  newConversation(conversationId: UUID): void {
    // Kill the underlying runtime so the next send starts a fresh session.
    this.killProc(conversationId);
    this.killOllama(conversationId);
    this.killGeminiAcp(conversationId);
    this.codexExecTranscriptByConversation.delete(conversationId);
  }

  respondPermission(
    conversationId: UUID,
    requestId: string,
    approved: boolean,
    addDir?: string,
    scope?: 'once' | 'always',
    toolName?: string,
  ): void {
    const gemini = this.geminiAcpSessions.get(conversationId);
    if (gemini) {
      const pending = gemini.pendingPermissions.get(requestId);
      if (!pending) return;
      pending.resolve(approved);
      gemini.pendingPermissions.delete(requestId);
      return;
    }

    const active = this.procs.get(conversationId);
    if (!active) return;
    // "Always allow" persists by appending to Claude Code's own allow list
    // in <cwd>/.claude/settings.json. Claude Code reads that on every spawn
    // and auto-allows matching tools without calling our permission-prompt-
    // tool, so the grant survives subprocess restarts and is shared across
    // every conversation rooted at the same project directory.
    if (approved && scope === 'always' && toolName) {
      active.sessionAllowedTools.add(toolName);
      try {
        appendClaudeAllowRule(active.cwd, toolName);
      } catch (err) {
        console.warn('[runner] failed to persist always-allow rule', err);
      }
    }
    const cb = active.pendingPermissions.get(requestId);
    if (cb) {
      cb(approved);
      active.pendingPermissions.delete(requestId);
    }
    // When the user granted a new session directory, Claude's directory
    // gate is checked at launch — not by the permission-prompt-tool — so
    // the current subprocess can't pick it up mid-run. Kill the proc and
    // auto-respawn with the updated --add-dir set, resuming the session
    // so the user doesn't have to re-send anything.
    if (approved && addDir && active.backend === 'claude') {
      const abs = path.resolve(addDir);
      if (!active.allowedDirs.includes(abs)) active.allowedDirs.push(abs);
      const stashed = active.lastSendArgs;
      const sessionId = active.sessionId;
      this.killProc(conversationId);
      this.emit({
        type: 'stream',
        conversationId,
        events: [
          {
            id: randomUUID(),
            timestamp: Date.now(),
            raw: '',
            kind: {
              type: 'systemNotice',
              text: `Added ${abs} to session. Resuming…`,
            },
            revision: 0,
          },
        ],
      });
      if (stashed) {
        // Re-launch with the widened allowlist. --resume picks up the
        // prior session so Claude sees the permission grant and can
        // retry the blocked tool call on its own. Attachments are
        // dropped — they were already delivered on the original turn;
        // re-sending would double them.
        const resumeArgs: SendArgs = {
          ...stashed,
          prompt: 'Continue with the newly granted directory access.',
          sessionId: sessionId ?? stashed.sessionId,
          allowedDirs: [...(stashed.allowedDirs ?? []), abs],
          attachments: undefined,
          localUserId: undefined,
        };
        this.send(resumeArgs, { suppressLocalUser: true });
      }
    }
  }

  respondCodexApproval(
    conversationId: UUID,
    callId: string,
    kind: 'exec' | 'patch',
    approved: boolean,
  ): void {
    const active = this.procs.get(conversationId);
    if (!active) return;
    const cb = active.pendingCodexApprovals.get(callId);
    if (cb) {
      cb(approved);
      active.pendingCodexApprovals.delete(callId);
    }
    // The pendingCodexApprovals callback (registered in
    // handleCodexAppServerRequest) already routed the JSON-RPC response
    // through the app-server client. Other codex modes (exec) don't have
    // an approval surface, so there's nothing more to do here.
  }

  respondUserInput(
    conversationId: UUID,
    requestId: string,
    answers: Record<string, UserInputAnswer>,
  ): void {
    const active = this.procs.get(conversationId);
    if (!active) return;
    const cb = active.pendingUserInputs.get(requestId);
    if (cb) {
      cb(answers);
      active.pendingUserInputs.delete(requestId);
    }
  }

  killAll(): void {
    for (const id of Array.from(this.procs.keys())) this.killProc(id);
    for (const id of Array.from(this.ollamaSessions.keys())) this.killOllama(id);
    for (const id of Array.from(this.geminiAcpSessions.keys())) this.killGeminiAcp(id);
    this.claudeBroker.shutdown();
  }

  // --- Internals ---

  private killProc(conversationId: UUID): void {
    const active = this.procs.get(conversationId);
    if (!active) return;
    if (active.codexMode === 'app-server' && active.codexAppServer) {
      active.codexAppServer.kill();
    } else if (active.proc) {
      try {
        active.proc.stdin.end();
      } catch {}
      try {
        active.proc.kill('SIGTERM');
      } catch {}
    }
    this.procs.delete(conversationId);
    if (active.backend === 'claude') {
      this.claudeBroker.unregisterSession(conversationId);
      this.claudeMcpByConv.delete(conversationId);
    }
    // Tear down any persistent reviewer too — the conversation's primary
    // is going away, so the warm reviewer thread has nothing left to
    // collab with.
    this.reviewer.dispose(conversationId);
  }

  private killOllama(conversationId: UUID): void {
    const s = this.ollamaSessions.get(conversationId);
    if (!s) return;
    s.inFlight?.abort();
    this.ollamaSessions.delete(conversationId);
    this.reviewer.dispose(conversationId);
  }

  private sendSubprocess(
    args: SendArgs,
    options: { syntheticFromCollab: boolean; userEventAlreadyEmitted: boolean },
  ): { ok: true } | { ok: false; error: string } {
    const convId = args.conversationId;
    if (!options.syntheticFromCollab && !options.userEventAlreadyEmitted) {
      this.emitLocalUser(convId, args.prompt, args.attachments, args.localUserId);
    }

    try {
      const existing = this.procs.get(convId);
      const paramsChanged =
        !!existing &&
        (existing.launchPermissionMode !== args.permissionMode ||
          existing.launchModel !== args.model ||
          existing.cwd !== args.cwd);
      // Codex app-server lets us override approvalPolicy/sandboxPolicy/model/cwd
      // per turn via turn/start params, so a permission-mode (or model/cwd) change
      // should NOT kill the thread — that would lose conversation history.
      // The runtime stamp on the active record is updated below so subsequent
      // change-detection compares against the latest values.
      const canHotSwap =
        !!existing &&
        existing.backend === 'codex' &&
        existing.codexMode === 'app-server';
      if (paramsChanged && !canHotSwap) {
        this.killProc(convId);
      }
      const active = this.procs.get(convId) ?? this.spawnFor(args);
      // App-server hot-swap: refresh the launch stamp so subsequent
      // sends compare against the latest params, and re-emit codexRuntimeMode
      // so the header shows the new sandbox/approval pair immediately.
      if (canHotSwap && paramsChanged) {
        active.launchPermissionMode = args.permissionMode;
        active.launchModel = args.model;
        const perms = codexTransportPermissions(args.permissionMode);
        this.emit({
          type: 'codexRuntimeMode',
          conversationId: convId,
          mode: 'app-server',
          sandbox: perms.sandbox,
          approval: perms.approval,
        });
      }
      active.currentUserPrompt = args.prompt;
      active.currentAssistantText = '';
      active.currentToolActivity = [];
      active.reviewBackend = (args.reviewBackend as Backend | null) ?? null;
      active.reviewMode = args.reviewMode ?? null;
      active.collabMaxTurns = args.collabMaxTurns ?? 3;
      active.reviewOllamaModel = args.reviewOllamaModel ?? null;
      active.reviewYolo = !!args.reviewYolo;
      active.cwd = args.cwd;
      active.lastSendArgs = args;
      // Per-backend turn-boundary reset. Specs that accumulate per-turn
      // state (codex's exec snapshot, gemini's coalesce buffer) drop it
      // here. Claude leaves resetForNewTurn undefined so its in-flight
      // tracking survives the boundary — important when the user fires
      // a follow-up while the previous response is still streaming;
      // wiping inFlightEventId mid-stream would orphan the trailing
      // chunks into a duplicate bubble. Claude's parser self-manages
      // via message_start / message_stop instead.
      getBackendSpec(args.backend).resetForNewTurn?.(active.parserState);
      if (!options.syntheticFromCollab) {
        active.collabBurst += 1;
        active.collabRoundsInBurst = 0;
      }
      this.emit({ type: 'running', conversationId: convId, isRunning: true, activityLabel: 'Thinking…' });
      if (args.backend === 'codex' && active.codexMode === 'app-server' && active.codexAppServer) {
        void this.sendCodexAppServerTurn(convId, active, args);
        return { ok: true };
      }
      const envelope = this.buildEnvelope(args, active);
      if (!active.proc) {
        throw new Error('subprocess transport is not available');
      }
      if (args.backend === 'gemini' || (args.backend === 'codex' && active.codexMode === 'exec')) {
        active.proc.stdin.end(envelope + '\n');
      } else {
        active.proc.stdin.write(envelope + '\n');
      }
      return { ok: true };
    } catch (err: any) {
      const message = err?.message ?? String(err);
      this.emit({ type: 'error', conversationId: convId, message });
      return { ok: false, error: message };
    }
  }

  private sendOllama(
    args: SendArgs,
    options: { syntheticFromCollab?: boolean } = {},
  ): { ok: true } | { ok: false; error: string } {
    const convId = args.conversationId;
    // The renderer resolves a pulled model tag before calling us (see
    // `pickInstalledOllamaModel`). The settings-level default is a last-
    // resort fallback — we deliberately don't hardcode a tag here,
    // because invented tags lead to runtime 404s on the pull list.
    const model = args.model || this.settingsProvider().backendDefaultModels.ollama;
    if (!model) {
      this.emit({
        type: 'error',
        conversationId: convId,
        message:
          'No Ollama model selected. Pick one in the conversation header, or pull one from Settings → Local models.',
      });
      return { ok: false, error: 'no ollama model selected' };
    }

    let session = this.ollamaSessions.get(convId);
    if (!session) {
      // Try to hydrate from the on-disk transcript if the renderer
      // recorded a sessionId last time. `args.sessionId` is persisted
      // onto the conversation via the `sessionConfigured` event we emit
      // on first turn, so after an app restart it comes back in here.
      const persisted = args.sessionId ? loadOllamaSession(args.sessionId) : null;
      session = {
        messages: persisted?.messages ?? [],
        messageTimestamps:
          persisted?.messageTimestamps && persisted.messageTimestamps.length === persisted.messages.length
            ? [...persisted.messageTimestamps]
            : evenlySpreadTimestamps(persisted?.updatedAt ?? Date.now(), persisted?.messages.length ?? 0),
        sessionId: persisted?.sessionId ?? args.sessionId ?? randomUUID(),
        lastModel: persisted?.lastModel ?? model,
        // If we loaded transcript from disk, the renderer already has the
        // events via `loadHistory` at conversation open — don't re-emit
        // the systemInit, it would duplicate the row in chat.
        initEmitted: !!persisted,
        collabBurst: 0,
        collabRoundsInBurst: 0,
      };
      this.ollamaSessions.set(convId, session);
    }
    // Human-originated sends start a fresh collab burst; synthetic
    // ping-pong re-entries reuse the current burst.
    if (!options.syntheticFromCollab) {
      session.collabBurst += 1;
      session.collabRoundsInBurst = 0;
    }

    // Push a local-user bubble into the UI up front, matching the
    // subprocess path. Attachments are dropped — vision-capable local
    // models would need a different message shape, not in scope here.
    // Collab synthetic prompts don't show as user bubbles. Human-originated
    // sends (with a renderer-assigned localUserId) already rendered the
    // bubble optimistically — skip to avoid double-rendering.
    if (!options.syntheticFromCollab && !args.localUserId) {
      const userEvent: StreamEvent = {
        id: randomUUID(),
        timestamp: Date.now(),
        raw: args.prompt,
        kind: { type: 'localUser', text: args.prompt, attachments: args.attachments },
        revision: 0,
      };
      this.emit({ type: 'stream', conversationId: convId, events: [userEvent] });
    }

    if (!session.initEmitted) {
      const initEvent = makeSystemInitEvent(model, args.cwd, session.sessionId);
      this.emit({ type: 'stream', conversationId: convId, events: [initEvent] });
      this.emit({
        type: 'sessionConfigured',
        conversationId: convId,
        sessionId: session.sessionId,
      });
      session.initEmitted = true;
    }

    session.lastModel = model;
    session.messages.push({ role: 'user', content: args.prompt });
    session.messageTimestamps.push(Date.now());

    const controller = new AbortController();
    session.inFlight?.abort();
    session.inFlight = controller;

    this.emit({ type: 'running', conversationId: convId, isRunning: true, activityLabel: 'Thinking…' });

    const tools = modelSupportsTools(model) ? OLLAMA_BUILTIN_TOOLS : undefined;
    // Qwen/Llama-coder models default to refusing file questions unless a
    // system message explicitly tells them tools are real. Prepended to
    // every tool-enabled call; not persisted to the transcript so cwd and
    // the tool list stay fresh if either changes mid-conversation.
    const toolSystemPrompt = tools ? buildOllamaToolSystemPrompt(args.cwd) : null;
    // Cap the tool-call ping-pong. Models occasionally get stuck re-calling
    // read_file on the same path; bailing out after 8 rounds surfaces the
    // bug instead of hanging the UI.
    const MAX_TOOL_ROUNDS = 8;

    const startedAt = Date.now();
    let finished = false;
    // Accumulated text from the FINAL (non-tool-calling) assistant reply.
    // Reviewer hook uses this; mid-turn text between tool calls is shown
    // but not fed to the reviewer (noise).
    let finalAssistantText = '';
    const finishWith = (opts?: { err?: string }) => {
      if (finished) return;
      finished = true;
      const events: StreamEvent[] = [];
      const result = makeResultEvent({
        durationMs: Date.now() - startedAt,
        error: opts?.err,
      });
      events.push(result);
      this.emit({ type: 'stream', conversationId: convId, events });
      const handsOffToReviewer = !opts?.err && !!finalAssistantText && !!args.reviewBackend;
      if (handsOffToReviewer) {
        this.emit({
          type: 'running',
          conversationId: convId,
          isRunning: true,
          activityLabel: 'Rebounding…',
        });
      } else {
        this.emit({ type: 'running', conversationId: convId, isRunning: false });
      }
      if (!opts?.err) {
        // Persist after the whole turn (including tool rounds) finishes.
        saveOllamaSession({
          sessionId: session!.sessionId,
          lastModel: session!.lastModel,
          messages: session!.messages,
          messageTimestamps: session!.messageTimestamps,
        });
      }
      if (session!.inFlight === controller) session!.inFlight = undefined;

      if (handsOffToReviewer) {
        void this.runOllamaReviewHook({
          convId,
          session: session!,
          userPrompt: args.prompt,
          assistantText: finalAssistantText,
          reviewBackend: args.reviewBackend as Backend,
          reviewMode: args.reviewMode ?? null,
          collabMaxTurns: args.collabMaxTurns ?? 3,
          reviewOllamaModel: args.reviewOllamaModel ?? null,
          reviewYolo: !!args.reviewYolo,
          cwd: args.cwd,
        });
      }
    };

    // Runs one streamChat call. Returns the collected tool calls (empty
    // if the model finished with plain text). Emits assistant tokens and
    // the final assistant event for this sub-turn.
    const runOneRound = async (): Promise<
      { ok: true; toolCalls: OllamaToolCall[]; text: string } | { ok: false; error: string }
    > => {
      let acc = '';
      let pendingToolCalls: OllamaToolCall[] = [];
      const assistantEventId = randomUUID();
      let assistantRevision = 0;
      let streamError: string | null = null;

      const wireMessages: OllamaChatMessage[] = toolSystemPrompt
        ? [{ role: 'system', content: toolSystemPrompt }, ...session!.messages]
        : session!.messages;
      await streamChat(
        { model, messages: wireMessages, tools, signal: controller.signal },
        (ev) => {
          if (ev.type === 'token') {
            acc += ev.text;
            assistantRevision += 1;
            this.emit({
              type: 'stream',
              conversationId: convId,
              events: [makeAssistantEvent(model, acc, assistantEventId, assistantRevision)],
            });
          } else if (ev.type === 'toolCalls') {
            pendingToolCalls = pendingToolCalls.concat(ev.calls);
          } else if (ev.type === 'done') {
            // If this round ends with tool_calls, finalize the assistant
            // bubble with the tool uses attached so the UI can render
            // them inline with the intermediate text.
            if (pendingToolCalls.length > 0) {
              assistantRevision += 1;
              this.emit({
                type: 'stream',
                conversationId: convId,
                events: [
                  makeAssistantEventWithTools(
                    model,
                    acc,
                    assistantEventId,
                    assistantRevision,
                    pendingToolCalls,
                  ),
                ],
              });
            }
          } else if (ev.type === 'error') {
            streamError = ollamaFriendlyError(ev.message);
          }
        },
      ).catch((err: any) => {
        streamError = err?.message ?? String(err);
      });

      if (streamError) return { ok: false, error: streamError };

      // Text-fallback parser. Some tool-capable models (notably smaller
      // Qwen/Llama coder variants, but occasionally the 14B+ too) emit
      // tool calls as JSON in the content channel instead of via Ollama's
      // structured `tool_calls`. When tools were sent but nothing came
      // back structurally, sniff the content. If we find a call, strip it
      // from the visible bubble so the user sees the cleaned-up reply.
      let finalText = acc;
      if (tools && pendingToolCalls.length === 0) {
        const extracted = extractInlineToolCalls(acc);
        if (extracted.calls.length > 0) {
          pendingToolCalls = extracted.calls;
          finalText = extracted.cleanedText;
          assistantRevision += 1;
          this.emit({
            type: 'stream',
            conversationId: convId,
            events: [
              makeAssistantEventWithTools(
                model,
                finalText,
                assistantEventId,
                assistantRevision,
                pendingToolCalls,
              ),
            ],
          });
        }
      }

      return { ok: true, toolCalls: pendingToolCalls, text: finalText };
    };

    const runLoop = async () => {
      for (let round = 0; round < MAX_TOOL_ROUNDS; round += 1) {
        const res = await runOneRound();
        if (!res.ok) {
          this.emit({
            type: 'stream',
            conversationId: convId,
            events: [makeErrorEvent(res.error)],
          });
          // Roll back the just-sent user message so the next retry
          // doesn't double-count it — matches prior behaviour.
          if (session!.messages[session!.messages.length - 1]?.role === 'user') {
            session!.messages.pop();
            session!.messageTimestamps.pop();
          }
          finishWith({ err: res.error });
          return;
        }

        if (res.toolCalls.length === 0) {
          // Clean finish: append the assistant reply to the transcript.
          if (res.text) {
            session!.messages.push({ role: 'assistant', content: res.text });
            session!.messageTimestamps.push(Date.now());
            finalAssistantText = res.text;
          }
          finishWith();
          return;
        }

        // Tool-call round — persist the assistant's partial reply (with
        // tool_calls attached so the transcript keeps the call/result
        // pairing Ollama expects on replay) and execute each call.
        session!.messages.push({
          role: 'assistant',
          content: res.text,
          tool_calls: res.toolCalls.map((c) => ({
            function: { name: c.name, arguments: c.arguments },
          })),
        });
        session!.messageTimestamps.push(Date.now());

        for (const call of res.toolCalls) {
          const result = executeOllamaTool({
            name: call.name,
            arguments: call.arguments,
            cwd: args.cwd,
          });
          // Surface the tool result in the UI the same way the Claude
          // parser does — as a toolResult event correlated by id.
          this.emit({
            type: 'stream',
            conversationId: convId,
            events: [
              makeToolResultEvent([
                { id: call.id, content: result.content, isError: result.isError },
              ]),
            ],
          });
          session!.messages.push({
            role: 'tool',
            content: result.content,
            tool_name: call.name,
          });
          session!.messageTimestamps.push(Date.now());
        }
      }

      // Hit the tool-round cap — the model is likely stuck. Bail with a
      // visible error rather than looping forever.
      const capMsg = `Reached tool-call limit (${MAX_TOOL_ROUNDS} rounds) without a final answer.`;
      this.emit({
        type: 'stream',
        conversationId: convId,
        events: [makeErrorEvent(capMsg)],
      });
      finishWith({ err: capMsg });
    };

    void runLoop();
    return { ok: true };
  }

  /// Reviewer hook for the Ollama primary. Fires the secondary CLI (or
  /// another Ollama model) against the just-completed turn and, in
  /// collab mode, feeds the reviewer's text back into the primary so
  /// the loop continues. Mirrors the subprocess path's maybeRunReviewer
  /// but operates on an OllamaSession instead of an ActiveProcess.
  private async runOllamaReviewHook(params: {
    convId: UUID;
    session: OllamaSession;
    userPrompt: string;
    assistantText: string;
    reviewBackend: Backend;
    reviewMode: 'review' | 'collab' | null;
    collabMaxTurns: number;
    reviewOllamaModel: string | null;
    reviewYolo: boolean;
    cwd: string;
  }): Promise<void> {
    const { convId, session, reviewBackend } = params;
    const settings = this.settingsProvider();
    const capturedBurst = session.collabBurst;
    const capturedRound = session.collabRoundsInBurst + 1;
    session.collabRoundsInBurst = capturedRound;
    let nextRoundQueued = false;
    try {

    const result = await this.reviewer.run({
      conversationId: convId,
      reviewBackend,
      reviewMode: params.reviewMode,
      cwd: params.cwd,
      summary: {
        primaryBackend: 'ollama',
        userPrompt: params.userPrompt,
        assistantText: params.assistantText,
        // Ollama doesn't emit tool_use events today, so tool activity is
        // empty. The reviewer prompt handles the empty case gracefully.
        toolActivity: '',
      },
      backendPathOverride: settings.backendPaths[reviewBackend],
      ollamaModel:
        reviewBackend === 'ollama'
          ? await this.resolveOllamaReviewerModel(params.reviewOllamaModel)
          : undefined,
      yolo: params.reviewYolo,
    });

    // Plain review: done after one round.
    if (params.reviewMode !== 'collab') return;
    // Stale burst — user sent a new message; abandon.
    if (session.collabBurst !== capturedBurst) return;
    // Reviewer errored or had nothing to say.
    if (result.error || !result.text.trim()) return;
    // Hit the round cap for this burst.
    if (capturedRound >= (params.collabMaxTurns || 3)) return;
    // Session torn down.
    if (this.ollamaSessions.get(convId) !== session) return;

    // Ping-pong: feed the reviewer's critique back to the primary as a
    // synthetic user turn. We re-enter sendOllama with the
    // `syntheticFromCollab` flag so it doesn't emit a user bubble and
    // doesn't bump the burst counter.
    const pingPrompt = [
      `The secondary reviewer (${reviewBackend}) had this take on your last turn:`,
      '',
      result.text,
      '',
      `Please respond — either incorporate their feedback or push back with reasoning.`,
    ].join('\n');

    this.emit({
      type: 'syntheticPrompt',
      conversationId: convId,
      hash: hashSyntheticPrompt(pingPrompt),
    });
    this.emit({
      type: 'running',
      conversationId: convId,
      isRunning: true,
      activityLabel: `Collab round ${capturedRound + 1}…`,
    });

    nextRoundQueued = true;
    this.sendOllama(
      {
        conversationId: convId,
        prompt: pingPrompt,
        backend: 'ollama',
        cwd: params.cwd,
        model: session.lastModel,
        permissionMode: 'default',
        reviewBackend,
        reviewMode: params.reviewMode,
        collabMaxTurns: params.collabMaxTurns,
        reviewOllamaModel: params.reviewOllamaModel,
        reviewYolo: params.reviewYolo,
      },
      { syntheticFromCollab: true },
    );
    } finally {
      if (!nextRoundQueued) {
        this.emit({ type: 'running', conversationId: convId, isRunning: false });
      }
    }
  }

  private async sendGeminiAcp(
    args: SendArgs,
    options: { syntheticFromCollab: boolean; userEventAlreadyEmitted: boolean },
  ): Promise<void> {
    const convId = args.conversationId;
    // If a prompt is still streaming, stash this turn and drain it when
    // the current one resolves. Without this guard, resetting session
    // state (currentAssistantText etc.) mid-stream would blank the bubble
    // and a second session/prompt would race the first.
    const inFlight = this.geminiAcpSessions.get(convId);
    if (inFlight?.promptInFlight) {
      if (!options.syntheticFromCollab && !options.userEventAlreadyEmitted) {
        this.emitLocalUser(convId, args.prompt, args.attachments, args.localUserId);
      }
      inFlight.queuedPrompt = {
        args,
        syntheticFromCollab: options.syntheticFromCollab,
      };
      return;
    }

    let session: GeminiAcpSession;
    try {
      session = await this.ensureGeminiAcpSession(args);
      this.geminiAcpSupported = true;
    } catch (err: any) {
      if (this.geminiAcpSupported !== true) {
        this.geminiAcpSupported = false;
        this.killGeminiAcp(convId);
        this.sendSubprocess(args, {
          syntheticFromCollab: options.syntheticFromCollab,
          userEventAlreadyEmitted: options.userEventAlreadyEmitted,
        });
        return;
      }
      const message = err?.message ?? String(err);
      this.emit({ type: 'error', conversationId: convId, message });
      this.emit({ type: 'running', conversationId: convId, isRunning: false });
      return;
    }

    if (!options.syntheticFromCollab && !options.userEventAlreadyEmitted) {
      this.emitLocalUser(convId, args.prompt, args.attachments, args.localUserId);
    }

    session.currentUserPrompt = args.prompt;
    session.currentAssistantText = '';
    session.currentThinkingText = '';
    session.currentToolUses = [];
    session.currentToolUseIndex.clear();
    session.currentToolActivity = [];
    session.currentAssistantEventId = undefined;
    session.currentAssistantNeedsSplit = false;
    session.reviewBackend = (args.reviewBackend as Backend | null) ?? null;
    session.reviewMode = args.reviewMode ?? null;
    session.collabMaxTurns = args.collabMaxTurns ?? 3;
    session.reviewOllamaModel = args.reviewOllamaModel ?? null;
    session.reviewYolo = !!args.reviewYolo;
    session.cwd = args.cwd;
    session.turnStartedAt = Date.now();
    if (!options.syntheticFromCollab) {
      session.collabBurst += 1;
      session.collabRoundsInBurst = 0;
    }

    this.emit({
      type: 'running',
      conversationId: convId,
      isRunning: true,
      activityLabel: 'Thinking…',
    });
    session.promptInFlight = true;

    try {
      const result = await session.client.request('session/prompt', {
        sessionId: session.sessionId,
        prompt: buildGeminiAcpPromptBlocks(args.prompt, args.attachments ?? []),
      });
      session.promptInFlight = false;
      const resultInfo = geminiAcpResultInfo(result, Date.now() - session.turnStartedAt);
      this.emit({
        type: 'stream',
        conversationId: convId,
        events: [
          {
            id: randomUUID(),
            timestamp: Date.now(),
            raw: JSON.stringify(result),
            kind: { type: 'result', info: resultInfo },
            revision: 0,
          },
        ],
      });
      const handsOffToReviewer = !resultInfo.isError && !!session.reviewBackend;
      if (handsOffToReviewer) {
        this.emit({
          type: 'running',
          conversationId: convId,
          isRunning: true,
          activityLabel: 'Rebounding…',
        });
      } else {
        this.emit({ type: 'running', conversationId: convId, isRunning: false });
      }
      void this.maybeRunGeminiAcpReviewer(convId, session, resultInfo.isError);
      this.drainGeminiAcpQueue(convId);
    } catch (err: any) {
      session.promptInFlight = false;
      const message = err?.message ?? String(err);
      this.emit({ type: 'error', conversationId: convId, message });
      this.emit({ type: 'running', conversationId: convId, isRunning: false });
      this.drainGeminiAcpQueue(convId);
    }
  }

  private drainGeminiAcpQueue(convId: UUID): void {
    const session = this.geminiAcpSessions.get(convId);
    if (!session) return;
    const queued = session.queuedPrompt;
    if (!queued) return;
    session.queuedPrompt = undefined;
    // The local user bubble was already emitted when the prompt queued, so
    // pass `userEventAlreadyEmitted: true` to avoid a duplicate.
    void this.sendGeminiAcp(queued.args, {
      syntheticFromCollab: queued.syntheticFromCollab,
      userEventAlreadyEmitted: true,
    });
  }

  private async ensureGeminiAcpSession(args: SendArgs): Promise<GeminiAcpSession> {
    const convId = args.conversationId;
    let session = this.geminiAcpSessions.get(convId);
    if (session && session.cwd !== args.cwd) {
      this.killGeminiAcp(convId);
      session = undefined;
    }
    if (!session) {
      const binary = this.resolveBinary('gemini');
      const env = this.buildEnv(binary);
      const next = {} as GeminiAcpSession;
      next.sessionId = undefined;
      next.initialized = false;
      next.promptInFlight = false;
      next.closing = false;
      next.stderrBuffer = '';
      next.currentModelId = '';
      next.currentModeId = '';
      next.currentAssistantEventId = undefined;
      next.currentAssistantText = '';
      next.currentThinkingText = '';
      next.currentToolUses = [];
      next.currentToolUseIndex = new Map();
      next.currentAssistantNeedsSplit = false;
      next.currentUserPrompt = '';
      next.currentToolActivity = [];
      next.reviewBackend = null;
      next.reviewMode = null;
      next.collabMaxTurns = 3;
      next.reviewOllamaModel = null;
      next.reviewYolo = false;
      next.collabBurst = 0;
      next.collabRoundsInBurst = 0;
      next.cwd = args.cwd;
      next.turnStartedAt = 0;
      next.pendingPermissions = new Map();
      next.client = new GeminiAcpClient({
        binary,
        cwd: args.cwd,
        env,
        onNotification: async (method, params) => this.handleGeminiAcpNotification(convId, method, params),
        onRequest: async (id, method, params) => this.handleGeminiAcpRequest(convId, id, method, params),
        onStderr: (chunk) => this.handleGeminiAcpStderr(convId, chunk),
        onClose: (code) => this.handleGeminiAcpClose(convId, code),
      });
      this.geminiAcpSessions.set(convId, next);
      session = next;
    }

    if (!session.initialized) {
      await session.client.request('initialize', {
        protocolVersion: 1,
        clientCapabilities: {
          auth: { terminal: false },
          fs: { readTextFile: false, writeTextFile: false },
          terminal: false,
        },
        clientInfo: { name: 'overcli', version: '0.1.0' },
      });

      const resumed = !!args.sessionId;
      const opened = resumed
        ? await session.client.request('session/resume', {
            sessionId: args.sessionId,
            cwd: args.cwd,
            mcpServers: [],
          })
        : await session.client.request('session/new', { cwd: args.cwd, mcpServers: [] });

      session.initialized = true;
      session.sessionId = resumed ? args.sessionId : opened.sessionId;
      session.currentModelId = opened.models?.currentModelId ?? args.model ?? 'gemini';
      session.currentModeId = opened.modes?.currentModeId ?? geminiAcpPermissionMode(args.permissionMode);
      await this.applyGeminiAcpSettings(session, args);

      this.emit({
        type: 'stream',
        conversationId: convId,
        events: [
          {
            id: randomUUID(),
            timestamp: Date.now(),
            raw: JSON.stringify(opened),
            kind: {
              type: 'systemInit',
              info: {
                sessionId: session.sessionId ?? '',
                model: session.currentModelId || args.model || 'gemini',
                cwd: args.cwd,
                apiKeySource: 'acp',
                tools: [],
                slashCommands: [],
                mcpServers: [],
              },
            },
            revision: 0,
          },
        ],
      });
      this.emit({
        type: 'sessionConfigured',
        conversationId: convId,
        sessionId: session.sessionId ?? '',
      });
    } else {
      await this.applyGeminiAcpSettings(session, args);
    }

    return session;
  }

  private async applyGeminiAcpSettings(session: GeminiAcpSession, args: SendArgs): Promise<void> {
    if (!session.sessionId) return;
    const desiredMode = geminiAcpPermissionMode(args.permissionMode);
    if (desiredMode && session.currentModeId !== desiredMode) {
      await session.client.request('session/set_mode', {
        sessionId: session.sessionId,
        modeId: desiredMode,
      });
      session.currentModeId = desiredMode;
    }
    const desiredModel = args.model?.trim();
    if (desiredModel && session.currentModelId !== desiredModel) {
      await session.client.request('session/set_model', {
        sessionId: session.sessionId,
        modelId: desiredModel,
      });
      session.currentModelId = desiredModel;
    }
  }

  private async handleGeminiAcpNotification(convId: UUID, method: string, params: any): Promise<void> {
    if (method !== 'session/update') return;
    const session = this.geminiAcpSessions.get(convId);
    if (!session) return;

    const update = params?.update;
    if (!update) return;
    const events: StreamEvent[] = [];

    switch (update.sessionUpdate) {
      case 'agent_message_chunk': {
        const text = geminiAcpTextContent(update.content);
        if (text) {
          session.currentAssistantText += text;
          events.push(this.geminiAcpAssistantSnapshot(session, update));
        }
        break;
      }
      case 'agent_thought_chunk': {
        const text = geminiAcpTextContent(update.content);
        if (text) {
          session.currentThinkingText += text;
          events.push(this.geminiAcpAssistantSnapshot(session, update));
        }
        break;
      }
      case 'tool_call': {
        const toolUse = geminiAcpToolUse(update);
        if (toolUse) {
          this.upsertGeminiAcpToolUse(session, toolUse);
          const line = summarizeToolUse(toolUse.name, toolUse.inputJSON, toolUse.filePath);
          if (line) session.currentToolActivity.push(line);
          events.push(this.geminiAcpAssistantSnapshot(session, update));
        }
        break;
      }
      case 'tool_call_update': {
        const toolUse = geminiAcpToolUse(update);
        if (toolUse) {
          this.upsertGeminiAcpToolUse(session, toolUse);
          events.push(this.geminiAcpAssistantSnapshot(session, update));
        }
        if (update.status === 'completed' || update.status === 'failed') {
          events.push({
            id: randomUUID(),
            timestamp: Date.now(),
            raw: JSON.stringify(update),
            kind: {
              type: 'toolResult',
              results: [
                {
                  id: update.toolCallId ?? randomUUID(),
                  content: geminiAcpToolResultText(update),
                  isError: update.status === 'failed',
                },
              ],
            },
            revision: 0,
          });
          session.currentAssistantNeedsSplit = true;
        }
        break;
      }
      case 'current_mode_update':
        session.currentModeId = update.currentModeId ?? session.currentModeId;
        break;
      default:
        break;
    }

    if (!events.length) return;
    this.emit({ type: 'stream', conversationId: convId, events });
    const last = events[events.length - 1];
    if (last.kind.type === 'assistant') {
      if (last.kind.info.toolUses.length > 0) {
        this.emit({ type: 'running', conversationId: convId, isRunning: true, activityLabel: 'Running tools…' });
      } else if (last.kind.info.text.trim() || last.kind.info.thinking.length > 0) {
        this.emit({ type: 'running', conversationId: convId, isRunning: true, activityLabel: 'Writing…' });
      }
    } else if (last.kind.type === 'toolResult') {
      this.emit({ type: 'running', conversationId: convId, isRunning: true, activityLabel: 'Reading tool output…' });
    }
  }

  private async handleGeminiAcpRequest(
    convId: UUID,
    id: string | number | null,
    method: string,
    params: any,
  ): Promise<any> {
    if (method !== 'session/request_permission') {
      throw new Error(`Unsupported ACP client request: ${method}`);
    }
    const session = this.geminiAcpSessions.get(convId);
    if (!session) throw new Error('Gemini ACP session missing');

    const toolUse = geminiAcpToolUse(params?.toolCall);
    const events: StreamEvent[] = [];
    if (toolUse) {
      this.upsertGeminiAcpToolUse(session, toolUse);
      const line = summarizeToolUse(toolUse.name, toolUse.inputJSON, toolUse.filePath);
      if (line) session.currentToolActivity.push(line);
      events.push(this.geminiAcpAssistantSnapshot(session, params?.toolCall));
    }

    const requestId = String(id);
    events.push({
      id: randomUUID(),
      timestamp: Date.now(),
      raw: JSON.stringify(params),
      kind: {
        type: 'permissionRequest',
        info: {
          backend: 'gemini',
          requestId,
          toolName: geminiAcpPermissionToolName(params?.toolCall),
          description: params?.toolCall?.title ?? '',
          toolInput: geminiAcpPermissionInput(params?.toolCall),
        },
      },
      revision: 0,
    });
    this.emit({ type: 'stream', conversationId: convId, events });

    return await new Promise((resolve) => {
      session.pendingPermissions.set(requestId, {
        requestId,
        toolCallId: params?.toolCall?.toolCallId ?? '',
        options: Array.isArray(params?.options) ? params.options : [],
        resolve: (approved: boolean) => {
          resolve({ outcome: geminiAcpPermissionOutcome(params?.options ?? [], approved) });
        },
      });
    });
  }

  private handleGeminiAcpStderr(convId: UUID, chunk: string): void {
    const session = this.geminiAcpSessions.get(convId);
    if (!session) return;
    session.stderrBuffer += chunk;
    if (session.stderrBuffer.length > 5000) {
      session.stderrBuffer = session.stderrBuffer.slice(-5000);
    }
  }

  private handleGeminiAcpClose(convId: UUID, code: number | null): void {
    const session = this.geminiAcpSessions.get(convId);
    if (!session) return;
    const closing = session.closing;
    const wasRunning = session.promptInFlight;
    const stderr = session.stderrBuffer.trim();
    this.geminiAcpSessions.delete(convId);
    if (!closing && wasRunning && code != null && code !== 0 && code !== 143) {
      this.emit({
        type: 'error',
        conversationId: convId,
        message: `gemini ACP exited with status ${code}. ${stderr ? `Recent stderr: ${stderr.slice(-500)}` : ''}`.trim(),
      });
      this.emit({ type: 'running', conversationId: convId, isRunning: false });
    }
  }

  private cancelGeminiAcp(conversationId: UUID): void {
    const session = this.geminiAcpSessions.get(conversationId);
    if (!session) return;
    session.queuedPrompt = undefined;
    if (!session.promptInFlight || !session.sessionId) return;
    void session.client.notify('session/cancel', { sessionId: session.sessionId });
  }

  private killGeminiAcp(conversationId: UUID): void {
    const session = this.geminiAcpSessions.get(conversationId);
    if (!session) return;
    session.queuedPrompt = undefined;
    session.closing = true;
    if (session.sessionId) {
      void session.client.request('session/close', { sessionId: session.sessionId }).catch(() => {});
    }
    session.client.close();
    this.geminiAcpSessions.delete(conversationId);
    this.reviewer.dispose(conversationId);
  }

  private geminiAcpAssistantSnapshot(session: GeminiAcpSession, raw: any): StreamEvent {
    if (session.currentAssistantNeedsSplit) {
      session.currentAssistantEventId = undefined;
      session.currentAssistantText = '';
      session.currentThinkingText = '';
      session.currentToolUses = [];
      session.currentToolUseIndex.clear();
      session.currentAssistantNeedsSplit = false;
    }
    if (!session.currentAssistantEventId) session.currentAssistantEventId = randomUUID();
    return {
      id: session.currentAssistantEventId,
      timestamp: Date.now(),
      raw: typeof raw === 'string' ? raw : JSON.stringify(raw),
      kind: {
        type: 'assistant',
        info: {
          model: session.currentModelId || 'gemini',
          text: session.currentAssistantText,
          toolUses: [...session.currentToolUses],
          thinking: session.currentThinkingText ? [session.currentThinkingText] : [],
        },
      },
      revision: 0,
    };
  }

  private upsertGeminiAcpToolUse(session: GeminiAcpSession, toolUse: ToolUseBlock): void {
    const idx = session.currentToolUseIndex.get(toolUse.id);
    if (idx == null) {
      session.currentToolUseIndex.set(toolUse.id, session.currentToolUses.length);
      session.currentToolUses.push(toolUse);
      return;
    }
    session.currentToolUses[idx] = toolUse;
  }

  private async maybeRunGeminiAcpReviewer(
    convId: UUID,
    session: GeminiAcpSession,
    resultIsError: boolean,
  ): Promise<void> {
    if (resultIsError) return;
    if (!session.reviewBackend) return;
    const settings = this.settingsProvider();
    const capturedBurst = session.collabBurst;
    const capturedRound = session.collabRoundsInBurst + 1;
    session.collabRoundsInBurst = capturedRound;
    let nextRoundQueued = false;
    try {

    const result = await this.reviewer.run({
      conversationId: convId,
      reviewBackend: session.reviewBackend,
      reviewMode: session.reviewMode,
      cwd: session.cwd,
      summary: {
        primaryBackend: 'gemini',
        userPrompt: session.currentUserPrompt,
        assistantText: session.currentAssistantText,
        toolActivity: session.currentToolActivity.join('\n'),
      },
      backendPathOverride: settings.backendPaths[session.reviewBackend],
      ollamaModel:
        session.reviewBackend === 'ollama'
          ? await this.resolveOllamaReviewerModel(session.reviewOllamaModel)
          : undefined,
      yolo: session.reviewYolo,
    });

    if (session.reviewMode !== 'collab') return;
    if (session.collabBurst !== capturedBurst) return;
    if (result.error || !result.text.trim()) return;
    if (capturedRound >= (session.collabMaxTurns || 3)) return;
    if (this.geminiAcpSessions.get(convId) !== session) return;

    nextRoundQueued = true;

    const pingPrompt = [
      `The secondary reviewer (${session.reviewBackend}) had this take on your last turn:`,
      '',
      result.text,
      '',
      `Please respond — either incorporate their feedback or push back with reasoning.`,
    ].join('\n');

    this.emit({
      type: 'syntheticPrompt',
      conversationId: convId,
      hash: hashSyntheticPrompt(pingPrompt),
    });
    this.emit({
      type: 'running',
      conversationId: convId,
      isRunning: true,
      activityLabel: `Collab round ${capturedRound + 1}…`,
    });

    await this.sendGeminiAcp(
      {
        conversationId: convId,
        prompt: pingPrompt,
        backend: 'gemini',
        cwd: session.cwd,
        model: session.currentModelId,
        permissionMode: 'default',
        sessionId: session.sessionId,
        reviewBackend: session.reviewBackend,
        reviewMode: session.reviewMode,
        collabMaxTurns: session.collabMaxTurns,
        reviewOllamaModel: session.reviewOllamaModel,
        reviewYolo: session.reviewYolo,
      },
      { syntheticFromCollab: true, userEventAlreadyEmitted: true },
    );
    } finally {
      if (!nextRoundQueued) {
        this.emit({ type: 'running', conversationId: convId, isRunning: false });
      }
    }
  }

  private spawnFor(args: SendArgs): ActiveProcess {
    const binary = this.resolveBinary(args.backend);
    const env = this.buildEnv(binary);
    const codexPerms = args.backend === 'codex' ? codexTransportPermissions(args.permissionMode) : null;
    const codexMode: 'exec' | 'app-server' | undefined =
      args.backend === 'codex' ? this.pickCodexMode(binary, env) : undefined;
    if (args.backend === 'codex' && codexMode === 'app-server' && codexPerms) {
      return this.spawnCodexAppServer(args, binary, env, codexPerms);
    }
    const spawnArgs = this.buildArgs(args, codexMode);
    const shell = backendNeedsShell(binary);
    const proc = spawn(binary, spawnArgs, {
      cwd: args.cwd,
      env,
      shell,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const active: ActiveProcess = {
      proc,
      backend: args.backend,
      sessionId: args.sessionId,
      launchModel: args.model,
      launchPermissionMode: args.permissionMode,
      stdoutBuffer: '',
      stderrBuffer: '',
      codexMode,
      pendingPermissions: new Map(),
      pendingCodexApprovals: new Map(),
      pendingUserInputs: new Map(),
      currentUserPrompt: args.prompt,
      currentAssistantText: '',
      currentToolActivity: [],
      reviewBackend: (args.reviewBackend as Backend | null) ?? null,
      reviewMode: args.reviewMode ?? null,
      collabMaxTurns: args.collabMaxTurns ?? 3,
      reviewOllamaModel: args.reviewOllamaModel ?? null,
      reviewYolo: !!args.reviewYolo,
      collabBurst: 0,
      collabRoundsInBurst: 0,
      cwd: args.cwd,
      allowedDirs: normalizeAllowedDirs(args.cwd, args.allowedDirs),
      sessionAllowedTools: new Set(),
      parserState: getBackendSpec(args.backend).makeParserState?.({ codexMode }),
    };
    this.procs.set(args.conversationId, active);
    if (args.backend === 'codex' && codexMode && codexPerms) {
      this.emit({
        type: 'codexRuntimeMode',
        conversationId: args.conversationId,
        mode: codexMode,
        sandbox: codexPerms.sandbox,
        approval: codexPerms.approval,
      });
    }

    proc.stdout.setEncoding('utf-8');
    proc.stdout.on('data', (chunk: string) => this.handleStdout(args.conversationId, active, chunk));
    proc.stderr.setEncoding('utf-8');
    proc.stderr.on('data', (chunk: string) => this.handleStderr(args.conversationId, active, chunk));
    proc.on('close', (code) => this.handleActiveClose(args.conversationId, active, code));
    return active;
  }


  private buildArgs(args: SendArgs, _codexMode?: 'proto' | 'exec' | 'app-server'): string[] {
    return getBackendSpec(args.backend).buildArgs(this.toBackendArgs(args), this.backendCtx());
  }

  private buildEnvelope(args: SendArgs, _active: ActiveProcess): string {
    return getBackendSpec(args.backend).buildEnvelope(this.toBackendArgs(args), this.backendCtx());
  }

  private handleStdout(convId: UUID, active: ActiveProcess, chunk: string): void {
    const spec = getBackendSpec(active.backend);
    if (!spec.parseChunk) return;
    const result = spec.parseChunk(chunk, active.parserState);
    const sessionConfigured = result.sessionConfigured;
    if (sessionConfigured?.sessionId && !active.sessionId) {
      active.sessionId = sessionConfigured.sessionId;
    }
    if (result.liveActivity) {
      // Codex exec emits a single growing assistant snapshot per chunk
      // with no end-of-turn marker on the stream itself; the runner
      // bumps the running pill so the user sees we're still alive.
      this.emit({
        type: 'running',
        conversationId: convId,
        isRunning: true,
        activityLabel: result.liveActivity,
      });
    }
    // A single stdout read can carry dozens of `stream_event` deltas for
    // the same in-flight message. Each delta produces an assistant
    // snapshot with the same id — only the last one has useful content.
    // Collapse intra-chunk duplicates so we ship one snapshot per id to
    // the renderer instead of forcing it to merge + re-render each one.
    const collapsed = collapsePartialAssistants(result.events);
    this.handleParsedEvents(convId, active, collapsed, sessionConfigured);
  }

  private handleParsedEvents(
    convId: UUID,
    active: ActiveProcess,
    emitted: StreamEvent[],
    sessionConfigured?: { sessionId: string; rolloutPath?: string },
  ): void {
    if (emitted.length) {
      let turnEnded = false;
      let nextActivity: string | undefined;
      for (const e of emitted) {
        if (e.kind.type === 'codexApproval') {
          active.pendingCodexApprovals.set(e.kind.info.callId, () => {});
        } else if (e.kind.type === 'result') {
          turnEnded = true;
        } else if (e.kind.type === 'assistant') {
          if (e.kind.info.text && e.kind.info.text.length > active.currentAssistantText.length) {
            active.currentAssistantText = e.kind.info.text;
          }
          // Skip reviewer-digest bookkeeping for streaming snapshots —
          // the final non-partial `assistant` event arrives with the
          // complete tool-use list and will log it once. Without this
          // guard a long response pushes hundreds of duplicate entries
          // into the reviewer summary.
          if (!e.kind.info.isPartial) {
            for (const t of e.kind.info.toolUses) {
              const line = summarizeToolUse(t.name, t.inputJSON, t.filePath);
              if (line) active.currentToolActivity.push(line);
            }
          }
          if (e.kind.info.toolUses.length > 0) nextActivity = 'Running tools…';
          else if (e.kind.info.text.length > 0 || e.kind.info.thinking.length > 0) nextActivity = 'Writing…';
        } else if (e.kind.type === 'toolResult' || e.kind.type === 'patchApply') {
          nextActivity = 'Reading tool output…';
        }
      }
      this.emit({ type: 'stream', conversationId: convId, events: emitted });

      // AskUserQuestion in headless mode: Claude Code resolves the tool
      // with an empty result and lets the model keep talking ("I'll wait
      // for your pick"), which is noise since the real answer arrives as
      // the next user turn. End the turn now so the UI shows only the
      // question card. Claude resumes naturally via --resume sessionId
      // when the user submits.
      const asksQuestion = emitted.some(
        (e) =>
          e.kind.type === 'assistant' &&
          e.kind.info.toolUses.some((t) => t.name === 'AskUserQuestion'),
      );

      if (turnEnded) {
        if (active.reviewBackend) {
          this.emit({
            type: 'running',
            conversationId: convId,
            isRunning: true,
            activityLabel: 'Rebounding…',
          });
        } else {
          this.emit({ type: 'running', conversationId: convId, isRunning: false });
        }
        void this.maybeRunReviewer(convId, active);
      } else if (asksQuestion && active.backend === 'claude') {
        this.killProc(convId);
        this.emit({ type: 'running', conversationId: convId, isRunning: false });
      } else if (nextActivity) {
        this.emit({
          type: 'running',
          conversationId: convId,
          isRunning: true,
          activityLabel: nextActivity,
        });
      }
    }
    if (sessionConfigured) {
      active.sessionId = sessionConfigured.sessionId;
      this.emit({
        type: 'sessionConfigured',
        conversationId: convId,
        sessionId: sessionConfigured.sessionId,
        rolloutPath: sessionConfigured.rolloutPath,
      });
    }
  }

  private handleActiveClose(conversationId: UUID, active: ActiveProcess, code: number | null): void {
    if (this.procs.get(conversationId) === active) {
      this.procs.delete(conversationId);
    }
    if (active.backend === 'claude') {
      this.claudeBroker.unregisterSession(conversationId);
      this.claudeMcpByConv.delete(conversationId);
    }
    // Skip the running:false emit only when a fresh Claude send is
    // mid-flight on this same conversation AND the closing proc was the
    // previous Claude turn. The flag is Claude-specific (codex/gemini
    // don't use it), so closes from other backends always emit normally.
    const skipRunningFalse =
      active.backend === 'claude' && this.claudeSendPending.has(conversationId);
    // Codex exec close fires the reviewer right below for code===0 — keep
    // the running indicator on (as "Rebounding…") so the sidebar doesn't
    // flicker idle between primary close and reviewer launch.
    const codexExecHandsOffToReviewer =
      active.backend === 'codex' &&
      active.codexMode === 'exec' &&
      code === 0 &&
      !!active.reviewBackend;
    if (!skipRunningFalse) {
      if (codexExecHandsOffToReviewer) {
        this.emit({
          type: 'running',
          conversationId,
          isRunning: true,
          activityLabel: 'Rebounding…',
        });
      } else {
        this.emit({
          type: 'running',
          conversationId,
          isRunning: false,
        });
      }
    }
    if (active.backend === 'codex' && active.codexMode === 'exec') {
      this.emit({
        type: 'stream',
        conversationId,
        events: [
          {
            id: randomUUID(),
            timestamp: Date.now(),
            raw: '',
            kind: {
              type: 'result',
              info: {
                subtype: code === 0 ? 'success' : 'error',
                isError: code !== 0,
                durationMs: 0,
                totalCostUSD: 0,
                modelUsage: {},
              },
            },
            revision: 0,
          } as StreamEvent,
        ],
      });
      if (code === 0) {
        const userText = active.currentUserPrompt.trim();
        const assistantText = codexExecSnapshotText(active.parserState).trim();
        if (userText && assistantText) {
          const transcript = this.codexExecTranscriptByConversation.get(conversationId) ?? [];
          transcript.push({ user: userText, assistant: assistantText });
          this.codexExecTranscriptByConversation.set(conversationId, transcript);
        }
        void this.maybeRunReviewer(conversationId, active);
      }
    }
    if (code != null && code !== 0 && code !== 143) {
      const tail = (active.stderrBuffer || active.stdoutBuffer || '').slice(-500);
      this.emit({
        type: 'error',
        conversationId,
        message:
          `${active.backend} exited with status ${code}. ` +
          (tail ? `Recent stderr: ${tail}` : 'Run the CLI manually for details.'),
      });
    }
  }

  private handleStderr(convId: UUID, active: ActiveProcess, chunk: string): void {
    active.stderrBuffer += chunk;
    // Keep only the last ~5KB so a chatty CLI doesn't bloat memory.
    if (active.stderrBuffer.length > 5000) {
      active.stderrBuffer = active.stderrBuffer.slice(-5000);
    }
    // Forward each complete line as a stderr stream event so the debug
    // viewer can show the raw output.
    const lines = active.stderrBuffer.split('\n');
    if (lines.length > 1) {
      const events: StreamEvent[] = lines.slice(0, -1).map((line) => ({
        id: randomUUID(),
        timestamp: Date.now(),
        raw: line,
        kind: { type: 'stderr', line } as StreamEventKind,
        revision: 0,
      }));
      this.emit({ type: 'stream', conversationId: convId, events });
      active.stderrBuffer = lines[lines.length - 1];
    }
  }

  private resolveBinary(backend: Backend): string {
    const settings = this.settingsProvider();
    const override = settings.backendPaths[backend];
    if (backend === 'codex' && !override) {
      const picked = this.pickCodexBinary();
      if (picked) return picked;
    }
    const resolved = resolveBackendPath(backend, override);
    if (resolved) return resolved;
    // Last resort: hope it's on PATH (which we extend via buildEnv).
    return backend;
  }

  /// codex 0.30+ ships an `app-server` transport that overcli prefers; older
  /// builds (e.g. homebrew 0.29) only have `exec`, which fails outside a
  /// trusted git repo. When multiple codex binaries are installed (common
  /// when `npm i -g @openai/codex` lands a fresh one alongside a stale
  /// homebrew install), PATH order alone can pick the older one. Walk
  /// every visible candidate and return the first that supports
  /// app-server; null falls back to the default first-match resolver.
  private pickCodexBinary(): string | null {
    const env = buildBackendEnv(process.env);
    for (const candidate of listBackendPathCandidates('codex', env)) {
      if (this.detectCodexCapabilities(candidate, env).hasAppServer) {
        return candidate;
      }
    }
    return null;
  }

  private detectCodexCapabilities(
    binary: string,
    env: NodeJS.ProcessEnv,
  ): { hasAppServer: boolean } {
    const cached = this.codexCapabilities.get(binary);
    if (cached) return cached;
    const shell = backendNeedsShell(binary);
    const help = spawnSync(binary, ['--help'], {
      encoding: 'utf-8',
      timeout: 3000,
      env,
      shell,
    });
    const helpText = `${help.stdout ?? ''}\n${help.stderr ?? ''}`;
    // app-server arrived in codex 0.30+ (still marked experimental). Older
    // binaries fall back to the `exec --json` one-shot path.
    const hasAppServer = /^\s*app-server\s+/m.test(helpText);
    const caps = { hasAppServer };
    this.codexCapabilities.set(binary, caps);
    return caps;
  }

  private pickCodexMode(
    binary: string,
    env: NodeJS.ProcessEnv,
  ): 'exec' | 'app-server' {
    return this.detectCodexCapabilities(binary, env).hasAppServer
      ? 'app-server'
      : 'exec';
  }

  private spawnCodexAppServer(
    args: SendArgs,
    binary: string,
    env: NodeJS.ProcessEnv,
    codexPerms: { sandbox: string; approval: string },
  ): ActiveProcess {
    const client = new CodexAppServerClient({
      binary,
      cwd: args.cwd,
      env,
      // Re-attach to the persisted codex thread if we have one. The
      // client tries thread/resume first and falls back to thread/start
      // on any failure (deleted thread, older codex, sandbox change).
      resumeId: args.sessionId,
    });
    const active: ActiveProcess = {
      proc: undefined,
      backend: args.backend,
      sessionId: args.sessionId,
      launchModel: args.model,
      launchPermissionMode: args.permissionMode,
      stdoutBuffer: '',
      stderrBuffer: '',
      codexAppServerState: makeCodexAppServerParserState(),
      codexAppServer: client,
      codexMode: 'app-server',
      pendingPermissions: new Map(),
      pendingCodexApprovals: new Map(),
      pendingUserInputs: new Map(),
      currentUserPrompt: args.prompt,
      currentAssistantText: '',
      currentToolActivity: [],
      reviewBackend: (args.reviewBackend as Backend | null) ?? null,
      reviewMode: args.reviewMode ?? null,
      collabMaxTurns: args.collabMaxTurns ?? 3,
      reviewOllamaModel: args.reviewOllamaModel ?? null,
      reviewYolo: !!args.reviewYolo,
      collabBurst: 0,
      collabRoundsInBurst: 0,
      cwd: args.cwd,
      allowedDirs: normalizeAllowedDirs(args.cwd, args.allowedDirs),
      sessionAllowedTools: new Set(),
      // app-server takes its own transport; parserState exists only for
      // the inline handleStdout path (which app-server never reaches).
      parserState: undefined,
    };
    this.procs.set(args.conversationId, active);
    this.emit({
      type: 'codexRuntimeMode',
      conversationId: args.conversationId,
      mode: 'app-server',
      sandbox: codexPerms.sandbox,
      approval: codexPerms.approval,
    });

    client.on('notification', ({ method, params, raw }) => {
      const result = parseCodexAppServerNotification(method, params, active.codexAppServerState!, raw);
      this.handleParsedEvents(args.conversationId, active, result.events, result.sessionConfigured);
    });
    client.on('request', ({ id, method }) => {
      void this.handleCodexAppServerRequest(args.conversationId, active, id, method);
    });
    client.on('stderr', (chunk) => this.handleStderr(args.conversationId, active, chunk));
    client.on('close', (code) => this.handleActiveClose(args.conversationId, active, code));
    return active;
  }

  private async sendCodexAppServerTurn(
    convId: UUID,
    active: ActiveProcess,
    args: SendArgs,
  ): Promise<void> {
    try {
      const transport = codexTransportPermissions(args.permissionMode);
      const result = await active.codexAppServer!.sendUserInput(args.prompt, {
        cwd: args.cwd,
        model: args.model,
        sandbox: transport.sandbox as CodexAppServerSandboxMode,
        approval: transport.approval as CodexAppServerApprovalPolicy,
        effortLevel: args.effortLevel,
        attachments: args.attachments,
        // For coordinator-style cwds (a folder of symlinks into each
        // member worktree) workspace-write would otherwise sandbox out
        // edits whose path resolved through a symlink.
        writableRoots: resolveSymlinkWritableRoots(args.cwd),
      });
      // Update on any threadId we don't already have. The fresh-conv
      // case (no prior sessionId) is the original trigger; the
      // resume-failed-fallback case (had a sessionId, but resume
      // failed and the client started a fresh thread with a NEW id)
      // also matches and overwrites the now-orphaned id so the
      // conversation re-pins to the live thread.
      if (result.threadId && result.threadId !== active.sessionId) {
        active.sessionId = result.threadId;
        this.emit({
          type: 'sessionConfigured',
          conversationId: convId,
          sessionId: result.threadId,
        });
      }
    } catch (err: any) {
      const message = err?.message ?? String(err);
      this.emit({ type: 'error', conversationId: convId, message });
      this.emit({ type: 'running', conversationId: convId, isRunning: false });
    }
  }

  private async handleCodexAppServerRequest(
    conversationId: UUID,
    active: ActiveProcess,
    id: string | number | null,
    method: string,
    params?: any,
  ): Promise<void> {
    const client = active.codexAppServer;
    if (!client) return;
    const translated = translateApprovalRequest(method, params);
    if (translated) {
      // Route the user's eventual decision through the JSON-RPC channel
      // with the right method-specific decision shape. The existing
      // pendingCodexApprovals/respondCodexApproval pipeline (used by proto)
      // is reused so the renderer surface is unchanged.
      active.pendingCodexApprovals.set(translated.callId, (approved: boolean) => {
        void client.respondToServerRequest(id, translated.buildResult(approved));
      });
      this.emit({ type: 'stream', conversationId, events: [translated.event] });
      return;
    }
    const userInput = translateUserInputRequest(method, params, id);
    if (userInput) {
      active.pendingUserInputs.set(userInput.requestId, (answers: Record<string, UserInputAnswer>) => {
        void client.respondToServerRequest(id, userInput.buildResult(answers));
      });
      this.emit({ type: 'stream', conversationId, events: [userInput.event] });
      this.emit({
        type: 'running',
        conversationId,
        isRunning: true,
        activityLabel: 'Waiting for your answer…',
      });
      return;
    }
    // Unknown request type — surface a notice and respond with a benign
    // default so the agent doesn't hang.
    this.emit({
      type: 'stream',
      conversationId,
      events: [
        {
          id: randomUUID(),
          timestamp: Date.now(),
          raw: method,
          kind: {
            type: 'systemNotice',
            text: `codex requested ${method} (auto-handled; not yet wired to UI)`,
          },
          revision: 0,
        },
      ],
    });
    switch (method) {
      case 'item/permissions/requestApproval':
        await client.respondToServerRequest(id, { permissions: {}, scope: 'turn' });
        return;
      default:
        await client.rejectServerRequest(id, `Unhandled server request: ${method}`);
    }
  }

  /// Pick a model tag for the Ollama reviewer. Priority: per-conversation
  /// override (set in the rebound picker) → app-wide Ollama default →
  /// first pulled model. The last fallback means the review doesn't fail
  /// just because the user never set a default and only has one model.
  private async resolveOllamaReviewerModel(
    override?: string | null,
  ): Promise<string | undefined> {
    const picked = override?.trim();
    if (picked) return picked;
    const configured = this.settingsProvider().backendDefaultModels.ollama?.trim();
    if (configured) return configured;
    try {
      const det = await detectOllama();
      return det.models[0]?.name;
    } catch {
      return undefined;
    }
  }

  /// Fires the reviewer ("rebound") for the just-completed turn if the
  /// conversation has one configured. One-shot per turn — we don't hold
  /// a persistent reviewer subprocess. In collab mode, the reviewer's
  /// response is then fed back to the primary as a synthetic user turn,
  /// and the cycle repeats up to `collabMaxTurns` rounds per burst.
  private async maybeRunReviewer(convId: UUID, active: ActiveProcess): Promise<void> {
    if (!active.reviewBackend) return;
    const settings = this.settingsProvider();
    const capturedBurst = active.collabBurst;
    const capturedRound = active.collabRoundsInBurst + 1;
    active.collabRoundsInBurst = capturedRound;
    // Track whether we kicked off another collab round. If we don't,
    // the conversation has truly settled and the running indicator
    // (which we left on as "Rebounding…" at turn end) needs to flip
    // back to false so the sidebar doesn't read as perpetually busy.
    let nextRoundQueued = false;
    try {

    const result = await this.reviewer.run({
      conversationId: convId,
      reviewBackend: active.reviewBackend,
      reviewMode: active.reviewMode,
      cwd: active.cwd,
      summary: {
        primaryBackend: active.backend,
        userPrompt: active.currentUserPrompt,
        assistantText: active.currentAssistantText,
        toolActivity: active.currentToolActivity.join('\n'),
      },
      backendPathOverride: settings.backendPaths[active.reviewBackend],
      // Ollama reviewer needs a model tag — it doesn't infer one from
      // auth like Claude/Codex do. Prefer the configured default; fall
      // back to the first pulled model so an unset default doesn't hard-
      // fail the review.
      ollamaModel:
        active.reviewBackend === 'ollama'
          ? await this.resolveOllamaReviewerModel(active.reviewOllamaModel)
          : undefined,
      yolo: active.reviewYolo,
    });

    // Collab mode: feed the reviewer's text back to the primary as a
    // synthetic user turn, which starts another primary→reviewer cycle.
    // We stop if:
    //   - mode is plain review (not collab)
    //   - the user sent a new message during the review (burst changed)
    //   - the reviewer errored or produced no usable text
    //   - we've hit the per-burst rounds cap
    //   - the primary subprocess has died
    if (active.reviewMode !== 'collab') return;
    if (active.collabBurst !== capturedBurst) return;
    if (result.error || !result.text.trim()) return;
    if (capturedRound >= (active.collabMaxTurns || 3)) return;
    if (!this.procs.get(convId) || this.procs.get(convId) !== active) return;

    nextRoundQueued = true;

    // Build a ping-pong prompt. Make it clear to the primary who is
    // speaking so the loop reads coherently in the chat.
    const pingPrompt = [
      `The secondary reviewer (${active.reviewBackend}) had this take on your last turn:`,
      '',
      result.text,
      '',
      `Please respond — either incorporate their feedback or push back with reasoning.`,
    ].join('\n');

    this.emit({
      type: 'syntheticPrompt',
      conversationId: convId,
      hash: hashSyntheticPrompt(pingPrompt),
    });

    try {
      if (active.backend === 'gemini') {
        this.killProc(convId);
        this.sendSubprocess(
          {
            conversationId: convId,
            prompt: pingPrompt,
            backend: 'gemini',
            cwd: active.cwd,
            model: '',
            permissionMode: 'default',
            sessionId: active.sessionId,
            reviewBackend: active.reviewBackend,
            reviewMode: active.reviewMode,
            collabMaxTurns: active.collabMaxTurns,
            reviewOllamaModel: active.reviewOllamaModel,
            reviewYolo: active.reviewYolo,
          },
          { syntheticFromCollab: true, userEventAlreadyEmitted: true },
        );
        return;
      }
      // Reuse the existing primary subprocess via the envelope path —
      // same format user sends take, just without emitting a
      // localUser event to the chat (collab synthetic prompts
      // shouldn't appear as user bubbles).
      active.currentUserPrompt = pingPrompt;
      active.currentAssistantText = '';
      active.currentToolActivity = [];
      this.emit({
        type: 'running',
        conversationId: convId,
        isRunning: true,
        activityLabel: `Collab round ${capturedRound + 1}…`,
      });
      if (active.codexMode === 'app-server' && active.codexAppServer) {
        void this.sendCodexAppServerTurn(
          convId,
          active,
          {
            conversationId: convId,
            prompt: pingPrompt,
            backend: active.backend,
            cwd: active.cwd,
            model: active.launchModel,
            permissionMode: active.launchPermissionMode,
          },
        );
        return;
      }
      const envelope = this.buildEnvelope(
        {
          conversationId: convId,
          prompt: pingPrompt,
          backend: active.backend,
          cwd: active.cwd,
          model: '',
          permissionMode: 'default',
        },
        active,
      );
      if (!active.proc) return;
      active.proc.stdin.write(envelope + '\n');
    } catch {
      // If stdin died, skip silently; the session already reported the
      // failure via the process close handler.
    }
    } finally {
      if (!nextRoundQueued) {
        this.emit({ type: 'running', conversationId: convId, isRunning: false });
      }
    }
  }

  private buildEnv(binary: string): NodeJS.ProcessEnv {
    return buildBackendEnv(process.env, binary);
  }

  private emitLocalUser(
    conversationId: UUID,
    prompt: string,
    attachments?: Attachment[],
    id?: string,
  ): void {
    // When the renderer assigned an id up front, it already pushed the
    // user bubble into the UI optimistically with the *display* prompt —
    // no need to re-emit. This avoids a race where main's emission carries
    // a different payload (e.g. a fork preamble the renderer intentionally
    // excluded from the on-screen bubble) and clobbers the local version.
    if (id) return;
    this.emit({
      type: 'stream',
      conversationId,
      events: [
        {
          id: randomUUID(),
          timestamp: Date.now(),
          raw: prompt,
          kind: { type: 'localUser', text: prompt, attachments },
          revision: 0,
        },
      ],
    });
  }

  killAllReviewers(): void {
    this.reviewer.stopAll();
  }

}

/// Non-image attachments (CSV / text / JSON / logs / …) can't ride the
/// per-backend image content blocks, so we land them on disk in the same
/// `~/.overcli/attachments` dir the codex app-server already uses for
/// images and inline a `[Attached file: <path>]` line at the head of the
/// prompt. The agent then reads the file with whichever native filesystem
/// tool its CLI exposes — uniform across Claude / Codex / Gemini / Ollama.
/// Image attachments pass through unchanged so the existing typed-block
/// envelopes keep working.
function materializeNonImageAttachments(args: SendArgs): SendArgs {
  const attachments = args.attachments ?? [];
  if (attachments.length === 0) return args;
  const imageOnly: Attachment[] = [];
  const refs: string[] = [];
  for (const a of attachments) {
    if (a.mimeType.startsWith('image/')) {
      imageOnly.push(a);
      continue;
    }
    try {
      const filePath = writeAttachmentFile(a);
      const label = a.label ? ` (${a.label})` : '';
      refs.push(`[Attached file: ${filePath}${label}]`);
    } catch (err) {
      refs.push(
        `[Attachment ${a.label ?? a.id} couldn't be saved: ${(err as Error).message}]`,
      );
    }
  }
  if (refs.length === 0) return args;
  const header = refs.join('\n');
  const prompt = args.prompt ? `${header}\n\n${args.prompt}` : header;
  return { ...args, prompt, attachments: imageOnly.length > 0 ? imageOnly : undefined };
}

function writeAttachmentFile(a: Attachment): string {
  const dir = path.join(os.homedir(), '.overcli', 'attachments');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const ext = attachmentExtension(a);
  const base = a.id || randomUUID();
  const file = path.join(dir, `${base}${ext}`);
  fs.writeFileSync(file, Buffer.from(a.dataBase64, 'base64'), { mode: 0o600 });
  return file;
}

function attachmentExtension(a: Attachment): string {
  if (a.label) {
    const dot = a.label.lastIndexOf('.');
    if (dot > 0 && dot < a.label.length - 1) {
      const ext = a.label.slice(dot).toLowerCase();
      if (/^\.[a-z0-9]{1,8}$/.test(ext)) return ext;
    }
  }
  switch (a.mimeType) {
    case 'text/plain':
      return '.txt';
    case 'text/csv':
      return '.csv';
    case 'text/markdown':
      return '.md';
    case 'application/json':
      return '.json';
    case 'text/yaml':
    case 'application/x-yaml':
      return '.yaml';
    case 'application/xml':
    case 'text/xml':
      return '.xml';
    case 'application/pdf':
      return '.pdf';
    case 'application/msword':
      return '.doc';
    case 'application/vnd.openxmlformats-officedocument.wordprocessingml.document':
      return '.docx';
    case 'application/vnd.ms-excel':
      return '.xls';
    case 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet':
      return '.xlsx';
    case 'application/vnd.ms-powerpoint':
      return '.ppt';
    case 'application/vnd.openxmlformats-officedocument.presentationml.presentation':
      return '.pptx';
    case 'application/vnd.oasis.opendocument.text':
      return '.odt';
    case 'application/vnd.oasis.opendocument.spreadsheet':
      return '.ods';
    case 'application/vnd.oasis.opendocument.presentation':
      return '.odp';
    case 'application/rtf':
      return '.rtf';
    default:
      return '.bin';
  }
}

function buildGeminiAcpPromptBlocks(prompt: string, attachments: Attachment[]): any[] {
  const blocks: any[] = attachments
    .filter((a) => a.mimeType.startsWith('image/'))
    .map((a) => ({
      type: 'image',
      data: a.dataBase64,
      mimeType: a.mimeType,
    }));
  if (prompt) blocks.push({ type: 'text', text: prompt });
  if (blocks.length === 0) blocks.push({ type: 'text', text: '(no text)' });
  return blocks;
}

function geminiAcpPermissionMode(mode: PermissionMode): string {
  switch (mode) {
    case 'plan':
      return 'plan';
    case 'acceptEdits':
      return 'autoEdit';
    case 'bypassPermissions':
      return 'yolo';
    // `auto` is Claude-only; gemini ACP has no equivalent classifier mode.
    case 'auto':
    case 'default':
    default:
      return 'default';
  }
}

function geminiAcpTextContent(content: any): string {
  if (!content) return '';
  if (content.type === 'text' && typeof content.text === 'string') return content.text;
  if (content.type === 'content') return geminiAcpTextContent(content.content);
  return '';
}

function geminiAcpToolUse(update: any): ToolUseBlock | null {
  if (!update?.toolCallId) return null;
  const diff = Array.isArray(update.content) ? update.content.find((c: any) => c?.type === 'diff') : null;
  const content = Array.isArray(update.content) ? update.content.find((c: any) => c?.type === 'content') : null;
  const locationPath = Array.isArray(update.locations) ? update.locations[0]?.path : undefined;
  const filePath = diff?.path ?? locationPath;
  const name = geminiAcpToolName(update, diff, content);
  const input = geminiAcpToolInput(name, update, diff, content, filePath);
  return {
    id: update.toolCallId,
    name,
    inputJSON: JSON.stringify(input),
    filePath,
    oldString: typeof diff?.oldText === 'string' ? diff.oldText : undefined,
    newString: typeof diff?.newText === 'string' ? diff.newText : undefined,
  };
}

function geminiAcpToolName(update: any, diff: any, content: any): string {
  if (update?.kind === 'read') return 'Read';
  if (update?.kind === 'execute') return 'Bash';
  if (update?.kind === 'edit') {
    if (diff && typeof diff.oldText === 'string' && diff.oldText.length === 0) return 'Write';
    return 'Edit';
  }
  if (update?.kind === 'search') return 'Read';
  if (content && geminiAcpTextContent(content)) return update?.title ?? 'tool';
  return update?.title ?? 'tool';
}

function geminiAcpToolInput(
  name: string,
  update: any,
  diff: any,
  content: any,
  filePath?: string,
): Record<string, any> {
  if (name === 'Read') return { file_path: filePath ?? update?.title ?? '' };
  if (name === 'Bash') return { command: update?.title ?? '' };
  if (name === 'Write') return { file_path: filePath ?? '', content: diff?.newText ?? '' };
  if (name === 'Edit') {
    return {
      file_path: filePath ?? '',
      old_string: diff?.oldText ?? '',
      new_string: diff?.newText ?? '',
    };
  }
  return {
    title: update?.title ?? '',
    kind: update?.kind ?? 'other',
    file_path: filePath,
    content: content ? geminiAcpTextContent(content) : undefined,
  };
}

function geminiAcpToolResultText(update: any): string {
  if (!Array.isArray(update?.content)) return '';
  const text = update.content.map((c: any) => geminiAcpTextContent(c)).filter(Boolean).join('\n');
  if (text) return text;
  const diff = update.content.find((c: any) => c?.type === 'diff');
  if (diff?.path) return diff.path;
  return '';
}

function geminiAcpPermissionToolName(toolCall: any): string {
  return geminiAcpToolName(toolCall, Array.isArray(toolCall?.content) ? toolCall.content.find((c: any) => c?.type === 'diff') : null, null);
}

function geminiAcpPermissionInput(toolCall: any): string {
  const toolUse = geminiAcpToolUse(toolCall);
  return toolUse?.inputJSON ?? '';
}

function geminiAcpPermissionOutcome(
  options: Array<{ optionId: string; kind: string }>,
  approved: boolean,
): Record<string, any> {
  if (approved) {
    const allow = options.find((o) => o.kind === 'allow_once') ?? options.find((o) => o.kind === 'allow_always');
    if (allow) return { outcome: 'selected', optionId: allow.optionId };
  } else {
    const deny = options.find((o) => o.kind === 'reject_once') ?? options.find((o) => o.kind === 'reject_always');
    if (deny) return { outcome: 'selected', optionId: deny.optionId };
    return { outcome: 'cancelled' };
  }
  return { outcome: 'cancelled' };
}

function geminiAcpResultInfo(result: any, durationMs: number) {
  const quota = result?._meta?.quota;
  const modelUsage: Record<string, any> = {};
  const modelEntries = Array.isArray(quota?.model_usage) ? quota.model_usage : [];
  for (const entry of modelEntries) {
    const tokens = entry?.token_count ?? {};
    modelUsage[entry?.model ?? 'gemini'] = {
      inputTokens: tokens.input_tokens ?? 0,
      outputTokens: tokens.output_tokens ?? 0,
      cacheReadInputTokens: tokens.cached_tokens ?? 0,
      cacheCreationInputTokens: 0,
    };
  }
  const stopReason = result?.stopReason ?? '';
  return {
    subtype: stopReason,
    isError: stopReason === 'cancelled',
    durationMs,
    totalCostUSD: 0,
    modelUsage,
  };
}

/// Backfills per-message timestamps for legacy persisted sessions that
/// were saved before we tracked them individually. Spreads N points
/// ending at `end` across one second apart each, so replay order is
/// stable even if the real timing is lost.
function evenlySpreadTimestamps(end: number, count: number): number[] {
  if (count <= 0) return [];
  const out: number[] = [];
  for (let i = 0; i < count; i++) {
    out.push(end - (count - 1 - i) * 1000);
  }
  return out;
}

/// True iff `tag` is in the curated catalog AND its family is trained on
/// the Ollama tool-calling protocol. Unknown/custom tags get `false` —
/// passing `tools` to a model that wasn't trained for them typically
/// produces garbage or outright JSON-mode refusals.
function modelSupportsTools(tag: string): boolean {
  const hit = OLLAMA_CATALOG.find((m) => m.tag === tag);
  return !!hit?.supportsTools;
}

/// System prompt prepended on every tool-enabled Ollama call. Qwen-coder
/// and (less often) Llama variants default to "I can't access your
/// files" refusals unless told outright that the tools are real. The
/// phrasing is deliberately blunt: these models respond to explicit
/// "do X, not Y" instructions much better than to polite hints.
function buildOllamaToolSystemPrompt(cwd: string): string {
  return [
    'You are a local coding assistant running inside overcli on the user\'s machine.',
    `You have real, working access to the user's project directory at: ${cwd}`,
    '',
    'The following tools are available and will return real results from disk:',
    '- read_file(path): read a text file relative to the project root.',
    '- list_dir(path): list files and subdirectories; use "." for the project root.',
    '- grep(pattern, path?, caseInsensitive?): regex-search across the project.',
    '',
    'When the user asks to read a file, list a directory, search the code, or otherwise inspect the project — CALL THE TOOL. Do not reply that you cannot access files. Do not refuse. The tools work.',
    '',
    'Call tools through your native tool-calling channel. Do not emit JSON tool-call blobs as plain text.',
    'After receiving tool results, answer the user\'s question concisely using what you learned.',
  ].join('\n');
}

function ollamaFriendlyError(raw: string): string {
  const lower = raw.toLowerCase();
  if (lower.includes('econnrefused') || lower.includes('connect enoent')) {
    return 'Ollama server isn\'t running. Open the Local tab and click Start server, then try again.';
  }
  if (lower.includes('model') && (lower.includes('not found') || lower.includes('does not exist'))) {
    return `${raw} — pull it from the Local tab first.`;
  }
  return raw;
}

/// Write a base64 attachment to a temp file that codex proto can read by
/// path. Stored under `~/.overcli/attachments/<uuid>.<ext>` so the file
/// sticks around for the lifetime of the codex subprocess (which may read
/// it asynchronously); cleanup happens at app quit since temp files are
/// cheap and leaving them means reopened sessions can re-reference the
/// same path if needed.
function writeAttachmentToTemp(a: Attachment): string {
  const dir = path.join(os.homedir(), '.overcli', 'attachments');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const ext = mimeToExt(a.mimeType);
  const file = path.join(dir, `${a.id || randomUUID()}${ext}`);
  fs.writeFileSync(file, Buffer.from(a.dataBase64, 'base64'), { mode: 0o600 });
  return file;
}

function mimeToExt(mime: string): string {
  switch (mime) {
    case 'image/png':
      return '.png';
    case 'image/jpeg':
    case 'image/jpg':
      return '.jpg';
    case 'image/gif':
      return '.gif';
    case 'image/webp':
      return '.webp';
    default:
      return '.bin';
  }
}
