// Per-conversation subprocess manager. Holds one long-lived `claude` or
// `codex proto` process per conversation. Parses line-delimited JSON off
// stdout, emits typed StreamEvents to the renderer via the `mainEmitter`
// supplied at construction, and buffers a writer handle on stdin so we can
// feed new user turns without respawning.

import { spawn, spawnSync, ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
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
} from '../shared/types';
import { parseClaudeLine } from './parsers/claude';
import { parseCodexProtoLine, makeCodexParserState, CodexParserState } from './parsers/codex';
import {
  makeAssistantEvent,
  makeAssistantEventWithTools,
  makeErrorEvent,
  makeResultEvent,
  makeSystemInitEvent,
  makeToolResultEvent,
} from './parsers/ollama';
import { backendNeedsShell, buildBackendEnv, resolveBackendPath } from './backendPaths';
import {
  OLLAMA_CATALOG,
  OllamaChatMessage,
  OllamaToolCall,
  detectOllama,
  streamChat,
} from './ollama';
import { OLLAMA_BUILTIN_TOOLS, executeOllamaTool } from './ollamaTools';
import { loadOllamaSession, saveOllamaSession } from './ollamaStore';
import { ReviewerManager } from './reviewer';
import { GeminiAcpClient } from './geminiAcp';

type Emit = (event: MainToRendererEvent) => void;

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
}

interface PermissionResponse {
  requestId: string;
  approved: boolean;
}

interface ActiveProcess {
  proc: ChildProcessWithoutNullStreams;
  backend: Backend;
  sessionId?: string;
  launchModel: string;
  launchPermissionMode: PermissionMode;
  stdoutBuffer: string;
  stderrBuffer: string;
  codexState?: CodexParserState;
  codexMode?: 'proto' | 'exec';
  codexExecEventId?: string;
  codexExecRevision: number;
  /// Codex proto: maps our internal request id onto the proto `id` field
  /// so resuming codex exec responses route back to the live subprocess.
  lastCodexMsgId: number;
  /// Pending permission/approval handlers indexed by requestId / callId.
  /// We look them up on response so the renderer's allow/deny decisions
  /// reach the live subprocess.
  pendingPermissions: Map<string, (approved: boolean) => void>;
  pendingCodexApprovals: Map<string, (approved: boolean) => void>;
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
  /// Bumps on each human-originated send so collab loops that kick off
  /// on a stale burst don't keep ping-ponging after the user has moved
  /// on. Reviewer completion compares this to its captured snapshot.
  collabBurst: number;
  /// Number of collab rounds fired in the current burst. Ping-pong
  /// stops when this hits `collabMaxTurns`.
  collabRoundsInBurst: number;
  cwd: string;
  /// Gemini headless mode is one-shot per turn, but it still streams
  /// assistant deltas + tool calls we want to fold into one live bubble.
  geminiAssistantEventId?: string;
  geminiAssistantText: string;
  geminiAssistantToolUses: ToolUseBlock[];
  geminiAssistantNeedsSplit: boolean;
}

interface GeminiAcpSession {
  client: GeminiAcpClient;
  sessionId?: string;
  initialized: boolean;
  promptInFlight: boolean;
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
  private codexProtoSupport = new Map<string, boolean>();
  private codexExecNoticeByConversation = new Set<UUID>();

  constructor(emit: Emit, settingsProvider: () => AppSettings) {
    this.emit = emit;
    this.settingsProvider = settingsProvider;
    this.reviewer = new ReviewerManager(emit);
  }

  /// Spawn (or reuse) a subprocess for this conversation, write the prompt
  /// onto its stdin in the backend's native envelope format, and return
  /// once the write completes. All events stream back async via `emit`.
  send(args: SendArgs): { ok: true } | { ok: false; error: string } {
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

    // Prefer Gemini ACP when available. If a legacy Gemini subprocess is
    // already bound to this conversation (fallback path), keep using it
    // until the conversation is reset or switched away.
    if (args.backend === 'gemini' && !(existing && existing.backend === 'gemini') && this.geminiAcpSupported !== false) {
      this.emitLocalUser(convId, args.prompt, args.attachments);
      void this.sendGeminiAcp(args, { syntheticFromCollab: false, userEventAlreadyEmitted: true });
      return { ok: true };
    }

    return this.sendSubprocess(args, { syntheticFromCollab: false, userEventAlreadyEmitted: false });
  }

  stop(conversationId: UUID): void {
    this.cancelGeminiAcp(conversationId);
    this.killProc(conversationId);
    this.killOllama(conversationId);
    this.emit({ type: 'running', conversationId, isRunning: false });
  }

  newConversation(conversationId: UUID): void {
    // Kill the underlying runtime so the next send starts a fresh session.
    this.killProc(conversationId);
    this.killOllama(conversationId);
    this.killGeminiAcp(conversationId);
    this.codexExecNoticeByConversation.delete(conversationId);
  }

  respondPermission(conversationId: UUID, requestId: string, approved: boolean): void {
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
    const cb = active.pendingPermissions.get(requestId);
    if (cb) {
      cb(approved);
      active.pendingPermissions.delete(requestId);
    }
    // Write the decision envelope to the CLI's stdin. claude's permission
    // protocol expects a JSON object with request_id + decision.
    const msg = JSON.stringify({
      type: 'permission_response',
      request_id: requestId,
      decision: approved ? 'allow' : 'deny',
    });
    try {
      active.proc.stdin.write(msg + '\n');
    } catch {
      // Subprocess died — nothing to do.
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
    active.lastCodexMsgId += 1;
    const op =
      kind === 'exec'
        ? { type: 'exec_approval', id: callId, decision: approved ? 'approved' : 'denied' }
        : { type: 'apply_patch_approval', id: callId, decision: approved ? 'approved' : 'denied' };
    const msg = JSON.stringify({ id: String(active.lastCodexMsgId), op });
    try {
      active.proc.stdin.write(msg + '\n');
    } catch {}
  }

  killAll(): void {
    for (const id of Array.from(this.procs.keys())) this.killProc(id);
    for (const id of Array.from(this.ollamaSessions.keys())) this.killOllama(id);
    for (const id of Array.from(this.geminiAcpSessions.keys())) this.killGeminiAcp(id);
  }

  // --- Internals ---

  private killProc(conversationId: UUID): void {
    const active = this.procs.get(conversationId);
    if (!active) return;
    try {
      active.proc.stdin.end();
    } catch {}
    try {
      active.proc.kill('SIGTERM');
    } catch {}
    this.procs.delete(conversationId);
  }

  private killOllama(conversationId: UUID): void {
    const s = this.ollamaSessions.get(conversationId);
    if (!s) return;
    s.inFlight?.abort();
    this.ollamaSessions.delete(conversationId);
  }

  private sendSubprocess(
    args: SendArgs,
    options: { syntheticFromCollab: boolean; userEventAlreadyEmitted: boolean },
  ): { ok: true } | { ok: false; error: string } {
    const convId = args.conversationId;
    if (!options.syntheticFromCollab && !options.userEventAlreadyEmitted) {
      this.emitLocalUser(convId, args.prompt, args.attachments);
    }

    try {
      const existing = this.procs.get(convId);
      if (
        existing &&
        (existing.launchPermissionMode !== args.permissionMode ||
          existing.launchModel !== args.model ||
          existing.cwd !== args.cwd)
      ) {
        this.killProc(convId);
      }
      const active = this.procs.get(convId) ?? this.spawnFor(args);
      active.currentUserPrompt = args.prompt;
      active.currentAssistantText = '';
      active.currentToolActivity = [];
      active.reviewBackend = (args.reviewBackend as Backend | null) ?? null;
      active.reviewMode = args.reviewMode ?? null;
      active.collabMaxTurns = args.collabMaxTurns ?? 3;
      active.reviewOllamaModel = args.reviewOllamaModel ?? null;
      active.cwd = args.cwd;
      active.geminiAssistantEventId = undefined;
      active.geminiAssistantText = '';
      active.geminiAssistantToolUses = [];
      active.geminiAssistantNeedsSplit = false;
      active.codexExecEventId = undefined;
      active.codexExecRevision = 0;
      if (!options.syntheticFromCollab) {
        active.collabBurst += 1;
        active.collabRoundsInBurst = 0;
      }
      this.emit({ type: 'running', conversationId: convId, isRunning: true, activityLabel: 'Thinking…' });
      const envelope = this.buildEnvelope(args, active);
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
    // Collab synthetic prompts don't show as user bubbles.
    if (!options.syntheticFromCollab) {
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
      this.emit({ type: 'running', conversationId: convId, isRunning: false });
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

      if (!opts?.err && finalAssistantText && args.reviewBackend) {
        void this.runOllamaReviewHook({
          convId,
          session: session!,
          userPrompt: args.prompt,
          assistantText: finalAssistantText,
          reviewBackend: args.reviewBackend as Backend,
          reviewMode: args.reviewMode ?? null,
          collabMaxTurns: args.collabMaxTurns ?? 3,
          reviewOllamaModel: args.reviewOllamaModel ?? null,
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

      await streamChat(
        { model, messages: session!.messages, tools, signal: controller.signal },
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
      return { ok: true, toolCalls: pendingToolCalls, text: acc };
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
    cwd: string;
  }): Promise<void> {
    const { convId, session, reviewBackend } = params;
    const settings = this.settingsProvider();
    const capturedBurst = session.collabBurst;
    const capturedRound = session.collabRoundsInBurst + 1;
    session.collabRoundsInBurst = capturedRound;

    const result = await this.reviewer.run({
      conversationId: convId,
      reviewBackend,
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
      type: 'running',
      conversationId: convId,
      isRunning: true,
      activityLabel: `Collab round ${capturedRound + 1}…`,
    });

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
      },
      { syntheticFromCollab: true },
    );
  }

  private async sendGeminiAcp(
    args: SendArgs,
    options: { syntheticFromCollab: boolean; userEventAlreadyEmitted: boolean },
  ): Promise<void> {
    const convId = args.conversationId;
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
      this.emitLocalUser(convId, args.prompt, args.attachments);
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
      this.emit({ type: 'running', conversationId: convId, isRunning: false });
      void this.maybeRunGeminiAcpReviewer(convId, session, resultInfo.isError);
    } catch (err: any) {
      session.promptInFlight = false;
      const message = err?.message ?? String(err);
      this.emit({ type: 'error', conversationId: convId, message });
      this.emit({ type: 'running', conversationId: convId, isRunning: false });
    }
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
    if (!session?.promptInFlight || !session.sessionId) return;
    void session.client.notify('session/cancel', { sessionId: session.sessionId });
  }

  private killGeminiAcp(conversationId: UUID): void {
    const session = this.geminiAcpSessions.get(conversationId);
    if (!session) return;
    session.closing = true;
    if (session.sessionId) {
      void session.client.request('session/close', { sessionId: session.sessionId }).catch(() => {});
    }
    session.client.close();
    this.geminiAcpSessions.delete(conversationId);
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

    const result = await this.reviewer.run({
      conversationId: convId,
      reviewBackend: session.reviewBackend,
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
    });

    if (session.reviewMode !== 'collab') return;
    if (session.collabBurst !== capturedBurst) return;
    if (result.error || !result.text.trim()) return;
    if (capturedRound >= (session.collabMaxTurns || 3)) return;
    if (this.geminiAcpSessions.get(convId) !== session) return;

    const pingPrompt = [
      `The secondary reviewer (${session.reviewBackend}) had this take on your last turn:`,
      '',
      result.text,
      '',
      `Please respond — either incorporate their feedback or push back with reasoning.`,
    ].join('\n');

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
      },
      { syntheticFromCollab: true, userEventAlreadyEmitted: true },
    );
  }

  private spawnFor(args: SendArgs): ActiveProcess {
    const binary = this.resolveBinary(args.backend);
    const env = this.buildEnv(binary);
    const codexPerms = args.backend === 'codex' ? codexPermissionMapping(args.permissionMode) : null;
    const codexMode =
      args.backend === 'codex'
        ? process.platform === 'win32' && !this.supportsCodexProto(binary, env)
          ? 'exec'
          : 'proto'
        : undefined;
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
      codexState: args.backend === 'codex' ? makeCodexParserState() : undefined,
      codexMode,
      codexExecEventId: undefined,
      codexExecRevision: 0,
      lastCodexMsgId: 0,
      pendingPermissions: new Map(),
      pendingCodexApprovals: new Map(),
      currentUserPrompt: args.prompt,
      currentAssistantText: '',
      currentToolActivity: [],
      reviewBackend: (args.reviewBackend as Backend | null) ?? null,
      reviewMode: args.reviewMode ?? null,
      collabMaxTurns: args.collabMaxTurns ?? 3,
      reviewOllamaModel: args.reviewOllamaModel ?? null,
      collabBurst: 0,
      collabRoundsInBurst: 0,
      cwd: args.cwd,
      geminiAssistantEventId: undefined,
      geminiAssistantText: '',
      geminiAssistantToolUses: [],
      geminiAssistantNeedsSplit: false,
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
    proc.on('close', (code) => {
      // Only clear if this is still the current process for this conversation
      if (this.procs.get(args.conversationId) === active) {
        this.procs.delete(args.conversationId);
      }
      this.emit({
        type: 'running',
        conversationId: args.conversationId,
        isRunning: false,
      });
      if (active.backend === 'codex' && active.codexMode === 'exec') {
        this.emit({
          type: 'stream',
          conversationId: args.conversationId,
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
          void this.maybeRunReviewer(args.conversationId, active);
        }
      }
      if (code != null && code !== 0 && code !== 143) {
        const tail = (active.stderrBuffer || active.stdoutBuffer || active.currentAssistantText || '').slice(-500);
        this.emit({
          type: 'error',
          conversationId: args.conversationId,
          message:
            `${args.backend} exited with status ${code}. ` +
            (tail ? `Recent stderr: ${tail}` : 'Run the CLI manually for details.'),
        });
      }
    });
    return active;
  }

  private buildArgs(args: SendArgs, codexMode?: 'proto' | 'exec'): string[] {
    switch (args.backend) {
      case 'claude': {
        const a: string[] = [
          '-p',
          '--input-format',
          'stream-json',
          '--output-format',
          'stream-json',
          '--verbose',
          '--include-partial-messages',
        ];
        if (args.sessionId) a.push('--resume', args.sessionId);
        if (args.model) a.push('--model', args.model);
        if (args.permissionMode && args.permissionMode !== 'default') {
          a.push('--permission-mode', args.permissionMode);
        }
        if (args.effortLevel) a.push('--thinking-effort', args.effortLevel);
        return a;
      }
      case 'codex': {
        const { sandbox, approval } = codexPermissionMapping(args.permissionMode);
        if (codexMode === 'exec') {
          const a: string[] = [];
          if (args.model) a.push('-m', args.model);
          a.push('-s', sandbox, '-a', approval, 'exec', '-');
          return a;
        }
        const a: string[] = ['proto'];
        if (args.model) a.push('-c', `model=${args.model}`);
        a.push('-c', `sandbox_mode="${sandbox}"`);
        a.push('-c', `approval_policy="${approval}"`);
        return a;
      }
      case 'gemini': {
        const a: string[] = ['-p', '-', '-o', 'stream-json'];
        if (args.model) a.push('-m', args.model);
        if (args.sessionId) a.push('--resume', args.sessionId);
        a.push('--approval-mode', geminiPermissionMapping(args.permissionMode));
        return a;
      }
      case 'ollama':
        // Ollama never reaches the subprocess path — sendOllama handles it.
        throw new Error('Ollama backend uses the HTTP path, not subprocess args');
    }
  }

  private buildEnvelope(args: SendArgs, active: ActiveProcess): string {
    const attachments = args.attachments ?? [];
    switch (args.backend) {
      case 'claude': {
        // If we have images, send content as an array of typed blocks.
        // Otherwise keep the plain-string form — equivalent on the wire
        // but cheaper to eyeball in logs.
        if (attachments.length === 0) {
          return JSON.stringify({
            type: 'user',
            message: { role: 'user', content: args.prompt },
          });
        }
        const content: any[] = attachments.map((a) => ({
          type: 'image',
          source: { type: 'base64', media_type: a.mimeType, data: a.dataBase64 },
        }));
        // Text always comes last so the user's words aren't buried above
        // the screenshots.
        content.push({ type: 'text', text: args.prompt || '(no text)' });
        return JSON.stringify({
          type: 'user',
          message: { role: 'user', content },
        });
      }
      case 'codex': {
        if (active.codexMode === 'exec') {
          return args.prompt;
        }
        active.lastCodexMsgId += 1;
        // codex proto wants local file paths, not base64. Write each
        // attachment to a temp file and reference by path.
        const items: any[] = [];
        if (args.prompt) items.push({ type: 'text', text: args.prompt });
        for (const a of attachments) {
          const p = writeAttachmentToTemp(a);
          items.push({ type: 'local_image', path: p });
        }
        return JSON.stringify({
          id: String(active.lastCodexMsgId),
          op: { type: 'user_input', items },
        });
      }
      case 'gemini':
        // Gemini headless mode here is text-only for now, so image
        // attachments are dropped even though the CLI supports image paths.
        return args.prompt;
      case 'ollama':
        throw new Error('Ollama backend builds its payload in sendOllama');
    }
  }

  private handleStdout(convId: UUID, active: ActiveProcess, chunk: string): void {
    if (active.backend === 'codex' && active.codexMode === 'exec') {
      if (!this.codexExecNoticeByConversation.has(convId)) {
        this.codexExecNoticeByConversation.add(convId);
        this.emit({
          type: 'stream',
          conversationId: convId,
          events: [
            {
              id: randomUUID(),
              timestamp: Date.now(),
              raw: '',
              kind: {
                type: 'systemNotice',
                text:
                  'Codex is running in compatibility mode (exec). Tool cards/approvals are limited on this CLI build. Install a proto-capable Codex build for full Overcli tooling.',
              },
              revision: 0,
            },
          ],
        });
      }
      active.currentAssistantText += chunk;
      if (!active.sessionId) {
        const m = active.currentAssistantText.match(/session id:\s*([0-9a-f-]{8,})/i);
        if (m?.[1]) {
          active.sessionId = m[1];
          this.emit({
            type: 'sessionConfigured',
            conversationId: convId,
            sessionId: active.sessionId,
          });
        }
      }
      const snap = extractCodexExecSnapshot(active.currentAssistantText);
      if (!active.codexExecEventId) active.codexExecEventId = randomUUID();
      active.codexExecRevision += 1;
      this.emit({
        type: 'stream',
        conversationId: convId,
        events: [
          {
            id: active.codexExecEventId,
            timestamp: Date.now(),
            raw: chunk,
            kind: {
              type: 'assistant',
              info: {
                model: 'codex',
                text: snap.text,
                toolUses: [],
                thinking: snap.thinking ? [snap.thinking] : [],
              },
            },
            revision: active.codexExecRevision,
          } as StreamEvent,
        ],
      });
      this.emit({
        type: 'running',
        conversationId: convId,
        isRunning: true,
        activityLabel: 'Writing…',
      });
      return;
    }
    active.stdoutBuffer += chunk;
    const lines = active.stdoutBuffer.split('\n');
    active.stdoutBuffer = lines.pop() ?? '';
    const emitted: StreamEvent[] = [];
    let sessionConfigured: { sessionId: string; rolloutPath?: string } | undefined;
    for (const raw of lines) {
      if (!raw) continue;
      if (active.backend === 'claude') {
        const evt = parseClaudeLine(raw);
        if (evt) emitted.push(evt);
      } else if (active.backend === 'codex') {
        const result = parseCodexProtoLine(raw, active.codexState!);
        for (const evt of result.events) emitted.push(evt);
        if (result.sessionConfigured) sessionConfigured = result.sessionConfigured;
      } else {
        const { parseGeminiLine } = require('./parsers/gemini');
        const evt = parseGeminiLine(raw);
        if (evt) {
          if (evt.kind.type === 'assistant') {
            emitted.push(this.coalesceGeminiAssistant(active, evt));
          } else {
            if (active.backend === 'gemini' && evt.kind.type === 'toolResult') {
              active.geminiAssistantNeedsSplit = true;
            }
            emitted.push(evt);
          }
        }
      }
    }
    for (const e of emitted) {
      if (e.kind.type === 'systemInit' && e.kind.info.sessionId) {
        sessionConfigured = { sessionId: e.kind.info.sessionId };
      }
    }
    if (emitted.length) {
      // Walk the new events once to update permission maps, activity
      // label, turn-end signal, and the per-turn digest the reviewer
      // hook consumes.
      let turnEnded = false;
      let nextActivity: string | undefined;
      for (const e of emitted) {
        if (e.kind.type === 'permissionRequest') {
          active.pendingPermissions.set(e.kind.info.requestId, () => {});
        } else if (e.kind.type === 'codexApproval') {
          active.pendingCodexApprovals.set(e.kind.info.callId, () => {});
        } else if (e.kind.type === 'result') {
          turnEnded = true;
        } else if (e.kind.type === 'assistant') {
          if (e.kind.info.text) {
            // Accumulate assistant text for the reviewer digest. Claude
            // emits partial assistants as streaming deltas plus one full
            // snapshot on finish; we take whichever is longer so we
            // don't truncate.
            if (e.kind.info.text.length > active.currentAssistantText.length) {
              active.currentAssistantText = e.kind.info.text;
            }
          }
          for (const t of e.kind.info.toolUses) {
            const line = summarizeToolUse(t.name, t.inputJSON, t.filePath);
            if (line) active.currentToolActivity.push(line);
          }
          if (e.kind.info.toolUses.length > 0) nextActivity = 'Running tools…';
          else if (e.kind.info.text.length > 0) nextActivity = 'Writing…';
        } else if (e.kind.type === 'toolResult') {
          nextActivity = 'Reading tool output…';
        }
      }
      this.emit({ type: 'stream', conversationId: convId, events: emitted });

      if (turnEnded) {
        this.emit({ type: 'running', conversationId: convId, isRunning: false });
        void this.maybeRunReviewer(convId, active);
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
    const resolved = resolveBackendPath(backend, settings.backendPaths[backend]);
    if (resolved) return resolved;
    // Last resort: hope it's on PATH (which we extend via buildEnv).
    return backend;
  }

  private supportsCodexProto(binary: string, env: NodeJS.ProcessEnv): boolean {
    const cached = this.codexProtoSupport.get(binary);
    if (cached != null) return cached;
    const shell = backendNeedsShell(binary);
    const probe = spawnSync(binary, ['help', 'proto'], {
      encoding: 'utf-8',
      timeout: 3000,
      env,
      shell,
    });
    let supports = probe.status === 0;
    if (!supports) {
      const res = spawnSync(binary, ['--help'], { encoding: 'utf-8', timeout: 3000, env, shell });
      const text = `${res.stdout ?? ''}\n${res.stderr ?? ''}`;
      supports = /^\s*proto\s+/m.test(text);
    }
    this.codexProtoSupport.set(binary, supports);
    return supports;
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

    const result = await this.reviewer.run({
      conversationId: convId,
      reviewBackend: active.reviewBackend,
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

    // Build a ping-pong prompt. Make it clear to the primary who is
    // speaking so the loop reads coherently in the chat.
    const pingPrompt = [
      `The secondary reviewer (${active.reviewBackend}) had this take on your last turn:`,
      '',
      result.text,
      '',
      `Please respond — either incorporate their feedback or push back with reasoning.`,
    ].join('\n');

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
      active.proc.stdin.write(envelope + '\n');
    } catch {
      // If stdin died, skip silently; the session already reported the
      // failure via the process close handler.
    }
  }

  private buildEnv(binary: string): NodeJS.ProcessEnv {
    return buildBackendEnv(process.env, binary);
  }

  private emitLocalUser(conversationId: UUID, prompt: string, attachments?: Attachment[]): void {
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

  private coalesceGeminiAssistant(active: ActiveProcess, evt: StreamEvent): StreamEvent {
    if (evt.kind.type !== 'assistant') return evt;
    if (active.geminiAssistantNeedsSplit) {
      active.geminiAssistantEventId = undefined;
      active.geminiAssistantText = '';
      active.geminiAssistantToolUses = [];
      active.geminiAssistantNeedsSplit = false;
    }
    if (!active.geminiAssistantEventId) active.geminiAssistantEventId = randomUUID();
    const delta = geminiAssistantIsDelta(evt.raw);
    if (evt.kind.info.text) {
      active.geminiAssistantText = delta
        ? active.geminiAssistantText + evt.kind.info.text
        : evt.kind.info.text;
    }
    if (evt.kind.info.toolUses.length > 0) {
      active.geminiAssistantToolUses = [
        ...active.geminiAssistantToolUses,
        ...evt.kind.info.toolUses,
      ];
    }
    return {
      ...evt,
      id: active.geminiAssistantEventId,
      kind: {
        type: 'assistant',
        info: {
          ...evt.kind.info,
          text: active.geminiAssistantText,
          toolUses: [...active.geminiAssistantToolUses],
        },
      },
    };
  }
}

function extractCodexExecSnapshot(raw: string): { text: string; thinking: string } {
  if (!raw.trim()) return { text: '', thinking: '' };

  // Timestamped blocks (newer codex exec):
  // [2026-... ] thinking
  // <body>
  // [2026-... ] codex
  // <body>
  const tsLine = /^\[\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\][ \t]*(.*?)[ \t]*$/gm;
  const sections: Array<{ tag: string; bodyStart: number; markerStart: number }> = [];
  for (const m of raw.matchAll(tsLine)) {
    const idx = m.index ?? 0;
    sections.push({ tag: (m[1] ?? '').trim().toLowerCase(), bodyStart: idx + m[0].length, markerStart: idx });
  }
  if (sections.length > 0) {
    const textBlocks: string[] = [];
    const thinkingBlocks: string[] = [];
    for (let i = 0; i < sections.length; i++) {
      const cur = sections[i]!;
      const end = sections[i + 1]?.markerStart ?? raw.length;
      const body = raw.slice(cur.bodyStart, end).trim();
      if (!body) continue;
      if (cur.tag === 'codex') textBlocks.push(body);
      else if (cur.tag.includes('thinking') || cur.tag.includes('reasoning')) thinkingBlocks.push(body);
    }
    const text = textBlocks.join('\n\n').trim();
    const thinking = thinkingBlocks.join('\n\n').trim();
    if (text || thinking) return { text, thinking };
  }

  // Plain sections (older/alternate codex exec):
  // thinking\n...\n
  // codex\n...\n
  const thinking = extractSection(raw, 'thinking').trim();
  const text = extractSection(raw, 'codex').trim();
  if (text || thinking) return { text, thinking };

  // Last resort: avoid dumping headers/config in the chat bubble.
  return { text: raw.trim(), thinking: '' };
}

function extractSection(raw: string, label: string): string {
  const re = new RegExp(
    String.raw`(?:^|\r?\n)${label}\r?\n([\s\S]*?)(?=(?:\r?\n(?:tokens used|user|codex|thinking|reasoning)\r?\n)|$)`,
    'i',
  );
  const m = raw.match(re);
  return m?.[1] ?? '';
}

/// One-line digest of a tool use for the reviewer prompt. Ideally the
/// reviewer sees enough to reconstruct what happened without us dumping
/// the full tool_use JSON (which can be many KB for patch / file writes).
function summarizeToolUse(name: string, inputJSON: string, filePath?: string): string {
  let parsed: any = null;
  try {
    parsed = JSON.parse(inputJSON);
  } catch {
    // inputJSON might not be JSON (we pack `command.join(' ')` straight
    // in for shell/bash from codex); treat as opaque.
  }
  if (name === 'Bash' || name === 'shell' || name === 'exec_command') {
    const cmd =
      typeof parsed?.command === 'string'
        ? parsed.command
        : Array.isArray(parsed?.command)
        ? parsed.command.join(' ')
        : inputJSON;
    return `• Bash: ${truncate(cmd, 240)}`;
  }
  if (name === 'Edit' || name === 'MultiEdit') {
    return `• Edit ${filePath ?? parsed?.file_path ?? ''}`.trim();
  }
  if (name === 'Write') {
    return `• Write ${filePath ?? parsed?.file_path ?? ''}`.trim();
  }
  if (name === 'Read') {
    return `• Read ${filePath ?? parsed?.file_path ?? ''}`.trim();
  }
  if (name === 'TodoWrite') {
    const count = Array.isArray(parsed?.todos) ? parsed.todos.length : 0;
    return `• TodoWrite (${count})`;
  }
  return `• ${name} ${truncate(inputJSON, 160)}`;
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + '…' : s;
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

function codexPermissionMapping(mode: PermissionMode): { sandbox: string; approval: string } {
  switch (mode) {
    case 'plan':
      return { sandbox: 'read-only', approval: 'on-request' };
    case 'acceptEdits':
      return { sandbox: 'workspace-write', approval: 'on-failure' };
    case 'bypassPermissions':
      return { sandbox: 'danger-full-access', approval: 'never' };
    case 'default':
    default:
      return { sandbox: 'workspace-write', approval: 'on-request' };
  }
}

function geminiPermissionMapping(mode: PermissionMode): string {
  switch (mode) {
    case 'plan':
      return 'plan';
    case 'acceptEdits':
      return 'auto_edit';
    case 'bypassPermissions':
      return 'yolo';
    case 'default':
    default:
      return 'default';
  }
}

function geminiAssistantIsDelta(raw: string): boolean {
  try {
    const parsed = JSON.parse(raw);
    return parsed?.type === 'message' && parsed?.role === 'assistant' && parsed?.delta === true;
  } catch {
    return false;
  }
}

/// Write a base64 attachment to a temp file that codex proto can read by
/// path. Stored under `~/.overcli/attachments/<uuid>.<ext>` so the file
/// sticks around for the lifetime of the codex subprocess (which may read
/// it asynchronously); cleanup happens at app quit since temp files are
/// cheap and leaving them means reopened sessions can re-reference the
/// same path if needed.
function writeAttachmentToTemp(a: Attachment): string {
  const dir = path.join(os.homedir(), '.overcli', 'attachments');
  fs.mkdirSync(dir, { recursive: true });
  const ext = mimeToExt(a.mimeType);
  const file = path.join(dir, `${a.id || randomUUID()}${ext}`);
  fs.writeFileSync(file, Buffer.from(a.dataBase64, 'base64'));
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
