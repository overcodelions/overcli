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
// get a ↻ glyph. Steps with on_fail.goto get a small arrow back to the
// target rendered as a colored chip below the row (kept simple — full
// edge routing would be overkill for v1).

import { useMemo } from 'react';

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
  const retryEdges = useMemo(() => {
    // For each step with on_fail.goto, capture (from, target) so we can
    // render a sub-row of "retry" arrows below the main pipeline.
    return flow.steps
      .filter((s) => s.onFail?.action === 'goto' && s.onFail.target)
      .map((s) => ({
        from: s.id,
        to: (s.onFail as { action: 'goto'; target: string }).target,
      }));
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
        <div className="flex flex-wrap items-center gap-x-1 gap-y-3">
          <PromptChip />
          {flow.steps.map((step, idx) => (
            <StepRowEntry
              key={step.id}
              flow={flow}
              step={step}
              isFirst={idx === 0}
              isLast={idx === flow.steps.length - 1}
              onClick={() => onStepClick?.(step.id)}
            />
          ))}
        </div>
      )}
      {layout === 'wrap' && retryEdges.length > 0 && (
        <div className="mt-3 pt-3">
          <div className="text-xs text-ink-muted mb-1.5">Retry edges</div>
          <div className="flex flex-wrap gap-2">
            {retryEdges.map(({ from, to }, i) => (
              <div
                key={`${from}-${to}-${i}`}
                className="text-[11px] px-2 py-1 rounded bg-amber-500/10 border border-amber-400/30 text-amber-700 dark:text-amber-200"
              >
                if <span className="font-semibold">{from}</span> fails → retry{' '}
                <span className="font-semibold">{to}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
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
  onClick,
}: {
  flow: Flow;
  step: FlowStep;
  isFirst: boolean;
  isLast: boolean;
  onClick: () => void;
}) {
  const tier = tierOf(flow, step);
  const model = compactModel(flow, step);
  const resolved = resolveStepModel(flow, step);
  return (
    <>
      {step.pauseBefore && !isFirst && (
        <>
          <PauseGlyph />
          <Arrow />
        </>
      )}
      <button
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
      {!isLast && <ArtifactArrow name={step.output} />}
      {isLast && <TerminatorArrow name={step.output} />}
    </>
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

function ArtifactArrow({ name }: { name: string }) {
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
