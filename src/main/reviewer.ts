// Reviewer ("rebound") subprocess. Fires a claude/codex/gemini run after
// each primary turn, streams its output back as reviewResult events
// tagged with the owning conversation id. Default is one short-lived
// subprocess per turn (mirrors Swift's ReviewerSession). Codex in collab
// mode is the exception: we keep a persistent app-server client per
// conversation so successive rounds reuse the codex thread instead of
// paying cold-start each time.

import { spawn, spawnSync, ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  Backend,
  EffortLevel,
  MainToRendererEvent,
  PersonaKey,
  ReviewInfo,
  StreamEvent,
  UUID,
} from '../shared/types';
import { backendNeedsShell, buildBackendEnv, resolveBackendPath } from './backendPaths';
import {
  PERSONA_EFFORT,
  PERSONA_PREAMBLES,
  defaultAllGoodVerdict,
} from '../shared/reboundPresets';
import { summarizeToolUse } from './toolDescription';
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
  /// Earlier exchanges in the same conversation, oldest first. The
  /// reviewer needs them to make sense of replies like "ok 2" — without
  /// the prior question that "2" was answering, every short follow-up
  /// reads as ambiguous. Rendered above the current turn in the prompt.
  /// Optional so test fixtures and legacy call sites don't have to set
  /// it; treated as empty when absent.
  priorTurns?: { userPrompt: string; assistantText: string }[];
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
  /// Claude reviewer session id per conversation. Captured from the
  /// system_init event of the first review's stream-json output and
  /// passed to subsequent reviews via `--resume <id>` so Claude reuses
  /// the same conversation thread on its side. That lets the API-level
  /// prompt cache hit on the persona + transcript prefix, and lets us
  /// strip priorTurns from the prompt entirely (Claude already
  /// remembers them in the resumed session).
  private claudeReviewerSessions = new Map<UUID, string>();
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
    // Drop the captured claude session id so a new conversation that
    // happens to reuse this id (post-dispose) doesn't accidentally
    // resume into the prior conversation's reviewer thread.
    this.claudeReviewerSessions.delete(conversationId);
  }

  stopAll(): void {
    for (const id of Array.from(this.inFlight.keys())) this.stop(id);
    for (const id of Array.from(this.inFlightHttp.keys())) this.stop(id);
    for (const id of Array.from(this.codexSessions.keys())) this.dispose(id);
    this.claudeReviewerSessions.clear();
  }

  /// Reset the per-conversation round counter so the next reviewer run
  /// starts at "round 1". Called by the runner when a new collab burst
  /// begins (human-originated send), so the round number rendered in
  /// `ReviewerHeader` / `ReviewCard` reflects the burst-relative round
  /// instead of the lifetime count.
  resetRounds(conversationId: UUID): void {
    this.rounds.delete(conversationId);
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
    /// Reviewer model override for claude/codex/gemini. Passed as
    /// `--model X` (claude) or `-m X` (codex/gemini). Use ollamaModel
    /// for the ollama path instead.
    reviewModel?: string | null;
    /// Reviewer persona key. Resolved into a prompt preamble inside
    /// buildReviewPrompt — the table lives in reboundPresets.ts.
    reviewPersona?: PersonaKey | null;
    /// Persisted reviewer session ids per backend (from a prior app
    /// session). When present for the active reviewer backend and we
    /// don't already have an in-memory entry, we prime the map so the
    /// next reviewer invocation resumes the warm thread across app
    /// restarts. Ignored once the in-memory entry exists.
    reviewerSessionIds?: Partial<Record<Backend, string>>;
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

    // Codex always uses the persistent app-server transport so the
    // reviewer thread stays warm across reviews in the same
    // conversation. Verdict promotion (in wireCodexReviewerClient)
    // handles the noisier output stream — the last text-bearing
    // assistant event becomes the verdict and intermediate narration
    // is dimmed. Falls back to one-shot exec when the binary isn't on
    // PATH or app-server fails to start.
    if (args.reviewBackend === 'codex') {
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

    // Claude warm-resume: if we captured a session id from a previous
    // review in this conversation, pass it via --resume and strip
    // priorTurns from the prompt (the resumed Claude session already
    // has them). Prime the in-memory map from the persisted hint
    // (carried on the conversation across app restarts) when we don't
    // yet have an entry — first review post-restart picks up where
    // the previous app session left off.
    const persistedClaudeId = args.reviewerSessionIds?.claude;
    if (
      args.reviewBackend === 'claude' &&
      persistedClaudeId &&
      !this.claudeReviewerSessions.has(args.conversationId)
    ) {
      this.claudeReviewerSessions.set(args.conversationId, persistedClaudeId);
    }
    const claudeResumeId =
      args.reviewBackend === 'claude'
        ? this.claudeReviewerSessions.get(args.conversationId) ?? null
        : null;
    const summary =
      claudeResumeId ? { ...args.summary, priorTurns: [] } : args.summary;
    const prompt = buildReviewPrompt(summary, round, args.reviewPersona ?? null);
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
        model: args.reviewModel ?? null,
        resumeSessionId: claudeResumeId,
        effort: args.reviewPersona ? PERSONA_EFFORT[args.reviewPersona] : undefined,
        // Skip `--effort` when the user's claude CLI is too old to
        // know it — otherwise the subprocess dies immediately with
        // `error: unknown option '--effort'`. Probed (and cached) per
        // binary path; no-op for codex/gemini.
        effortSupported:
          args.reviewBackend === 'claude' ? claudeSupportsEffort(bin) : undefined,
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
        // For claude we also pull thinking content + tool activity so
        // the renderer can show "what was checked" and live tool calls
        // above the verdict — gives users visible signal that the
        // model actually worked.
        const displayed = extractReviewerDisplay(stdout, args.reviewBackend);
        let thinking = '';
        let toolActivity: string[] | undefined;
        if (args.reviewBackend === 'claude') {
          const parsed = parseClaudeStreamJson(stdout);
          thinking = parsed.thinking;
          if (parsed.toolActivity.length > 0) toolActivity = parsed.toolActivity;
        }
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
              thinking: thinking || undefined,
              toolActivity,
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
        let finalThinking: string | undefined;
        let finalToolActivity: string[] | undefined;
        // Capture claude session id so the next review can --resume.
        // Only on a clean exit — a non-zero exit means the session may
        // not be reusable and we'd rather start fresh next time. While
        // we're parsing, also grab the final thinking content +
        // tool activity for the verdict card.
        if (args.reviewBackend === 'claude' && code === 0) {
          const parsed = parseClaudeStreamJson(stdout);
          if (parsed.sessionId) {
            const prev = this.claudeReviewerSessions.get(args.conversationId);
            this.claudeReviewerSessions.set(args.conversationId, parsed.sessionId);
            if (prev !== parsed.sessionId) {
              this.emit({
                type: 'reviewerSessionConfigured',
                conversationId: args.conversationId,
                reviewBackend: 'claude',
                sessionId: parsed.sessionId,
              });
            }
          }
          finalThinking = parsed.thinking || undefined;
          finalToolActivity = parsed.toolActivity.length > 0 ? parsed.toolActivity : undefined;
        }
        let finalText = extractReviewerDisplay(stdout, args.reviewBackend);
        // Empty-output rescue: Opus on `--effort low` (notably the
        // critic persona used by cheap-and-paranoid) sometimes exits
        // with zero content blocks when it has nothing critical to
        // add. The CLI returns code 0 with `result: ""` and a few
        // end-of-turn tokens. Show the persona's "all good" phrase
        // instead of "(no output)" — captures the model's intent
        // ("nothing to flag") in a form that flows through the rest
        // of the pipeline correctly (the all-good detection skips the
        // synthetic feedback round, the card displays a real verdict).
        if (!finalText.trim() && code === 0 && args.reviewPersona) {
          finalText = defaultAllGoodVerdict(args.reviewPersona);
        }
        const info: ReviewInfo = {
          backend: args.reviewBackend,
          text: finalText,
          isRunning: false,
          error: code === 0 ? undefined : stderr.trim() || `exit ${code}`,
          startedAt,
          round,
          mode,
          thinking: finalThinking,
          toolActivity: finalToolActivity,
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
    reviewModel?: string | null;
    reviewPersona?: PersonaKey | null;
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
    // Capture warm-vs-cold BEFORE we (possibly) create a fresh session
    // below. A warm session means the codex thread already has the prior
    // conversation in its memory, so we skip priorTurns in the prompt
    // and send only the new exchange — saves real tokens on smart-tier
    // reviewer presets, and lets cache reuse kick in inside codex too.
    const warm = !!session;
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
      // On warm rounds, strip priorTurns from the summary — the codex
      // thread already remembers them.
      const summary = warm ? { ...args.summary, priorTurns: [] } : args.summary;
      const prompt = buildReviewPrompt(summary, round, args.reviewPersona ?? null);
      // Persona-driven reasoning effort. Codex's app-server takes the
      // same EffortLevel union the primary uses; mapping to its API
      // value happens inside codexAppServerEffort. Falls through as
      // undefined when no persona is set (e.g. preset = 'independent').
      const personaEffort: EffortLevel | undefined = args.reviewPersona
        ? PERSONA_EFFORT[args.reviewPersona]
        : undefined;
      void session!.client
        .sendUserInput(prompt, {
          cwd: args.cwd,
          model: args.reviewModel?.trim() || '',
          sandbox,
          approval,
          writableRoots: extraWritableRoots,
          effortLevel: personaEffort,
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
    reviewPersona?: PersonaKey | null;
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

    // Persona, when set, overrides the generic critic system prompt —
    // ollama models stay on-rails better with the same persona text we
    // give the cloud CLIs, since they're the ones tuned for it.
    const systemPrompt = args.reviewPersona
      ? PERSONA_PREAMBLES[args.reviewPersona]
      : buildOllamaReviewSystem();
    const messages: OllamaChatMessage[] = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: buildReviewPrompt(args.summary, round, args.reviewPersona ?? null) },
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

export function buildReviewPrompt(
  summary: PrimaryTurnSummary,
  round: number,
  persona?: PersonaKey | null,
): string {
  // Tight framing — codex exec echoes the prompt in its stdout, so extra
  // words here directly bloat the raw view. First round gets the role;
  // later rounds skip it.
  // Cap the transcript to the last N exchanges so the reviewer prompt
  // doesn't balloon over long conversations. The reviewer needs RECENT
  // context to disambiguate replies like "ok 2", not turn-47 from an
  // hour ago. Keeps cost bounded for smart-tier reviewer presets.
  const PRIOR_TURNS_CAP = 8;
  const all = summary.priorTurns ?? [];
  const kept = all.slice(-PRIOR_TURNS_CAP);
  const transcript: string[] = [];
  if (kept.length < all.length) {
    transcript.push(`(${all.length - kept.length} earlier turns elided)`);
    transcript.push('');
  }
  for (const t of kept) {
    transcript.push(`User: ${t.userPrompt || '(no text)'}`);
    transcript.push('');
    transcript.push(`${summary.primaryBackend}: ${t.assistantText || '(no text)'}`);
    transcript.push('');
  }
  const body: string[] = [
    ...transcript,
    `User: ${summary.userPrompt}`,
    '',
    `${summary.primaryBackend}: ${summary.assistantText || '(no text)'}`,
  ];
  if (summary.toolActivity && summary.toolActivity !== '(no tools used)') {
    body.push('', `Tools: ${summary.toolActivity}`);
  }
  if (round === 1) {
    // Persona preamble replaces the generic sanity-check framing — the
    // persona text already names the lens. Falls back to the generic
    // framing when no persona is set (preset = 'independent' or no
    // preset at all). When there's prior context, hint that the LAST
    // exchange is the one to review so the reviewer doesn't critique
    // the earlier ones.
    const framing = persona
      ? PERSONA_PREAMBLES[persona]
      : `Sanity-check the turn below by ${summary.primaryBackend}. Reply briefly: what's wrong or "looks fine". Ground it in the code.`;
    const focusHint =
      transcript.length > 0
        ? `\n\nThe earlier exchanges are conversation context; review only the LAST ${summary.primaryBackend} response.`
        : '';
    return [framing + focusHint, '', ...body].join('\n');
  }
  return body.join('\n');
}

/// Memo of `bin → does its --help mention --effort?`. Older
/// `@anthropic-ai/claude-code` releases don't accept the flag and
/// exit immediately with `error: unknown option '--effort'`. We
/// probe once per binary path (cheap local --help call) and cache
/// the answer for the rest of the process. Exported only for tests.
const claudeEffortSupport = new Map<string, boolean>();

export function claudeSupportsEffort(bin: string): boolean {
  const cached = claudeEffortSupport.get(bin);
  if (cached !== undefined) return cached;
  let supported = true;
  try {
    const env = buildBackendEnv(process.env, bin);
    const shell = backendNeedsShell(bin);
    const res = spawnSync(bin, ['--help'], { encoding: 'utf-8', timeout: 4000, env, shell });
    const out = `${res.stdout ?? ''}\n${res.stderr ?? ''}`;
    // If --help failed entirely we leave `supported` true — falling
    // through to the existing "error: unknown option" surface is no
    // worse than what we have today, and we don't want to silently
    // strip the flag on healthy installs because of a transient probe
    // failure. We only flip to false when --help ran AND --effort is
    // absent from its output.
    if (!res.error && res.status === 0 && out && !/--effort\b/.test(out)) {
      supported = false;
    }
  } catch {
    // Same reasoning as above — probe failure shouldn't strip the flag.
  }
  claudeEffortSupport.set(bin, supported);
  return supported;
}

/// Test-only: reset the probe cache between cases. Not part of the
/// public surface beyond unit tests.
export function _resetClaudeEffortSupportCache(): void {
  claudeEffortSupport.clear();
}

export function buildReviewerArgs(
  backend: Backend,
  opts: {
    yolo?: boolean;
    writableRoots?: string[];
    model?: string | null;
    /// Claude only: when set, append `--resume <id>` so the reviewer
    /// continues the same Claude session as previous reviewer rounds in
    /// this conversation. Lets the API prompt cache hit on the
    /// persona + transcript prefix, and lets us skip priorTurns in the
    /// prompt body (Claude already has them).
    resumeSessionId?: string | null;
    /// Per-persona reasoning effort. Maps to `--effort` on claude.
    /// Codex picks this up via the app-server transport instead (so
    /// this is unused for that path); gemini has no equivalent flag.
    effort?: EffortLevel;
    /// Claude only: whether the installed `claude` CLI accepts the
    /// `--effort` flag. Older versions reject it with
    /// `error: unknown option '--effort'`. Probed once per binary in
    /// `claudeSupportsEffort` and threaded through here so the pure
    /// arg builder stays sync + testable. Defaults to true (assume
    /// support) so existing call sites and tests are unaffected.
    effortSupported?: boolean;
  } = {},
): string[] {
  // Reviewer model override: claude takes `--model X`, codex/gemini
  // take `-m X`. Each CLI puts the flag before its own positional
  // arguments, so we splice rather than append.
  const model = opts.model?.trim() || null;
  const resume = opts.resumeSessionId?.trim() || null;
  switch (backend) {
    case 'claude': {
      // stream-json output gives us the system_init event (carries the
      // session_id we need to capture for next round's --resume) plus
      // structured assistant events we extract the verdict text from.
      // --verbose is required when --output-format=stream-json.
      //
      // --effort comes from the persona table (PERSONA_EFFORT) — most
      // personas use 'low' to keep the model from burning its output
      // budget on extended thinking and ending with empty text;
      // 'security' uses 'medium' because subtle bugs (race conditions,
      // auth bypass paths) genuinely benefit from deeper analysis.
      //
      // --permission-mode default means tools require asking; -p mode
      // has no human to ask, so tools effectively can't fire. The
      // reviewer is a text-only critic; tool use just wastes budget.
      // Empty-string and undefined both fall through to 'low'.
      const effort = opts.effort || 'low';
      const a: string[] = [];
      if (model) a.push('--model', model);
      if (resume) a.push('--resume', resume);
      // Older claude CLIs predate `--effort` and exit immediately with
      // `error: unknown option '--effort'`. Skip the flag when the
      // installed binary doesn't advertise it (probed at the call site).
      if (opts.effortSupported !== false) a.push('--effort', effort);
      a.push('--permission-mode', 'default');
      // Whitelist read-only tools so the reviewer can verify findings
      // against the actual code instead of trusting the assistant's
      // summary. Read/Grep/Glob cover source inspection; the git Bash
      // subset lets it diff the working tree (most useful for
      // half-finished / security personas reviewing real code changes).
      // Edits and shell mutations are NOT whitelisted, and
      // --permission-mode default means anything outside this list
      // would prompt for approval — which can't happen in -p mode, so
      // it effectively fails. Reviewer is read-only by construction.
      a.push(
        '--allowedTools',
        'Read Grep Glob Bash(git diff:*) Bash(git log:*) Bash(git show:*) Bash(git status:*) Bash(git ls-files:*)',
      );
      // --include-partial-messages surfaces streaming partial content
      // blocks including thinking. Without it, claude only emits the
      // final assistant message, so even at high effort the model's
      // reasoning is invisible to us. The primary's claude path uses
      // this same flag for the same reason.
      a.push(
        '--output-format',
        'stream-json',
        '--verbose',
        '--include-partial-messages',
        '-p',
        '-',
      );
      return a;
    }
    case 'codex': {
      // codex exec: one-shot version of codex proto. `-` tells it to
      // read the user prompt from stdin. --skip-git-repo-check lets the
      // reviewer run when cwd is a synthetic workspace/coordinator root
      // (a dir of symlinks that isn't itself a git repo).
      // Yolo: opt into workspace-write + auto-approval so the reviewer
      // can actually edit files. Default is codex's own read-only
      // sandbox, which is why a review that wants to patch code
      // previously bounced with a "read-only session" message.
      // `-s` and `-a` and `-m` are TOP-LEVEL codex flags — they have
      // to come before `exec`. Putting them after `exec` makes the
      // codex parser reject them as unknown exec arguments.
      const top: string[] = [];
      if (model) top.push('-m', model);
      if (!opts.yolo) return [...top, 'exec', '--skip-git-repo-check', '-'];
      const extras: string[] = [];
      for (const r of opts.writableRoots ?? []) {
        if (!r) continue;
        extras.push('--add-dir', r);
      }
      return [
        ...top,
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
    case 'gemini': {
      // gemini CLI also supports stdin prompt via `-p -`. Model flag is
      // `-m X`, same as the primary gemini path.
      const a: string[] = [];
      if (model) a.push('-m', model);
      a.push('-p', '-');
      return a;
    }
    case 'ollama':
      // Ollama doesn't go through a CLI subprocess at all — run() routes
      // it to runOllama() before reaching this builder. Throw if we ever
      // get here, since it means the dispatch in run() was bypassed.
      throw new Error('Ollama reviewer is dispatched via runOllama, not buildReviewerArgs');
  }
}

/// Pull display text out of whatever stdout the reviewer is producing.
/// Gemini runs without --output-format so stdout is plain assistant
/// text. Claude runs with --output-format stream-json so we can capture
/// the session_id for warm-resume, and we extract the latest assistant
/// event's text. Codex exec emits a structured transcript — banner,
/// config block, echoed user instructions, thinking summaries, then the
/// actual "codex" response, then a token-usage footer — and we want
/// only the final response to land in the review card.
export function extractReviewerDisplay(raw: string, backend: Backend): string {
  if (!raw) return '';
  if (backend === 'codex') return extractCodexDisplay(raw);
  if (backend === 'claude') return parseClaudeStreamJson(raw).text;
  return raw.trim();
}

/// Parse claude's --output-format=stream-json output. One JSON object
/// per line. We only care about the system_init event (carries
/// session_id we'll re-use via --resume) and assistant events (carry
/// the verdict text in their content blocks). Tolerant of partial
/// lines during streaming — bad JSON is silently skipped.
export function parseClaudeStreamJson(raw: string): {
  text: string;
  thinking: string;
  toolActivity: string[];
  sessionId?: string;
} {
  let text = '';
  let thinking = '';
  let resultText = '';
  let sessionId: string | undefined;
  // Tool uses are emitted as separate `assistant` events with a
  // `tool_use` content block (each with a unique id). Tracking by id
  // lets us deduplicate the partial-message stream — claude emits the
  // same tool_use multiple times as the input JSON streams in, and we
  // only want one activity line per actual call. The summary string
  // (file path / command / etc) is built once when the input is
  // complete-enough to parse.
  const toolActivityById = new Map<string, string>();
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || !trimmed.startsWith('{')) continue;
    let obj: any;
    try {
      obj = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (obj?.type === 'system' && obj?.subtype === 'init' && typeof obj.session_id === 'string') {
      sessionId = obj.session_id;
    } else if (obj?.type === 'assistant' && Array.isArray(obj?.message?.content)) {
      const textJoined = obj.message.content
        .filter((b: any) => b?.type === 'text' && typeof b.text === 'string')
        .map((b: any) => b.text)
        .join('');
      if (textJoined) text = textJoined;
      const thinkingJoined = obj.message.content
        .filter((b: any) => b?.type === 'thinking' && typeof b.thinking === 'string')
        .map((b: any) => b.thinking)
        .join('\n\n');
      if (thinkingJoined) thinking = thinkingJoined;
      // Capture tool_use blocks for the activity strip. Reusing the
      // shared summarizeToolUse keeps formatting consistent with the
      // primary's tool activity panel (e.g. "• Read /path/to/file").
      for (const b of obj.message.content) {
        if (b?.type !== 'tool_use' || typeof b.id !== 'string') continue;
        const inputJSON =
          b.input != null ? JSON.stringify(b.input) : '';
        const summary = summarizeToolUse(b.name ?? '?', inputJSON);
        if (summary) toolActivityById.set(b.id, summary);
      }
    } else if (obj?.type === 'result' && typeof obj?.result === 'string' && obj.result) {
      // Defense-in-depth fallback. In some claude versions the assistant
      // event might be filtered out by hooks or arrive in a shape we
      // don't recognize, but the result event's `result` field still
      // carries the final text. Prefer assistant event when present.
      resultText = obj.result;
    }
  }
  return {
    text: text || resultText,
    thinking,
    toolActivity: Array.from(toolActivityById.values()),
    sessionId,
  };
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
