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

import type { AppSettings, Backend, MainToRendererEvent, Project, UUID } from '../../shared/types';
import type { FlowRun } from '../../shared/flows/schema';
import type {
  Candidate,
  Orchestration,
  OrchestrationItem,
  RunIn,
} from '../../shared/flows/orchestration';
import { isOrchestrationComplete, parseCandidates } from '../../shared/flows/orchestration';
import { pickDrafterBackend, drafterModelFor } from '../../shared/flows/drafterBackend';
import { probeBackendHealth } from '../health';
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

/// Fold a refinement turn's prior context into the next producer prompt.
/// The producer is a one-shot (no persistent session), so we replay the
/// last exchange as context rather than relying on conversation memory.
function buildProducerPrompt(args: {
  message: string;
  priorPrompt?: string;
  priorReply?: string;
}): string {
  const parts = [producerSystemPrompt(), '', '---', ''];
  if (args.priorPrompt && args.priorReply) {
    parts.push(
      'CONTEXT — this is a refinement. Earlier in this session:',
      '',
      `User asked: ${args.priorPrompt}`,
      '',
      `You replied (summary + candidates):`,
      args.priorReply,
      '',
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
  }): Promise<
    { ok: true; reply: string; candidates: Candidate[] } | { ok: false; error: string }
  > {
    const message = args.message.trim();
    if (!message) return { ok: false, error: 'Message is empty.' };

    const settings = this.getSettings();
    const backend = pickDrafterBackend({
      preferred: settings.preferredBackend,
      isHealthy: (b: Backend) =>
        probeBackendHealth(b, settings.backendPaths[b]).kind === 'ready',
      isEnabled: (b: Backend) => settings.disabledBackends[b] !== true,
    });
    if (!backend) {
      return {
        ok: false,
        error:
          'No CLI is signed in to investigate with. Set up Claude, Codex, Gemini, or Copilot in Settings first.',
      };
    }
    const model = drafterModelFor(backend);
    // Run in the project so MCP servers scoped to that repo (and the model's
    // own file tools) resolve; fall back to home if no project path given.
    const cwd = args.projectPath?.trim() || os.homedir();
    const prompt = buildProducerPrompt(args);

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
      cwd,
      timeoutMs: 300_000,
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
        this.emit({ type: 'orchestrationProducerProgress', text, tools: snap.tools });
      },
    });
    if (!result.ok) return { ok: false, error: result.error };

    const candidates = parseCandidates(result.text);
    return { ok: true, reply: result.text, candidates };
  }

  // ---- DISPATCH ---------------------------------------------------------

  async startBatch(args: {
    title: string;
    projectPath: string;
    runIn?: RunIn;
    baseBranch?: string;
    maxConcurrent: number;
    producer?: { prompt: string; reply: string };
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
      // `queued` never launched; a `paused` item with no run (shouldn't
      // happen, but be defensive) has nothing to kill — settle both straight
      // to cancelled so they can't hold the batch open.
      if (item.status === 'queued' || (item.status === 'paused' && !item.runId)) {
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
