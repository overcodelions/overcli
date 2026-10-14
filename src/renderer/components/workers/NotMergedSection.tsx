// "Not merged" — finished shifts whose commit never reached its base branch.
//
// Everything else on Today is about work in motion or work you have to read.
// This is the work that is done and still not anywhere: committed, parked on
// a branch, and forgotten. Each row offers the three things you do with one:
//   - the title opens the commit in the shift-work sheet (what did it change),
//   - "Go to shift" opens the worker's desk on the turn that produced it,
//   - on a row that no longer merges, "Ask <worker> to rebuild" sends that
//     worker an errand to redo it on top of current base — then takes you to
//     its desk, where the errand runs in front of you. It never merges or
//     pushes; landing stays your call.
//
// Fetched when the page mounts and on Recheck, never on a timer: the audit
// runs a handful of git commands per finished item (main/flows/
// strandedLandings.ts), which can take a few seconds on a busy machine — so
// the first check says it is checking rather than leaving a silent gap.

import { useCallback, useEffect, useState } from 'react';

import type { LandingAudit, StrandedLanding } from '../../../shared/flows/landingAudit';
import { useStore } from '../../store';
import { useWorkersStore } from '../../workersStore';
import { landabilityLabel, notMergedRows, rebuildInstruction } from './notMerged';

const TONE: Record<'clean' | 'conflicts' | 'unknown', string> = {
  clean: 'text-emerald-400',
  conflicts: 'text-amber-500',
  unknown: 'text-ink-faint',
};

const HEADING = 'shrink-0 whitespace-nowrap text-[10.5px] font-semibold uppercase tracking-[0.08em] text-ink-muted';

export function NotMergedSection({ workerId = null }: { workerId?: string | null }) {
  const openSheet = useStore((s) => s.openSheet);
  const openWorkerActivity = useWorkersStore((s) => s.openWorkerActivity);
  const openWorkerDesk = useWorkersStore((s) => s.openWorkerDesk);
  const runErrand = useWorkersStore((s) => s.runErrand);
  const workers = useWorkersStore((s) => s.workers);
  const [audit, setAudit] = useState<LandingAudit | null>(null);
  const [checking, setChecking] = useState(false);
  const [failed, setFailed] = useState(false);

  const check = useCallback(() => {
    setChecking(true);
    setFailed(false);
    void window.overcli
      .invoke('workers:auditLandings')
      .then((res) => setAudit(res))
      .catch(() => setFailed(true))
      .finally(() => setChecking(false));
  }, []);

  useEffect(() => {
    check();
  }, [check]);

  const askToRebuild = (s: StrandedLanding) => {
    // Not awaited: the errand is a whole planning turn. The desk shows it
    // live from the moment it is sent, so take the user there instead.
    void runErrand(s.workerId, rebuildInstruction(s));
    openWorkerDesk(s.workerId);
  };

  // The first look takes a moment; say so rather than appearing later.
  if (!audit) {
    if (!checking && !failed) return null;
    return (
      <section className="mt-6 flex items-center justify-between gap-2">
        <h3 className={HEADING}>Not merged</h3>
        {failed ? (
          <button onClick={check} className="text-[10.5px] text-ink-faint hover:text-ink">
            Couldn&apos;t check — retry
          </button>
        ) : (
          <span className="flex items-center gap-1.5 text-[10.5px] text-ink-faint" role="status">
            <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-ink-faint" />
            Checking for unmerged shift work…
          </span>
        )}
      </section>
    );
  }

  const rows = notMergedRows(audit.stranded, workerId);
  if (rows.length === 0) return null;

  return (
    <section className="mt-6 flex flex-col gap-1.5">
      <div className="flex items-center justify-between gap-2">
        <h3 className={HEADING} title="Shifts that committed work which never reached its base branch">
          Not merged · {rows.length}
        </h3>
        <button
          onClick={check}
          disabled={checking}
          className="flex items-center gap-1.5 text-[10.5px] text-ink-faint hover:text-ink disabled:opacity-60"
        >
          {checking && <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-ink-faint" />}
          {checking ? 'Checking…' : 'Recheck'}
        </button>
      </div>
      <div className="overflow-hidden rounded-lg border border-card">
        {rows.map((s) => {
          const label = landabilityLabel(s);
          // A worker that has since been let go can't take an errand.
          const canAsk = s.landability === 'conflicts' && !!workers[s.workerId];
          return (
            <div
              key={`${s.orchestrationId}:${s.headSha}`}
              className="flex flex-col gap-1 border-b border-card px-3 py-2 last:border-b-0"
            >
              <button
                onClick={() =>
                  openSheet({
                    type: 'shiftWork',
                    projectPath: s.projectPath,
                    headSha: s.headSha,
                    title: s.itemTitle,
                    baseBranch: s.baseBranch,
                  })
                }
                title="See what this shift changed"
                className="truncate text-left text-[12.5px] text-ink hover:underline"
              >
                {s.itemTitle}
              </button>
              <span className="flex min-w-0 items-center gap-1.5 text-[11px] text-ink-faint">
                {!workerId && <span className="truncate">{s.workerName}</span>}
                {!workerId && <span>·</span>}
                {s.finishedAt && <span className="shrink-0">{new Date(s.finishedAt).toLocaleDateString()}</span>}
                <span>·</span>
                <span className="shrink-0 font-mono">{s.headSha.slice(0, 7)}</span>
                <span className={`ml-auto shrink-0 ${TONE[label.tone]}`} title={label.hint}>
                  {label.text}
                </span>
              </span>
              <span className="flex items-center gap-3 text-[11px]">
                <button
                  onClick={() => openWorkerActivity(s.workerId, s.orchestrationId, s.batchCreatedAt)}
                  title="Open the worker's desk on the shift that produced this"
                  className="text-ink-faint hover:text-ink"
                >
                  Go to shift →
                </button>
                {canAsk && (
                  <button
                    onClick={() => askToRebuild(s)}
                    title={`Send ${s.workerName} an errand to redo this on top of current ${s.baseBranch}. It won't merge or push.`}
                    className="text-amber-500 hover:underline"
                  >
                    Ask {s.workerName} to rebuild it
                  </button>
                )}
              </span>
            </div>
          );
        })}
      </div>
    </section>
  );
}
