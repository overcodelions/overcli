// The Org tab: your workers on the org servers this app is signed in to.
//
// The front page is what waits on you, across every server in one list, and
// the workers you can see, grouped by server. A worker opens on its own page:
// Overview and Runs, with the day-to-day actions (pause, run now, approve,
// answer, stop). Everything goes through main to the server the worker lives
// on, and the server decides who may do what, as it does for the console.

import { useEffect, useMemo, useState } from 'react';
import { useStore } from '../../../store';
import { OrgWorkerPage } from './OrgWorkerPage';
import { OrgHome } from './OrgHome';
import { DesktopTaskCard } from './DesktopTaskCard';
import type { OrgServerStatus } from '@shared/types';
import { ago, enc, initials, money, orgCall, STATE_DOT, STATE_LABEL, useOrgTab, usePicture, type OrgProposal, type OrgWaiting, type OrgWorker } from './orgTabStore';

const REFRESH_MS = 60_000;

/// Keeps the tab fresh while it's open: now, on focus, and every minute.
export function useOrgTabRefresh(): void {
  const refresh = useOrgTab((s) => s.refresh);
  useEffect(() => {
    void refresh();
    const onFocus = () => void refresh();
    window.addEventListener('focus', onFocus);
    const timer = window.setInterval(() => void refresh(), REFRESH_MS);
    return () => {
      window.removeEventListener('focus', onFocus);
      window.clearInterval(timer);
    };
  }, [refresh]);
}

export function OrgPane() {
  useOrgTabRefresh();
  const selected = useOrgTab((s) => s.selected);
  if (selected) return <OrgWorkerPage key={`${selected.serverId}/${selected.workerId}/${selected.tab ?? ''}`} serverId={selected.serverId} workerId={selected.workerId} runId={selected.runId} initialTab={selected.tab} />;
  return <OrgHome />;
}

export function Face({ worker, size = 30, square = false }: { worker: OrgWorker; size?: number; square?: boolean }) {
  const src = usePicture(worker.avatarUrl);
  const shape = square ? (size >= 40 ? 'rounded-2xl' : 'rounded-lg') : 'rounded-full';
  const dot = Math.max(9, Math.round(size / 4.5));
  return (
    <span className="relative flex-shrink-0" style={{ width: size, height: size }}>
      {src ? (
        <img src={src} alt="" className={'h-full w-full bg-card-strong object-cover ' + shape} />
      ) : (
        <span className={'flex h-full w-full items-center justify-center bg-card-strong font-semibold text-ink ' + shape} style={{ fontSize: Math.max(9, Math.round(size / 3)) }}>{initials(worker.name)}</span>
      )}
      <span className={'absolute -bottom-0.5 -right-0.5 rounded-full border-2 border-surface ' + STATE_DOT[worker.state]} style={{ width: dot, height: dot }} title={STATE_LABEL[worker.state]} />
    </span>
  );
}

/// A question to answer or an approval to give, sent to the server it came from.
export function WaitingCard({ server, item, showServer, onDone }: { server: OrgServerStatus; item: OrgWaiting; showServer: boolean; onDone: () => void }) {
  const [answer, setAnswer] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const send = (path: string, body: unknown) => {
    setBusy(true);
    setError(null);
    void orgCall(server.id, 'POST', path, body).then((res) => {
      setBusy(false);
      if (!res.ok) setError(res.error);
      else onDone();
    });
  };
  return (
    <div className="rounded-lg border border-card bg-card px-3 py-2.5">
      <div className="flex items-center gap-2 text-[11px] text-ink-muted">
        <span className={'rounded px-1.5 py-px text-[10px] font-medium ' + (item.kind === 'question' ? 'bg-sky-500/15 text-sky-700 dark:text-sky-300' : 'bg-amber-500/15 text-amber-700 dark:text-amber-300')}>
          {item.kind === 'question' ? 'Question' : 'Approval'}
        </span>
        <span className="font-medium text-ink">{item.workerName}</span>
        {showServer && <span className="text-ink-faint">· {server.name ?? server.url}</span>}
        <span className="ml-auto text-ink-faint">{ago(item.since)}</span>
      </div>
      <div className="mt-1 text-sm text-ink">
        {item.title}
        {item.runNumber ? <span className="ml-1 text-ink-faint">#{item.runNumber}</span> : null}
      </div>
      {item.question && <div className="mt-1 whitespace-pre-wrap text-xs text-ink">{item.question}</div>}
      {item.why && <div className="mt-1 text-xs text-ink-muted">{item.why}</div>}
      {item.kind === 'approval' && (item.instructions || item.reaches?.length) && (
        <div className="mt-1">
          {item.reaches?.length ? <div className="text-xs text-ink-muted">Reaches outside: {item.reaches.join(', ')}.</div> : null}
          {item.instructions && (
            <button onClick={() => setOpen(!open)} className="text-[11px] text-accent hover:underline">
              {open ? 'Hide what it will do' : 'What it will do'}
            </button>
          )}
          {open && item.instructions && <pre className="mt-1 max-h-60 overflow-auto whitespace-pre-wrap rounded bg-surface-muted p-2 text-[11px] text-ink">{item.instructions}</pre>}
        </div>
      )}
      <div className="mt-2 flex flex-wrap items-center gap-2">
        {item.kind === 'question' ? (
          <>
            {item.options?.map((o) => (
              <button key={o} disabled={busy} onClick={() => send('/api/answer', { runId: item.runId, answer: o })} className="rounded-md border border-card-strong px-2.5 py-1 text-xs text-ink hover:bg-card-strong disabled:opacity-50">
                {o}
              </button>
            ))}
            <input
              value={answer}
              onChange={(e) => setAnswer(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && answer.trim()) send('/api/answer', { runId: item.runId, answer: answer.trim() });
              }}
              placeholder="Answer…"
              className="field min-w-[12rem] flex-1 px-2 py-1 text-xs"
            />
            <button disabled={busy || !answer.trim()} onClick={() => send('/api/answer', { runId: item.runId, answer: answer.trim() })} className="rounded-md bg-accent px-3 py-1 text-xs text-white disabled:opacity-50">
              Send
            </button>
          </>
        ) : (
          <>
            <button disabled={busy} onClick={() => send('/api/approval', { runId: item.runId, approve: true })} className="rounded-md bg-accent px-3 py-1 text-xs text-white disabled:opacity-50">
              Approve
            </button>
            {item.coversLater ? (
              <button disabled={busy} onClick={() => send('/api/approval', { runId: item.runId, approve: true, forRun: true })} className="rounded-md border border-card-strong px-2.5 py-1 text-xs text-ink hover:bg-card-strong disabled:opacity-50" title={`Also the ${item.coversLater} later step(s) of this run that need only the same tools`}>
                Approve for this run
              </button>
            ) : null}
            <button disabled={busy} onClick={() => send('/api/approval', { runId: item.runId, approve: false })} className="rounded-md border border-card-strong px-2.5 py-1 text-xs text-ink-muted hover:text-ink disabled:opacity-50">
              Skip
            </button>
          </>
        )}
      </div>
      {error && (
        <div role="alert" className="mt-1 text-[11px] text-red-600 dark:text-red-300">
          {error}
        </div>
      )}
    </div>
  );
}

/// Work a worker on probation proposed at a run: pick what goes ahead.
export function ProposalCard({ server, batch, showServer, onDone }: { server: OrgServerStatus; batch: OrgProposal; showServer: boolean; onDone: () => void }) {
  const [picked, setPicked] = useState<Set<string>>(() => new Set(batch.items.map((i) => i.candidateId)));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const decide = (approve: string[]) => {
    setBusy(true);
    setError(null);
    const skip = batch.items.map((i) => i.candidateId).filter((id) => !approve.includes(id));
    void orgCall(server.id, 'POST', `/api/proposals/${enc(batch.batchId)}`, { approve, skip }).then((res) => {
      setBusy(false);
      if (!res.ok) setError(res.error);
      else onDone();
    });
  };
  return (
    <div className="rounded-lg border border-card bg-card px-3 py-2.5">
      <div className="flex items-center gap-2 text-[11px] text-ink-muted">
        <span className="rounded bg-violet-500/15 px-1.5 py-px text-[10px] font-medium text-violet-700 dark:text-violet-300">Proposed work</span>
        <span className="font-medium text-ink">{batch.workerName}</span>
        {showServer && <span className="text-ink-faint">· {server.name ?? server.url}</span>}
        <span className="ml-auto text-ink-faint">{ago(batch.at)}</span>
      </div>
      <div className="mt-1 text-xs text-ink-muted">On probation, so it asks before starting. Tick what should go ahead.</div>
      <ul className="mt-2 flex flex-col gap-1">
        {batch.items.map((i) => (
          <li key={i.candidateId}>
            <label className="flex cursor-pointer items-start gap-2 text-xs text-ink">
              <input
                type="checkbox"
                className="mt-0.5"
                checked={picked.has(i.candidateId)}
                onChange={(e) => {
                  const next = new Set(picked);
                  if (e.target.checked) next.add(i.candidateId);
                  else next.delete(i.candidateId);
                  setPicked(next);
                }}
              />
              <span>
                {i.title}
                {i.size ? <span className="ml-1 text-ink-faint">({i.size})</span> : null}
                {i.detail ? <span className="block text-[11px] text-ink-muted">{i.detail}</span> : null}
              </span>
            </label>
          </li>
        ))}
      </ul>
      <div className="mt-2 flex gap-2">
        <button disabled={busy || picked.size === 0} onClick={() => decide([...picked])} className="rounded-md bg-accent px-3 py-1 text-xs text-white disabled:opacity-50">
          {picked.size === batch.items.length ? 'Approve all' : `Approve ${picked.size}`}
        </button>
        <button disabled={busy} onClick={() => decide([])} className="rounded-md border border-card-strong px-2.5 py-1 text-xs text-ink-muted hover:text-ink disabled:opacity-50">
          Skip all
        </button>
      </div>
      {error && (
        <div role="alert" className="mt-1 text-[11px] text-red-600 dark:text-red-300">
          {error}
        </div>
      )}
    </div>
  );
}
