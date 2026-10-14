// "Not merged" — finished shifts whose commit never reached its base branch.
//
// Everything else on Today is about work in motion or work you have to read.
// This is the work that is done and still not anywhere: committed, parked on
// a branch, and forgotten. Each row opens the commit in the shift-work sheet,
// the same door the desk uses once a run has aged out.
//
// Fetched when the page mounts and on Recheck, never on a timer: the audit
// runs a handful of git commands per finished item (main/flows/
// strandedLandings.ts). Renders nothing until there is something to say.

import { useCallback, useEffect, useState } from 'react';

import type { LandingAudit } from '../../../shared/flows/landingAudit';
import { useStore } from '../../store';
import { landabilityLabel, notMergedRows } from './notMerged';

const TONE: Record<'clean' | 'conflicts' | 'unknown', string> = {
  clean: 'text-emerald-400',
  conflicts: 'text-amber-500',
  unknown: 'text-ink-faint',
};

export function NotMergedSection({ workerId = null }: { workerId?: string | null }) {
  const openSheet = useStore((s) => s.openSheet);
  const [audit, setAudit] = useState<LandingAudit | null>(null);
  const [checking, setChecking] = useState(false);

  const check = useCallback(() => {
    setChecking(true);
    void window.overcli
      .invoke('workers:auditLandings')
      .then((res) => setAudit(res))
      .catch(() => setAudit(null))
      .finally(() => setChecking(false));
  }, []);

  useEffect(() => {
    check();
  }, [check]);

  const rows = audit ? notMergedRows(audit.stranded, workerId) : [];
  if (rows.length === 0) return null;

  return (
    <section className="mt-6 flex flex-col gap-1.5">
      <div className="flex items-center justify-between gap-2">
        <h3
          className="shrink-0 whitespace-nowrap text-[10.5px] font-semibold uppercase tracking-[0.08em] text-ink-muted"
          title="Shifts that committed work which never reached its base branch"
        >
          Not merged · {rows.length}
        </h3>
        <button
          onClick={check}
          disabled={checking}
          className="text-[10.5px] text-ink-faint hover:text-ink disabled:opacity-50"
        >
          {checking ? 'Checking…' : 'Recheck'}
        </button>
      </div>
      <div className="overflow-hidden rounded-lg border border-card">
        {rows.map((s) => {
          const label = landabilityLabel(s);
          return (
            <button
              key={`${s.orchestrationId}:${s.headSha}`}
              onClick={() =>
                openSheet({
                  type: 'shiftWork',
                  projectPath: s.projectPath,
                  headSha: s.headSha,
                  title: s.itemTitle,
                  baseBranch: s.baseBranch,
                })
              }
              title={label.hint}
              className="flex w-full flex-col gap-0.5 border-b border-card px-3 py-2 text-left last:border-b-0 hover:bg-white/5"
            >
              <span className="truncate text-[12.5px] text-ink">{s.itemTitle}</span>
              <span className="flex min-w-0 items-center gap-1.5 text-[11px] text-ink-faint">
                {!workerId && <span className="truncate">{s.workerName}</span>}
                {!workerId && <span>·</span>}
                {s.finishedAt && <span className="shrink-0">{new Date(s.finishedAt).toLocaleDateString()}</span>}
                <span>·</span>
                <span className="shrink-0 font-mono">{s.headSha.slice(0, 7)}</span>
                <span className={`ml-auto shrink-0 ${TONE[label.tone]}`}>{label.text}</span>
              </span>
            </button>
          );
        })}
      </div>
    </section>
  );
}
