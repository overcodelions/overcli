// Reviewer ("rebound") subprocess. Fires a claude/codex/gemini run after
// each primary turn, streams its output back as reviewResult events
// tagged with the owning conversation id. Default is one short-lived
// subprocess per turn (mirrors Swift's ReviewerSession). Codex in collab
// mode is the exception: we keep a persistent app-server client per
// conversation so successive rounds reuse the codex thread instead of
// paying cold-start each time.

import { spawn, ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { Backend, MainToRendererEvent, ReviewInfo, StreamEvent, UUID } from '../shared/types';
import { backendNeedsShell, buildBackendEnv, resolveBackendPath } from './backendPaths';
import {
  CodexAppServerApprovalPolicy,
  CodexAppServerClient,
  CodexAppServerSandboxMode,
} from './codex-app-server';
import { OllamaChatMessage, streamChat } from './ollama';

type Emit = (event: MainToRendererEvent) => void;

interface PrimaryTurnSummary {
  primaryBackend: string;
  userPrompt: string;
  assistantText: string;
  toolActivity: string;
}

interface CodexCollabActiveRound {
  cardId: string;
  startedAt: number;
  round: number;
  /// Text accumulated per agentMessage item id, in arrival order. Codex
  /// can emit multiple agentMessage items in one turn (e.g. text →
  /// command/patch → more text in yolo collab), and the rendered card
  /// is the concatenation of all of them.
  textByItem: Map<string, string>;
  lastEmit: number;
  resolve: (info: ReviewInfo) => void;
}

function joinCollabText(textByItem: Map<string, string>): string {
  return Array.from(textByItem.values()).filter(Boolean).join('\n\n');
}

interface CodexCollabSession {
  client: CodexAppServerClient;
  cwd: string;
  yolo: boolean;
  /// In-flight round, if any. Cleared on turn/completed or error.
  active?: CodexCollabActiveRound;
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
  /// Persistent codex app-server reviewer per conversation, used in
  /// collab mode so each round reuses the same codex thread instead of
  /// spawning a fresh `codex exec` subprocess. Lazily created on first
  /// collab round and disposed only on full shutdown / cwd change.
  private codexCollab = new Map<UUID, CodexCollabSession>();
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
    // Codex collab: cancellation invalidates the persistent thread.
    // turn/interrupt is best-effort — codex may keep streaming item/* or
    // turn/completed for the cancelled turn for a while. If we kept the
    // client warm, those late notifications would land after the next
    // round's tryRunCodexCollab reassigned session.active and would
    // either smear text into the wrong bubble or prematurely finish it.
    // Killing forces a fresh client + thread on the next round, which
    // costs one cold start but keeps round boundaries clean.
    const collab = this.codexCollab.get(conversationId);
    if (collab) {
      const a = collab.active;
      collab.active = undefined;
      this.codexCollab.delete(conversationId);
      collab.client.kill();
      if (a) {
        const final: ReviewInfo = {
          backend: 'codex',
          text: joinCollabText(a.textByItem).trim(),
          isRunning: false,
          error: 'Cancelled',
          startedAt: a.startedAt,
          round: a.round,
          mode: 'collab',
        };
        this.emitReview(conversationId, { cardId: a.cardId, info: final });
        a.resolve(final);
      }
    }
  }

  /// Tear down any persistent reviewer state for the conversation. Use
  /// when the conversation is going away or its rebound config no longer
  /// matches the persistent backend (e.g. user switched away from codex).
  /// Today this is equivalent to stop() because stop() already kills the
  /// codex client; kept as a separate name so call sites read clearly
  /// (stop = "cancel current", dispose = "this conversation is going away").
  dispose(conversationId: UUID): void {
    this.stop(conversationId);
    const collab = this.codexCollab.get(conversationId);
    if (collab) {
      collab.client.kill();
      this.codexCollab.delete(conversationId);
    }
  }

  stopAll(): void {
    for (const id of Array.from(this.inFlight.keys())) this.stop(id);
    for (const id of Array.from(this.inFlightHttp.keys())) this.stop(id);
    for (const id of Array.from(this.codexCollab.keys())) this.dispose(id);
  }

  /// Fire a reviewer for the just-completed primary turn. Resolves when
  /// the reviewer exits; events stream through `emit` as they arrive.
  async run(args: {
    conversationId: UUID;
    reviewBackend: Backend;
    /// Plain `review` runs once and stops; `collab` ping-pongs the
    /// reviewer's response back into the primary, so the badge text
    /// and the persistent-session decision both depend on this.
    reviewMode?: 'review' | 'collab' | null;
    cwd: string;
    summary: PrimaryTurnSummary;
    backendPathOverride?: string;
    /// Ollama reviewer model tag; ignored for other backends.
    ollamaModel?: string;
    /// Codex-only yolo toggle: run the reviewer with a workspace-write
    /// sandbox and auto-approval. Ignored for other backends (Claude and
    /// Gemini reviewer CLIs don't expose an equivalent flag here).
    yolo?: boolean;
  }): Promise<ReviewInfo> {
    // Kill any prior in-flight reviewer for this conversation. Happens
    // if the user sent a follow-up turn before the reviewer finished.
    this.stop(args.conversationId);

    const mode: 'review' | 'collab' = args.reviewMode === 'collab' ? 'collab' : 'review';

    if (args.reviewBackend === 'ollama') {
      return this.runOllama({ ...args, mode });
    }

    // Codex collab: persistent app-server thread, reused across rounds.
    // Falls back to the one-shot subprocess path below if the codex
    // binary isn't on PATH or the client fails to start.
    if (args.reviewBackend === 'codex' && mode === 'collab') {
      const persisted = await this.tryRunCodexCollab(args);
      if (persisted) return persisted;
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
        mode,
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
        mode,
      };
      this.emitReview(args.conversationId, { cardId, info });
      return info;
    }

    return new Promise<ReviewInfo>((resolve) => {
      const childArgs = buildReviewerArgs(args.reviewBackend, { yolo: !!args.yolo });
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
              mode,
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
          mode,
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
          mode,
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
          mode,
        };
        this.emitReview(args.conversationId, { cardId, info });
        resolve(info);
      }
    });
  }

  /// Attempts a persistent codex app-server reviewer round. Returns the
  /// finished ReviewInfo on success, or `null` if we couldn't even start
  /// (binary missing) — caller falls back to the one-shot exec path.
  private async tryRunCodexCollab(args: {
    conversationId: UUID;
    cwd: string;
    summary: PrimaryTurnSummary;
    backendPathOverride?: string;
    yolo?: boolean;
  }): Promise<ReviewInfo | null> {
    const bin = resolveBackendPath('codex', args.backendPathOverride);
    if (!bin) return null;

    const round = (this.rounds.get(args.conversationId) ?? 0) + 1;
    this.rounds.set(args.conversationId, round);

    const cardId = randomUUID();
    const startedAt = Date.now();
    const yolo = !!args.yolo;

    this.emitReview(args.conversationId, {
      cardId,
      info: {
        backend: 'codex',
        text: '',
        isRunning: true,
        startedAt,
        round,
        mode: 'collab',
      },
    });

    // Reuse an existing client only if cwd & yolo still match; otherwise
    // tear it down and start fresh so sandbox semantics stay correct.
    let session = this.codexCollab.get(args.conversationId);
    if (session && (session.cwd !== args.cwd || session.yolo !== yolo)) {
      session.client.kill();
      this.codexCollab.delete(args.conversationId);
      session = undefined;
    }
    if (!session) {
      const env = buildBackendEnv(process.env, bin);
      const client = new CodexAppServerClient({ binary: bin, cwd: args.cwd, env });
      session = { client, cwd: args.cwd, yolo };
      this.codexCollab.set(args.conversationId, session);
      this.wireCodexCollabClient(args.conversationId, session);
    }

    const sandbox: CodexAppServerSandboxMode = yolo ? 'workspace-write' : 'read-only';
    const approval: CodexAppServerApprovalPolicy = 'never';

    return new Promise<ReviewInfo>((resolve) => {
      session!.active = {
        cardId,
        startedAt,
        round,
        textByItem: new Map(),
        lastEmit: 0,
        resolve,
      };
      const prompt = buildReviewPrompt(args.summary, round);
      void session!.client
        .sendUserInput(prompt, {
          cwd: args.cwd,
          model: '',
          sandbox,
          approval,
        })
        .catch((err: any) => {
          if (!session!.active || session!.active.cardId !== cardId) return;
          const message = err?.message ?? String(err);
          session!.active = undefined;
          // Drop the now-broken client so the next round starts cleanly.
          session!.client.kill();
          this.codexCollab.delete(args.conversationId);
          const info: ReviewInfo = {
            backend: 'codex',
            text: '',
            isRunning: false,
            error: message,
            startedAt,
            round,
            mode: 'collab',
          };
          this.emitReview(args.conversationId, { cardId, info });
          resolve(info);
        });
    });
  }

  private wireCodexCollabClient(conversationId: UUID, session: CodexCollabSession): void {
    session.client.on('notification', ({ method, params }) => {
      // Reject events from a session that's been replaced. After we
      // kill+respawn on cancel, the dying client may still parse a few
      // more JSON-RPC lines off its stdout buffer; without this guard
      // those late item/* or turn/completed events would mutate the new
      // session's active round.
      if (this.codexCollab.get(conversationId) !== session) return;
      const a = session.active;
      if (!a) return;
      switch (method) {
        case 'item/started':
        case 'item/completed': {
          const item = params?.item;
          if (item?.type === 'agentMessage' && typeof item.text === 'string') {
            const itemId = String(item.id ?? '');
            // Overwrite the per-item text — item/completed carries the
            // final full text for this item, item/started carries the
            // initial chunk (often empty). Other items in the same turn
            // keep their entries in textByItem so the rendered card is
            // the union, in arrival order.
            if (itemId) a.textByItem.set(itemId, item.text);
            this.maybeEmitCodexCollabProgress(conversationId, session);
          }
          break;
        }
        case 'item/agentMessage/delta': {
          const itemId = String(params?.itemId ?? '');
          if (itemId && typeof params?.delta === 'string') {
            a.textByItem.set(itemId, (a.textByItem.get(itemId) ?? '') + params.delta);
          }
          this.maybeEmitCodexCollabProgress(conversationId, session);
          break;
        }
        case 'turn/completed': {
          const text = joinCollabText(a.textByItem).trim();
          const final: ReviewInfo = {
            backend: 'codex',
            text,
            isRunning: false,
            startedAt: a.startedAt,
            round: a.round,
            mode: 'collab',
            raw: text || undefined,
          };
          session.active = undefined;
          this.emitReview(conversationId, { cardId: a.cardId, info: final });
          a.resolve(final);
          break;
        }
        case 'error': {
          const message = typeof params?.message === 'string' ? params.message : 'codex app-server error';
          const final: ReviewInfo = {
            backend: 'codex',
            text: joinCollabText(a.textByItem).trim(),
            isRunning: false,
            error: message,
            startedAt: a.startedAt,
            round: a.round,
            mode: 'collab',
          };
          session.active = undefined;
          this.emitReview(conversationId, { cardId: a.cardId, info: final });
          a.resolve(final);
          break;
        }
      }
    });
    // The reviewer runs autonomously — auto-decline any approval prompts
    // codex sends rather than blocking forever waiting for user input.
    session.client.on('request', ({ id }) => {
      if (this.codexCollab.get(conversationId) !== session) return;
      void session.client.rejectServerRequest(id, 'Reviewer auto-decline');
    });
    session.client.on('close', () => {
      // Only clear the map slot if it's still pointing at THIS session.
      // After a kill-on-cancel, a fresh session may already occupy this
      // conversation id, and the dying client's close event must not
      // evict it.
      const current = this.codexCollab.get(conversationId);
      if (current === session) this.codexCollab.delete(conversationId);
      const a = session.active;
      if (!a) return;
      session.active = undefined;
      const final: ReviewInfo = {
        backend: 'codex',
        text: joinCollabText(a.textByItem).trim(),
        isRunning: false,
        error: 'codex app-server closed',
        startedAt: a.startedAt,
        round: a.round,
        mode: 'collab',
      };
      this.emitReview(conversationId, { cardId: a.cardId, info: final });
      a.resolve(final);
    });
  }

  private maybeEmitCodexCollabProgress(conversationId: UUID, session: CodexCollabSession): void {
    const a = session.active;
    if (!a) return;
    const now = Date.now();
    if (now - a.lastEmit < 100) return;
    a.lastEmit = now;
    this.emitReview(conversationId, {
      cardId: a.cardId,
      info: {
        backend: 'codex',
        text: joinCollabText(a.textByItem),
        isRunning: true,
        startedAt: a.startedAt,
        round: a.round,
        mode: 'collab',
      },
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
    mode: 'review' | 'collab';
  }): Promise<ReviewInfo> {
    const { mode } = args;
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
        mode,
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
        mode,
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
              mode,
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
      mode,
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

export function buildReviewerArgs(
  backend: Backend,
  opts: { yolo?: boolean } = {},
): string[] {
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
      // Yolo: opt into workspace-write + auto-approval so the reviewer
      // can actually edit files. Default is codex's own read-only
      // sandbox, which is why a review that wants to patch code
      // previously bounced with a "read-only session" message.
      return opts.yolo
        ? [
            'exec',
            '--skip-git-repo-check',
            '--sandbox',
            'workspace-write',
            '--ask-for-approval',
            'never',
            '-',
          ]
        : ['exec', '--skip-git-repo-check', '-'];
    case 'gemini':
      // gemini CLI also supports stdin prompt via `-p -`.
      return ['-p', '-'];
    case 'ollama':
      // Ollama doesn't go through a CLI subprocess at all — run() routes
      // it to runOllama() before reaching this builder. Throw if we ever
      // get here, since it means the dispatch in run() was bypassed.
      throw new Error('Ollama reviewer is dispatched via runOllama, not buildReviewerArgs');
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
