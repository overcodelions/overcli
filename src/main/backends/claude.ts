// Claude CLI backend spec. Owns the CLI args, stdin envelope shape, and
// stdout parsing for `claude -p --input-format stream-json`. State for a
// single subprocess (line buffer + the streaming-deltas accumulator) is
// constructed via `makeParserState` and threaded through `parseChunk` —
// the runner stores it opaquely.

import { ClaudeParserState, makeClaudeParserState, parseClaudeLine } from '../parsers/claude';
import { normalizeAllowedDirs } from '../permissionRules';
import type { BackendCtx, BackendSendArgs, BackendSpec, ParseChunkResult } from './types';

interface ClaudeStreamState {
  /// Partial line carried from the previous chunk — claude emits
  /// newline-delimited JSON and a single read can split a line in half.
  buffer: string;
  /// State the underlying parser keeps across lines (in-flight assistant
  /// id, accumulated content blocks, snapshot throttle).
  inner: ClaudeParserState;
}

export const claudeBackend: BackendSpec = {
  name: 'claude',

  buildArgs(args: BackendSendArgs, ctx: BackendCtx): string[] {
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
    // In bypassPermissions mode Claude Code auto-allows everything
    // without prompting — wiring our permission-prompt-tool would force
    // it to route tool checks through us anyway, defeating the mode.
    // `auto` mode keeps the prompt tool wired: Claude classifies each
    // tool call and only routes to us when it wants confirmation; safe
    // calls just don't invoke the prompt tool.
    if (args.permissionMode !== 'bypassPermissions') {
      const mcpConfigPath = ctx.mcpConfigPathFor(args.conversationId);
      if (mcpConfigPath) {
        a.push('--mcp-config', mcpConfigPath);
        a.push('--permission-prompt-tool', 'mcp__overcli__approve');
      }
    }
    for (const dir of normalizeAllowedDirs(args.cwd, args.allowedDirs)) {
      a.push('--add-dir', dir);
    }
    return a;
  },

  buildEnvelope(args: BackendSendArgs): string {
    const attachments = args.attachments ?? [];
    // If we have images, send content as an array of typed blocks.
    // Otherwise keep the plain-string form — equivalent on the wire but
    // cheaper to eyeball in logs.
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
  },

  makeParserState(): ClaudeStreamState {
    return { buffer: '', inner: makeClaudeParserState() };
  },

  parseChunk(chunk: string, state: unknown): ParseChunkResult {
    const s = state as ClaudeStreamState;
    s.buffer += chunk;
    const lines = s.buffer.split('\n');
    s.buffer = lines.pop() ?? '';
    const events = [];
    let sessionConfigured: ParseChunkResult['sessionConfigured'];
    for (const raw of lines) {
      if (!raw) continue;
      const evt = parseClaudeLine(raw, s.inner);
      if (!evt) continue;
      events.push(evt);
      // The sessionId arrives on the systemInit event at the start of
      // every turn (and on resume). Hand it back so the runner can pin
      // the conversation to it via a sessionConfigured side-channel.
      if (evt.kind.type === 'systemInit' && evt.kind.info.sessionId) {
        sessionConfigured = { sessionId: evt.kind.info.sessionId };
      }
    }
    return sessionConfigured ? { events, sessionConfigured } : { events };
  },
};
