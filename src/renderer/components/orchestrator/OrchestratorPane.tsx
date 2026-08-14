// Orchestrator tab. Three panes:
//   ① Ask      — a producer AI turn (with the user's MCPs) → candidate list
//   ② Map      — per-candidate flow + base-branch mapping, with a batch
//                default applied to anything unmapped
//   ③ Runs     — the live batch ledger
//
// …but only two of them are ever doing anything at once, so the tab has two
// modes (see `composing` in OrchestratorPane):
//
//   COMPOSING — a producer turn is streaming, or a candidate list is waiting
//     to be mapped. You are walking ①→②→③, the numbering means something, and
//     the three panes share the screen.
//   IDLE — neither of those is true, which is most of the time. ① and ② have
//     nothing in them; the launched runs are the only thing on screen worth
//     looking at, so ① shrinks to a launcher bar, ② disappears, and the
//     ledger takes the whole stage. No step numbers in this mode: nothing is
//     mid-sequence, so numbering them would be decoration.
//
// The producer is a normal one-shot (orchestrator:propose), NOT the flow
// step machine, so it reaches MCP servers today. Launching hands the mapped
// candidates to orchestrator:startBatch, which fans them out over worktrees
// with a concurrency cap. Launched candidates leave pane ② and appear in the
// ledger with live status.

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';

import { useStore } from '../../store';
import { useFlowsStore } from '../../flowsStore';
import { useOrchestratorStore, type ProducerTurn } from '../../orchestratorStore';
import { backendColor } from '../../theme';
import { Markdown } from '../Markdown';
import { ResizableDivider } from '../ResizableDivider';
import { SegmentButton } from '../flows/FlowLaunch';
import type { Flow } from '@shared/flows/schema';
import { isOrchestrationAwaitingApproval } from '@shared/flows/orchestration';
import type { Orchestration, OrchestrationItem } from '@shared/flows/orchestration';

/// A launch target the batch can run against: a single project or a whole
/// workspace. The runtime resolves a workspace `rootPath` to a worktree per
/// member, so both collapse to a single `path` here — the only difference
/// the UI cares about is how to label/group them.
export interface LaunchTarget {
  name: string;
  path: string;
  kind: 'project' | 'workspace';
}

export function OrchestratorPane() {
  const projects = useStore((s) => s.projects);
  const workspaces = useStore((s) => s.workspaces);
  const flows = useFlowsStore((s) => s.flows);
  const reloadFlows = useFlowsStore((s) => s.reload);

  const s = useOrchestratorStore();

  // Workspaces first — a batch most often fans out across a whole workspace,
  // so it's the more common pick and the sensible default.
  const targets = useMemo<LaunchTarget[]>(
    () => [
      ...workspaces.map((w) => ({ name: w.name, path: w.rootPath, kind: 'workspace' as const })),
      ...projects.map((p) => ({ name: p.name, path: p.path, kind: 'project' as const })),
    ],
    [projects, workspaces],
  );

  // Hydrate flows + batches when the tab first mounts (it can be the first
  // surface the user opens, before the Flows tab populated the library).
  useEffect(() => {
    if (!useFlowsStore.getState().loaded) {
      void reloadFlows(projects.map((p) => p.path));
    }
    if (!useOrchestratorStore.getState().loaded) {
      void useOrchestratorStore.getState().reload();
    }
    // Default the batch target to the first workspace (or project) if unset.
    if (!useOrchestratorStore.getState().projectPath && targets[0]) {
      useOrchestratorStore.getState().setProjectPath(targets[0].path);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const flowById = useMemo(() => {
    const m = new Map<string, Flow>();
    for (const f of flows) m.set(f.id, f);
    return m;
  }, [flows]);

  const batches = useMemo(
    () =>
      Object.values(s.orchestrations).sort(
        // A parked batch is the one thing here that's blocked on the user, so
        // it sorts above everything regardless of age — a proposal from this
        // morning shouldn't sit below a batch that finished an hour ago.
        (a, b) =>
          Number(isOrchestrationAwaitingApproval(b)) -
            Number(isOrchestrationAwaitingApproval(a)) || b.createdAt - a.createdAt,
      ),
    [s.orchestrations],
  );

  // The composer draft lives here rather than in the Ask pane: the idle
  // stage's empty state offers one-click starters too, and both need to write
  // into the same box.
  const [draft, setDraft] = useState('');
  const [aboutOpen, setAboutOpen] = useState(false);

  // Queue column width — defaults to a third of the bottom section, then the
  // user can drag the divider to resize (double-click resets). Measured once
  // after layout so it scales with the window instead of a fixed pixel guess.
  const bottomRef = useRef<HTMLDivElement>(null);
  const [queueWidth, setQueueWidth] = useState(560);
  const measuredQueueWidth = useRef(false);
  useLayoutEffect(() => {
    if (measuredQueueWidth.current) return;
    const w = bottomRef.current?.clientWidth ?? 0;
    if (w > 0) {
      measuredQueueWidth.current = true;
      setQueueWidth(Math.max(320, Math.min(900, Math.round(w / 3))));
    }
  }, []);

  const targetName = targets.find((t) => t.path === s.projectPath)?.name ?? null;

  /// Is there a batch being put together right now? See the file header for
  /// what each mode looks like.
  const composing = s.proposing || s.turns.length > 0 || s.candidates.length > 0;

  return (
    <div className="flex flex-col h-full min-h-0 bg-surface text-ink">
      <PageHeader targets={targets} onAbout={() => setAboutOpen(true)} />
      <ProducerPane
        targets={targets}
        targetName={targetName}
        composing={composing}
        hasBatches={batches.length > 0}
        draft={draft}
        setDraft={setDraft}
        onAbout={() => setAboutOpen(true)}
      />
      {/* Same element in both modes, so the measured width below is the same
          either way — only what sits inside it changes. */}
      <div
        ref={bottomRef}
        className="flex-1 flex min-h-0 border-t"
        style={{ borderTopColor: 'var(--c-card-bg)' }}
      >
        {composing ? (
          <>
            {/* Decision surface (Map, left) and live surface (Queue, right)
                sit at eye level: candidates flow left→right as they launch, so
                you can keep triaging while runs progress instead of scrolling
                between them. The divider is a draggable resize handle. */}
            <MapPane flows={flows} flowById={flowById} />
            <ResizableDivider
              width={queueWidth}
              onChange={setQueueWidth}
              minWidth={320}
              maxWidth={900}
              side="right"
            />
            <QueuePane flowById={flowById} batches={batches} width={queueWidth} />
          </>
        ) : (
          <QueuePane flowById={flowById} batches={batches} setDraft={setDraft} />
        )}
      </div>
      {aboutOpen && (
        <AboutModal
          onClose={() => setAboutOpen(false)}
          onUseExample={(prompt) => {
            setDraft(prompt);
            setAboutOpen(false);
          }}
        />
      )}
    </div>
  );
}

/// What the Orchestrator is and what to ask it for, behind the header's About
/// button. Same shape as the Flows tab's About modal, and for the same reason:
/// the examples are the answer to "what do I even type here", and once you
/// have a few recent prompts of your own they are otherwise unreachable — the
/// quick-pick row under the composer shows your history instead, and the
/// first-run empty state is long gone.
///
/// Every example is a button, not a code sample. The question this panel
/// answers is "what can I ask for", and the shortest honest answer is to put
/// the ask in the box.
function AboutModal({
  onClose,
  onUseExample,
}: {
  onClose: () => void;
  onUseExample: (prompt: string) => void;
}) {
  const setDetailMode = useStore((s) => s.setDetailMode);
  /// Take the user to the thing the sentence is about. Clearing the open run
  /// matters: the Flows tab renders a run detail over the library when one is
  /// selected, so without this you'd land back on whatever you last opened
  /// instead of on the schedules.
  const openSchedules = () => {
    useFlowsStore.getState().setActiveRun(null);
    useFlowsStore.getState().setLibrarySegment('schedules');
    setDetailMode('flows');
    onClose();
  };
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
      onClick={onClose}
    >
      <div
        className="bg-surface-elevated rounded-lg shadow-2xl border border-card-strong w-full max-w-[680px] max-h-[80vh] overflow-hidden flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-3 px-5 py-4 border-b border-card">
          <div className="text-lg font-semibold">About the Orchestrator</div>
          <button
            onClick={onClose}
            className="ml-auto text-xs text-ink-faint hover:text-ink px-2 py-1 rounded hover:bg-white/5"
          >
            ✕
          </button>
        </div>
        <div className="flex-1 overflow-y-auto p-5 space-y-5">
          <p className="text-sm text-ink-muted leading-relaxed m-0">
            Ask for a list of small jobs and it goes and finds them. The producer
            investigates with whatever tools and MCP servers you have connected — your
            tracker, your feedback tool, your error reporter — and comes back with asks
            small enough to hand to one agent each. You map them to flows and launch the
            lot; each one gets its own git worktree, so they run side by side without
            treading on each other.
          </p>
          <div>
            <div className="text-[11px] uppercase tracking-wider text-ink-faint font-bold mb-2">
              What to ask for
            </div>
            <div className="grid grid-cols-2 gap-2">
              {PRODUCER_EXAMPLES.map((ex) => (
                <button
                  key={ex.label}
                  onClick={() => onUseExample(ex.prompt)}
                  className="group text-left p-3 rounded-lg bg-card hover:bg-card-strong transition-colors"
                >
                  <div className="flex items-center gap-2">
                    <span className="font-semibold text-[13px] text-ink">{ex.label}</span>
                    <span className="ml-auto text-[11px] text-accent opacity-0 group-hover:opacity-100 transition-opacity">
                      use →
                    </span>
                  </div>
                  <div className="text-xs text-ink-faint mt-0.5 leading-snug">{ex.blurb}</div>
                </button>
              ))}
            </div>
            <p className="text-xs text-ink-faint mt-2.5 m-0">
              These are examples, not an integration list — the producer uses whatever
              you have connected.
            </p>
          </div>
          <div>
            <div className="text-[11px] uppercase tracking-wider text-ink-faint font-bold mb-2">
              Worth knowing
            </div>
            <ul className="text-sm text-ink-muted leading-relaxed space-y-1.5 m-0 pl-4 list-disc">
              <li>
                Refine before you launch — “only the docs ones”, “drop anything touching
                auth”. The producer re-answers with the whole list.
              </li>
              <li>
                Nothing runs until you hit Launch, and you can untick individual asks
                first.
              </li>
              <li>
                <button
                  onClick={openSchedules}
                  className="text-accent hover:underline font-medium"
                >
                  A schedule
                </button>{' '}
                can run the producer for you on a timer. By default it parks what it
                finds for your approval; you can let it launch a capped number unattended
                instead.
              </li>
            </ul>
          </div>
        </div>
      </div>
    </div>
  );
}

/// Horizontal padding for the idle stage. Edge to edge by request: a centred
/// column left ~270px of dead gutter either side on a wide display, and the
/// window is already the measure the user chose by sizing it. The row grid
/// takes up the slack in its flow column rather than stranding the status
/// chip — see LedgerRow.
const IDLE_PAD = 'px-6';

/// The tab's page header. Present in both modes — it identifies the page, and
/// the page doesn't change when you start composing.
///
/// Deliberately the same idiom as the Flows tab (`text-2xl font-semibold`, one
/// row, actions pushed right): these are sibling tabs, and a page title that
/// changed size between them would read as two different apps. No tagline for
/// the same reason — Flows doesn't carry one, and a description you've read
/// once is decoration on every visit after that.
///
/// The target picker lives here rather than beside the composer because it
/// governs the whole page — the producer turn, the batch, and every run in the
/// ledger — not just the box it used to sit next to.
function PageHeader({
  targets,
  onAbout,
}: {
  targets: LaunchTarget[];
  onAbout: () => void;
}) {
  const projectPath = useOrchestratorStore((s) => s.projectPath);
  const setProjectPath = useOrchestratorStore((s) => s.setProjectPath);
  const workspaceTargets = targets.filter((t) => t.kind === 'workspace');
  const projectTargets = targets.filter((t) => t.kind === 'project');
  return (
    <header className={'flex-none flex items-center gap-3 pt-5 pb-4 ' + IDLE_PAD}>
      <h1 className="text-2xl font-semibold text-ink m-0">Orchestrator</h1>
      <div className="flex-1" />
      {/* "About", not a "?" glyph: the Flows tab already spends this exact
          button on this exact job, and a second idiom for "explain this page"
          is a thing to learn twice. */}
      <button
        onClick={onAbout}
        className="text-xs text-ink-faint hover:text-ink hover:bg-white/5 px-2 py-1 rounded"
        title="What can I ask the producer for?"
      >
        About
      </button>
      <select
        value={projectPath ?? ''}
        onChange={(e) => setProjectPath(e.target.value || null)}
        className="text-xs bg-card-strong rounded-md px-2 py-1 text-ink border-0 outline-none"
        title="Project or workspace everything on this page runs against"
      >
        {targets.length === 0 && <option value="">No workspaces or projects</option>}
        {workspaceTargets.length > 0 && (
          <optgroup label="Workspaces">
            {workspaceTargets.map((t) => (
              <option key={t.path} value={t.path}>
                {t.name}
              </option>
            ))}
          </optgroup>
        )}
        {projectTargets.length > 0 && (
          <optgroup label="Projects">
            {projectTargets.map((t) => (
              <option key={t.path} value={t.path}>
                {t.name}
              </option>
            ))}
          </optgroup>
        )}
      </select>
    </header>
  );
}

/// Small numbered step badge — makes ①②③ read as a connected sequence
/// rather than decorative glyphs.
function StepBadge({ n }: { n: number }) {
  return (
    <span className="inline-grid place-items-center w-[18px] h-[18px] rounded-full bg-accent-600/20 text-accent text-[11px] font-bold flex-none">
      {n}
    </span>
  );
}

// ============================ ① Producer =============================

/// Starter prompts spanning the common request sources. Clicking one drops it
/// in the composer to edit + send. Deliberately source-agnostic in spirit:
/// the producer uses whatever MCP/tools are connected, so these are examples,
/// not a fixed integration list.
/// How many recent prompts surface as quick-pick pills. We persist more (the
/// store caps at 30), but only the most-recent ones are worth one-click reach —
/// keeps the empty state from growing into a long scroll.
const RECENT_VISIBLE = 15;

const PRODUCER_EXAMPLES: Array<{ label: string; blurb: string; prompt: string }> = [
  {
    label: 'ProductBoard',
    blurb: 'Recent insights → small, self-contained asks',
    prompt:
      'Pull the recent ProductBoard insights and pick out the small, self-contained asks I could knock out individually.',
  },
  {
    label: 'GitHub issues',
    blurb: 'Open “good first issue” / “papercut” fixes',
    prompt:
      'List the open GitHub issues labeled "good first issue" or "papercut" and surface the ones that are a single, low-ambiguity fix.',
  },
  {
    label: 'Linear / Jira',
    blurb: 'Well-scoped tickets in the current cycle',
    prompt:
      'Look at my open Linear tickets in the current cycle and find the small, well-scoped ones that could each be done in one focused change.',
  },
  {
    label: 'Zendesk tickets',
    blurb: 'Recent bug tickets that map to one fix',
    prompt:
      'Scan recent Zendesk tickets tagged as bugs and pull out the small, reproducible ones that map to a single code fix.',
  },
  {
    label: 'Sentry errors',
    blurb: 'Top recurring errors that look contained',
    prompt:
      'Look at the top recurring Sentry errors from the last week and find the ones that look like a small, contained fix.',
  },
];

function ProducerPane({
  targets,
  targetName,
  composing,
  hasBatches,
  draft,
  setDraft,
  onAbout,
}: {
  targets: LaunchTarget[];
  targetName: string | null;
  composing: boolean;
  /// Whether the ledger below has anything in it. When it doesn't, the tab's
  /// empty state lives down there and carries the starters — so this bar drops
  /// its own quick-pick row rather than showing them twice.
  hasBatches: boolean;
  draft: string;
  setDraft: (v: string) => void;
  onAbout: () => void;
}) {
  const projectPath = useOrchestratorStore((s) => s.projectPath);
  const setProjectPath = useOrchestratorStore((s) => s.setProjectPath);
  const resetDraft = useOrchestratorStore((s) => s.resetDraft);
  const candidateCount = useOrchestratorStore((s) => s.candidates.length);
  const hasDraft = useOrchestratorStore((s) => s.turns.length > 0 || s.candidates.length > 0);
  const projectTargets = targets.filter((t) => t.kind === 'project');
  const workspaceTargets = targets.filter((t) => t.kind === 'workspace');
  const turns = useOrchestratorStore((s) => s.turns);
  const proposing = useOrchestratorStore((s) => s.proposing);
  const liveText = useOrchestratorStore((s) => s.liveText);
  const liveTools = useOrchestratorStore((s) => s.liveTools);
  const producerError = useOrchestratorStore((s) => s.producerError);
  const propose = useOrchestratorStore((s) => s.propose);

  const [collapsed, setCollapsed] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  // Auto-collapse once the first candidate list lands — the producer has done
  // its job and the candidates below want the room. Re-expands on demand (to
  // refine) and is force-expanded while a turn streams so you see progress.
  const prevCount = useRef(0);
  useEffect(() => {
    if (prevCount.current === 0 && candidateCount > 0) setCollapsed(true);
    prevCount.current = candidateCount;
  }, [candidateCount]);
  const expanded = !collapsed || proposing;

  // Keep the latest content in view as it streams.
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [turns.length, proposing, liveText, liveTools.length, expanded]);

  const send = () => {
    const text = draft.trim();
    if (!text || proposing) return;
    setDraft('');
    void propose(text);
  };

  const composerInput = (
    <>
      <span className="text-ink-faint">▸</span>
      <input
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            send();
          }
        }}
        placeholder={
          turns.length === 0
            ? 'Ask for a list of small asks…'
            : 'Refine — “only the docs ones”, “also check Zendesk papercuts”…'
        }
        className="flex-1 bg-transparent outline-none text-sm text-ink placeholder:text-ink-faint"
      />
      <button
        onClick={send}
        disabled={proposing || !draft.trim()}
        className="text-xs font-medium px-3 py-1 rounded-md bg-accent-600 text-white disabled:opacity-40"
      >
        {turns.length === 0 ? 'Send' : 'Refine'}
      </button>
    </>
  );

  // Idle: no transcript, no candidates, nothing to collapse. The Ask is a
  // launcher, not a landing page — one bar, and the room it used to take goes
  // to the ledger below. Typing here and hitting Send flips the tab straight
  // into composing mode, so nothing is more than one keystroke away.
  //
  // The generous `pb` is what separates the compose block from the ledger now
  // that the header below carries no fill of its own — whitespace doing the
  // job a background was doing.
  if (!composing) {
    return (
      <section className={'flex-none pt-3 pb-7 ' + IDLE_PAD}>
        <div className="flex items-center gap-2 rounded-lg bg-card-strong px-3 py-2 focus-within:bg-surface-elevated transition-colors">
          {composerInput}
        </div>
        {hasBatches && <QuickPicks setDraft={setDraft} onAbout={onAbout} />}
      </section>
    );
  }

  return (
    <section className="flex flex-col flex-none min-h-0">
      {/* Header doubles as the collapse toggle once there's something to
          collapse. The chevron + summary make the collapsed state legible. */}
      <div className="flex items-center gap-2.5 px-4 py-2.5 flex-none">
        <button
          onClick={() => hasDraft && setCollapsed((c) => !c)}
          className={'flex items-center gap-2.5 min-w-0 ' + (hasDraft ? 'cursor-pointer' : 'cursor-default')}
          title={hasDraft ? (expanded ? 'Collapse' : 'Expand to refine') : undefined}
        >
          <StepBadge n={1} />
          <h2 className="text-[11px] uppercase tracking-wider text-ink font-bold m-0">Ask</h2>
          {!expanded && candidateCount > 0 ? (
            <span className="text-xs text-ink-faint truncate">
              {candidateCount} candidates{targetName ? ` · ${targetName}` : ''} — click to refine
            </span>
          ) : (
            <span className="text-xs text-ink-faint hidden sm:inline">
              a producer turn with your MCPs — returns a candidate list
            </span>
          )}
        </button>
        <div className="flex-1" />
        {hasDraft && (
          <button
            onClick={resetDraft}
            className="text-xs font-medium px-2.5 py-1 rounded-md text-ink-muted hover:text-ink bg-card hover:bg-card-strong"
            title="Clear this conversation and candidates to start a fresh batch"
          >
            ＋ New batch
          </button>
        )}
      </div>
      {expanded && (
        <ProducerBody
          scrollRef={scrollRef}
          turns={turns}
          proposing={proposing}
          liveText={liveText}
          liveTools={liveTools}
          producerError={producerError}
          composerInput={composerInput}
        />
      )}
    </section>
  );
}

/// The tab's empty state: what the Orchestrator is for, the canned starters,
/// and the prompts you've run before. It lives on the idle stage rather than
/// under the Ask bar, because it is only ever the right thing to show when
/// there is nothing running to show instead.
function ProducerEmptyState({ setDraft }: { setDraft: (v: string) => void }) {
  const recentPrompts = useOrchestratorStore((s) => s.recentPrompts);
  const removeRecentPrompt = useOrchestratorStore((s) => s.removeRecentPrompt);
  return (
      <div className="max-w-3xl mx-auto mt-6 mb-3 text-center">
        <h3 className="text-lg font-semibold text-ink">Turn a backlog into a batch of flows</h3>
        <p className="text-sm text-ink-faint leading-relaxed mt-1.5 max-w-xl mx-auto">
          The producer investigates with your connected tools and MCP servers, then
          returns a list of small, self-contained asks. Map each to a flow and launch
          them together — one git worktree per ask, or one at a time in your own
          working tree.
        </p>
        <div className="text-[11px] uppercase tracking-wider text-ink-faint font-bold mt-5 mb-2">
          Start from an example
        </div>
        <div className="grid grid-cols-2 gap-2 text-left">
          {PRODUCER_EXAMPLES.map((ex) => (
            <button
              key={ex.label}
              onClick={() => setDraft(ex.prompt)}
              className="group p-3 rounded-lg bg-card hover:bg-card-strong transition-colors"
            >
              <div className="flex items-center gap-2">
                <span className="font-semibold text-[13px] text-ink">{ex.label}</span>
                <span className="ml-auto text-[11px] text-accent opacity-0 group-hover:opacity-100 transition-opacity">
                  use →
                </span>
              </div>
              <div className="text-xs text-ink-faint mt-0.5 leading-snug">{ex.blurb}</div>
            </button>
          ))}
        </div>
        {recentPrompts.length > 0 && (
          <>
            <div className="text-[11px] uppercase tracking-wider text-ink-faint font-bold mt-5 mb-2">
              Recent
            </div>
            {/* Compact wrapping pills (not stacked rows) so the list stays a
                couple of rows tall no matter how many are stored — only the
                most-recent handful surface as quick-picks. */}
            <div className="flex flex-wrap justify-center gap-1.5">
              {recentPrompts.slice(0, RECENT_VISIBLE).map((rp) => (
                <span
                  key={rp.text}
                  className="group inline-flex items-center max-w-[340px] rounded-full bg-card hover:bg-card-strong transition-colors"
                >
                  <button
                    onClick={() => setDraft(rp.text)}
                    className="min-w-0 truncate pl-3 pr-1.5 py-1 text-xs text-ink"
                    title={rp.text}
                  >
                    {rp.text}
                  </button>
                  <button
                    onClick={() => void removeRecentPrompt(rp.text)}
                    className="flex-none pl-0.5 pr-2.5 py-1 text-ink-faint hover:text-ink opacity-0 group-hover:opacity-100 transition-opacity"
                    title="Remove from recent"
                    aria-label="Remove from recent"
                  >
                    ✕
                  </button>
                </span>
              ))}
            </div>
          </>
        )}
        <p className="text-xs text-ink-faint mt-3">…or type your own in the bar above.</p>
      </div>
  );
}

/// One row of one-click starters under the idle Ask bar: prompts you have
/// actually run, falling back to the canned examples on a fresh install. It
/// scrolls sideways instead of wrapping — the ledger below is what the user
/// came back for, and this must never push it down the screen.
function QuickPicks({
  setDraft,
  onAbout,
}: {
  setDraft: (v: string) => void;
  onAbout: () => void;
}) {
  const recentPrompts = useOrchestratorStore((s) => s.recentPrompts);
  const picks =
    recentPrompts.length > 0
      ? recentPrompts.slice(0, RECENT_VISIBLE).map((rp) => ({ label: rp.text, prompt: rp.text }))
      : PRODUCER_EXAMPLES.map((ex) => ({ label: ex.label, prompt: ex.prompt }));
  return (
    <div className="flex items-center gap-1.5 mt-2 overflow-x-auto no-scrollbar">
      {/* Pinned, and pinned FIRST. "What can I ask for" is the question a
          blank composer provokes, and the answer has to be within reach of the
          box — not behind a grey word in the header, and not at the end of a
          sideways-scrolling row of fifteen prompts you've already run. Tinted
          rather than another neutral pill, because it's the one chip here that
          isn't a prompt. */}
      <button
        onClick={onAbout}
        title="What can I ask the producer for?"
        className="flex-none flex items-center gap-1 rounded-full px-3 py-1 text-xs text-accent palette-chip-active border transition-colors"
      >
        <span aria-hidden>✦</span>
        Examples
      </button>
      {picks.length > 0 && <span className="flex-none w-px h-4 bg-card-strong" />}
      {picks.map((p) => (
        <button
          key={p.label}
          onClick={() => setDraft(p.prompt)}
          title={p.prompt}
          className="flex-none max-w-[260px] truncate rounded-full bg-card hover:bg-card-strong px-3 py-1 text-xs text-ink-muted hover:text-ink transition-colors"
        >
          {p.label}
        </button>
      ))}
    </div>
  );
}

/// The expandable body of the Ask pane (transcript + composer), split out so
/// the collapsed header stays cheap and the JSX stays readable.
function ProducerBody({
  scrollRef,
  turns,
  proposing,
  liveText,
  liveTools,
  producerError,
  composerInput,
}: {
  scrollRef: React.RefObject<HTMLDivElement>;
  turns: ProducerTurn[];
  proposing: boolean;
  liveText: string;
  liveTools: string[];
  producerError: string | null;
  composerInput: React.ReactNode;
}) {
  return (
    <>
      <div ref={scrollRef} className="overflow-y-auto px-4 pb-2 max-h-[40vh]">
        {turns.map((t, i) => (
          <Turn key={i} role={t.role} text={t.text} />
        ))}
        {proposing && <LiveProducerTurn text={liveText} tools={liveTools} />}
        {producerError && (
          <div className="text-sm text-red-400 my-2 max-w-2xl">{producerError}</div>
        )}
      </div>

      <div className="px-4 pb-3 pt-1">
        <div className="flex items-center gap-2 w-full rounded-lg bg-card-strong px-3 py-2 focus-within:bg-surface-elevated transition-colors">
          {composerInput}
        </div>
      </div>
    </>
  );
}

/// The in-flight producer turn, streamed live like the chat — an assistant
/// avatar + a bubble showing the tools it's invoking and the prose as it
/// arrives, so the user can see the investigation instead of a blank spinner.
function LiveProducerTurn({ text, tools }: { text: string; tools: string[] }) {
  const latestTool = tools[tools.length - 1];
  return (
    <div className="flex gap-2.5 my-2.5">
      <div
        className="w-6 h-6 rounded-md grid place-items-center text-xs font-bold flex-none bg-backend-claude/20"
        style={{ color: 'var(--c-backend-claude)' }}
      >
        ◈
      </div>
      <div className="relative min-w-0 flex-1 rounded-xl bg-card pl-4 pr-3.5 py-2.5 overflow-hidden">
        <span
          className="absolute left-0 top-0 bottom-0 w-[2px]"
          style={{ background: 'var(--c-backend-claude)' }}
        />
        <div className="flex items-center gap-2 text-xs text-ink-muted mb-1.5">
          <Spinner />
          <span className="font-medium">
            {latestTool ? `calling ${prettyTool(latestTool)}…` : 'investigating…'}
          </span>
          {tools.length > 1 && <span className="text-ink-faint">· {tools.length} tool calls</span>}
        </div>
        {tools.length > 0 && (
          <div className="flex flex-wrap gap-1.5 mb-2">
            {dedupeTools(tools).map((t, i) => (
              <span
                key={i}
                className="text-[11px] font-mono px-1.5 py-px rounded border"
                style={{
                  color: 'var(--c-backend-gemini)',
                  borderColor: 'var(--c-card-border)',
                  background: 'var(--c-card-bg)',
                }}
              >
                {prettyTool(t.name)}
                {t.count > 1 ? ` ×${t.count}` : ''}
              </span>
            ))}
          </div>
        )}
        {text && <Markdown source={text} />}
      </div>
    </div>
  );
}

/// Collapse an MCP tool id to something readable: `mcp__productboard__list`
/// → `productboard·list`; a bare `Bash` stays `Bash`.
function prettyTool(name: string): string {
  const m = name.match(/^mcp__([^_]+)__(.+)$/);
  if (m) return `${m[1]}·${m[2]}`;
  return name;
}

/// Roll a flat tool-call list into ordered unique entries with counts so the
/// chip strip stays compact when a tool is hit repeatedly (paging a source).
function dedupeTools(tools: string[]): Array<{ name: string; count: number }> {
  const out: Array<{ name: string; count: number }> = [];
  const idx = new Map<string, number>();
  for (const t of tools) {
    const at = idx.get(t);
    if (at === undefined) {
      idx.set(t, out.length);
      out.push({ name: t, count: 1 });
    } else {
      out[at].count++;
    }
  }
  return out;
}

function Turn({ role, text }: { role: 'user' | 'assistant'; text: string }) {
  // Strip the machine-readable <candidates> block from the assistant's
  // shown prose — the parsed candidates render as rows in pane ②, so echoing
  // the raw JSON here would be noise.
  const shown =
    role === 'assistant' ? text.replace(/<candidates>[\s\S]*?<\/candidates>/i, '').trim() : text;
  return (
    <div className="flex gap-2.5 my-2.5">
      <div
        className={
          'w-6 h-6 rounded-md grid place-items-center text-xs font-bold flex-none ' +
          (role === 'user' ? 'bg-surface-elevated text-ink-muted' : 'bg-backend-claude/20')
        }
        style={role === 'assistant' ? { color: 'var(--c-backend-claude)' } : undefined}
      >
        {role === 'user' ? 'You' : '◈'}
      </div>
      {role === 'assistant' ? (
        // Full-width, markdown-rendered like the chat — the producer's
        // summary is real prose (headings, lists, code) and deserves the
        // same treatment as an assistant message in a conversation: a soft
        // card with a left accent rail, no hard border.
        <div className="relative min-w-0 flex-1 rounded-xl bg-card pl-4 pr-3.5 py-2.5 text-ink overflow-hidden">
          <span
            className="absolute left-0 top-0 bottom-0 w-[2px]"
            style={{ background: 'var(--c-backend-claude)' }}
          />
          {shown ? (
            <Markdown source={shown} />
          ) : (
            <span className="text-ink-faint text-sm">(no summary)</span>
          )}
        </div>
      ) : (
        <div className="min-w-0 flex-1 text-sm text-ink pt-0.5 whitespace-pre-wrap">{shown}</div>
      )}
    </div>
  );
}

// ============================ ② Map ==================================

function MapPane({
  flows,
  flowById,
}: {
  flows: Flow[];
  flowById: Map<string, Flow>;
}) {
  const candidates = useOrchestratorStore((s) => s.candidates);
  const itemConfig = useOrchestratorStore((s) => s.itemConfig);
  const defaultFlowId = useOrchestratorStore((s) => s.defaultFlowId);
  const defaultBaseBranch = useOrchestratorStore((s) => s.defaultBaseBranch);
  const runIn = useOrchestratorStore((s) => s.runIn);
  const setRunIn = useOrchestratorStore((s) => s.setRunIn);
  const setDefaultFlow = useOrchestratorStore((s) => s.setDefaultFlow);
  const setDefaultBaseBranch = useOrchestratorStore((s) => s.setDefaultBaseBranch);
  const selectAll = useOrchestratorStore((s) => s.selectAll);
  const setFlowForSelected = useOrchestratorStore((s) => s.setFlowForSelected);

  const selectedCount = candidates.filter((c) => itemConfig[c.id]?.selected).length;

  return (
    <section className="flex flex-col min-h-0 flex-1">
      <PaneHead step={2} title="Map each ask → a flow">
        <div className="flex items-center gap-3 text-xs">
          <span className="text-ink-muted">
            <b className="text-ink">{selectedCount}</b> of {candidates.length} selected
          </span>
          <button className="text-accent font-medium" onClick={() => selectAll(true)}>
            Select all
          </button>
          <button className="text-accent font-medium" onClick={() => selectAll(false)}>
            None
          </button>
        </div>
      </PaneHead>

      <div className="flex-1 overflow-y-auto px-4 pb-3 min-h-0">
        {candidates.length === 0 ? (
          <div className="h-full min-h-[140px] grid place-items-center text-center">
            <div className="text-sm text-ink-faint max-w-xs">
              Candidates you map to flows will appear here.
              <br />
              Ask the producer above to get a list.
            </div>
          </div>
        ) : (
          <>
            {/* batch default — set once, every row inherits unless overridden */}
            <div className="flex items-center gap-3 flex-wrap px-3 py-2.5 my-2 rounded-lg bg-card">
              <span className="font-medium text-sm text-ink-muted">Default flow</span>
              <FlowSelect
                flows={flows}
                value={defaultFlowId}
                onChange={(id) => setDefaultFlow(id)}
                placeholder="Pick a flow…"
              />
              {/* Where the whole batch works. Same idiom as a single flow
                  launch, but batch-wide — mixing the two inside one batch
                  would just be a confusing way to serialize half of it. */}
              <div className="inline-flex p-0.5 rounded-lg bg-card-strong">
                <SegmentButton
                  active={runIn === 'cwd'}
                  onClick={() => setRunIn('cwd')}
                  title="Run every ask in the project's own working tree, one at a time"
                >
                  main tree
                </SegmentButton>
                <SegmentButton
                  active={runIn === 'worktree'}
                  onClick={() => setRunIn('worktree')}
                  title="Give each ask its own fresh worktree so they can run in parallel"
                >
                  worktree each
                </SegmentButton>
              </div>
              {/* Nothing forks from a base branch in the main tree — the runs
                  use whatever it already has checked out. */}
              {runIn === 'worktree' && (
                <>
                  <span className="font-medium text-sm text-ink-muted ml-1">Base</span>
                  <input
                    value={defaultBaseBranch}
                    onChange={(e) => setDefaultBaseBranch(e.target.value)}
                    placeholder="(repo default)"
                    className="text-xs font-mono bg-card-strong rounded-md px-2 py-1.5 text-ink w-32 border-0 outline-none"
                  />
                </>
              )}
              <div className="flex-1" />
              <button
                className="text-xs text-accent font-medium disabled:opacity-40"
                disabled={!defaultFlowId || selectedCount === 0}
                onClick={() => defaultFlowId && setFlowForSelected(defaultFlowId)}
                title="Reset every selected row to the default flow"
              >
                Apply default to selected
              </button>
            </div>

            {/* Soft separated cards (the app's participant/chat idiom): a
                subtle fill + left accent rail, gaps between — no hard borders. */}
            <div className="space-y-1.5">
              {candidates.map((c) => (
                <CandidateRow key={c.id} candidateId={c.id} flows={flows} flowById={flowById} />
              ))}
            </div>
          </>
        )}
      </div>

      {/* Launch controls live at the foot of the decision column — they act
          on the selection above. */}
      {candidates.length > 0 && <LaunchFooter />}
    </section>
  );
}

/// Concurrency cap + PR toggle + Launch. Footer of the Map column.
function LaunchFooter() {
  const candidates = useOrchestratorStore((s) => s.candidates);
  const itemConfig = useOrchestratorStore((s) => s.itemConfig);
  const maxConcurrent = useOrchestratorStore((s) => s.maxConcurrent);
  const setMaxConcurrent = useOrchestratorStore((s) => s.setMaxConcurrent);
  const runIn = useOrchestratorStore((s) => s.runIn);
  const openPr = useOrchestratorStore((s) => s.openPrOnFinish);
  const setOpenPr = useOrchestratorStore((s) => s.setOpenPrOnFinish);
  const startBatch = useOrchestratorStore((s) => s.startBatch);

  // One working tree can't host two agents editing the same files, so a
  // main-tree batch drains strictly one at a time. Show that as a fact
  // rather than a stepper the user can move but main will overrule.
  const serialized = runIn === 'cwd';

  const [launchError, setLaunchError] = useState<string | null>(null);
  const [launching, setLaunching] = useState(false);
  const readyCount = candidates.filter((c) => itemConfig[c.id]?.selected).length;

  const launch = async () => {
    setLaunching(true);
    setLaunchError(null);
    const title = candidates[0]?.title ? `Batch · ${readyCount} asks` : 'Batch';
    const res = await startBatch(title);
    setLaunching(false);
    if (!res.ok) setLaunchError(res.error ?? 'Launch failed.');
  };

  return (
    <div className="flex-none px-4 py-2.5 bg-surface-muted/40 flex items-center gap-3 flex-wrap">
      {serialized ? (
        <span
          className="text-xs text-ink-faint"
          title="Every ask runs in the project's working tree, so they can't overlap — the queue runs them one after another."
        >
          Running <b className="text-ink">one at a time</b> in the main tree
        </span>
      ) : (
        <div className="flex items-center gap-2">
          <span className="text-xs text-ink-faint">Run at most</span>
          <div className="flex items-center bg-card-strong rounded-md overflow-hidden">
            <button
              className="w-6 h-6 text-ink hover:bg-card-border"
              onClick={() => setMaxConcurrent(maxConcurrent - 1)}
            >
              −
            </button>
            <span className="w-7 text-center text-sm font-semibold">{maxConcurrent}</span>
            <button
              className="w-6 h-6 text-ink hover:bg-card-border"
              onClick={() => setMaxConcurrent(maxConcurrent + 1)}
            >
              +
            </button>
          </div>
          <span className="text-xs text-ink-faint">at a time</span>
        </div>
      )}
      <label className="text-xs text-ink-faint flex items-center gap-1.5">
        <input type="checkbox" checked={openPr} onChange={(e) => setOpenPr(e.target.checked)} />
        open a PR when each finishes
      </label>
      <div className="flex-1" />
      {launchError && <span className="text-xs text-red-400">{launchError}</span>}
      <button
        onClick={launch}
        disabled={launching || readyCount === 0}
        className="text-sm font-semibold px-4 py-1.5 rounded-lg bg-accent-600 text-white disabled:opacity-40"
      >
        {launching ? 'Launching…' : `Launch ${readyCount} flow${readyCount === 1 ? '' : 's'} ▸`}
      </button>
    </div>
  );
}

function CandidateRow({
  candidateId,
  flows,
  flowById,
}: {
  candidateId: string;
  flows: Flow[];
  flowById: Map<string, Flow>;
}) {
  const candidate = useOrchestratorStore((s) => s.candidates.find((c) => c.id === candidateId))!;
  const cfg = useOrchestratorStore((s) => s.itemConfig[candidateId]);
  const defaultFlowId = useOrchestratorStore((s) => s.defaultFlowId);
  const toggle = useOrchestratorStore((s) => s.toggleCandidate);
  const setCandidateFlow = useOrchestratorStore((s) => s.setCandidateFlow);
  const effectiveFlowId = useOrchestratorStore((s) => s.effectiveFlowId);

  const selected = !!cfg?.selected;
  const resolvedFlowId = effectiveFlowId(candidateId);
  const resolvedFlow = resolvedFlowId ? flowById.get(resolvedFlowId) : undefined;
  // A row is "overriding" when it has an explicit per-item flow that differs
  // from the batch default — that's the row the user deliberately changed.
  const overriding = !!cfg?.flowId && cfg.flowId !== defaultFlowId;

  const railColor = backendColor(resolvedFlow?.participants?.[0]?.backend);

  return (
    <div
      className={
        'relative grid items-center gap-3 rounded-lg px-3.5 py-2.5 transition-colors ' +
        (selected ? 'bg-card hover:bg-card-strong' : 'bg-card/40 opacity-60 hover:opacity-90')
      }
      style={{ gridTemplateColumns: '18px 1fr auto' }}
    >
      {/* left accent rail — the resolved flow's backend tint, like the
          participant cards. Quiet when the row is deselected. */}
      <span
        className="absolute left-0 top-2 bottom-2 w-[3px] rounded-full"
        style={{ background: selected && resolvedFlow ? railColor : 'var(--c-card-border)' }}
      />
      <button
        onClick={() => toggle(candidateId)}
        className={
          'w-[18px] h-[18px] rounded grid place-items-center text-[11px] text-white border ' +
          (selected ? 'bg-accent-600 border-accent-600' : 'border-card-border-strong')
        }
      >
        {selected ? '✓' : ''}
      </button>

      <div className="min-w-0" title={candidate.note || candidate.prompt}>
        <div className="flex items-baseline gap-2">
          <span className="font-medium text-[13px] text-ink truncate">{candidate.title}</span>
          {candidate.size && (
            <span
              className={
                'text-[10px] rounded-full px-1.5 font-semibold flex-none ' +
                (candidate.size === 'small'
                  ? 'text-green-400/90 bg-green-400/10'
                  : 'text-amber-400/90 bg-amber-400/10')
              }
            >
              {candidate.size}
            </span>
          )}
        </div>
        <div className="text-xs text-ink-faint truncate mt-0.5">{candidate.prompt}</div>
      </div>

      <div className="flex items-center gap-2">
        <FlowSelect
          flows={flows}
          value={resolvedFlowId}
          onChange={(id) => setCandidateFlow(candidateId, id)}
          placeholder="— none —"
          dim={!selected}
        />
        {/* Only call out a deliberate override; the common "default" case
            stays quiet rather than tagging every row. */}
        {overriding ? (
          <span className="text-[9.5px] uppercase tracking-wide font-bold px-1.5 py-0.5 rounded text-accent bg-accent/10">
            override
          </span>
        ) : (
          <span className="w-[52px]" />
        )}
      </div>
    </div>
  );
}

function FlowSelect({
  flows,
  value,
  onChange,
  placeholder,
  dim,
}: {
  flows: Flow[];
  value: string | null;
  onChange: (id: string | null) => void;
  placeholder: string;
  dim?: boolean;
}) {
  return (
    <select
      value={value ?? ''}
      onChange={(e) => onChange(e.target.value || null)}
      className={
        'text-xs bg-card-strong rounded-md px-2 py-1.5 text-ink min-w-[170px] border-0 outline-none focus:bg-surface-elevated ' +
        (dim ? 'opacity-60' : '')
      }
    >
      <option value="">{placeholder}</option>
      {flows.map((f) => (
        <option key={f.id} value={f.id}>
          {f.name}
        </option>
      ))}
    </select>
  );
}

// ============================ ③ Queue (live ledger) ==================

function QueuePane({
  flowById,
  batches,
  width,
  setDraft,
}: {
  flowById: Map<string, Flow>;
  batches: Orchestration[];
  /// Fixed column width while composing. Omitted on the idle stage, where the
  /// ledger is the whole screen.
  width?: number;
  /// Only passed on the idle stage, where the empty state doubles as the
  /// tab's front door.
  setDraft?: (v: string) => void;
}) {
  const full = width === undefined;
  const [filter, setFilter] = useState<RunFilter>(null);
  const tally = tallyOf(batches);
  const finished = batches.filter((b) => b.completedAt);

  // A batch awaiting approval is an obligation, not a list entry — it renders
  // whole, filter or no filter, or a "10 done" view would quietly bury a
  // parked proposal that is waiting on a decision.
  const visible = filter
    ? batches.filter(
        (b) =>
          isOrchestrationAwaitingApproval(b) || b.items.some((i) => matchesFilter(i, filter)),
      )
    : batches;

  const clearFinished = () => {
    for (const b of finished) void window.overcli.invoke('orchestrator:delete', { id: b.id });
  };

  return (
    <section
      style={full ? undefined : { width }}
      className={
        'flex flex-col min-h-0 ' + (full ? 'flex-1' : 'flex-none bg-surface-muted/40')
      }
    >
      {/* Lives outside the scroll container, so it stays put without
          `sticky`. */}
      {full && batches.length > 0 && (
        <RunsBar
          batches={batches}
          tally={tally}
          filter={filter}
          setFilter={setFilter}
          finishedCount={finished.length}
          onClearFinished={clearFinished}
        />
      )}
      <div className="flex flex-col min-h-0 flex-1">
        {!full && (
          <PaneHead step={3} title="Flow runs">
            <Tally {...tally} />
          </PaneHead>
        )}
        <div
          className={
            'flex-1 overflow-y-auto pb-3 min-h-0 ' + (full ? `pt-3 ${IDLE_PAD}` : 'px-4')
          }
        >
          {batches.length === 0 ? (
            full && setDraft ? (
              <ProducerEmptyState setDraft={setDraft} />
            ) : (
              <div className="text-sm text-ink-faint mt-3">
                Nothing launched yet. Map asks on the left and hit Launch — they'll
                appear here as they run.
              </div>
            )
          ) : (
            <div className="space-y-4">
              {visible.map((b) => (
                <BatchLedger
                  key={b.id}
                  batch={b}
                  flowById={flowById}
                  filter={isOrchestrationAwaitingApproval(b) ? null : filter}
                />
              ))}
            </div>
          )}
        </div>
      </div>
    </section>
  );
}

function BatchLedger({
  batch,
  flowById,
  filter,
}: {
  batch: Orchestration;
  flowById: Map<string, Flow>;
  /// Narrows which rows render. The head's counts stay whole either way —
  /// "2/3 done" has to mean the batch, not the slice you're looking at.
  filter?: RunFilter;
}) {
  const abort = (id: string) => void window.overcli.invoke('orchestrator:abort', { id });
  const del = (id: string) => void window.overcli.invoke('orchestrator:delete', { id });
  const retryAll = (id: string) => void window.overcli.invoke('orchestrator:retry', { id });

  const running = batch.items.filter((i) => i.status === 'running').length;
  const paused = batch.items.filter((i) => i.status === 'paused').length;
  const done = batch.items.filter((i) => i.status === 'done').length;
  const retryable = batch.items.filter(
    (i) => i.status === 'failed' || i.status === 'cancelled',
  ).length;
  const active = !batch.completedAt;
  const awaiting = isOrchestrationAwaitingApproval(batch);

  // Which parked items the user has kept. Local, not persisted: it's a
  // decision in progress, and it's resolved the moment they hit Approve.
  const [declined, setDeclined] = useState<Set<string>>(() => new Set());
  const [approving, setApproving] = useState(false);
  const proposed = batch.items.filter((i) => i.status === 'proposed');
  const keeping = proposed.filter((i) => !declined.has(i.candidate.id));
  // A schedule with `autoApprove` set launches its first N and parks the
  // overflow, so a batch can be half-running and half-waiting. The banner has
  // to say so — "Nothing has run yet" would be a lie, and "Discard all" would
  // read as "drop these proposals" while actually killing live worktrees.
  const alreadyLaunched = batch.items.length - proposed.length;

  async function approve(): Promise<void> {
    if (approving) return;
    setApproving(true);
    try {
      await window.overcli.invoke('orchestrator:approveBatch', {
        id: batch.id,
        approve: keeping.map((i) => ({ candidateId: i.candidate.id })),
      });
    } finally {
      setApproving(false);
    }
  }

  /// Decline every parked item without touching the ones already in flight.
  /// An empty approve list cancels exactly the `proposed` items, which is what
  /// `abort` cannot do — it takes the running children down with them.
  async function discardParked(): Promise<void> {
    if (approving) return;
    setApproving(true);
    try {
      await window.overcli.invoke('orchestrator:approveBatch', { id: batch.id, approve: [] });
    } finally {
      setApproving(false);
    }
  }

  return (
    <div>
      {awaiting && (
        <div className="mb-2 rounded-lg border border-violet-400/40 bg-violet-500/10 px-3 py-2.5">
          <div className="text-[13px] text-ink">
            <span className="font-semibold">{proposed.length}</span>{' '}
            {proposed.length === 1 ? 'ask' : 'asks'} proposed
            {batch.origin?.kind === 'schedule' && (
              <span className="text-ink-muted"> by {batch.origin.scheduleName}</span>
            )}
            .{' '}
            {alreadyLaunched > 0
              ? `${alreadyLaunched} already launched — these were over the auto-launch cap.`
              : 'Nothing has run yet.'}
          </div>
          <div className="mt-2 flex items-center gap-2">
            <button
              onClick={() => void approve()}
              disabled={approving || keeping.length === 0}
              className="text-[11px] px-2.5 py-1 rounded-md bg-accent text-white hover:opacity-90 disabled:opacity-40"
            >
              {approving
                ? 'Launching…'
                : `Launch ${keeping.length} of ${proposed.length}`}
            </button>
            <button
              onClick={() =>
                void (alreadyLaunched > 0
                  ? discardParked()
                  : window.overcli.invoke('orchestrator:abort', { id: batch.id }))
              }
              className="text-[11px] px-2.5 py-1 rounded-md border border-card-strong text-ink-muted hover:bg-white/5"
            >
              {alreadyLaunched > 0 ? 'Discard the rest' : 'Discard all'}
            </button>
            <span className="text-[11px] text-ink-faint ml-auto">
              Untick anything you don&apos;t want.
            </span>
          </div>
        </div>
      )}
      <div className="flex items-center gap-2 mb-1.5">
        <div className="text-[11px] uppercase tracking-wide text-ink-faint font-bold">
          {batch.title} · {done}/{batch.items.length} done
          {running > 0 && ` · ${running} running`}
          {paused > 0 && ` · ${paused} paused`}
        </div>
        <div className="flex-1" />
        {retryable > 0 && (
          <button
            className="text-[11px] text-ink-faint hover:text-accent"
            onClick={() => retryAll(batch.id)}
            title="Re-queue every failed or cancelled item in this batch"
          >
            ↻ Retry {retryable} failed
          </button>
        )}
        {awaiting ? null : active ? (
          <button className="text-[11px] text-ink-faint hover:text-red-400" onClick={() => abort(batch.id)}>
            Abort batch
          </button>
        ) : (
          <button className="text-[11px] text-ink-faint hover:text-red-400" onClick={() => del(batch.id)}>
            Clear
          </button>
        )}
      </div>
      <div className="space-y-1.5">
        {batch.items
          .map((it, i) => ({ it, i }))
          .filter(({ it }) => matchesFilter(it, filter ?? null))
          .map(({ it, i }) => (
            <LedgerRow
              key={i}
              item={it}
              flowById={flowById}
              orchestrationId={batch.id}
              kept={it.status === 'proposed' ? !declined.has(it.candidate.id) : undefined}
              onToggleKeep={
                it.status === 'proposed'
                  ? () =>
                      setDeclined((prev) => {
                        const next = new Set(prev);
                        if (next.has(it.candidate.id)) next.delete(it.candidate.id);
                        else next.add(it.candidate.id);
                        return next;
                      })
                  : undefined
              }
            />
          ))}
      </div>
    </div>
  );
}

/// The axis you actually triage a ledger on. Not a search box: with a dozen
/// or two items, "what is stuck" is the question, never "which one said foo".
type RunFilter = 'needsYou' | 'running' | 'queued' | 'done' | null;

function matchesFilter(item: OrchestrationItem, filter: RunFilter): boolean {
  switch (filter) {
    case 'needsYou':
      return item.status === 'proposed' || item.status === 'paused' || item.status === 'failed';
    case 'running':
      return item.status === 'running';
    case 'queued':
      return item.status === 'queued';
    case 'done':
      return item.status === 'done';
    default:
      return true;
  }
}

/// Count every item on the ledger by who it is waiting on.
///
/// `failed` belongs under "needs you" and at first wasn't: a failed item has
/// stopped dead and nothing moves until someone hits retry, which is the same
/// obligation a paused or proposed one carries. On a ledger with one paused
/// and four failed items, a count that says "1 needs you" is wrong by five.
/// `cancelled` deliberately does NOT count — it is retryable too, but you
/// already decided against it, and a number that says "needs you" has to mean
/// it or it stops being read.
function tallyOf(batches: Orchestration[]): {
  running: number;
  queued: number;
  needsYou: number;
  done: number;
  total: number;
} {
  const acc = { running: 0, queued: 0, needsYou: 0, done: 0, total: 0 };
  for (const b of batches) {
    for (const i of b.items) {
      acc.total++;
      if (i.status === 'running') acc.running++;
      else if (i.status === 'queued') acc.queued++;
      else if (i.status === 'done') acc.done++;
      else if (i.status === 'proposed' || i.status === 'paused' || i.status === 'failed') {
        acc.needsYou++;
      }
    }
  }
  return acc;
}

/// The idle stage's page header.
///
/// Deliberately NOT another `text-[11px] uppercase` label. That idiom marks a
/// region inside a pane, and every batch head in the ledger below already uses
/// it — rendering the page head identically to its own children is what made
/// the stage read as a bare list bolted under a search box. This is the
/// missing level above them, so it breaks the idiom exactly once and the batch
/// heads become subordinate.
///
/// It does not repeat the tab name: the title bar already renders
/// "Orchestrator" as the active nav pill, and spending 50px to say it twice is
/// how a working tool turns into a dashboard.
///
/// Every count here is a filter. A number you cannot act on is a run row given
/// up for decoration — and when two thirds of a busy ledger has finished,
/// dropping those rows is the single biggest thing this bar can do for the
/// runs the user actually came to watch.
function RunsBar({
  batches,
  tally,
  filter,
  setFilter,
  finishedCount,
  onClearFinished,
}: {
  batches: Orchestration[];
  tally: ReturnType<typeof tallyOf>;
  filter: RunFilter;
  setFilter: (f: RunFilter) => void;
  finishedCount: number;
  onClearFinished: () => void;
}) {
  const shown = filter
    ? batches.reduce(
        (n, b) =>
          n +
          (isOrchestrationAwaitingApproval(b)
            ? b.items.length
            : b.items.filter((i) => matchesFilter(i, filter)).length),
        0,
      )
    : tally.total;

  const chips: Array<{
    key: Exclude<RunFilter, null>;
    n: number;
    label: string;
    cls: string;
    /// 'pulse' borrows the running rail's animation; a class paints a static
    /// dot; absent means no dot at all.
    dot?: 'pulse' | string;
    tip: string;
  }> = [
    {
      key: 'needsYou',
      n: tally.needsYou,
      label: `${tally.needsYou} ${tally.needsYou === 1 ? 'needs' : 'need'} you`,
      // Paired light/dark tints rather than the bare `text-amber-400` a status
      // word uses: this sits on a filled band, and amber-400 on the light
      // theme's surface-muted is unreadable.
      cls: 'text-amber-600 dark:text-amber-400 font-semibold',
      dot: 'bg-amber-500 dark:bg-amber-400',
      tip: 'Paused, failed, or waiting for your approval — show only these',
    },
    {
      key: 'running',
      n: tally.running,
      label: `${tally.running} running`,
      cls: 'text-green-600 dark:text-green-400',
      dot: 'pulse',
      tip: 'Show only the runs in flight',
    },
    {
      key: 'queued',
      n: tally.queued,
      label: `${tally.queued} queued`,
      cls: 'text-ink-faint',
      tip: 'Waiting for a free slot — show only these',
    },
    {
      key: 'done',
      n: tally.done,
      label: `${tally.done} done`,
      // Not the accent `StatusLabel` gives a done row: up here it would
      // compete with amber for the eye, and "done" is the least urgent thing
      // in the bar.
      cls: 'text-ink-muted',
      tip: 'Show only the runs that finished',
    },
  ];

  // No fill. The band was there to separate this header from the composer
  // above it, and space does that better — a filled strip a third of the way
  // down the page reads as a toolbar bolted on, where the title now simply
  // sits above its own list. The hairline is all that's left, and it's there
  // to tie the header to the rows rather than to fence it off from them.
  return (
    <div className={'flex-none border-b border-card ' + IDLE_PAD}>
      <div className="flex items-center gap-3 pb-2.5">
        <h2 className="text-[15px] font-semibold text-ink m-0 tracking-tight">Flow runs</h2>
        <span className="text-xs text-ink-faint hidden lg:inline">
          {filter
            ? `Showing ${shown} of ${tally.total}`
            : `${tally.total} ${tally.total === 1 ? 'ask' : 'asks'}` +
              (batches.length > 1 ? ` in ${batches.length} batches` : '')}
        </span>
        <div className="flex-1" />
        {/* A count of zero renders nothing rather than "0 queued" — the
            absence says it, and an empty count is a chip you can't press. */}
        {chips
          .filter((c) => c.n > 0)
          .map((c) => (
            <button
              key={c.key}
              title={c.tip}
              aria-pressed={filter === c.key}
              onClick={() => setFilter(filter === c.key ? null : c.key)}
              className={
                'flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] transition-colors ' +
                (filter === c.key
                  ? 'palette-chip-active'
                  : 'border-transparent hover:bg-card-strong')
              }
            >
              {c.dot === 'pulse' ? (
                <span
                  className="w-1.5 h-1.5 rounded-full flex-none animate-pulse"
                  style={{ background: 'var(--c-running-pulse)' }}
                />
              ) : c.dot ? (
                <span className={'w-1.5 h-1.5 rounded-full flex-none ' + c.dot} />
              ) : null}
              <span className={c.cls}>{c.label}</span>
            </button>
          ))}
        {finishedCount > 0 && (
          <button
            onClick={onClearFinished}
            title="Remove finished batches from this list. Their worktrees and branches stay."
            className="text-[11px] text-ink-faint hover:text-red-400 whitespace-nowrap"
          >
            Clear {finishedCount} finished
          </button>
        )}
      </div>
    </div>
  );
}

/// One-line state of everything on the ledger, for the narrow composing
/// column where the bar above has no room to live. Ordered by who it's waiting
/// on: the things blocked on the user first, then the machine's own backlog.
function Tally({ running, queued, needsYou }: ReturnType<typeof tallyOf>) {
  const parts: Array<{ key: string; text: string; cls: string }> = [];
  if (needsYou > 0) {
    parts.push({
      key: 'needs',
      text: `${needsYou} ${needsYou === 1 ? 'needs' : 'need'} you`,
      cls: 'text-amber-400 font-semibold',
    });
  }
  if (running > 0) {
    parts.push({ key: 'running', text: `${running} running`, cls: 'text-green-400' });
  }
  if (queued > 0) parts.push({ key: 'queued', text: `${queued} queued`, cls: 'text-ink-faint' });
  if (parts.length === 0) return null;
  return (
    <span className="flex items-center gap-1.5 text-xs">
      {parts.map((p, i) => (
        <span key={p.key} className="flex items-center gap-1.5">
          {i > 0 && <span className="text-ink-faint">·</span>}
          <span className={p.cls}>{p.text}</span>
        </span>
      ))}
    </span>
  );
}

/// Status → rail tint for ledger cards. Mirrors the candidate cards' left
/// rail, but colored by run status rather than flow backend.
function statusRail(status: OrchestrationItem['status']): string {
  switch (status) {
    case 'running':
      return 'var(--c-running-pulse, #16a34a)';
    case 'paused':
      return '#f0a83d';
    case 'proposed':
      return '#a78bfa';
    case 'done':
      return 'var(--c-accent)';
    case 'failed':
      return '#ef4444';
    default:
      return 'var(--c-card-border)';
  }
}

function LedgerRow({
  item,
  flowById,
  orchestrationId,
  kept,
  onToggleKeep,
}: {
  item: OrchestrationItem;
  flowById: Map<string, Flow>;
  orchestrationId: string;
  /// Set only for a `proposed` item: whether it's still in the approval set.
  kept?: boolean;
  onToggleKeep?: () => void;
}) {
  const setActiveRun = useFlowsStore((s) => s.setActiveRun);
  const setDetailMode = useStore((s) => s.setDetailMode);
  const flow = flowById.get(item.flowId);
  const retryable = item.status === 'failed' || item.status === 'cancelled';

  const openRun = () => {
    if (!item.runId) return;
    setActiveRun(item.runId);
    setDetailMode('flows');
  };

  const retry = () =>
    void window.overcli.invoke('orchestrator:retry', {
      id: orchestrationId,
      candidateId: item.candidate.id,
    });

  return (
    <div
      className={
        'relative grid items-center gap-2.5 rounded-lg bg-card px-3.5 py-2 hover:bg-card-strong transition-colors ' +
        (kept === false ? 'opacity-45' : '')
      }
      // The flow column flexes rather than sitting at a fixed 112px: the same
      // row renders in a narrow side column while composing and across the
      // full idle stage, and "Ticket-Driven Cypress…" should stop truncating
      // when there is obviously room for it.
      style={{ gridTemplateColumns: 'minmax(0, 1fr) minmax(112px, 0.22fr) 96px' }}
    >
      <span
        className={
          'absolute left-0 top-2 bottom-2 w-[3px] rounded-full ' +
          (item.status === 'running' ? 'animate-pulse' : '')
        }
        style={{ background: statusRail(item.status) }}
      />
      <div className="flex items-center gap-2 min-w-0">
        {onToggleKeep && (
          <input
            type="checkbox"
            checked={kept ?? true}
            onChange={onToggleKeep}
            title="Include this ask when you launch the batch"
            className="flex-none"
          />
        )}
        <button
          className="text-left font-medium text-[13px] text-ink truncate hover:text-accent disabled:hover:text-ink"
          onClick={openRun}
          disabled={!item.runId}
          title={item.candidate.prompt}
        >
          {item.candidate.title}
        </button>
      </div>
      <span
        className="text-xs text-ink-muted flex items-center gap-1.5 truncate"
        title={item.branchName ? `branch ${item.branchName}` : undefined}
      >
        {flow && (
          <span
            className="w-2 h-2 rounded-full flex-none"
            style={{ background: backendColor(flow.participants?.[0]?.backend) }}
          />
        )}
        {flow?.name ?? item.flowId}
      </span>
      {retryable ? (
        <button
          onClick={retry}
          className="text-xs font-medium text-right text-ink-faint hover:text-accent whitespace-nowrap"
          title={item.note ? `${item.note} — click to retry` : 'Retry this item'}
        >
          ↻ retry
        </button>
      ) : item.status === 'paused' ? (
        <button
          onClick={openRun}
          className="text-xs font-medium text-right text-amber-400 hover:text-amber-300 whitespace-nowrap"
          title="Paused at a checkpoint — continue this run in the Flows tab"
        >
          continue →
        </button>
      ) : (
        <StatusLabel item={item} />
      )}
    </div>
  );
}

function StatusLabel({ item }: { item: OrchestrationItem }) {
  const map: Record<string, { text: string; cls: string }> = {
    running: { text: 'running…', cls: 'text-green-400' },
    paused: { text: 'paused', cls: 'text-amber-400' },
    proposed: { text: 'proposed', cls: 'text-violet-400' },
    queued: { text: 'queued', cls: 'text-ink-muted' },
    done: { text: 'done', cls: 'text-accent' },
    failed: { text: 'failed', cls: 'text-red-400' },
    cancelled: { text: 'cancelled', cls: 'text-ink-faint' },
  };
  const v = map[item.status] ?? map.queued;
  return (
    <span
      className={`text-xs font-semibold text-right whitespace-nowrap ${v.cls}`}
      title={item.note ?? undefined}
    >
      {v.text}
    </span>
  );
}

// ============================ shared chrome ==========================

function PaneHead({
  step,
  title,
  hint,
  children,
}: {
  /// Omitted on the idle stage: nothing is mid-sequence there, so a number
  /// would be decoration rather than a position in a process.
  step?: number;
  title: string;
  hint?: string;
  children?: React.ReactNode;
}) {
  return (
    <div className="flex items-center gap-2.5 px-4 py-2.5 flex-none">
      {step !== undefined && <StepBadge n={step} />}
      <h2 className="text-[11px] uppercase tracking-wider text-ink font-bold m-0">{title}</h2>
      {hint && <span className="text-xs text-ink-faint">{hint}</span>}
      <div className="flex-1" />
      {children}
    </div>
  );
}

function Spinner() {
  return (
    <span className="inline-block w-3.5 h-3.5 border-2 border-ink-faint border-t-transparent rounded-full animate-spin" />
  );
}
