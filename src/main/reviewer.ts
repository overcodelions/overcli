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
import {
  CodexAppServerParserState,
  makeCodexAppServerParserState,
  parseCodexAppServerNotification,
} from './parsers/codex-app-server';
import { OllamaChatMessage, streamChat } from './ollama';
import { resolveSymlinkWritableRoots } from './workspace';

type Emit = (event: MainToRendererEvent) => void;

interface PrimaryTurnSummary {
  primaryBackend: string;
  userPrompt: string;
  assistantText: string;
  toolActivity: string;
}

interface CodexReviewerActiveTurn {
  startedAt: number;
  round: number;
  /// Mode this round was fired in. Used as the per-event reviewer tag
  /// and surfaced by the renderer's "Codex · collab · round 2" header.
  mode: 'review' | 'collab';
  /// Per-round parser state. We use the same translator the primary
  /// codex path uses, so reasoning items become thinking text, command/
  /// patch items become tool cards, and agentMessage items become the
  /// reviewer's assistant text. Resetting per round keeps item ids from
  /// smearing into the next round's bubbles.
  parserState: CodexAppServerParserState;
  /// agentMessage text per emitted assistant event id. Each delta of a
  /// codex agentMessage emits an `assistant` event (same id) carrying
  /// the running snapshot — `text="I"`, then `"I'm"`, then `"I'm
  /// checking"`, … — so we can't push-on-every-emit without ending up
  /// with every streaming snapshot in the joined feed-back prompt.
  /// Storing by id and overwriting keeps just the final text per item;
  /// the values join in insertion order (= arrival order of items) at
  /// turn/completed.
  assistantTextsById: Map<string, string>;
  /// Most recently emitted text-bearing assistant event. Updated on
  /// every delta so it stays current; at turn/completed we re-emit it
  /// with `reviewer.verdict: true` so the renderer can mark exactly
  /// one bubble per round as the verdict (and dim the others). Must
  /// be text-bearing because codex tool starts (commandExecution,
  /// fileChange) emit `assistant` events with toolUses and no text —
  /// we don't want them claiming the verdict slot.
  lastTextAssistant?: StreamEvent;
  resolve: (info: ReviewInfo) => void;
}

function joinAssistantTexts(textsById: Map<string, string>): string {
  return Array.from(textsById.values())
    .map((t) => t.trim())
    .filter(Boolean)
    .join('\n\n');
}

interface CodexReviewerSession {
  client: CodexAppServerClient;
  cwd: string;
  yolo: boolean;
  /// In-flight round, if any. Cleared on turn/completed or error.
  active?: CodexReviewerActiveTurn;
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
  /// review and collab modes so each round reuses the same codex thread
  /// instead of spawning a fresh `codex exec` subprocess. Lazily created
  /// on first round and disposed only on full shutdown / cwd change.
  private codexSessions = new Map<UUID, CodexReviewerSession>();
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
    // Cancel any in-flight codex turn but leave an idle warm session
    // alone so the next collab round can reuse the same thread. We only
    // kill the client when there's an active turn: turn/interrupt is
    // best-effort and codex may keep streaming item/* or turn/completed
    // for the cancelled turn for a while; if we left that client running
    // those late notifications would land after the next round's
    // tryRunCodexAppServer reassigned session.active and smear text into
    // the wrong bubble. With no in-flight turn there's nothing to smear,
    // so the cache stays useful.
    const codex = this.codexSessions.get(conversationId);
    if (codex && codex.active) {
      const a = codex.active;
      codex.active = undefined;
      this.codexSessions.delete(conversationId);
      codex.client.kill();
      this.emitReviewerSystemNotice(conversationId, a, 'Cancelled');
      const final: ReviewInfo = {
        backend: 'codex',
        text: joinAssistantTexts(a.assistantTextsById),
        isRunning: false,
        error: 'Cancelled',
        startedAt: a.startedAt,
        round: a.round,
        mode: a.mode,
      };
      a.resolve(final);
    }
  }

  /// Tear down any persistent reviewer state for the conversation,
  /// including idle warm codex sessions that stop() leaves alone. Use
  /// when the conversation is going away or its rebound config no
  /// longer matches the persistent backend (e.g. user switched away
  /// from codex). stop() = "cancel any in-flight round, keep warm
  /// session"; dispose() = "this conversation is going away, kill
  /// everything".
  dispose(conversationId: UUID): void {
    this.stop(conversationId);
    const codex = this.codexSessions.get(conversationId);
    if (codex) {
      codex.client.kill();
      this.codexSessions.delete(conversationId);
    }
  }

  stopAll(): void {
    for (const id of Array.from(this.inFlight.keys())) this.stop(id);
    for (const id of Array.from(this.inFlightHttp.keys())) this.stop(id);
    for (const id of Array.from(this.codexSessions.keys())) this.dispose(id);
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

    // Codex collab uses the persistent app-server transport so each
    // round reuses the same thread. Plain review stays on `codex exec`
    // because exec's stdout parser tags reasoning-style narration as
    // [thinking] sections that we strip — the app-server stream emits
    // the same narration as agentMessage items, which we'd have no
    // clean way to filter, and the review card ends up as a wall of
    // process-narration instead of just the verdict. Falls back to
    // exec when the binary isn't on PATH.
    if (args.reviewBackend === 'codex' && mode === 'collab') {
      const persisted = await this.tryRunCodexAppServer({ ...args, mode });
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
      const childArgs = buildReviewerArgs(args.reviewBackend, {
        yolo: !!args.yolo,
        // Lifts coordinator-root symlink targets into codex's writable
        // set so `--sandbox workspace-write` doesn't deny edits that
        // resolve outside the coordinator's cwd subtree.
        writableRoots:
          args.reviewBackend === 'codex' && args.yolo
            ? resolveSymlinkWritableRoots(args.cwd)
            : undefined,
      });
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

  /// Run a codex reviewer round through the persistent app-server
  /// transport. Returns the finished ReviewInfo on success, or `null`
  /// if we couldn't start (binary missing) — caller falls back to the
  /// one-shot exec path.
  private async tryRunCodexAppServer(args: {
    conversationId: UUID;
    cwd: string;
    summary: PrimaryTurnSummary;
    backendPathOverride?: string;
    yolo?: boolean;
    mode: 'review' | 'collab';
  }): Promise<ReviewInfo | null> {
    const bin = resolveBackendPath('codex', args.backendPathOverride);
    if (!bin) return null;

    const round = (this.rounds.get(args.conversationId) ?? 0) + 1;
    this.rounds.set(args.conversationId, round);

    const startedAt = Date.now();
    const yolo = !!args.yolo;
    const { mode } = args;

    // Reuse an existing client only if cwd & yolo still match; otherwise
    // tear it down and start fresh so sandbox semantics stay correct.
    let session = this.codexSessions.get(args.conversationId);
    if (session && (session.cwd !== args.cwd || session.yolo !== yolo)) {
      session.client.kill();
      this.codexSessions.delete(args.conversationId);
      session = undefined;
    }
    if (!session) {
      const env = buildBackendEnv(process.env, bin);
      const client = new CodexAppServerClient({ binary: bin, cwd: args.cwd, env });
      session = { client, cwd: args.cwd, yolo };
      this.codexSessions.set(args.conversationId, session);
      this.wireCodexReviewerClient(args.conversationId, session);
    }

    const sandbox: CodexAppServerSandboxMode = yolo ? 'workspace-write' : 'read-only';
    const approval: CodexAppServerApprovalPolicy = 'never';

    const extraWritableRoots = yolo ? resolveSymlinkWritableRoots(args.cwd) : undefined;

    return new Promise<ReviewInfo>((resolve) => {
      session!.active = {
        startedAt,
        round,
        mode,
        parserState: makeCodexAppServerParserState(),
        assistantTextsById: new Map(),
        resolve,
      };
      const prompt = buildReviewPrompt(args.summary, round);
      void session!.client
        .sendUserInput(prompt, {
          cwd: args.cwd,
          model: '',
          sandbox,
          approval,
          writableRoots: extraWritableRoots,
        })
        .catch((err: any) => {
          // Guard against late catch resolving the wrong round — only
          // act if our active round is still the one we just started.
          const a = session!.active;
          if (!a || a.round !== round) return;
          const message = err?.message ?? String(err);
          session!.active = undefined;
          // Drop the now-broken client so the next round starts cleanly.
          session!.client.kill();
          this.codexSessions.delete(args.conversationId);
          this.emitReviewerSystemNotice(args.conversationId, a, message);
          resolve({
            backend: 'codex',
            text: '',
            isRunning: false,
            error: message,
            startedAt,
            round,
            mode,
          });
        });
    });
  }

  private wireCodexReviewerClient(conversationId: UUID, session: CodexReviewerSession): void {
    session.client.on('notification', ({ method, params, raw }) => {
      // Reject events from a session that's been replaced. After we
      // kill+respawn on cancel, the dying client may still parse a few
      // more JSON-RPC lines off its stdout buffer; without this guard
      // those late item/* or turn/completed events would mutate the new
      // session's active round.
      if (this.codexSessions.get(conversationId) !== session) return;
      const a = session.active;
      if (!a) return;

      // Route every notification through the same parser the primary
      // codex path uses, then tag the resulting events with reviewer
      // provenance and emit them on the conversation's normal stream.
      // The renderer treats a tagged event like a regular assistant /
      // tool / patch row and groups them under a "Codex · collab ·
      // round N" header.
      const parsed = parseCodexAppServerNotification(method, params, a.parserState, raw);
      if (parsed.events.length > 0) {
        // Strip the synthetic per-turn `result` event the parser appends
        // on turn/completed — the reviewer turn doesn't deserve a
        // duration/cost ResultRow in the chat. The reviewer's own end-
        // of-turn handler below resolves the ReviewInfo for the runner.
        const filtered = parsed.events.filter((e) => e.kind.type !== 'result');
        if (filtered.length > 0) {
          const tag = { backend: 'codex' as Backend, round: a.round, mode: a.mode };
          for (const ev of filtered) ev.reviewer = tag;
          // Capture text-bearing assistant events into the by-id map
          // (overwriting per-item) so the joined feed-back prompt has
          // each item's *final* text exactly once, regardless of how
          // many delta snapshots we saw stream by. Track the most
          // recently emitted text-bearing event so it can be promoted
          // to verdict on turn/completed.
          for (const ev of filtered) {
            if (ev.kind.type === 'assistant' && ev.kind.info.text) {
              a.assistantTextsById.set(ev.id, ev.kind.info.text);
              a.lastTextAssistant = ev;
            }
          }
          this.emit({ type: 'stream', conversationId, events: filtered });
        }
      }

      if (method === 'turn/completed') {
        // Verdict promotion: re-emit the last text-bearing assistant
        // event of the round with `reviewer.verdict: true`. The store
        // replaces by id, so the existing bubble updates in place — the
        // renderer reacts by drawing a check next to the CLI label and
        // dimming the other text bubbles in this round. This is the
        // only point where any event carries the verdict flag, so
        // mid-stream nothing reads as final or intermediate.
        if (a.lastTextAssistant) {
          const verdict: StreamEvent = {
            ...a.lastTextAssistant,
            reviewer: { ...a.lastTextAssistant.reviewer!, verdict: true },
          };
          this.emit({ type: 'stream', conversationId, events: [verdict] });
        }
        const joined = joinAssistantTexts(a.assistantTextsById);
        const final: ReviewInfo = {
          backend: 'codex',
          text: joined,
          isRunning: false,
          startedAt: a.startedAt,
          round: a.round,
          mode: a.mode,
          raw: joined || undefined,
        };
        session.active = undefined;
        a.resolve(final);
      } else if (method === 'error') {
        const message =
          typeof params?.message === 'string' ? params.message : 'codex app-server error';
        const joined = joinAssistantTexts(a.assistantTextsById);
        const final: ReviewInfo = {
          backend: 'codex',
          text: joined,
          isRunning: false,
          error: message,
          startedAt: a.startedAt,
          round: a.round,
          mode: a.mode,
        };
        session.active = undefined;
        this.emitReviewerSystemNotice(conversationId, a, message);
        a.resolve(final);
      }
    });
    // The reviewer runs autonomously — auto-decline any approval prompts
    // codex sends rather than blocking forever waiting for user input.
    session.client.on('request', ({ id }) => {
      if (this.codexSessions.get(conversationId) !== session) return;
      void session.client.rejectServerRequest(id, 'Reviewer auto-decline');
    });
    session.client.on('close', () => {
      // Only clear the map slot if it's still pointing at THIS session.
      // After a kill-on-cancel, a fresh session may already occupy this
      // conversation id, and the dying client's close event must not
      // evict it.
      const current = this.codexSessions.get(conversationId);
      if (current === session) this.codexSessions.delete(conversationId);
      const a = session.active;
      if (!a) return;
      session.active = undefined;
      this.emitReviewerSystemNotice(conversationId, a, 'codex app-server closed');
      a.resolve({
        backend: 'codex',
        text: joinAssistantTexts(a.assistantTextsById),
        isRunning: false,
        error: 'codex app-server closed',
        startedAt: a.startedAt,
        round: a.round,
        mode: a.mode,
      });
    });
  }

  /// Surface a reviewer-side error/cancellation as a tagged systemNotice
  /// so the chat shows what happened inline with the rebound block,
  /// rather than silently dropping the round.
  private emitReviewerSystemNotice(
    conversationId: UUID,
    a: CodexReviewerActiveTurn,
    text: string,
  ): void {
    this.emit({
      type: 'stream',
      conversationId,
      events: [
        {
          id: randomUUID(),
          timestamp: Date.now(),
          raw: '',
          kind: { type: 'systemNotice', text },
          revision: 0,
          reviewer: { backend: 'codex', round: a.round, mode: a.mode },
        },
      ],
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
  opts: { yolo?: boolean; writableRoots?: string[] } = {},
): string[] {
  switch (backend) {
    case 'claude':
      // `-p -` reads the prompt from stdin, returns a single final
      // assistant message. No --output-format so we get plain text,
      // which is what the review card displays.
      return ['-p', '-'];
    case 'codex': {
      // codex exec: one-shot version of codex proto. `-` tells it to
      // read the user prompt from stdin. --skip-git-repo-check lets the
      // reviewer run when cwd is a synthetic workspace/coordinator root
      // (a dir of symlinks that isn't itself a git repo).
      // Yolo: opt into workspace-write + auto-approval so the reviewer
      // can actually edit files. Default is codex's own read-only
      // sandbox, which is why a review that wants to patch code
      // previously bounced with a "read-only session" message.
      // `-s` and `-a` are TOP-LEVEL codex flags — they have to come
      // before `exec`. Putting them after `exec` makes the codex parser
      // reject `--ask-for-approval` as an unknown exec argument.
      if (!opts.yolo) return ['exec', '--skip-git-repo-check', '-'];
      const extras: string[] = [];
      for (const r of opts.writableRoots ?? []) {
        if (!r) continue;
        extras.push('--add-dir', r);
      }
      return [
        '-s',
        'workspace-write',
        '-a',
        'never',
        'exec',
        '--skip-git-repo-check',
        ...extras,
        '-',
      ];
    }
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
