// "Not merged" — finished shifts whose commit never reached its base branch.
//
// Everything else on Today is about work in motion or work you have to read.
// This is the work that is done and still not anywhere: committed, parked on
// a branch, and forgotten. Each row offers what you do with one:
//   - the title opens the commit in the shift-work sheet (what did it change);
//   - "Go to shift" opens the worker's desk on the turn that produced it;
//   - "Update with <base>" merges base into the work on a fresh branch
//     (main/flows/landingUpdate). Clean → committed, and the row moves to the
//     up-to-date branch, ready for you to merge. Conflicts → the merge is
//     parked in its own worktree, and the row turns into the controls for
//     resolving it: open it, mark it resolved, or discard it;
//   - on a conflicting row, "Ask <worker> instead" sends the worker an
//     errand to redo it — the fallback when the clash is too big to fix by
//     hand. Nothing here ever merges into base or pushes.
//
// Fetched when the page mounts and on Recheck, never on a timer: the audit
// runs a handful of git commands per finished item (main/flows/
// strandedLandings.ts), so the first check says it is checking rather than
// leaving a silent gap.

import { useCallback, useEffect, useState } from 'react';

import type { LandingAudit, StrandedLanding } from '../../../shared/flows/landingAudit';
import { useStore } from '../../store';
import { useWorkersStore } from '../../workersStore';
import { conflictSummary, landabilityLabel, notMergedRows, rebuildInstruction } from './notMerged';

const TONE: Record<'clean' | 'conflicts' | 'unknown', string> = {
  clean: 'text-emerald-400',
  conflicts: 'text-amber-500',
  unknown: 'text-ink-faint',
};

const HEADING = 'shrink-0 whitespace-nowrap text-[10.5px] font-semibold uppercase tracking-[0.08em] text-ink-muted';
const ACTION = 'text-ink-faint hover:text-ink disabled:opacity-50';

export function NotMergedSection({ workerId = null }: { workerId?: string | null }) {
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
        {rows.map((s) => (
          <NotMergedRow key={`${s.orchestrationId}:${s.headSha}`} s={s} showWorker={!workerId} onChanged={check} />
        ))}
      </div>
    </section>
  );
}

function NotMergedRow({ s, showWorker, onChanged }: { s: StrandedLanding; showWorker: boolean; onChanged: () => void }) {
  const openSheet = useStore((st) => st.openSheet);
  const openWorkerActivity = useWorkersStore((st) => st.openWorkerActivity);
  const openWorkerDesk = useWorkersStore((st) => st.openWorkerDesk);
  const runErrand = useWorkersStore((st) => st.runErrand);
  const workerExists = useWorkersStore((st) => !!st.workers[s.workerId]);
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<{ text: string; error: boolean } | null>(null);

  const label = landabilityLabel(s);
  const pending = s.pendingUpdate;
  const ids = { orchestrationId: s.orchestrationId, headSha: s.headSha };

  const act = async <R extends { ok: true }>(
    what: string,
    run: () => Promise<R | { ok: false; error: string }>,
    done: (r: R) => string,
  ) => {
    setBusy(what);
    setNote(null);
    try {
      const res = await run();
      if (res.ok) setNote({ text: done(res as R), error: false });
      else setNote({ text: res.error, error: true });
      onChanged();
    } catch (err) {
      setNote({ text: err instanceof Error ? err.message : String(err), error: true });
    } finally {
      setBusy(null);
    }
  };

  const update = () =>
    act(
      'update',
      () => window.overcli.invoke('workers:updateLanding', { ...ids, baseBranch: s.baseBranch }),
      (r) =>
        r.status === 'merged'
          ? `Brought ${s.baseBranch} in cleanly — now on ${r.branchName}, ready to merge.`
          : `${s.baseBranch} conflicts — the merge is waiting for you below.`,
    );
  const finish = () =>
    act(
      'finish',
      () => window.overcli.invoke('workers:finishLandingUpdate', { ...ids, baseBranch: s.baseBranch }),
      (r) => `Resolved — now on ${r.branchName}, ready to merge.`,
    );
  const discard = () =>
    act(
      'discard',
      () => window.overcli.invoke('workers:discardLandingUpdate', ids),
      (r) =>
        r.keptBranch ? `Discarded the worktree; kept ${r.keptBranch} because it has commits on it.` : 'Discarded — back as it was.',
    );
  const askWorker = () => {
    // Not awaited: the errand is a whole planning turn. The desk shows it
    // live from the moment it is sent, so take the user there instead.
    void runErrand(s.workerId, rebuildInstruction(s));
    openWorkerDesk(s.workerId);
  };

  return (
    <div className="flex flex-col gap-1 border-b border-card px-3 py-2 last:border-b-0">
      <button
        onClick={() =>
          openSheet({ type: 'shiftWork', projectPath: s.projectPath, headSha: s.headSha, title: s.itemTitle, baseBranch: s.baseBranch })
        }
        title="See what this shift changed"
        className="truncate text-left text-[12.5px] text-ink hover:underline"
      >
        {s.itemTitle}
      </button>
      <span className="flex min-w-0 items-center gap-1.5 text-[11px] text-ink-faint">
        {showWorker && <span className="truncate">{s.workerName}</span>}
        {showWorker && <span>·</span>}
        {s.finishedAt && <span className="shrink-0">{new Date(s.finishedAt).toLocaleDateString()}</span>}
        <span>·</span>
        <span className="shrink-0 font-mono">{s.headSha.slice(0, 7)}</span>
        <span className={`ml-auto shrink-0 ${TONE[label.tone]}`} title={label.hint}>
          {pending ? 'resolving' : label.text}
        </span>
      </span>
      {!pending && s.conflictFiles.length > 0 && (
        <span className="truncate text-[11px] text-ink-faint" title={s.conflictFiles.join('\n')}>
          Conflicts in {conflictSummary(s.conflictFiles)}
        </span>
      )}

      {pending ? (
        <div className="mt-1 flex flex-col gap-1 rounded-md border border-amber-500/30 bg-amber-500/5 px-2 py-1.5 text-[11px]">
          <span className="text-ink-muted">
            Merge of {s.baseBranch} waiting on {conflictSummary(pending.conflictFiles)} in{' '}
            <span className="font-mono text-ink-faint" title={pending.worktreePath}>
              {pending.branchName}
            </span>
            . Resolve, <span className="font-mono">git commit</span>, then mark it resolved.
          </span>
          <span className="flex flex-wrap items-center gap-3">
            <button
              onClick={() => void window.overcli.invoke('terminal:openFolder', { path: pending.worktreePath })}
              className={ACTION}
            >
              Open in Terminal
            </button>
            <button onClick={() => void window.overcli.invoke('fs:openInFinder', pending.worktreePath)} className={ACTION}>
              Show in Finder
            </button>
            <button onClick={() => void finish()} disabled={!!busy} className="text-emerald-400 hover:underline disabled:opacity-50">
              {busy === 'finish' ? 'Checking…' : "I've resolved it"}
            </button>
            <button onClick={() => void discard()} disabled={!!busy} className={ACTION}>
              {busy === 'discard' ? 'Discarding…' : 'Discard'}
            </button>
          </span>
        </div>
      ) : (
        <span className="flex flex-wrap items-center gap-3 text-[11px]">
          <button
            onClick={() => openWorkerActivity(s.workerId, s.orchestrationId, s.batchCreatedAt)}
            title="Open the worker's desk on the shift that produced this"
            className={ACTION}
          >
            Go to shift →
          </button>
          {s.landability !== 'unknown' && (
            <button
              onClick={() => void update()}
              disabled={!!busy}
              title={
                s.landability === 'clean'
                  ? `Merge ${s.baseBranch} into this work on a new branch, so it is up to date before you merge it`
                  : `Merge ${s.baseBranch} into this work on a new branch and leave the conflicts for you to resolve`
              }
              className="text-accent hover:underline disabled:opacity-50"
            >
              {busy === 'update' ? `Merging ${s.baseBranch}…` : `Update with ${s.baseBranch}`}
            </button>
          )}
          {s.landability === 'conflicts' && workerExists && (
            <button
              onClick={askWorker}
              title={`Send ${s.workerName} an errand to redo this on top of current ${s.baseBranch}. It won't merge or push.`}
              className={ACTION}
            >
              Ask {s.workerName} instead
            </button>
          )}
        </span>
      )}
      {note && (
        <span className={`text-[11px] ${note.error ? 'text-rose-400' : 'text-emerald-400'}`} role="status">
          {note.text}
        </span>
      )}
    </div>
  );
}
