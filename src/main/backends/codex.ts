// Codex CLI backend spec. Owns the CLI args and stdin envelope shape
// for `codex exec` (the fallback path used when the proto / app-server
// transport isn't available), plus the stdout parser for that mode.
//
// The proto/app-server transports route through their own clients in
// runner.ts and never touch buildEnvelope or parseChunk; the spec is
// transport-aware via makeParserState's opts so its parseChunk can
// short-circuit when the runner is using a richer transport.

import { randomUUID } from 'node:crypto';
import { codexTransportPermissions } from '../permissionRules';
import { extractCodexExecSnapshot } from '../streamSnapshot';
import type { StreamEvent } from '../../shared/types';
import type {
  BackendCtx,
  BackendSendArgs,
  BackendSpec,
  MakeParserStateOpts,
  ParseChunkResult,
} from './types';

interface CodexStreamState {
  /// Transport mode this subprocess is running. Only `exec` produces
  /// stdout that parseChunk should consume; the others are handled by
  /// dedicated transports and parseChunk returns nothing.
  mode: 'proto' | 'exec' | 'app-server';
  /// The full accumulated text. Codex exec emits a free-form text
  /// stream rather than line-delimited events, so we keep growing it
  /// and re-snapshot on every chunk.
  accumulator: string;
  /// Stable id for the assistant snapshot we keep painting. Assigned
  /// on the first chunk, reused for every subsequent paint.
  eventId?: string;
  /// Monotonic revision so the renderer knows which snapshot is freshest.
  revision: number;
  /// Whether we've already shown the "compatibility mode" notice.
  noticeEmitted: boolean;
  /// Session id once the codex banner reveals it. We surface it via
  /// sessionConfigured the first time we see it.
  sessionEmitted: boolean;
}

const COMPAT_NOTICE =
  'Codex is running in compatibility mode (exec). Tool cards/approvals are limited on this CLI build. Install a proto-capable Codex build for full overcli tooling.';

export const codexBackend: BackendSpec = {
  name: 'codex',

  buildArgs(args: BackendSendArgs): string[] {
    const { sandbox, approval } = codexTransportPermissions(args.permissionMode);
    const a: string[] = [];
    if (args.model) a.push('-m', args.model);
    a.push('-s', sandbox, '-a', approval, 'exec', '-');
    return a;
  },

  buildEnvelope(args: BackendSendArgs, ctx: BackendCtx): string {
    const transcript = ctx.codexExecTranscriptFor(args.conversationId);
    if (!transcript || transcript.length === 0) return args.prompt;
    const history = transcript
      .map((t) => `User: ${t.user}\n\nAssistant: ${t.assistant}`)
      .join('\n\n---\n\n');
    return `Prior turns in this conversation (for context only — do not repeat them):\n\n${history}\n\n---\n\nNew user message:\n\n${args.prompt}`;
  },

  makeParserState(opts?: MakeParserStateOpts): CodexStreamState {
    return {
      mode: opts?.codexMode ?? 'exec',
      accumulator: '',
      eventId: undefined,
      revision: 0,
      noticeEmitted: false,
      sessionEmitted: false,
    };
  },

  resetForNewTurn(state: unknown): void {
    if (!state) return;
    const s = state as CodexStreamState;
    // Drop the previous turn's accumulator + snapshot id so the new
    // turn paints into a fresh bubble. Subprocess-lifetime flags (mode,
    // sessionEmitted, noticeEmitted) survive — the compat notice and
    // session id should appear once per subprocess, not once per turn.
    s.accumulator = '';
    s.eventId = undefined;
    s.revision = 0;
  },

  parseChunk(chunk: string, state: unknown): ParseChunkResult {
    const s = state as CodexStreamState;
    // Non-exec transports route stdout through their own clients (the
    // CodexAppServerClient, the proto adapter); no parseChunk work to do.
    if (s.mode !== 'exec') return { events: [] };

    const events: StreamEvent[] = [];
    const now = Date.now();
    if (!s.noticeEmitted) {
      s.noticeEmitted = true;
      events.push({
        id: randomUUID(),
        timestamp: now,
        raw: '',
        kind: { type: 'systemNotice', text: COMPAT_NOTICE },
        revision: 0,
      });
    }

    s.accumulator += chunk;

    let sessionConfigured: ParseChunkResult['sessionConfigured'];
    if (!s.sessionEmitted) {
      const m = s.accumulator.match(/session id:\s*([0-9a-f-]{8,})/i);
      if (m?.[1]) {
        s.sessionEmitted = true;
        sessionConfigured = { sessionId: m[1] };
      }
    }

    const snap = extractCodexExecSnapshot(s.accumulator);
    if (!s.eventId) s.eventId = randomUUID();
    s.revision += 1;
    events.push({
      id: s.eventId,
      timestamp: now,
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
      revision: s.revision,
    } as StreamEvent);

    return {
      events,
      sessionConfigured,
      liveActivity: 'Writing…',
    };
  },
};

/// Exported for the runner: expose the latest snapshot text so the
/// turn-end transcript-replay path can stash it without reaching into
/// state internals.
export function codexExecSnapshotText(state: unknown): string {
  const s = state as CodexStreamState;
  return extractCodexExecSnapshot(s.accumulator).text;
}

