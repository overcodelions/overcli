// Work: everything shipped or started, found by what it was rather than by
// which tool did it. See shared/workRecords.ts for how a record is stitched
// together from chats, runs, batches and the PR its branch landed in.
//
// Reached from the top of the sidebar and from ⌘K (⇧↵ searches here) — it is
// something you go looking in now and then, not a place you work, so it never
// earned a tab.

import { useEffect, useMemo, useRef, useState } from 'react';

import {
  gitSummary,
  repoSummary,
  searchWorkRecords,
  transcriptHitsByRecord,
  type WorkMatch,
  type WorkRecord,
  type WorkRecordRun,
  type WorkStatus,
} from '@shared/workRecords';
import { useFlowsStore } from '../../flowsStore';
import { useOrchestratorStore } from '../../orchestratorStore';
import { useStore } from '../../store';
import { RunTranscriptView } from './RunTranscriptView';
import { KeepWorking } from './KeepWorking';
import { RepoGitTable } from './RepoGitTable';
import { useLoadWorkPrs, useWorkPlaces, useWorkRecords, useWorkStore } from '../../workStore';

type KindFilter = 'all' | 'run' | 'batch' | 'chat';

const KINDS: Array<{ id: KindFilter; label: string }> = [
  { id: 'all', label: 'Everything' },
  { id: 'run', label: 'Flow runs' },
  { id: 'batch', label: 'Batches & shifts' },
  { id: 'chat', label: 'Chats' },
];

const PAGE = 120;

export const STATUS_LABEL: Record<WorkStatus, string> = {
  merged: 'Merged',
  landed: 'Landed',
  'pr-open': 'PR open',
  'pr-closed': 'PR closed',
  running: 'Running',
  done: 'Done',
  failed: 'Failed',
  chat: '',
};

export const STATUS_TONE: Record<WorkStatus, string> = {
  merged: 'bg-green-500/15 text-green-700 dark:text-green-300',
  landed: 'bg-green-500/15 text-green-700 dark:text-green-300',
  'pr-open': 'bg-accent/15 text-accent',
  'pr-closed': 'bg-card-strong text-ink-muted',
  running: 'bg-sky-500/15 text-sky-700 dark:text-sky-300',
  done: 'bg-card-strong text-ink-muted',
  failed: 'bg-red-500/15 text-red-700 dark:text-red-300',
  chat: '',
};

export const KIND_DOT: Record<WorkRecord['kind'], string> = {
  run: 'bg-accent',
  batch: 'bg-teal-500',
  chat: 'bg-backend-claude',
};

export function WorkPane() {
  const records = useWorkRecords();
  const places = useWorkPlaces();
  const query = useWorkStore((s) => s.query);
  const setQuery = useWorkStore((s) => s.setQuery);
  const selectedKey = useWorkStore((s) => s.selectedKey);
  const select = useWorkStore((s) => s.select);
  const promptHits = useWorkStore((s) => s.promptHits);
  const promptHitsFor = useWorkStore((s) => s.promptHitsFor);
  const logLoaded = useWorkStore((s) => s.logLoaded);
  const loadLog = useWorkStore((s) => s.loadLog);
  const markSeen = useWorkStore((s) => s.markSeen);

  const [kind, setKind] = useState<KindFilter>('all');
  const [place, setPlace] = useState<string>('');
  const [shippedOnly, setShippedOnly] = useState(false);
  const [shown, setShown] = useState(PAGE);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!logLoaded) void loadLog();
    if (!useOrchestratorStore.getState().loaded) void useOrchestratorStore.getState().reload();
    markSeen();
    return () => markSeen();
  }, [logLoaded, loadLog, markSeen]);

  useLoadWorkPrs(records, places);

  const matches = useMemo(() => {
    const hits = promptHitsFor && promptHitsFor === query.trim() ? transcriptHitsByRecord(records, promptHits) : undefined;
    return searchWorkRecords(records, query, hits).filter(({ record }) => {
      if (kind !== 'all' && record.kind !== kind) return false;
      if (place && record.placePath !== place) return false;
      if (shippedOnly && record.status !== 'merged' && record.status !== 'landed') return false;
      return true;
    });
  }, [records, query, promptHits, promptHitsFor, kind, place, shippedOnly]);

  useEffect(() => setShown(PAGE), [query, kind, place, shippedOnly]);

  const counts = useMemo(() => {
    const base = searchWorkRecords(records, query);
    return {
      all: base.length,
      run: base.filter((m) => m.record.kind === 'run').length,
      batch: base.filter((m) => m.record.kind === 'batch').length,
      chat: base.filter((m) => m.record.kind === 'chat').length,
    } satisfies Record<KindFilter, number>;
  }, [records, query]);

  const selected = selectedKey ? records.find((r) => r.key === selectedKey) : undefined;
  if (selected) return <WorkRecordDetail key={selected.key} record={selected} onBack={() => select(null)} />;

  const groups = groupByAge(matches.slice(0, shown));
  const placeOptions = [...new Map(records.map((r) => [r.placePath, r.placeName])).entries()].sort((a, b) =>
    a[1].localeCompare(b[1]),
  );

  return (
    <div className="flex flex-col min-h-0 flex-1">
      <div className="px-10 pt-6 pb-4 flex flex-col gap-4 flex-none border-b border-card bg-surface-muted/60">
        <div className="flex flex-col gap-1">
          <h1 className="m-0 text-2xl font-bold tracking-tight text-ink" style={{ fontFamily: "'Bricolage Grotesque', sans-serif" }}>
            Work
          </h1>
          <div className="text-xs text-ink-muted">
            Everything shipped or started. Each chat, run, batch and PR on the same branch is one record.
          </div>
        </div>
        <label className="field flex items-center gap-2 px-3 py-2">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className="text-ink-faint flex-none" aria-hidden>
            <circle cx="11" cy="11" r="7" />
            <path d="M20 20l-3.5-3.5" />
          </svg>
          <span className="sr-only">Search work</span>
          <input
            ref={inputRef}
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape' && query) {
                e.stopPropagation();
                setQuery('');
              }
            }}
            placeholder="Search titles, what you typed, branches, PRs, tickets…"
            className="flex-1 min-w-0 bg-transparent outline-none text-sm text-ink placeholder:text-ink-faint"
          />
          {query && (
            <button onClick={() => setQuery('')} aria-label="Clear search" className="text-ink-faint hover:text-ink text-xs px-1">
              ✕
            </button>
          )}
        </label>
        <div className="flex items-center gap-2 flex-wrap">
          {KINDS.map((k) => (
            <button
              key={k.id}
              onClick={() => setKind(k.id)}
              className={
                'text-[11px] font-medium px-3 py-1 rounded-full border ' +
                (kind === k.id ? 'border-accent bg-accent/10 text-ink' : 'border-card-strong text-ink-muted hover:text-ink')
              }
            >
              {k.label} <span className="text-ink-faint font-normal">{counts[k.id]}</span>
            </button>
          ))}
          <div className="flex-1" />
          <label className="flex items-center gap-1.5 text-[11px] text-ink-muted">
            <span className="sr-only">Place</span>
            <select value={place} onChange={(e) => setPlace(e.target.value)} className="field text-[11px] px-2 py-1">
              <option value="">All places</option>
              {placeOptions.map(([path, name]) => (
                <option key={path} value={path}>
                  {name}
                </option>
              ))}
            </select>
          </label>
          <label className="flex items-center gap-1.5 text-[11px] text-ink-muted">
            <input type="checkbox" checked={shippedOnly} onChange={(e) => setShippedOnly(e.target.checked)} />
            Shipped only
          </label>
        </div>
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto px-10 py-6">
        {query.trim() && (
          <div className="text-[11px] text-ink-faint mb-4">
            {matches.length} match{matches.length === 1 ? '' : 'es'} for “{query.trim()}”
            {query.trim().length >= 3 && promptHitsFor !== query.trim() ? ' · searching what you typed…' : ''}
          </div>
        )}
        {groups.map((g) => (
          <section key={g.label} className="mb-6">
            <h2 className="text-[11px] uppercase tracking-wider text-ink-faint font-bold mb-2 m-0">{g.label}</h2>
            <div className="flex flex-col gap-2">
              {g.items.map((m) => (
                <WorkRow key={m.record.key} match={m} onOpen={() => select(m.record.key)} />
              ))}
            </div>
          </section>
        ))}
        {matches.length > shown && (
          <button onClick={() => setShown((n) => n + PAGE)} className="text-xs text-accent hover:underline">
            Show {Math.min(PAGE, matches.length - shown)} more
          </button>
        )}
        {matches.length === 0 && (
          <div className="mt-10 text-center text-xs text-ink-muted">
            {query.trim()
              ? 'Nothing matches. Try a branch name, a PR number, or a word you remember typing.'
              : 'Nothing here yet — finished runs, batches and chats show up as you work.'}
          </div>
        )}
      </div>
    </div>
  );
}

function WorkRow({ match, onOpen }: { match: WorkMatch; onOpen: () => void }) {
  const r = match.record;
  return (
    <button
      onClick={onOpen}
      className="w-full text-left flex gap-3 items-start px-4 py-3 rounded-lg border border-card bg-card hover:border-card-strong"
    >
      <span className={`w-2 h-2 mt-1.5 rounded-sm flex-none ${KIND_DOT[r.kind]}`} aria-hidden />
      <span className="flex-1 min-w-0 flex flex-col gap-1.5">
        <span className="flex items-center gap-2 min-w-0">
          <span className="text-[13px] font-semibold text-ink truncate">{r.title}</span>
          {STATUS_LABEL[r.status] && (
            <span className={`text-[10px] font-semibold px-1.5 py-0.5 rounded-full flex-none ${STATUS_TONE[r.status]}`}>
              {STATUS_LABEL[r.status]}
            </span>
          )}
          <span className="flex-1" />
          <span className="text-[11px] text-ink-faint flex-none">{shortDate(r.updatedAt)}</span>
        </span>
        {match.snippet ? (
          <span className="text-xs text-ink-muted line-clamp-2">
            {match.fromTranscript && <span className="text-ink-faint">You typed: </span>}
            {match.snippet.pre}
            <mark className="bg-accent/25 text-ink rounded-sm px-0.5">{match.snippet.hit}</mark>
            {match.snippet.post}
          </span>
        ) : r.headline ? (
          <span className="text-xs text-ink-muted line-clamp-2">{r.headline}</span>
        ) : null}
        <span className="flex items-center gap-1.5 flex-wrap text-[11px] text-ink-muted">
          <Chip>{r.placeName}</Chip>
          {r.ticket && <Chip>{r.ticket}</Chip>}
          {r.runs.length > 0 && <Chip>{r.runs.length === 1 ? r.runs[0].flowName : `${r.runs.length} runs`}</Chip>}
          {r.jobs[0]?.workerName && <Chip>{r.jobs[0].workerName}</Chip>}
          {r.chats.length > 0 && <Chip>{r.chats.length === 1 ? '1 chat' : `${r.chats.length} chats`}</Chip>}
          {r.pr && <Chip>PR #{r.pr.number}</Chip>}
          {!r.pr && gitLine(r) && <Chip>{gitLine(r)}</Chip>}
          {r.branch && <span className="font-mono text-[10px] text-ink-faint ml-1 truncate">{r.branch}</span>}
        </span>
      </span>
    </button>
  );
}

function Chip({ children }: { children: React.ReactNode }) {
  return <span className="px-1.5 py-0.5 rounded bg-card-strong">{children}</span>;
}

type TrailKind = 'run' | 'batch' | 'chat' | 'pr';

interface TrailStep {
  key: string;
  at: number;
  kind: TrailKind;
  label: string;
  title: string;
  sub?: string;
  note?: string;
  action?: { label: string; run: () => void };
}

const TRAIL_TONE: Record<TrailKind, string> = {
  run: 'text-accent bg-accent/15',
  batch: 'text-teal-600 dark:text-teal-300 bg-teal-500/15',
  chat: 'text-backend-claude bg-backend-claude/15',
  pr: 'text-green-700 dark:text-green-300 bg-green-500/15',
};

function TrailIcon({ kind }: { kind: TrailKind }) {
  const common = { width: 14, height: 14, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const, 'aria-hidden': true };
  if (kind === 'chat') return <svg {...common}><path d="M4 5h16v11H9l-5 4z" /></svg>;
  if (kind === 'pr')
    return (
      <svg {...common}>
        <circle cx="6" cy="6" r="2.5" /><circle cx="6" cy="18" r="2.5" /><circle cx="18" cy="12" r="2.5" />
        <path d="M6 8.5v7M8 7c5 0 8 1 8 3" />
      </svg>
    );
  if (kind === 'batch')
    return (
      <svg {...common}>
        <circle cx="12" cy="5" r="2" /><circle cx="5" cy="19" r="2" /><circle cx="12" cy="19" r="2" /><circle cx="19" cy="19" r="2" />
        <path d="M12 7v10M12 11H5v6M12 11h7v6" />
      </svg>
    );
  return (
    <svg {...common}>
      <circle cx="6" cy="6" r="2.5" /><circle cx="18" cy="18" r="2.5" />
      <path d="M8.5 6H14a4 4 0 014 4v5.5" />
    </svg>
  );
}

function WorkRecordDetail({ record: r, onBack }: { record: WorkRecord; onBack: () => void }) {
  const query = useWorkStore((s) => s.query);
  const runs = useFlowsStore((s) => s.runs);
  const [copied, setCopied] = useState(false);
  /// An evicted run being read back from its transcripts.
  const [reading, setReading] = useState<WorkRecordRun | null>(null);
  const openExternal = (url: string) => void window.overcli.invoke('app:openExternal', url);
  const openChat = (id: string) => useStore.getState().selectConversation(id);
  const openRun = (id: string) => {
    useFlowsStore.getState().setActiveRun(id);
    useStore.getState().setDetailMode('flows');
  };
  const openBatch = (id: string) => {
    useOrchestratorStore.getState().setActiveOrchestration(id);
    useStore.getState().setDetailMode('orchestrator');
  };
  const copyBranch = () => {
    if (!r.branch) return;
    void navigator.clipboard.writeText(r.branch).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    });
  };

  if (reading) return <RunTranscriptView run={reading} record={r} ask={askOf(r)} onBack={() => setReading(null)} />;

  const steps: TrailStep[] = [];
  for (const job of r.jobs) {
    steps.push({
      key: `job:${job.orchestrationId}`,
      at: r.startedAt - 1,
      kind: 'batch',
      label: job.workerName ? `${job.workerName} shift` : 'Batch',
      title: job.title,
      action: { label: 'Open batch', run: () => openBatch(job.orchestrationId) },
    });
  }
  for (const run of r.runs) {
    const retained = !!runs[run.id];
    steps.push({
      key: `run:${run.id}`,
      at: run.at,
      kind: 'run',
      label: `Flow run · ${run.flowName}`,
      title: run.title,
      ...(retained
        ? { action: { label: 'Open run', run: () => openRun(run.id) } }
        : {
            note: 'The run itself is no longer kept — its steps are read back from the transcripts.',
            action: { label: 'See what it did →', run: () => setReading(run) },
          }),
    });
  }
  for (const chat of r.chats) {
    steps.push({
      key: `chat:${chat.id}`,
      at: chat.at,
      kind: 'chat',
      label: chat.archived ? 'Chat · archived' : 'Chat',
      title: chat.name,
      action: { label: 'Open chat', run: () => openChat(chat.id) },
    });
  }
  if (r.pr) {
    const pr = r.pr;
    steps.push({
      key: 'pr',
      at: pr.mergedAt ? Date.parse(pr.mergedAt) : r.updatedAt + 1,
      kind: 'pr',
      label: `PR #${pr.number} · ${pr.state === 'MERGED' ? 'merged' : pr.state === 'OPEN' ? 'open' : 'closed'}`,
      title: pr.title,
      action: { label: 'Open on GitHub ↗', run: () => openExternal(pr.url) },
    });
  }
  steps.sort((a, b) => a.at - b.at);

  const primary = r.pr
    ? { label: 'Open PR ↗', run: () => openExternal(r.pr!.url) }
    : [...steps].reverse().find((s) => s.action)?.action;
  const ask = askOf(r);
  const stats: Array<[string, string]> = [
    ['Runs', String(r.runs.length)],
    ['Chats', String(r.chats.length)],
    ['Batches', String(r.jobs.length)],
    ['Took', span(r.startedAt, r.updatedAt)],
    ['Last touched', shortDate(r.updatedAt)],
  ];

  return (
    <div className="flex flex-col min-h-0 flex-1 overflow-y-auto">
      <header className="px-10 pt-5 pb-6 border-b border-card bg-surface-muted/60">
        <button onClick={onBack} className="text-xs text-ink-muted hover:text-ink">
          ‹ Work{query.trim() ? ` · “${query.trim()}”` : ''}
        </button>
        <div className="mt-3 flex items-start gap-6">
          <div className="flex-1 min-w-0 flex flex-col gap-3">
            <div className="flex items-center gap-2 text-[11px] text-ink-faint uppercase tracking-wider font-semibold">
              <span className={`w-2 h-2 rounded-sm ${KIND_DOT[r.kind]}`} aria-hidden />
              {r.kind === 'batch' ? 'Batch' : r.kind === 'run' ? 'Flow work' : 'Chat'} · {r.placeName}
            </div>
            <h1
              className="m-0 text-[28px] leading-tight font-bold tracking-tight text-ink"
              style={{ fontFamily: "'Bricolage Grotesque', sans-serif" }}
            >
              {r.title}
            </h1>
            <div className="flex items-center gap-2 flex-wrap text-xs text-ink-muted">
              {STATUS_LABEL[r.status] && (
                <span className={`text-[11px] font-semibold px-2 py-0.5 rounded-full ${STATUS_TONE[r.status]}`}>
                  {STATUS_LABEL[r.status]}
                </span>
              )}
              {r.branch && (
                <button
                  onClick={copyBranch}
                  title="Copy branch name"
                  className="font-mono text-[11px] px-2 py-0.5 rounded bg-card-strong text-ink-muted hover:text-ink"
                >
                  {copied ? 'copied' : r.branch}
                </button>
              )}
              {r.ticket && <span className="text-[11px] px-2 py-0.5 rounded bg-card-strong">{r.ticket}</span>}
              <span className="text-ink-faint">Started {shortDate(r.startedAt)}</span>
            </div>
          </div>
          {primary && (
            <button
              onClick={primary.run}
              className="flex-none mt-6 text-xs font-semibold px-4 py-2 rounded-md bg-accent text-white hover:opacity-90"
            >
              {primary.label}
            </button>
          )}
        </div>
        <dl className="mt-6 grid grid-cols-5 gap-px rounded-lg overflow-hidden border border-card bg-[var(--c-card-border)]">
          {stats.map(([label, value]) => (
            <div key={label} className="bg-surface px-4 py-3">
              <dt className="text-[10px] uppercase tracking-wider text-ink-faint font-semibold">{label}</dt>
              <dd className="m-0 mt-1 text-lg font-semibold text-ink tabular-nums">{value}</dd>
            </div>
          ))}
        </dl>
      </header>

      <div className="px-10 py-8 grid grid-cols-1 xl:grid-cols-[minmax(0,3fr)_minmax(340px,2fr)] gap-10">
        <section className="min-w-0">
          <h2 className="text-[11px] uppercase tracking-wider text-ink-faint font-bold m-0 mb-4">The trail</h2>
          {steps.length === 0 ? (
            <div className="text-xs text-ink-faint">Nothing linked yet.</div>
          ) : (
            <ol className="relative m-0 p-0 list-none">
              <span className="absolute left-[15px] top-4 bottom-4 w-px bg-[var(--c-card-border-strong)]" aria-hidden />
              {steps.map((s) => (
                <li key={s.key} className="relative flex gap-4 pb-5 last:pb-0">
                  <span className={`relative z-[1] flex-none w-8 h-8 rounded-full flex items-center justify-center ring-4 ring-[var(--c-surface)] ${TRAIL_TONE[s.kind]}`}>
                    <TrailIcon kind={s.kind} />
                  </span>
                  {/* The whole card opens the step — the link on the right only
                      says where to. */}
                  <button
                    onClick={s.action?.run}
                    disabled={!s.action}
                    className="flex-1 min-w-0 text-left rounded-lg border border-card bg-card px-4 py-3 group enabled:hover:border-card-strong enabled:hover:bg-card-strong/40 disabled:cursor-default"
                  >
                    <span className="flex items-center gap-3">
                      <span className="text-[11px] font-semibold text-ink-muted">{s.label}</span>
                      <span className="text-[11px] text-ink-faint">{shortDate(s.at)}</span>
                      <span className="flex-1" />
                      {s.action && (
                        <span className="text-xs font-medium text-accent group-hover:underline">{s.action.label}</span>
                      )}
                    </span>
                    <span className="block mt-1 text-[13px] text-ink leading-snug">{s.title}</span>
                    {s.note && <span className="block mt-1.5 text-[11px] text-ink-faint">{s.note}</span>}
                  </button>
                </li>
              ))}
            </ol>
          )}
          <RepoGitTable record={r} />
        </section>

        <aside className="min-w-0 flex flex-col gap-6">
          <KeepWorking record={r} ask={ask} />
          <section>
            <h2 className="text-[11px] uppercase tracking-wider text-ink-faint font-bold m-0 mb-3">What it was</h2>
            <div className="rounded-lg border border-card bg-card px-5 py-4 flex flex-col gap-2">
              {r.headline ? (
                <>
                  <div className="text-sm text-ink leading-relaxed">{r.headline}</div>
                  {r.summary && <div className="text-xs text-ink-muted leading-relaxed whitespace-pre-wrap">{r.summary}</div>}
                </>
              ) : (
                <div className="text-xs text-ink-faint">No summary was recorded for this work — what was asked is below.</div>
              )}
            </div>
          </section>
          {ask && (
            <section>
              <h2 className="text-[11px] uppercase tracking-wider text-ink-faint font-bold m-0 mb-3">What was asked</h2>
              <blockquote className="m-0 rounded-lg border border-card bg-card px-5 py-4 text-xs text-ink-muted leading-relaxed whitespace-pre-wrap line-clamp-[14]">
                {ask}
              </blockquote>
            </section>
          )}
          <section>
            <h2 className="text-[11px] uppercase tracking-wider text-ink-faint font-bold m-0 mb-3">Details</h2>
            <dl className="m-0 rounded-lg border border-card bg-card divide-y divide-[var(--c-card-border)] text-xs">
              <DetailRow label="Place" value={r.placeName} />
              {r.branch && <DetailRow label="Branch" value={<span className="font-mono">{r.branch}</span>} />}
              {r.git && (
                <DetailRow
                  label="Git"
                  value={
                    <span title={r.git.lastSubject ? `Last commit: ${r.git.lastSubject}` : undefined}>
                      {gitSummary(r.git) ?? 'up to date'}
                      {r.git.lastCommitAt ? (
                        <span className="text-ink-faint"> · last commit {shortDate(r.git.lastCommitAt)}</span>
                      ) : null}
                    </span>
                  }
                />
              )}
              {r.ticket && <DetailRow label="Ticket" value={r.ticket} />}
              {r.pr && (
                <DetailRow
                  label="Pull request"
                  value={
                    <button onClick={() => openExternal(r.pr!.url)} className="text-accent hover:underline">
                      #{r.pr.number}
                    </button>
                  }
                />
              )}
              <DetailRow label="Started" value={fullDate(r.startedAt)} />
              <DetailRow label="Last touched" value={fullDate(r.updatedAt)} />
            </dl>
            {r.branch && (
              <p className="mt-3 mb-0 text-[11px] text-ink-faint">
                Everything on <span className="font-mono">{r.branch}</span> in {r.placeName} is part of this record.
              </p>
            )}
          </section>
        </aside>
      </div>
    </div>
  );
}

function DetailRow({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-center gap-4 px-5 py-2.5">
      <dt className="w-24 flex-none text-ink-faint">{label}</dt>
      <dd className="m-0 flex-1 min-w-0 truncate text-ink">{value}</dd>
    </div>
  );
}

/// What was asked, when the record carries a prompt beyond its title.
function askOf(r: WorkRecord): string {
  const lines = r.body.split('\n').slice(1);
  const drop = new Set([r.headline, r.summary, r.branch, r.placeName, r.ticket].filter(Boolean));
  return lines
    .filter((l) => l.trim() && !drop.has(l) && !l.startsWith('PR #'))
    .slice(0, 14)
    .join('\n')
    .trim();
}

function span(from: number, to: number): string {
  const ms = Math.max(0, to - from);
  const h = ms / 3_600_000;
  if (h < 1) return `${Math.max(1, Math.round(ms / 60_000))}m`;
  if (h < 48) return `${Math.round(h)}h`;
  return `${Math.round(h / 24)}d`;
}

function fullDate(ms: number): string {
  return new Date(ms).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

/// The git line for a row: across repos when the work spans several (or has
/// no branch of its own), else the one branch. "no commits yet" says nothing
/// on a row — most chats have none — so it is left to the record page.
export function gitLine(r: WorkRecord): string | undefined {
  const line = r.repoGit.length > 1 || (!r.git && r.repoGit.length) ? repoSummary(r) : gitSummary(r.git);
  return line === 'no commits yet' ? undefined : line;
}

/// Its colour: amber while work is only on this machine, blue once pushed,
/// green once in the trunk.
export function gitTone(r: WorkRecord): string {
  const all = r.repoGit.length ? r.repoGit.map((g) => g.status) : r.git ? [r.git] : [];
  if (all.some((s) => (s.uncommitted ?? 0) > 0 || (s.local && !s.remote && s.ahead > 0) || s.unpushed > 0)) {
    return 'text-amber-700 dark:text-amber-300';
  }
  if (all.length && all.every((s) => s.inTrunk && s.ahead === 0)) return 'text-green-700 dark:text-green-300';
  return 'text-accent';
}

export function shortDate(ms: number): string {
  const d = new Date(ms);
  const now = new Date();
  const sameYear = d.getFullYear() === now.getFullYear();
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', ...(sameYear ? {} : { year: 'numeric' }) });
}

export function groupByAge(matches: WorkMatch[]): Array<{ label: string; items: WorkMatch[] }> {
  const now = new Date();
  const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const day = 24 * 60 * 60 * 1000;
  const labelFor = (ms: number): string => {
    if (ms >= startOfDay) return 'Today';
    if (ms >= startOfDay - day) return 'Yesterday';
    if (ms >= startOfDay - 6 * day) return 'This week';
    if (ms >= startOfDay - 13 * day) return 'Last week';
    const d = new Date(ms);
    return d.toLocaleDateString(undefined, {
      month: 'long',
      ...(d.getFullYear() === now.getFullYear() ? {} : { year: 'numeric' }),
    });
  };
  const out: Array<{ label: string; items: WorkMatch[] }> = [];
  for (const m of matches) {
    const label = labelFor(m.record.updatedAt);
    const last = out[out.length - 1];
    if (last?.label === label) last.items.push(m);
    else out.push({ label, items: [m] });
  }
  return out;
}
