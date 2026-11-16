// Bird's-eye view of a flow's pipeline. Renders the user prompt + each
// step as a pill with arrows in between, showing artifact handoff. Click
// a pill to scroll the corresponding step card into view in the editor.
//
// Visual model:
//
//   [user prompt] → [plan]──plan.md──→ [build]──diff──→ [review]──review.md──→ [tests]
//                                                                                  │
//                                                                              diff │
//                                                                                  ▼
//                                                                       ⏸  [push]
//
// Pauses are surfaced with a ⏸ glyph BEFORE the step. Steps with rebound
// get a ↻ glyph. Steps with on_fail.goto get a dashed loop drawn from the
// failing step back to its target, measured against the live layout so it
// follows the pills when the row wraps.

import { useId, useLayoutEffect, useMemo, useRef, useState } from 'react';

import { resolveStepModel, type Flow, type FlowStep } from '@shared/flows/schema';
import { modelTier } from '@shared/modelCatalog';
import {
  compactModelLabel,
  compactStepModel,
  ROLE_VERB,
  stepOrdinal,
  stepWrites,
} from './flowSpine';

const TIER_COLOR: Record<string, string> = {
  premium: 'border-sky-400/60 bg-sky-500/15 text-sky-800 dark:text-sky-100',
  local: 'border-emerald-400/60 bg-emerald-500/15 text-emerald-800 dark:text-emerald-100',
  other: 'border-[color-mix(in_srgb,var(--c-card-border)_30%,transparent)] bg-card text-ink',
};

function tierOf(flow: Flow, step: FlowStep): keyof typeof TIER_COLOR {
  const { backend } = resolveStepModel(flow, step);
  if (backend === 'ollama') return 'local';
  if (
    backend === 'claude' ||
    backend === 'codex' ||
    backend === 'gemini' ||
    backend === 'copilot'
  ) {
    return 'premium';
  }
  return 'other';
}

// Model label formatting lives in flowSpine.ts — it's a pure string
// transform shared with the launch panel, and keeping it there is what
// lets it be tested without a DOM.
const compactModel = compactStepModel;

interface PipelineDiagramProps {
  flow: Flow;
  /// Step id whose card should be scrolled into view when a pill is
  /// clicked. The editor passes a stable selector for each step card.
  onStepClick?: (stepId: string) => void;
  /// How to lay the steps out. `wrap` is the wide editor view — pills
  /// flowing left to right. `stack` is for a narrow column: below about
  /// 500px the wrapping row folds into a snake and stops reading as a
  /// sequence at all, so the drawer gets one step per line instead.
  layout?: 'wrap' | 'stack';
  /// Whether the diagram draws its own "Pipeline" heading and card. The
  /// drawer supplies both, and two headings in a row read as a bug.
  chrome?: boolean;
}

export function FlowPipelineDiagram({
  flow,
  onStepClick,
  layout = 'wrap',
  chrome = true,
}: PipelineDiagramProps) {
  const retryEdges = useMemo<RetryEdge[]>(() => {
    // For each step with on_fail.goto, capture (from, target) so the wrap
    // layout can draw the loop back.
    return flow.steps
      .filter((s) => s.onFail?.action === 'goto' && s.onFail.target)
      .map((s) => {
        const f = s.onFail as {
          action: 'goto';
          target: string;
          maxRetries: number;
        };
        return { from: s.id, to: f.target, maxRetries: f.maxRetries };
      });
  }, [flow.steps]);

  if (flow.steps.length === 0) {
    return (
      <div className="rounded-md border border-dashed border-[color-mix(in_srgb,var(--c-card-border)_30%,transparent)] p-4 text-xs text-ink-faint text-center">
        Add a step to see the pipeline.
      </div>
    );
  }

  return (
    <div className={chrome ? 'rounded-xl bg-card p-4 shadow-sm' : ''}>
      {chrome && (
        <div className="text-[11px] uppercase tracking-wider text-ink-faint mb-2">Pipeline</div>
      )}
      {layout === 'stack' ? (
        <StepStack flow={flow} onStepClick={onStepClick} />
      ) : (
        <StepRow flow={flow} onStepClick={onStepClick} retryEdges={retryEdges} />
      )}
    </div>
  );
}

interface RetryEdge {
  from: string;
  to: string;
  maxRetries: number;
}

interface EdgeGeom {
  key: string;
  d: string;
  labelX: number;
  labelY: number;
  label: string;
}

/// How far below a row the first loop runs, and how much further each
/// extra loop drops so two loops never share a line.
const LOOP_DEPTH = 24;
const LOOP_STEP = 18;
/// The loop's label sits just under its line, never on it — a dashed line
/// through text reads as strikethrough.
const LABEL_GAP = 10;
/// The lane under a row's loops that carries the handoff from the end of
/// one row to the start of the next. Below the loops rather than among
/// them, so the bridge runs clear of every loop's label.
const BRIDGE_ROOM = 20;

interface BridgeGeom {
  key: string;
  d: string;
}

/// The wide layout: pills flowing left to right, with every on_fail.goto
/// drawn as a dashed loop back to its target, and every wrap bridged by a
/// line from the end of one row to the start of the next. Both are
/// measured from the rendered pills rather than computed from indices,
/// because the row wraps and only the browser knows where each pill landed.
function StepRow({
  flow,
  onStepClick,
  retryEdges,
}: {
  flow: Flow;
  onStepClick?: (stepId: string) => void;
  retryEdges: RetryEdge[];
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const pillRefs = useRef(new Map<string, HTMLButtonElement>());
  const groupRefs = useRef(new Map<string, HTMLDivElement>());
  const [edges, setEdges] = useState<EdgeGeom[]>([]);
  const [bridges, setBridges] = useState<BridgeGeom[]>([]);
  /// Steps whose outgoing arrow is replaced by a bridge. Their arrow is
  /// hidden, not removed: removing it would narrow the row, which could
  /// pull the next step back up, which would bring the arrow back.
  const [bridged, setBridged] = useState<ReadonlySet<string>>(new Set());
  const markerId = useId().replace(/:/g, '');

  // Room under each row for its loops. Reserved from the edge count, not
  // from the measurement, so the layout doesn't jump once it's measured.
  const loopRoom = retryEdges.length
    ? LOOP_DEPTH + (retryEdges.length - 1) * LOOP_STEP + LABEL_GAP + 14
    : 0;

  useLayoutEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const measure = () => {
      const c = el.getBoundingClientRect();
      const rel = (r: DOMRect) => ({
        left: r.left - c.left,
        right: r.right - c.left,
        top: r.top - c.top,
        bottom: r.bottom - c.top,
        cx: r.left + r.width / 2 - c.left,
        cy: r.top + r.height / 2 - c.top,
      });
      const pill = (id: string) => {
        const n = pillRefs.current.get(id);
        return n ? rel(n.getBoundingClientRect()) : null;
      };

      const nextBridges: BridgeGeom[] = [];
      const nextBridged = new Set<string>();
      for (let i = 0; i < flow.steps.length - 1; i++) {
        const fromId = flow.steps[i].id;
        const ga = groupRefs.current.get(fromId);
        const gb = groupRefs.current.get(flow.steps[i + 1].id);
        if (!ga || !gb) continue;
        const A = rel(ga.getBoundingClientRect());
        const B = rel(gb.getBoundingClientRect());
        if (B.top < A.top + 4) continue; // same row — the arrow is enough
        const line = ga.querySelector('[data-handoff-line]');
        const L = line ? rel(line.getBoundingClientRect()) : null;
        const sx = L ? L.left + 2 : A.right;
        const sy = L ? L.cy : A.cy;
        const dropX = A.right - 2;
        const laneY = A.bottom + loopRoom + BRIDGE_ROOM / 2;
        const entryX = B.left - 12;
        nextBridges.push({
          key: fromId,
          d: roundedPath(
            [
              [sx, sy],
              [dropX, sy],
              [dropX, laneY],
              [entryX, laneY],
              [entryX, B.cy],
              [B.left - 1, B.cy],
            ],
            8,
          ),
        });
        nextBridged.add(fromId);
      }

      const nextEdges: EdgeGeom[] = [];
      retryEdges.forEach((edge, i) => {
        const a = pill(edge.from);
        const b = pill(edge.to);
        if (!a || !b) return;
        const depth = LOOP_DEPTH + i * LOOP_STEP;
        // Leave and arrive a little off-centre so a loop's two legs don't
        // sit on top of another loop's legs at a shared pill.
        const fx = a.cx + 8;
        const tx = b.cx - 8;
        let pts: [number, number][];
        let y: number;
        if (Math.abs(a.bottom - b.bottom) < 4) {
          // Same row: drop under it, run across, come back up.
          y = Math.max(a.bottom, b.bottom) + depth;
          pts = [
            [fx, a.bottom],
            [fx, y],
            [tx, y],
            [tx, b.bottom + 2],
          ];
        } else if (a.bottom > b.bottom) {
          // Target on an earlier row: rise into that row's loop lane.
          y = b.bottom + depth;
          pts = [
            [fx, a.top],
            [fx, y],
            [tx, y],
            [tx, b.bottom + 2],
          ];
        } else {
          // Target on a later row: run in this row's loop lane, then down.
          y = a.bottom + depth;
          pts = [
            [fx, a.bottom],
            [fx, y],
            [tx, y],
            [tx, b.top - 2],
          ];
        }
        nextEdges.push({
          key: `${edge.from}-${edge.to}-${i}`,
          d: roundedPath(pts, 8),
          labelX: (fx + tx) / 2,
          labelY: y + LABEL_GAP,
          label: `if ${edge.from} fails → back to ${edge.to}, up to ${edge.maxRetries}×`,
        });
      });

      setEdges(nextEdges);
      setBridges(nextBridges);
      setBridged((prev) =>
        prev.size === nextBridged.size && [...prev].every((id) => nextBridged.has(id))
          ? prev
          : nextBridged,
      );
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    groupRefs.current.forEach((g) => ro.observe(g));
    return () => ro.disconnect();
  }, [retryEdges, flow.steps, loopRoom]);

  return (
    <div
      ref={containerRef}
      className="relative flex flex-wrap items-center gap-x-1"
      style={{ rowGap: loopRoom + BRIDGE_ROOM, paddingBottom: loopRoom }}
    >
      <PromptChip />
      {flow.steps.map((step, idx) => (
        <StepRowEntry
          key={step.id}
          flow={flow}
          step={step}
          isFirst={idx === 0}
          isLast={idx === flow.steps.length - 1}
          bridged={bridged.has(step.id)}
          onClick={() => onStepClick?.(step.id)}
          groupRef={(node) => {
            if (node) groupRefs.current.set(step.id, node);
            else groupRefs.current.delete(step.id);
          }}
          pillRef={(node) => {
            if (node) pillRefs.current.set(step.id, node);
            else pillRefs.current.delete(step.id);
          }}
        />
      ))}
      {(edges.length > 0 || bridges.length > 0) && (
        <svg
          className="absolute inset-0 w-full h-full pointer-events-none overflow-visible"
          aria-hidden
        >
          {/* A marker takes its colour from where it is defined, not from
              the path using it — so each colour group defines its own. */}
          <g className="text-ink-faint">
            <defs>
              <ArrowMarker id={`${markerId}-bridge`} />
            </defs>
            {bridges.map((b) => (
              <path
                key={b.key}
                d={b.d}
                fill="none"
                stroke="currentColor"
                strokeWidth="1.4"
                markerEnd={`url(#${markerId}-bridge)`}
              />
            ))}
          </g>
          <g className="text-amber-600 dark:text-amber-400">
            <defs>
              <ArrowMarker id={`${markerId}-loop`} />
            </defs>
            {edges.map((e) => (
              <path
                key={e.key}
                d={e.d}
                fill="none"
                stroke="currentColor"
                strokeWidth="1.4"
                strokeDasharray="4 3"
                markerEnd={`url(#${markerId}-loop)`}
              />
            ))}
          </g>
        </svg>
      )}
      {edges.map((e) => (
        <span
          key={`${e.key}-label`}
          className="absolute -translate-x-1/2 -translate-y-1/2 whitespace-nowrap px-1.5 text-[10px] leading-none text-amber-700 dark:text-amber-300 pointer-events-none"
          style={{ left: e.labelX, top: e.labelY }}
        >
          {e.label}
        </span>
      ))}
    </div>
  );
}

function ArrowMarker({ id }: { id: string }) {
  return (
    <marker
      id={id}
      viewBox="0 0 10 10"
      refX="8"
      refY="5"
      markerWidth="7"
      markerHeight="7"
      orient="auto-start-reverse"
    >
      <path d="M1 1 L9 5 L1 9" fill="none" stroke="currentColor" strokeWidth="1.6" />
    </marker>
  );
}

/// An orthogonal polyline with its corners rounded off.
function roundedPath(pts: [number, number][], r: number): string {
  let d = `M ${pts[0][0]} ${pts[0][1]}`;
  for (let i = 1; i < pts.length - 1; i++) {
    const [px, py] = pts[i - 1];
    const [cx, cy] = pts[i];
    const [nx, ny] = pts[i + 1];
    const d1 = Math.hypot(cx - px, cy - py);
    const d2 = Math.hypot(nx - cx, ny - cy);
    if (d1 === 0 || d2 === 0) {
      d += ` L ${cx} ${cy}`;
      continue;
    }
    const rr = Math.min(r, d1 / 2, d2 / 2);
    const ax = cx + ((px - cx) / d1) * rr;
    const ay = cy + ((py - cy) / d1) * rr;
    const bx = cx + ((nx - cx) / d2) * rr;
    const by = cy + ((ny - cy) / d2) * rr;
    d += ` L ${ax} ${ay} Q ${cx} ${cy} ${bx} ${by}`;
  }
  const [lx, ly] = pts[pts.length - 1];
  return `${d} L ${lx} ${ly}`;
}

function PromptChip() {
  return (
    <>
      <div className="rounded-full bg-card-strong px-3 py-1.5 text-[11px] text-ink-muted shadow-sm">
        <span className="text-ink-faint">your request</span>
      </div>
      <Arrow />
    </>
  );
}

function StepRowEntry({
  flow,
  step,
  isFirst,
  isLast,
  bridged = false,
  onClick,
  pillRef,
  groupRef,
}: {
  flow: Flow;
  step: FlowStep;
  isFirst: boolean;
  isLast: boolean;
  /// The next step wrapped to a new row; a drawn bridge replaces the arrow.
  bridged?: boolean;
  onClick: () => void;
  pillRef?: (node: HTMLButtonElement | null) => void;
  groupRef?: (node: HTMLDivElement | null) => void;
}) {
  const tier = tierOf(flow, step);
  const model = compactModel(flow, step);
  const resolved = resolveStepModel(flow, step);
  // One unit that never breaks inside: the pause, the pill and the arrow
  // out of it. When the row wraps, whole steps move to the next line, so a
  // line never opens on a stray arrow or an orphaned output chip.
  return (
    <div ref={groupRef} className="flex items-center gap-x-1 self-stretch">
      {step.pauseBefore && !isFirst && (
        <>
          <PauseGlyph />
          <Arrow />
        </>
      )}
      <button
        ref={pillRef}
        onClick={onClick}
        className={
          'rounded-lg border px-3.5 py-2 text-xs shadow-sm hover:scale-[1.03] transition active:scale-100 min-w-[120px] ' +
          TIER_COLOR[tier]
        }
        title={`${resolved.backend}:${resolved.model} · ${step.role}`}
      >
        <div className="flex items-center justify-center gap-1.5">
          {step.rebound && <ReboundGlyph />}
          <span className="font-semibold">{step.id}</span>
        </div>
        <div className="text-[10px] opacity-80 mt-0.5 text-center">{model}</div>
      </button>
      {/* Only show the artifact arrow when there's a NEXT step to flow into.
          The last step's output goes to the user, not another step — we
          render it as a labeled terminator instead. */}
      {!isLast && <ArtifactArrow name={step.output} bridged={bridged} />}
      {isLast && <TerminatorArrow name={step.output} />}
    </div>
  );
}

function Arrow() {
  return (
    <svg width="20" height="14" viewBox="0 0 20 14" className="text-ink-faint flex-shrink-0">
      <path d="M2 7 H16" stroke="currentColor" strokeWidth="1.4" />
      <path d="M14 3 L18 7 L14 11" stroke="currentColor" strokeWidth="1.4" fill="none" />
    </svg>
  );
}

function ArtifactArrow({ name, bridged = false }: { name: string; bridged?: boolean }) {
  // Render as a small badge BELOW the arrow, vertically separated so it
  // can't visually bleed into the adjacent step pills. The arrow row
  // grows wide enough to fit typical artifact names (plan_review.md,
  // review.md, diff) without their labels overflowing into neighbors.
  return (
    <div className="flex flex-col items-center flex-shrink-0 px-2 gap-1 self-stretch justify-center">
      <svg
        width="56"
        height="14"
        viewBox="0 0 56 14"
        className="text-ink-faint"
        aria-hidden
        data-handoff-line
        style={bridged ? { visibility: 'hidden' } : undefined}
      >
        <path d="M2 7 H50" stroke="currentColor" strokeWidth="1.4" />
        <path d="M48 3 L52 7 L48 11" stroke="currentColor" strokeWidth="1.4" fill="none" />
      </svg>
      <span className="text-[9px] font-mono text-ink-faint whitespace-nowrap leading-none">
        {name}
      </span>
    </div>
  );
}

/// Last step's output flows to the user — render as a labeled "deliverable"
/// chip rather than another in-pipeline arrow.
function TerminatorArrow({ name }: { name: string }) {
  return (
    <div className="flex items-center gap-1.5 flex-shrink-0">
      <svg width="20" height="14" viewBox="0 0 20 14" className="text-emerald-700 dark:text-emerald-300/70">
        <path d="M2 7 H16" stroke="currentColor" strokeWidth="1.4" />
        <path d="M14 3 L18 7 L14 11" stroke="currentColor" strokeWidth="1.4" fill="none" />
      </svg>
      <div className="rounded-full border border-emerald-400/40 bg-emerald-500/10 px-2.5 py-1 text-[10px] text-emerald-700 dark:text-emerald-200 font-mono">
        {name}
      </div>
    </div>
  );
}

function PauseGlyph() {
  return (
    <div
      title="Paused — wait for me here"
      className="rounded border border-amber-400/50 bg-amber-500/15 text-amber-700 dark:text-amber-200 px-1.5 py-0.5 text-[11px]"
    >
      ⏸
    </div>
  );
}

function ReboundGlyph() {
  return (
    <span
      title="Critic loops on this step"
      className="text-[10px] text-purple-700 dark:text-purple-300"
    >
      ↻
    </span>
  );
}

// --- Narrow column layout ------------------------------------------------
//
// One step per band, reading top to bottom:
//
//   ○  your request
//   │
//  (1) survey                                                     ← a band
//      researches                                        sonnet 4.6
//   │  survey.md                                         ← the handoff
//  (2) write-tests
//      writes tests                                   gpt-5.6-terra
//   │  diff
//  (3) review
//      reviews the work                                  sonnet 4.6
//      ────────────────────────────
//      ↻ opus 5 critiques it, up to 2 rounds
//      ↳ if it still fails, back to step 2
//   │  out_3.md   ⏸ waits for you
//  (4) file-and-open-pr …
//   │
//   ●  you get out_4.md
//
// Three things have to survive the fold to one column: the sequence, the
// handoff, and the cycles. The sequence is a numbered bead per step and a
// bounded band beside it, so steps read as objects. The handoff is the gap
// between two bands, carrying the artifact's name. The cycles are said in
// words INSIDE the band they belong to — they are facts about that step,
// not stages of their own. Words rather than drawn arcs on purpose: an arc
// has to be measured against live layout, it cannot say "up to 2 rounds",
// and a flow with four cycles tangles the gutter.
//
// The numbers are not decoration: they are what lets a cycle name where it
// returns to ("back to step 2") in terms the reader can find by eye.

/// The bead's ring answers the one question worth a colour here: is this
/// step going to change my repo? Amber is the app's caution hue, and the
/// same one as the drawer's "Edits your files" chip — the chip says that
/// something writes, these rings say which.
///
/// The model's capability tier deliberately does NOT get a ring. Two
/// meanings on one channel and neither survives, and the tier is spelled
/// out in words on the band anyway.
const WRITE_RING = 'border-amber-500/80 dark:border-amber-400/80';
const READ_RING = 'border-[var(--c-ink-faint)]';

/// Tier names carry the Usage page's colours (StatsPage's TIER_COLOR), so
/// the two screens agree about what "frontier" looks like — but as
/// Tailwind pairs, because those hexes are tuned for a dark background and
/// several of them fall under 2:1 on a light one.
const TIER_TEXT: Record<string, string> = {
  frontier: 'text-purple-600 dark:text-purple-400',
  thinking: 'text-amber-600 dark:text-amber-400',
  standard: 'text-sky-600 dark:text-sky-400',
  fast: 'text-emerald-600 dark:text-emerald-400',
  local: 'text-slate-500 dark:text-slate-400',
};

/// Width of the bead column. The rail runs down its centre, so every
/// connector and endcap uses it too.
const BEAD_COL = 'w-[26px] flex justify-center flex-shrink-0';

function StepStack({
  flow,
  onStepClick,
}: {
  flow: Flow;
  onStepClick?: (stepId: string) => void;
}) {
  const last = flow.steps[flow.steps.length - 1];
  return (
    <ol className="relative flex flex-col">
      {/* ONE line down the whole pipeline, behind the rows, inset by half
          an endcap row so it runs exactly from the first dot's centre to
          the last one's. Drawn per-connector it could not cross the band
          rows, which left a gap under every bead. The rows come later in
          the document, so they paint over it — the beads' own background
          is what makes the line stop at each step. */}
      <span
        className="absolute left-[12.5px] top-[11px] bottom-[11px] w-px bg-[var(--c-ink-faint)] flow-rail"
        aria-hidden
      />
      <li className="relative flex items-center gap-3 h-[22px]">
        <span className={BEAD_COL}>
          <span className="h-[7px] w-[7px] rounded-full border border-[var(--c-ink-faint)] bg-surface-elevated" />
        </span>
        <span className="text-xs text-ink-muted">your request</span>
      </li>
      {flow.steps.map((step, idx) => (
        <StepBand
          key={step.id}
          flow={flow}
          step={step}
          number={idx + 1}
          // The label on the connector above a band is what the step is
          // handed: the previous step's output, or the person's ask.
          incoming={idx === 0 ? null : flow.steps[idx - 1].output}
          isFirst={idx === 0}
          onClick={() => onStepClick?.(step.id)}
        />
      ))}
      <Connector className="h-[26px]" />
      <li className="relative flex items-center gap-3 h-[22px]">
        <span className={BEAD_COL}>
          <span className="h-[7px] w-[7px] rounded-full bg-emerald-400 ring-2 ring-[var(--c-surface-elevated)]" />
        </span>
        <span className="text-xs text-ink-muted">
          you get <span className="font-mono text-ink">{last.output}</span>
        </span>
      </li>
    </ol>
  );
}

/// The gap between two bands. It carries the handoff, and its height is
/// the pause the arrows used to imply — a hairline alone reads as a list.
/// The rail itself runs behind it, so there is nothing to draw here.
function Connector({
  children,
  className = 'h-[34px]',
}: {
  children?: React.ReactNode;
  className?: string;
}) {
  return (
    <li className={'relative flex items-stretch gap-3 ' + className}>
      <span className={BEAD_COL} />
      <span className="flex items-center gap-2.5">{children}</span>
    </li>
  );
}

function StepBand({
  flow,
  step,
  number,
  incoming,
  isFirst,
  onClick,
}: {
  flow: Flow;
  step: FlowStep;
  number: number;
  incoming: string | null;
  isFirst: boolean;
  onClick: () => void;
}) {
  const resolved = resolveStepModel(flow, step);
  const verb = ROLE_VERB[step.role];
  const writes = stepWrites(step);
  const tier = modelTier(resolved.model ?? '');
  const retryTo = step.onFail?.action === 'goto' ? step.onFail.target : null;
  const rebound = step.rebound;
  return (
    <>
      <Connector>
        {incoming && <span className="text-[11px] font-mono text-ink-muted">{incoming}</span>}
        {step.pauseBefore && !isFirst && (
          <span className="inline-flex items-center gap-1.5 text-[11px] text-amber-700 dark:text-amber-200">
            <PauseIcon />
            waits for you
          </span>
        )}
      </Connector>
      <li className="relative flex items-start gap-3">
        {/* Nudged to sit level with the step's NAME rather than with the
            top of its band — the band's padding puts the name's line 9.6px
            below where a top-aligned bead lands, and a bead floating above
            the name it belongs to reads as a mistake. */}
        <span className={BEAD_COL + ' mt-[10px]'}>
          <span
            title={writes ? 'Changes files in your repo' : 'Reads only'}
            className={
              'h-[26px] w-[26px] rounded-full border flex items-center justify-center ' +
              'text-[11px] font-mono text-ink-muted bg-surface-elevated ' +
              (writes ? WRITE_RING : READ_RING)
            }
          >
            {number}
          </span>
        </span>
        <button
          onClick={onClick}
          title={`${resolved.backend}:${resolved.model} · ${step.role}`}
          className="flex-1 min-w-0 text-left rounded-[10px] border border-card bg-[var(--c-surface-muted)] px-3.5 py-3 hover:border-card-strong transition-colors"
        >
          <div className="flex items-baseline gap-2.5">
            <span className="text-sm text-ink leading-snug truncate">{step.id}</span>
            {/* The tier, then the model. Named rather than encoded: a
                coloured word is its own key, so the panel needs no legend
                for it — and "frontier" is the part that decides what a run
                costs, which the model id alone does not say. */}
            <span className="ml-auto flex items-baseline gap-1.5 text-[11px] whitespace-nowrap">
              <span className={TIER_TEXT[tier]}>{tier}</span>
              <span className="text-ink-muted">{compactStepModel(flow, step)}</span>
            </span>
          </div>
          {/* Only when the role has one. A custom step's name is the only
              honest summary of it, and an empty line under it was reading
              as a broken band. */}
          {verb && <div className="text-xs text-ink-muted truncate mt-0.5">{verb}</div>}
          {/* Cycles belong to this step, so they sit inside its band under
              a rule — not as rows of their own, which would read as more
              stages in the sequence. */}
          {(rebound || retryTo) && (
            <div className="mt-2.5 pt-2.5 border-t border-card-strong flex flex-col gap-1.5">
              {rebound && (
                <span className="flex items-center gap-2 text-[11px] text-purple-700 dark:text-purple-300">
                  <LoopIcon />
                  <span>
                    {compactModelLabel(rebound.critic.model)} critiques it, up to{' '}
                    {rebound.maxIters} {rebound.maxIters === 1 ? 'round' : 'rounds'}
                  </span>
                </span>
              )}
              {retryTo && (
                <span className="flex items-center gap-2 text-[11px] text-amber-700 dark:text-amber-300">
                  <ReturnIcon />
                  <span>if it still fails, back to {stepOrdinal(flow, retryTo)}</span>
                </span>
              )}
            </div>
          )}
        </button>
      </li>
    </>
  );
}

// Drawn rather than typed: ⏸ and ↻ are emoji-adjacent code points that
// render in a different weight, and sometimes a different colour, than the
// text beside them.

function PauseIcon() {
  return (
    <svg width="9" height="10" viewBox="0 0 9 10" aria-hidden className="flex-shrink-0">
      <path d="M2 1 V9 M7 1 V9" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}

function LoopIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden className="flex-shrink-0">
      <path
        d="M10 6 A4 4 0 1 1 6 2 L9 2"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
      />
      <path
        d="M7 0.5 L9.5 2 L7 3.5"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
      />
    </svg>
  );
}

function ReturnIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden className="flex-shrink-0">
      <path
        d="M10 2 V6 A2 2 0 0 1 8 8 H2"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
      />
      <path
        d="M4.5 5.5 L2 8 L4.5 10.5"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
      />
    </svg>
  );
}
