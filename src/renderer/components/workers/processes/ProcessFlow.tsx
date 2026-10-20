// "How it works": a process drawn as a row of cards (Start, one per stage,
// End) with solid arrows between them and dashed loops round the outside
// for what goes back. The geometry is worked out in processView.ts
// (flowPlan, flowDrawing); here the cards are laid out on the shared column
// grid, measured, and the SVG drawn over them, again whenever they resize.

import { useId, useLayoutEffect, useMemo, useRef, useState } from "react";

import type { ProcessStage } from "@shared/org/process";
import {
  FLOW_GAP,
  STAGE_KIND_LABEL,
  decidersText,
  flowColumns,
  flowDrawing,
  flowMinWidth,
  flowPadding,
  flowPlan,
  stageTimeWords,
  voteRuleText,
  type FlowRect,
  type StageDuration,
} from "./processView";

/// Each kind's tag colour, as the rest of Processes draws it: a team in the
/// accent, a worker sky, a decision amber.
export const FLOW_KIND_TEXT: Record<ProcessStage["kind"], string> = {
  team: "text-accent",
  worker: "text-sky-700 dark:text-sky-300",
  people: "text-amber-700 dark:text-amber-300",
};

export const FLOW_KIND_PILL: Record<ProcessStage["kind"], string> = {
  team: "bg-accent/15 text-accent",
  worker: "bg-sky-400/15 text-sky-700 dark:text-sky-300",
  people: "bg-amber-400/15 text-amber-700 dark:text-amber-300",
};

/// Who does a stage, for its card: the team or worker, or who decides and
/// how many must ("You · any one").
export function flowWho(stage: ProcessStage, doer: (s: ProcessStage) => string): string {
  if (stage.kind !== "people") return doer(stage);
  const rule = voteRuleText(stage);
  return rule ? `${decidersText(stage)} · ${rule}` : decidersText(stage);
}

function sameRects(a: FlowRect[], b: FlowRect[]): boolean {
  return a.length === b.length && a.every((r, i) => r.x === b[i].x && r.y === b[i].y && r.w === b[i].w && r.h === b[i].h);
}

export function ProcessFlow({
  stages,
  doer,
  onOpenDoer,
  times,
  waysIn,
}: {
  stages: ProcessStage[];
  doer: (s: ProcessStage) => string;
  /// Opens a team's or worker's own page; without it their names stay text.
  onOpenDoer?: (s: ProcessStage) => void;
  times: StageDuration[];
  /// The ways in, short, for the Start card: "page · Tracker · Slack".
  waysIn: string;
}) {
  const plan = useMemo(() => flowPlan(stages), [stages]);
  const pad = flowPadding(plan);
  const box = useRef<HTMLDivElement | null>(null);
  const cards = useRef<Array<HTMLDivElement | null>>([]);
  const [rects, setRects] = useState<FlowRect[]>([]);
  const uid = useId().replace(/:/g, "");

  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    const measure = () => {
      const o = el.getBoundingClientRect();
      const next = cards.current.slice(0, stages.length + 2).map((c) => {
        const r = c?.getBoundingClientRect();
        return r ? { x: Math.round(r.left - o.left), y: Math.round(r.top - o.top), w: Math.round(r.width), h: Math.round(r.height) } : { x: 0, y: 0, w: 0, h: 0 };
      });
      setRects((prev) => (sameRects(prev, next) ? prev : next));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    for (const c of cards.current) if (c) ro.observe(c);
    return () => ro.disconnect();
  }, [stages]);

  const drawing = useMemo(() => flowDrawing(plan, rects), [plan, rects]);
  const solid = `ppg-solid-${uid}`;
  const dashed = `ppg-dashed-${uid}`;
  const cardBase = "flex min-h-[96px] min-w-0 flex-col justify-center gap-0.5 rounded-[10px] border px-3.5 py-3 text-xs leading-normal";

  return (
    <div ref={box} className="relative" style={{ minWidth: flowMinWidth(stages.length), paddingTop: pad.top, paddingBottom: pad.bottom }}>
      <svg aria-hidden className="ppg-overlay">
        <defs>
          <marker id={solid} viewBox="0 0 8 8" refX="6" refY="4" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
            <path d="M0 0 L8 4 L0 8 Z" className="ppg-head-solid" />
          </marker>
          <marker id={dashed} viewBox="0 0 8 8" refX="6" refY="4" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
            <path d="M0 0 L8 4 L0 8 Z" className="ppg-head-loop" />
          </marker>
        </defs>
        {drawing.arrows.map((d, i) => (
          <path key={`a${i}`} d={d} className="ppg-line" markerEnd={`url(#${solid})`} />
        ))}
        {drawing.loops.map((l, i) => (
          <path key={`l${i}`} d={l.d} className="ppg-loop" markerEnd={`url(#${dashed})`} />
        ))}
      </svg>

      <ol className="m-0 grid list-none items-stretch p-0" style={{ gridTemplateColumns: flowColumns(stages.length), columnGap: FLOW_GAP }} aria-label="Stages, in order">
        <li>
          <div ref={(el) => { cards.current[0] = el; }} className={cardBase + " h-full border-accent/40 bg-accent/10 text-ink-muted"}>
            <span className="text-[10px] font-bold tracking-wider text-accent">START</span>
            <b className="text-sm font-semibold text-ink">Comes in</b>
            <span className="truncate" title={waysIn}>
              {waysIn}
            </span>
          </div>
        </li>
        {stages.map((s, i) => {
          const time = stageTimeWords(times[i]);
          const who = flowWho(s, doer);
          const line = [who, time].filter(Boolean).join(" · ");
          return (
            <li key={s.id}>
              <div
                ref={(el) => { cards.current[i + 1] = el; }}
                className={
                  cardBase +
                  " h-full text-ink-muted " +
                  (s.kind === "people" ? "border-dashed border-amber-500/60 bg-amber-400/[0.06] dark:border-amber-400/50" : "border-card-strong bg-surface")
                }
              >
                <span className={"text-[10px] font-bold uppercase tracking-wider " + FLOW_KIND_TEXT[s.kind]}>
                  {i + 1} · {STAGE_KIND_LABEL[s.kind]}
                </span>
                <b className="line-clamp-2 text-sm font-semibold text-ink">{s.name || "Unnamed stage"}</b>
                {onOpenDoer && s.kind !== "people" && (s.teamId || s.workerId) ? (
                  <span className="truncate" title={line}>
                    <button
                      type="button"
                      onClick={() => onOpenDoer(s)}
                      title={`Open ${who}`}
                      className="text-ink underline decoration-card-strong underline-offset-[3px] hover:text-accent hover:decoration-current focus:outline-none focus-visible:ring-1 focus-visible:ring-accent/50"
                    >
                      {who}
                    </button>
                    {time ? ` · ${time}` : ""}
                  </span>
                ) : (
                  <span className="truncate" title={line}>
                    {line}
                  </span>
                )}
              </div>
            </li>
          );
        })}
        <li>
          <div ref={(el) => { cards.current[stages.length + 1] = el; }} className={cardBase + " h-full border-emerald-400/40 bg-emerald-400/10 text-emerald-800/80 dark:text-emerald-200/80"}>
            <span className="text-[10px] font-bold tracking-wider text-emerald-700 dark:text-emerald-300">END</span>
            <b className="text-sm font-semibold text-ink">Done</b>
            <span className="truncate">made it through</span>
          </div>
        </li>
      </ol>

      {drawing.loops.map((l, i) => (
        <span key={`ll${i}`} className="ppg-label ppg-label-loop" style={{ left: l.lx, top: l.ly }}>
          {l.label}
        </span>
      ))}
      {drawing.delays.map((d, i) => (
        <span key={`d${i}`} className="ppg-label ppg-label-wait" style={{ left: d.x, top: d.y }}>
          {d.lines.map((t) => (
            <span key={t} className="block">
              {t}
            </span>
          ))}
        </span>
      ))}
    </div>
  );
}

/// The legend: solid moves on, dashed goes back round.
export function FlowLegend() {
  return (
    <span className="flex flex-wrap gap-3.5 text-[11.5px] text-ink-faint">
      <span className="flex items-center gap-1.5">
        <span aria-hidden className="ppg-key ppg-key-solid" />
        moves on
      </span>
      <span className="flex items-center gap-1.5">
        <span aria-hidden className="ppg-key ppg-key-loop" />
        goes back round
      </span>
    </span>
  );
}
