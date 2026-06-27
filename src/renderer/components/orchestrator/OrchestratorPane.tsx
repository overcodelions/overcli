// Orchestrator tab — three stacked panes:
//   ① Ask      — a producer AI turn (with the user's MCPs) → candidate list
//   ② Map      — per-candidate flow + base-branch mapping, with a batch
//                default applied to anything unmapped
//   ③ Launch   — concurrency cap + Launch, then the live batch ledger
//
// The producer is a normal one-shot (orchestrator:propose), NOT the flow
// step machine, so it reaches MCP servers today. Launching hands the mapped
// candidates to orchestrator:startBatch, which fans them out over worktrees
// with a concurrency cap. Launched candidates leave pane ② and appear in the
// pane ③ queue with live status.

import { useEffect, useMemo, useRef, useState } from 'react';

import { useStore } from '../../store';
import { useFlowsStore } from '../../flowsStore';
import { useOrchestratorStore, type ProducerTurn } from '../../orchestratorStore';
import { backendColor } from '../../theme';
import { Markdown } from '../Markdown';
import { ResizableDivider } from '../ResizableDivider';
import type { Flow } from '@shared/flows/schema';
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
    () => Object.values(s.orchestrations).sort((a, b) => b.createdAt - a.createdAt),
    [s.orchestrations],
  );

  // Queue column width — drag the divider to resize, double-click to reset.
  const [queueWidth, setQueueWidth] = useState(560);

  const targetName = targets.find((t) => t.path === s.projectPath)?.name ?? null;

  return (
    <div className="flex flex-col h-full min-h-0 bg-surface text-ink">
      <ProducerPane targets={targets} targetName={targetName} />
      {/* Decision surface (Map, left) and live surface (Queue, right) sit at
          eye level: candidates flow left→right as they launch, so you can keep
          triaging while runs progress instead of scrolling between them. The
          divider is a draggable resize handle. */}
      <div
        className="flex-1 flex min-h-0 border-t"
        style={{ borderTopColor: 'var(--c-card-bg)' }}
      >
        <MapPane flows={flows} flowById={flowById} />
        <ResizableDivider
          width={queueWidth}
          onChange={setQueueWidth}
          minWidth={320}
          maxWidth={900}
          side="right"
        />
        <QueuePane flowById={flowById} batches={batches} width={queueWidth} />
      </div>
    </div>
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
const PRODUCER_EXAMPLES: Array<{ label: string; prompt: string }> = [
  {
    label: 'ProductBoard',
    prompt:
      'Pull the recent ProductBoard insights and pick out the small, self-contained asks I could knock out individually.',
  },
  {
    label: 'GitHub issues',
    prompt:
      'List the open GitHub issues labeled "good first issue" or "papercut" and surface the ones that are a single, low-ambiguity fix.',
  },
  {
    label: 'Linear / Jira',
    prompt:
      'Look at my open Linear tickets in the current cycle and find the small, well-scoped ones that could each be done in one focused change.',
  },
  {
    label: 'Zendesk tickets',
    prompt:
      'Scan recent Zendesk tickets tagged as bugs and pull out the small, reproducible ones that map to a single code fix.',
  },
  {
    label: 'Sentry errors',
    prompt:
      'Look at the top recurring Sentry errors from the last week and find the ones that look like a small, contained fix.',
  },
];

function ProducerPane({ targets, targetName }: { targets: LaunchTarget[]; targetName: string | null }) {
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

  const [draft, setDraft] = useState('');
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

  const projectSelect = (
    <select
      value={projectPath ?? ''}
      onChange={(e) => setProjectPath(e.target.value || null)}
      className="text-xs bg-card-strong rounded-md px-2 py-1 text-ink border-0 outline-none"
      title="Project or workspace the batch runs against"
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
  );

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
        {projectSelect}
      </div>
      {expanded && (
        <ProducerBody
          scrollRef={scrollRef}
          turns={turns}
          proposing={proposing}
          liveText={liveText}
          liveTools={liveTools}
          producerError={producerError}
          draft={draft}
          setDraft={setDraft}
          send={send}
        />
      )}
    </section>
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
  draft,
  setDraft,
  send,
}: {
  scrollRef: React.RefObject<HTMLDivElement>;
  turns: ProducerTurn[];
  proposing: boolean;
  liveText: string;
  liveTools: string[];
  producerError: string | null;
  draft: string;
  setDraft: (v: string) => void;
  send: () => void;
}) {
  return (
    <>
      <div ref={scrollRef} className="overflow-y-auto px-4 pb-2 max-h-[40vh]">
        {turns.length === 0 && !proposing && (
          <div className="max-w-2xl mt-2">
            <div className="text-sm text-ink-faint leading-relaxed">
              Ask the AI to pull a source of requests and find the small,
              self-contained asks. It investigates with whatever tools and MCP
              servers you have connected, then returns a candidate list below.
              Try one of these:
            </div>
            <div className="flex flex-col gap-1.5 mt-3">
              {PRODUCER_EXAMPLES.map((ex) => (
                <button
                  key={ex.label}
                  onClick={() => setDraft(ex.prompt)}
                  className="text-left text-sm px-3 py-2 rounded-lg bg-card hover:bg-card-strong"
                >
                  <span className="text-ink-muted font-medium">{ex.label}</span>
                  <span className="text-ink-faint"> — {ex.prompt}</span>
                </button>
              ))}
            </div>
            <div className="text-xs text-ink-faint mt-2">
              Pick a starter to drop it in the box, then edit and send — or just
              type your own.
            </div>
          </div>
        )}
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
          <div className="text-sm text-ink-faint mt-3">
            No candidates yet — ask the producer above for a list.
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
              <span className="font-medium text-sm text-ink-muted ml-1">Base</span>
              <input
                value={defaultBaseBranch}
                onChange={(e) => setDefaultBaseBranch(e.target.value)}
                placeholder="(repo default)"
                className="text-xs font-mono bg-card-strong rounded-md px-2 py-1.5 text-ink w-32 border-0 outline-none"
              />
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
  const openPr = useOrchestratorStore((s) => s.openPrOnFinish);
  const setOpenPr = useOrchestratorStore((s) => s.setOpenPrOnFinish);
  const startBatch = useOrchestratorStore((s) => s.startBatch);

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
}: {
  flowById: Map<string, Flow>;
  batches: Orchestration[];
  width: number;
}) {
  const runningTotal = batches.reduce(
    (n, b) => n + b.items.filter((i) => i.status === 'running').length,
    0,
  );
  return (
    <section
      style={{ width }}
      className="flex-none flex flex-col min-h-0 bg-surface-muted/40"
    >
      <PaneHead step={3} title="Running flows">
        {runningTotal > 0 && (
          <span className="text-xs text-ink-faint">{runningTotal} in flight</span>
        )}
      </PaneHead>
      <div className="flex-1 overflow-y-auto px-4 pb-3 min-h-0">
        {batches.length === 0 ? (
          <div className="text-sm text-ink-faint mt-3">
            Nothing launched yet. Map asks on the left and hit Launch — they'll
            appear here as they run.
          </div>
        ) : (
          <div className="space-y-4">
            {batches.map((b) => (
              <BatchLedger key={b.id} batch={b} flowById={flowById} />
            ))}
          </div>
        )}
      </div>
    </section>
  );
}

function BatchLedger({
  batch,
  flowById,
}: {
  batch: Orchestration;
  flowById: Map<string, Flow>;
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

  return (
    <div>
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
        {active ? (
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
        {batch.items.map((it, i) => (
          <LedgerRow key={i} item={it} flowById={flowById} orchestrationId={batch.id} />
        ))}
      </div>
    </div>
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
}: {
  item: OrchestrationItem;
  flowById: Map<string, Flow>;
  orchestrationId: string;
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
      className="relative grid items-center gap-2.5 rounded-lg bg-card px-3.5 py-2 hover:bg-card-strong transition-colors"
      style={{ gridTemplateColumns: '1fr 128px 78px' }}
    >
      <span
        className={
          'absolute left-0 top-2 bottom-2 w-[3px] rounded-full ' +
          (item.status === 'running' ? 'animate-pulse' : '')
        }
        style={{ background: statusRail(item.status) }}
      />
      <button
        className="text-left font-medium text-[13px] text-ink truncate hover:text-accent disabled:hover:text-ink"
        onClick={openRun}
        disabled={!item.runId}
        title={item.candidate.prompt}
      >
        {item.candidate.title}
      </button>
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
          className="text-xs font-medium text-right text-ink-faint hover:text-accent"
          title={item.note ? `${item.note} — click to retry` : 'Retry this item'}
        >
          ↻ retry
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
    paused: { text: 'paused · continue in Flows', cls: 'text-amber-400' },
    queued: { text: 'queued', cls: 'text-ink-muted' },
    done: { text: 'done', cls: 'text-accent' },
    failed: { text: 'failed', cls: 'text-red-400' },
    cancelled: { text: 'cancelled', cls: 'text-ink-faint' },
  };
  const v = map[item.status] ?? map.queued;
  return (
    <span className={`text-xs font-semibold text-right ${v.cls}`} title={item.note ?? undefined}>
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
  step: number;
  title: string;
  hint?: string;
  children?: React.ReactNode;
}) {
  return (
    <div className="flex items-center gap-2.5 px-4 py-2.5 flex-none">
      <StepBadge n={step} />
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
