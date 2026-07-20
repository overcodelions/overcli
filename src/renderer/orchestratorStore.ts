// Zustand slice for the Orchestrator tab. Two halves, matching the engine:
//   - the DRAFT: the producer conversation (ask → AI → candidates) plus the
//     per-candidate mapping the user builds (selected? which flow? which
//     base branch?) and the batch defaults applied to everything unmapped.
//   - the LEDGER: launched orchestrations, kept in sync from the main
//     process's `orchestrationUpdate` events.
//
// Kept separate from flowsStore so the producer's churn (streaming a reply,
// editing candidate rows) never re-renders the flow library or run panes.

import { create } from 'zustand';

import type { Candidate, Orchestration, RecentPrompt, RunIn } from '@shared/flows/orchestration';

/// Client-side overlay on a Candidate: the mapping decisions that aren't part
/// of the producer's output. Keyed by candidate id in `itemConfig`.
export interface CandidateConfig {
  /// In the batch? Defaults true for every fresh candidate.
  selected: boolean;
  /// Per-item flow override. When unset, the row inherits the batch default
  /// (or the producer's suggestion). `null` is never stored — absence means
  /// "inherit".
  flowId?: string;
  /// Per-item base-branch override. Absence means inherit the batch default.
  baseBranch?: string;
}

/// One turn of the producer conversation, shown in the top pane.
export interface ProducerTurn {
  role: 'user' | 'assistant';
  text: string;
}

interface OrchestratorState {
  loaded: boolean;
  /// Launched batches, keyed by id. Newest-first ordering is derived in
  /// selectors.
  orchestrations: Record<string, Orchestration>;
  /// Which batch's ledger is expanded in the queue pane (null = the most
  /// recent / all).
  activeOrchestrationId: string | null;

  // ---- draft (producer + mapping) ----
  /// Project the batch runs against — also the cwd the producer investigates
  /// in (so repo-scoped MCP servers resolve).
  projectPath: string | null;
  /// Producer conversation turns.
  turns: ProducerTurn[];
  /// Past fresh asks (newest first), offered as one-click starters in the Ask
  /// pane. Refinements are never recorded — they're meaningless out of context.
  recentPrompts: RecentPrompt[];
  /// Whether a producer turn is in flight.
  proposing: boolean;
  /// Live streamed text of the in-flight producer turn (cleared when it
  /// resolves into a real assistant turn). Lets the Ask pane show the
  /// investigation as it happens.
  liveText: string;
  /// Tools the in-flight producer turn has invoked so far, in order.
  liveTools: string[];
  producerError: string | null;
  /// Current candidate list from the latest producer turn.
  candidates: Candidate[];
  /// Per-candidate mapping overlay.
  itemConfig: Record<string, CandidateConfig>;
  /// Batch defaults — applied to any candidate without an override.
  defaultFlowId: string | null;
  defaultBaseBranch: string;
  /// Where every item in the batch works: a fresh worktree each (the default,
  /// and the only way items can run in parallel), or the project's own working
  /// tree. `cwd` pins `maxConcurrent` to 1 — one checkout can't host two
  /// agents at once — and makes the base branch moot.
  runIn: RunIn;
  maxConcurrent: number;
  /// Open a PR when each child finishes (passed through to flows that ship).
  openPrOnFinish: boolean;
}

interface OrchestratorActions {
  reload(): Promise<void>;
  applyOrchestrationUpdate(o: Orchestration): void;
  /// Apply a live producer-progress snapshot (from main's
  /// `orchestrationProducerProgress` event).
  applyProducerProgress(text: string, tools: string[]): void;
  removeOrchestration(id: string): void;
  setActiveOrchestration(id: string | null): void;

  setProjectPath(path: string | null): void;
  setDefaultFlow(flowId: string | null): void;
  setDefaultBaseBranch(branch: string): void;
  setRunIn(runIn: RunIn): void;
  setMaxConcurrent(n: number): void;
  setOpenPrOnFinish(v: boolean): void;
  /// Rehydrate the sticky batch-launch defaults from a persisted view on
  /// launch. Applies the same cwd↔concurrency coupling setRunIn/setMaxConcurrent
  /// enforce, so a restored `cwd` batch still pins the cap to 1. Absent fields
  /// keep the current value.
  restoreDefaults(d: { runIn?: RunIn; maxConcurrent?: number; openPrOnFinish?: boolean }): void;

  /// Clear the producer conversation + candidate mapping to start a fresh
  /// batch. Keeps the launched orchestrations (the ledger) and the batch
  /// defaults (project, default flow, branch, cap) so a follow-up batch
  /// doesn't have to re-pick everything.
  resetDraft(): void;

  propose(message: string): Promise<void>;

  /// Forget a recent seed prompt from the quick-pick list.
  removeRecentPrompt(text: string): Promise<void>;

  toggleCandidate(id: string): void;
  setCandidateFlow(id: string, flowId: string | null): void;
  setCandidateBranch(id: string, branch: string | null): void;
  selectAll(selected: boolean): void;
  setFlowForSelected(flowId: string): void;

  /// Resolve the effective flow for a candidate: per-item override →
  /// producer suggestion → batch default.
  effectiveFlowId(id: string): string | null;
  /// Resolve the effective base branch for a candidate.
  effectiveBaseBranch(id: string): string;

  /// Launch the selected candidates. On success the launched ones leave the
  /// draft (they live in the queue now) and the batch becomes active.
  startBatch(title: string): Promise<{ ok: boolean; error?: string }>;
}

export type OrchestratorStore = OrchestratorState & OrchestratorActions;

function freshConfig(c: Candidate): CandidateConfig {
  return { selected: true, flowId: c.suggestedFlowId };
}

export const useOrchestratorStore = create<OrchestratorStore>((set, get) => ({
  loaded: false,
  orchestrations: {},
  activeOrchestrationId: null,

  projectPath: null,
  turns: [],
  recentPrompts: [],
  proposing: false,
  liveText: '',
  liveTools: [],
  producerError: null,
  candidates: [],
  itemConfig: {},
  defaultFlowId: null,
  defaultBaseBranch: '',
  runIn: 'worktree',
  maxConcurrent: 2,
  openPrOnFinish: true,

  async reload() {
    const [list, recentPrompts] = await Promise.all([
      window.overcli.invoke('orchestrator:list'),
      window.overcli.invoke('orchestrator:recentPrompts'),
    ]);
    const byId: Record<string, Orchestration> = {};
    for (const o of list) byId[o.id] = o;
    set({ orchestrations: byId, recentPrompts, loaded: true });
  },

  applyOrchestrationUpdate(o) {
    set((s) => ({ orchestrations: { ...s.orchestrations, [o.id]: o } }));
  },

  applyProducerProgress(text, tools) {
    // Ignore stray progress after the turn resolved.
    if (!get().proposing) return;
    set({ liveText: text, liveTools: tools });
  },

  removeOrchestration(id) {
    set((s) => {
      if (!(id in s.orchestrations)) return {};
      const { [id]: _drop, ...rest } = s.orchestrations;
      return {
        orchestrations: rest,
        activeOrchestrationId: s.activeOrchestrationId === id ? null : s.activeOrchestrationId,
      };
    });
  },

  setActiveOrchestration(id) {
    set({ activeOrchestrationId: id });
  },

  setProjectPath(path) {
    set({ projectPath: path });
  },
  setDefaultFlow(flowId) {
    set({ defaultFlowId: flowId });
  },
  setDefaultBaseBranch(branch) {
    set({ defaultBaseBranch: branch });
  },
  setRunIn(runIn) {
    // Items in a cwd batch share one working tree, so they can't overlap.
    // Drop the cap to 1 as we switch, which is also what main enforces —
    // better the UI shows the truth than launches something it didn't promise.
    set(runIn === 'cwd' ? { runIn, maxConcurrent: 1 } : { runIn });
  },
  setMaxConcurrent(n) {
    if (get().runIn === 'cwd') return;
    set({ maxConcurrent: Math.max(1, Math.min(8, Math.round(n) || 1)) });
  },
  setOpenPrOnFinish(v) {
    set({ openPrOnFinish: v });
  },
  restoreDefaults(d) {
    set((s) => {
      const runIn = d.runIn ?? s.runIn;
      // cwd shares one working tree, so it can't overlap — pin the cap to 1,
      // matching setRunIn/setMaxConcurrent. Otherwise clamp the saved cap.
      const maxConcurrent =
        runIn === 'cwd'
          ? 1
          : Math.max(1, Math.min(8, Math.round(d.maxConcurrent ?? s.maxConcurrent) || 1));
      return {
        runIn,
        maxConcurrent,
        openPrOnFinish: d.openPrOnFinish ?? s.openPrOnFinish,
      };
    });
  },

  resetDraft() {
    set({
      turns: [],
      candidates: [],
      itemConfig: {},
      producerError: null,
      proposing: false,
      liveText: '',
      liveTools: [],
    });
  },

  async propose(message) {
    const trimmed = message.trim();
    if (!trimmed || get().proposing) return;
    const projectPath = get().projectPath;
    if (!projectPath) {
      set({ producerError: 'Pick a project for the batch first.' });
      return;
    }
    // Replay the prior exchange so a refinement builds on context.
    const priorTurns = get().turns;
    const priorPrompt = [...priorTurns].reverse().find((t) => t.role === 'user')?.text;
    const priorReply = [...priorTurns].reverse().find((t) => t.role === 'assistant')?.text;
    // A fresh ask (no prior user turn) is what we record as a reusable prompt;
    // refinements only make sense against their prior turn, so they're skipped.
    const isFreshAsk = !priorPrompt;

    set((s) => ({
      turns: [...s.turns, { role: 'user', text: trimmed }],
      proposing: true,
      producerError: null,
      liveText: '',
      liveTools: [],
    }));

    const res = await window.overcli.invoke('orchestrator:propose', {
      message: trimmed,
      projectPath,
      priorPrompt,
      priorReply,
    });

    if (!res.ok) {
      set({ proposing: false, producerError: res.error, liveText: '', liveTools: [] });
      return;
    }

    // Remember a successful fresh ask so it's a one-click starter next time.
    // The main store dedupes + caps and hands back the updated list.
    if (isFreshAsk) {
      void window.overcli
        .invoke('orchestrator:recordRecentPrompt', { text: trimmed })
        .then((recentPrompts) => set({ recentPrompts }))
        .catch(() => {
          /* a failed recency write shouldn't disrupt the batch */
        });
    }

    set((s) => {
      // Merge config: keep overlays for candidates that survive (same id),
      // give fresh ones a default config (selected, suggested flow).
      const nextConfig: Record<string, CandidateConfig> = {};
      for (const c of res.candidates) {
        nextConfig[c.id] = s.itemConfig[c.id] ?? freshConfig(c);
      }
      return {
        turns: [...s.turns, { role: 'assistant', text: res.reply }],
        proposing: false,
        liveText: '',
        liveTools: [],
        candidates: res.candidates,
        itemConfig: nextConfig,
      };
    });
  },

  async removeRecentPrompt(text) {
    const recentPrompts = await window.overcli.invoke('orchestrator:deleteRecentPrompt', { text });
    set({ recentPrompts });
  },

  toggleCandidate(id) {
    set((s) => {
      const cur = s.itemConfig[id];
      if (!cur) return {};
      return { itemConfig: { ...s.itemConfig, [id]: { ...cur, selected: !cur.selected } } };
    });
  },

  setCandidateFlow(id, flowId) {
    set((s) => {
      const cur = s.itemConfig[id] ?? { selected: true };
      const next = { ...cur };
      if (flowId) next.flowId = flowId;
      else delete next.flowId;
      return { itemConfig: { ...s.itemConfig, [id]: next } };
    });
  },

  setCandidateBranch(id, branch) {
    set((s) => {
      const cur = s.itemConfig[id] ?? { selected: true };
      const next = { ...cur };
      if (branch && branch.trim()) next.baseBranch = branch.trim();
      else delete next.baseBranch;
      return { itemConfig: { ...s.itemConfig, [id]: next } };
    });
  },

  selectAll(selected) {
    set((s) => {
      const next: Record<string, CandidateConfig> = {};
      for (const c of s.candidates) {
        next[c.id] = { ...(s.itemConfig[c.id] ?? freshConfig(c)), selected };
      }
      return { itemConfig: next };
    });
  },

  setFlowForSelected(flowId) {
    set((s) => {
      const next = { ...s.itemConfig };
      for (const c of s.candidates) {
        const cfg = next[c.id];
        if (cfg?.selected) next[c.id] = { ...cfg, flowId };
      }
      return { itemConfig: next };
    });
  },

  effectiveFlowId(id) {
    const s = get();
    const cfg = s.itemConfig[id];
    if (cfg?.flowId) return cfg.flowId;
    const cand = s.candidates.find((c) => c.id === id);
    if (cand?.suggestedFlowId) return cand.suggestedFlowId;
    return s.defaultFlowId;
  },

  effectiveBaseBranch(id) {
    const s = get();
    return s.itemConfig[id]?.baseBranch ?? s.defaultBaseBranch;
  },

  async startBatch(title) {
    const s = get();
    if (!s.projectPath) return { ok: false, error: 'No project selected.' };
    const selected = s.candidates.filter((c) => s.itemConfig[c.id]?.selected);
    if (selected.length === 0) return { ok: false, error: 'No candidates selected.' };

    // When "open a PR when each finishes" is on, nudge each launched flow to
    // ship — appended to the prompt the run actually sees (and shown in the
    // ledger tooltip). Flows with their own shipper step already do this; the
    // suffix makes the intent explicit for flows that merely could. A cwd run
    // has no worktree branch of its own to commit on, so it has to cut one
    // itself rather than commit onto whatever the user has checked out.
    const prSuffix = !s.openPrOnFinish
      ? ''
      : s.runIn === 'cwd'
        ? '\n\nWhen the work is complete, commit it on a new branch and open a pull request.'
        : '\n\nWhen the work is complete, commit it on this worktree branch and open a pull request.';

    const items = selected.map((c) => {
      const flowId = get().effectiveFlowId(c.id);
      const candidate = prSuffix ? { ...c, prompt: c.prompt + prSuffix } : c;
      return {
        candidate,
        flowId: flowId ?? '',
        baseBranch:
          s.runIn === 'cwd' ? undefined : get().effectiveBaseBranch(c.id) || undefined,
      };
    });
    const missingFlow = items.find((i) => !i.flowId);
    if (missingFlow) {
      return {
        ok: false,
        error: `"${missingFlow.candidate.title}" has no flow — set a default flow or pick one for it.`,
      };
    }

    const lastReply = [...s.turns].reverse().find((t) => t.role === 'assistant')?.text;
    const lastPrompt = [...s.turns].reverse().find((t) => t.role === 'user')?.text;

    const res = await window.overcli.invoke('orchestrator:startBatch', {
      title: title.trim() || 'Batch',
      projectPath: s.projectPath,
      runIn: s.runIn,
      baseBranch: s.runIn === 'cwd' ? undefined : s.defaultBaseBranch.trim() || undefined,
      maxConcurrent: s.maxConcurrent,
      producer:
        lastPrompt && lastReply ? { prompt: lastPrompt, reply: lastReply } : undefined,
      items,
    });
    if (!res.ok) return { ok: false, error: res.error };

    // Launched candidates leave the draft — they live in the queue now.
    set((state) => {
      const launchedIds = new Set(selected.map((c) => c.id));
      const candidates = state.candidates.filter((c) => !launchedIds.has(c.id));
      const itemConfig = { ...state.itemConfig };
      for (const id of launchedIds) delete itemConfig[id];
      return {
        candidates,
        itemConfig,
        activeOrchestrationId: res.orchestrationId,
      };
    });
    return { ok: true };
  },
}));
