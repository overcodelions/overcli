// GitHub Copilot CLI backend spec. Owns the CLI args and stdout parser
// for `copilot -p PROMPT --output-format=json --stream=on`. Copilot exits
// after each prompt (no persistent stdin loop), so we lean on the
// runner's gemini/codex-exec one-shot pathway: prompt rides in argv, the
// envelope is empty, and stdin is closed immediately so the subprocess
// doesn't block waiting for input.

import {
  CopilotParserState,
  copilotSessionIdFromResult,
  makeCopilotParserState,
  parseCopilotLine,
} from '../parsers/copilot';
import { normalizeAllowedDirs } from '../permissionRules';
import type { StreamEvent } from '../../shared/types';
import type { BackendSendArgs, BackendSpec, ParseChunkResult } from './types';

interface CopilotStreamState {
  /// Partial line carried from the previous chunk — copilot emits
  /// newline-delimited JSON and a single read can split a line in half.
  buffer: string;
  /// State the underlying parser keeps (in-flight message id, reasoning
  /// accumulators, mcp servers).
  inner: CopilotParserState;
}

export const copilotBackend: BackendSpec = {
  name: 'copilot',

  buildArgs(args: BackendSendArgs): string[] {
    const a: string[] = [
      '-p',
      args.prompt,
      '--output-format',
      'json',
      '--stream',
      'on',
    ];
    if (args.sessionId) {
      a.push('--resume', args.sessionId);
    }
    if (args.model) {
      a.push('--model', args.model);
    }
    // Permission mapping: overcli doesn't yet broker copilot approvals
    // (no MCP-style prompt tool for copilot), and we launch the
    // subprocess with stdin closed — so any interactive approval copilot
    // would normally print to TTY just hangs the process. To stay
    // usable, we pass `--allow-all-tools` for every mode *except* plan.
    // Plan mode is read-only by intent (no writes / no shell), so we
    // narrow the tool set to safe inspection tools instead.
    if (args.permissionMode === 'plan') {
      a.push('--available-tools', 'view');
      a.push('--available-tools', 'glob');
      a.push('--available-tools', 'grep');
    } else {
      a.push('--allow-all-tools');
    }
    for (const dir of normalizeAllowedDirs(args.cwd, args.allowedDirs)) {
      a.push('--add-dir', dir);
    }
    return a;
  },

  /// Prompt rides in argv, not stdin. Return an empty envelope so the
  /// runner's stdin.end('\n') is a harmless no-op. (Copilot ignores
  /// stdin when `-p` is set.)
  buildEnvelope(): string {
    return '';
  },

  makeParserState(): CopilotStreamState {
    return { buffer: '', inner: makeCopilotParserState() };
  },

  resetForNewTurn(state: unknown): void {
    if (!state) return;
    const s = state as CopilotStreamState;
    // Each copilot subprocess is single-turn (the CLI exits after `-p`).
    // In practice the runner respawns for the next turn so this reset
    // rarely fires, but we drop in-flight per-turn state anyway in case
    // a future overcli change keeps the process alive somehow.
    s.inner.inFlightMessageId = null;
    s.inner.inFlightText = '';
    s.inner.inFlightReasoningById.clear();
    s.inner.lastSnapshotAt = 0;
  },

  parseChunk(chunk: string, state: unknown): ParseChunkResult {
    const s = state as CopilotStreamState;
    s.buffer += chunk;
    const lines = s.buffer.split('\n');
    s.buffer = lines.pop() ?? '';
    const events: StreamEvent[] = [];
    let sessionConfigured: ParseChunkResult['sessionConfigured'];
    for (const raw of lines) {
      if (!raw) continue;
      // Peek at the type before handing off — the result line is where
      // copilot finally surfaces the sessionId, and we need to flag it
      // for the runner's side-channel.
      let parsed: any;
      try {
        parsed = JSON.parse(raw);
      } catch {
        // The parser handles malformed lines itself — let it.
      }
      if (parsed?.type === 'result') {
        const sid = copilotSessionIdFromResult(parsed);
        if (sid) sessionConfigured = { sessionId: sid };
      }
      const out = parseCopilotLine(raw, s.inner);
      for (const ev of out) events.push(ev);
    }
    return sessionConfigured ? { events, sessionConfigured } : { events };
  },
};
