// Per-backend specification. Today this is the seam Claude has been
// migrated to; Codex / Gemini / Ollama still live inline in runner.ts and
// will be ported to this same shape one at a time.
//
// The goal is that every backend-specific decision (CLI args, stdin
// envelope, parser state init, permission mapping) is reachable through a
// single registry — runner.ts becomes an orchestrator that spawns,
// collects stdout, and forwards events, with no `if (backend === 'foo')`
// branches.

import type { Attachment, Backend, EffortLevel, PermissionMode, UUID } from '../../shared/types';

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

/// What a backend tells the runner to do for a single send.
export interface BackendSpec {
  name: Backend;
  /// argv passed after the backend binary (`claude`, `codex`, `gemini`).
  buildArgs(args: BackendSendArgs, ctx: BackendCtx): string[];
  /// Bytes written once to the subprocess's stdin per turn.
  buildEnvelope(args: BackendSendArgs, ctx: BackendCtx): string;
  /// Fresh parser state for a new subprocess. Returned as `unknown` so the
  /// runner stores it opaquely; the spec's parseChunk owns the type.
  makeParserState?(): unknown;
}
