// The sidebar's Work tab: everything in flight or done, beside Places (where
// things live). It replaced Recent, so it does Recent's job first — what needs
// you and what is running sit pinned at the top, and anything live or made of
// one thing opens in one click (see workOpen.ts). Below that, everything else,
// newest first. The sidebar's search box searches work while this tab is on;
// see Sidebar.tsx.

import { useEffect, useMemo, useState } from 'react';

import { gitLine, gitTone } from './WorkPane';
import { searchWorkRecords, transcriptHitsByRecord, type WorkMatch, type WorkRecord } from '@shared/workRecords';
import { RUNNING_MARKER_COLOR } from '../SidebarMarker';
import { useFlowsStore } from '../../flowsStore';
import { useOrchestratorStore } from '../../orchestratorStore';
import { useRunningMap } from '../../runnersStore';
import { useRunTouchedAt } from '../../runTouched';
import { useStore } from '../../store';
import { useWorkersStore } from '../../workersStore';
import { alternateTarget, liveness, primaryTarget, type LiveState, type Liveness, type OpenTarget } from './workOpen';
import { useLoadWorkPrs, useWorkPlaces, useWorkRecords, useWorkStore } from '../../workStore';
import { KIND_DOT, STATUS_LABEL, STATUS_TONE, groupByAge, openTeamTask, shortDate } from './WorkPane';

type Filter = 'all' | 'shipped' | 'run' | 'chat';

const FILTERS: Array<[Filter, string]> = [
  ['all', 'All'],
  ['shipped', 'Shipped'],
  ['run', 'Runs'],
  ['chat', 'Chats'],
];

const PAGE = 80;

export function WorkSidebarList() {
  const records = useWorkRecords();
  const places = useWorkPlaces();
  const query = useWorkStore((s) => s.query);
  const promptHits = useWorkStore((s) => s.promptHits);
  const promptHitsFor = useWorkStore((s) => s.promptHitsFor);
  const selectedKey = useWorkStore((s) => s.selectedKey);
  const logLoaded = useWorkStore((s) => s.logLoaded);
  const loadLog = useWorkStore((s) => s.loadLog);
  const markSeen = useWorkStore((s) => s.markSeen);
  const openRecord = useWorkStore((s) => s.openRecord);
  const detailMode = useStore((s) => s.detailMode);
  const selectedTeamTaskId = useWorkersStore((s) => s.selectedTeamTaskId);
  const selectedConversationId = useStore((s) => s.selectedConversationId);
  const runs = useFlowsStore((s) => s.runs);
  const activeRunId = useFlowsStore((s) => s.activeRunId);
  const runningMap = useRunningMap();
  const touchedAt = useRunTouchedAt();
  const runningChatIds = useMemo(() => {
    const ids = new Set<string>();
    for (const [id, r] of Object.entries(runningMap)) if (r?.isRunning) ids.add(id);
    return ids;
  }, [runningMap]);
  const [filter, setFilter] = useState<Filter>('all');
  const [shown, setShown] = useState(PAGE);

  useEffect(() => {
    if (!logLoaded) void loadLog();
    if (!useOrchestratorStore.getState().loaded) void useOrchestratorStore.getState().reload();
    markSeen();
  }, [logLoaded, loadLog, markSeen]);
  useLoadWorkPrs(records, places);
  useEffect(() => setShown(PAGE), [query, filter]);

  const matches = useMemo(() => {
    const q = query.trim();
    const hits = promptHitsFor && promptHitsFor === q ? transcriptHitsByRecord(records, promptHits) : undefined;
    return searchWorkRecords(records, query, hits).filter(({ record }) =>
      filter === 'all'
        ? true
        : filter === 'shipped'
          ? record.status === 'merged' || record.status === 'landed'
          : filter === 'run'
            ? record.kind !== 'chat'
            : record.kind === 'chat',
    );
  }, [records, query, promptHits, promptHitsFor, filter]);

  const live = useMemo(() => {
    const out = new Map<string, Liveness>();
    const now = Date.now();
    for (const m of matches) out.set(m.record.key, liveness(m.record, runs, runningChatIds, now, touchedAt));
    return out;
  }, [matches, runs, runningChatIds, touchedAt]);
  // What Recent was for: what needs you, then what is running, pinned above
  // the history — only while browsing, since a search is after something else.
  const pinning = !query.trim() && filter === 'all';
  const needsYou = pinning ? matches.filter((m) => live.get(m.record.key)?.state === 'needs-you') : [];
  const running = pinning ? matches.filter((m) => live.get(m.record.key)?.state === 'running') : [];
  const rest = pinning
    ? matches.filter((m) => {
        const s = live.get(m.record.key)?.state;
        return s !== 'needs-you' && s !== 'running';
      })
    : matches;
  const groups = [
    ...(needsYou.length ? [{ label: 'Needs you', items: needsYou }] : []),
    ...(running.length ? [{ label: 'Running', items: running }] : []),
    ...groupByAge(rest.slice(0, shown)),
  ];

  const go = (target: OpenTarget, key: string) => {
    if (target.type === 'record') openRecord(key);
    else if (target.type === 'chat') useStore.getState().selectConversation(target.id);
    else if (target.type === 'team') openTeamTask(target.teamId, target.taskId);
    else {
      useFlowsStore.getState().setActiveRun(target.id);
      useStore.getState().setDetailMode('flows');
    }
  };
  const isOnScreen = (r: WorkRecord) =>
    (detailMode === 'work' && selectedKey === r.key) ||
    (detailMode === 'conversation' && r.chats.some((c) => c.id === selectedConversationId)) ||
    (detailMode === 'flows' && r.runs.some((x) => x.id === activeRunId)) ||
    (detailMode === 'workers' && !!r.team && r.team.taskId === selectedTeamTaskId);
  const searching = query.trim().length >= 3 && promptHitsFor !== query.trim();

  return (
    <div className="flex flex-col">
      {/* The filters and the match count stay pinned while the list scrolls
          under them — the sidebar's own background, so rows don't show
          through. */}
      <div className="sticky top-0 z-10 bg-surface-muted pb-1">
      <div className="flex items-center gap-1 px-1 pt-1.5 pb-1">
        {FILTERS.map(([value, label]) => (
          <button
            key={value}
            onClick={() => setFilter(value)}
            aria-pressed={filter === value}
            className={
              'rounded-full px-2 py-px text-[10.5px] ' +
              (filter === value
                ? 'bg-card-strong text-ink'
                : 'border border-card-strong text-ink-faint hover:text-ink-muted')
            }
          >
            {label}
          </button>
        ))}
        <span className="flex-1" />
        <button
          onClick={() => useWorkStore.getState().open()}
          title="Browse all work with more filters"
          className="text-[10.5px] text-ink-faint hover:text-accent px-1"
        >
          Full view
        </button>
      </div>
      {query.trim() && (
        <div className="px-2 pb-1 text-[10.5px] text-ink-faint">
          {matches.length} match{matches.length === 1 ? '' : 'es'}
          {searching ? ' · searching what you typed…' : ''}
        </div>
      )}
      </div>
      {groups.map((g) => (
        <div key={g.label}>
          <div
            className={
              'px-2 pt-2.5 pb-1 text-[10px] uppercase tracking-wider font-semibold ' +
              (g.label === 'Needs you'
                ? 'text-amber-600 dark:text-amber-300'
                : g.label === 'Running'
                  ? 'text-emerald-600 dark:text-emerald-300'
                  : 'text-ink-faint')
            }
          >
            {g.label}
            {g.label === 'Needs you' || g.label === 'Running' ? ` · ${g.items.length}` : ''}
          </div>
          {g.items.map((m: WorkMatch) => {
            const l = live.get(m.record.key) ?? { state: null };
            const primary = primaryTarget(m.record, l, runs);
            return (
              <WorkSidebarRow
                key={m.record.key}
                record={m.record}
                live={l.state}
                opensDirect={primary.type !== 'record'}
                selected={isOnScreen(m.record)}
                fromTranscript={m.fromTranscript}
                onOpen={(alt) => go(alt ? alternateTarget(m.record, primary, runs) : primary, m.record.key)}
                onDetails={() => openRecord(m.record.key)}
              />
            );
          })}
        </div>
      ))}
      {rest.length > shown && (
        <button onClick={() => setShown((n) => n + PAGE)} className="px-2 py-1.5 text-left text-[11px] text-ink-faint hover:text-ink-muted">
          Show {Math.min(PAGE, rest.length - shown)} more
        </button>
      )}
      {matches.length === 0 && (
        <div className="px-2 py-3 text-xs text-ink-faint">
          {query.trim() ? `Nothing matches “${query.trim()}”.` : 'Finished runs, batches and chats show up here.'}
        </div>
      )}
    </div>
  );
}

// The sidebar's own vocabulary, as Places draws it: amber waits on you, the
// running pulse is working.
const LIVE_DOT: Record<LiveState, string> = {
  'needs-you': 'bg-amber-400',
  running: 'animate-pulse',
  paused: 'bg-ink-faint/60',
};

function WorkSidebarRow({
  record: r,
  live,
  opensDirect,
  selected,
  fromTranscript,
  onOpen,
  onDetails,
}: {
  record: WorkRecord;
  live: LiveState | null;
  opensDirect: boolean;
  selected: boolean;
  fromTranscript?: boolean;
  onOpen: (alternate: boolean) => void;
  onDetails: () => void;
}) {
  const kindLabel = r.kind === 'batch' ? (r.jobs[0]?.workerName ?? 'batch') : r.kind === 'run' ? 'flow run' : 'chat';
  // A lone chat can be put away from here, as it could from Recent.
  const loneChat = r.chats.length === 1 && r.runs.length === 0 && r.jobs.length === 0 && !r.chats[0].archived ? r.chats[0] : null;
  const liveLabel = live === 'needs-you' ? 'Needs you' : live === 'running' ? 'Running' : live === 'paused' ? 'Paused' : null;
  return (
    <div className={'sidebar-row group relative rounded ' + (selected ? 'sidebar-row-selected' : 'hover:bg-card-strong')}>
      <button
        onClick={(e) => onOpen(e.altKey)}
        aria-current={selected ? 'page' : undefined}
        title={`${r.title}\n${opensDirect ? 'Click to open · ⌥-click for its record' : 'Click for its record · ⌥-click to open the latest part'}`}
        // Full width at rest; room for the hover buttons only while they show.
        className="w-full text-left px-2 py-1.5 group-hover:pr-12 group-focus-within:pr-12 flex flex-col gap-0.5"
      >
        <span className="flex items-center gap-1.5 min-w-0">
          {live ? (
            <span
              className={`w-1.5 h-1.5 rounded-full flex-none ${LIVE_DOT[live]}`}
              style={live === 'running' ? { background: RUNNING_MARKER_COLOR } : undefined}
              aria-label={liveLabel ?? undefined}
            />
          ) : (
            <span className={`w-1.5 h-1.5 rounded-sm flex-none ${KIND_DOT[r.kind]}`} aria-hidden />
          )}
          <span className={`text-[13px] leading-[18px] truncate ${selected ? 'text-ink font-medium' : 'text-ink'}`}>{r.title}</span>
          {live === 'paused' && (
            <span
              className="ml-auto flex-none text-[9.5px] font-semibold px-1.5 rounded-full bg-card-strong text-ink-muted"
              title="Paused — you paused it, or it has sat long enough that it no longer counts as waiting on you"
            >
              Paused
            </span>
          )}
          {!live && STATUS_LABEL[r.status] && r.status !== 'done' && r.status !== 'running' && (
            <span className={`ml-auto flex-none text-[9.5px] font-semibold px-1.5 rounded-full ${STATUS_TONE[r.status]}`}>
              {STATUS_LABEL[r.status]}
            </span>
          )}
        </span>
        <span className="pl-3 flex items-center gap-1.5 min-w-0 text-[11px] text-ink-faint">
          <span className="truncate">
            {r.placeName} · {fromTranscript ? 'matched what you typed' : kindLabel} · {shortDate(r.updatedAt)}
          </span>
          {r.pr ? (
            <span className="flex-none ml-auto text-[10.5px] font-medium text-ink-muted">PR #{r.pr.number}</span>
          ) : gitLine(r) ? (
            <span className={`flex-none ml-auto max-w-[55%] truncate text-[10.5px] font-medium ${gitTone(r)}`} title={gitLine(r)}>
              {gitLine(r)}
            </span>
          ) : null}
        </span>
      </button>
      {/* On hover: the record page for any row, and archive-or-delete for a lone chat. */}
      <span className="absolute right-1 top-1 hidden group-hover:flex group-focus-within:flex items-center gap-0.5">
        <button
          onClick={onDetails}
          title="Details — the record page"
          aria-label={`Details for ${r.title}`}
          className="w-5 h-5 rounded flex items-center justify-center text-ink-faint hover:text-ink hover:bg-card-strong"
        >
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden>
            <circle cx="12" cy="12" r="9" />
            <path d="M12 11v6M12 7.5v.01" />
          </svg>
        </button>
        {loneChat && (
          // The same × as every other chat row in the sidebar: it opens the
          // archive-or-delete sheet rather than acting on one click.
          <button
            onClick={() => useStore.getState().openSheet({ type: 'archiveConversation', convId: loneChat.id })}
            title="Archive or delete conversation…"
            aria-label={`Archive or delete ${r.title}`}
            className="w-5 h-5 rounded flex items-center justify-center text-[12px] leading-none text-ink-faint hover:text-red-400 hover:bg-card-strong"
          >
            ×
          </button>
        )}
      </span>
    </div>
  );
}
