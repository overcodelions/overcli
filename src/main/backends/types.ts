// Per-backend specification. The goal is that every backend-specific
// decision (CLI args, stdin envelope, stdout parsing, permission mapping)
// is reachable through a single registry — runner.ts becomes an
// orchestrator that spawns, forwards stdout chunks, and emits events,
// with no `if (backend === 'foo')` branches.
//
// Migration status:
//   - buildArgs / buildEnvelope: all four backends.
//   - parseChunk: claude only. Codex (exec/proto/app-server) and Gemini
//     fall through to the inline path in runner.ts handleStdout. The
//     `parseChunk` field is optional precisely so unmigrated backends
//     can stay on the inline path until they're ported.

import type { Attachment, Backend, EffortLevel, PermissionMode, StreamEvent, UUID } from '../../shared/types';

export interface BackendSendArgs {
  conversationId: UUID;
  prompt: string;
  cwd: string;
  model: string;
  permissionMode: PermissionMode;
  sessionId?: string;
  effortLevel?: EffortLevel;
  attachments?: Attachment[];
  allowedDirs?: string[];
}

/// Lookups the runner exposes to a spec. Lets a spec resolve per-conv
/// state (MCP config paths for claude, transcript history for codex exec)
/// without holding a back-reference to the full RunnerManager.
export interface BackendCtx {
  mcpConfigPathFor(conversationId: UUID): string | undefined;
  /// Codex exec has no `--resume`: every turn spawns a fresh session that
  /// knows nothing about prior exchanges. We stitch context back by
  /// prepending the accumulated transcript to the next prompt.
  codexExecTranscriptFor(
    conversationId: UUID,
  ): Array<{ user: string; assistant: string }> | undefined;
}

/// Result of feeding a single stdout chunk through a spec's parser.
/// Pure: parseChunk should not emit on its own — it returns events the
/// runner will forward to the renderer plus optional side-channel
/// signals (session id discovered mid-stream, etc).
export interface ParseChunkResult {
  /// Events to forward on the main `stream` channel, in order.
  events: StreamEvent[];
  /// Set when this chunk surfaced the CLI's session id (claude's
  /// `systemInit`, codex proto's `session_configured`). The runner
  /// stashes it on the active process and emits a `sessionConfigured`
  /// side-channel event.
  sessionConfigured?: { sessionId: string; rolloutPath?: string };
  /// Set when this chunk should bump the live activity caption (codex
  /// exec keeps `Writing…` painted while text streams in). The runner
  /// emits a `running` side-channel event with this label.
  liveActivity?: string;
}

/// Optional context passed to `makeParserState`. Only codex needs it
/// today (its exec/proto/app-server transports parse very differently).
export interface MakeParserStateOpts {
  codexMode?: 'proto' | 'exec' | 'app-server';
}

/// What a backend tells the runner to do for a single send.
export interface BackendSpec {
  name: Backend;
  /// argv passed after the backend binary (`claude`, `codex`, `gemini`).
  buildArgs(args: BackendSendArgs, ctx: BackendCtx): string[];
  /// Bytes written once to the subprocess's stdin per turn.
  buildEnvelope(args: BackendSendArgs, ctx: BackendCtx): string;
  /// Fresh parser state for a new subprocess. Returned as `unknown` so the
  /// runner stores it opaquely; the spec's parseChunk owns the type.
  /// State should encapsulate everything parseChunk needs across calls —
  /// most notably the partial-line buffer for line-delimited backends.
  /// Opts surface the small bits of spawn-time context certain backends
  /// need (codex's transport mode); most specs ignore the argument.
  makeParserState?(opts?: MakeParserStateOpts): unknown;
  /// Consume one stdout chunk, mutate state, and return the resulting
  /// events. Optional during the migration: backends without a
  /// parseChunk still go through runner.ts's inline switch.
  parseChunk?(chunk: string, state: unknown): ParseChunkResult;
  /// Called when a new user turn arrives on an existing subprocess
  /// (claude / codex stay alive across turns). Specs that accumulate
  /// per-turn state — codex's growing exec snapshot, gemini's coalesce
  /// buffer — implement this to drop that state without losing
  /// subprocess-lifetime flags (compatibility-mode notice, session id
  /// once seen). Specs whose state self-manages via stream events
  /// (claude's message_start/stop) leave it undefined and the runner
  /// preserves the current state across the turn boundary.
  resetForNewTurn?(state: unknown): void;
}
