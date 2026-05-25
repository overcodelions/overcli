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

function compactModel(flow: Flow, step: FlowStep): string {
  const m = resolveStepModel(flow, step).model;
  if (!m) return '(no model)';
  // Strip the vendor prefix, keep version dashes as dots (4-7 → 4.7) and
  // turn the remaining word-separating dashes into spaces (opus → opus).
  // e.g. claude-opus-4-7 → "opus 4.7".
  if (m.startsWith('claude-')) {
    return m
      .replace('claude-', '')
      .replace(/(\d)-(\d)/g, '$1.$2')
      .replace(/-/g, ' ');
  }
  if (m.includes(':')) return m.split(':')[0];
  return m;
}

interface PipelineDiagramProps {
  flow: Flow;
  /// Step id whose card should be scrolled into view when a pill is
  /// clicked. The editor passes a stable selector for each step card.
  onStepClick?: (stepId: string) => void;
}

export function FlowPipelineDiagram({ flow, onStepClick }: PipelineDiagramProps) {
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
    <div className="rounded-xl bg-card p-4 shadow-sm">
      <div className="text-[11px] uppercase tracking-wider text-ink-faint mb-2">Pipeline</div>
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
      {retryEdges.length > 0 && (
        <div className="mt-3 pt-3">
          <div className="text-[11px] uppercase tracking-wider text-ink-faint mb-1.5">
            Retry edges
          </div>
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
