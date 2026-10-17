// The crew as an org chart: each manager at the top of their branch, the
// workers they manage below, and every worker's reports below it.
//
// Drawn from `reportsTo` and `manager` alone (`buildOrgTree`), so it is only
// ever as true as the worker settings. A roster nobody has arranged reads as
// one flat row under "Not managed yet", which is the honest picture and the
// prompt to fix it: each card opens the worker, and its settings hold the
// fields.

import { useEffect, useMemo, useState } from 'react';
import { useWorkersStore } from '../../workersStore';
import { useFlowsStore } from '../../flowsStore';
import type { Worker } from '@shared/flows/worker';
import { WORKER_VISIBILITY_LABEL, workerTagline } from '@shared/flows/worker';
import { buildOrgTree, countNodes, type OrgNode } from '@shared/flows/org';
import type { WorkerReport, WorkerReportRow } from '@shared/flows/workerReport';
import { WorkerAvatar } from './WorkerAvatar';

/// The window the card counts cover. A month matches the report's default.
const STATS_DAYS = 30;

/// Siblings drawn as a tree row; more than this wrap as a grid.
const MAX_TREE_ROW = 4;

interface CardStats {
  done: number;
  errands: number;
  questions: number;
  waiting: number;
}

export function OrgChartPane() {
  const workers = useWorkersStore((s) => s.workers);
  const selectWorker = useWorkersStore((s) => s.selectWorker);
  const runs = useFlowsStore((s) => s.runs);
  const [report, setReport] = useState<WorkerReport | null>(null);

  useEffect(() => {
    let cancelled = false;
    const from = new Date();
    from.setHours(0, 0, 0, 0);
    from.setDate(from.getDate() - (STATS_DAYS - 1));
    void window.overcli.invoke('workers:report', { sinceMs: from.getTime() }).then(
      (next) => {
        if (!cancelled) setReport(next);
      },
      // The cards still draw without the counts.
      () => {},
    );
    return () => {
      cancelled = true;
    };
  }, []);

  const branches = useMemo(() => buildOrgTree(Object.values(workers)), [workers]);

  // Questions are counted from the runs the renderer holds, not the report:
  // they live on the run, and "waiting on someone" is a now-fact the report's
  // window does not answer.
  const stats = useMemo(() => {
    const byWorker = new Map<string, WorkerReportRow>((report?.byWorker ?? []).map((r) => [r.workerId, r]));
    const out = new Map<string, CardStats>();
    for (const w of Object.values(workers)) {
      const row = byWorker.get(w.id);
      out.set(w.id, {
        done: row?.itemsDone ?? 0,
        errands: row?.errands ?? 0,
        questions: 0,
        waiting: 0,
      });
    }
    for (const run of Object.values(runs)) {
      const s = run.workerId ? out.get(run.workerId) : undefined;
      if (!s) continue;
      s.questions += run.workerExchanges?.length ?? 0;
      if (run.state.kind === 'paused' && (run.state.reason === 'needsInput' || run.state.reason === 'externalAction'))
        s.waiting += 1;
    }
    return out;
  }, [workers, runs, report]);

  const total = Object.keys(workers).length;

  return (
    <div className="min-h-0 flex-1 overflow-auto px-6 pb-10 pt-4">
      <header className="mb-6">
        <h2 className="text-sm font-semibold text-ink">Org chart</h2>
        <p className="mt-0.5 text-xs text-ink-muted">
          Who reports to whom, and which person each branch answers to. A question climbs the chain before it
          reaches a person. Set a worker&apos;s manager and boss in its settings.
        </p>
      </header>
      {total === 0 ? (
        <div className="text-sm text-ink-muted">Nobody is hired yet.</div>
      ) : (
        <div className="flex flex-col gap-12">
          {branches.map((branch) => (
            // Safe centering: a branch wider than the pane starts at its left
            // edge, where the scroll can reach it, instead of spilling off both.
            <section key={branch.manager?.name ?? '\u0000unmanaged'} className="flex flex-col [align-items:safe_center]">
              <PersonCard
                name={branch.manager?.name ?? 'Not managed yet'}
                slack={!!branch.manager?.slackUserId}
                count={countNodes(branch.roots)}
                unmanaged={!branch.manager}
              />
              <Children nodes={branch.roots} stats={stats} onOpen={selectWorker} />
            </section>
          ))}
        </div>
      )}
    </div>
  );
}

function PersonCard({ name, slack, count, unmanaged }: { name: string; slack: boolean; count: number; unmanaged: boolean }) {
  return (
    <div
      className={
        'flex min-w-[220px] items-center gap-3 rounded-xl px-4 py-3 shadow-sm ' +
        (unmanaged ? 'border border-dashed border-card-strong bg-card/40' : 'bg-ink text-surface')
      }
    >
      <div
        className={
          'flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-xs font-semibold ' +
          (unmanaged ? 'bg-card-strong text-ink-muted' : 'bg-surface/15')
        }
      >
        {unmanaged ? '?' : initials(name)}
      </div>
      <div className="min-w-0">
        <div className={'truncate text-sm font-semibold ' + (unmanaged ? 'text-ink-muted' : '')}>{name}</div>
        <div className={'text-[11px] ' + (unmanaged ? 'text-ink-faint' : 'opacity-70')}>
          {unmanaged
            ? `${count} worker${count === 1 ? '' : 's'} — questions wait in overcli`
            : `Manages ${count} worker${count === 1 ? '' : 's'}${slack ? ' · asked in Slack' : ''}`}
        </div>
      </div>
    </div>
  );
}

/// One row of reports under a parent, with the connector lines drawn by each
/// child: a stub up from its card, and its share of the bar across the top.
/// Padding rather than gap between siblings, so the bar runs unbroken.
function Children({
  nodes,
  stats,
  onOpen,
}: {
  nodes: OrgNode<Worker>[];
  stats: Map<string, CardStats>;
  onOpen: (id: string) => void;
}) {
  if (nodes.length === 0) return null;
  // A long row of siblings — a flat roster nobody has arranged yet, or one
  // manager with many workers — would run off the side. Past a few, they
  // wrap as a grid in one group under the parent instead.
  if (nodes.length > MAX_TREE_ROW) {
    return (
      <>
        <div className="h-5 w-px bg-ink/20" />
        <div className="flex w-full flex-wrap justify-center gap-4 rounded-2xl border border-ink/10 p-4">
          {nodes.map((node) => (
            <div key={node.worker.id} className="flex flex-col items-center">
              <WorkerCard worker={node.worker} stats={stats.get(node.worker.id)} onOpen={() => onOpen(node.worker.id)} />
              <Children nodes={node.reports} stats={stats} onOpen={onOpen} />
            </div>
          ))}
        </div>
      </>
    );
  }
  return (
    <>
      <div className="h-5 w-px bg-ink/20" />
      <div className="flex">
        {nodes.map((node, i) => (
          <div key={node.worker.id} className="relative flex flex-col items-center px-2 pt-5">
            {nodes.length > 1 && (
              <div
                className="absolute top-0 h-px bg-ink/20"
                style={{ left: i === 0 ? '50%' : 0, right: i === nodes.length - 1 ? '50%' : 0 }}
              />
            )}
            <div className="absolute left-1/2 top-0 h-5 w-px bg-ink/20" />
            <WorkerCard worker={node.worker} stats={stats.get(node.worker.id)} onOpen={() => onOpen(node.worker.id)} />
            <Children nodes={node.reports} stats={stats} onOpen={onOpen} />
          </div>
        ))}
      </div>
    </>
  );
}

function WorkerCard({ worker, stats, onOpen }: { worker: Worker; stats?: CardStats; onOpen: () => void }) {
  const tagline = workerTagline(worker);
  return (
    <div
      className={
        'flex w-[212px] flex-col items-center rounded-xl bg-card px-4 pb-3 pt-4 text-center shadow-sm ' +
        (worker.enabled ? '' : 'opacity-60')
      }
    >
      <WorkerAvatar worker={worker} size="lg" />
      <div className="mt-2 max-w-full truncate text-sm font-semibold text-ink">{worker.name}</div>
      {tagline && <div className="mt-0.5 line-clamp-2 text-[11px] leading-snug text-ink-muted">{tagline}</div>}
      <div className="mt-2 flex flex-wrap justify-center gap-1">
        {worker.manager && (
          <Chip title={worker.manager.slackUserId ? 'Asks this manager in Slack' : 'Manager'}>
            {worker.manager.name}
            {worker.manager.slackUserId ? ' · Slack' : ''}
          </Chip>
        )}
        <Chip title="Who may ask it things">{WORKER_VISIBILITY_LABEL[worker.visibility ?? 'private']}</Chip>
        {!worker.enabled && <Chip>Paused</Chip>}
      </div>
      <div className="mt-3 grid w-full grid-cols-3 border-t border-card-strong pt-2">
        <Stat value={(stats?.done ?? 0) + (stats?.errands ?? 0)} label="Tasks" title={`Items done and errands, last ${STATS_DAYS} days`} />
        <Stat value={stats?.questions ?? 0} label="Questions" title="Questions its runs asked" />
        <Stat
          value={stats?.waiting ?? 0}
          label="Waiting"
          title="Paused for a person: a question or an approval"
          warn={(stats?.waiting ?? 0) > 0}
        />
      </div>
      <button
        onClick={onOpen}
        className="mt-3 w-full rounded-md border border-card-strong px-2 py-1 text-xs text-ink-muted hover:bg-card-strong hover:text-ink"
      >
        Open {worker.name}
      </button>
    </div>
  );
}

function Chip({ children, title }: { children: React.ReactNode; title?: string }) {
  return (
    <span title={title} className="max-w-full truncate rounded-full bg-card-strong px-2 py-0.5 text-[10px] text-ink-muted">
      {children}
    </span>
  );
}

function Stat({ value, label, title, warn }: { value: number; label: string; title: string; warn?: boolean }) {
  return (
    <div title={title} className="flex flex-col items-center">
      <span className={'text-sm font-semibold tabular-nums ' + (warn ? 'text-amber-300' : 'text-ink')}>{value}</span>
      <span className="text-[9px] uppercase tracking-wider text-ink-faint">{label}</span>
    </div>
  );
}

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  return ((parts[0]?.[0] ?? '') + (parts.length > 1 ? parts[parts.length - 1][0] : '')).toUpperCase() || '?';
}
