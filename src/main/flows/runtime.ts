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
  MainToRendererEvent,
  PermissionMode,
  Project,
  UUID,
  Workspace,
} from '../../shared/types';
import { workspaceSymlinkNames } from '../../shared/workspaceNames';
import { preflightRun, formatPreflight, type PreflightResult } from './preflight';
import { filterNoiseFromDiff, isNoisyPath } from './diffFilter';
import { clearAttachments, writeAttachment } from './attachments';
import type {
  Flow,
  FlowArtifact,
  FlowRun,
  FlowStep,
  FlowStepAttempt,
} from '../../shared/flows/schema';
import { FLOW_USER_PROMPT_REF, resolveStepModel } from '../../shared/flows/schema';
import { ROLE_PROMPTS, resolveSystemPrompt } from '../../shared/flows/roles';
import type { RunnerManager } from '../runner';
import { loadAllFlows } from './storage';
import { createWorktree, detectBaseBranch, runGit } from '../git';
import { ensureCoordinatorSymlinkRoot } from '../workspace';
import { deleteRun as deleteRunFromDisk, loadAllRuns, saveRun } from './runsStore';

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
}

export interface FlowRuntimeResumeArgs {
  runId: UUID;
  editedArtifacts?: Record<string, string>;
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

  /// Launch-prompt attachments (images / files) per run, handed to the
  /// step(s) that read `user_prompt`. In-memory only — they're consumed by
  /// the first step at run start; not worth bloating the persisted run JSON
  /// with base64 image data.
  private pendingAttachments = new Map<UUID, Attachment[]>();

  /// Cap on the number of past runs we keep in memory. Once we exceed
  /// this, the oldest done/aborted runs are evicted. Running + paused
  /// runs are NEVER evicted regardless of count (they're load-bearing).
  /// Sized to be generous for a normal session — bump if it's not.
  private static readonly MAX_RETAINED_RUNS = 20;

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
    // Restore checkpointed runs from prior sessions. `loadAllRuns` already
    // demotes any state === 'running' entries to 'aborted' (their step
    // subprocesses are dead), so what comes back is either done, aborted,
    // or paused — the latter resumable via resumeRun.
    for (const run of loadAllRuns()) {
      this.runs.set(run.id, run);
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
            if (existing !== event.sessionId) {
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
      // Only react when the runtime itself is mid-step. running:false on a
      // user hijack turn should NOT finish the step — that would extract
      // an artifact from a chat reply.
      if (run.state.kind !== 'running') return;
      this.onStepFinished(runId, run.state.currentStepId);
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
        const minted: Array<{
          name: string;
          projectPath: string;
          worktreePath: string;
          branchName: string;
        }> = [];
        const wtNameBase = `flow-${flow.id}-${runId.slice(0, 8)}`;
        for (const p of members) {
          const r = createWorktree({
            projectPath: p.path,
            agentName: wtNameBase,
            baseBranch: sharedBase ?? detectBaseBranch(p.path),
            branchPrefix: settings.agentBranchPrefix || 'agent/',
          });
          if (!r.ok) {
            return {
              ok: false,
              error: `Failed to create worktree for ${p.name}: ${r.error}`,
            };
          }
          minted.push({
            name: p.name,
            projectPath: p.path,
            worktreePath: r.worktreePath,
            branchName: r.branchName,
          });
        }
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
        // Single-project worktree (original behavior).
        const wtName = `flow-${flow.id}-${runId.slice(0, 8)}`;
        const result = createWorktree({
          projectPath: args.projectPath,
          agentName: wtName,
          baseBranch: sharedBase ?? detectBaseBranch(args.projectPath),
          branchPrefix: settings.agentBranchPrefix || 'agent/',
        });
        if (!result.ok) {
          return { ok: false, error: `Failed to create worktree: ${result.error}` };
        }
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
    if (workspaceWorktrees) {
      const captured: Record<string, { path: string; commit: string }> = {};
      for (const m of workspaceWorktrees) {
        const res = runGit(['rev-parse', 'HEAD'], m.worktreePath);
        if (res.exitCode === 0) {
          const commit = res.stdout.trim();
          if (commit) captured[m.name] = { path: m.worktreePath, commit };
        }
      }
      if (Object.keys(captured).length > 0) baselineCommitsByMember = captured;
    } else if (matchingWorkspaceInPlace) {
      const projectsById = new Map(this.getProjects().map((p) => [p.id, p]));
      const members = matchingWorkspaceInPlace.projectIds
        .map((pid) => projectsById.get(pid))
        .filter((p): p is NonNullable<typeof p> => !!p && !!p.path)
        .map((p) => ({ name: p.name, path: p.path }));
      const named = workspaceSymlinkNames(members);
      const captured: Record<string, { path: string; commit: string }> = {};
      for (const { name, path: projPath } of named) {
        const res = runGit(['rev-parse', 'HEAD'], projPath);
        if (res.exitCode === 0) {
          const commit = res.stdout.trim();
          if (commit) captured[name] = { path: projPath, commit };
        }
      }
      if (Object.keys(captured).length > 0) baselineCommitsByMember = captured;
    } else {
      const baselineCommitRes = runGit(['rev-parse', 'HEAD'], cwd);
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
      .filter((r) => r.state.kind === 'done' || r.state.kind === 'aborted')
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
      model: participant.model,
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

  /// Permanently remove a run from memory + disk. Aborts it first if
  /// it's still active so any in-flight subprocess gets a chance to
  /// stop. Used by the library's "Delete run" affordance.
  deleteRun(args: { runId: UUID }): { ok: true } | { ok: false; error: string } {
    const run = this.runs.get(args.runId);
    if (!run) {
      // Idempotent: deleting an unknown run is a no-op success rather
      // than a hard error — the persisted file may still exist on disk
      // even if the in-memory map evicted it.
      deleteRunFromDisk(args.runId);
      clearAttachments(args.runId);
      return { ok: true };
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
  // Internals
  // ---------------------------------------------------------------------

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

    const stepModel = resolveStepModel(run.flowSnapshot, step);
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

    const stepModel = resolveStepModel(run.flowSnapshot, step);
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

  private emitRunUpdate(run: FlowRun): void {
    this.emit({ type: 'flowRunUpdate', run: structuredClone(run) });
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

/// Detect artifact kind from its name. Markdown by default; "diff" by name
/// → diff; "url" suffix → url. Everything else falls through to text.
export function detectArtifactKind(name: string): FlowArtifact['kind'] {
  const lower = name.toLowerCase();
  if (lower.endsWith('.md') || lower.endsWith('.markdown')) return 'markdown';
  if (lower === 'diff' || lower.endsWith('.diff') || lower.endsWith('.patch')) return 'diff';
  if (lower.endsWith('url') || lower.endsWith('_url')) return 'url';
  return 'text';
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
