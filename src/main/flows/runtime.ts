// Flow runtime — orchestrates step execution by driving the existing
// RunnerManager. One FlowRuntime instance lives in the main process; each
// in-flight FlowRun is a small state machine inside it.
//
// Architecture:
//   - `startRun` mints a FlowRun, sets `state.running` on its first step,
//     and calls `advanceRun`.
//   - `advanceRun` finds the next step to execute, generates a UUID for
//     its backing Conversation, builds a prompt (role + artifact bundle
//     + user prompt + output contract), and calls `runner.send`.
//   - We tap the emit pipeline: every event flowing back from the runner
//     that targets a tracked step conversation feeds `handleStreamEvent`.
//     That accumulates assistant text + watches for the `running:false`
//     terminator that means "the model is done talking for now."
//   - On finish, we try to extract the artifact (parse `<output
//     name="…">…</output>` from the accumulated text). If the extraction
//     succeeds the artifact lands in the run's map and we advance; if
//     not, the step's onFail policy decides.
//
// Step conversations are minted with `hidden: true` so they don't pollute
// the sidebar but are otherwise normal Conversations that the existing
// runner pipeline drives.

import { randomUUID } from 'node:crypto';
import { copyFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { log } from '../diagnostics';

import type {
  AppSettings,
  Attachment,
  Backend,
  MainToRendererEvent,
  PermissionMode,
  Project,
  UUID,
  Workspace,
} from '../../shared/types';
import { PREMIUM_MODELS, friendlyModelLabel, isSupportedPremiumModel, modelSpeed } from '../../shared/modelCatalog';
import { workspaceSymlinkNames } from '../../shared/workspaceNames';
import { preflightRun, formatPreflight, type PreflightResult } from './preflight';
import { filterNoiseFromDiff, isNoisyPath } from './diffFilter';
import { clearAttachments, writeAttachment } from './attachments';
import type {
  Flow,
  FlowArtifact,
  FlowRolePreset,
  FlowRun,
  FlowStep,
  FlowStepAttempt,
} from '../../shared/flows/schema';
import {
  FLOW_USER_PROMPT_REF,
  resolveStepModel,
  resolveRunStepModel,
  effectiveParticipantModel,
} from '../../shared/flows/schema';
import { ROLE_PROMPTS, resolveSystemPrompt } from '../../shared/flows/roles';
import type { RunnerManager } from '../runner';
import { loadAllFlows } from './storage';
import {
  createWorktreeAsync,
  detectBaseBranchAsync,
  removeWorktreeAsync,
  runGit,
  runGitAsync,
  worktreeNameTaken,
} from '../git';
import { branchSlugFromPrompt } from './branchName';
import { ensureCoordinatorSymlinkRoot } from '../workspace';
import { deleteRun as deleteRunFromDisk, loadAllRuns, saveRun } from './runsStore';
import { getWatchSource, parseWatchReport, type WatchTickReport } from './watch/source';
import { notifyWatch } from './watch/notify';
// Importing this registers the bundled watch source(s) with the registry as a
// side effect. Keep it even though the symbol isn't referenced directly.
import './watch/generic';
import type { WatchState, WatchTickLogEntry } from '../../shared/flows/schema';

export interface FlowRuntimeStartArgs {
  flowId: string;
  /// Path the steps will run in. For `runIn: 'cwd'`, this is the project
  /// or workspace root used as-is. For `runIn: 'worktree'`, this is the
  /// SOURCE repo from which a fresh worktree is minted; the runtime
  /// substitutes the worktree path before any step runs.
  projectPath: string;
  userPrompt: string;
  /// Images / files attached to the launch prompt, handed to the step(s)
  /// that read `user_prompt` so the flow can act on a screenshot / spec.
  attachments?: Attachment[];
  /// `cwd` (default): steps run with `projectPath` as their cwd, sharing
  /// the working tree with the user. `worktree`: create a fresh git
  /// worktree (new branch off `baseBranch`) and run there — changes stay
  /// isolated until the user reviews + merges. Only valid when
  /// `projectPath` is a git repo.
  runIn?: 'cwd' | 'worktree';
  /// Base branch to fork the worktree from. Required when
  /// `runIn === 'worktree'`. Ignored otherwise.
  baseBranch?: string;
  /// Set when this run is one item of an Orchestrator batch. Recorded on
  /// the FlowRun so the runtime's run observer can route the run's terminal
  /// state back to the orchestrator (which pumps the next queued item).
  parentOrchestrationId?: UUID;
  /// The orchestration item's human title (the candidate's title), stored
  /// on the run for display when it's surfaced on its own.
  orchestrationItemTitle?: string;
}

export interface FlowRuntimeResumeArgs {
  runId: UUID;
  editedArtifacts?: Record<string, string>;
  /// Force a FAILURE pause to roll forward past the failed step instead of
  /// re-running it — the "override the gate" escape hatch. Ignored on
  /// non-failure pauses. See `resumeRun`.
  override?: boolean;
}

export interface FlowRuntimeDeleteArgs {
  runId: UUID;
}

interface StepStreamBuffer {
  /// Accumulated assistant text — concatenated across every `assistant`
  /// event that arrived on this step's conversation, excluding partials.
  assistantText: string;
  /// Running token totals summed from assistant events' usage block.
  /// Stays at zeros if the backend never reports usage.
  usage: { inputTokens: number; outputTokens: number; cacheReadInputTokens: number; cacheCreationInputTokens: number };
  /// Most-recent reported cumulative cost from the CLI's `result` event.
  /// Replaced (not summed) each turn since result.totalCostUSD is itself
  /// cumulative for the conversation.
  costUSD: number;
}

/// Pick a worktree/branch name that's free in EVERY given repo, starting
/// from `base` and appending `-2`, `-3`, … on collision. Workspace runs
/// reuse one name across member repos, so it has to clear all of them —
/// otherwise a clean ticket name like `WOW-1234` run twice would fail the
/// second time instead of becoming `WOW-1234-2`.
function uniqueWorktreeName(repoPaths: string[], base: string, branchPrefix: string): string {
  let name = base;
  let n = 2;
  while (repoPaths.some((p) => worktreeNameTaken(p, name, branchPrefix))) {
    name = `${base}-${n++}`;
  }
  return name;
}

export class FlowRuntimeImpl {
  private runs = new Map<UUID, FlowRun>();
  /// Reverse index: which run owns this conversation id. With participants,
  /// the same conv id can host multiple steps (one participant runs many
  /// steps), but it still belongs to exactly one run.
  private convIdToRun = new Map<UUID, UUID>();
  /// Per-run buffer for the CURRENTLY-EXECUTING step. Reset at each
  /// step's start so artifact extraction sees only this step's turn,
  /// even when the participant's underlying conversation carries
  /// transcripts from previous steps. Keyed by run id (not conv id)
  /// because participants' convs are shared across steps.
  private stepBuffers = new Map<UUID, StepStreamBuffer>();
  /// Latest non-partial assistant text per participant, captured from
  /// stream events regardless of run state. Keyed `${runId}:${participantId}`.
  /// Used by `resumeRun` to re-extract a prior step's artifact when the
  /// user has chatted with that participant during a `preStep` pause —
  /// if the participant re-emits an `<output>` block in their reply,
  /// the artifact handed to the next step reflects those refinements.
  private latestAssistantTextByParticipant = new Map<string, string>();
  /// Did the user actually chat with a participant during the current
  /// pre-step pause? Keyed `${runId}:${participantId}`. Set by the
  /// stream observer when an assistant message lands while the run is
  /// paused, consumed (and cleared) by `resumeRun` to decide whether
  /// to round-trip a synthetic "finalize" turn through the prior
  /// step's participant before advancing. Avoids paying for a finalize
  /// call when the user clicked Continue without saying anything.
  private pauseChatHappened = new Set<string>();
  /// Promises waiting for the synthetic finalize turn to fully drain
  /// (`running:false` on the prior participant's conversation). Used by
  /// `finalizeAndAdvance` to block until the conv has actually finished
  /// — not just sent its first assistant message — so the next step
  /// starts on a clean event queue. Keyed `${runId}:${participantId}`.
  /// Resolvers self-clear from the map.
  private finalizeWaiters = new Map<string, () => void>();
  /// Runs currently mid-finalize. Guards against the user clicking
  /// Continue twice while the synthetic finalize turn is still in flight
  /// — without this, a second click would spin up a second finalize and
  /// race the first to extract the artifact.
  private finalizingRuns = new Set<UUID>();
  /// Track how many `goto` retries each step has consumed in a run, so
  /// `on_fail.goto.maxRetries` is respected.
  private retryCounts = new Map<string, number>(); // `${runId}:${stepId}` → count

  /// Worktree snapshot (a git tree-ish) captured after each diff-producing
  /// step, so the NEXT diff step can compute only what IT changed rather
  /// than the whole cumulative diff. Outer key is runId; inner key is the
  /// repo: `__single__` for a single-repo run, or the member name for a
  /// workspace run. In-memory only — if it's lost across a restart, the
  /// next diff step falls back to diffing against the run's baseline
  /// commit (i.e. cumulative), which degrades gracefully.
  private diffSnapshots = new Map<UUID, Map<string, string>>();

  /// Optional observer notified on every run state change. The orchestrator
  /// registers here so it can react when a child run (one launched as part
  /// of a batch) reaches a terminal state and pump the next queued item.
  /// Kept as a single callback rather than an event-emitter — there's
  /// exactly one consumer and the runtime stays dependency-free of it.
  private runObserver: ((run: FlowRun) => void) | null = null;

  /// Launch-prompt attachments (images / files) per run, handed to the
  /// step(s) that read `user_prompt`. In-memory only — they're consumed by
  /// the first step at run start; not worth bloating the persisted run JSON
  /// with base64 image data.
  private pendingAttachments = new Map<UUID, Attachment[]>();

  /// Cap on the number of past runs we keep in memory. Once we exceed
  /// this, the oldest done/aborted runs are evicted. Running + paused +
  /// watching runs are NEVER evicted regardless of count (they're load-
  /// bearing). Sized to be generous for a normal session — bump if it's not.
  private static readonly MAX_RETAINED_RUNS = 50;

  // ---- Watch engine (post-completion "stewardship tail") -----------------
  /// The single sweep timer that drives ALL watching runs. Lazily started
  /// the first time a run enters `watching` (or on restart if any restored
  /// run is already watching); never one-timer-per-run.
  private watchTimer: ReturnType<typeof setInterval> | null = null;
  /// Accumulated assistant text for the in-flight watch tick, keyed by run
  /// id. Separate from `stepBuffers` because a watch tick is not a step.
  private watchBuffers = new Map<UUID, string>();
  /// Runs with a watch tick currently in flight — guards the sweep against
  /// firing a second tick before the first reply lands.
  private watchTicking = new Set<UUID>();
  /// Which tier the in-flight tick is on: 'detect' (cheap, every tick) or
  /// 'answer' (premium, only after detect escalates). Keyed by run id.
  private watchPhase = new Map<UUID, 'detect' | 'answer'>();
  /// How often the sweep wakes to check which watching runs are due. Coarse
  /// on purpose: due-ness is decided per run from `lastTickAt + pollIntervalMs`,
  /// so this only bounds scheduling granularity, not the poll cadence.
  private static readonly WATCH_SWEEP_MS = 30_000;
  /// Floor on a watch's poll interval, so a stray tiny value can't hammer
  /// the source's API.
  private static readonly WATCH_MIN_POLL_MS = 60_000;
  /// Default poll cadence when the caller doesn't specify one (10 min).
  private static readonly WATCH_DEFAULT_POLL_MS = 600_000;

  /// Max combined size of artifact inputs + system prompt we'll feed to a
  /// step's first turn before truncating. Local models choke on huge
  /// contexts; premium models can handle more but we still cap to keep
  /// token bills and round-trip times sane. The runtime emits a system
  /// notice into the step's conversation when truncation kicks in so the
  /// user can see what happened.
  private static readonly PROMPT_BUDGET_PREMIUM = 250_000; // ~62k tokens-ish
  private static readonly PROMPT_BUDGET_OLLAMA = 60_000;   // ~15k tokens-ish

  /// Inputs larger than this get written to disk and referenced by
  /// absolute path so the step's CLI can pull them with its own Read
  /// tool — instead of inlining bytes that would otherwise blow the
  /// prompt budget. Tuned so plan.md / ticket.md / short reviews stay
  /// inline (where they "just work") and only the chunky stuff
  /// (diffs, transcripts) gets attached. Only applies to non-ollama
  /// backends since Ollama's read_file is cwd-scoped and can't reach
  /// the attachment directory.
  private static readonly INLINE_THRESHOLD_BYTES = 20_000;

  constructor(
    private runner: RunnerManager,
    private emit: (event: MainToRendererEvent) => void,
    private getProjects: () => Project[],
    private getSettings: () => AppSettings,
    private getWorkspaces: () => Workspace[] = () => [],
  ) {
    // Restore checkpointed runs from prior sessions. `loadAllRuns` demotes
    // any `running` entry to 'aborted' (it died mid-step, its subprocess is
    // gone), so what comes back is done, aborted, archived, watching, or
    // paused. A paused run is resumable via `resumeRun`, which starts the
    // next step fresh — no live subprocess required.
    for (const run of loadAllRuns()) {
      this.runs.set(run.id, run);
      // Seed conversation→run routing for restored non-terminal runs so
      // `observeEvent` can resolve their conversations again. Without this,
      // hijack-chatting the prior participant during a restored `preStep`
      // pause wouldn't be captured (`pauseChatHappened` never set), so the
      // finalize-on-Continue round-trip couldn't fold that chat into the
      // artifact. `executeStep`/`watchTick` re-register on their own once
      // the run advances, but the pause window needs routing up front.
      if (run.state.kind === 'paused' || run.state.kind === 'watching') {
        for (const convId of Object.values(run.conversationIds)) {
          this.convIdToRun.set(convId, run.id);
        }
      }
    }
    // If any restored run is still `watching`, re-arm the sweep so its poll
    // loop resumes. The watcher's subprocess is dead, but its conversation
    // session persists, so the next tick's `runner.send` warm-resumes it.
    if (Array.from(this.runs.values()).some((r) => r.state.kind === 'watching')) {
      this.ensureWatchTimer();
    }
  }

  /// Called from main/index.ts's wrapped emit BEFORE every event is sent
  /// to the renderer. Lets the runtime tap stream events targeted at its
  /// tracked step conversations.
  observeEvent(event: MainToRendererEvent): void {
    // Capture sessionId for flow conversations regardless of whether the
    // runtime is mid-step. The CLI emits `sessionConfigured` once per
    // subprocess; persisting it on the FlowRun lets the renderer resume
    // the participant's transcript via `runner:loadHistory` after an
    // app restart (without it, ChatView shows the artifact but no chat).
    if (event.type === 'sessionConfigured') {
      const runId = this.convIdToRun.get(event.conversationId);
      if (runId) {
        const run = this.runs.get(runId);
        if (run) {
          const participantId = Object.entries(run.conversationIds).find(
            ([, cid]) => cid === event.conversationId,
          )?.[0];
          if (participantId) {
            const existing = run.sessionIdsByParticipant?.[participantId];
            // Only let a NEW session id REPLACE an existing one while the
            // runtime is actively executing THIS participant's step.
            // Otherwise this `sessionConfigured` comes from a hijack/side
            // chat — the user talking to the participant during a pause or
            // after the run settled. If that hijack started a fresh session
            // (e.g. it didn't resume), letting it overwrite the pointer
            // discards the step's real transcript, and the chat panel then
            // shows only the hijack turn ("can't see the step history").
            // We still SET the pointer when there's none yet, so a
            // hijack-only participant that never ran a step is resumable.
            const st = run.state;
            const executingThisParticipant =
              st.kind === 'running' &&
              run.flowSnapshot.steps.find((s) => s.id === st.currentStepId)?.participantId ===
                participantId;
            if (existing !== event.sessionId && (!existing || executingThisParticipant)) {
              run.sessionIdsByParticipant = {
                ...(run.sessionIdsByParticipant ?? {}),
                [participantId]: event.sessionId,
              };
              this.checkpoint(run);
              this.emitRunUpdate(run);
            }
          }
        }
      }
      // fall through — other observers (none today) might also care
    }
    if (event.type === 'stream') {
      const runId = this.convIdToRun.get(event.conversationId);
      if (!runId) return;
      const run = this.runs.get(runId);
      if (!run) return;

      // Capture the latest non-partial assistant text per participant,
      // regardless of run state. Hijack replies during a `preStep` pause
      // flow through here too — and `resumeRun` reads this map to
      // re-extract the refined artifact before advancing.
      const participantId = Object.entries(run.conversationIds).find(
        ([, cid]) => cid === event.conversationId,
      )?.[0];
      if (participantId) {
        const key = `${runId}:${participantId}`;
        for (const ev of event.events) {
          if (
            ev.kind.type === 'assistant' &&
            !ev.kind.info.isPartial &&
            !ev.reviewer &&
            ev.kind.info.text
          ) {
            this.latestAssistantTextByParticipant.set(key, ev.kind.info.text);
            // Any assistant message that lands while the run is paused
            // counts as hijack chat — the user said something to the
            // participant and got a reply. `resumeRun` reads this flag
            // to decide whether to ask the participant for a finalized
            // <output> before advancing.
            if (run.state.kind === 'paused') {
              this.pauseChatHappened.add(key);
            }
            // Waiter resolution lives in the `running:false` branch
            // below (not here). Resolving on the first assistant message
            // lets `finalizeAndAdvance` advance to the next step while
            // the prior conv is still streaming — its delayed
            // `running:false` then misfires as a step boundary on the
            // already-running next step and re-pauses the run.
          }
        }
      }

      // Watch tick: while a run is `watching` and a tick is in flight,
      // accumulate the watcher participant's reply so `onWatchTickFinished`
      // can parse the <watch_report> from it. A watch tick isn't a step, so
      // it has its own buffer rather than touching `stepBuffers`.
      if (run.state.kind === 'watching' && this.watchTicking.has(runId)) {
        const watcherConv = run.conversationIds[run.state.watch.participantId];
        if (watcherConv === event.conversationId) {
          let acc = this.watchBuffers.get(runId) ?? '';
          for (const ev of event.events) {
            if (
              ev.kind.type === 'assistant' &&
              !ev.kind.info.isPartial &&
              !ev.reviewer &&
              ev.kind.info.text
            ) {
              acc += ev.kind.info.text + '\n';
            }
          }
          this.watchBuffers.set(runId, acc);
        }
        return;
      }

      // Only capture buffer state while the runtime is actually running a
      // step — user hijacks (chat between steps, or after a pause) flow
      // through the same conv but shouldn't pollute the current step's
      // artifact buffer.
      if (run.state.kind !== 'running') return;
      const buf = this.stepBuffers.get(runId);
      if (!buf) return;
      for (const ev of event.events) {
        if (ev.kind.type === 'assistant' && !ev.kind.info.isPartial) {
          // Skip reviewer-origin events — those are the critic talking,
          // not the worker. Their text shouldn't end up in the artifact.
          if (ev.reviewer) continue;
          if (ev.kind.info.text) buf.assistantText += ev.kind.info.text + '\n';
          if (ev.kind.info.usage) {
            buf.usage.inputTokens += ev.kind.info.usage.inputTokens;
            buf.usage.outputTokens += ev.kind.info.usage.outputTokens;
            buf.usage.cacheReadInputTokens += ev.kind.info.usage.cacheReadInputTokens;
            buf.usage.cacheCreationInputTokens += ev.kind.info.usage.cacheCreationInputTokens;
          }
        } else if (ev.kind.type === 'result') {
          // result.totalCostUSD is cumulative for the conv; just take
          // the latest reported value rather than summing.
          if (typeof ev.kind.info.totalCostUSD === 'number') {
            buf.costUSD = ev.kind.info.totalCostUSD;
          }
        }
      }
      return;
    }
    if (event.type === 'running' && event.isRunning === false) {
      const runId = this.convIdToRun.get(event.conversationId);
      if (!runId) return;
      const run = this.runs.get(runId);
      if (!run) return;
      // A synthetic finalize turn (resumeRun → finalizeAndAdvance) pulses
      // the pipeline pill on the prior step. Its `running:false` is not a
      // real step boundary — resolve the awaiting finalize promise (so
      // the runtime advances to the next step) and return. Doing this
      // here rather than on the first assistant message guarantees the
      // synthetic conv has fully drained before we kick off the next
      // step, otherwise the prior conv's later `running:false` would
      // misfire as a step finish on the just-started next step (empty
      // buffer → no <output> → pause-on-failure → banner reappears).
      const participantId = Object.entries(run.conversationIds).find(
        ([, cid]) => cid === event.conversationId,
      )?.[0];
      if (participantId) {
        const waiter = this.finalizeWaiters.get(`${runId}:${participantId}`);
        if (waiter) {
          this.finalizeWaiters.delete(`${runId}:${participantId}`);
          waiter();
          return;
        }
      }
      // Watch tick finished: the watcher participant's turn drained. Parse
      // its report, advance the cursor, notify/escalate, and schedule the
      // next tick. Guarded on `watchTicking` so a stray running:false on the
      // watcher conv (e.g. a user hijack) doesn't misfire as a tick finish.
      if (run.state.kind === 'watching') {
        if (this.watchTicking.has(runId)) {
          const watcherConv = run.conversationIds[run.state.watch.participantId];
          if (watcherConv === event.conversationId) {
            this.onWatchTickFinished(runId);
          }
        }
        return;
      }

      // Only react when the runtime itself is mid-step. running:false on a
      // user hijack turn should NOT finish the step — that would extract
      // an artifact from a chat reply.
      if (run.state.kind !== 'running') return;
      // Guard against a late-arriving running:false from a DIFFERENT conv
      // than the one the current step is running on. After
      // finalizeAndAdvance resolves its waiter and advances to the next
      // step, a stray running:false from the prior conv (or any earlier
      // in-flight turn) would otherwise misfire here as a step boundary
      // on the now-current step — extracting from its empty buffer,
      // failing the step, and re-pausing the run with reason='failure'
      // (the banner the user sees re-appear).
      const currentStepId = run.state.currentStepId;
      const currentStep = run.flowSnapshot.steps.find((s) => s.id === currentStepId);
      if (!currentStep) return;
      const currentConvId = run.conversationIds[currentStep.participantId];
      if (currentConvId !== event.conversationId) return;
      this.onStepFinished(runId, currentStepId);
    }
  }

  async startRun(
    args: FlowRuntimeStartArgs,
  ): Promise<{ ok: true; runId: UUID } | { ok: false; error: string; preflight?: PreflightResult }> {
    const projectPaths = this.getProjects().map(p => p.path);
    const flows = loadAllFlows({ projectPaths });
    const flow = flows.find(f => f.id === args.flowId);
    if (!flow) return { ok: false, error: `Flow "${args.flowId}" not found.` };
    if (flow.steps.length === 0) return { ok: false, error: 'Flow has no steps.' };

    // Preflight: every backend healthy, every model reachable, the cwd
    // exists, every step has tools, etc. We bail before spinning up any
    // subprocess so the user sees a clear listed problem instead of a
    // cryptic CLI error mid-run.
    const settings = this.getSettings();
    const preflight = await preflightRun({ flow, projectPath: args.projectPath, settings });
    if (!preflight.ok) {
      return {
        ok: false,
        error: 'Preflight failed:\n' + formatPreflight(preflight),
        preflight,
      };
    }

    const runId = randomUUID();

    // If `runIn === 'worktree'`, mint worktrees off `baseBranch` and
    // route the step subprocesses through them. Two shapes:
    //   - Single-project run: one worktree, used as `cwd` directly.
    //   - Workspace run: one worktree PER member project, surfaced
    //     through a coordinator symlink root (the same primitive
    //     workspace-agent uses). The root becomes the run's cwd; the
    //     steps see a workspace-shaped tree that's fully isolated from
    //     the user's main checkouts.
    let cwd = args.projectPath;
    let worktreeMeta: { worktreePath: string; branchName: string } | undefined;
    let workspaceWorktrees:
      | Array<{ name: string; projectPath: string; worktreePath: string; branchName: string }>
      | undefined;
    if (args.runIn === 'worktree') {
      // Base branch is optional. When the user picked a single shared name we
      // fork every repo off it; when absent, each repo forks off its OWN
      // default branch (detectBaseBranch) — so a workspace whose members
      // disagree (one `main`, one `master`) still runs.
      const sharedBase = args.baseBranch?.trim() || undefined;
      const matchingWorkspaceForWorktree = this.getWorkspaces().find(
        (w) => w.rootPath === args.projectPath,
      );
      if (matchingWorkspaceForWorktree) {
        // Workspace branch: mint a worktree per member project, then
        // build a symlink farm at userData/coordinators/<runId> that
        // resolves to those new worktrees. Members the user dropped
        // from the workspace or with missing paths are skipped (same
        // tolerance as workspace-agent), so a partially-cleaned
        // workspace still launches as far as it can.
        const projectsById = new Map(this.getProjects().map((p) => [p.id, p]));
        const members = matchingWorkspaceForWorktree.projectIds
          .map((pid) => projectsById.get(pid))
          .filter((p): p is NonNullable<typeof p> => !!p && !!p.path);
        if (members.length === 0) {
          return { ok: false, error: 'Workspace has no eligible member projects.' };
        }
        const branchPrefix = settings.agentBranchPrefix || 'agent/';
        const wtNameBase = uniqueWorktreeName(
          members.map((p) => p.path),
          branchSlugFromPrompt(args.userPrompt, flow.id),
          branchPrefix,
        );
        // Mint every member's worktree CONCURRENTLY. They're independent
        // repos, so a serial loop just stacked each repo's (potentially
        // multi-second) `git worktree add` end to end; running them in
        // parallel makes the whole launch take as long as the SLOWEST single
        // repo rather than the sum. The async runner also keeps the rest of
        // the app responsive while they check out.
        let done = 0;
        const results = await Promise.all(
          members.map(async (p) => {
            const baseBranch = sharedBase ?? (await detectBaseBranchAsync(p.path));
            const r = await createWorktreeAsync({
              projectPath: p.path,
              agentName: wtNameBase,
              baseBranch,
              branchPrefix,
            });
            this.emitLaunchProgress(args.projectPath, {
              completed: ++done,
              total: members.length,
              message: r.ok
                ? `Prepared worktree for ${p.name}`
                : `Worktree failed for ${p.name}`,
            });
            return { p, r };
          }),
        );
        const failed = results.find((x) => !x.r.ok);
        if (failed && !failed.r.ok) {
          return {
            ok: false,
            error: `Failed to create worktree for ${failed.p.name}: ${failed.r.error}`,
          };
        }
        const minted = results.map(({ p, r }) => {
          // Narrowed by the `failed` guard above — every result is ok here.
          const ok = r as Extract<typeof r, { ok: true }>;
          return {
            name: p.name,
            projectPath: p.path,
            worktreePath: ok.worktreePath,
            branchName: ok.branchName,
          };
        });
        const linked = ensureCoordinatorSymlinkRoot(
          runId,
          minted.map((m) => ({ name: m.name, worktreePath: m.worktreePath })),
        );
        if (!linked.ok) {
          return { ok: false, error: `Failed to build workspace worktree root: ${linked.error}` };
        }
        cwd = linked.rootPath;
        workspaceWorktrees = minted;
      } else {
        // Single-project worktree (original behavior). Async git so the
        // `git worktree add` checkout doesn't block the main thread.
        const branchPrefix = settings.agentBranchPrefix || 'agent/';
        const wtName = uniqueWorktreeName(
          [args.projectPath],
          branchSlugFromPrompt(args.userPrompt, flow.id),
          branchPrefix,
        );
        this.emitLaunchProgress(args.projectPath, {
          completed: 0,
          total: 1,
          message: 'Preparing worktree…',
        });
        const baseBranch = sharedBase ?? (await detectBaseBranchAsync(args.projectPath));
        const result = await createWorktreeAsync({
          projectPath: args.projectPath,
          agentName: wtName,
          baseBranch,
          branchPrefix,
        });
        if (!result.ok) {
          return { ok: false, error: `Failed to create worktree: ${result.error}` };
        }
        this.emitLaunchProgress(args.projectPath, { completed: 1, total: 1, message: 'Worktree ready' });
        cwd = result.worktreePath;
        worktreeMeta = { worktreePath: result.worktreePath, branchName: result.branchName };
      }
    }

    // Make room before adding a new run — keeps the in-memory map bounded.
    this.pruneOldRuns();

    // Snapshot the current HEAD(s) so diff-kind artifacts can be
    // computed against them later (real `git diff` rather than trusting
    // the model's `<output name="diff">` text). Two shapes:
    //   - Single-repo run: one `baselineCommit` for the cwd.
    //   - Workspace run: cwd is a symlink farm that isn't itself a git
    //     repo, so we capture per-member baselines keyed by the same
    //     prefix `workspaceCommitStatus` uses, and the diff aggregates
    //     across members at extract time.
    let baselineCommit: string | undefined;
    let baselineCommitsByMember: Record<string, { path: string; commit: string }> | undefined;
    // Resolve the per-repo paths to capture baselines from:
    //   - Workspace + worktree: just-minted per-member worktrees (each
    //     starts at baseBranch HEAD, so the baseline IS that HEAD).
    //   - Workspace in-place: each member project's main tree.
    //   - Single project + worktree: the worktree directly.
    //   - Single project in-place: the project directly.
    const matchingWorkspaceInPlace =
      !workspaceWorktrees && this.getWorkspaces().find((w) => w.rootPath === cwd);
    // HEAD lookups are individually fast, but they're in the launch path —
    // keep them async (and parallel across members) so nothing here re-blocks
    // the main thread the async worktree work just freed up.
    const captureHead = async (
      key: string,
      repoPath: string,
    ): Promise<[string, { path: string; commit: string }] | null> => {
      const res = await runGitAsync(['rev-parse', 'HEAD'], repoPath);
      const commit = res.exitCode === 0 ? res.stdout.trim() : '';
      return commit ? [key, { path: repoPath, commit }] : null;
    };
    if (workspaceWorktrees) {
      const captured = (
        await Promise.all(workspaceWorktrees.map((m) => captureHead(m.name, m.worktreePath)))
      ).filter((x): x is NonNullable<typeof x> => !!x);
      if (captured.length > 0) baselineCommitsByMember = Object.fromEntries(captured);
    } else if (matchingWorkspaceInPlace) {
      const projectsById = new Map(this.getProjects().map((p) => [p.id, p]));
      const members = matchingWorkspaceInPlace.projectIds
        .map((pid) => projectsById.get(pid))
        .filter((p): p is NonNullable<typeof p> => !!p && !!p.path)
        .map((p) => ({ name: p.name, path: p.path }));
      const named = workspaceSymlinkNames(members);
      const captured = (
        await Promise.all(named.map(({ name, path: projPath }) => captureHead(name, projPath)))
      ).filter((x): x is NonNullable<typeof x> => !!x);
      if (captured.length > 0) baselineCommitsByMember = Object.fromEntries(captured);
    } else {
      const baselineCommitRes = await runGitAsync(['rev-parse', 'HEAD'], cwd);
      baselineCommit =
        baselineCommitRes.exitCode === 0
          ? baselineCommitRes.stdout.trim() || undefined
          : undefined;
    }

    const run: FlowRun = {
      id: runId,
      flowId: flow.id,
      flowSnapshot: flow,
      projectPath: cwd,
      userPrompt: args.userPrompt,
      conversationIds: {},
      artifacts: {},
      state: { kind: 'running', currentStepId: flow.steps[0].id },
      createdAt: Date.now(),
      attempts: [],
      worktreePath: worktreeMeta?.worktreePath,
      branchName: worktreeMeta?.branchName,
      baseBranch:
        worktreeMeta || workspaceWorktrees ? args.baseBranch?.trim() || undefined : undefined,
      sourceProjectPath:
        worktreeMeta || workspaceWorktrees ? args.projectPath : undefined,
      baselineCommit,
      baselineCommitsByMember,
      workspaceWorktrees,
      parentOrchestrationId: args.parentOrchestrationId,
      orchestrationItemTitle: args.orchestrationItemTitle,
    };
    this.runs.set(runId, run);
    if (args.attachments && args.attachments.length > 0) {
      this.pendingAttachments.set(runId, args.attachments);
    }
    this.emitRunUpdate(run);
    void this.executeStep(runId, flow.steps[0].id);
    return { ok: true, runId };
  }

  /// Evict oldest done/aborted runs once we exceed MAX_RETAINED_RUNS. We
  /// never touch runs in `running` or `paused` state since they're still
  /// active and the renderer is watching them. Also frees any per-step
  /// stream buffers that were tied to evicted runs and removes the
  /// run's on-disk checkpoint so the persistent store stays bounded too.
  private pruneOldRuns(): void {
    const all = Array.from(this.runs.values());
    if (all.length < FlowRuntimeImpl.MAX_RETAINED_RUNS) return;
    const evictable = all
      .filter(
        (r) =>
          r.state.kind === 'done' || r.state.kind === 'aborted' || r.state.kind === 'archived',
      )
      .sort((a, b) => a.createdAt - b.createdAt);
    const overflow = all.length - FlowRuntimeImpl.MAX_RETAINED_RUNS + 1;
    for (const victim of evictable.slice(0, overflow)) {
      this.runs.delete(victim.id);
      for (const convId of Object.values(victim.conversationIds)) {
        this.convIdToRun.delete(convId);
      }
      this.stepBuffers.delete(victim.id);
      this.diffSnapshots.delete(victim.id);
      this.pendingAttachments.delete(victim.id);
      // Sweep any retry counters keyed under this run's id.
      for (const key of this.retryCounts.keys()) {
        if (key.startsWith(`${victim.id}:`)) this.retryCounts.delete(key);
      }
      deleteRunFromDisk(victim.id);
      clearAttachments(victim.id);
    }
  }

  /// Persist a checkpoint at meaningful boundaries — when a step
  /// completes (artifact extracted), when the run pauses, and when it
  /// reaches a terminal state. We DON'T persist on every internal
  /// transition (e.g. a step entering 'running'); mid-step crashes can't
  /// be safely resumed because the subprocess and its in-flight tool
  /// effects are gone. Resumption picks up from the LAST completed step.
  private checkpoint(run: FlowRun): void {
    saveRun(run);
  }

  listRuns(): FlowRun[] {
    return Array.from(this.runs.values()).sort((a, b) => b.createdAt - a.createdAt);
  }

  getRun(runId: UUID): FlowRun | null {
    return this.runs.get(runId) ?? null;
  }

  resumeRun(args: FlowRuntimeResumeArgs): { ok: true } | { ok: false; error: string } {
    const run = this.runs.get(args.runId);
    if (!run) return { ok: false, error: `Run ${args.runId} not found.` };
    if (run.state.kind !== 'paused') {
      return { ok: false, error: `Run is not paused (state: ${run.state.kind}).` };
    }
    const pausedReason = run.state.reason;
    const nextStepId = run.state.nextStepId;

    // Gate override: on a FAILURE pause, `nextStepId` is the step that
    // failed (a rejecting reviewer, or a step whose on_fail is `pause`).
    // A plain Continue re-runs it — which loops forever when the failure
    // is a false negative (e.g. a reviewer that approved in a phrasing
    // the verdict gate didn't recognize). Override rolls the run FORWARD
    // past the failed step instead: its artifact is already recorded, so
    // `advanceAfterStep` hands that output to the next step (or finishes
    // the run / parks on a pause_before), exactly as if the step had
    // passed. Only meaningful for a failure pause — ignored otherwise.
    if (args.override && pausedReason === 'failure') {
      this.advanceAfterStep(args.runId, nextStepId);
      return { ok: true };
    }

    // Explicit artifact overrides always win — apply, then advance.
    if (args.editedArtifacts) {
      for (const [name, body] of Object.entries(args.editedArtifacts)) {
        const existing = run.artifacts[name];
        if (existing) {
          run.artifacts[name] = { ...existing, body, producedAt: Date.now() };
        }
      }
      this.advanceToStep(args.runId, nextStepId);
      return { ok: true };
    }

    // Pre-step pause where the user chatted with the prior participant:
    // round-trip a synthetic finalize prompt so the participant emits one
    // fresh <output> block reflecting the discussion, then advance. This
    // is async — we return ok immediately and emit state updates as the
    // finalize turn streams in.
    //
    // EXCEPTION: when the prior step's output is diff-kind, we DO NOT
    // finalize. The authoritative diff artifact is computed from the
    // worktree (see `onStepFinished` → `computeRunDiffForRun`), not from
    // the model's text. Re-prompting the implementer to "emit the FINAL
    // updated <output name="diff">" makes it interpret the request as
    // "go apply more file changes" — and with `acceptEdits` permission
    // it actually does, mutating the user's tree after they hit Continue.
    if (pausedReason === 'preStep') {
      if (this.finalizingRuns.has(args.runId)) {
        // Continue already in flight — idempotent no-op.
        return { ok: true };
      }
      const priorParticipantKey = this.priorParticipantKey(args.runId, nextStepId);
      const priorStep = this.priorStep(args.runId, nextStepId);
      const priorIsDiff = priorStep ? detectArtifactKind(priorStep.output) === 'diff' : false;
      if (
        priorParticipantKey &&
        this.pauseChatHappened.has(priorParticipantKey) &&
        priorStep &&
        !priorIsDiff
      ) {
        this.pauseChatHappened.delete(priorParticipantKey);
        this.finalizingRuns.add(args.runId);
        run.pendingContinue = {
          priorStepId: priorStep.id,
          priorOutput: priorStep.output,
          startedAt: Date.now(),
        };
        this.emitRunUpdate(run);
        void this.finalizeAndAdvance(args.runId, nextStepId).finally(() => {
          this.finalizingRuns.delete(args.runId);
        });
        return { ok: true };
      }
      if (priorParticipantKey && this.pauseChatHappened.has(priorParticipantKey)) {
        // Diff-output prior step — clear the chat flag so we don't
        // accidentally trigger finalize on a future pause, then fall
        // through to advance directly.
        this.pauseChatHappened.delete(priorParticipantKey);
      }
    }

    // No chat happened (or it's a failure pause) — advance directly.
    this.advanceToStep(args.runId, nextStepId);
    return { ok: true };
  }

  /// Rewind the run and re-execute starting at `stepId`, then roll forward
  /// through every later step in order. This is the user-facing "Re-run from
  /// this step" affordance — the one form of going BACKWARD the runtime
  /// allows at the user's request (vs. `on_fail.goto`, which is automatic).
  ///
  /// Why this exists: artifacts handed between steps are snapshotted at the
  /// moment each step finished, and downstream steps never re-read an
  /// upstream artifact once they've run. So editing `plan.md` (via hijack
  /// chat) while paused before `review` does nothing — `build` already
  /// consumed the old plan and won't re-run on its own. Re-running from
  /// `build` re-reads the now-updated `plan.md` and propagates it forward.
  ///
  /// Artifacts produced by steps BEFORE `stepId` are kept intact (they're
  /// this step's inputs). `stepId` and everything after it re-execute and
  /// overwrite their own outputs as they go. The worktree is NOT reverted —
  /// a re-run of a build/diff step continues editing from the current tree,
  /// same as `on_fail.goto`.
  ///
  /// Only valid from a settled state (paused / done / aborted). Refused
  /// while a step is actively running (it would race the live subprocess)
  /// or while the run is watching (archive it first).
  rerunFromStep(args: { runId: UUID; stepId: string }): { ok: true } | { ok: false; error: string } {
    const run = this.runs.get(args.runId);
    if (!run) return { ok: false, error: `Run ${args.runId} not found.` };
    if (run.state.kind === 'running') {
      return {
        ok: false,
        error: 'A step is still running — abort or let it finish before re-running.',
      };
    }
    if (run.state.kind === 'watching' || run.state.kind === 'archived') {
      return { ok: false, error: 'This run is being watched — archive it before re-running.' };
    }
    if (this.finalizingRuns.has(args.runId)) {
      return { ok: false, error: 'Still finalizing the previous step — try again in a moment.' };
    }
    const step = run.flowSnapshot.steps.find((s) => s.id === args.stepId);
    if (!step) return { ok: false, error: `Step "${args.stepId}" not found in this flow.` };

    // Rewinding abandons any pending pause/continue bookkeeping for this run:
    // we're no longer advancing out of that pause, we're jumping elsewhere.
    delete run.pendingContinue;
    for (const key of Array.from(this.pauseChatHappened)) {
      if (key.startsWith(`${args.runId}:`)) this.pauseChatHappened.delete(key);
    }
    // Reset `goto` retry budgets for the whole run so the re-run segment gets
    // a fresh allowance — otherwise a step that exhausted its retries on the
    // first pass would refuse to loop on this one.
    for (const key of Array.from(this.retryCounts.keys())) {
      if (key.startsWith(`${args.runId}:`)) this.retryCounts.delete(key);
    }

    // Mirror `advanceToStep`: flip to running and kick the step. Deliberately
    // no checkpoint here — like every other 'running' transition, a mid-step
    // crash isn't resumable, so we persist at the next step boundary instead.
    run.state = { kind: 'running', currentStepId: step.id };
    this.emitRunUpdate(run);
    void this.executeStep(args.runId, step.id);
    return { ok: true };
  }

  private priorStep(runId: UUID, nextStepId: string): FlowStep | null {
    const run = this.runs.get(runId);
    if (!run) return null;
    const idx = run.flowSnapshot.steps.findIndex((s) => s.id === nextStepId);
    if (idx <= 0) return null;
    return run.flowSnapshot.steps[idx - 1];
  }

  private priorParticipantKey(runId: UUID, nextStepId: string): string | null {
    const run = this.runs.get(runId);
    if (!run) return null;
    const idx = run.flowSnapshot.steps.findIndex((s) => s.id === nextStepId);
    if (idx <= 0) return null;
    const prior = run.flowSnapshot.steps[idx - 1];
    return `${runId}:${prior.participantId}`;
  }

  private advanceToStep(runId: UUID, stepId: string): void {
    const run = this.runs.get(runId);
    if (!run) return;
    run.state = { kind: 'running', currentStepId: stepId };
    // Continuing → actually running the next step now; clear the banner's
    // transient "Continuing…" signal in lockstep with the state flip so
    // the renderer transitions cleanly from pause-banner → running-strip.
    if (run.pendingContinue) {
      delete run.pendingContinue;
    }
    this.emitRunUpdate(run);
    void this.executeStep(runId, stepId);
  }

  /// Send the prior step's participant a synthetic "finalize" prompt
  /// asking them to emit one complete `<output>` block reflecting the
  /// hijack discussion, wait for the reply, extract the artifact, then
  /// advance to the next step. The synthetic turn is visible in the
  /// participant's chat (with a friendly `displayText`) so the user can
  /// see what happened. Falls back to advancing without finalization
  /// if anything goes wrong — the existing artifact is still usable.
  private async finalizeAndAdvance(runId: UUID, nextStepId: string): Promise<void> {
    const run = this.runs.get(runId);
    if (!run) return;
    const idx = run.flowSnapshot.steps.findIndex((s) => s.id === nextStepId);
    if (idx <= 0) {
      this.advanceToStep(runId, nextStepId);
      return;
    }
    const prior = run.flowSnapshot.steps[idx - 1];
    if (!prior.output) {
      this.advanceToStep(runId, nextStepId);
      return;
    }
    const participant = run.flowSnapshot.participants.find(
      (p) => p.id === prior.participantId,
    );
    const convId = run.conversationIds[prior.participantId];
    if (!participant || !convId) {
      this.advanceToStep(runId, nextStepId);
      return;
    }

    // If the user's latest message already includes a fresh <output>
    // (they explicitly asked the participant to re-emit during chat),
    // skip the synthetic turn and use it.
    const latest = this.latestAssistantTextByParticipant.get(`${runId}:${prior.participantId}`);
    const existingArtifact = run.artifacts[prior.output];
    if (latest && existingArtifact) {
      const already = extractOutput(latest, prior.output);
      if (already !== null && already !== existingArtifact.body) {
        run.artifacts[prior.output] = {
          ...existingArtifact,
          body: already,
          producedAt: Date.now(),
        };
        this.emit({
          type: 'flowArtifactProduced',
          runId,
          artifact: run.artifacts[prior.output],
        });
        this.advanceToStep(runId, nextStepId);
        return;
      }
    }

    // Finalization needs a synthetic turn on the prior participant, which
    // can run for a while. Flip the run's `state` to running-on-prior so
    // the pipeline diagram lights the prior step as actively working
    // (re-emitting its output). The Pause banner stays visible because
    // `pendingContinue` is set on the run (cleared by `advanceToStep`),
    // so the user gets explicit "Continuing — finalizing X…" feedback
    // instead of the banner vanishing instantly on click.
    run.state = { kind: 'running', currentStepId: prior.id };
    this.emitRunUpdate(run);

    const finalizePrompt = [
      `[Internal finalization request — the runtime is about to advance to step "${nextStepId}".]`,
      '',
      `Emit the FINAL updated <output name="${prior.output}"> … </output> block reflecting`,
      'EVERYTHING from our conversation, including any changes the user just asked for.',
      'If nothing needs to change, restate the current version verbatim.',
      'Output ONLY the block — no preamble, no commentary, no chatter.',
    ].join('\n');

    const waitKey = `${runId}:${prior.participantId}`;
    const waitPromise = new Promise<void>((resolve) => {
      const timeout = setTimeout(() => {
        if (this.finalizeWaiters.get(waitKey)) {
          this.finalizeWaiters.delete(waitKey);
          resolve();
        }
      }, 180_000);
      this.finalizeWaiters.set(waitKey, () => {
        clearTimeout(timeout);
        resolve();
      });
    });

    const sendResult = this.runner.send({
      conversationId: convId,
      prompt: finalizePrompt,
      displayText: `Finalizing ${prior.output} before continuing…`,
      backend: participant.backend,
      cwd: run.projectPath,
      model: effectiveParticipantModel(run, prior.participantId),
      permissionMode: 'default',
      reviewBackend: null,
      reviewMode: null,
      reviewModel: null,
      reviewPersona: null,
      enabledTools: participant.backend === 'ollama' ? [] : undefined,
    });
    if (!sendResult.ok) {
      this.finalizeWaiters.delete(waitKey);
      this.advanceToStep(runId, nextStepId);
      return;
    }

    await waitPromise;
    // Re-extract from the finalize reply.
    const finalText = this.latestAssistantTextByParticipant.get(waitKey);
    if (finalText && existingArtifact) {
      const refined = extractOutput(finalText, prior.output);
      if (refined !== null && refined !== existingArtifact.body) {
        run.artifacts[prior.output] = {
          ...existingArtifact,
          body: refined,
          producedAt: Date.now(),
        };
        this.emit({
          type: 'flowArtifactProduced',
          runId,
          artifact: run.artifacts[prior.output],
        });
      }
    }
    this.advanceToStep(runId, nextStepId);
  }

  /// Report each of a run's worktrees that has uncommitted changes (a
  /// dirty working tree, including untracked files). Used by `deleteRun`
  /// to warn before `removeRunWorktrees` discards that work with
  /// `git worktree remove --force`. A worktree whose status can't be read
  /// (path gone, not a git dir) is treated as clean — we don't block a
  /// delete on a directory we can't inspect.
  private runDirtyWorktrees(
    run: FlowRun,
  ): Array<{ name: string; worktreePath: string; fileCount: number }> {
    const out: Array<{ name: string; worktreePath: string; fileCount: number }> = [];
    const check = (name: string, worktreePath: string): void => {
      const status = runGit(['status', '--porcelain'], worktreePath);
      if (status.exitCode !== 0) return;
      const fileCount = status.stdout.split('\n').filter((l) => l.trim().length > 0).length;
      if (fileCount > 0) out.push({ name, worktreePath, fileCount });
    };
    if (run.workspaceWorktrees && run.workspaceWorktrees.length > 0) {
      for (const m of run.workspaceWorktrees) check(m.name, m.worktreePath);
    } else if (run.worktreePath) {
      check(run.flowSnapshot.name, run.worktreePath);
    }
    return out;
  }

  /// Remove the git worktree(s) a run forked, if any. Only invoked from
  /// the explicit `deleteRun` path — NOT from `pruneOldRuns` auto-eviction,
  /// which only frees in-memory/on-disk run metadata and must leave the
  /// user's worktrees and branches untouched. Best-effort: a failure here
  /// never blocks the run deletion itself, since the metadata is already
  /// gone. Mirrors the agent-conversation cleanup in `removeAgent`. Runs
  /// async (and is fired without awaiting from `deleteRun`) so the git
  /// worktree teardown never blocks the delete round-trip or freezes the UI.
  private async removeRunWorktrees(run: FlowRun): Promise<void> {
    // Workspace worktree run: one worktree per member project.
    if (run.workspaceWorktrees && run.workspaceWorktrees.length > 0) {
      for (const m of run.workspaceWorktrees) {
        try {
          const res = await removeWorktreeAsync({
            projectPath: m.projectPath,
            worktreePath: m.worktreePath,
            branchName: m.branchName,
          });
          if (!res.ok && res.error) {
            log('warn', 'flows.deleteRun', `worktree remove failed for ${m.name}: ${res.error}`);
          } else if (res.warning) {
            log('warn', 'flows.deleteRun', `${m.name}: ${res.warning}`);
          }
        } catch (err) {
          log('error', 'flows.deleteRun', `worktree remove threw for ${m.name}`, err);
        }
      }
      return;
    }
    // Single-project worktree run. `git worktree remove` must run from the
    // source repo the worktree was forked from, not the worktree path.
    if (run.worktreePath) {
      const projectPath = run.sourceProjectPath ?? run.projectPath;
      try {
        const res = await removeWorktreeAsync({
          projectPath,
          worktreePath: run.worktreePath,
          branchName: run.branchName ?? '',
        });
        if (!res.ok && res.error) {
          log('warn', 'flows.deleteRun', `worktree remove failed: ${res.error}`);
        } else if (res.warning) {
          log('warn', 'flows.deleteRun', res.warning);
        }
      } catch (err) {
        log('error', 'flows.deleteRun', 'worktree remove threw', err);
      }
    }
  }

  /// Permanently remove a run from memory + disk. Aborts it first if
  /// it's still active so any in-flight subprocess gets a chance to
  /// stop, then removes any git worktree(s) the run forked. Used by the
  /// library's "Delete run" affordance — an explicit user action, distinct
  /// from `pruneOldRuns` auto-eviction which leaves worktrees in place.
  deleteRun(args: { runId: UUID; force?: boolean }):
    | { ok: true }
    | { ok: false; error: string }
    | {
        ok: false;
        needsConfirm: true;
        dirty: Array<{ name: string; worktreePath: string; fileCount: number }>;
      } {
    const run = this.runs.get(args.runId);
    if (!run) {
      // Idempotent: deleting an unknown run is a no-op success rather
      // than a hard error — the persisted file may still exist on disk
      // even if the in-memory map evicted it.
      deleteRunFromDisk(args.runId);
      clearAttachments(args.runId);
      return { ok: true };
    }
    // Guard uncommitted work: unless the caller already confirmed via
    // `force`, refuse to delete a run whose worktree(s) are dirty and
    // hand the renderer the details so it can prompt. Checked before any
    // mutation (stop / evict / disk delete) so a declined confirm leaves
    // the run completely intact.
    if (!args.force) {
      const dirty = this.runDirtyWorktrees(run);
      if (dirty.length > 0) {
        return { ok: false, needsConfirm: true, dirty };
      }
    }
    if (run.state.kind === 'running') {
      const step = run.flowSnapshot.steps.find((s) => s.id === (run.state as any).currentStepId);
      const convId = step ? run.conversationIds[step.participantId] : undefined;
      if (convId) {
        try {
          this.runner.stop(convId);
        } catch {
          // best-effort
        }
      }
    }
    this.runs.delete(args.runId);
    for (const convId of Object.values(run.conversationIds)) {
      this.convIdToRun.delete(convId);
    }
    this.stepBuffers.delete(args.runId);
    this.diffSnapshots.delete(args.runId);
    this.pendingAttachments.delete(args.runId);
    this.watchTicking.delete(args.runId);
    this.watchPhase.delete(args.runId);
    this.watchBuffers.delete(args.runId);
    for (const key of this.retryCounts.keys()) {
      if (key.startsWith(`${args.runId}:`)) this.retryCounts.delete(key);
    }
    for (const key of this.latestAssistantTextByParticipant.keys()) {
      if (key.startsWith(`${args.runId}:`)) {
        this.latestAssistantTextByParticipant.delete(key);
      }
    }
    for (const key of Array.from(this.pauseChatHappened)) {
      if (key.startsWith(`${args.runId}:`)) this.pauseChatHappened.delete(key);
    }
    for (const key of this.finalizeWaiters.keys()) {
      if (key.startsWith(`${args.runId}:`)) {
        const resolver = this.finalizeWaiters.get(key);
        this.finalizeWaiters.delete(key);
        resolver?.();
      }
    }
    deleteRunFromDisk(args.runId);
    clearAttachments(args.runId);
    // Tell the renderer so its in-memory `runs` map evicts in lockstep.
    this.emit({ type: 'flowRunUpdate', run: { ...run, state: { kind: 'aborted' } } });
    // Explicit delete only: tear down the worktree(s) the run forked. This
    // shells out to `git worktree remove`, which can take a second on a large
    // repo — but the run's metadata is already gone and the teardown is
    // best-effort, so fire it in the background rather than making the delete
    // round-trip (and the UI) wait on it. Errors are logged inside.
    void this.removeRunWorktrees(run).catch((err) => {
      log('error', 'flows.deleteRun', 'worktree teardown failed', err);
    });
    return { ok: true };
  }

  abortRun(args: { runId: UUID }): { ok: true } | { ok: false; error: string } {
    const run = this.runs.get(args.runId);
    if (!run) return { ok: false, error: `Run ${args.runId} not found.` };
    if (run.state.kind === 'running') {
      const step = run.flowSnapshot.steps.find(s => s.id === (run.state as any).currentStepId);
      const convId = step ? run.conversationIds[step.participantId] : undefined;
      if (convId) {
        try {
          this.runner.stop(convId);
        } catch {
          // best-effort
        }
      }
    }
    run.state = { kind: 'aborted' };
    // If the run was aborted mid-Continue (rare but possible), the banner's
    // transient "Continuing…" signal is no longer meaningful — clear it.
    if (run.pendingContinue) {
      delete run.pendingContinue;
    }
    this.emitRunUpdate(run);
    this.checkpoint(run); // terminal — save final state
    return { ok: true };
  }

  // ---------------------------------------------------------------------
  // Watch engine — post-completion "stewardship tail"
  // ---------------------------------------------------------------------

  /// Put a completed run into the `watching` state. From here the run stops
  /// doing work and periodically polls `binding` (via the named source +
  /// the user's own tools) for new comments, answering them through the
  /// chosen participant's existing conversation. Only valid on a `done` run.
  enterWatch(args: {
    runId: UUID;
    sourceId: string;
    binding: string;
    instructions?: string;
    participantId?: string;
    pollIntervalSec?: number;
    ttlHours?: number;
  }): { ok: true } | { ok: false; error: string } {
    const run = this.runs.get(args.runId);
    if (!run) return { ok: false, error: `Run ${args.runId} not found.` };
    // Allow starting from a completed run OR re-arming an archived one (the
    // "resume — possibly with edits" path).
    const priorWatch = run.state.kind === 'archived' ? run.state.watch : undefined;
    if (run.state.kind !== 'done' && run.state.kind !== 'archived') {
      return {
        ok: false,
        error: `A watch can only start from a completed or archived run (state: ${run.state.kind}).`,
      };
    }
    const binding = args.binding?.trim() ?? '';
    const instructions = args.instructions?.trim() || undefined;
    if (!binding && !instructions) {
      return { ok: false, error: 'A watch needs either a target to watch or instructions describing one.' };
    }
    // Default the watcher to the participant that ran the LAST step — it has
    // the freshest context of the finished work.
    const lastStep = run.flowSnapshot.steps[run.flowSnapshot.steps.length - 1];
    const participantId = args.participantId ?? lastStep?.participantId;
    if (!participantId || !run.conversationIds[participantId]) {
      return { ok: false, error: `Participant "${participantId}" has no conversation in this run.` };
    }
    const pollIntervalMs = Math.max(
      FlowRuntimeImpl.WATCH_MIN_POLL_MS,
      args.pollIntervalSec ? args.pollIntervalSec * 1000 : FlowRuntimeImpl.WATCH_DEFAULT_POLL_MS,
    );
    // When re-arming an archived watch on the SAME target, carry over the
    // answered-id dedup set / log / tally so it picks up where it left off and
    // doesn't re-answer comments it already handled. If the target
    // (source+binding) changed — e.g. the user fixed a typo — start fresh,
    // because the old answered ids no longer apply.
    const sameTarget =
      !!priorWatch && priorWatch.sourceId === (args.sourceId || 'ai') && priorWatch.binding === binding;
    // The detect tier runs on a cheap/fast same-backend model so the frequent
    // no-op ticks are near-free; the answer tier uses the participant's full
    // model. Same-target resume keeps the prior detect model.
    const participant = run.flowSnapshot.participants?.find((p) => p.id === participantId);
    const fullModel = effectiveParticipantModel(run, participantId);
    const watchModel =
      participant ? cheapDetectModel(participant.backend, fullModel) : fullModel;
    const watch: WatchState = {
      sourceId: args.sourceId || 'ai',
      binding,
      instructions,
      participantId,
      watchModel,
      pollIntervalMs,
      expiresAt: args.ttlHours && args.ttlHours > 0 ? Date.now() + args.ttlHours * 3_600_000 : undefined,
      answered: sameTarget ? priorWatch!.answered : 0,
      escalated: sameTarget ? priorWatch!.escalated : false,
      answeredIds: sameTarget ? priorWatch!.answeredIds : undefined,
      log: sameTarget ? priorWatch!.log : undefined,
    };
    if (sameTarget && priorWatch!.watchModel) watch.watchModel = priorWatch!.watchModel;
    run.state = { kind: 'watching', watch };
    this.emitRunUpdate(run);
    this.checkpoint(run);
    this.ensureWatchTimer();
    return { ok: true };
  }

  /// End a watched run. The off-switch for the stewardship tail — keeps the
  /// final tally so the UI can still show "answered N". Also a clean no-op
  /// terminal for a run that was never watching (just marks it archived).
  archiveRun(args: { runId: UUID }): { ok: true } | { ok: false; error: string } {
    const run = this.runs.get(args.runId);
    if (!run) return { ok: false, error: `Run ${args.runId} not found.` };
    // Preserve a previously-saved watch when re-archiving an already-archived
    // run. archiveRun can fire more than once on the same run (e.g. a quick
    // double-click on Archive, or a click on a stale card after the run was
    // already archived) because the Archive button isn't debounced and state
    // propagates back to the renderer asynchronously. Only the FIRST call sees
    // `watching`; if a later call fell through to `undefined` here it would
    // clobber the saved watch, leaving an archived run with no `watch` and so
    // no way to resume it.
    const watch =
      run.state.kind === 'watching'
        ? run.state.watch
        : run.state.kind === 'archived'
          ? run.state.watch
          : undefined;
    // If a tick is in flight, stop the watcher's subprocess so it doesn't
    // post a stray reply after the user closed the watch.
    if (run.state.kind === 'watching' && this.watchTicking.has(run.id)) {
      const convId = run.conversationIds[run.state.watch.participantId];
      if (convId) {
        try {
          this.runner.stop(convId);
        } catch {
          // best-effort
        }
      }
    }
    this.watchTicking.delete(run.id);
    this.watchPhase.delete(run.id);
    this.watchBuffers.delete(run.id);
    // The run is terminal now — drop its conversation routing entries so
    // observeEvent doesn't keep resolving them to an archived run. A resume
    // re-registers the watcher conversation via watchTick.
    for (const cid of Object.values(run.conversationIds)) {
      this.convIdToRun.delete(cid);
    }
    run.state = { kind: 'archived', watch };
    this.emitRunUpdate(run);
    this.checkpoint(run);
    return { ok: true };
  }

  /// Lazily start the single sweep timer. Idempotent. Uses `unref` so the
  /// timer never keeps the process alive on its own.
  private ensureWatchTimer(): void {
    if (this.watchTimer) return;
    this.watchTimer = setInterval(() => this.sweepWatchers(), FlowRuntimeImpl.WATCH_SWEEP_MS);
    this.watchTimer.unref?.();
  }

  /// One sweep: archive any expired watches, then fire a tick for each
  /// watching run that's due and not already ticking.
  private sweepWatchers(): void {
    const now = Date.now();
    let anyWatching = false;
    for (const run of this.runs.values()) {
      if (run.state.kind !== 'watching') continue;
      anyWatching = true;
      const w = run.state.watch;
      if (w.expiresAt && now >= w.expiresAt) {
        this.archiveRun({ runId: run.id });
        continue;
      }
      if (this.watchTicking.has(run.id)) continue;
      const due = (w.lastTickAt ?? 0) + w.pollIntervalMs;
      if (now >= due) void this.watchTick(run.id);
    }
    // Nothing left to watch — stop the timer; enterWatch re-arms it.
    if (!anyWatching && this.watchTimer) {
      clearInterval(this.watchTimer);
      this.watchTimer = null;
    }
  }

  /// Fire one DETECT tick: send the source's detect prompt to the watcher
  /// participant's conversation on the cheap watch model. The reply streams
  /// back through `observeEvent`, which calls `onWatchTickFinished` when it
  /// drains. Detect posts nothing — it only decides whether anything needs
  /// the (expensive) answer pass.
  private async watchTick(runId: UUID): Promise<void> {
    const run = this.runs.get(runId);
    if (!run || run.state.kind !== 'watching') return;
    const w = run.state.watch;
    const participant = run.flowSnapshot.participants.find((p) => p.id === w.participantId);
    const convId = run.conversationIds[w.participantId];
    if (!participant || !convId) {
      // Can't tick without a participant conversation — back off a cycle.
      w.lastTickAt = Date.now();
      return;
    }
    const source = getWatchSource(w.sourceId);
    const prompt = source.buildDetectPrompt({
      binding: w.binding,
      answeredIds: w.answeredIds,
      instructions: w.instructions,
      workSummary: this.summarizeWork(run),
    });
    this.watchTicking.add(runId);
    this.watchPhase.set(runId, 'detect');
    this.watchBuffers.set(runId, '');
    this.convIdToRun.set(convId, runId);
    // Detect runs on the cheap watch model (the frequent no-op case). Falls
    // back to the participant's full model when no cheap model was resolved.
    const detectModel = w.watchModel || effectiveParticipantModel(run, w.participantId);
    const sendResult = this.sendWatchTurn({
      convId,
      backend: participant.backend,
      cwd: run.projectPath,
      model: detectModel,
      prompt,
      displayText: `Watching ${w.binding || 'follow-ups'} — checking for new comments…`,
    });
    if (!sendResult.ok) {
      this.watchTicking.delete(runId);
      this.watchPhase.delete(runId);
      this.watchBuffers.delete(runId);
      w.lastTickAt = Date.now(); // back off; the sweep retries next interval
      w.lastNote = `Watch tick could not start: ${sendResult.error}`;
      this.emitRunUpdate(run);
      this.checkpoint(run);
    }
  }

  /// Fire the ANSWER pass after detect escalated: same conversation, but the
  /// participant's FULL model, told to post a grounded reply. `detected` is
  /// the detect pass's note describing what to answer.
  private sendWatchAnswer(runId: UUID, detected: string): void {
    const run = this.runs.get(runId);
    if (!run || run.state.kind !== 'watching') return;
    const w = run.state.watch;
    const participant = run.flowSnapshot.participants.find((p) => p.id === w.participantId);
    const convId = run.conversationIds[w.participantId];
    if (!participant || !convId) {
      this.finalizeWatchTick(runId, null);
      return;
    }
    const source = getWatchSource(w.sourceId);
    const prompt = source.buildAnswerPrompt({
      binding: w.binding,
      answeredIds: w.answeredIds,
      instructions: w.instructions,
      workSummary: this.summarizeWork(run),
      detected,
    });
    this.watchPhase.set(runId, 'answer');
    this.watchBuffers.set(runId, '');
    const sendResult = this.sendWatchTurn({
      convId,
      backend: participant.backend,
      cwd: run.projectPath,
      model: effectiveParticipantModel(run, w.participantId),
      prompt,
      displayText: `Answering on ${w.binding || 'the watched item'}…`,
    });
    if (!sendResult.ok) {
      // Couldn't launch the answer pass — a real question is going unanswered,
      // so escalate to the human (needsWork → finalizeWatchTick notifies) rather
      // than letting it pass silently. The question's id never lands in the
      // answered set, so it's re-detected on the next tick.
      this.finalizeWatchTick(runId, {
        answered: 0,
        needsWork: true,
        note: `A new comment needs a reply, but the answer pass could not start: ${sendResult.error}`,
      });
    }
  }

  /// Shared `runner.send` for both watch tiers — same unattended config
  /// (bypassPermissions, no reviewer, unrestricted tools). Answer-only is
  /// enforced by the prompt contract, not the permission mode: for non-Ollama
  /// backends overcli can't restrict the CLI's tool surface, and the watch
  /// runs unattended, so we rely on the "do not change anything" contract.
  private sendWatchTurn(args: {
    convId: UUID;
    backend: Backend;
    cwd: string;
    model: string;
    prompt: string;
    displayText: string;
  }): ReturnType<RunnerManager['send']> {
    return this.runner.send({
      conversationId: args.convId,
      prompt: args.prompt,
      displayText: args.displayText,
      backend: args.backend,
      cwd: args.cwd,
      model: args.model,
      permissionMode: 'bypassPermissions',
      reviewBackend: null,
      reviewMode: null,
      reviewModel: null,
      reviewPersona: null,
      enabledTools: undefined,
    });
  }

  /// A drained tick turn. Detect → maybe escalate to the answer pass;
  /// answer (or a no-escalation detect) → finalize.
  private onWatchTickFinished(runId: UUID): void {
    const run = this.runs.get(runId);
    const phase = this.watchPhase.get(runId);
    const text = this.watchBuffers.get(runId) ?? '';
    this.watchBuffers.delete(runId);
    if (!run || run.state.kind !== 'watching') {
      this.watchTicking.delete(runId);
      this.watchPhase.delete(runId);
      return;
    }
    const report = parseWatchReport(text);

    // A tick that DID reach its tools clears any prior "can't reach tools"
    // escalation, so the next genuine outage notifies again.
    if (report && !report.toolsUnavailable && run.state.watch.toolsUnreachable) {
      run.state.watch.toolsUnreachable = false;
    }

    // Self-heal: the detect model couldn't reach the source's tools (e.g. it
    // can't drive the deferred Atlassian/Slack MCP). Climb ONE rung of the
    // detect ladder (cheapest → … → the participant's full model) so the next
    // tick tries a more capable model, then finalize this (wasted) tick. If
    // we're already on the top rung the tool is genuinely unreachable — notify
    // the user once (so a broken watch surfaces instead of silently spinning)
    // and keep going.
    if (phase === 'detect' && report?.toolsUnavailable) {
      const w = run.state.watch;
      const participant = run.flowSnapshot.participants.find((p) => p.id === w.participantId);
      const full = effectiveParticipantModel(run, w.participantId);
      const ladder = participant ? detectModelLadder(participant.backend, full) : [];
      const idx = ladder.indexOf(w.watchModel ?? ladder[0]);
      const next = idx >= 0 ? ladder[idx + 1] : undefined;
      if (participant && next && next !== w.watchModel) {
        // Still have a stronger model to try.
        w.watchModel = next;
        report.note = `${report.note} — couldn't reach tools, escalated detect to ${friendlyModelLabel(participant.backend, next)}.`;
      } else if (!w.toolsUnreachable) {
        // Top of the ladder and still can't reach the tools — surface it once.
        w.toolsUnreachable = true;
        const label = w.binding || 'your watch';
        notifyWatch(
          `Overcli watch can't reach its tools — ${label}`,
          report.note ||
            'The watcher has no working tool to reach the target. Check that the connector/MCP is installed and authenticated.',
        );
      }
      this.finalizeWatchTick(runId, report);
      return;
    }

    // Detect found a genuine question → run the premium answer pass. Note we
    // do NOT gate this on `!needsWork`: a tick can have BOTH an answerable
    // question AND a standing work request, and a ticket with an open work
    // item would otherwise suppress answering forever (every tick reports
    // needsWork=true). The answer pass answers the question and re-reports
    // needsWork itself, so the human still gets escalated — both happen,
    // independently.
    if (phase === 'detect' && report?.answerNeeded) {
      this.sendWatchAnswer(runId, report.note);
      return;
    }

    this.finalizeWatchTick(runId, report);
  }

  /// Record the comment ids the watcher replied to so they're never answered
  /// again. Capped to bound the persisted run.
  private static readonly WATCH_ANSWERED_CAP = 200;
  private appendAnsweredIds(w: WatchState, ids: string[] | undefined): void {
    if (!ids?.length) return;
    const merged = [...(w.answeredIds ?? []), ...ids];
    // Dedupe (last-wins order preserved) and cap to the most recent.
    w.answeredIds = Array.from(new Set(merged)).slice(-FlowRuntimeImpl.WATCH_ANSWERED_CAP);
  }

  /// Close out a tick: fix the baseline (first tick), record answered ids,
  /// bump counters, log, notify / escalate, checkpoint. `report` is null when
  /// the turn produced no parsable block.
  private finalizeWatchTick(runId: UUID, report: WatchTickReport | null): void {
    this.watchTicking.delete(runId);
    this.watchPhase.delete(runId);
    const run = this.runs.get(runId);
    if (!run || run.state.kind !== 'watching') return;
    const w = run.state.watch;
    w.lastTickAt = Date.now();

    if (!report) {
      w.lastNote = 'Watch tick produced no report block.';
      this.appendWatchLog(w, { at: w.lastTickAt, answered: 0, needsWork: false, note: w.lastNote });
      this.emitRunUpdate(run);
      this.checkpoint(run);
      return;
    }
    this.appendAnsweredIds(w, report.answeredIds);
    if (report.answered > 0) w.answered += report.answered;
    w.lastNote = report.note;
    this.appendWatchLog(w, {
      at: w.lastTickAt,
      answered: report.answered,
      needsWork: report.needsWork,
      note: report.note,
    });

    const label = w.binding || 'your watch';
    if (report.answered > 0) {
      notifyWatch(`Overcli watch — ${label}`, report.note || `Answered ${report.answered} comment(s).`);
    }
    if (report.needsWork) {
      // Escalation is the trust boundary: the watcher saw work being asked
      // for, did NOT do it, and pulls the human back in. Notify loudly the
      // first time; keep the flag so the UI shows "needs you".
      if (!w.escalated) {
        notifyWatch(
          `Overcli watch needs you — ${label}`,
          report.note || 'A comment requests work. Reopen the flow to act.',
        );
      }
      w.escalated = true;
    }
    this.emitRunUpdate(run);
    this.checkpoint(run);
  }

  /// Append a tick to the watch log, capped to the most recent entries so a
  /// long-lived watch can't grow the persisted run unbounded.
  private static readonly WATCH_LOG_CAP = 50;
  private appendWatchLog(w: WatchState, entry: WatchTickLogEntry): void {
    const log = w.log ?? [];
    log.push(entry);
    w.log = log.slice(-FlowRuntimeImpl.WATCH_LOG_CAP);
  }

  /// A short grounding blurb describing what the flow accomplished, fed to
  /// every watch tick so the watcher answers from the real work rather than
  /// guessing. Kept compact — the participant's own conversation already
  /// holds the full transcript.
  private summarizeWork(run: FlowRun): string {
    const parts: string[] = [];
    const prompt = run.userPrompt?.trim();
    if (prompt) parts.push(`Original request: ${prompt.slice(0, 600)}`);
    const artifactNames = Object.keys(run.artifacts);
    if (artifactNames.length > 0) {
      parts.push(`Artifacts produced: ${artifactNames.join(', ')}.`);
    }
    return parts.join('\n') || '(this run produced no recorded artifacts)';
  }

  // ---------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------

  /// Set (or clear) the per-participant model override for a run. Pass
  /// `null`/empty to revert to the participant's declared model. The
  /// override drives all subsequent turns for that participant (step
  /// orchestration, finalize, question-answers, hijack) and is persisted
  /// so it survives a restart. Emits a run update so the renderer's
  /// synthesized conversation + badge reflect the change immediately.
  setModelOverride(
    runId: UUID,
    participantId: string,
    model: string | null,
  ): { ok: true } | { ok: false; error: string } {
    const run = this.runs.get(runId);
    if (!run) return { ok: false, error: `Run ${runId} not found.` };
    const participant = run.flowSnapshot.participants?.find((p) => p.id === participantId);
    if (!participant) {
      return { ok: false, error: `Participant "${participantId}" not in run.` };
    }
    if (participant.backend !== 'ollama' && model && !isSupportedPremiumModel(participant.backend, model)) {
      return {
        ok: false,
        error: `Model "${model}" is not supported for backend "${participant.backend}".`,
      };
    }
    const next = { ...(run.modelOverrides ?? {}) };
    const trimmed = model?.trim();
    if (!trimmed || trimmed === participant.model) {
      if (!(participantId in next)) return { ok: true }; // already declared
      delete next[participantId];
    } else {
      if (next[participantId] === trimmed) return { ok: true };
      next[participantId] = trimmed;
    }
    run.modelOverrides = Object.keys(next).length > 0 ? next : undefined;
    this.checkpoint(run);
    this.emitRunUpdate(run);
    return { ok: true };
  }

  private async executeStep(runId: UUID, stepId: string): Promise<void> {
    const run = this.runs.get(runId);
    if (!run) return;
    const step = run.flowSnapshot.steps.find(s => s.id === stepId);
    if (!step) {
      this.failRun(run, `Step "${stepId}" not found in flow.`);
      return;
    }

    // NOTE: pre-step pause is handled by `advanceAfterStep` (after the
    // prior step finishes) and by `resumeRun` (transitioning out of the
    // pause). Re-checking `step.pauseBefore` here would re-pause the run
    // every time the user hits Continue, leaving the build step stuck.

    // Find or mint the participant's hidden Conversation. Each
    // participant has ONE conv across the whole run; multiple steps
    // assigned to the same participant share it, so the planner remembers
    // its plan when it later reviews. If the participant's id can't be
    // resolved to a real participant, fall back to a per-step conv to
    // avoid hanging the run.
    const participantId = step.participantId || step.id;
    let convId = run.conversationIds[participantId];
    if (!convId) {
      convId = randomUUID();
      run.conversationIds[participantId] = convId;
    }
    this.convIdToRun.set(convId, runId);
    // Fresh buffer for this step's turn — the conv may already have
    // earlier steps' transcripts inside it, but artifact extraction
    // should only see what THIS step produces.
    this.stepBuffers.set(runId, {
      assistantText: '',
      usage: { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 },
      costUSD: 0,
    });

    const prompt = this.buildStepPrompt(run, step);
    const attempt: FlowStepAttempt & { stepId: string } = {
      stepId: step.id,
      startedAt: Date.now(),
      conversationId: convId,
    };
    run.attempts.push(attempt);
    this.emitRunUpdate(run);

    const stepModel = resolveRunStepModel(run, step);
    // Visible-bubble text — the cleaner view of the same step request,
    // formatted as markdown so the user sees:
    //   - their request prominently
    //   - inputs rendered as headed sections (markdown bodies render as
    //     real markdown via UserBubble's flow renderer)
    // The model still receives the full `prompt` with role + contract,
    // so behavior doesn't change.
    const displayText = this.buildStepDisplayText(run, step);
    // Launch attachments ride along with the step(s) that consume the
    // user's prompt — typically just the first / planning step.
    const attachments = step.inputs.includes(FLOW_USER_PROMPT_REF)
      ? this.pendingAttachments.get(runId)
      : undefined;
    const sendResult = this.runner.send({
      conversationId: convId,
      prompt,
      displayText,
      attachments,
      backend: stepModel.backend,
      cwd: run.projectPath,
      model: stepModel.model,
      permissionMode: this.resolvePermissionMode(run, step),
      reviewBackend: step.rebound?.critic.backend ?? null,
      reviewMode: step.rebound?.mode ?? null,
      reviewModel: step.rebound?.critic.model ?? null,
      reviewPersona: step.rebound?.persona ?? null,
      // Tool allowlist is only enforceable on the Ollama path (overcli
      // owns the dispatch). For Claude/Codex/Gemini/Copilot, the CLI's
      // permission mode is the gate — the user opts into autonomy via
      // bypassPermissions/acceptEdits, or gets prompted per call.
      enabledTools: stepModel.backend === 'ollama' ? step.tools : undefined,
    });
    if (!sendResult.ok) {
      this.finishAttempt(run, step.id, { outcome: 'error', errorMessage: sendResult.error });
      this.handleStepFailure(runId, step, sendResult.error);
      return;
    }
  }

  private onStepFinished(runId: UUID, stepId: string): void {
    const run = this.runs.get(runId);
    if (!run) return;
    const step = run.flowSnapshot.steps.find(s => s.id === stepId);
    if (!step) return;
    const buf = this.stepBuffers.get(runId);
    const text = buf?.assistantText ?? '';

    const artifactBody = extractOutput(text, step.output);
    if (artifactBody === null) {
      // No <output> block — treat as failure so onFail policy decides.
      this.finishAttempt(run, step.id, {
        outcome: 'error',
        errorMessage: `Step "${step.id}" produced no <output name="${step.output}"> block.`,
      });
      this.handleStepFailure(runId, step, `missing <output name="${step.output}"> in assistant text`);
      return;
    }

    const kind = detectArtifactKind(step.output);
    // For diff-kind artifacts, prefer the real filesystem diff over
    // whatever the model emitted. Models — especially smaller local
    // ones — routinely narrate ("Added [path](...)" bullet lists)
    // instead of producing valid unified-diff output, which makes the
    // resulting artifact useless for review or downstream piping.
    // Computing it from the worktree against `baselineCommit` guarantees
    // it reflects what actually changed on disk.
    // For diffs the artifact handed downstream (`run.artifacts[name]`) is
    // the CUMULATIVE worktree diff — review/test/ship steps want the whole
    // change so far as context. But the body we DISPLAY for this step is
    // only its INCREMENTAL change, so a flow with several diff steps doesn't
    // show the same growing blob over and over. Both come from the real
    // filesystem rather than the model's narration.
    let body = artifactBody;
    let displayBody = artifactBody;
    if (kind === 'diff') {
      const realDiff = computeRunDiffForRun(run);
      if (realDiff !== null) body = realDiff;
      const incremental = this.computeIncrementalDiffForRun(run);
      // Fall back to the cumulative diff when an incremental can't be
      // computed (non-git cwd, or snapshot lost across a restart).
      displayBody = incremental ?? body;
    }

    const artifact: FlowArtifact = {
      name: step.output,
      kind,
      body,
      producedByStepId: step.id,
      producedAt: Date.now(),
    };
    run.artifacts[step.output] = artifact;
    this.emit({ type: 'flowArtifactProduced', runId, artifact });
    // Per-step display copy. Same as `artifact` for everything except
    // diffs, where the body is this step's increment (see above).
    const displayArtifact: FlowArtifact =
      displayBody === body ? artifact : { ...artifact, body: displayBody };
    const usageTotals = buf
      ? {
          usage: { ...buf.usage },
          costUSD: buf.costUSD > 0 ? buf.costUSD : undefined,
        }
      : {};
    this.finishAttempt(run, step.id, {
      outcome: 'success',
      artifact: displayArtifact,
      ...usageTotals,
    });
    // Step boundary: artifact extracted, ready to advance. Persist NOW so
    // an unexpected exit between here and the next step start can be
    // resumed: on restart the run will be in `paused` (set by
    // advanceAfterStep below if there's another step) or `done`.
    this.checkpoint(run);

    // Verdict gate: a reviewer-role step produced its artifact cleanly, but
    // if the verdict isn't an approval the flow must NOT roll on to
    // downstream steps (tests/push) over disapproved work. Route it through
    // the normal `on_fail` policy — pause by default, or `goto` to loop
    // back to an earlier step the user wired up. The artifact itself is
    // already recorded above, so the user sees the rejecting review.
    if (isGatingReviewerRole(step.role) && !isReviewApproved(body)) {
      this.handleStepFailure(
        runId,
        step,
        `Reviewer step "${step.id}" did not approve (no "APPROVED" verdict in ${step.output}).`,
      );
      return;
    }

    this.advanceAfterStep(runId, step.id);
  }

  private advanceAfterStep(runId: UUID, finishedStepId: string): void {
    const run = this.runs.get(runId);
    if (!run) return;
    const idx = run.flowSnapshot.steps.findIndex(s => s.id === finishedStepId);
    const next = run.flowSnapshot.steps[idx + 1];
    if (!next) {
      run.state = { kind: 'done', success: true };
      this.emitRunUpdate(run);
      this.checkpoint(run); // terminal — save final state
      return;
    }
    // pause_before on the next step → park; resumeRun picks it up.
    if (next.pauseBefore) {
      run.state = { kind: 'paused', nextStepId: next.id, reason: 'preStep' };
      this.emitRunUpdate(run);
      this.checkpoint(run); // boundary — paused state is resumable across restart
      return;
    }
    run.state = { kind: 'running', currentStepId: next.id };
    this.emitRunUpdate(run);
    void this.executeStep(runId, next.id);
  }

  private handleStepFailure(runId: UUID, step: FlowStep, message: string): void {
    const run = this.runs.get(runId);
    if (!run) return;
    const policy = step.onFail ?? { action: 'pause' };

    if (policy.action === 'abort') {
      run.state = { kind: 'aborted' };
      this.emitRunUpdate(run);
      this.checkpoint(run); // terminal — save final state
      return;
    }

    if (policy.action === 'goto') {
      const key = `${runId}:${step.id}`;
      const used = this.retryCounts.get(key) ?? 0;
      if (used < policy.maxRetries) {
        this.retryCounts.set(key, used + 1);
        run.state = { kind: 'running', currentStepId: policy.target };
        this.emitRunUpdate(run);
        void this.executeStep(runId, policy.target);
        return;
      }
      // retries exhausted → pause.
    }

    // pause (default + retries-exhausted fallthrough)
    run.state = { kind: 'paused', nextStepId: step.id, reason: 'failure' };
    this.emitRunUpdate(run);
    this.checkpoint(run); // boundary — failure-pause is resumable
  }

  /// Compute what the JUST-FINISHED diff step changed on its own — the
  /// delta between the worktree snapshot taken after the previous diff step
  /// and the worktree right now. Advances the stored snapshot so the next
  /// diff step measures from here. Returns null when the run has no git
  /// baseline (non-git cwd) or git fails, letting the caller fall back to
  /// the cumulative diff. Mirrors `computeRunDiffForRun`'s single-repo vs
  /// per-member workspace split.
  private computeIncrementalDiffForRun(run: FlowRun): string | null {
    let snaps = this.diffSnapshots.get(run.id);
    if (!snaps) {
      snaps = new Map();
      this.diffSnapshots.set(run.id, snaps);
    }
    const measure = (key: string, cwd: string, baseline: string): string | null => {
      // First diff step measures from the run's baseline commit; later
      // ones measure from the previous step's snapshot.
      const from = snaps!.get(key) ?? baseline;
      const res = computeIncrementalDiff(cwd, from);
      if (!res) return null;
      snaps!.set(key, res.snapshot); // advance for the next diff step
      return res.diff;
    };

    if (run.baselineCommitsByMember) {
      const blocks: string[] = [];
      for (const [name, info] of Object.entries(run.baselineCommitsByMember)) {
        const d = measure(name, info.path, info.commit);
        if (d) blocks.push(`# ${name}\n${d}`);
      }
      return blocks.length === 0 ? null : blocks.join('\n');
    }
    if (run.baselineCommit) {
      return measure('__single__', run.projectPath, run.baselineCommit);
    }
    return null;
  }

  private buildStepPrompt(run: FlowRun, step: FlowStep): string {
    const systemPrompt = resolveSystemPrompt({
      role: step.role,
      override: step.systemPromptOverride,
      outputName: step.output,
    });

    // Each input becomes either an inline body (small enough to live in
    // the prompt) or an on-disk attachment (referenced by absolute
    // path; the CLI's own Read tool pulls it when the model needs it).
    // user_prompt is always inline — it's the user's words and tends
    // to be short.
    type InlineInput = { kind: 'inline'; name: string; body: string };
    type AttachedInput = { kind: 'attached'; name: string; path: string; size: number };
    type InputPart = InlineInput | AttachedInput;

    const stepModel = resolveRunStepModel(run, step);
    const canAttach = stepModel.backend !== 'ollama';

    const rawInputs: Array<{ name: string; body: string }> = [];
    for (const ref of step.inputs) {
      if (ref === FLOW_USER_PROMPT_REF) {
        rawInputs.push({ name: 'user_prompt', body: run.userPrompt });
      } else {
        const art = run.artifacts[ref];
        if (art) rawInputs.push({ name: ref, body: art.body });
      }
    }

    const inputParts: InputPart[] = rawInputs.map((p) => {
      const isLarge = p.body.length > FlowRuntimeImpl.INLINE_THRESHOLD_BYTES;
      if (canAttach && isLarge && p.name !== 'user_prompt') {
        try {
          const att = writeAttachment(run.id, p.name, p.body);
          return { kind: 'attached', name: p.name, path: att.path, size: att.size };
        } catch (err) {
          // Disk write failed — fall back to inlining, the budget
          // truncation below will keep us from sending too much.
          log('warn', 'flows.attachmentWrite', `attachment write failed for ${p.name}`, err);
          return { kind: 'inline', name: p.name, body: p.body };
        }
      }
      return { kind: 'inline', name: p.name, body: p.body };
    });

    // Backstop budget: even after attaching, the remaining INLINE bytes
    // can exceed the budget if a flow happens to have many medium-size
    // inputs. We truncate then — but with smallest-first priority so
    // small inputs (plan.md, ticket.md) survive intact and the biggest
    // remaining inline absorbs whatever's left. user_prompt is always
    // kept verbatim regardless of size.
    const budget =
      stepModel.backend === 'ollama'
        ? FlowRuntimeImpl.PROMPT_BUDGET_OLLAMA
        : FlowRuntimeImpl.PROMPT_BUDGET_PREMIUM;
    const overhead = systemPrompt.length + 500; // wrappers + instructions
    const inlineParts = inputParts.filter(
      (p): p is InlineInput => p.kind === 'inline',
    );
    const totalInlineBytes = inlineParts.reduce((n, p) => n + p.body.length, 0);
    const truncationNotes: string[] = [];
    if (overhead + totalInlineBytes > budget) {
      let remaining = Math.max(0, budget - overhead);
      const ordered = [...inlineParts].sort((a, b) => {
        // user_prompt first (always kept), then smallest → biggest so
        // small inputs are fully included before the giant ones eat
        // the remaining budget.
        if (a.name === 'user_prompt' && b.name !== 'user_prompt') return -1;
        if (b.name === 'user_prompt' && a.name !== 'user_prompt') return 1;
        return a.body.length - b.body.length;
      });
      for (const p of ordered) {
        if (p.name === 'user_prompt') {
          remaining -= p.body.length; // accept overrun — keep user words verbatim
          continue;
        }
        if (p.body.length <= remaining) {
          remaining -= p.body.length;
          continue;
        }
        const keep = Math.max(2_000, remaining);
        const dropped = p.body.length - keep;
        p.body =
          p.body.slice(0, keep) +
          `\n\n[…truncated ${dropped.toLocaleString()} characters to fit context budget…]`;
        truncationNotes.push(`${p.name}: dropped ${dropped.toLocaleString()} chars`);
        remaining = Math.max(0, remaining - keep);
      }
    }

    const renderedInputs = inputParts.map((p) => {
      if (p.kind === 'inline') {
        return `<input name="${p.name}">\n${p.body}\n</input>`;
      }
      return (
        `<input name="${p.name}" attached="${p.path}" size="${p.size}">\n` +
        `This input is too large to inline. Use your file-reading tool ` +
        `(Read / read_file / similar) on the path "${p.path}" to load the ` +
        `bytes when you need them. Treat its contents as artifact "${p.name}".\n` +
        `</input>`
      );
    });
    const inputs = renderedInputs.length > 0 ? renderedInputs.join('\n\n') : '(no inputs provided)';

    const attachedCount = inputParts.filter((p) => p.kind === 'attached').length;
    const preambleNotes: string[] = [];
    if (attachedCount > 0) {
      preambleNotes.push(
        `${attachedCount} input(s) were attached as files rather than inlined. ` +
          'Read them with your file-reading tool — do not assume they are empty.',
      );
    }
    if (truncationNotes.length > 0) {
      preambleNotes.push(
        `Inputs still exceeded the context budget and were truncated: ${truncationNotes.join('; ')}. ` +
          'Ask the user (or earlier steps) for a more focused source if anything critical was lost.',
      );
    }
    const preamble = preambleNotes.length > 0 ? `\n\nNOTE: ${preambleNotes.join(' ')}` : '';

    return (
      `${systemPrompt}${preamble}\n\n---\n\nINPUTS:\n\n${inputs}\n\n---\n\n` +
      `Proceed with your task now. Remember to wrap your final deliverable in ` +
      `<output name="${step.output}">…</output>.`
    );
  }

  /// True when the step's participant already completed an EARLIER step in
  /// this run — i.e. its persistent conversation is being resumed rather
  /// than started fresh. Used to add a "picking up this thread" note so the
  /// user understands the model carries its prior context forward.
  private isParticipantContinuation(run: FlowRun, step: FlowStep): boolean {
    const participantId = step.participantId;
    if (!participantId) return false;
    return run.attempts.some((a) => {
      if (a.stepId === step.id) return false; // ignore this step's own attempts
      if (a.outcome !== 'success') return false;
      const prior = run.flowSnapshot.steps.find((s) => s.id === a.stepId);
      return prior?.participantId === participantId;
    });
  }

  /// Build the user-facing "I'm running step X" message. NOT what the model
  /// sees — the model gets the full prompt from buildStepPrompt above. This
  /// is split into labeled sections the renderer turns into separate cards:
  ///   - `<!--flow:header-->`       the step title + (when the same
  ///                                participant ran an earlier step) a
  ///                                "picking up this thread" continuation note
  ///   - `<!--flow:instructions-->` the role's system prompt, verbatim, so
  ///                                the user can see what the step was told
  ///                                to do — answering "why are the
  ///                                instructions so short?" (they aren't)
  ///   - `<!--flow:inputs-->`       the artifacts handed to this step
  ///
  /// The leading `<!--flow-->` marker switches the bubble into card mode;
  /// keep all four markers in sync with FlowStepCards.tsx in the renderer.
  private buildStepDisplayText(run: FlowRun, step: FlowStep): string {
    // Header — title plus a continuity note when this participant already
    // produced an earlier step's output (same persistent conversation is
    // being resumed, so the model keeps its prior context).
    const header: string[] = [`### Step: \`${step.id}\`  ·  ${step.role}`];
    if (this.isParticipantContinuation(run, step)) {
      header.push(
        `_↩ Picking up this thread — same model as a previous step, ` +
          `now starting the **${step.id}** step._`,
      );
    }

    // Instructions — the role's system prompt, shown verbatim. The artifact
    // output contract is boilerplate appended to every step, so we leave it
    // out here and show only the role-specific guidance.
    const instructions =
      step.role === 'custom'
        ? (step.systemPromptOverride ?? '').trim()
        : ROLE_PROMPTS[step.role];

    // Inputs — the artifacts (and/or the original request) feeding this step.
    const inputs: Array<{ name: string; body: string }> = [];
    for (const ref of step.inputs) {
      if (ref === FLOW_USER_PROMPT_REF) {
        inputs.push({ name: 'your request', body: run.userPrompt.trim() });
      } else {
        const art = run.artifacts[ref];
        if (art) inputs.push({ name: ref, body: art.body });
      }
    }
    const inputParts: string[] = [];
    if (inputs.length === 0) {
      inputParts.push('_no inputs_');
    } else {
      for (const inp of inputs) {
        inputParts.push(`#### ${inp.name}`);
        inputParts.push(formatInputBodyForDisplay(inp.name, inp.body));
      }
    }

    const parts: string[] = ['<!--flow-->'];
    parts.push('<!--flow:header-->');
    parts.push(header.join('\n\n'));
    if (instructions) {
      parts.push('<!--flow:instructions-->');
      parts.push(instructions);
    }
    parts.push('<!--flow:inputs-->');
    parts.push(inputParts.join('\n\n'));
    return parts.join('\n\n');
  }

  private resolvePermissionMode(run: FlowRun, step: FlowStep): PermissionMode {
    if (step.permissionMode) return step.permissionMode;
    // Flows are designed to run unattended — the user has already opted
    // into "automate this whole pipeline".
    //   - Ollama: step.tools is an authoritative allowlist; only flip
    //     into bypassPermissions when a write tool is actually granted.
    //   - Claude/Codex/Gemini/Copilot: the CLI owns the tool surface,
    //     not us. Default to bypassPermissions so the flow doesn't
    //     stall on every Bash/Edit prompt — the user can downgrade to
    //     'default'/'acceptEdits' on the step itself.
    const stepModel = resolveStepModel(run.flowSnapshot, step);
    if (stepModel.backend !== 'ollama') return 'bypassPermissions';
    const writeTools = new Set(['write_file', 'edit_file', 'bash']);
    const hasWrite = step.tools.some(t => writeTools.has(t));
    return hasWrite ? 'bypassPermissions' : 'default';
  }

  private finishAttempt(run: FlowRun, stepId: string, patch: Partial<FlowStepAttempt>): void {
    // Find the most recent attempt for this step.
    for (let i = run.attempts.length - 1; i >= 0; i--) {
      if (run.attempts[i].stepId === stepId) {
        Object.assign(run.attempts[i], { endedAt: Date.now(), ...patch });
        break;
      }
    }
  }

  private failRun(run: FlowRun, message: string): void {
    run.state = { kind: 'aborted' };
    this.emitRunUpdate(run);
    this.emit({ type: 'error', conversationId: run.id, message });
  }

  /// Register the run observer (see `runObserver`). Called once at wiring
  /// time in main/index.ts after both the runtime and orchestrator exist.
  setRunObserver(cb: (run: FlowRun) => void): void {
    this.runObserver = cb;
  }

  /// Push a worktree-preparation progress beat to the renderer during a
  /// launch, before the FlowRun exists. The launching pane (keyed on the
  /// same target `projectPath`) renders it under its spinner.
  private emitLaunchProgress(
    projectPath: string,
    p: { completed: number; total: number; message: string },
  ): void {
    this.emit({ type: 'flowLaunchProgress', projectPath, ...p });
  }

  private emitRunUpdate(run: FlowRun): void {
    this.emit({ type: 'flowRunUpdate', run: structuredClone(run) });
    // Notify the orchestrator (if any) so a batch child run's terminal
    // state can pump the next queued item. Isolated in a try so an
    // observer fault can never break the run's own update emission.
    if (this.runObserver) {
      try {
        this.runObserver(run);
      } catch {
        // best-effort — orchestration is a side-channel, not load-bearing
        // for the run itself.
      }
    }
  }
}

/// Format an input body for the user-visible bubble. Markdown-named
/// artifacts (`*.md`, `*.markdown`) are passed through verbatim so the
/// renderer's markdown parser handles them. Diff/patch artifacts and
/// the special `diff` name are wrapped in ```diff fences. Everything
/// else lands in a generic code fence to preserve formatting without
/// fighting the markdown parser over leading punctuation.
function formatInputBodyForDisplay(name: string, body: string): string {
  const lower = name.toLowerCase();
  if (lower.endsWith('.md') || lower.endsWith('.markdown') || name === 'your request') {
    return body;
  }
  if (lower === 'diff' || lower.endsWith('.diff') || lower.endsWith('.patch')) {
    return '```diff\n' + body + '\n```';
  }
  return '```\n' + body + '\n```';
}

/// Escalation ladder for the watch DETECT tier, cheapest model first, ending
/// at the participant's own model as the last resort. Detect is mechanical
/// (scan recent comments, dedup against the answered set, emit a tiny report),
/// so we start on the cheapest reliable fast-tier model (Sonnet for Claude,
/// mini for Codex, Flash for Gemini) and only climb a rung when a tick
/// reports it genuinely can't reach the source's tools (`tools_unavailable`
/// → `onWatchTickFinished`). Haiku is deliberately EXCLUDED — it's the
/// cheapest fast model but proved unreliable at the detect job (missed/garbled
/// reports), so watch ticks skip it in favour of Sonnet. The premium-model
/// lists are ordered premium-first, so reversing the fast subset gives
/// cheapest-first. Ollama is already local/cheap → just the participant model.
function detectModelLadder(backend: Backend, participantModel: string): string[] {
  if (backend === 'ollama') return [participantModel];
  const fast = (PREMIUM_MODELS[backend] ?? [])
    .filter((m) => modelSpeed(m) === 'fast')
    .filter((m) => !isHaikuModel(m));
  const ladder = [...fast].reverse(); // cheapest fast first
  if (!ladder.includes(participantModel)) ladder.push(participantModel); // top rung
  return ladder.length > 0 ? ladder : [participantModel];
}

/// Haiku (any spelling: `claude-haiku-4-5`, `claude-haiku-4.5`) is too
/// unreliable for the watch detect tier — see `detectModelLadder`.
function isHaikuModel(model: string): boolean {
  return /haiku/i.test(model);
}

/// The cheapest detect model (bottom rung of the ladder).
function cheapDetectModel(backend: Backend, participantModel: string): string {
  return detectModelLadder(backend, participantModel)[0];
}

/// Detect artifact kind from its name. Markdown by default; "diff" by name
/// → diff; "url" suffix → url. Everything else falls through to text.
export function detectArtifactKind(name: string): FlowArtifact['kind'] {
  const lower = name.toLowerCase();
  if (lower.endsWith('.md') || lower.endsWith('.markdown')) return 'markdown';
  if (lower === 'diff' || lower.endsWith('.diff') || lower.endsWith('.patch')) return 'diff';
  if (lower.endsWith('url') || lower.endsWith('_url')) return 'url';
  return 'text';
}

/// Role presets whose whole job is to render an APPROVE/REJECT verdict on
/// prior work. A step with one of these roles GATES the flow: if its
/// produced artifact doesn't clearly approve, the runtime treats the step
/// as failed and routes it through `on_fail` (pause by default) instead of
/// advancing to downstream steps — so a rejected review actually stops the
/// pipeline rather than letting `tests`/`push` run on disapproved work.
const GATING_REVIEWER_ROLES: ReadonlySet<FlowRolePreset> = new Set([
  'plan-reviewer',
  'reviewer',
  'code-reviewer',
  'security-reviewer',
  'adversarial-reviewer',
]);

export function isGatingReviewerRole(role: FlowRolePreset): boolean {
  return GATING_REVIEWER_ROLES.has(role);
}

/// Decide whether a reviewer's produced artifact represents an APPROVAL.
/// The reviewer role prompts (see ../../shared/flows/roles.ts) instruct the
/// model to put "APPROVED" on its OWN line when the work is good, and to
/// list concrete problems otherwise. We mirror that contract:
///   - Approved IFF some line, after stripping leading markdown bullets /
///     emphasis / headings, BEGINS with the bare word "APPROVED" and is
///     not negated ("NOT APPROVED", "not approved").
///   - Anything else — explicit rejection markers (REJECTED, CHANGES
///     REQUESTED), or simply the absence of an approval line — counts as
///     NOT approved, so an ambiguous or rejecting review gates rather than
///     slipping through. This is deliberately conservative: the documented
///     contract is an explicit APPROVED line, so its absence means "stop
///     and let the human look."
export function isReviewApproved(reviewBody: string): boolean {
  const lines = reviewBody.split('\n');
  for (const raw of lines) {
    // Strip leading markdown noise: list bullets, blockquotes, heading
    // hashes, and bold/italic markers — so "**APPROVED**" or "- APPROVED"
    // still read as a bare verdict line.
    const line = raw
      .replace(/^[\s>#*_-]+/, '')
      .replace(/[*_`]+/g, '')
      // Drop a leading verdict label so "Verdict: APPROVED" /
      // "Decision: APPROVED" read as approvals — models routinely
      // prefix the word rather than putting it bare on its own line.
      // A negated verdict ("Verdict: NOT APPROVED") still fails the
      // test below because the remaining text starts with "NOT".
      .replace(/^(?:verdict|decision|result|status|outcome)\s*[:\-–]\s*/i, '')
      .trim();
    if (/^APPROVED\b/i.test(line)) return true;
  }
  return false;
}

/// Pull the artifact body out of an assistant turn. Robust against the
/// failure modes smaller models routinely produce around the
/// `<output name="…">…</output>` contract:
///   - The model emits SEVERAL sibling blocks with the same name
///     (one per file it touched, or one per "round" of its own
///     reasoning). We concatenate all of them in document order.
///   - The model emits ONE outer block but with nested `<output …>`
///     and `</output>` tags inside the body (it interpreted the marker
///     as a section heading). We strip those leftover tags from the
///     body before returning it.
///   - The model uses unquoted or single-quoted name attributes.
///
/// Returns the cleaned body trimmed of surrounding whitespace, or
/// `null` when no matching block was found at all.
export function extractOutput(text: string, outputName: string): string | null {
  const escaped = outputName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // Scan greedily for every block whose name matches. Greedy `[\s\S]*?`
  // per match (non-greedy WITHIN a single match), but we iterate to
  // find ALL non-overlapping matches.
  const blockRe = new RegExp(
    `<output\\s+name=(?:"${escaped}"|'${escaped}'|${escaped})\\s*>([\\s\\S]*?)</output>`,
    'gi',
  );
  const bodies: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = blockRe.exec(text)) !== null) {
    bodies.push(m[1]);
  }
  if (bodies.length === 0) return null;
  // Strip any spurious nested tags from each body — these come from
  // the model fragmenting its output across pseudo-rounds. Match BOTH
  // the same name AND any other name (the model sometimes invents
  // adjacent names).
  const noiseRe = /<\/?output(?:\s+name=(?:"[^"]*"|'[^']*'|[^\s>]+))?\s*>/gi;
  const cleaned = bodies.map((b) => b.replace(noiseRe, '').trim()).filter(Boolean);
  if (cleaned.length === 0) return null;
  return cleaned.join('\n').trim();
}

/// Dispatch wrapper: single-repo runs get one `computeRunDiff`; workspace
/// runs walk each member's captured baseline and concatenate the diffs
/// with a `# <projectName>` header so the user can tell which repo each
/// chunk belongs to. Returns null when there's no baseline at all (e.g.
/// a non-git cwd) — callers should fall back to the model's `<output>`.
function computeRunDiffForRun(run: FlowRun): string | null {
  if (run.baselineCommitsByMember) {
    const blocks: string[] = [];
    for (const [name, info] of Object.entries(run.baselineCommitsByMember)) {
      const d = computeRunDiff(info.path, info.commit);
      if (!d) continue;
      // Prefix each member's diff with a banner comment so a multi-repo
      // diff is readable when reviewed as one blob. `# ` keeps unified-
      // diff parsers happy — they treat unprefixed text as context.
      blocks.push(`# ${name}\n${d}`);
    }
    if (blocks.length === 0) return null;
    return blocks.join('\n');
  }
  if (run.baselineCommit) {
    return computeRunDiff(run.projectPath, run.baselineCommit);
  }
  return null;
}

/// Snapshot the CURRENT working tree as a git tree object and return its
/// sha — tracked + untracked files, honoring .gitignore — WITHOUT touching
/// the repo's real index or working tree. We point git at a throwaway index
/// (GIT_INDEX_FILE), seed it from the real index so unchanged files keep
/// their stat cache (fast `add`), stage everything, then `write-tree`.
/// Returns null if any step fails so callers fall back to a baseline diff.
function snapshotWorktree(cwd: string): string | null {
  const tmpIndex = join(tmpdir(), `overcli-flow-index-${randomUUID()}`);
  try {
    // Seed the temp index from the real one so `git add -A` only re-hashes
    // files that actually changed. `--git-path index` resolves correctly
    // even for worktrees, where `.git` is a file, not a directory.
    const realIndex = runGit(['rev-parse', '--git-path', 'index'], cwd);
    if (realIndex.exitCode === 0) {
      const p = realIndex.stdout.trim();
      const abs = isAbsolute(p) ? p : join(cwd, p);
      try {
        copyFileSync(abs, tmpIndex);
      } catch {
        // No existing index (fresh repo) — git creates one in the temp path.
      }
    }
    const env: NodeJS.ProcessEnv = { GIT_INDEX_FILE: tmpIndex };
    const add = runGit(['add', '-A'], cwd, env);
    if (add.exitCode !== 0) return null;
    const tree = runGit(['write-tree'], cwd, env);
    if (tree.exitCode !== 0) return null;
    const sha = tree.stdout.trim();
    return sha || null;
  } finally {
    try {
      rmSync(tmpIndex, { force: true });
    } catch {
      // Best-effort cleanup of the throwaway index.
    }
  }
}

/// Diff a `from` tree-ish (a previous snapshot or the baseline commit)
/// against a fresh snapshot of the current worktree. Because both sides are
/// tree objects that already include untracked files, `git diff A B` reports
/// adds/edits/deletes with no untracked special-casing. Returns the filtered
/// diff plus the new snapshot sha (so the caller can advance its cursor), or
/// null on any git failure.
function computeIncrementalDiff(
  cwd: string,
  fromRef: string,
): { diff: string; snapshot: string } | null {
  const snapshot = snapshotWorktree(cwd);
  if (snapshot === null) return null;
  const r = runGit(['diff', '--no-color', '--no-ext-diff', fromRef, snapshot], cwd);
  if (r.exitCode !== 0) return null;
  return { diff: filterNoiseFromDiff(r.stdout).diff, snapshot };
}

/// Compute the actual git diff between the run's baseline commit and the
/// current working tree state in its cwd. Includes:
///   - tracked changes (committed + uncommitted) via `git diff <commit>`
///   - newly created files (which `git diff` would otherwise skip
///     because they're untracked), surfaced as `new file` diff blocks
/// Returns `null` when the cwd isn't a git repo or the tracked-diff
/// command fails — callers should fall back to the model's `<output>`
/// text. Returns an empty string when the working tree matches the
/// baseline exactly.
function computeRunDiff(cwd: string, baselineCommit: string): string | null {
  // Tracked changes: working tree vs baseline. Catches edits, deletes,
  // and any new files that have already been `git add`-ed or committed.
  const tracked = runGit(['diff', '--no-color', '--no-ext-diff', baselineCommit], cwd);
  if (tracked.exitCode !== 0) return null;

  // Untracked files: things the model created via Write/Edit without
  // staging. `git diff` skips these entirely, so we generate "new file"
  // diff blocks for each one using `git diff --no-index /dev/null …`
  // and concatenate. `--exclude-standard` respects .gitignore so build
  // artifacts and node_modules don't show up.
  const untrackedList = runGit(['ls-files', '--others', '--exclude-standard'], cwd);
  const untrackedPaths =
    untrackedList.exitCode === 0
      ? untrackedList.stdout.split('\n').map((s) => s.trim()).filter(Boolean)
      : [];

  const newFileBlocks: string[] = [];
  for (const p of untrackedPaths) {
    if (isNoisyPath(p)) continue;
    // `git diff --no-index` exits 1 when the files differ — that's the
    // normal case here (we're diffing against /dev/null), so don't
    // treat exit 1 as failure. Anything else (-no such file, etc.) we
    // silently skip rather than abort the whole diff.
    const r = runGit(['diff', '--no-color', '--no-ext-diff', '--no-index', '/dev/null', p], cwd);
    if (r.exitCode === 0 || r.exitCode === 1) {
      if (r.stdout) newFileBlocks.push(r.stdout);
    }
  }

  const combined = [tracked.stdout, ...newFileBlocks].filter(Boolean).join('');
  return filterNoiseFromDiff(combined).diff;
}

// Public alias used by main/index.ts — keeps a single import name whether
// callers want the type or the constructor.
export { FlowRuntimeImpl as FlowRuntime };
