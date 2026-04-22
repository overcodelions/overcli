// Reviewer ("rebound") subprocess. Fires a one-shot claude/codex/gemini
// run after each primary turn, streams its output back as reviewResult
// events tagged with the owning conversation id. Matches the Swift
// ReviewerSession's behavior — one reviewer per turn, short-lived.

import { spawn, ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { Backend, MainToRendererEvent, ReviewInfo, StreamEvent, UUID } from '../shared/types';
import { backendNeedsShell, buildBackendEnv, resolveBackendPath } from './backendPaths';
import { OllamaChatMessage, streamChat } from './ollama';

type Emit = (event: MainToRendererEvent) => void;

interface PrimaryTurnSummary {
  primaryBackend: string;
  userPrompt: string;
  assistantText: string;
  toolActivity: string;
}

export class ReviewerManager {
  private emit: Emit;
  /// Active reviewer process per conversation. We kill any in-flight
  /// reviewer when a new turn lands before the prior one finished — the
  /// old review is stale by then anyway.
  private inFlight = new Map<UUID, ChildProcessWithoutNullStreams>();
  /// Ollama reviewers are HTTP-based — cancelled via AbortController
  /// instead of SIGTERM on a child process.
  private inFlightHttp = new Map<UUID, AbortController>();
  /// Per-conversation counter so each review card gets a stable sequence
  /// number for the UI to show "round 2", "round 3", etc.
  private rounds = new Map<UUID, number>();

  constructor(emit: Emit) {
    this.emit = emit;
  }

  stop(conversationId: UUID): void {
    const p = this.inFlight.get(conversationId);
    if (p) {
      try {
        p.kill('SIGTERM');
      } catch {}
      this.inFlight.delete(conversationId);
    }
    const ctl = this.inFlightHttp.get(conversationId);
    if (ctl) {
      ctl.abort();
      this.inFlightHttp.delete(conversationId);
    }
  }

  stopAll(): void {
    for (const id of Array.from(this.inFlight.keys())) this.stop(id);
    for (const id of Array.from(this.inFlightHttp.keys())) this.stop(id);
  }

  /// Fire a reviewer for the just-completed primary turn. Resolves when
  /// the reviewer exits; events stream through `emit` as they arrive.
  async run(args: {
    conversationId: UUID;
    reviewBackend: Backend;
    cwd: string;
    summary: PrimaryTurnSummary;
    backendPathOverride?: string;
    /// Ollama reviewer model tag; ignored for other backends.
    ollamaModel?: string;
  }): Promise<ReviewInfo> {
    // Kill any prior in-flight reviewer for this conversation. Happens
    // if the user sent a follow-up turn before the reviewer finished.
    this.stop(args.conversationId);

    if (args.reviewBackend === 'ollama') {
      return this.runOllama(args);
    }

    const round = (this.rounds.get(args.conversationId) ?? 0) + 1;
    this.rounds.set(args.conversationId, round);

    const cardId = randomUUID();
    const startedAt = Date.now();

    // Emit an initial isRunning review card so the UI shows the reviewer
    // thinking immediately. We'll replace it with the final result when
    // the reviewer exits.
    this.emitReview(args.conversationId, {
      cardId,
      info: {
        backend: args.reviewBackend,
        text: '',
        isRunning: true,
        startedAt,
        round,
        mode: 'review',
      },
    });

    const prompt = buildReviewPrompt(args.summary, round);
    const bin = resolveBackendPath(args.reviewBackend, args.backendPathOverride);
    if (!bin) {
      const info: ReviewInfo = {
        backend: args.reviewBackend,
        text: '',
        isRunning: false,
        error: `${args.reviewBackend} CLI not found — install it to use rebound.`,
        startedAt,
        round,
        mode: 'review',
      };
      this.emitReview(args.conversationId, { cardId, info });
      return info;
    }

    return new Promise<ReviewInfo>((resolve) => {
      const childArgs = buildReviewerArgs(args.reviewBackend);
      const env = buildBackendEnv(process.env, bin);
      const shell = backendNeedsShell(bin);
      const proc = spawn(bin, childArgs, {
        cwd: args.cwd,
        env,
        shell,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      this.inFlight.set(args.conversationId, proc);

      let stdout = '';
      let stderr = '';
      let lastEmit = 0;
      proc.stdout.setEncoding('utf-8');
      proc.stderr.setEncoding('utf-8');
      proc.stdout.on('data', (chunk: string) => {
        stdout += chunk;
        // Extract display text from whatever format the backend used —
        // claude emits stream-json events, codex exec emits plain text,
        // gemini streams plain text. We keep the latest known assistant
        // text for the review card and update the UI throttled to ~10fps.
        const displayed = extractReviewerDisplay(stdout, args.reviewBackend);
        const now = Date.now();
        if (now - lastEmit > 100) {
          lastEmit = now;
          this.emitReview(args.conversationId, {
            cardId,
            info: {
              backend: args.reviewBackend,
              text: displayed,
              isRunning: true,
              startedAt,
              round,
              mode: 'review',
            },
          });
        }
      });
      proc.stderr.on('data', (chunk: string) => {
        stderr += chunk;
        if (stderr.length > 4000) stderr = stderr.slice(-4000);
      });
      proc.on('error', (err) => {
        this.inFlight.delete(args.conversationId);
        const info: ReviewInfo = {
          backend: args.reviewBackend,
          text: '',
          isRunning: false,
          error: err.message,
          startedAt,
          round,
          mode: 'review',
        };
        this.emitReview(args.conversationId, { cardId, info });
        resolve(info);
      });
      proc.on('close', (code) => {
        this.inFlight.delete(args.conversationId);
        const finalText = extractReviewerDisplay(stdout, args.reviewBackend);
        const info: ReviewInfo = {
          backend: args.reviewBackend,
          text: finalText,
          isRunning: false,
          error: code === 0 ? undefined : stderr.trim() || `exit ${code}`,
          startedAt,
          round,
          mode: 'review',
          raw: stdout.trim() || undefined,
        };
        this.emitReview(args.conversationId, { cardId, info });
        resolve(info);
      });

      // Write the prompt to stdin and close so the one-shot CLI starts.
      try {
        proc.stdin.write(prompt);
        proc.stdin.end();
      } catch (err: any) {
        this.inFlight.delete(args.conversationId);
        const info: ReviewInfo = {
          backend: args.reviewBackend,
          text: '',
          isRunning: false,
          error: err?.message ?? String(err),
          startedAt,
          round,
          mode: 'review',
        };
        this.emitReview(args.conversationId, { cardId, info });
        resolve(info);
      }
    });
  }

  private emitReview(
    conversationId: UUID,
    payload: { cardId: string; info: ReviewInfo },
  ): void {
    const event: StreamEvent = {
      id: payload.cardId,
      timestamp: payload.info.startedAt,
      raw: '',
      kind: { type: 'reviewResult', info: payload.info },
      revision: 0,
    };
    this.emit({ type: 'stream', conversationId, events: [event] });
  }

  private async runOllama(args: {
    conversationId: UUID;
    reviewBackend: Backend;
    cwd: string;
    summary: PrimaryTurnSummary;
    ollamaModel?: string;
  }): Promise<ReviewInfo> {
    const round = (this.rounds.get(args.conversationId) ?? 0) + 1;
    this.rounds.set(args.conversationId, round);

    const cardId = randomUUID();
    const startedAt = Date.now();

    this.emitReview(args.conversationId, {
      cardId,
      info: {
        backend: args.reviewBackend,
        text: '',
        isRunning: true,
        startedAt,
        round,
        mode: 'review',
      },
    });

    const model = args.ollamaModel?.trim();
    if (!model) {
      const info: ReviewInfo = {
        backend: args.reviewBackend,
        text: '',
        isRunning: false,
        error: 'No Ollama model available. Pull one from the Local tab, or set a default model in Settings.',
        startedAt,
        round,
        mode: 'review',
      };
      this.emitReview(args.conversationId, { cardId, info });
      return info;
    }

    const messages: OllamaChatMessage[] = [
      { role: 'system', content: buildOllamaReviewSystem() },
      { role: 'user', content: buildReviewPrompt(args.summary, round) },
    ];

    const controller = new AbortController();
    this.inFlightHttp.set(args.conversationId, controller);

    let acc = '';
    let lastEmit = 0;
    let errorMessage: string | undefined;

    await streamChat({ model, messages, signal: controller.signal }, (ev) => {
      if (ev.type === 'token') {
        acc += ev.text;
        const now = Date.now();
        if (now - lastEmit > 100) {
          lastEmit = now;
          this.emitReview(args.conversationId, {
            cardId,
            info: {
              backend: args.reviewBackend,
              text: acc,
              isRunning: true,
              startedAt,
              round,
              mode: 'review',
            },
          });
        }
      } else if (ev.type === 'error') {
        errorMessage = ev.message;
      }
    });

    this.inFlightHttp.delete(args.conversationId);

    const info: ReviewInfo = {
      backend: args.reviewBackend,
      text: acc.trim(),
      isRunning: false,
      error: errorMessage,
      startedAt,
      round,
      mode: 'review',
      raw: acc.trim() || undefined,
    };
    this.emitReview(args.conversationId, { cardId, info });
    return info;
  }
}

function buildOllamaReviewSystem(): string {
  // Local models run out of steam faster than cloud frontier models, so
  // we tell them explicitly what shape of answer we want. Keeps the
  // response on-rails and short.
  return [
    'You are a code reviewer. Your job is to read what another coding agent did in the previous turn and give a brief, practical critique.',
    'Be direct. If it looks fine, say so in one sentence.',
    'If something is wrong or risky, name the specific issue and suggest a fix in 1-2 sentences.',
    'Avoid generic advice. Avoid long explanations. No preamble.',
  ].join(' ');
}

export function buildReviewPrompt(summary: PrimaryTurnSummary, round: number): string {
  // Tight framing — codex exec echoes the prompt in its stdout, so extra
  // words here directly bloat the raw view. First round gets the role;
  // later rounds skip it.
  const body = [
    `User: ${summary.userPrompt}`,
    '',
    `${summary.primaryBackend}: ${summary.assistantText || '(no text)'}`,
  ];
  if (summary.toolActivity && summary.toolActivity !== '(no tools used)') {
    body.push('', `Tools: ${summary.toolActivity}`);
  }
  if (round === 1) {
    return [
      `Sanity-check the turn below by ${summary.primaryBackend}. Reply briefly: what's wrong or "looks fine". Ground it in the code.`,
      '',
      ...body,
    ].join('\n');
  }
  return body.join('\n');
}

export function buildReviewerArgs(backend: Backend): string[] {
  switch (backend) {
    case 'claude':
      // `-p -` reads the prompt from stdin, returns a single final
      // assistant message. No --output-format so we get plain text,
      // which is what the review card displays.
      return ['-p', '-'];
    case 'codex':
      // codex exec: one-shot version of codex proto. `-` tells it to
      // read the user prompt from stdin. --skip-git-repo-check lets the
      // reviewer run when cwd is a synthetic workspace/coordinator root
      // (a dir of symlinks that isn't itself a git repo).
      return ['exec', '--skip-git-repo-check', '-'];
    case 'gemini':
      // gemini CLI also supports stdin prompt via `-p -`.
      return ['-p', '-'];
    case 'ollama':
      // Ollama as reviewer would need a separate HTTP flow; not wired
      // yet. Picker disables Ollama in ReboundPicker so this shouldn't
      // be reached.
      throw new Error('Ollama reviewer not implemented');
  }
}

/// Pull display text out of whatever stdout the reviewer is producing.
/// Claude/Gemini run without --output-format so stdout is plain assistant
/// text. Codex exec emits a structured transcript — banner, config block,
/// echoed user instructions, thinking summaries, then the actual "codex"
/// response, then a token-usage footer — and we want only the final
/// response to land in the review card.
export function extractReviewerDisplay(raw: string, backend: Backend): string {
  if (!raw) return '';
  if (backend === 'codex') return extractCodexDisplay(raw);
  return raw.trim();
}

function extractCodexDisplay(raw: string): string {
  // codex exec stdout is a sequence of "[ISO-timestamp] <tag>\n<body>"
  // sections. We keep only sections tagged exactly "codex"; the rest
  // (banner/config block, "User instructions:", "thinking", "tokens used:")
  // are noise for the reviewer card.
  const tsLine = /^\[\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\][ \t]*(.*?)[ \t]*$/gm;
  const sections: Array<{ tag: string; bodyStart: number; markerStart: number }> = [];
  for (const m of raw.matchAll(tsLine)) {
    const idx = m.index ?? 0;
    sections.push({ tag: (m[1] ?? '').trim(), bodyStart: idx + m[0].length, markerStart: idx });
  }
  if (sections.length === 0) {
    // No structured tags yet (very early in the stream) — best-effort strip
    // of the token-usage footer so at least nothing spurious shows.
    return raw.replace(/Token usage:.*$/ms, '').trim();
  }
  const bodies: string[] = [];
  for (let i = 0; i < sections.length; i++) {
    const cur = sections[i]!;
    if (cur.tag !== 'codex') continue;
    const end = sections[i + 1]?.markerStart ?? raw.length;
    const body = raw.slice(cur.bodyStart, end).trim();
    if (body) bodies.push(body);
  }
  return bodies.join('\n\n');
}
