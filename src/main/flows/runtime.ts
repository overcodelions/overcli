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
import { copyFileSync, existsSync, readFileSync, realpathSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, resolve, sep } from 'node:path';
import { log } from '../diagnostics';
import { migrateClaudeSessionCwd } from '../history';

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
import { clearAttachments, ensureAttachmentDir, writeAttachment } from './attachments';
import type {
  Flow,
  FlowArtifact,
  FlowRolePreset,
  FlowRun,
  FlowStep,
  FlowStepAttempt,
  FlowWorkerExchange,
} from '../../shared/flows/schema';
import {
  FLOW_USER_PROMPT_REF,
  MAX_RUN_TITLE_LENGTH,
  resolveStepModel,
  resolveRunStepModel,
  effectiveParticipantModel,
} from '../../shared/flows/schema';
import { ROLE_PROMPTS, resolveSystemPrompt } from '../../shared/flows/roles';
import { extractWorkerQuestion } from '../../shared/flows/workerQuestion';
import type { RunnerManager } from '../runner';
import { loadAllFlows } from './storage';
import {
  baseBranchExistsAsync,
  checkoutAgentLocally as checkoutWorktreeLocally,
  createWorktreeAsync,
  currentBranch,
  detectBaseBranchAsync,
  removeWorktreeAsync,
  runGit,
  runGitAsync,
  worktreeNameTaken,
} from '../git';
import { branchSlugFromPrompt } from './branchName';
import { ensureCoordinatorSymlinkRoot, removeCoordinatorSymlinkRoot } from '../workspace';
import {
  pendingWorkspaceMembers,
  type WorkspaceMemberRef,
} from '../../shared/flows/workspaceMembers';
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
  /// Set when a Schedule fired this run. Routes the run's terminal state back
  /// to the scheduler (which clears the overlap guard and notifies).
  scheduleId?: UUID;
  /// The schedule's name at launch time, stored on the run so a scheduled run
  /// found in the sidebar can say who started it — nobody was watching when
  /// it did.
  scheduleName?: string;
  /// Set when a Worker shift launched this run. Stored on the FlowRun so the
  /// worker engine can route the terminal state and roll up cost.
  workerId?: UUID;
  workerName?: string;
  /// Explicit Worker capability. Missing is false for launches produced by
  /// older workers/orchestrations.
  allowExternalActions?: boolean;
  /// Explicit run title, set at launch instead of derived from the prompt.
  /// Only the scheduler uses it: a scheduled prompt never changes, so the
  /// prompt-derived title would be identical for every occurrence.
  title?: string;
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

export interface FlowWorkerQuestionRequest {
  workerId: UUID;
  workerName?: string;
  flowName: string;
  runTitle?: string;
  projectPath: string;
  userPrompt: string;
  step: Pick<FlowStep, 'id' | 'role' | 'systemPromptOverride' | 'inputs' | 'output'>;
  question: string;
  artifacts: Array<{ name: string; body: string; producedByStepId: string }>;
}

export type FlowWorkerQuestionResult =
  | { kind: 'answer'; answer: string }
  | { kind: 'escalate'; reason: string }
  | { kind: 'error'; error: string };

/// Convert a single-project worktree run into an in-place run after its
/// branch has been checked out in the source project. Kept as a small pure
/// mutation so both the explicit checkout path and startup recovery use the
/// exact same state transition.
export function rebindRunToLocalProject(
  run: FlowRun,
): { oldProjectPath: string; projectPath: string } | null {
  if (
    !run.worktreePath ||
    !run.sourceProjectPath ||
    (run.workspaceWorktrees?.length ?? 0) > 0
  ) {
    return null;
  }
  const oldProjectPath = run.projectPath;
  run.projectPath = run.sourceProjectPath;
  delete run.worktreePath;
  run.checkedOutLocally = true;
  return { oldProjectPath, projectPath: run.projectPath };
}

function migrateRunClaudeSessions(run: FlowRun, fromCwd: string, toCwd: string): void {
  const participants = new Map(
    (run.flowSnapshot.participants ?? []).map((participant) => [participant.id, participant]),
  );
  for (const [participantId, sessionId] of Object.entries(
    run.sessionIdsByParticipant ?? {},
  )) {
    if (participants.get(participantId)?.backend !== 'claude') continue;
    migrateClaudeSessionCwd({ worktreePath: fromCwd, projectPath: toCwd, sessionId });
  }
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

// `workspaceMembersMissingFromRun` / `pendingWorkspaceMembers` live in
// shared/flows/workspaceMembers so the renderer's "adopt these" banner and the
// adoption below can never disagree about what's missing.
export { workspaceMembersMissingFromRun } from '../../shared/flows/workspaceMembers';

/// The worktree(s) a run owns, if any. A workspace run forks one per member
/// project; a single-project run has at most one; a `runIn: 'cwd'` run has
/// none — it shares the project checkout, so there is no isolated tree whose
/// dirtiness belongs to the run rather than to the user.
function runWorktreeTargets(run: FlowRun): Array<{ name: string; worktreePath: string }> {
  if (run.workspaceWorktrees && run.workspaceWorktrees.length > 0) {
    return run.workspaceWorktrees.map((m) => ({ name: m.name, worktreePath: m.worktreePath }));
  }
  if (run.worktreePath) {
    return [{ name: run.flowSnapshot.name, worktreePath: run.worktreePath }];
  }
  return [];
}

/// Count the entries in `git status --porcelain` output. One file per line;
/// the trailing newline must not count as a change.
function countPorcelainFiles(stdout: string): number {
  return stdout.split('\n').filter((l) => l.trim().length > 0).length;
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
  /// Which step an Ollama conversation was opened for, `convId` →
  /// `${participantId} ${stepId}`. Ollama participants get a fresh
  /// conversation per NEW step (see `executeStep`) because the Ollama path
  /// replays the whole transcript each round, so a shared conv would carry a
  /// finished step's `<output name="…">` contract into the next one. Same
  /// step retrying keeps its conv. In-memory like `retryCounts`; losing it in
  /// a restart just mints a fresh conversation, which is the safe direction.
  private ollamaConvStepKeys = new Map<UUID, string>();
  /// Track how many `goto` retries each step has consumed in a run, so
  /// `on_fail.goto.maxRetries` is respected.
  private retryCounts = new Map<string, number>(); // `${runId}:${stepId}` → count
  /// How many times the current attempt at a step has been nudged to
  /// re-emit a missing `<output>` block. `${runId}:${stepId}` → count,
  /// cleared by `executeStep` so every fresh attempt gets its own nudge.
  private reaskCounts = new Map<string, number>();
  /// The pointer a step's last reply drew that the runtime refused, and why.
  /// `${runId}:${stepId}` → rejection, written by `resolveArtifactBody` and
  /// read by `reaskMissingOutput` so the nudge names the actual problem.
  private pointerRejections = new Map<string, { path: string; reason: PointerRejectionReason }>();
  /// One nudge per attempt. A model that ignores a direct "emit only the
  /// block" instruction twice is not one turn away from complying, and each
  /// round costs the user real tokens.
  private static readonly MAX_MISSING_OUTPUT_REASKS = 1;
  /// Feedback owed to the NEXT execution of a `on_fail.goto` target: why it
  /// got sent back and which artifact holds the details. Set when the jump
  /// is scheduled, consumed (and cleared) by that step's `executeStep`.
  /// One entry per run — a run only ever has one step in flight.
  /// In-memory like `retryCounts`; a restart loses it, which at worst
  /// costs the retried step its feedback preamble.
  private retryFeedback = new Map<UUID, FlowRetryFeedback & { targetStepId: string }>();
  /// A worker's answer owed to the participant that asked it a question.
  /// It is injected into the next attempt's prompt and then consumed.
  private workerAnswerFeedback = new Map<
    UUID,
    { stepId: string; exchangeId: UUID; question: string; answer: string }
  >();
  /// Wired after WorkerEngine is constructed. Kept optional so ordinary
  /// flow runtimes and focused tests do not need a worker dependency.
  private workerSupervisor:
    | ((request: FlowWorkerQuestionRequest) => Promise<FlowWorkerQuestionResult>)
    | null = null;
  private static readonly MAX_WORKER_QUESTION_ROUNDS = 3;

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
  /// Conversation the in-flight DETECT tick is running on, keyed by run id.
  /// Deliberately NOT stored in `run.conversationIds`: detect gets a throwaway
  /// conversation, minted fresh per tick and released when the tick drains.
  ///
  /// Detect asks one yes/no question — "is there a new comment worth a reply?"
  /// — and its prompt already carries everything needed to answer it (the
  /// user's instructions, the guardrails, the already-answered id list, a work
  /// summary). Running it on the participant's conversation instead meant every
  /// tick re-sent the entire flow transcript PLUS every prior tick's "nothing
  /// new" report, growing without bound for as long as the watch lived — at the
  /// 60s poll floor, ~1,440 ticks a day each larger than the last. The cheap
  /// `watchModel` made those tokens cost less; it didn't make there be fewer.
  ///
  /// Keeping detect out of `run.conversationIds` also keeps it invisible to the
  /// `sessionConfigured` handler, which resolves a participant by searching that
  /// map — so a detect session can never overwrite the participant's session
  /// pointer and strand the chat panel.
  ///
  /// The ANSWER pass is unchanged: it still runs on the participant's
  /// conversation, so replies stay grounded in the actual work.
  private watchDetectConv = new Map<UUID, UUID>();
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

  // ---- Step watchdog ----------------------------------------------------
  /// Last time we saw ANY event on the conversation of a run's currently
  /// executing step, keyed by run id. A `running` state is only ever left
  /// by an inbound event (`running: false` → `onStepFinished`), so a step
  /// whose backend dies quietly — or never starts — would otherwise hold
  /// the run (and its sidebar spinner) forever. Stamped when the step is
  /// kicked off and on every event that reaches `observeEvent`.
  private stepActivity = new Map<UUID, number>();
  private stepWatchdogTimer: ReturnType<typeof setInterval> | null = null;
  /// How long a running step may produce nothing at all before we treat it
  /// as dead. Generous: a step can legitimately sit inside one long tool
  /// call (a full test suite, a big build) without emitting anything.
  private static readonly STEP_SILENCE_TIMEOUT_MS = 30 * 60_000;
  /// How often the watchdog wakes. Only armed while a run is executing.
  private static readonly STEP_WATCHDOG_SWEEP_MS = 60_000;

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
      // `Check out locally` historically removed a flow worktree without
      // updating the run record. On the next participant message the runner
      // tried to spawn in that deleted cwd and surfaced macOS ENOENT as the
      // opaque status -2. Recover those already-affected runs when the main
      // project is now on the flow branch — the exact post-checkout shape.
      if (
        run.worktreePath &&
        run.sourceProjectPath &&
        run.branchName &&
        !existsSync(run.worktreePath) &&
        existsSync(run.sourceProjectPath) &&
        currentBranch(run.sourceProjectPath).branch === run.branchName
      ) {
        const oldCwd = run.worktreePath;
        migrateRunClaudeSessions(run, oldCwd, run.sourceProjectPath);
        if (rebindRunToLocalProject(run)) {
          saveRun(run);
          log(
            'info',
            'flows.recoverLocalCheckout',
            `rebound run ${run.id} from missing ${oldCwd} to ${run.projectPath}`,
          );
        }
      }
      // Re-running an external step after a crash is still an external
      // effect and may duplicate a partially-completed send/push/update.
      // Restore it at the approval boundary, not under the generic one-click
      // interrupted retry path.
      if (run.workerId && run.state.kind === 'paused' && run.state.reason === 'interrupted') {
        const interruptedStepId = run.state.nextStepId;
        const interruptedStep = run.flowSnapshot.steps.find(
          (step) => step.id === interruptedStepId,
        );
        if (
          interruptedStep &&
          !run.allowExternalActions &&
          resolveStepEffect(interruptedStep) === 'external'
        ) {
          run.state = {
            kind: 'paused',
            nextStepId: interruptedStep.id,
            reason: 'externalAction',
          };
          saveRun(run);
        }
      }
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
      this.markStepActivity(runId);

      // An unattended worker with no grant for external actions runs under
      // `acceptEdits` (see resolvePermissionMode), which keeps the approval
      // broker wired instead of bypassing it — so a call outside the step's
      // declared allowlist routes to mcp__overcli__approve and waits for a
      // human to click Allow/Deny. Nobody is watching a nightly shift, so
      // that wait is forever. Auto-deny it: the CLI gets a clean refusal it
      // can report or work around, instead of the run hanging in `running`.
      // EXCEPT the one step the user just approved via the externalAction
      // pause (see resumeRunInner) — that is a real human clicking Continue,
      // and auto-denying it anyway would silently discard their approval.
      const currentStepId = run.state.kind === 'running' ? run.state.currentStepId : undefined;
      const stepIsApproved =
        !!run.externalActionApprovedStepId && run.externalActionApprovedStepId === currentStepId;
      if (run.workerId && !run.allowExternalActions && !stepIsApproved) {
        for (const ev of event.events) {
          if (ev.kind.type === 'permissionRequest' && !ev.kind.info.decided) {
            log(
              'info',
              'flows.permission',
              `auto-denied "${ev.kind.info.toolName}" for worker run ${runId} (no grant for external actions)`,
            );
            this.runner.respondPermission(event.conversationId, ev.kind.info.requestId, false);
          }
        }
      }

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
        // Detect runs on a throwaway conversation, answer on the participant's
        // (see `watchDetectConv`) — a tick's reply can arrive on either.
        const watcherConv = run.conversationIds[run.state.watch.participantId];
        const detectConv = this.watchDetectConv.get(runId);
        if (watcherConv === event.conversationId || detectConv === event.conversationId) {
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
    if (event.type === 'running') {
      const activeRunId = this.convIdToRun.get(event.conversationId);
      if (activeRunId) this.markStepActivity(activeRunId);
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
      // Keyed the same way `executeStep` minted it — a step with a blank
      // participantId is filed under its own id, and looking it up by the
      // blank key would never match, so the step's own `running: false`
      // would be discarded and the run would hang on it forever.
      const currentConvId = run.conversationIds[stepParticipantKey(currentStep)];
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

    // A worker-owned worktree run must not smuggle an output back into the
    // persistent source project/workspace by naming an absolute destination.
    // The run gets an isolated cwd below; relative output belongs there and is
    // filed into the worker's cabinet on completion. Refuse the launch before
    // minting worktrees when the candidate itself still asks for a source-root
    // write. (The per-step boundary in buildStepPrompt covers downstream steps
    // that might otherwise derive such a destination from their artifacts.)
    if (
      args.workerId &&
      args.runIn === 'worktree' &&
      workerPromptWritesToPersistentRoot(args.userPrompt, args.projectPath)
    ) {
      return {
        ok: false,
        error:
          'Worker flow refused: its prompt asks to write into the persistent project/workspace. ' +
          'Use a relative output path so the file stays in the disposable run root and is filed ' +
          "into the worker's cabinet after completion.",
      };
    }

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
            // A shared base is a HINT across N independent repos, not a
            // contract. The launcher only offers names that exist in every
            // member (BaseBranchSelect intersects the lists), but a stored
            // one can outlive that guarantee — a schedule keeps whatever was
            // picked when it was last edited, even after its target changed
            // to a workspace those branches were never in. Falling back to
            // this repo's own default beats failing the entire launch on the
            // first member that never had the branch.
            let baseBranch: string;
            if (sharedBase && (await baseBranchExistsAsync(p.path, sharedBase))) {
              baseBranch = sharedBase;
            } else {
              baseBranch = await detectBaseBranchAsync(p.path);
              if (sharedBase) {
                log(
                  'warn',
                  'flows',
                  `${p.name}: base branch "${sharedBase}" doesn't exist here — forking off "${baseBranch}" instead.`,
                );
              }
            }
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

    const firstStep = flow.steps[0];
    // Preserve the historical first-step behavior: pause_before is an
    // between-steps checkpoint, while the worker external boundary also
    // applies before step one. The new capability only waives that boundary.
    const firstPauseReason =
      args.workerId &&
      !args.allowExternalActions &&
      resolveStepEffect(firstStep) === 'external'
        ? ('externalAction' as const)
        : null;
    const run: FlowRun = {
      id: runId,
      flowId: flow.id,
      flowSnapshot: flow,
      projectPath: cwd,
      userPrompt: args.userPrompt,
      conversationIds: {},
      artifacts: {},
      state: firstPauseReason
        ? { kind: 'paused', nextStepId: firstStep.id, reason: firstPauseReason }
        : { kind: 'running', currentStepId: firstStep.id },
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
      scheduleId: args.scheduleId,
      scheduleName: args.scheduleName,
      workerId: args.workerId,
      workerName: args.workerName,
      ...(args.allowExternalActions ? { allowExternalActions: true } : {}),
      title: args.title,
    };
    this.runs.set(runId, run);
    if (args.attachments && args.attachments.length > 0) {
      this.pendingAttachments.set(runId, args.attachments);
    }
    this.emitRunUpdate(run);
    if (firstPauseReason) this.checkpoint(run);
    else void this.executeStep(runId, firstStep.id);
    return { ok: true, runId };
  }

  /// Evict oldest done/aborted runs once we exceed MAX_RETAINED_RUNS. We
  /// never touch runs in `running` or `paused` state since they're still
  /// active and the renderer is watching them. Also frees any per-step
  /// stream buffers that were tied to evicted runs and removes the
  /// run's on-disk checkpoint so the persistent store stays bounded too.
  ///
  /// A finished run whose worktree still has UNCOMMITTED CHANGES is exempt,
  /// gated on the same `runDirtyWorktrees` predicate `deleteRun` refuses on.
  /// Do not "simplify" that conjunct away. Eviction never runs
  /// `git worktree remove` — `removeRunWorktrees` is reachable only from the
  /// explicit `deleteRun` path — so it is tempting to read this as harmless
  /// bookkeeping. It is not. Evicting drops the LAST HANDLE that can reach
  /// the tree: the in-memory run goes, `deleteRunFromDisk` takes the
  /// checkpoint so the next boot can't rehydrate it, and `checkoutRunLocally`
  /// resolves through `this.runs` and so can no longer find it. The files
  /// survive on disk with nothing in the product able to reach them — work
  /// the user never reviewed, orphaned silently, at launch time, with no
  /// prompt. The run stays retained and ages out normally once its work is
  /// committed or discarded.
  ///
  /// Accepted trade: if every retained run is dirty, `evictable` is empty and
  /// `this.runs` grows past the cap with nothing surfaced to the user.
  /// Unbounded memory beats silent loss of work nobody has looked at.
  private pruneOldRuns(): void {
    const all = Array.from(this.runs.values());
    if (all.length < FlowRuntimeImpl.MAX_RETAINED_RUNS) return;
    const evictable = all
      .filter(
        (r) =>
          (r.state.kind === 'done' ||
            r.state.kind === 'aborted' ||
            r.state.kind === 'archived') &&
          this.runDirtyWorktrees(r).length === 0,
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
      this.retryFeedback.delete(victim.id);
      this.workerAnswerFeedback.delete(victim.id);
      // Sweep any retry counters keyed under this run's id.
      for (const key of this.retryCounts.keys()) {
        if (key.startsWith(`${victim.id}:`)) this.retryCounts.delete(key);
      }
      for (const key of this.ollamaConvStepKeys.keys()) {
        if (key.startsWith(`${victim.id}:`)) this.ollamaConvStepKeys.delete(key);
      }
      for (const key of this.reaskCounts.keys()) {
        if (key.startsWith(`${victim.id}:`)) this.reaskCounts.delete(key);
      }
      for (const key of this.pointerRejections.keys()) {
        if (key.startsWith(`${victim.id}:`)) this.pointerRejections.delete(key);
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

  /// Ids of finished runs that still have uncommitted work sitting in their
  /// worktree — work the flow produced and nobody has looked at. Reuses the
  /// same `runDirtyWorktrees` predicate `deleteRun` gates its confirm on, so
  /// the sidebar can show that fact passively instead of only revealing it
  /// at the moment the user tries to destroy it.
  ///
  /// Deliberately `done`-only. A run that is still `running`/`watching`/
  /// `paused` is EXPECTED to have a dirty tree — flagging it would say
  /// nothing — and gating here keeps the git calls off active runs. Cost is
  /// bounded by MAX_RETAINED_RUNS (50) `git status --porcelain` invocations,
  /// run concurrently and asynchronously so the main thread keeps serving the
  /// UI while they resolve. The renderer refreshes this on window focus, so
  /// it must never block.
  ///
  /// Not attached to the FlowRun itself on purpose: runs are echoed back to
  /// the renderer wholesale by `emitRunUpdate`, and persisted by `saveRun`,
  /// so a computed field would be clobbered by the next update and would
  /// reload stale from disk. The renderer keeps this as a parallel map.
  async unreviewedDoneRunIds(): Promise<UUID[]> {
    const done = Array.from(this.runs.values()).filter((r) => r.state.kind === 'done');
    const dirty = await Promise.all(done.map((run) => this.runIsDirtyAsync(run)));
    return done.filter((_, i) => dirty[i]).map((run) => run.id);
  }

  getRun(runId: UUID): FlowRun | null {
    return this.runs.get(runId) ?? null;
  }

  /// Check out a single-project flow branch in its main project and keep the
  /// flow conversation alive there. This must live in the runtime (rather
  /// than being two renderer IPC calls) so git checkout, session migration,
  /// run rebinding, persistence, and renderer notification form one action.
  checkoutRunLocally(args: {
    runId: UUID;
    commitSubject: string;
    commitBody?: string;
  }):
    | { ok: true; message: string; stashed: boolean; autoCommitted: boolean }
    | { ok: false; error: string } {
    const run = this.runs.get(args.runId);
    if (!run) return { ok: false, error: `Run ${args.runId} not found.` };
    if ((run.workspaceWorktrees?.length ?? 0) > 0) {
      return {
        ok: false,
        error: 'Use the per-project checkout actions for a workspace flow.',
      };
    }
    if (!run.worktreePath || !run.sourceProjectPath || !run.branchName) {
      if (run.checkedOutLocally) {
        return {
          ok: true,
          message: `Already checked out ${run.branchName ?? 'the flow branch'} in ${run.projectPath}.`,
          stashed: false,
          autoCommitted: false,
        };
      }
      return { ok: false, error: 'This run no longer has a flow worktree to check out.' };
    }

    const oldCwd = run.worktreePath;
    const result = checkoutWorktreeLocally({
      projectPath: run.sourceProjectPath,
      worktreePath: run.worktreePath,
      branchName: run.branchName,
      commitSubject: args.commitSubject,
      commitBody: args.commitBody,
    });
    if (!result.ok) return result;

    migrateRunClaudeSessions(run, oldCwd, run.sourceProjectPath);
    if (!rebindRunToLocalProject(run)) {
      return {
        ok: false,
        error: 'Checked out the branch, but could not rebind the flow run to the project.',
      };
    }
    this.checkpoint(run);
    this.emitRunUpdate(run);
    return result;
  }

  resumeRun(args: FlowRuntimeResumeArgs): { ok: true } | { ok: false; error: string } {
    return this.withWorkspaceAdoption(args.runId, () => this.resumeRunInner(args));
  }

  private resumeRunInner(args: FlowRuntimeResumeArgs): { ok: true } | { ok: false; error: string } {
    const run = this.runs.get(args.runId);
    if (!run) return { ok: false, error: `Run ${args.runId} not found.` };
    if (run.state.kind !== 'paused') {
      return { ok: false, error: `Run is not paused (state: ${run.state.kind}).` };
    }
    const pausedReason = run.state.reason;
    const nextStepId = run.state.nextStepId;

    // Clicking Continue on an externalAction pause is an explicit, one-shot
    // approval for exactly the step that was paused — not a standing grant
    // for the rest of the run. Recorded before any resume path below
    // advances into that step; `onStepFinished` clears it once the step
    // completes, so it can never leak into a later, unapproved step.
    if (pausedReason === 'externalAction') {
      run.externalActionApprovedStepId = nextStepId;
      this.checkpoint(run);
    }

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
    if (pausedReason === 'preStep' || pausedReason === 'externalAction') {
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

    // A same-step retry (failure/interruption/needs-input) consumes any chat
    // that happened during this pause as conversation context. Clear the
    // pre-step-finalize marker so it cannot leak into a later checkpoint on
    // this participant and trigger an unrelated synthetic finalize turn.
    if (pausedReason !== 'preStep' && pausedReason !== 'externalAction') {
      for (const key of Array.from(this.pauseChatHappened)) {
        if (key.startsWith(`${args.runId}:`)) this.pauseChatHappened.delete(key);
      }
    }

    // No chat happened (or it's a same-step retry) — advance directly.
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
  /// Projects added to this run's workspace since it launched, as
  /// `{ name, path }`. Empty for anything that isn't a workspace-worktree run.
  private pendingWorkspaceMembers(run: FlowRun): WorkspaceMemberRef[] {
    return pendingWorkspaceMembers(run, this.getWorkspaces(), this.getProjects());
  }

  /// Adopt those projects into the live run: a worktree each, a symlink in the
  /// run's root, and its own baseline.
  ///
  /// ADDITIVE ONLY, and that is the whole reason this is safe. Every diff the
  /// run has produced is measured from `baselineCommitsByMember`; existing
  /// entries are never touched, so nothing already measured moves. A member
  /// REMOVED from the workspace likewise keeps its worktree — dropping it
  /// would strand the diffs that cite it.
  ///
  /// Best-effort per member: a repo that fails to check out is logged and
  /// skipped rather than failing the resume, matching the launch path's
  /// tolerance for a partially-cleaned workspace.
  private async adoptWorkspaceMembers(run: FlowRun): Promise<void> {
    const pending = this.pendingWorkspaceMembers(run);
    if (pending.length === 0) return;
    const minted = run.workspaceWorktrees;
    if (!minted) return;

    const settings = this.getSettings();
    const branchPrefix = settings.agentBranchPrefix || 'agent/';
    // Reuse the run's existing branch name so an adopted repo lands on the
    // same branch as its siblings rather than inventing a second one.
    const agentName = minted[0].branchName.startsWith(branchPrefix)
      ? minted[0].branchName.slice(branchPrefix.length)
      : minted[0].branchName;

    for (const member of pending) {
      let baseBranch: string;
      if (run.baseBranch && (await baseBranchExistsAsync(member.path, run.baseBranch))) {
        baseBranch = run.baseBranch;
      } else {
        baseBranch = await detectBaseBranchAsync(member.path);
      }
      const created = await createWorktreeAsync({
        projectPath: member.path,
        agentName,
        baseBranch,
        branchPrefix,
      });
      if (!created.ok) {
        log('warn', 'flows', `Could not adopt ${member.name} into run ${run.id}: ${created.error}`);
        continue;
      }
      minted.push({
        name: member.name,
        projectPath: member.path,
        worktreePath: created.worktreePath,
        branchName: created.branchName,
      });
      const head = await runGitAsync(['rev-parse', 'HEAD'], created.worktreePath);
      const commit = head.exitCode === 0 ? head.stdout.trim() : '';
      if (commit) {
        run.baselineCommitsByMember = {
          ...(run.baselineCommitsByMember ?? {}),
          [member.name]: { path: created.worktreePath, commit },
        };
      }
      log('info', 'flows', `Adopted ${member.name} into run ${run.id} at ${created.worktreePath}`);
    }

    // Rebuild the farm from the FULL member list — this reconciles by
    // removing symlinks it doesn't recognize, so a partial list would unlink
    // the members the run has been working in.
    const linked = ensureCoordinatorSymlinkRoot(
      run.id,
      minted.map((m) => ({ name: m.name, worktreePath: m.worktreePath })),
    );
    if (!linked.ok) {
      log('warn', 'flows', `Could not relink run ${run.id}'s workspace root: ${linked.error}`);
    }
    this.emitRunUpdate(run);
    this.checkpoint(run);
  }

  /// The "workspace grew" banner's action: adopt the pending members and
  /// nothing else. Resume and re-run already do this on their way through
  /// (`withWorkspaceAdoption`), but a paused run the user is CHATTING with
  /// never reaches either — and chatting is exactly what people do when a
  /// step stalls on a repo that isn't there. This gives them the worktree
  /// without also advancing the run, so the participant can be asked to look
  /// again in the same pause.
  ///
  /// Returns the member names actually adopted; a repo that failed to check
  /// out is logged and skipped by `adoptWorkspaceMembers`, so a short list
  /// back means some member didn't make it.
  async adoptPendingWorkspaceMembers(
    runId: UUID,
  ): Promise<{ ok: true; adopted: string[] } | { ok: false; error: string }> {
    const run = this.runs.get(runId);
    if (!run) return { ok: false, error: `Run ${runId} not found.` };
    // Adoption rebuilds the symlink farm, and the farm IS a running step's
    // cwd — reconciling it out from under a live subprocess would yank
    // directories the step has open. Settled states only, same rule
    // `rerunFromStep` enforces.
    if (run.state.kind === 'running') {
      return { ok: false, error: 'Wait for the current step to settle before adding projects.' };
    }
    const pending = this.pendingWorkspaceMembers(run);
    if (pending.length === 0) return { ok: true, adopted: [] };
    const before = new Set((run.workspaceWorktrees ?? []).map((m) => m.projectPath));
    try {
      await this.adoptWorkspaceMembers(run);
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      log('warn', 'flows', `Workspace adoption failed for run ${runId}`, err);
      return { ok: false, error };
    }
    const adopted = (run.workspaceWorktrees ?? [])
      .filter((m) => !before.has(m.projectPath))
      .map((m) => m.name);
    return { ok: true, adopted };
  }

  /// Dismiss the "workspace grew" banner for whatever is pending right now.
  ///
  /// Records the PATHS rather than setting a hide flag, so this can't blind
  /// the run: add another project tomorrow and it isn't in the dismissed set,
  /// so the banner returns for that one. Display-only — `adoptWorkspaceMembers`
  /// still picks these up on resume / re-run.
  dismissWorkspaceMembers(runId: UUID): { ok: true; dismissed: string[] } | { ok: false; error: string } {
    const run = this.runs.get(runId);
    if (!run) return { ok: false, error: `Run ${runId} not found.` };
    const pending = this.pendingWorkspaceMembers(run);
    if (pending.length === 0) return { ok: true, dismissed: [] };
    const merged = new Set(run.dismissedWorkspaceMemberPaths ?? []);
    for (const m of pending) merged.add(m.path);
    run.dismissedWorkspaceMemberPaths = [...merged];
    this.emitRunUpdate(run);
    this.checkpoint(run);
    return { ok: true, dismissed: pending.map((m) => m.path) };
  }

  /// Resume/rerun entry points run the adoption first when the workspace has
  /// grown, then do the real thing. Both callers are synchronous and return
  /// immediately, so this hands back `{ ok: true }` and lets the git work
  /// settle before the step starts — the step must not open in a root whose
  /// new symlink isn't there yet.
  private withWorkspaceAdoption(
    runId: UUID,
    proceed: () => { ok: true } | { ok: false; error: string },
  ): { ok: true } | { ok: false; error: string } {
    const run = this.runs.get(runId);
    if (!run || this.pendingWorkspaceMembers(run).length === 0) return proceed();
    void this.adoptWorkspaceMembers(run).then(
      () => {
        const r = proceed();
        if (!r.ok) this.failRun(run, r.error);
      },
      (err) => {
        log('warn', 'flows', `Workspace adoption failed for run ${runId}`, err);
        const r = proceed();
        if (!r.ok) this.failRun(run, r.error);
      },
    );
    return { ok: true };
  }

  rerunFromStep(args: { runId: UUID; stepId: string }): { ok: true } | { ok: false; error: string } {
    return this.withWorkspaceAdoption(args.runId, () => this.rerunFromStepInner(args));
  }

  private rerunFromStepInner(args: { runId: UUID; stepId: string }): { ok: true } | { ok: false; error: string } {
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
    for (const key of Array.from(this.ollamaConvStepKeys.keys())) {
      if (key.startsWith(`${args.runId}:`)) this.ollamaConvStepKeys.delete(key);
    }
    for (const key of Array.from(this.reaskCounts.keys())) {
      if (key.startsWith(`${args.runId}:`)) this.reaskCounts.delete(key);
    }
    for (const key of Array.from(this.pointerRejections.keys())) {
      if (key.startsWith(`${args.runId}:`)) this.pointerRejections.delete(key);
    }
    // A manual rewind isn't a rejection — don't hand the step a stale
    // "you were sent back" notice from an earlier automatic retry.
    this.retryFeedback.delete(args.runId);

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
      const already = this.resolveArtifactBody(run, latest, prior.output, prior.id);
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
      displayText: flowNote(`Finalizing ${prior.output} before continuing…`),
      backend: participant.backend,
      cwd: run.projectPath,
      allowedDirs: this.runAllowedDirs(run),
      model: effectiveParticipantModel(run, prior.participantId),
      permissionMode: 'default',
      flowStep: true,
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
      const refined = this.resolveArtifactBody(run, finalText, prior.output, prior.id);
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
    for (const { name, worktreePath } of runWorktreeTargets(run)) {
      const status = runGit(['status', '--porcelain'], worktreePath);
      if (status.exitCode !== 0) continue;
      const fileCount = countPorcelainFiles(status.stdout);
      if (fileCount > 0) out.push({ name, worktreePath, fileCount });
    }
    return out;
  }

  /// Async twin of `runDirtyWorktrees`, answering only yes/no. Used by the
  /// unreviewed-run scan, which runs across every retained `done` run and can
  /// be triggered by something as ordinary as focusing the window — at that
  /// frequency `runGit`'s `spawnSync` would block the main thread (and so the
  /// UI) for up to MAX_RETAINED_RUNS git invocations in a row. `deleteRun`
  /// keeps the synchronous version: it runs once, on an explicit click, and
  /// needs the per-worktree file counts for its confirm dialog.
  private async runIsDirtyAsync(run: FlowRun): Promise<boolean> {
    for (const { worktreePath } of runWorktreeTargets(run)) {
      const status = await runGitAsync(['status', '--porcelain'], worktreePath);
      // A worktree we can't read is treated as clean, exactly as the
      // synchronous version does — we don't raise an alarm on a directory
      // that's gone or was never a git checkout.
      if (status.exitCode !== 0) continue;
      if (countPorcelainFiles(status.stdout) > 0) return true;
    }
    return false;
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
      // The coordinator is the disposable workspace-shaped cwd. Loose
      // reports belong here alongside the member symlinks; removing only the
      // member worktrees left those outputs and the symlink farm behind.
      const removed = removeCoordinatorSymlinkRoot(run.id);
      if (!removed.ok) {
        log('warn', 'flows.deleteRun', `coordinator remove failed: ${removed.error}`);
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
      const convId = step ? run.conversationIds[stepParticipantKey(step)] : undefined;
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
      this.dropPrewarmed(convId);
      this.convIdToRun.delete(convId);
    }
    this.stepBuffers.delete(args.runId);
    this.diffSnapshots.delete(args.runId);
    this.pendingAttachments.delete(args.runId);
    this.retryFeedback.delete(args.runId);
    this.workerAnswerFeedback.delete(args.runId);
    this.watchTicking.delete(args.runId);
    this.watchPhase.delete(args.runId);
    this.watchBuffers.delete(args.runId);
    this.releaseWatchDetectConv(args.runId);
    for (const key of this.retryCounts.keys()) {
      if (key.startsWith(`${args.runId}:`)) this.retryCounts.delete(key);
    }
    for (const key of this.ollamaConvStepKeys.keys()) {
      if (key.startsWith(`${args.runId}:`)) this.ollamaConvStepKeys.delete(key);
    }
    for (const key of this.reaskCounts.keys()) {
      if (key.startsWith(`${args.runId}:`)) this.reaskCounts.delete(key);
    }
    for (const key of this.pointerRejections.keys()) {
      if (key.startsWith(`${args.runId}:`)) this.pointerRejections.delete(key);
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
      const convId = step ? run.conversationIds[stepParticipantKey(step)] : undefined;
      if (convId) {
        try {
          this.runner.stop(convId);
        } catch {
          // best-effort
        }
      }
    }
    // Nothing further will run, so any step we warmed ahead of is now a
    // process nobody will ever send to.
    for (const convId of Object.values(run.conversationIds)) {
      this.dropPrewarmed(convId);
    }
    run.state = { kind: 'aborted' };
    // If the run was aborted mid-Continue (rare but possible), the banner's
    // transient "Continuing…" signal is no longer meaningful — clear it.
    if (run.pendingContinue) {
      delete run.pendingContinue;
    }
    // A queued correction is persisted and would otherwise survive an abort
    // and resurface framed as fresh guidance on a `rerunFromStep` far later,
    // for a step context the user has long forgotten.
    if (run.pendingSteer) {
      delete run.pendingSteer;
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
      // A detect tick runs on the throwaway conversation, an answer tick on
      // the participant's — stop the one that's actually in flight.
      const convId =
        this.watchPhase.get(run.id) === 'detect'
          ? this.watchDetectConv.get(run.id)
          : run.conversationIds[run.state.watch.participantId];
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
    this.releaseWatchDetectConv(run.id);
    // The run is terminal now — drop its conversation routing entries so
    // observeEvent doesn't keep resolving them to an archived run. A resume
    // re-registers the watcher conversation via watchTick.
    for (const cid of Object.values(run.conversationIds)) {
      this.dropPrewarmed(cid);
      this.convIdToRun.delete(cid);
    }
    run.state = { kind: 'archived', watch };
    this.emitRunUpdate(run);
    this.checkpoint(run);
    return { ok: true };
  }

  /// Note that the run's executing step is still alive. Any event on one
  /// of its conversations counts — the watchdog only cares about total
  /// silence, not about progress.
  private markStepActivity(runId: UUID): void {
    const run = this.runs.get(runId);
    if (!run || run.state.kind !== 'running') return;
    this.stepActivity.set(runId, Date.now());
  }

  /// Lazily start the step watchdog. Idempotent; `unref` so it never holds
  /// the process open on its own.
  private ensureStepWatchdog(): void {
    if (this.stepWatchdogTimer) return;
    this.stepWatchdogTimer = setInterval(
      () => this.sweepStuckSteps(),
      FlowRuntimeImpl.STEP_WATCHDOG_SWEEP_MS,
    );
    this.stepWatchdogTimer.unref?.();
  }

  /// Fail any step that has gone completely silent past the timeout. This
  /// is the runtime's only escape from `running` that doesn't depend on the
  /// backend saying something: a CLI that dies without a closing event, or
  /// a send that never reaches one, used to wedge the run permanently (its
  /// state isn't even checkpointed, so a restart couldn't recover it
  /// either). Routing through `handleStepFailure` means the run lands in
  /// the same recoverable failure-pause a rejected step gets — the user can
  /// re-run the step or override forward.
  private sweepStuckSteps(now = Date.now()): void {
    let anyRunning = false;
    for (const run of Array.from(this.runs.values())) {
      if (run.state.kind !== 'running') {
        this.stepActivity.delete(run.id);
        continue;
      }
      anyRunning = true;
      const last = this.stepActivity.get(run.id);
      if (last == null) {
        // First sighting (e.g. a run restored mid-flight) — start its clock
        // here rather than declaring it stuck on the strength of no record.
        this.stepActivity.set(run.id, now);
        continue;
      }
      const stepId = run.state.currentStepId;
      const message = stuckStepMessage({
        stepId,
        silentMs: now - last,
        timeoutMs: FlowRuntimeImpl.STEP_SILENCE_TIMEOUT_MS,
      });
      if (!message) continue;
      const step = run.flowSnapshot.steps.find((s) => s.id === stepId);
      if (!step) continue;
      log('warn', 'flows.stepWatchdog', `run=${run.id} ${message}`);
      this.stepActivity.delete(run.id);
      this.finishAttempt(run, stepId, { outcome: 'error', errorMessage: message });
      this.handleStepFailure(run.id, step, message);
    }
    if (!anyRunning && this.stepWatchdogTimer) {
      clearInterval(this.stepWatchdogTimer);
      this.stepWatchdogTimer = null;
    }
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

  /// Mint a fresh throwaway conversation for a detect tick, releasing any
  /// previous one. Fresh per tick rather than reused: a reused detect
  /// conversation would accumulate its own tick history and reproduce exactly
  /// the unbounded growth this split exists to remove. The cost is a cold
  /// start per tick, which is free at a 60s floor — nothing is waiting on it.
  private mintWatchDetectConv(runId: UUID): UUID {
    this.releaseWatchDetectConv(runId);
    const convId = randomUUID();
    this.watchDetectConv.set(runId, convId);
    this.convIdToRun.set(convId, runId);
    return convId;
  }

  /// Tear down the run's detect conversation: stop its subprocess and drop its
  /// routing entry. Safe to call when there isn't one.
  private releaseWatchDetectConv(runId: UUID): void {
    const prev = this.watchDetectConv.get(runId);
    if (!prev) return;
    this.watchDetectConv.delete(runId);
    this.convIdToRun.delete(prev);
    this.dropPrewarmed(prev);
    try {
      this.runner.stop(prev);
    } catch {
      // best-effort — the tick is over either way
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
    // The participant conversation isn't what detect sends on any more, but it
    // is still required: escalation hands off to the answer pass, which runs
    // there. Without it a watch could detect forever and never reply, so back
    // off rather than tick blind.
    if (!participant || !run.conversationIds[w.participantId]) {
      w.lastTickAt = Date.now();
      return;
    }
    const convId = this.mintWatchDetectConv(runId);
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
    // Detect runs on the cheap watch model (the frequent no-op case). Falls
    // back to the participant's full model when no cheap model was resolved.
    const detectModel = w.watchModel || effectiveParticipantModel(run, w.participantId);
    const sendResult = this.sendWatchTurn({
      convId,
      backend: participant.backend,
      cwd: run.projectPath,
      allowedDirs: this.runAllowedDirs(run),
      model: detectModel,
      prompt,
      displayText: flowNote(`Watching ${w.binding || 'follow-ups'} — checking for new comments…`),
    });
    if (!sendResult.ok) {
      this.watchTicking.delete(runId);
      this.watchPhase.delete(runId);
      this.watchBuffers.delete(runId);
      this.releaseWatchDetectConv(runId);
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
    // Detect is done and the answer pass runs on the participant's
    // conversation, so the throwaway one has no further use.
    this.releaseWatchDetectConv(runId);
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
      allowedDirs: this.runAllowedDirs(run),
      model: effectiveParticipantModel(run, w.participantId),
      prompt,
      displayText: flowNote(`Answering on ${w.binding || 'the watched item'}…`),
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
    allowedDirs: string[];
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
      allowedDirs: args.allowedDirs,
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
      this.releaseWatchDetectConv(runId);
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
    this.releaseWatchDetectConv(runId);
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

  /// Give a run its own display title. Purely cosmetic — nothing in the
  /// runtime reads it — so it's safe at any point in a run's life,
  /// including mid-step. An empty/blank title clears the override and the
  /// UI falls back to the prompt-derived name.
  renameRun(args: { runId: UUID; title: string }): { ok: true } | { ok: false; error: string } {
    const run = this.runs.get(args.runId);
    if (!run) return { ok: false, error: `Run ${args.runId} not found.` };
    const trimmed = args.title.trim().slice(0, MAX_RUN_TITLE_LENGTH);
    const next = trimmed || undefined;
    if (run.title === next) return { ok: true };
    run.title = next;
    this.checkpoint(run);
    this.emitRunUpdate(run);
    return { ok: true };
  }

  /// Record that the user just typed at this run. Hijack turns go out over
  /// the generic `runner:send` path, which is conversation-shaped and knows
  /// nothing about runs — so without this the run's only user-driven
  /// timestamps are its launch and a Continue, and the sidebar orders a run
  /// you have been chatting with for ten minutes by when it started.
  /// Display-only: nothing in orchestration reads it.
  noteUserTurn(args: { runId: UUID }): { ok: true } | { ok: false; error: string } {
    const run = this.runs.get(args.runId);
    if (!run) return { ok: false, error: `Run ${args.runId} not found.` };
    run.lastUserTurnAt = Date.now();
    this.checkpoint(run);
    this.emitRunUpdate(run);
    return { ok: true };
  }

  /// Queue a course correction for the next step to run. Valid while a step
  /// is running AND while the run is paused: a pause is the moment the user
  /// is most likely to want to correct what happens next, and the pending
  /// step is known exactly. Only a finished run has nothing left to steer.
  /// Empty text withdraws a queued steer.
  steerRun(args: { runId: UUID; text: string }): { ok: true } | { ok: false; error: string } {
    const run = this.runs.get(args.runId);
    if (!run) return { ok: false, error: `Run ${args.runId} not found.` };
    if (run.state.kind !== 'running' && run.state.kind !== 'paused') {
      return { ok: false, error: 'This run has finished — there is no next step to correct.' };
    }
    const text = args.text.trim().slice(0, 2000);
    if (!text) {
      delete run.pendingSteer;
    } else {
      run.pendingSteer = {
        text,
        at: Date.now(),
        // Only meaningful when a step was actually mid-flight: it becomes
        // "Received while step X was running" in the block. A pause has no
        // running step, and `buildSteerBlock` drops the clause when absent.
        queuedDuringStepId:
          run.state.kind === 'running' ? run.state.currentStepId : undefined,
      };
      // Holding a correction is the user driving the run just as much as a
      // hijack turn is. Withdrawing one isn't, so only the set case stamps.
      run.lastUserTurnAt = run.pendingSteer.at;
    }
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
    const participantId = stepParticipantKey(step);
    // Declared wider than the map's value type: the Ollama reset below clears
    // this back to `undefined` to force a fresh conv, and the `if (!convId)`
    // mint that follows narrows it to a real id again before it is used.
    let convId: UUID | undefined = run.conversationIds[participantId];

    // …except on Ollama, where a participant gets a fresh conversation for
    // each NEW step. The shared-conv design buys continuity and prompt-cache
    // hits on the cloud backends. Locally it buys neither and costs a great
    // deal: the Ollama path replays the entire prior transcript on every
    // round, so step N+1 opens with step N's instructions still in context —
    // including its `<output name="…">` contract. Observed with gemma4:26b: a
    // test step (output `test_report.md`) reading the build step's prompt
    // (output `diff`) reasoned itself to a standstill — "This implies I can't
    // have both `<output name="diff">` and `<output name="test_report.md">`"
    // — and never emitted either. It was right; we had handed it two
    // contradictory contracts. Nothing is lost by starting clean: a step's
    // inputs are passed as artifacts in its own prompt.
    //
    // Keyed by step so a RETRY of the same step keeps its conversation — a
    // retry genuinely wants the failed attempt and the rejection feedback in
    // context, and its contract is unchanged.
    const stepConvKey = `${participantId}:${step.id}`;
    const stepBackend = resolveRunStepModel(run, step).backend;
    if (
      ollamaConvNeedsReset({
        backend: stepBackend,
        openedFor: convId ? this.ollamaConvStepKeys.get(convId) : undefined,
        wantedFor: stepConvKey,
      })
    ) {
      convId = undefined;
    }

    if (!convId) {
      convId = randomUUID();
      run.conversationIds[participantId] = convId;
    }
    if (stepBackend === 'ollama') this.ollamaConvStepKeys.set(convId, stepConvKey);
    this.convIdToRun.set(convId, runId);
    // Fresh buffer for this step's turn — the conv may already have
    // earlier steps' transcripts inside it, but artifact extraction
    // should only see what THIS step produces.
    // Every fresh attempt at a step gets its own missing-`<output>` nudge.
    this.reaskCounts.delete(`${runId}:${step.id}`);
    this.pointerRejections.delete(`${runId}:${step.id}`);
    this.stepBuffers.set(runId, {
      assistantText: '',
      usage: { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 },
      costUSD: 0,
    });

    // A participant can edit the worktree from hijack chat while the run is
    // paused (most notably: the premium verifier fixes its own findings after
    // exhausting on_fail retries). The stored diff artifact is a snapshot
    // from the last normal producer-step boundary, so it is stale after that
    // chat. Refresh diff inputs at CONSUMPTION time before building either
    // the model prompt or its attachment. This makes "fix it, then re-run
    // Verify" review the files that are actually on disk without forcing the
    // user to re-run the implementation step first.
    this.refreshDiffInputsFromWorktree(run, step);

    const prompt = this.buildStepPrompt(run, step);
    const attempt: FlowStepAttempt & { stepId: string } = {
      stepId: step.id,
      startedAt: Date.now(),
      conversationId: convId,
    };
    run.attempts.push(attempt);
    // Start the silence clock at the send, not at the first event: a send
    // that never produces one is exactly the case the watchdog exists for.
    this.stepActivity.set(runId, Date.now());
    this.ensureStepWatchdog();
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
    const spentSteer = run.pendingSteer;
    if (spentSteer) {
      delete run.pendingSteer;
      this.checkpoint(run);
      // The pill in SteerBanner is driven by `pendingSteer`; without this
      // it keeps claiming "queued" for the whole step that just spent it.
      this.emitRunUpdate(run);
    }
    // Both builders have read it — this attempt owns the feedback, so a
    // later step (or a manual re-run) doesn't get a stale rejection notice.
    if (this.retryFeedback.get(runId)?.targetStepId === step.id) {
      this.retryFeedback.delete(runId);
    }
    if (this.workerAnswerFeedback.get(runId)?.stepId === step.id) {
      this.workerAnswerFeedback.delete(runId);
    }
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
      allowedDirs: this.runAllowedDirs(run),
      model: stepModel.model,
      permissionMode: this.resolvePermissionMode(run, step),
      // Runtime-driven, not a user hijack — see SendArgs.flowStep.
      flowStep: true,
      turbo: step.turbo,
      reviewBackend: step.rebound?.critic.backend ?? null,
      reviewMode: step.rebound?.mode ?? null,
      reviewModel: step.rebound?.critic.model ?? null,
      reviewPersona: step.rebound?.persona ?? null,
      // `max_iters` is the step's round budget. The runner already caps
      // collab ping-pong at `collabMaxTurns`; without passing it here the
      // budget silently fell back to the interactive default of 3, so a
      // step asking for 1 round got 3 and a step asking for 5 got 3.
      // `review` mode ignores this by design — its round count is fixed
      // (see the round gate in runner.sendClaude and friends).
      collabMaxTurns: step.rebound?.maxIters ?? null,
      // The allowlist the approval gate classifies by is the allowlist the
      // process gets: Ollama enforces it in-dispatcher, claude via
      // --allowedTools (see backends/claude.ts). See resolveStepEffect.
      // `step.tools` is never undefined (schema.ts) and a bare `[]` must stay
      // an empty allowlist rather than becoming "no restriction" — Ollama
      // reads `undefined` as its own read-only default (runner.ts), and
      // claude.ts already guards on `length > 0` before emitting the flag.
      enabledTools: step.tools,
    });
    if (!sendResult.ok) {
      this.finishAttempt(run, step.id, { outcome: 'error', errorMessage: sendResult.error });
      // The send never reached the model, so the steer was not spent. Put it
      // back — otherwise the next Continue runs without the user's correction
      // and says nothing about having dropped it.
      if (spentSteer) {
        run.pendingSteer = spentSteer;
        this.checkpoint(run);
        this.emitRunUpdate(run);
      }
      this.handleStepFailure(runId, step, sendResult.error);
      return;
    }

    // The step is now generating, which is the cheapest moment in the whole
    // run to pay for the NEXT participant's cold start.
    this.prewarmNextParticipant(run, step);
  }

  /// Replace each diff-kind artifact consumed by `step` with a fresh
  /// cumulative worktree diff. Other artifact types remain historical
  /// outputs: only a diff has an authoritative representation on disk that
  /// can be safely regenerated after out-of-band edits such as hijack chat.
  private refreshDiffInputsFromWorktree(run: FlowRun, step: FlowStep): void {
    const refs = step.inputs.filter((ref) => ref !== FLOW_USER_PROMPT_REF);
    const diffRefs = refs.filter((ref) => run.artifacts[ref]?.kind === 'diff');
    if (diffRefs.length === 0) return;

    const liveDiff = computeRunDiffForRun(run);
    if (liveDiff === null) return;

    const producedAt = Date.now();
    for (const ref of diffRefs) {
      const existing = run.artifacts[ref];
      if (!existing || existing.body === liveDiff) continue;
      const refreshed = { ...existing, body: liveDiff, producedAt };
      run.artifacts[ref] = refreshed;
      this.emit({ type: 'flowArtifactProduced', runId: run.id, artifact: refreshed });
    }
  }

  /// Release a conversation's process if it is still an unused prewarm.
  /// Called wherever a run stops advancing: the step a warm-up was
  /// speculating on may never arrive, and an unused process holds no state
  /// worth keeping. Never touches a conversation that has actually run.
  private dropPrewarmed(convId: UUID): void {
    try {
      this.runner.dropIfPrewarmed(convId);
    } catch {
      // best-effort
    }
  }

  /// Start the next step's backend process while the current step is still
  /// generating, so its first turn doesn't pay CLI startup on the critical
  /// path. Steps run strictly in order, so "next" is simply the following
  /// entry — and each participant keeps one conversation for the whole run,
  /// so this only ever fires the first time a participant comes up.
  ///
  /// Deliberately narrow, because a warm-up that guesses wrong costs a
  /// process:
  ///   - A participant that already has a conversation is skipped. It either
  ///     has a live process already or a session to resume, and prewarm
  ///     spawns without a resume hint — warming it would risk handing the
  ///     step a context-free session in exchange for nothing.
  ///   - A step with any pause boundary is skipped. The run is about to stop for a
  ///     human, and "a while" is not a latency window worth holding a CLI
  ///     open for.
  ///
  /// Everything the spawn needs — model, permission mode, cwd — is derived
  /// from the flow snapshot and the run, so it is knowable now and matches
  /// what `executeStep` will ask for. If the user retargets the participant
  /// mid-run anyway, `sendSubprocess` sees the param change and respawns,
  /// exactly as it would have without the warm-up.
  private prewarmNextParticipant(run: FlowRun, step: FlowStep): void {
    const idx = run.flowSnapshot.steps.findIndex((s) => s.id === step.id);
    const next = idx >= 0 ? run.flowSnapshot.steps[idx + 1] : undefined;
    if (!next || pauseReasonBeforeStep(run, next)) return;
    const participantId = stepParticipantKey(next);
    if (run.conversationIds[participantId]) return;
    const stepModel = resolveRunStepModel(run, next);
    if (stepModel.backend === 'ollama') return;

    // Mint the conversation now so `executeStep` finds the warm process
    // under the same id instead of spawning a second one.
    const convId = randomUUID();
    run.conversationIds[participantId] = convId;
    this.convIdToRun.set(convId, run.id);
    this.runner.prewarm({
      conversationId: convId,
      prompt: '',
      backend: stepModel.backend,
      cwd: run.projectPath,
      allowedDirs: this.runAllowedDirs(run),
      model: stepModel.model,
      permissionMode: this.resolvePermissionMode(run, next),
      turbo: next.turbo,
      reviewBackend: null,
      reviewMode: null,
      reviewModel: null,
      reviewPersona: null,
    });
  }

  private onStepFinished(runId: UUID, stepId: string): void {
    const run = this.runs.get(runId);
    if (!run) return;
    const step = run.flowSnapshot.steps.find(s => s.id === stepId);
    if (!step) return;
    // The externalAction approval is one-shot: consumed the moment the step
    // it was granted for finishes, so it can never carry into whichever step
    // runs next. See resumeRunInner (where it's set) and resolvePermissionMode
    // / observeEvent (where it's consulted).
    if (run.externalActionApprovedStepId === stepId) {
      delete run.externalActionApprovedStepId;
    }
    const buf = this.stepBuffers.get(runId);
    const text = buf?.assistantText ?? '';

    const artifactKind = detectArtifactKind(step.output);
    let artifactBody = this.resolveArtifactBody(run, text, step.output, step.id);

    /// This step's own change, measured off the previous diff step's
    /// snapshot. Computed at most once per step: `computeIncrementalDiffForRun`
    /// ADVANCES that snapshot as a side effect, so calling it twice would
    /// report the second call as an empty increment.
    let incrementalDiff: string | null = null;

    // No <output> wrapper is not automatically a failed step: for a local
    // diff step the work may already be on disk. See canSynthesizeDiffFromTree.
    // The body assigned here is only a placeholder — the diff-kind branch
    // below overwrites it with the real filesystem diff, which is what the
    // artifact would have carried even had the model emitted a perfect block.
    const pendingQuestion = artifactBody === null && run.workerId ? extractWorkerQuestion(text) : null;
    if (
      canSynthesizeDiffFromTree({
        hasOutputBlock: artifactBody !== null,
        kind: artifactKind,
        backend: resolveRunStepModel(run, step).backend,
      })
    ) {
      // No `git status` precheck: computeIncrementalDiffForRun already runs
      // `git diff` and returns empty for a clean tree, so the precheck was a
      // second blocking spawn that answered a question the diff answers.
      incrementalDiff = this.computeIncrementalDiffForRun(run);
      if (treeChanged(incrementalDiff)) artifactBody = '';
    }

    if (artifactBody === null || (pendingQuestion && artifactBody === '')) {
      const question = pendingQuestion;
      if (question && this.workerSupervisor) {
        const usageTotals = buf
          ? {
              usage: { ...buf.usage },
              costUSD: buf.costUSD > 0 ? buf.costUSD : undefined,
            }
          : {};
        this.finishAttempt(run, step.id, { outcome: 'question', ...usageTotals });
        const exchange: FlowWorkerExchange = {
          id: randomUUID(),
          stepId: step.id,
          participantId: stepParticipantKey(step),
          askedAt: Date.now(),
          question,
          status: 'asking',
        };
        run.workerExchanges = [...(run.workerExchanges ?? []), exchange].slice(-50);
        this.emitRunUpdate(run);
        this.checkpoint(run);

        let lastSuccess = -1;
        for (let i = run.attempts.length - 1; i >= 0; i -= 1) {
          const attempt = run.attempts[i];
          if (attempt.stepId === step.id && attempt.outcome === 'success') {
            lastSuccess = i;
            break;
          }
        }
        const rounds = run.attempts
          .slice(lastSuccess + 1)
          .filter((attempt) => attempt.stepId === step.id && attempt.outcome === 'question')
          .length;
        if (rounds > FlowRuntimeImpl.MAX_WORKER_QUESTION_ROUNDS) {
          exchange.status = 'escalated';
          exchange.answeredAt = Date.now();
          exchange.note = `The flow asked more than ${FlowRuntimeImpl.MAX_WORKER_QUESTION_ROUNDS} follow-up questions.`;
          run.state = { kind: 'paused', nextStepId: step.id, reason: 'needsInput' };
          this.emitRunUpdate(run);
          this.checkpoint(run);
          return;
        }

        void this.resolveWorkerQuestion(run, step, exchange);
        return;
      }
      // Before failing on a formatting slip, ask once for the block itself.
      // The work is usually DONE at this point — written to a file, or
      // narrated in the reply — and only the wrapper is missing, so pausing
      // the run here spends the user's attention on something the model can
      // fix in one cheap turn.
      if (this.reaskMissingOutput(run, step, text)) return;
      // No <output> block — treat as failure so onFail policy decides.
      this.finishAttempt(run, step.id, {
        outcome: 'error',
        errorMessage: `Step "${step.id}" produced no <output name="${step.output}"> block.`,
      });
      this.handleStepFailure(runId, step, `missing <output name="${step.output}"> in assistant text`);
      return;
    }

    const kind = artifactKind;
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
      // Already measured above on the synthesize-from-tree path; measuring
      // again would advance the snapshot past this step's own change.
      const incremental = incrementalDiff ?? this.computeIncrementalDiffForRun(run);
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

    // Verdict gate: a built-in or explicit custom review produced its
    // artifact cleanly, but if the verdict isn't an approval the flow must NOT roll on to
    // downstream steps (tests/push) over disapproved work. Route it through
    // the normal `on_fail` policy — pause by default, or `goto` to loop
    // back to an earlier step the user wired up. The artifact itself is
    // already recorded above, so the user sees the rejecting review.
    if (verdictGateStopsRun(run, step) && !isReviewApproved(body)) {
      const gist = summarizeReviewRejection(body);
      this.handleStepFailure(
        runId,
        step,
        `Reviewer step "${step.id}" did not approve (no "APPROVED" verdict in ${step.output})` +
          (gist ? ` — ${gist}` : '') +
          '.',
      );
      return;
    }

    this.advanceAfterStep(runId, step.id);
  }

  private async resolveWorkerQuestion(
    runAtAsk: FlowRun,
    step: FlowStep,
    exchangeAtAsk: FlowWorkerExchange,
  ): Promise<void> {
    const supervisor = this.workerSupervisor;
    if (!supervisor || !runAtAsk.workerId) return;

    let result: FlowWorkerQuestionResult;
    try {
      result = await supervisor({
        workerId: runAtAsk.workerId,
        workerName: runAtAsk.workerName,
        flowName: runAtAsk.flowSnapshot.name,
        runTitle: runAtAsk.title ?? runAtAsk.orchestrationItemTitle,
        projectPath: runAtAsk.projectPath,
        userPrompt: runAtAsk.userPrompt,
        step: {
          id: step.id,
          role: step.role,
          systemPromptOverride: step.systemPromptOverride,
          inputs: step.inputs,
          output: step.output,
        },
        question: exchangeAtAsk.question,
        artifacts: Object.values(runAtAsk.artifacts).map((artifact) => ({
          name: artifact.name,
          body: artifact.body.slice(0, 20_000),
          producedByStepId: artifact.producedByStepId,
        })),
      });
    } catch (err) {
      result = { kind: 'error', error: err instanceof Error ? err.message : String(err) };
    }

    // The user may have aborted/deleted the run while its Worker was thinking.
    const run = this.runs.get(runAtAsk.id);
    if (!run) return;
    const exchange = run.workerExchanges?.find((x) => x.id === exchangeAtAsk.id);
    if (!exchange || exchange.status !== 'asking') return;
    if (run.state.kind !== 'running' || run.state.currentStepId !== step.id) return;

    exchange.answeredAt = Date.now();
    if (result.kind === 'answer' && result.answer.trim()) {
      exchange.status = 'answered';
      exchange.answer = result.answer.trim();
      this.workerAnswerFeedback.set(run.id, {
        stepId: step.id,
        exchangeId: exchange.id,
        question: exchange.question,
        answer: exchange.answer,
      });
      this.emitRunUpdate(run);
      this.checkpoint(run);
      void this.executeStep(run.id, step.id);
      return;
    }

    exchange.status = result.kind === 'escalate' ? 'escalated' : 'failed';
    exchange.note =
      result.kind === 'escalate'
        ? result.reason
        : result.kind === 'error'
          ? result.error
          : 'The Worker returned an empty answer.';
    run.state = { kind: 'paused', nextStepId: step.id, reason: 'needsInput' };
    this.emitRunUpdate(run);
    this.checkpoint(run);
  }

  private advanceAfterStep(runId: UUID, finishedStepId: string): void {
    const run = this.runs.get(runId);
    if (!run) return;
    const idx = run.flowSnapshot.steps.findIndex(s => s.id === finishedStepId);
    const next = run.flowSnapshot.steps[idx + 1];
    if (!next) {
      run.state = { kind: 'done', success: true };
      delete run.pendingSteer; // no step left to carry it
      this.emitRunUpdate(run);
      this.checkpoint(run); // terminal — save final state
      return;
    }
    // Worker-owned runs always stop before effects outside the run cwd.
    // This is independent of tool permissions: local edits/tests stay fully
    // autonomous, while pushes/messages/ticket updates require one explicit
    // approval. An authored pause_before remains an additional checkpoint.
    const pauseReason = pauseReasonBeforeStep(run, next);
    if (pauseReason) {
      run.state = { kind: 'paused', nextStepId: next.id, reason: pauseReason };
      this.emitRunUpdate(run);
      this.checkpoint(run); // boundary — paused state is resumable across restart
      return;
    }
    run.state = { kind: 'running', currentStepId: next.id };
    this.emitRunUpdate(run);
    void this.executeStep(runId, next.id);
  }

  /// Resolve a step's artifact body from its final message, in priority
  /// order: the strict inline block, then the pointer form, then — only if a
  /// pointer was claimed and could not be honoured — whatever body was typed
  /// alongside it. Everything failing leaves `null`, which is the same "no
  /// output" the reask and on_fail paths already handle.
  ///
  /// The pointer is gated on the run having produced the file: first on the
  /// attempt's mtime floor (see `readArtifactFile`), and failing that on git
  /// showing it among the run's own changes (see `pathChangedInRun`).
  ///
  /// A rejected pointer is remembered per step so `reaskMissingOutput` can
  /// tell the model why, instead of drawing the same pointer twice.
  private resolveArtifactBody(
    run: FlowRun,
    text: string,
    outputName: string,
    stepId: string,
  ): string | null {
    const key = `${run.id}:${stepId}`;
    this.pointerRejections.delete(key);
    const inline = extractOutput(text, outputName);
    if (inline !== null) return inline;
    // `url` artifacts never come from disk (see `stepAllowsFileRef`), so a
    // `file=` attribute on one is noise around a typed value, not a pointer.
    if (detectArtifactKind(outputName) === 'url') return extractOutputLooseBody(text, outputName);
    const ref = extractOutputFileRef(text, outputName);
    if (!ref) return null;
    const abs = resolveArtifactFilePath(ref, run.projectPath);
    if (!abs) {
      log('warn', 'flows.outputFile', `pointer path outside run root, ignoring: ${ref}`);
      this.pointerRejections.set(key, { path: ref, reason: 'missing' });
      return this.recoverTypedBody(text, outputName);
    }
    const attemptStartedAt = this.lastAttemptStartedAt(run, stepId);
    let read = readArtifactFile(abs, attemptStartedAt);
    // Older than this attempt, but the run's own work — the usual shape is a
    // re-run, or a step that read the file, found it already correct, and
    // changed nothing. Re-read with the floor lifted.
    //
    // `runOwnsPath` gets the RUN's start, not this attempt's: it exists
    // specifically to lift a floor a file already failed (`attemptStartedAt`
    // above), so reusing that same floor inside it would make the gitignored
    // fallback it guards permanently unreachable — an ignored file the run
    // wrote at step 1 has to still count as owned when step 4 asks.
    if (!read.ok && read.reason === 'stale' && this.runOwnsPath(run, abs, run.createdAt)) {
      read = readArtifactFile(abs, 0);
      if (read.ok) {
        log('info', 'flows.outputFile', `pointer file predates the attempt but is the run's own work: ${abs}`);
      }
    }
    if (!read.ok) {
      log('warn', 'flows.outputFile', `pointer file rejected (${read.reason}): ${abs}`);
      this.pointerRejections.set(key, { path: ref, reason: read.reason });
      return this.recoverTypedBody(text, outputName);
    }
    return read.body;
  }

  /// Whether git in the repo holding `abs` reports it as this run's own
  /// change. Workspace runs carry a baseline per member, so the question is
  /// asked of the member repo that contains the file.
  private runOwnsPath(run: FlowRun, abs: string, runStartedAt: number): boolean {
    // Workspace runs hand the step a symlink farm; the member repos live
    // elsewhere. Without realpath the ownership fallback never matches.
    let probe = abs;
    try {
      probe = realpathSync(abs);
    } catch {
      /* not on disk yet */
    }
    let repoRoot = run.projectPath;
    let baseline = run.baselineCommit;
    if (run.baselineCommitsByMember) {
      for (const info of Object.values(run.baselineCommitsByMember)) {
        // Realpath this side too: `probe` is already realpath'd above, and a
        // member root that itself sits behind a symlink would otherwise never
        // match a literally-resolved comparison — the exact workspace case
        // this fallback exists for.
        let root = resolve(info.path);
        try {
          root = realpathSync(root);
        } catch {
          /* not on disk yet */
        }
        if (probe === root || probe.startsWith(root + sep)) {
          repoRoot = info.path;
          baseline = info.commit;
          break;
        }
      }
    }
    if (!repoRoot) return false;
    return pathChangedInRun(repoRoot, baseline, probe, runStartedAt);
  }

  /// The pointer was claimed and refused. If the model ALSO typed a body into
  /// that same tag, it is the deliverable and throwing it away would spend a
  /// whole extra turn re-asking for text we already have.
  private recoverTypedBody(text: string, outputName: string): string | null {
    const typed = extractOutputLooseBody(text, outputName);
    if (typed !== null) {
      log('info', 'flows.outputFile', `recovered inline body from a pointer tag for "${outputName}"`);
    }
    return typed;
  }

  /// Start time of the most recent attempt at `stepId`, or 0 when the run has
  /// no record of one. Used as the pointer-freshness floor.
  private lastAttemptStartedAt(run: FlowRun, stepId: string): number {
    for (let i = run.attempts.length - 1; i >= 0; i--) {
      if (run.attempts[i].stepId === stepId) return run.attempts[i].startedAt;
    }
    return 0;
  }

  /// A step finished without the `<output name="…">` wrapper. Ask its
  /// participant, once per attempt, to re-emit the deliverable properly
  /// before treating the step as failed.
  ///
  /// Nearly every one of these is a formatting slip rather than a failure of
  /// the work: the model wrote the file to disk and reported on it, wrapped
  /// the block in a code fence, or simply forgot the tag. The context that
  /// produced the deliverable is still live in the participant's
  /// conversation, so one short follow-up turn recovers it — where pausing
  /// costs a human round trip and re-running the step redoes minutes of
  /// correct work.
  ///
  /// Returns true when a nudge was sent, in which case the step stays in
  /// flight: the follow-up turn's `running: false` re-enters
  /// `onStepFinished` on the same step, extracting from a buffer that now
  /// holds only the nudge's reply.
  private reaskMissingOutput(run: FlowRun, step: FlowStep, priorText: string): boolean {
    const key = `${run.id}:${step.id}`;
    const used = this.reaskCounts.get(key) ?? 0;
    if (used >= FlowRuntimeImpl.MAX_MISSING_OUTPUT_REASKS) return false;

    const participantId = stepParticipantKey(step);
    const convId = run.conversationIds[participantId];
    // No conversation means the turn never really happened — nothing to
    // follow up on, and a nudge would open a context-free session.
    if (!convId) return false;

    const stepModel = resolveRunStepModel(run, step);
    // Why the last reply's pointer was refused, if it drew one. Without it
    // the nudge reads as "you emitted no block", the model re-sends the
    // identical pointer, and the second miss is decided before it is sent.
    const rejection = this.pointerRejections.get(key);
    const buf = this.stepBuffers.get(run.id);
    // The nudge's reply is the only text that should be extracted from.
    // Usage and cost stay — they belong to this attempt either way.
    if (buf) buf.assistantText = '';

    const sendResult = this.runner.send({
      conversationId: convId,
      prompt: missingOutputReaskPrompt(
        step.output,
        stepAllowsFileRef(step, stepModel.backend),
        rejection,
      ),
      displayText: flowNote(
        rejection
          ? `Asking for ${step.output} inline — ${rejection.path} couldn't be used (${rejection.reason}).`
          : `Asking for ${step.output} in an output block so it can be handed to the next step.`,
      ),
      backend: stepModel.backend,
      cwd: run.projectPath,
      allowedDirs: this.runAllowedDirs(run),
      model: stepModel.model,
      permissionMode: this.resolvePermissionMode(run, step),
      flowStep: true,
      reviewBackend: null,
      reviewMode: null,
      reviewModel: null,
      reviewPersona: null,
      // Ollama dispatches tools itself, and this turn wants prose only —
      // a local model handed tools here tends to go back to work instead
      // of answering.
      enabledTools: stepModel.backend === 'ollama' ? [] : undefined,
    });
    if (!sendResult.ok) {
      // Put the original text back so the caller fails against what the
      // step actually said.
      if (buf) buf.assistantText = priorText;
      return false;
    }

    this.reaskCounts.set(key, used + 1);
    // The step is live again — don't let the silence watchdog count the
    // time already spent on the failed turn against it.
    this.markStepActivity(run.id);
    return true;
  }

  private handleStepFailure(runId: UUID, step: FlowStep, message: string): void {
    const run = this.runs.get(runId);
    if (!run) return;
    const policy = step.onFail ?? { action: 'pause' };

    if (policy.action === 'abort') {
      run.state = { kind: 'aborted' };
      // Same reason as `abortRun`: a queued correction is persisted, and a
      // terminal run that is later re-run from a step must not replay it as
      // if it were fresh guidance.
      delete run.pendingSteer;
      this.emitRunUpdate(run);
      this.checkpoint(run); // terminal — save final state
      return;
    }

    if (policy.action === 'goto') {
      const key = `${runId}:${step.id}`;
      const used = this.retryCounts.get(key) ?? 0;
      if (used < policy.maxRetries) {
        this.retryCounts.set(key, used + 1);
        // Hand the target step the reason it's being re-run. The failing
        // step's artifact (a reviewer's `review.md`) is the substance —
        // `buildStepPrompt` pulls it in as an extra input even when the
        // target's declared `inputs` don't list it.
        const produced = run.artifacts[step.output];
        this.retryFeedback.set(runId, {
          targetStepId: policy.target,
          fromStepId: step.id,
          artifactName: produced ? step.output : null,
          reason: message,
          attempt: used + 1,
          maxRetries: policy.maxRetries,
        });
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

  /// Extra directories every send in this run needs in scope. Inputs over
  /// INLINE_THRESHOLD_BYTES are handed to the model as absolute paths under
  /// userData instead of inline text (see `buildStepPrompt`), and nothing
  /// about the run's cwd covers that location — without this the model gets
  /// a path it is structurally unable to read, which reads to it as a
  /// missing input rather than a misconfiguration.
  ///
  /// Returned for every send in the run, not just the ones that actually
  /// attached something, so the allowed set never changes mid-conversation.
  private runAllowedDirs(run: FlowRun): string[] {
    try {
      return [ensureAttachmentDir(run.id)];
    } catch (err) {
      // Can't create the dir — attachment writes will fail too and
      // `buildStepPrompt` falls back to inlining, so the step still runs.
      log('warn', 'flows.attachmentDir', `attachment dir unavailable for run ${run.id}`, err);
      return [];
    }
  }

  /// Input names this step's participant produced ITSELF, in the very
  /// conversation this step is about to resume — so the bytes are already
  /// in the model's context and re-inlining them pays for the same text
  /// twice. These get handed over as a path reference instead (see
  /// `buildStepPrompt`), which keeps them recoverable if the conversation
  /// was compacted while dropping them from the prompt.
  ///
  /// Deliberately strict. An input only qualifies when:
  ///   - the backend isn't Ollama — there a participant gets a FRESH
  ///     conversation per step (see `ollamaConvNeedsReset`), so nothing
  ///     carries forward and every input is genuinely new to the model;
  ///   - a SUCCESSFUL attempt on the producing step ran on the exact
  ///     conversation id this step will use. Same id means the transcript
  ///     literally contains the model's own `<output>` block. A re-minted
  ///     conversation fails this test and the input inlines as usual;
  ///   - the artifact isn't a diff. Diff bodies are re-derived from the
  ///     worktree rather than taken from the model's text
  ///     (`refreshDiffInputsFromWorktree`, and the `kind === 'diff'` branch
  ///     when the artifact is committed), so what's in `run.artifacts` is
  ///     usually NOT what this participant emitted. Telling it otherwise
  ///     would point it at a stale copy in its own history.
  private selfProducedInputs(run: FlowRun, step: FlowStep, backend: string): Set<string> {
    const empty = new Set<string>();
    const participantId = step.participantId;
    if (!participantId || backend === 'ollama') return empty;
    const convId = run.conversationIds[participantId];
    if (!convId) return empty;

    // Steps whose output this participant emitted on THIS conversation.
    const ownStepIds = new Set(
      run.attempts
        .filter((a) => a.outcome === 'success' && a.conversationId === convId)
        .map((a) => a.stepId),
    );
    if (ownStepIds.size === 0) return empty;

    const names = new Set<string>();
    for (const [name, art] of Object.entries(run.artifacts)) {
      if (art.kind === 'diff') continue;
      if (art.producedByStepId === step.id) continue; // this step's own prior attempt
      if (ownStepIds.has(art.producedByStepId)) names.add(name);
    }
    return names;
  }

  private buildStepPrompt(run: FlowRun, step: FlowStep): string {
    const stepModel = resolveRunStepModel(run, step);
    const systemPrompt = resolveSystemPrompt({
      role: step.role,
      override: step.systemPromptOverride,
      outputName: step.output,
      allowFileRef: stepAllowsFileRef(step, stepModel.backend),
    });

    // Each input becomes either an inline body (small enough to live in
    // the prompt) or an on-disk attachment (referenced by absolute
    // path; the CLI's own Read tool pulls it when the model needs it).
    // user_prompt is always inline — it's the user's words and tends
    // to be short.
    type InlineInput = { kind: 'inline'; name: string; body: string };
    type AttachedInput = {
      kind: 'attached';
      name: string;
      path: string;
      size: number;
      /// This participant wrote this artifact itself, earlier in the very
      /// conversation it is resuming — so it is referenced rather than
      /// re-sent at any size. See `selfProducedInputs`.
      recalled: boolean;
    };
    type InputPart = InlineInput | AttachedInput;

    const canAttach = stepModel.backend !== 'ollama';
    const selfProduced = this.selfProducedInputs(run, step, stepModel.backend);

    const rawInputs: Array<{ name: string; body: string }> = [];
    for (const ref of step.inputs) {
      if (ref === FLOW_USER_PROMPT_REF) {
        rawInputs.push({ name: 'user_prompt', body: run.userPrompt });
      } else {
        const art = run.artifacts[ref];
        if (art) rawInputs.push({ name: ref, body: art.body });
      }
    }
    // `on_fail.goto` sent us back here: prepend why, and make sure the
    // rejecting step's artifact is actually in front of the model. It's
    // usually NOT in `step.inputs` (a `build` step declares `plan.md`, not
    // the `review.md` that doesn't exist yet when the flow is authored), so
    // without this the retry is blind. Pushed through the same
    // attach/truncate path as every other input.
    const feedback = this.pendingRetryFeedback(run, step);
    if (feedback?.artifactName && !rawInputs.some((p) => p.name === feedback.artifactName)) {
      const art = run.artifacts[feedback.artifactName];
      if (art) rawInputs.push({ name: feedback.artifactName, body: art.body });
    }
    const retryBlock = feedback ? `${buildRetryFeedbackBlock(feedback)}\n\n---\n\n` : '';
    // A steer arriving on the same step as a retry goes FIRST: the owner's
    // live correction outranks a reviewer's earlier rejection.
    const steer = run.pendingSteer;
    const steerBlock = steer?.text.trim()
      ? `${buildSteerBlock(steer.text, steer.queuedDuringStepId)}\n\n---\n\n`
      : '';
    const workerBoundary = buildWorkerRunBoundary(run);
    const workerSupervision = buildWorkerSupervisionBoundary(run);
    const workerAnswer = this.workerAnswerFeedback.get(run.id);
    const workerAnswerBlock =
      workerAnswer?.stepId === step.id
        ? buildWorkerAnswerBlock(workerAnswer.question, workerAnswer.answer)
        : '';

    const inputParts: InputPart[] = rawInputs.map((p) => {
      const isLarge = p.body.length > FlowRuntimeImpl.INLINE_THRESHOLD_BYTES;
      // Self-produced inputs are referenced at ANY size, not just past the
      // inline threshold: the model already has the full text in the
      // transcript it's resuming, so inlining a second copy buys nothing.
      const recalled = selfProduced.has(p.name);
      if (canAttach && (isLarge || recalled) && p.name !== 'user_prompt') {
        try {
          const att = writeAttachment(run.id, p.name, p.body);
          return { kind: 'attached', name: p.name, path: att.path, size: att.size, recalled };
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
    const overhead = systemPrompt.length + steerBlock.length + retryBlock.length + 500; // wrappers + instructions
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
      if (p.recalled) {
        return (
          `<input name="${p.name}" attached="${p.path}" size="${p.size}" recalled="true">\n` +
          `You produced this artifact yourself earlier in THIS conversation, so ` +
          `it is not repeated here. Scroll back to your own output for it. If you ` +
          `cannot find it above, read the path "${p.path}" with your file-reading ` +
          `tool (Read / read_file / similar) — that file holds the exact bytes.\n` +
          `</input>`
        );
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

    const attachedCount = inputParts.filter((p) => p.kind === 'attached' && !p.recalled).length;
    const recalledNames = inputParts
      .filter((p) => p.kind === 'attached' && p.recalled)
      .map((p) => p.name);
    const preambleNotes: string[] = [];
    if (attachedCount > 0) {
      preambleNotes.push(
        `${attachedCount} input(s) were attached as files rather than inlined. ` +
          'Read them with your file-reading tool — do not assume they are empty.',
      );
    }
    if (recalledNames.length > 0) {
      preambleNotes.push(
        `${recalledNames.join(', ')} ${recalledNames.length === 1 ? 'is' : 'are'} your own ` +
          'earlier output in this conversation and so appear as references rather than ' +
          'repeated text — they are NOT empty, and each carries the path to re-read if needed.',
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
      `${steerBlock}${retryBlock}${workerAnswerBlock}${workerBoundary}${workerSupervision}${systemPrompt}${preamble}\n\n---\n\nINPUTS:\n\n${inputs}\n\n---\n\n` +
      `Proceed with your task now. Remember to wrap your final deliverable in ` +
      `<output name="${step.output}">…</output>.`
    );
  }

  /// Retry feedback owed to `step`, or null. Read-only — `executeStep`
  /// clears the entry once it has built both the prompt and the display
  /// text from it.
  private pendingRetryFeedback(run: FlowRun, step: FlowStep): FlowRetryFeedback | null {
    const fb = this.retryFeedback.get(run.id);
    if (!fb || fb.targetStepId !== step.id) return null;
    return fb;
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
    const feedback = this.pendingRetryFeedback(run, step);
    if (feedback) {
      header.push(
        `_↺ Retry ${feedback.attempt} of ${feedback.maxRetries} — sent back by ` +
          `**${feedback.fromStepId}**: ${feedback.reason}_`,
      );
    }
    const steerText = run.pendingSteer?.text.trim();
    if (steerText) {
      header.push(`_↯ Course correction applied: ${steerText}_`);
    }
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
    // Mirror buildStepPrompt: on a retry the rejecting step's artifact is
    // fed in even though it isn't a declared input, so show it here too.
    if (feedback?.artifactName && !inputs.some((i) => i.name === feedback.artifactName)) {
      const art = run.artifacts[feedback.artifactName];
      if (art) inputs.push({ name: feedback.artifactName, body: art.body });
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
    //   - A worker with no grant for external actions is the one exception,
    //     handled below: it must not auto-approve everything, whatever the
    //     backend. Nobody watches a nightly shift to click Allow/Deny, so
    //     `observeEvent` auto-denies any request that reaches the broker —
    //     the step gets a clean refusal instead of a permanent hang.
    //   - Ollama: step.tools is an authoritative allowlist; only flip
    //     into bypassPermissions when a write tool is actually granted.
    //   - Claude/Codex/Gemini/Copilot: the CLI owns the tool surface,
    //     not us. Default to bypassPermissions so the flow doesn't
    //     stall on every Bash/Edit prompt — the user can downgrade to
    //     'default'/'acceptEdits' on the step itself.
    const stepModel = resolveStepModel(run.flowSnapshot, step);
    // An unattended worker with no grant for external actions must never run
    // under a mode that auto-approves every call. `acceptEdits` keeps the
    // approval broker wired (backends/claude.ts skips it only for
    // bypassPermissions), so anything outside the step's declared allowlist
    // routes through mcp__overcli__approve instead of just firing. Skipped
    // when THIS step is the one the user just approved via the externalAction
    // pause — that approval is one-shot (see resumeRunInner / onStepFinished)
    // and must not still force through the broker only to auto-deny it.
    if (run.workerId && !run.allowExternalActions && run.externalActionApprovedStepId !== step.id) {
      return 'acceptEdits';
    }
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
    delete run.pendingSteer; // see `abortRun` — never replay it on a re-run
    this.emitRunUpdate(run);
    this.emit({ type: 'error', conversationId: run.id, message });
  }

  /// Register the run observer (see `runObserver`). Called once at wiring
  /// time in main/index.ts after both the runtime and orchestrator exist.
  setRunObserver(cb: (run: FlowRun) => void): void {
    this.runObserver = cb;
  }

  /// Attach the standing-worker decision loop after both engines exist.
  /// The runtime remains usable without it; a missing supervisor simply
  /// preserves the legacy missing-output failure behavior.
  setWorkerSupervisor(
    cb: (request: FlowWorkerQuestionRequest) => Promise<FlowWorkerQuestionResult>,
  ): void {
    this.workerSupervisor = cb;
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

/// Key a step's conversation is filed under in `FlowRun.conversationIds`.
/// Normally the participant it's assigned to — participants share one
/// conversation across all their steps so context carries forward. A step
/// with no resolvable participant falls back to its own id, which gives it
/// a private conversation rather than one shared by every such step.
/// Every reader must key the same way; see the guard in `observeEvent`.
export function stepParticipantKey(step: Pick<FlowStep, 'id' | 'participantId'>): string {
  return step.participantId || step.id;
}

/// The failure message for a step that has gone silent past the watchdog's
/// timeout, or null while it's still within budget. Split out from the
/// sweep so the boundary is testable without a live runtime.
export function stuckStepMessage(args: {
  stepId: string;
  silentMs: number;
  timeoutMs: number;
}): string | null {
  if (args.silentMs <= args.timeoutMs) return null;
  const minutes = Math.round(args.silentMs / 60_000);
  return `Step "${args.stepId}" produced no output for ${minutes} minutes — treating it as failed.`;
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

/// Roles that change the working copy or push it somewhere. Their presence is
/// what makes a verdict actionable: something downstream can build on, fix, or
/// ship the reviewed work. A flow without one of these produces documents and
/// nothing else.
const CODE_WRITING_ROLES: ReadonlySet<FlowRolePreset> = new Set([
  'implementer',
  'test-writer',
  'shipper',
]);

export function flowHasCodeWritingStep(steps: readonly Pick<FlowStep, 'role'>[]): boolean {
  return steps.some((step) => CODE_WRITING_ROLES.has(step.role));
}

/// Should a non-approving verdict actually STOP this run?
///
/// A gating reviewer that never approves is right in front of a step that would
/// act on the work. It is wrong when the review IS the deliverable: an audit
/// whose security lens finds two real issues has succeeded, and halting there
/// throws away the report that was the point of the run.
///
/// Unattended runs are where that distinction stops being cosmetic. A user who
/// launched a flow by hand sees the pause and clicks through it; a worker on a
/// 08:30 cadence just produces nothing, on exactly the shifts that had
/// something to say, until someone notices the silence. So the assessor
/// reading only relaxes the gate for worker-owned runs — an interactive run
/// keeps pausing, because there is someone there for the pause to inform.
///
/// Narrow on purpose. An explicit `verdict_gate` always wins (that is the
/// user's own answer to this question), `plan-reviewer` is exempt because
/// judging a plan before code exists is a real gate, and a flow holding any
/// code-writing step keeps every gate it has.
export function verdictGateStopsRun(
  run: Pick<FlowRun, 'workerId' | 'flowSnapshot'>,
  step: Pick<FlowStep, 'role' | 'systemPromptOverride' | 'verdictGate' | 'onFail'>,
): boolean {
  if (!isGatingReviewStep(step)) return false;
  if (step.verdictGate !== undefined) return step.verdictGate;
  if (!run.workerId) return true;
  if (step.role === 'plan-reviewer') return true;
  // The code-writing relaxation is about PRESET reviewers on a flow that
  // writes no code. A custom step only counts as a gate when its own prompt
  // and `on_fail: goto` say so, and dropping that turns the revision loop off.
  if (!isGatingReviewerRole(step.role)) return true;
  return flowHasCodeWritingStep(run.flowSnapshot.steps);
}

/// Custom steps are how AI-drafted flows express domain-specific reviews:
/// they keep the specialist instructions in `systemPromptOverride` instead of
/// using one of the generic reviewer presets. Treat one as a verdict gate when
/// its prompt explicitly defines both sides of the approval contract. This is
/// intentionally narrower than "custom + on_fail" — custom action steps also
/// use failure policies for tool errors and must not be forced to emit an
/// APPROVED verdict.
export function isGatingReviewStep(
  step: Pick<FlowStep, 'role' | 'systemPromptOverride' | 'verdictGate' | 'onFail'>,
): boolean {
  if (step.verdictGate !== undefined) return step.verdictGate;
  if (isGatingReviewerRole(step.role)) return true;
  if (step.role !== 'custom') return false;
  const prompt = step.systemPromptOverride ?? '';
  const definesApproval = /\bAPPROVED\b/i.test(prompt);
  const definesRejection = /\b(?:CHANGES\s+REQUESTED|REJECTED|NOT\s+APPROVED)\b/i.test(prompt);
  // Legacy custom reviewers predate verdict_gate. Their goto loop is the
  // strongest structural signal that this output really is a gate. Requiring
  // it prevents an action step that says "deliver only after APPROVED; report
  // NOT APPROVED otherwise" from being classified as the reviewer itself.
  return definesApproval && definesRejection && step.onFail?.action === 'goto';
}

/// Resolve the side-effect class for a step. New flows state it explicitly;
/// old flows get a conservative compatibility inference so existing worker
/// contracts gain the external approval boundary without being hand-edited.
/// A clear external directive always wins over an erroneous `effect: local`:
/// safety metadata can add a boundary, never waive an obvious one.
export function resolveStepEffect(
  step: Pick<
    FlowStep,
    'id' | 'role' | 'systemPromptOverride' | 'tools' | 'output' | 'effect'
  >,
): 'local' | 'external' {
  if (step.effect === 'external') return 'external';
  if (step.role === 'shipper') return 'external';

  const text = [step.id, step.output, step.systemPromptOverride ?? '', ...(step.tools ?? [])]
    .join(' ')
    .replace(/[_-]+/g, ' ');
  const actionableText = text.replace(
    /\b(?:do\s+not|don't|never|must\s+not)\s+(?:git\s+)?(?:push|deploy|publish|send|post|reply|respond|message|create|update|edit|delete|close|merge)\b[^.\n]*/gi,
    '',
  );
  const directExternal =
    /\bgit\s+push\b|\bpush\s+(?:the\s+)?(?:branch|code|changes|commit)|\bdeploy\b|\brelease\s+to\b|\bpublish\s+(?:the\s+)?(?:site|app|package|release|document)|\bmerge\s+(?:the\s+)?(?:branch|pull request|pr)\b/i;
  const prWrite =
    /\b(?:open|create|update|edit|close|merge)\b[^.\n]{0,80}\b(?:pull request|merge request|pr)\b|\b(?:pull request|merge request|pr)\b[^.\n]{0,80}\b(?:open|create|update|edit|close|merge)\b/i;
  const messageWrite =
    /\b(?:send|post|reply|respond|message|dm|deliver)\b[^.\n]{0,100}\b(?:slack|teams|email|e-mail|message|dm|channel|thread|recipient|inbox)\b|\b(?:slack|teams|email|e-mail|message|dm|channel|thread|recipient|inbox)\b[^.\n]{0,100}\b(?:send|post|reply|respond|message|deliver)\b/i;
  const serviceWrite =
    /\b(?:create|update|edit|change|delete|remove|close|transition|assign|comment|add|record|schedule|invite|upload)\b[^.\n]{0,110}\b(?:jira|productboard|zendesk|salesforce|linear|asana|trello|ticket|issue|insight|card|calendar|event|crm|record)\b|\b(?:jira|productboard|zendesk|salesforce|linear|asana|trello|ticket|issue|insight|card|calendar|event|crm)\b[^.\n]{0,110}\b(?:create|update|edit|change|delete|remove|close|transition|assign|comment|add|record|schedule|invite|upload)\b/i;
  if (directExternal.test(actionableText) || prWrite.test(actionableText) || messageWrite.test(actionableText) || serviceWrite.test(actionableText)) {
    return 'external';
  }
  // Fail closed: a step that reaches for a tool we don't recognise as read-only
  // is treated as external, so an unattended worker pauses rather than acting.
  // Covers both the Claude-style tool names and the Ollama built-in kit
  // (read_file/list_dir/write_file/edit_file/grep/bash — see ollamaTools.ts)
  // used by the shipped templates' `build`/`tests` steps.
  // `bash`, `websearch` and `webfetch` are NOT here on purpose: bash reaches
  // curl/git push/ssh/aws with the user's on-disk credentials, and webfetch is
  // a bare SSRF primitive. An unattended worker must stop and ask first.
  const LOCAL_TOOLS = new Set([
    'read', 'grep', 'glob', 'ls', 'edit', 'write', 'notebookedit', 'todowrite', 'task',
    'read_file', 'list_dir', 'write_file', 'edit_file',
  ]);
  // Scoped read-only git is local: `Bash(git diff:*)` cannot mutate anything,
  // and forcing a pause on it made two shipped templates stall at step 1.
  const READONLY_BASH = /^bash\(\s*git\s+(?:diff|log|show|status|ls-files|rev-parse|branch)\b[^)]*\)$/;
  const isLocalTool = (t: string): boolean => {
    const name = t.toLowerCase().trim();
    return LOCAL_TOOLS.has(name.split('__')[0]) || READONLY_BASH.test(name);
  };
  const declared = step.tools ?? [];
  // Fail closed on an absent or empty declaration: a step that names nothing
  // is granted everything by the CLI, which is the opposite of "local".
  if (declared.length === 0) return 'external';
  return declared.some((t) => !isLocalTool(t)) ? 'external' : 'local';
}

export function pauseReasonBeforeStep(
  run: Pick<FlowRun, 'workerId' | 'allowExternalActions'>,
  step: Pick<FlowStep, 'id' | 'role' | 'systemPromptOverride' | 'tools' | 'output' | 'effect' | 'pauseBefore'>,
): 'externalAction' | 'preStep' | null {
  if (run.workerId && !run.allowExternalActions && resolveStepEffect(step) === 'external') {
    return 'externalAction';
  }
  return step.pauseBefore ? 'preStep' : null;
}

/// Does a worker candidate explicitly direct a write into its persistent
/// source project/workspace? Reading an absolute source path is fine — research
/// and report-update flows need that — but destinations must be relative to the
/// disposable run root. This catches the concrete escape shape (`named
/// /persistent/workspace/report.html`) without rejecting a plain `Read
/// /persistent/workspace/prior.html` input, or a prompt that names the path
/// only to exclude it (`write it to a relative path, never into /persistent/workspace`).
export function workerPromptWritesToPersistentRoot(prompt: string, sourceRoot: string): boolean {
  const normalizedPrompt = prompt.replace(/\\/g, '/').toLowerCase();
  const normalizedRoot = sourceRoot.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
  if (!normalizedRoot) return false;

  let from = 0;
  while (true) {
    const at = normalizedPrompt.indexOf(normalizedRoot, from);
    if (at < 0) return false;
    from = at + normalizedRoot.length;
    const after = normalizedPrompt[from] ?? '';
    // `/repo-old` is a sibling string, not a path inside `/repo`.
    if (after && after !== '/' && !/[\s'"`),.;:]/.test(after)) continue;

    const lineStart = Math.max(
      normalizedPrompt.lastIndexOf('\n', at),
      normalizedPrompt.lastIndexOf('.', at),
      normalizedPrompt.lastIndexOf(';', at),
    );
    const before = normalizedPrompt.slice(lineStart + 1, at).slice(-180);
    const writeVerb = '(?:write|save|append|edit|modify|delete|remove|overwrite|publish|export)';
    const negated = new RegExp(
      `\\b(?:do not|don't|never|must not)\\s+${writeVerb}\\b[^.!?\\n]{0,100}$`,
      'i',
    );
    if (negated.test(before)) continue;

    // The path is often quoted as a PROHIBITION — "write it to a relative path
    // (never into /persistent/workspace)". The write verb earlier in the same
    // sentence made that read as a destination and refused the launch. A
    // negative direction that runs right up to the path is an exclusion, not a
    // destination.
    const excluded = new RegExp(
      `\\b(?:never|not|avoid|rather than|instead of|outside(?:\\s+of)?|other than|excluding|except)\\s*` +
        `(?:${writeVerb}|writing|saving|creating|placing|putting|copying|moving|publishing)?\\s*` +
        `(?:back\\s+)?(?:into|inside|within|under|in|to|at)?\\s*[('"\`]*$`,
      'i',
    );
    if (excluded.test(before)) continue;

    const destination = new RegExp(
      `(?:` +
        `\\b${writeVerb}\\b[^.!?\\n]{0,100}` +
        `|\\b(?:copy|move)\\b[^.!?\\n]{0,100}\\b(?:to|into)\\s*` +
        `|\\bcreate\\b[^.!?\\n]{0,100}\\b(?:at|under|inside|into|named)\\s*` +
        `|\\bnamed\\s*` +
        `|\\boutput(?:\\s+(?:path|directory|file))?(?:\\s+is|\\s*:)?\\s*` +
        `)$`,
      'i',
    );
    if (destination.test(before)) return true;
  }
}

/// Runtime policy prepended to every step of an isolated worker-owned run.
/// Flow-authored prompts can be highly specific (and can themselves be custom
/// roles), so the boundary lives above them rather than relying on every flow
/// author to remember it.
export function buildWorkerRunBoundary(
  run: Pick<FlowRun, 'workerId' | 'projectPath' | 'sourceProjectPath'>,
): string {
  if (!run.workerId || !run.sourceProjectPath) return '';
  return [
    'WORKER RUN FILE BOUNDARY — RUNTIME POLICY (higher priority than flow instructions)',
    `Disposable run root (your cwd): ${run.projectPath}`,
    `Persistent source project/workspace (READ-ONLY): ${run.sourceProjectPath}`,
    '',
    'You may read the persistent source, but you must not create, edit, overwrite, move, or',
    'delete anything there. Any absolute output destination under that source is stale and',
    'must be translated to a path inside the disposable run root. Put loose reports directly',
    'in the disposable run root using a relative filename; Overcli files completed worker',
    "deliverables into the worker's private cabinet. Never publish back to the persistent",
    'workspace from this run.',
    '',
    '---',
    '',
  ].join('\n');
}

/// Runtime-wide decision protocol for every worker-owned flow step. The
/// participant is free to decide and mutate the local run root; if it truly
/// lacks a decision, it asks the standing Worker in a machine-readable form
/// instead of turning a question into a failed step.
export function buildWorkerSupervisionBoundary(run: Pick<FlowRun, 'workerId'>): string {
  if (!run.workerId) return '';
  return [
    'WORKER SUPERVISION — RUNTIME POLICY',
    'This run is owned by a standing Worker. Make ordinary implementation and editorial',
    'decisions autonomously. You are already authorized to read, edit local files, change',
    'local code, and run tests/builds inside the run cwd; do not ask permission for those.',
    'The runtime separately pauses before any external action (push, deploy, publish, send,',
    'or service update), so do not manufacture an extra approval checkpoint yourself.',
    '',
    'If you cannot proceed because a real decision or missing fact is not available in the',
    'inputs or repository, emit exactly one question and no output block:',
    '<worker_question>your concise question, including the choice you need</worker_question>',
    'The owning Worker will answer in this conversation and you will continue automatically.',
    '',
    '---',
    '',
  ].join('\n');
}

export function buildWorkerAnswerBlock(question: string, answer: string): string {
  return [
    'YOUR WORKER ANSWERED THE FLOW',
    `<question>${question}</question>`,
    `<worker_answer>${answer}</worker_answer>`,
    'Treat this as the owning Worker\'s decision. Continue the same step now; do not ask the',
    'same question again. Produce the required output when the task is complete.',
    '',
    '---',
    '',
  ].join('\n');
}

/// Re-exported so the runtime's own callers and tests keep one import site.
/// The rule itself lives in shared/flows/workerQuestion.ts because the
/// renderer's timeline matcher has to agree with it exactly — when the two
/// had separate copies they drifted, and multi-paragraph questions stopped
/// matching their answers.
export { extractWorkerQuestion };

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

/// What a `goto` retry needs to know about the failure that sent it back.
/// Built by `handleStepFailure` and consumed by the next `executeStep` of
/// the target step.
export interface FlowRetryFeedback {
  /// Step that failed (usually the reviewer that rejected the work).
  fromStepId: string;
  /// The failing step's output artifact name, when it produced one — e.g.
  /// `review.md`. Null when the step failed WITHOUT an artifact (missing
  /// <output> block, backend error).
  artifactName: string | null;
  /// The runtime's own one-line description of why the step failed.
  reason: string;
  /// 1-based retry number and the configured budget, so the target step
  /// knows how many shots it has left.
  attempt: number;
  maxRetries: number;
}

/// Render the "your owner corrected you mid-flight" preamble. Same shape as
/// `buildRetryFeedbackBlock`: a shouty header, a blank line, then substance.
/// Placed ahead of the step's inputs because those inputs were produced
/// BEFORE the correction and may contradict it.
export function buildSteerBlock(text: string, duringStepId?: string): string {
  const lines: string[] = [];
  lines.push('COURSE CORRECTION FROM YOUR OWNER — read this before your inputs.');
  lines.push('');
  lines.push(
    duringStepId
      ? `Received while step "${duringStepId}" was running. It supersedes anything in your inputs that conflicts with it.`
      : 'It supersedes anything in your inputs that conflicts with it.',
  );
  lines.push('');
  lines.push(`  ${text.trim()}`);
  lines.push('');
  lines.push(
    'Your inputs below were produced BEFORE this correction. Where they disagree with it, ' +
      'the correction wins — say so explicitly in your output rather than silently splitting the difference.',
  );
  return lines.join('\n');
}

/// Render the "you're being sent back, here's why" preamble prepended to a
/// `goto` target's prompt. Without this the retried step re-ran with only
/// its ORIGINAL inputs (e.g. `plan.md`) and no idea what the reviewer
/// objected to — so it would produce the same work and get rejected again
/// until the retry budget ran out. Kept pure so it can be unit-tested.
export function buildRetryFeedbackBlock(fb: FlowRetryFeedback): string {
  const lines: string[] = [];
  lines.push(
    `RETRY ${fb.attempt} of ${fb.maxRetries} — your previous attempt at this step was REJECTED.`,
  );
  lines.push('');
  lines.push(`Rejected by step "${fb.fromStepId}": ${fb.reason}`);
  if (fb.artifactName) {
    lines.push('');
    lines.push(
      `That step's full feedback is included below as input "${fb.artifactName}". ` +
        'Read it first — it is the authoritative list of what is wrong.',
    );
  }
  lines.push('');
  lines.push('How to handle this retry:');
  lines.push('  - Do NOT start over. The work already on disk is your starting point.');
  lines.push(
    "  - Repair the rejected attempt's own files in place. They are not protected prior deliverables; older successful files still are.",
  );
  lines.push(
    '  - Address EVERY concrete problem raised. If you disagree with one, fix the rest and say why in your output.',
  );
  lines.push(
    '  - Do not re-litigate or re-summarize the feedback; change the code, then emit your output block as usual.',
  );
  return lines.join('\n');
}

/// One-line gist of WHY a review rejected, for the failure message that
/// rides along with a `goto` retry (and shows in the step header). Prefers
/// an explicit verdict line ("Verdict: CHANGES REQUESTED"), falling back to
/// the first substantive line of the review. The full body is handed to the
/// retried step as an input regardless — this is just the headline.
export function summarizeReviewRejection(reviewBody: string): string | null {
  const lines = reviewBody.split('\n');
  const clean = (raw: string): string =>
    raw.replace(/^[\s>#*_-]+/, '').replace(/[*_`]+/g, '').trim();
  const cap = (line: string): string =>
    line.length > 200 ? `${line.slice(0, 200)}…` : line;
  for (const raw of lines) {
    const line = clean(raw);
    if (/^(?:verdict|decision|result|status|outcome)\s*[:\-–]/i.test(line)) return cap(line);
  }
  for (const raw of lines) {
    const line = clean(raw);
    if (line.length > 0) return cap(line);
  }
  return null;
}

/// Mark a one-line `displayText` as runtime-authored. Without it the turn
/// renders as a bubble on the user's side of the transcript, so housekeeping
/// the runtime did on its own reads as something the user typed — most
/// confusingly for the missing-output re-ask, which then looks like the user
/// interrupting their own flow to complain. Kept in sync with
/// FLOW_NOTE_MARKER in flowStepSections.ts.
export function flowNote(text: string): string {
  return `<!--flow-note-->${text}`;
}

/// The follow-up turn sent when a step's reply carried no `<output>` block
/// (see `reaskMissingOutput`). Deliberately short: it is read in a context
/// that already contains the full step contract, so restating the rules
/// competes with the deliverable for the model's attention. It names the two
/// recoverable cases explicitly — the artifact was written to a file, or it
/// was narrated in chat — because in both the model tends to answer "I
/// already did that" unless told the block itself is the missing part.
export function missingOutputReaskPrompt(
  outputName: string,
  allowFileRef = false,
  rejection?: { path: string; reason: PointerRejectionReason },
): string {
  // A refused pointer is a different conversation from a missing block: the
  // model already believes it complied, so repeating the generic instruction
  // gets the same pointer back. Name the file, name the reason, and take the
  // pointer form off the table for this turn.
  if (rejection) {
    return [
      `Your last reply pointed at "${rejection.path}" for <output name="${outputName}">, but the runtime could not accept that file: ${pointerRejectionExplanation(rejection.reason)}`,
      '',
      'Do not redo the work, and do not point at a file again this turn.',
      'Read the deliverable back and paste its full contents inline.',
      '',
      `Reply with ONLY this, and nothing else — no preamble, no commentary:`,
      `<output name="${outputName}">`,
      '... the complete deliverable ...',
      '</output>',
    ].join('\n');
  }
  const fileLines = [
    `  - If you wrote it to a file, read that file back and paste its full contents inside the block.`,
    ...(allowFileRef
      ? [
          `  - Or, if that file still holds the complete deliverable, point at it instead of retyping it:`,
          `    <output name="${outputName}" file="relative/path/to/the/file" />`,
        ]
      : []),
  ];
  return [
    `Your last reply did not contain an <output name="${outputName}"> block, so this step has nothing to hand to the next one.`,
    '',
    'Do not redo the work. Emit the deliverable you already produced:',
    ...fileLines,
    '  - If you described it in your reply, restate it in full inside the block.',
    '',
    `Reply with ONLY this, and nothing else — no preamble, no commentary:`,
    `<output name="${outputName}">`,
    '... the complete deliverable ...',
    '</output>',
  ].join('\n');
}

/// Plain-language version of a `PointerRejectionReason`, written for the
/// model that drew the pointer rather than for a log reader.
function pointerRejectionExplanation(reason: PointerRejectionReason): string {
  switch (reason) {
    case 'missing':
      return 'no readable file exists at that path inside this run\'s working directory';
    case 'stale':
      return 'nothing in this run wrote or changed that file, so it cannot be this step\'s deliverable';
    case 'oversized':
      return 'the file is too large to hand to the next step';
    case 'binary':
      return 'the file is not readable as UTF-8 text';
    case 'empty':
      return 'the file is empty';
  }
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

/// Hard cap on a filesystem-sourced artifact. Larger than the 256 KB
/// persistence cap in runsStore, so nothing realistic is refused; a file
/// past it falls back to the normal missing-output path rather than
/// pulling an unbounded blob into memory and into downstream prompts.
const MAX_OUTPUT_FILE_BYTES = 1024 * 1024;

/// Slack allowed between a step's start and its pointer file's mtime, to
/// absorb filesystem timestamp granularity. See `readArtifactFileBody`.
const MTIME_GRACE_MS = 1_000;

/// Pointer form of the output contract: `<output name="x" file="path" />`.
/// The model has already written the deliverable with its Write tool, so
/// re-typing it into the reply costs a full second decode of the artifact.
///
/// Returns the `file` attribute of the LAST matching tag, or null. Last, not
/// first, because the shape this has to survive is a model correcting itself
/// mid-reply ("…file=\"draft.md\" — sorry, I meant file=\"plan.md\""), and
/// taking the first match hands the run the stale draft. `extractOutput`
/// answers that same self-correction by concatenating every block it finds;
/// there is nothing to concatenate here, so the last claim wins instead.
export function extractOutputFileRef(text: string, outputName: string): string | null {
  const tagRe = /<output\s+([^>]*?)\/?>/gi;
  let m: RegExpExecArray | null;
  let last: string | null = null;
  while ((m = tagRe.exec(text)) !== null) {
    const attrs = m[1];
    const name = attrs.match(/\bname\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/i);
    const file = attrs.match(/\bfile\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/i);
    if (!name || !file) continue;
    const nameVal = (name[1] ?? name[2] ?? name[3] ?? '').trim();
    const fileVal = (file[1] ?? file[2] ?? file[3] ?? '').trim();
    if (nameVal.toLowerCase() !== outputName.toLowerCase()) continue;
    if (fileVal) last = fileVal;
  }
  return last;
}

/// Last-resort body extraction: an `<output>` block whose opening tag carries
/// EXTRA attributes (typically a `file=` pointer) around a real, typed body.
/// `extractOutput`'s regex requires the name attribute to be followed
/// immediately by `>`, so it cannot see these — which means a model that
/// emitted BOTH a broken pointer and the full deliverable would otherwise
/// have its deliverable thrown away. Only consulted after the pointer path
/// has failed; the strict form always wins when it matches.
export function extractOutputLooseBody(text: string, outputName: string): string | null {
  const escaped = outputName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const blockRe = new RegExp(
    `<output\\s+[^>]*\\bname\\s*=\\s*(?:"${escaped}"|'${escaped}'|${escaped})[^>]*>([\\s\\S]*?)</output\\s*>`,
    'gi',
  );
  const bodies: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = blockRe.exec(text)) !== null) bodies.push(m[1]);
  const noiseRe = /<\/?output(?:\s+[^>]*)?>/gi;
  const cleaned = bodies.map((b) => b.replace(noiseRe, '').trim()).filter(Boolean);
  if (cleaned.length === 0) return null;
  return cleaned.join('\n').trim();
}

/// Resolve a pointer path against the run root, refusing anything that
/// escapes it. Mirrors the boundary rule behind
/// `workerPromptWritesToPersistentRoot`: a run may only source artifacts
/// from its own disposable working directory. Absolute paths are allowed
/// only when they land inside that root.
export function resolveArtifactFilePath(rawPath: string, runRoot: string): string | null {
  const cleaned = rawPath.trim().replace(/^["'<]+/, '').replace(/["'>]+$/, '').trim();
  if (!cleaned || cleaned.includes('\0')) return null;
  if (!runRoot) return null;
  const root = resolve(runRoot);
  const abs = isAbsolute(cleaned) ? resolve(cleaned) : resolve(root, cleaned);
  if (abs !== root && !abs.startsWith(root + sep)) return null;
  return abs;
}

/// Read a pointer artifact's body. Returns null for anything that isn't a
/// readable, non-empty, in-budget, plausibly-textual regular file so the
/// caller can fall back to the inline contract.
///
/// `minMtimeMs` is the freshness floor — normally the start of the attempt
/// that emitted the pointer. It is what stops the pointer form from being a
/// way to pass off a file the step did NOT write: the inline contract could
/// only ever carry what the model actually produced, so without this check a
/// mistyped path (an input, a source file, a previous step's scratch) becomes
/// a plausible-looking artifact that nothing downstream can question. We only
/// accept a file the run itself created or updated — `resolveArtifactBody`
/// widens "the step" to "the run" for files git can show are the run's own
/// work, so a step that verified an already-correct file can still point at
/// it. Pass 0 to skip the check when no attempt timestamp is available.
export function readArtifactFileBody(absPath: string, minMtimeMs = 0): string | null {
  const read = readArtifactFile(absPath, minMtimeMs);
  return read.ok ? read.body : null;
}

/// Why a pointer file was refused. Carried into the reask prompt so the
/// follow-up turn can say what to do differently — a model told only "there
/// was no <output> block" re-sends the identical pointer and the step fails
/// on the same rejection twice.
export type PointerRejectionReason = 'missing' | 'stale' | 'oversized' | 'binary' | 'empty';

export type PointerRead =
  | { ok: true; body: string }
  | { ok: false; reason: PointerRejectionReason };

/// `readArtifactFileBody` with the refusal reason kept.
export function readArtifactFile(absPath: string, minMtimeMs = 0): PointerRead {
  let st: ReturnType<typeof statSync>;
  try {
    st = statSync(absPath);
  } catch {
    return { ok: false, reason: 'missing' };
  }
  try {
    if (!st.isFile()) return { ok: false, reason: 'missing' };
    if (st.size > MAX_OUTPUT_FILE_BYTES) return { ok: false, reason: 'oversized' };
    if (minMtimeMs > 0 && st.mtimeMs + MTIME_GRACE_MS < minMtimeMs) {
      return { ok: false, reason: 'stale' };
    }
    const raw = readFileSync(absPath, 'utf8');
    // Artifacts are text. A NUL byte means binary; U+FFFD means Node hit a
    // byte sequence that isn't valid UTF-8 and substituted the replacement
    // character. Either way the "artifact" would be mojibake, and every
    // downstream consumer (prompt injection, markdown render, diff parse)
    // treats it as prose. Refusing costs one reask; accepting corrupts the
    // rest of the run silently.
    if (raw.includes('\0') || raw.includes('�')) return { ok: false, reason: 'binary' };
    const body = raw.trim();
    return body.length > 0 ? { ok: true, body } : { ok: false, reason: 'empty' };
  } catch {
    return { ok: false, reason: 'missing' };
  }
}

/// Whether `abs` is part of what this run changed in `repoRoot` — uncommitted
/// (including untracked), or committed since `baselineCommit`.
///
/// This is the run-scoped version of the mtime floor. The property worth
/// defending is that a pointer can't hand the run a file the run did not
/// produce; the floor enforced the much stricter "written during THIS
/// attempt", which no re-run and no verify-only turn can satisfy — the file
/// is already correct, so nothing rewrites it and its mtime predates the
/// attempt forever. Git knows the difference between "the run wrote this"
/// and "this was already in the repo", which is the question actually being
/// asked.
export function pathChangedInRun(
  repoRoot: string,
  baselineCommit: string | undefined,
  abs: string,
  // Floor for the gitignored-file fallback below. `git status`/`git diff`
  // cannot see an ignored path at all, so unlike the tracked/untracked
  // branches above, there is no git signal that scopes an ignored file to
  // THIS run — every caller must pass the timestamp a file has to beat.
  // Required (not defaulted) so a new caller can't silently fall back to "any
  // ignored file that exists" the way the un-parameterized version did.
  runStartedAt: number,
): boolean {
  // `-uall` so an untracked file inside an untracked directory is listed by
  // name rather than collapsed into its parent.
  const status = runGit(['status', '--porcelain', '-uall', '--', abs], repoRoot);
  if (status.exitCode === 0 && status.stdout.trim() !== '') return true;
  // `git status` never lists an ignored file, so a run that legitimately wrote
  // to a gitignored path got a misleading "nothing wrote or changed that file".
  // `check-ignore` alone can't scope that to this run's own writes though —
  // it answers "is this path ignored", not "did this run produce it" — so a
  // pre-existing ignored file (`.env`, `node_modules/**`) would otherwise be
  // handed back as though the run had written it. Require its mtime to beat
  // the run's own floor, exactly like the tracked-file mtime check above it.
  const ignored = runGit(['check-ignore', '-q', '--', abs], repoRoot);
  if (ignored.exitCode === 0) {
    try {
      return statSync(abs).mtimeMs >= runStartedAt;
    } catch {
      return false;
    }
  }
  if (!baselineCommit) return false;
  const committed = runGit(['diff', '--name-only', baselineCommit, '--', abs], repoRoot);
  return committed.exitCode === 0 && committed.stdout.trim() !== '';
}

/// Which steps may be offered the pointer form: only ones that can write
/// files at all. Mirrors `resolvePermissionMode` — `step.tools` is an
/// authoritative allowlist for Ollama only; other backends' tool surface
/// is owned by their CLI.
export function stepCanWriteFiles(step: Pick<FlowStep, 'tools'>, backend: Backend): boolean {
  if (backend !== 'ollama') return true;
  const writeTools = new Set(['write_file', 'edit_file', 'bash']);
  return step.tools.some((t) => writeTools.has(t));
}

/// Whether this step's output contract should offer the pointer form at all.
/// Beyond "can it write files", `url` artifacts are excluded: a `pr_url` is
/// one line, so there is no duplicated decode to save, and sourcing it from a
/// file only adds a way for the run to record a URL nobody typed.
export function stepAllowsFileRef(
  step: Pick<FlowStep, 'tools' | 'output'>,
  backend: Backend,
): boolean {
  if (detectArtifactKind(step.output) === 'url') return false;
  return stepCanWriteFiles(step, backend);
}

/// Dispatch wrapper: single-repo runs get one `computeRunDiff`; workspace
/// runs walk each member's captured baseline and concatenate the diffs
/// with a `# <projectName>` header so the user can tell which repo each
/// chunk belongs to. Returns null when there's no baseline at all (e.g.
/// a non-git cwd) — callers should fall back to the model's `<output>`.
function computeRunDiffForRun(run: FlowRun): string | null {
  if (run.baselineCommitsByMember) {
    const blocks: string[] = [];
    let measuredMember = false;
    for (const [name, info] of Object.entries(run.baselineCommitsByMember)) {
      const d = computeRunDiff(info.path, info.commit);
      if (d === null) continue;
      measuredMember = true;
      if (!d) continue;
      // Prefix each member's diff with a banner comment so a multi-repo
      // diff is readable when reviewed as one blob. `# ` keeps unified-
      // diff parsers happy — they treat unprefixed text as context.
      blocks.push(`# ${name}\n${d}`);
    }
    // An empty successful measurement is a real live value: hijack chat may
    // have reverted the final change, and a re-run must clear the old diff
    // rather than retain it. Null is reserved for "could not measure".
    if (blocks.length === 0) return measuredMember ? '' : null;
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

/// Whether an Ollama participant's conversation must be replaced because it
/// belongs to a different step.
///
/// Cloud backends deliberately share ONE conversation per participant across a
/// run: the planner remembers its plan when it later reviews, and the
/// provider's prompt cache hits on the shared prefix. Locally neither applies,
/// and the sharing costs a great deal — the Ollama path replays the entire
/// prior transcript every round, so step N+1 opens with step N's instructions
/// still in context, including its `<output name="...">` contract. Observed
/// with gemma4:26b: a test step (output `test_report.md`) reading the build
/// step's prompt (output `diff`) reasoned itself to a standstill rather than
/// emit either. It was right — we had handed it two contradictory contracts.
/// Nothing is lost by starting clean: a step's inputs arrive as artifacts in
/// its own prompt.
///
/// Keys are `${participantId}:${stepId}`, so the same step retrying keeps its
/// conversation — a retry wants the failed attempt and the rejection feedback
/// in context, and its contract is unchanged.
export function ollamaConvNeedsReset(args: {
  backend: Backend;
  openedFor: string | undefined;
  wantedFor: string;
}): boolean {
  if (args.backend !== 'ollama') return false;
  if (args.openedFor === undefined) return false;
  return args.openedFor !== args.wantedFor;
}

/// Whether a step that produced no `<output>` block may still have its
/// artifact synthesized from the working tree.
///
/// An Ollama step that edits files with tools has already done the work by
/// the time it writes its closing message — the changes are on disk. Making
/// it ALSO hand-transcribe them inside `<output name="diff">` asks it to
/// restate in prose what the filesystem already records, and small local
/// models routinely finish their edits and simply stop. Failing there
/// discards minutes of correct work over a missing tag.
///
/// Restricted to Ollama on purpose. For the cloud backends a missing
/// `<output>` more often means the step derailed partway — leaving partial
/// edits behind — than that it forgot a tag, and promoting that to success
/// would bury a real failure. Local models have the opposite base rate, and
/// re-running one costs minutes rather than seconds.
///
/// Caller must still confirm the step actually changed something; see
/// `treeChanged`.
export function canSynthesizeDiffFromTree(args: {
  hasOutputBlock: boolean;
  kind: string;
  backend: Backend;
}): boolean {
  if (args.hasOutputBlock) return false;
  if (args.kind !== 'diff') return false;
  return args.backend === 'ollama';
}

/// True when a measured increment represents real work. A step that emitted
/// no `<output>` AND touched nothing has genuinely failed — there is no work
/// to rescue, and passing it on would hand the next step an empty diff.
export function treeChanged(incrementalDiff: string | null): boolean {
  return incrementalDiff !== null && incrementalDiff.trim().length > 0;
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

  const UNTRACKED_DIFF_MAX = 50;
  const newFileBlocks: string[] = [];
  for (const p of untrackedPaths.slice(0, UNTRACKED_DIFF_MAX)) {
    if (isNoisyPath(p)) continue;
    // Synthesized rather than spawned: one `git diff --no-index` per new file
    // cost up to 50 blocking subprocesses on the step-advance path.
    let text: string;
    try {
      const abs = join(cwd, p);
      const sizeBytes = statSync(abs).size;
      // A file skipped here used to just vanish from the diff with no trace —
      // the same silent-drop shape as the oversize-publish bug fixed
      // elsewhere in this release. Leave a marker instead of `continue`ing
      // straight past it, so a reviewer sees that something was left out.
      if (sizeBytes > 512 * 1024) {
        newFileBlocks.push(`\ndiff --git a/${p} b/${p}\nnew file: ${p} — not shown (${sizeBytes} bytes).\n`);
        continue;
      }
      text = readFileSync(abs, 'utf-8');
      if (text.includes('\0')) {
        newFileBlocks.push(`\ndiff --git a/${p} b/${p}\nnew file: ${p} — not shown (binary).\n`);
        continue;
      }
    } catch {
      continue;
    }
    const lines = text.split('\n');
    // A trailing '\n' splits into a final empty element — drop it. Its
    // absence means the file itself has no trailing newline, which the
    // marker below records the way a real `git diff` would.
    const noTrailingNewline = lines[lines.length - 1] !== '';
    if (!noTrailingNewline) lines.pop();
    if (lines.length === 0) {
      newFileBlocks.push(`\ndiff --git a/${p} b/${p}\nnew file: ${p} — empty file.\n`);
      continue;
    }
    const body = lines.map((l) => `+${l}`).join('\n') + (noTrailingNewline ? '\n\\ No newline at end of file\n' : '\n');
    newFileBlocks.push(
      `diff --git a/${p} b/${p}\nnew file mode 100644\n--- /dev/null\n+++ b/${p}\n@@ -0,0 +1,${lines.length} @@\n${body}`,
    );
  }
  if (untrackedPaths.length > UNTRACKED_DIFF_MAX) {
    newFileBlocks.push(`\n… ${untrackedPaths.length - UNTRACKED_DIFF_MAX} more untracked files not shown.\n`);
  }

  const combined = [tracked.stdout, ...newFileBlocks].filter(Boolean).join('');
  return filterNoiseFromDiff(combined).diff;
}

// Public alias used by main/index.ts — keeps a single import name whether
// callers want the type or the constructor.
export { FlowRuntimeImpl as FlowRuntime };
