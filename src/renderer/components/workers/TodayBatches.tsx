// Today's line for batches you launched from the Orchestrator. The crew's
// queue is built from worker batches only, so without this a fifty-ask batch
// could run all afternoon — or stop with items waiting on you — and Today
// would not mention it. One line per batch, not one per item: the items live
// on the Orchestrator's ledger, and this is the door to it.

import { useMemo } from 'react';

import { useOrchestratorStore } from '../../orchestratorStore';
import { liveOrchestratorBatches, movingLine, tallyOf } from '../../orchestratorTally';
import { useStore } from '../../store';
import { SectionLabel } from './NowSection';

export function TodayBatches() {
  const orchestrations = useOrchestratorStore((s) => s.orchestrations);
  const batches = useMemo(() => liveOrchestratorBatches(orchestrations), [orchestrations]);
  if (batches.length === 0) return null;
  const open = (id: string) => {
    useOrchestratorStore.getState().setActiveOrchestration(id);
    useStore.getState().setDetailMode('orchestrator');
  };
  return (
    <section className="flex flex-col gap-0.5">
      <SectionLabel>Orchestrator</SectionLabel>
      <div className="mt-1 flex flex-col">
        {batches.map((b) => {
          const t = tallyOf([b]);
          const moving = movingLine(t);
          const pct = t.total ? Math.round((t.done / t.total) * 100) : 0;
          return (
            <button
              key={b.id}
              onClick={() => open(b.id)}
              title="Open this batch in the Orchestrator"
              className="group flex flex-col gap-1 rounded-md px-2 py-1.5 text-left hover:bg-card"
            >
              <div className="flex items-center gap-2 text-[12.5px]">
                <span
                  className={
                    'h-1.5 w-1.5 shrink-0 rounded-full ' +
                    (t.needsYou > 0 ? 'bg-amber-400' : t.running > 0 ? 'animate-pulse bg-accent' : 'bg-ink-faint')
                  }
                />
                <span className="truncate text-ink">{b.title}</span>
                {b.runIn === 'shared' && b.adoptWorktrees && (
                  <span className="truncate font-mono text-[10.5px] text-ink-faint">{b.adoptWorktrees.branch}</span>
                )}
                <span className="ml-auto shrink-0 text-[11px] text-ink-faint">
                  {t.done}/{t.total} done
                </span>
              </div>
              <div className="flex items-center gap-2 pl-3.5 text-[11px]">
                <div className="h-1 w-24 shrink-0 overflow-hidden rounded-full bg-card-strong">
                  <div className="h-full bg-accent" style={{ width: `${pct}%` }} />
                </div>
                {t.needsYou > 0 && <span className="text-amber-500">{t.needsYou} need{t.needsYou === 1 ? 's' : ''} you</span>}
                {moving && <span className="text-ink-faint">{moving}</span>}
                {b.pausedAt && <span className="text-ink-faint">paused</span>}
              </div>
            </button>
          );
        })}
      </div>
    </section>
  );
}
