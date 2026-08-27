// Orchestrator engine — the main-process half of the Orchestrator tab.
//
// Two responsibilities, cleanly split:
//   1. PRODUCE — `propose` runs one hidden AI turn (the user's preferred CLI,
//      with its own MCP tools) that investigates the user's ask and returns a
//      list of small, self-contained candidates. This is a normal one-shot,
//      NOT the flow step machine — so it can reach MCP servers today without
//      waiting on flow-level MCP enumeration.
//   2. DISPATCH — `startBatch` turns the user's mapped candidates into a
//      queue and `pump`s them into child FlowRuns, each in its own worktree,
//      never exceeding `maxConcurrent`. When a child run reaches a terminal
//      state the runtime calls `onRunUpdate`, which records the result and
//      pumps the next queued item.
//
// The orchestration record is the ledger (see shared/flows/orchestration.ts):
// it persists across restarts and remembers the producer turn so "why did I
// launch these" stays answerable.

import { randomUUID } from 'node:crypto';
import os from 'node:os';

import type {
  AppSettings,
  Attachment,
  Backend,
  MainToRendererEvent,
  Project,
  UUID,
} from '../../shared/types';
import type { FlowRun } from '../../shared/flows/schema';
import type {
  Candidate,
  Orchestration,
  OrchestrationItem,
  RunIn,
} from '../../shared/flows/orchestration';
import {
  isOrchestrationComplete,
  isResidueOrchestration,
  parseCandidates,
} from '../../shared/flows/orchestration';
import { SCHEDULE_AUTO_APPROVE_MAX } from '../../shared/flows/schedule';
import {
  pickDrafterBackend,
  resolveProducerModel,
} from '../../shared/flows/drafterBackend';
import { healthyBackends } from '../health';
import type { RunnerManager } from '../runner';
import {
  deleteOrchestration,
  loadAllOrchestrations,
  saveOrchestration,
} from './orchestrationsStore';

/// The slice of the flow runtime the orchestrator drives. Kept narrow (an
/// interface rather than the concrete class) so the two modules don't form
/// an import cycle and the engine stays unit-testable with a fake launcher.
export interface FlowLauncher {
  startRun(args: {
    flowId: string;
    projectPath: string;
    userPrompt: string;
    runIn?: 'cwd' | 'worktree';
    baseBranch?: string;
    parentOrchestrationId?: UUID;
    orchestrationItemTitle?: string;
    scheduleId?: UUID;
    scheduleName?: string;
    /// Chain provenance for a run fired by an `onFlowComplete` schedule. The
    /// scheduler is typed against THIS interface, not the runtime's wider
    /// arg bag, so both have to carry the fields.
    chainDepth?: number;
    chainParentRunId?: UUID;
    workerId?: UUID;
    workerName?: string;
    allowExternalActions?: boolean;
    title?: string;
  }): Promise<{ ok: true; runId: UUID } | { ok: false; error: string }>;
  abortRun(args: { runId: UUID }): { ok: true } | { ok: false; error: string };
  getRun(runId: UUID): FlowRun | null;
}

/// System prompt for the producer turn. Steers the model to triage rather
/// than solve, and — critically — to end with a machine-readable
/// `<candidates>` block the renderer parses. Mirrors the drafter's
/// "investigate then emit a strict contract" approach.
function producerSystemPrompt(): string {
  return [
    'You are the orchestrator producer for overcli. The user wants to turn a source of',
    'requests (product feedback, tickets, a backlog — often reachable through your MCP tools)',
    'into a list of SMALL, SELF-CONTAINED asks that can each be handled by a single autonomous',
    'flow run.',
    '',
    'Do the investigation the user asks for (use your available tools — list/search/read), then',
    'TRIAGE: keep only asks that are individually low-ambiguity and finishable in one focused',
    'change. Drop anything that is really an epic, needs a design decision, or spans many areas —',
    'mention in prose why you dropped the big ones, but do NOT put them in the list.',
    '',
    'Write a short, human plain-language summary of what you found FIRST. Then, on its own,',
    'emit EXACTLY ONE block in this shape (and nothing after it):',
    '',
    '<candidates>',
    '[',
    '  {',
    '    "id": "stable-id-or-ticket-key",',
    '    "title": "short headline of the ask",',
    '    "prompt": "a self-contained instruction a coding agent can act on with no other context",',
    '    "note": "one line: source / votes / why it is small",',
    '    "size": "small" | "medium"',
    '  }',
    '  // … one object per ask …',
    ']',
    '</candidates>',
    '',
    'Rules for the block:',
    '  - It MUST be valid JSON (double quotes, no trailing commas, no comments inside the real output).',
    '  - "prompt" is the ONLY thing the launched flow will see — make it stand on its own.',
    '  - Prefer 3–8 candidates. If nothing qualifies, emit an empty array: <candidates>[]</candidates>.',
    '  - Do not write anything after the closing </candidates> tag.',
  ].join('\n');
}

/// Fold prior context into the next producer prompt. The producer is a
/// one-shot with no persistent session, so the thread has to be replayed —
/// `priorTurns` carries as many exchanges as the caller wants remembered
/// (a worker's errand thread passes several, so "no, the other one" resolves
/// against the whole conversation rather than only the last thing said).
function buildProducerPrompt(args: {
  message: string;
  priorPrompt?: string;
  priorReply?: string;
  priorTurns?: Array<{ prompt: string; reply: string }>;
  /// Set when this turn RESUMES the session that produced the earlier
  /// exchanges. The model already holds the persona, the rules and the whole
  /// thread — re-sending them would be paying twice for context it never
  /// lost, and replaying turns it remembers reads as the user repeating
  /// themselves. Send the new message and nothing else.
  warmResume?: boolean;
}): string {
  if (args.warmResume) return args.message;
  const parts = [producerSystemPrompt(), '', '---', ''];
  const turns =
    args.priorTurns && args.priorTurns.length > 0
      ? args.priorTurns
      : args.priorPrompt && args.priorReply
        ? [{ prompt: args.priorPrompt, reply: args.priorReply }]
        : [];
  if (turns.length > 0) {
    parts.push(
      turns.length > 1
        ? 'CONTEXT — this is a continuing conversation. Earlier, oldest first:'
        : 'CONTEXT — this is a refinement. Earlier in this session:',
      '',
    );
    for (const turn of turns) {
      parts.push(`User asked: ${turn.prompt}`, '', 'You replied:', turn.reply, '');
    }
    parts.push(
      '---',
      '',
      `Now the user refines their ask. Re-emit the FULL updated <candidates> block reflecting`,
      'the refinement (not just the delta).',
      '',
    );
  }
  parts.push('USER REQUEST:', args.message);
  return parts.join('\n');
}

export class OrchestratorImpl {
  private batches = new Map<UUID, Orchestration>();
  /// childRunId → orchestrationId, so `onRunUpdate` can route a terminal
  /// run back to its batch in O(1).
  private runToBatch = new Map<UUID, UUID>();

  constructor(
    private runner: RunnerManager,
    private launcher: FlowLauncher,
    private emit: (event: MainToRendererEvent) => void,
    private getProjects: () => Project[],
    private getSettings: () => AppSettings,
  ) {
    // Restore persisted batches as a read-only ledger. loadAll already
    // demoted any `running` item to `failed` (its child subprocess died on
    // exit) and any `queued` item to `cancelled` (we do NOT auto-launch new
    // runs on restart — see orchestrationsStore.loadAllOrchestrations), so
    // what comes back has nothing left to pump.
    for (const o of loadAllOrchestrations()) {
      // Residue from earlier builds, which persisted every item-less batch:
      // nothing shows it, nothing can clear it, so boot is the moment to be
      // rid of it. Worker batches are never residue — see
      // isResidueOrchestration.
      if (isResidueOrchestration(o)) {
        deleteOrchestration(o.id);
        continue;
      }
      this.batches.set(o.id, o);
      for (const item of o.items) {
        // Map items whose child run can still finish. Only `paused` runs are
        // resumable — the runtime checkpoints them, so the user can continue
        // one in the Flows tab and its terminal update must route back here.
        if (item.runId && item.status === 'paused') {
          this.runToBatch.set(item.runId, o.id);
        }
      }
    }
  }

  // ---- PRODUCE ----------------------------------------------------------

  async propose(args: {
    message: string;
    projectPath: string;
    priorPrompt?: string;
    priorReply?: string;
    /// The whole thread so far, oldest first, when the caller keeps one.
    priorTurns?: Array<{ prompt: string; reply: string }>;
    /// Files the user attached to the ask.
    attachments?: Attachment[];
    /// Override the producer's model (a worker's cheap heartbeat model).
    /// Paired with `backend` below when the caller knows it; on its own it is
    /// translated to the chosen backend's equivalent tier rather than trusted
    /// blindly — see `resolveProducerModel`.
    model?: string;
    /// The backend `model` was chosen for. Preferred over the user's default
    /// when it's healthy and enabled, so a worker pinned to Codex keeps
    /// planning on Codex after the user switches their default to Claude.
    /// Falls back to the usual health pick when it isn't usable, and the
    /// model is translated to match whatever backend wins.
    backend?: Backend;
    /// Attribute this turn's streamed progress to a worker's shift. The
    /// renderer routes attributed progress to the Workers pane instead of
    /// the Orchestrator's Ask pane.
    progressWorkerId?: UUID;
    /// Load only these MCP servers for the producer turn (see
    /// `RunnerManager.oneShot`). Undefined inherits the user's whole config.
    mcpAllowlist?: string[];
    /// Run the turn as part of a caller-owned conversation rather than a
    /// throwaway one, resuming `resumeSessionId` when it is set. The worker
    /// desk uses this to hold one thread per day instead of re-establishing
    /// the worker from scratch on every message.
    conversationId?: UUID;
    resumeSessionId?: string;
  }): Promise<
    | { ok: true; reply: string; candidates: Candidate[]; sessionId?: string }
    | { ok: false; error: string }
  > {
    const message = args.message.trim();
    if (!message) return { ok: false, error: 'Message is empty.' };

    const settings = this.getSettings();
    // Resolved up front — probing runs a CLI, so it's async (see health.ts)
    // and can't happen inside a sync predicate.
    const healthy = await healthyBackends(settings.backendPaths);
    const backend = pickDrafterBackend({
      preferred: args.backend ?? settings.preferredBackend,
      isHealthy: (b: Backend) => healthy.has(b),
      isEnabled: (b: Backend) => settings.disabledBackends[b] !== true,
    });
    if (!backend) {
      return {
        ok: false,
        error:
          'No CLI is signed in to investigate with. Set up Claude, Codex, Gemini, or Copilot in Settings first.',
      };
    }
    // Never trust a pinned model against a backend it may not belong to: the
    // pin and the backend are resolved from different places and can drift
    // apart (a worker hired under one default provider, run under another).
    const model = resolveProducerModel(backend, args.model, settings.flowModelDefaults);
    // Run in the project so MCP servers scoped to that repo (and the model's
    // own file tools) resolve; fall back to home if no project path given.
    const cwd = args.projectPath?.trim() || os.homedir();
    const prompt = buildProducerPrompt({ ...args, warmResume: !!args.resumeSessionId });

    // Producer turns can be slow (tool round-trips against a remote source),
    // so give them a longer leash than the default one-shot timeout. They
    // also MUST call tools (MCP servers, search, read) unattended, so the
    // turn runs with permissions bypassed — the system prompt constrains it
    // to investigate-and-report, never to edit. We stream progress (running
    // text + tools invoked) so the UI can show the investigation live rather
    // than a blank spinner; throttled so a chatty turn can't flood IPC.
    let lastEmit = 0;
    let lastToolCount = -1;
    const result = await this.runner.oneShot({
      backend,
      model,
      prompt,
      attachments: args.attachments,
      cwd,
      mcpAllowlist: args.mcpAllowlist,
      conversationId: args.conversationId,
      resumeSessionId: args.resumeSessionId,
      // A producer that searches two issue trackers and diffs three repos is
      // doing dozens of MCP round-trips; a flat 5-minute wall clock killed
      // healthy runs mid-investigation. Budget on SILENCE instead (the same
      // shape as the flow runtime's step watchdog) with a generous absolute
      // ceiling behind it, so a turn that keeps working keeps going and only
      // a genuinely stalled one — or a runaway — gets cut.
      timeoutMs: 30 * 60_000,
      idleTimeoutMs: 5 * 60_000,
      permissionMode: 'bypassPermissions',
      onProgress: (snap) => {
        const now = Date.now();
        // Always emit when a new tool fires (the high-signal moment);
        // otherwise coalesce text updates to ~5/sec.
        if (snap.tools.length === lastToolCount && now - lastEmit < 200) return;
        lastEmit = now;
        lastToolCount = snap.tools.length;
        // Strip the candidates block from the live view — it's noise until
        // parsed into rows.
        const text = snap.text.replace(/<candidates>[\s\S]*$/i, '').trim();
        this.emit({
          type: 'orchestrationProducerProgress',
          text,
          tools: snap.tools,
          workerId: args.progressWorkerId,
        });
      },
    });
    if (!result.ok) return { ok: false, error: result.error };

    const candidates = parseCandidates(result.text);
    return { ok: true, reply: result.text, candidates, sessionId: result.sessionId };
  }

  // ---- DISPATCH ---------------------------------------------------------

  async startBatch(args: {
    title: string;
    projectPath: string;
    runIn?: RunIn;
    baseBranch?: string;
    maxConcurrent: number;
    producer?: { prompt: string; reply: string };
    /// Provenance, when something other than the user pressed Launch. A worker
    /// running the flow it just drafted passes its own origin here so the
    /// batch journals and scores through `syncOrchestration` exactly like a
    /// shift — work that skipped that fold would be invisible to the worker's
    /// performance review.
    origin?: Orchestration['origin'];
    items: Array<{ candidate: Candidate; flowId: string; baseBranch?: string }>;
  }): Promise<{ ok: true; orchestrationId: UUID } | { ok: false; error: string }> {
    const projectPath = args.projectPath?.trim();
    if (!projectPath) return { ok: false, error: 'No project selected for the batch.' };
    const items = args.items.filter((i) => i.candidate && i.flowId);
    if (items.length === 0) return { ok: false, error: 'No items to launch.' };

    const runIn: RunIn = args.runIn === 'cwd' ? 'cwd' : 'worktree';
    // A cwd batch shares one working tree across every item, so two items in
    // flight would edit the same files underneath each other. Serialize it —
    // the queue still drains, just strictly one at a time. (The UI pins the
    // stepper to 1 in cwd mode; this is the load-bearing enforcement.)
    const cap =
      runIn === 'cwd' ? 1 : Math.max(1, Math.min(8, Math.floor(args.maxConcurrent) || 1));
    // Nothing forks from a base branch in cwd mode — the run just uses
    // whatever the tree has checked out. Drop it rather than record a value
    // the launch will ignore.
    const baseBranch = runIn === 'cwd' ? undefined : args.baseBranch?.trim() || undefined;
    const orchestration: Orchestration = {
      id: randomUUID(),
      title: args.title?.trim() || 'Batch',
      projectPath,
      runIn,
      baseBranch,
      maxConcurrent: cap,
      producer: args.producer,
      origin: args.origin,
      createdAt: Date.now(),
      items: items.map<OrchestrationItem>((i) => ({
        candidate: i.candidate,
        flowId: i.flowId,
        baseBranch:
          runIn === 'cwd' ? undefined : i.baseBranch?.trim() || baseBranch,
        status: 'queued',
      })),
    };
    this.batches.set(orchestration.id, orchestration);
    this.persistAndEmit(orchestration);
    await this.pump(orchestration.id);
    return { ok: true, orchestrationId: orchestration.id };
  }

  // ---- PARK (scheduled proposals) ---------------------------------------

  /// Run the producer turn and record what it found as a batch. By default
  /// nothing launches — every item lands `proposed`.
  ///
  /// This is the only entry point a schedule gets. `startBatch` dispatches
  /// immediately, which is fine when a human just clicked Launch and is
  /// looking at the candidate list; it is not fine at 8am with nobody there,
  /// because the producer decides how many items exist and a bad pull would
  /// fork a dozen worktrees unsupervised. Parking keeps the expensive half of
  /// the decision with the user while still doing the slow half (the
  /// investigation) on their behalf.
  ///
  /// `autoApprove` hands the cheap half back too, for schedules whose producer
  /// the user has learned to trust — but through the cap, not around it. The
  /// first `maxItems` candidates queue and pump; everything past the cap stays
  /// `proposed`, so an unexpectedly large morning degrades into a normal
  /// parked batch instead of a dozen unsupervised worktrees.
  async parkProposal(args: {
    scheduleId?: UUID;
    scheduleName?: string;
    /// Explicit provenance. When absent, built from scheduleId/scheduleName —
    /// the worker engine passes its own `{ kind: 'worker', … }` here.
    origin?: Orchestration['origin'];
    projectPath: string;
    prompt: string;
    flowId: string;
    runIn: RunIn;
    baseBranch?: string;
    maxConcurrent: number;
    /// Title for the batch, already carrying its `[SR-n]` sequence so two
    /// mornings' worth of the same schedule are tellable apart in the ledger.
    title?: string;
    /// Set to dispatch without waiting for approval, up to `maxItems`.
    autoApprove?: { maxItems: number };
    /// Producer model override (a worker's heartbeat model).
    model?: string;
    /// Hard cap on recorded items per firing (a worker's items-per-shift
    /// cap). Distinct from `autoApprove.maxItems`, which bounds only the
    /// auto-launched prefix — this bounds the whole batch.
    maxItems?: number;
    /// When set, a candidate's `suggestedFlowId` is honored only if it's in
    /// this list; anything else falls back to `flowId`. A worker's planner
    /// may route items among the flows on its contract, never to an
    /// arbitrary flow it hallucinated — under autoApprove that would be an
    /// unattended launch into machinery nobody vetted for this worker.
    allowedFlowIds?: string[];
    /// Prior turn of the same thread, when this park is a follow-up. Handed
    /// to the producer so "no, the other spec" resolves against what was just
    /// said instead of starting cold.
    priorPrompt?: string;
    priorReply?: string;
    /// The whole thread so far, oldest first, when the caller keeps one.
    priorTurns?: Array<{ prompt: string; reply: string }>;
    /// Files the user attached to the ask.
    attachments?: Attachment[];
    /// Candidate titles to drop, case-insensitively — a worker's journaled
    /// rejections. The producer prompt asks the model not to re-propose them,
    /// but this filter is the guarantee: a rejected idea cannot come back
    /// even when the model ignores the instruction.
    excludeTitles?: string[];
    /// See `propose`. A worker carries its own MCP allowlist and, at the
    /// desk, its own conversation.
    mcpAllowlist?: string[];
    conversationId?: UUID;
    resumeSessionId?: string;
  }): Promise<
    | {
        ok: true;
        orchestrationId: UUID;
        count: number;
        queued: number;
        excluded: number;
        sessionId?: string;
      }
    | { ok: false; error: string }
  > {
    const projectPath = args.projectPath?.trim();
    if (!projectPath) return { ok: false, error: 'Schedule has no project.' };

    const produced = await this.propose({
      message: args.prompt,
      projectPath,
      model: args.model,
      priorPrompt: args.priorPrompt,
      priorReply: args.priorReply,
      priorTurns: args.priorTurns,
      attachments: args.attachments,
      mcpAllowlist: args.mcpAllowlist,
      conversationId: args.conversationId,
      resumeSessionId: args.resumeSessionId,
      progressWorkerId: args.origin?.kind === 'worker' ? args.origin.workerId : undefined,
    });
    if (!produced.ok) return { ok: false, error: produced.error };

    const excluded = new Set(
      (args.excludeTitles ?? []).map((t) => t.trim().toLowerCase()).filter(Boolean),
    );
    let kept = excluded.size
      ? produced.candidates.filter((c) => !excluded.has(c.title.trim().toLowerCase()))
      : produced.candidates;
    // Counted BEFORE the maxItems trim: `excluded` is reported to the user
    // as "dropped as previously rejected", and the cap trim is not that.
    const excludedCount = produced.candidates.length - kept.length;
    // Hard bound on how many items one firing may record at all (a worker's
    // items-per-shift cap). Producer order is best-first, so take the prefix.
    if (args.maxItems !== undefined) {
      kept = kept.slice(0, Math.max(0, Math.floor(args.maxItems)));
    }

    // Clamped here as well as validated at save time: a schedule persisted by
    // an older build, or hand-edited on disk, must not be able to talk this
    // engine into an unbounded unattended dispatch.
    const autoCap = args.autoApprove
      ? Math.max(0, Math.min(SCHEDULE_AUTO_APPROVE_MAX, Math.floor(args.autoApprove.maxItems) || 0))
      : 0;
    const runIn: RunIn = args.runIn === 'cwd' ? 'cwd' : 'worktree';
    const baseBranch = runIn === 'cwd' ? undefined : args.baseBranch?.trim() || undefined;
    const origin: Orchestration['origin'] =
      args.origin ??
      (args.scheduleId && args.scheduleName
        ? { kind: 'schedule', scheduleId: args.scheduleId, scheduleName: args.scheduleName }
        : undefined);
    const orchestration: Orchestration = {
      id: randomUUID(),
      title: args.title?.trim() || args.scheduleName || 'Batch',
      projectPath,
      runIn,
      baseBranch,
      maxConcurrent:
        runIn === 'cwd' ? 1 : Math.max(1, Math.min(8, Math.floor(args.maxConcurrent) || 1)),
      producer: { prompt: args.prompt, reply: produced.reply },
      origin,
      createdAt: Date.now(),
      items: kept.map<OrchestrationItem>((candidate, index) => ({
        candidate,
        // The producer may name a flow per candidate; the caller's flow is
        // the fallback, since there was nobody around to pick one. With
        // `allowedFlowIds` set, an off-list suggestion falls back too.
        flowId: resolveItemFlowId(candidate.suggestedFlowId, args.flowId, args.allowedFlowIds),
        baseBranch: runIn === 'cwd' ? undefined : baseBranch,
        // Producer order is the only ranking available at 8am — it triages
        // best-first by construction — so the cap takes a prefix of it.
        status: index < autoCap ? 'queued' : 'proposed',
        note:
          autoCap > 0 && index >= autoCap
            ? `Held back — over the ${autoCap}-item auto-launch cap.`
            : undefined,
      })),
    };
    // A producer that proposed nothing has produced no batch worth keeping,
    // unless a worker asked — then the empty record is that worker's desk turn
    // and carries its prose answer (see isResidueOrchestration). Skipping the
    // record here is what stops a schedule that fires all day from filling the
    // ledger with rows the user can neither read nor clear. The caller still
    // gets an id and an honest `count: 0`; it just won't resolve through
    // `get`, which is already null-tolerant.
    const residue = isResidueOrchestration(orchestration);
    if (!residue) {
      this.batches.set(orchestration.id, orchestration);
      this.persistAndEmit(orchestration);
    }
    const queued = orchestration.items.filter((i) => i.status === 'queued').length;
    // Without `autoApprove` there is deliberately no `pump` — that's what
    // approval is for. With it, the queued prefix goes now and the parked
    // remainder still waits for a human.
    if (queued > 0) await this.pump(orchestration.id);
    return {
      ok: true,
      orchestrationId: orchestration.id,
      count: orchestration.items.length,
      queued,
      excluded: excludedCount,
      sessionId: produced.sessionId,
    };
  }

  /// Release a parked batch. Items named in `approve` are queued (with an
  /// optional flow remap); every other `proposed` item is cancelled, because
  /// the user reviewed the list and left them out on purpose. Omit `approve`
  /// to take the whole batch as proposed.
  async approveBatch(args: {
    id: UUID;
    approve?: Array<{ candidateId: string; flowId?: string; baseBranch?: string }>;
  }): Promise<{ ok: true; queued: number } | { ok: false; error: string }> {
    const o = this.batches.get(args.id);
    if (!o) return { ok: false, error: `Batch ${args.id} not found.` };
    const proposed = o.items.filter((i) => i.status === 'proposed');
    if (proposed.length === 0) return { ok: false, error: 'Nothing is waiting for approval.' };

    type Pick = { candidateId?: string; flowId?: string; baseBranch?: string };
    const picks: Map<string, Pick> | null = args.approve
      ? new Map(args.approve.map((a) => [a.candidateId, a as Pick]))
      : null;
    let queued = 0;
    for (const item of proposed) {
      // No `approve` list at all means "take it as proposed" — every item gets
      // an empty override rather than being read as unpicked.
      const pick: Pick | undefined = picks ? picks.get(item.candidate.id) : {};
      if (!pick) {
        item.status = 'cancelled';
        item.note = 'Not approved.';
        item.finishedAt = Date.now();
        continue;
      }
      if (pick.flowId?.trim()) item.flowId = pick.flowId.trim();
      if (o.runIn !== 'cwd' && pick.baseBranch?.trim()) item.baseBranch = pick.baseBranch.trim();
      item.status = 'queued';
      queued++;
    }
    this.persistAndEmit(o);
    if (queued === 0) {
      // Everything was declined — the batch is settled, not launched.
      this.maybeComplete(o);
      return { ok: true, queued: 0 };
    }
    await this.pump(o.id);
    return { ok: true, queued };
  }

  /// Reject one PAUSED item — the per-item form of the decline approveBatch
  /// applies to unpicked proposals. A paused run is a proposal that got
  /// further before the user saw it, and turning it down should count the
  /// same way: settling the item to `cancelled` is what journals the
  /// rejection on a worker-origin batch and feeds the demotion streak.
  ///
  /// The child run itself is the CALLER's to delete, before calling this —
  /// the renderer routes deletion through the dirty-worktree confirm, and a
  /// decline at that prompt must leave the item exactly as it was.
  rejectItem(args: { id: UUID; candidateId: string }): { ok: true } | { ok: false; error: string } {
    const o = this.batches.get(args.id);
    if (!o) return { ok: false, error: `Batch ${args.id} not found.` };
    const item = o.items.find((i) => i.candidate.id === args.candidateId);
    if (!item) return { ok: false, error: `Item ${args.candidateId} not found in batch.` };
    if (item.status !== 'paused') {
      return { ok: false, error: 'Only paused work can be rejected here.' };
    }
    // The run is already deleted (or was never told about this batch's
    // interest) — drop the link so a stale terminal event can't resurrect
    // the item after it settles.
    if (item.runId) this.runToBatch.delete(item.runId);
    item.status = 'cancelled';
    item.note = 'Rejected.';
    item.finishedAt = Date.now();
    this.persistAndEmit(o);
    this.maybeComplete(o);
    return { ok: true };
  }

  /// Fill open concurrency slots with queued items. Each launch mints a
  /// child FlowRun — in its own worktree, or in the project's working tree
  /// for a `runIn: 'cwd'` batch (which is capped at one slot, so those items
  /// land one at a time). The run links back via `parentOrchestrationId` so
  /// `onRunUpdate` can pump the next item when it finishes. Safe to call
  /// repeatedly — it's a no-op once the cap is reached or the queue is empty.
  private async pump(orchestrationId: UUID): Promise<void> {
    const o = this.batches.get(orchestrationId);
    if (!o) return;
    let launchedAny = false;
    // Loop because a slot may free up (a synchronous startRun failure)
    // while we're still filling — re-evaluate until no queued item can go.
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const running = o.items.filter((i) => i.status === 'running').length;
      if (running >= o.maxConcurrent) break;
      const next = o.items.find((i) => i.status === 'queued');
      if (!next) break;
      // Optimistically mark running so we don't double-launch it on the
      // next loop iteration before startRun resolves.
      next.status = 'running';
      next.startedAt = Date.now();
      launchedAny = true;
      let res: Awaited<ReturnType<FlowLauncher['startRun']>>;
      try {
        // Batches persisted before `runIn` existed have it undefined — they
        // were all worktree batches, so that's the default.
        const runIn: RunIn = o.runIn ?? 'worktree';
        res = await this.launcher.startRun({
          flowId: next.flowId,
          projectPath: o.projectPath,
          userPrompt: next.candidate.prompt,
          runIn,
          baseBranch: runIn === 'cwd' ? undefined : (next.baseBranch ?? o.baseBranch),
          parentOrchestrationId: o.id,
          orchestrationItemTitle: next.candidate.title,
          // Stamp the worker on child runs of a worker's batch — the run
          // summary's `workerId` is what the monthly budget rollup groups by,
          // and nothing can reconstruct the tag after launch.
          ...(o.origin?.kind === 'worker'
            ? {
                workerId: o.origin.workerId,
                workerName: o.origin.workerName,
                allowExternalActions: o.origin.allowExternalActions,
              }
            : {}),
        });
      } catch (err) {
        // startRun should return {ok:false}, but guard against an unexpected
        // throw so a single bad launch can't wedge the item at `running`.
        res = { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
      if (res.ok) {
        next.runId = res.runId;
        this.runToBatch.set(res.runId, o.id);
        // Close a race: if the child run already reached a terminal state
        // synchronously (e.g. an immediate abort inside executeStep) before
        // we recorded its runId, its terminal update would have found no
        // matching item and been dropped. Re-check now that runId is set.
        const cur = this.launcher.getRun(res.runId);
        if (cur && (cur.state.kind === 'done' || cur.state.kind === 'aborted')) {
          this.onRunUpdate(cur);
        }
      } else {
        // Launch failed (preflight, worktree collision, etc.) — mark the
        // item failed and keep going so one bad item can't stall the batch.
        next.status = 'failed';
        next.note = res.error;
        next.finishedAt = Date.now();
      }
    }
    if (launchedAny) this.persistAndEmit(o);
    this.maybeComplete(o);
  }

  /// Called by the runtime (via the registered observer) on EVERY run
  /// update. We react to a batch child run's transitions: pausing (free the
  /// slot, pump the next item — a human checkpoint shouldn't stall the batch),
  /// resuming, and finishing.
  onRunUpdate(run: FlowRun): void {
    const orchId = run.parentOrchestrationId ?? this.runToBatch.get(run.id);
    if (!orchId) return;
    const o = this.batches.get(orchId);
    if (!o) return;
    const item = o.items.find((i) => i.runId === run.id);
    if (!item) return;

    const kind = run.state.kind;

    // Paused: the flow hit a `pause_before` step and is waiting for the user
    // to continue it in the Flows tab. It's no longer doing work, so park it
    // and free its concurrency slot — pump the next queued item so the batch
    // keeps flowing while the human checkpoint is outstanding.
    if (kind === 'paused') {
      if (item.status === 'paused') return; // already parked — idempotent
      item.status = 'paused';
      item.branchName = run.branchName ?? item.branchName;
      // Drop the slot-occupying mapping is NOT needed (we keep runToBatch so
      // the eventual resume→finish still routes here); we just stop counting
      // it as running via the status.
      this.persistAndEmit(o);
      void this.pump(orchId);
      return;
    }

    // Resumed: a parked item went back to work (the user clicked Continue).
    // Flip it back to running for display. Note this can transiently exceed
    // the cap — acceptable, since the slot was reallocated while it was
    // parked and we honor the user's resume.
    if (kind === 'running') {
      if (item.status === 'paused') {
        item.status = 'running';
        this.persistAndEmit(o);
      }
      return;
    }

    // Terminal. Reachable from either `running` or `paused` (a paused run can
    // be aborted while parked). Ignore if the item is already terminal.
    if (kind === 'done' || kind === 'aborted') {
      if (item.status !== 'running' && item.status !== 'paused') return;
      item.status = kind === 'done' ? 'done' : 'failed';
      item.finishedAt = Date.now();
      item.branchName = run.branchName ?? item.branchName;
      if (kind === 'aborted' && !item.note) item.note = 'Run aborted.';
      this.runToBatch.delete(run.id);
      this.persistAndEmit(o);
      // A slot freed up (if it was running) — fill it.
      void this.pump(orchId);
    }
  }

  abort(args: { id: UUID }): { ok: true } | { ok: false; error: string } {
    const o = this.batches.get(args.id);
    if (!o) return { ok: false, error: `Batch ${args.id} not found.` };
    // Cancel queued items FIRST, before aborting any running one. Aborting a
    // running child run emits its terminal update synchronously, which calls
    // onRunUpdate → pump — and pump would happily launch a still-queued item
    // mid-abort. Draining the queue up front means there's nothing left for
    // that pump to start.
    for (const item of o.items) {
      // `queued` never launched, and neither did `proposed` (aborting a
      // parked batch is how the user says "not this morning's list"); a
      // `paused` item with no run (shouldn't happen, but be defensive) has
      // nothing to kill — settle all three straight to cancelled so they
      // can't hold the batch open.
      if (
        item.status === 'queued' ||
        item.status === 'proposed' ||
        (item.status === 'paused' && !item.runId)
      ) {
        item.status = 'cancelled';
        item.finishedAt = Date.now();
      }
    }
    for (const item of o.items) {
      // Kill anything tied to a live or checkpointed child run: `running`
      // items hold a concurrency slot, `paused` ones are parked at a
      // `pause_before` step waiting for the user. Neither is terminal, so if
      // abort skips them the batch never completes — leaving the ledger stuck
      // on "Abort batch" with no "Clear" and abort appearing to do nothing.
      if ((item.status === 'running' || item.status === 'paused') && item.runId) {
        const runId = item.runId;
        this.runToBatch.delete(runId);
        // running was in flight → failed; paused never produced a result and
        // the user chose to abort → cancelled.
        item.status = item.status === 'running' ? 'failed' : 'cancelled';
        item.note = item.note ?? 'Batch aborted.';
        item.finishedAt = Date.now();
        try {
          // The run's own abort path may emit a terminal update that
          // re-enters onRunUpdate — harmless now: the item is already
          // terminal so onRunUpdate's `status !== 'running'` guard no-ops.
          this.launcher.abortRun({ runId });
        } catch {
          // best-effort
        }
      }
    }
    this.persistAndEmit(o);
    this.maybeComplete(o);
    return { ok: true };
  }

  /// Re-queue failed/cancelled items so they launch again as fresh runs (in a
  /// fresh worktree, or back in the project's tree for a cwd batch — `pump`
  /// re-reads the batch's `runIn`). With `candidateId`, retry just that one;
  /// without, retry every failed/cancelled item. Reactivates a completed batch.
  retry(args: { id: UUID; candidateId?: string }): { ok: true } | { ok: false; error: string } {
    const o = this.batches.get(args.id);
    if (!o) return { ok: false, error: `Batch ${args.id} not found.` };
    const targets = o.items.filter(
      (i) =>
        (i.status === 'failed' || i.status === 'cancelled') &&
        (!args.candidateId || i.candidate.id === args.candidateId),
    );
    if (targets.length === 0) return { ok: false, error: 'Nothing to retry.' };
    for (const item of targets) {
      // Drop any stale run mapping and clear the prior attempt's traces so the
      // item launches clean. The old child run (if any) keeps its own history;
      // retry mints a brand-new run.
      if (item.runId) this.runToBatch.delete(item.runId);
      item.status = 'queued';
      item.runId = undefined;
      item.note = undefined;
      item.branchName = undefined;
      item.startedAt = undefined;
      item.finishedAt = undefined;
    }
    // Re-queuing means the batch is active again.
    o.completedAt = undefined;
    this.persistAndEmit(o);
    void this.pump(args.id);
    return { ok: true };
  }

  delete(args: { id: UUID }): { ok: true } | { ok: false; error: string } {
    const o = this.batches.get(args.id);
    if (o) {
      // Stop anything still in flight before forgetting the record, else
      // its terminal update would route to a batch that no longer exists.
      for (const item of o.items) {
        if (item.status === 'running' && item.runId) {
          try {
            this.launcher.abortRun({ runId: item.runId });
          } catch {
            // best-effort
          }
          this.runToBatch.delete(item.runId);
        }
      }
    }
    this.batches.delete(args.id);
    deleteOrchestration(args.id);
    this.emit({ type: 'orchestrationDeleted', id: args.id });
    return { ok: true };
  }

  list(): Orchestration[] {
    return Array.from(this.batches.values()).sort((a, b) => b.createdAt - a.createdAt);
  }

  get(id: UUID): Orchestration | null {
    return this.batches.get(id) ?? null;
  }

  // ---- internals --------------------------------------------------------

  private maybeComplete(o: Orchestration): void {
    if (!o.completedAt && isOrchestrationComplete(o)) {
      o.completedAt = Date.now();
      this.persistAndEmit(o);
    }
  }

  private persistAndEmit(o: Orchestration): void {
    saveOrchestration(o);
    this.emit({ type: 'orchestrationUpdate', orchestration: structuredClone(o) });
  }
}

function resolveItemFlowId(
  suggested: string | undefined,
  fallback: string,
  allowed: string[] | undefined,
): string {
  const s = suggested?.trim();
  if (!s) return fallback;
  if (allowed && !allowed.includes(s)) return fallback;
  return s;
}
