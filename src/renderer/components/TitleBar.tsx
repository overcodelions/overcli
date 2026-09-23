import { useEffect, useMemo, useRef, useState } from 'react';

import { useStore } from '../store';
import { labOn, type LabKey } from '@shared/labs';
import {
  attentionInbox,
  attentionLabel,
  attentionLevel,
  groupAttention,
  recentWork,
  type AttentionItem,
  type AttentionLevel,
  type RecentItem,
} from '../attentionInbox';
import { WorkerAvatar } from './workers/WorkerAvatar';
import { relativeTime } from './workers/workerDeskSelectors';
import { mostRecentConversationId } from '../conversationLookup';
import { useFlowsStore } from '../flowsStore';
import { flowsLandingSegment, runAttentionBadge } from './flows/runTriage';
import { useSchedulesStore } from '../schedulesStore';
import { useOrchestratorStore } from '../orchestratorStore';
import { useWorkersStore } from '../workersStore';
import { isServiceLive, useServicesStore } from '../servicesStore';
import {
  describeLocation,
  navigateBack,
  navigateToChat,
  navigateForward,
  navigateToTab,
  useNavHistory,
} from '../navHistory';
import { formatShortcutDef, SHORTCUTS } from '../shortcuts';
import {
  SCHEDULE_LABELS,
  SHIFT_LABELS,
  headlineStatus,
  scheduleSubjects,
  workerSubjects,
  type AutomationHeadline,
} from '../upcoming';

/// Custom title bar region. `hiddenInset` window style shows the traffic
/// lights overlaid on our content; pad the left enough to clear them and
/// leave breathing room before the sidebar toggle.
export function TitleBar() {
  const toggleSidebar = useStore((s) => s.toggleSidebar);
  const detailMode = useStore((s) => s.detailMode);
  const labs = useStore((s) => s.settings.labs);
  /// A Labs tab shows when its switch is on (Settings → Labs); a new install
  /// starts with them off. Whatever is open, or has something waiting,
  /// always shows, so nothing live is ever unreachable.
  const showLab = (key: LabKey, mode: string, busy = false) =>
    labOn(labs, key) || detailMode === mode || busy;
  const setDetailMode = useStore((s) => s.setDetailMode);
  const openSheet = useStore((s) => s.openSheet);
  const sidebarVisible = useStore((s) => s.sidebarVisible);
  const whatsNewUnseen = useStore((s) => s.whatsNewUnseen);
  const setActiveRun = useFlowsStore((s) => s.setActiveRun);
  const closeFlowEditor = useFlowsStore((s) => s.closeEditor);
  const setLibrarySegment = useFlowsStore((s) => s.setLibrarySegment);
  const flowRuns = useFlowsStore((s) => s.runs);
  const selectWorker = useWorkersStore((s) => s.selectWorker);
  const showWorkersToday = useWorkersStore((s) => s.showToday);
  const closeWorkerEditor = useWorkersStore((s) => s.closeEditor);
  const schedules = useSchedulesStore((s) => s.schedules);
  const nextFireAt = useSchedulesStore((s) => s.nextFireAt);
  const workers = useWorkersStore((s) => s.workers);
  const nextShiftAt = useWorkersStore((s) => s.nextShiftAt);
  const shiftProgress = useWorkersStore((s) => s.shiftProgress);
  const pendingHire = useWorkersStore((s) => s.pendingHire);
  const hireRunning = useWorkersStore((s) => s.hire.startedAt !== null);
  const allocation = useWorkersStore((s) => s.allocation);
  const openWorkerActivity = useWorkersStore((s) => s.openWorkerActivity);
  const showFunds = useWorkersStore((s) => s.showFunds);
  const resumeHire = useWorkersStore((s) => s.resumeHire);
  const orchestrations = useOrchestratorStore((s) => s.orchestrations);
  const setActiveOrchestration = useOrchestratorStore((s) => s.setActiveOrchestration);
  const requestOrchestrationDetail = useOrchestratorStore((s) => s.requestOrchestrationDetail);

  const flowsBadge = useMemo(() => runAttentionBadge(flowRuns), [flowRuns]);

  // Services are the one thing on this bar that keeps running while you are
  // somewhere else and costs a port the whole time. Without the count, a
  // stack you left up is invisible from every other tab.
  const serviceStacks = useServicesStore((s) => s.stacks);
  const settings = useStore((s) => s.settings);
  const servicesBadge: { count: number; tone: 'waiting' | 'running' } | undefined = useMemo(() => {
    const live = Object.values(serviceStacks)
      .flatMap((stack) => stack.runtimes)
      .filter((r) => isServiceLive(r.status)).length;
    return live > 0 ? { count: live, tone: 'running' } : undefined;
  }, [serviceStacks]);

  // The idle state shows a countdown, and the needs-you alert escalates with
  // age; both are lies the moment they're painted unless something re-renders
  // them. One 30s tick, and only while one of them is on screen.
  const anyArmed = useMemo(
    () =>
      Object.values(schedules).some((s) => s.enabled) ||
      Object.values(workers).some((w) => w.enabled),
    [schedules, workers],
  );
  const [tick, setTick] = useState(0);

  // Everything waiting on you, from every tab — see `attentionInbox`.
  const inbox = useMemo(
    () =>
      attentionInbox({
        runs: flowRuns,
        orchestrations,
        workers,
        funding: allocation?.byWorker ?? null,
        pendingHire,
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [flowRuns, orchestrations, workers, allocation, pendingHire, tick],
  );
  const inboxLevel = attentionLevel(inbox);

  // What you were just in the middle of — see `recentWork`. Pure, so it needs
  // no bookkeeping and survives a reload.
  const recent = useMemo(
    () => recentWork({ runs: flowRuns, orchestrations }, inbox, Date.now()),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [flowRuns, orchestrations, inbox, tick],
  );

  useEffect(() => {
    // Finished work ages out, so the tick has to outlive the last waiting item.
    if (!anyArmed && inbox.length === 0 && recent.length === 0) return;
    const t = setInterval(() => setTick((n) => n + 1), 30_000);
    return () => clearInterval(t);
  }, [anyArmed, inbox.length, recent.length]);

  // Workers carries its share of the same list — a worker's proposals, its
  // paused runs, an unfunded worker, a drafted hire — so the tab and the alert
  // can't disagree. Sky while a hire is still being written.
  const workersWaiting = inbox.filter((it) => it.workerId !== null || it.kind === 'hire').length;
  const workersBadge: { count: number; tone: 'waiting' | 'running' } | undefined =
    workersWaiting > 0
      ? { count: workersWaiting, tone: 'waiting' }
      : hireRunning
        ? { count: 1, tone: 'running' }
        : undefined;

  function openAttention(item: AttentionItem): void {
    switch (item.kind) {
      case 'run':
        // The run pane, not the worker's desk: Continue lives there.
        navigateToTab(() => {
          closeFlowEditor();
          setActiveRun(item.runId);
          setDetailMode('flows');
        });
        return;
      case 'approval':
        if (item.workerId) {
          navigateToTab(
            () => {
              openWorkerActivity(item.workerId as string, item.orchestrationId, item.at);
              setDetailMode('workers');
            },
            { rememberForChat: true },
          );
        } else {
          navigateToTab(() => {
            setActiveRun(null);
            closeFlowEditor();
            setActiveOrchestration(item.orchestrationId);
            requestOrchestrationDetail(item.orchestrationId);
            setDetailMode('orchestrator');
          });
        }
        return;
      case 'hire':
        navigateToTab(
          () => {
            resumeHire();
            setDetailMode('workers');
          },
          { rememberForChat: true },
        );
        return;
      case 'unfunded':
        navigateToTab(
          () => {
            closeWorkerEditor();
            showFunds();
            setDetailMode('workers');
          },
          { rememberForChat: true },
        );
    }
  }

  // ONE chip for both species, naming whichever is actually asking for
  // attention. Shifts are listed first only as the tie-break: two sides in the
  // same state, equally many, firing at the same moment is a coin toss, and
  // the roster is the half with a persona behind it.
  const status = useMemo(
    () =>
      headlineStatus([
        {
          source: 'worker',
          subjects: workerSubjects(workers, nextShiftAt, shiftProgress),
          // Parked batches are the needs-you alert's to announce now; saying
          // it here too would put the same fact on the bar twice.
          waiting: 0,
          labels: SHIFT_LABELS,
        },
        {
          source: 'schedule',
          subjects: scheduleSubjects(schedules, nextFireAt),
          waiting: 0,
          labels: SCHEDULE_LABELS,
        },
      ]),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [workers, nextShiftAt, shiftProgress, schedules, nextFireAt, orchestrations, tick],
  );

  function openSchedules(): void {
    setActiveRun(null);
    closeFlowEditor();
    setLibrarySegment('schedules');
    setDetailMode('flows');
  }

  // Each tab's front page — where a first visit lands, and where generic tab
  // clicks take you. Chat also uses its root when there is no conversation or
  // flow run to resume after Services or Workers.
  function chatRoot(): void {
    // Chat's first-visit/no-restorable-target front page is the conversation
    // you were last in, not the empty composer. The Chat button normally
    // resumes the conversation or flow run interrupted by Services/Workers.
    //
    // Always the latest, even when an older thread is already open. Ranked
    // the way the sidebar ranks Recent, so the destination is the row at the
    // top of the list you can see. (The Chat pane can't show a flow run's
    // conversation — that's a Flows page — so those never win.)
    const s = useStore.getState();
    const recent = mostRecentConversationId(s, s.lastSelectedAt);
    if (recent) {
      s.selectConversation(recent);
      return;
    }
    setDetailMode('conversation');
  }

  function flowsRoot(): void {
    // Never the run detail or the editor: opening on a half-edited draft or a
    // run that finished overnight is not a front page.
    //
    // Which segment is the front page is the one conditional part, and only
    // on the session's first visit — see `flowsLandingSegment`. Chat already
    // works this way (`chatRoot` opens your most recent conversation, not the
    // new-chat screen); a Flows tab that always opens the list of flow
    // DEFINITIONS while three runs sit waiting was the odd one out.
    setActiveRun(null);
    closeFlowEditor();
    const first = useFlowsStore.getState().claimFirstFlowsVisit();
    setLibrarySegment(flowsLandingSegment(useFlowsStore.getState().runs, first));
    setDetailMode('flows');
  }

  function orchestratorRoot(): void {
    // Like Flows, land on the Orchestrator's own surface, not a leftover run
    // detail from another tab.
    setActiveRun(null);
    closeFlowEditor();
    setDetailMode('orchestrator');
  }

  function workersRoot(): void {
    // The work queue, not a desk and not the calendar: the question you
    // arrive at this tab with is "what is my crew doing", and the calendar
    // answers the narrower "who is working when" — right when you are
    // planning the week, wrong every other time you press the tab.
    // selectWorker(null) first so the queue isn't secretly still a selection
    // — it is about every worker at once — and it clears any run filling the
    // pane on the way.
    selectWorker(null);
    closeWorkerEditor();
    closeFlowEditor();
    showWorkersToday();
    setDetailMode('workers');
  }
  const platform = typeof navigator === 'undefined' ? '' : navigator.platform;
  const isMac = platform.toLowerCase().includes('mac');
  const leadingInsetClass = isMac ? 'pl-[92px]' : 'pl-2';
  return (
    <div className={`draggable flex items-center h-[38px] ${leadingInsetClass} pr-3 bg-surface border-b border-card select-none`}>
      <button
        onClick={toggleSidebar}
        className="no-drag p-1 mr-2 text-ink-muted hover:text-ink rounded hover:bg-card-strong"
        title={sidebarVisible ? 'Hide sidebar' : 'Show sidebar'}
      >
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
          <rect x="2" y="3" width="12" height="10" rx="1.5" stroke="currentColor" />
          <line x1="6" y1="3" x2="6" y2="13" stroke="currentColor" />
        </svg>
      </button>
      <HistoryArrows />
      <div className="flex items-center gap-1 no-drag">
        {/* Generic tabs take you to their front pages. Chat may instead resume
            the conversation or flow run interrupted by Services or Workers;
            the Back arrow still retraces every step. */}
        <NavButton
          label="Chat"
          active={detailMode === 'conversation'}
          onClick={() => navigateToChat(chatRoot)}
        />
        {/* The only tab that carries a count. Without it the fact that runs
            are waiting is invisible from every other tab — you had to open
            Flows to find out there was a reason to. Same helper the Runs
            segment uses, so the two can't disagree. */}
        <NavButton
          label="Flows"
          active={detailMode === 'flows'}
          onClick={() => navigateToTab(flowsRoot)}
          badge={flowsBadge}
        />
        {showLab('orchestrator', 'orchestrator') && (
          <NavButton
            label="Orchestrator"
            active={detailMode === 'orchestrator'}
            onClick={() => navigateToTab(orchestratorRoot)}
          />
        )}
        {showLab('workers', 'workers', !!workersBadge) && (
          <NavButton
            label="Workers"
            active={detailMode === 'workers'}
            onClick={() => navigateToTab(workersRoot, { rememberForChat: true })}
            badge={workersBadge}
          />
        )}
        {/* Hidden unless asked for. Most projects have nothing to run, and a
            permanently empty tab is clutter for everyone it does not apply
            to — but never hide it while something is actually running, or a
            live service becomes unreachable. */}
        {(settings.servicesEnabled || servicesBadge) && (
          <NavButton
            label="Services"
            active={detailMode === 'services'}
            onClick={() => navigateToTab(
              () => setDetailMode('services'),
              { rememberForChat: true },
            )}
            badge={servicesBadge}
          />
        )}
      </div>
      <div className="flex-1" />
      {/* Local + Usage are passive dashboards, not action surfaces, so
          they sit on the right alongside the info/settings controls.
          They stay text tabs (they swap the main pane), with a divider
          before the icon buttons so "tabs | icons" reads cleanly. */}
      <div className="flex items-center gap-1 no-drag">
        {(inboxLevel || recent.length > 0) && (
          <AttentionAlert
            items={inbox}
            recent={recent}
            level={inboxLevel}
            workers={workers}
            onOpen={openAttention}
          />
        )}
        {status && (
          <AutomationIndicator
            status={status}
            onClick={
              status.source === 'worker'
                ? () => navigateToTab(workersRoot, { rememberForChat: true })
                : openSchedules
            }
          />
        )}
        {showLab('localModels', 'local') && (
          <NavButton label="Local" active={detailMode === 'local'} onClick={() => setDetailMode('local')} />
        )}
        <NavButton label="Usage" active={detailMode === 'stats'} onClick={() => setDetailMode('stats')} />
      </div>
      <div className="w-px h-4 bg-card-border mx-2" />
      {/* Unread release notes ride the About button rather than earning their
          own control: it's already the "tell me about this app" affordance,
          and the dot is the whole point — a permanent extra icon in the title
          bar costs more than the news is worth once it's been read. */}
      <button
        onClick={() => openSheet({ type: whatsNewUnseen ? 'whatsNew' : 'about' })}
        className="no-drag relative p-1 mr-1 text-ink-muted hover:text-ink rounded hover:bg-card-strong"
        title={whatsNewUnseen ? "What's new in overcli" : 'About overcli'}
      >
        <svg width="16" height="16" viewBox="0 0 20 20" fill="none" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="10" cy="10" r="7" stroke="currentColor" strokeWidth="1.4" />
          <path d="M10 8v5" stroke="currentColor" strokeWidth="1.4" />
          <circle cx="10" cy="5.5" r="0.9" fill="currentColor" />
        </svg>
        {whatsNewUnseen && (
          <span className="absolute right-0.5 top-0.5 h-1.5 w-1.5 rounded-full bg-accent shadow-[0_0_5px_currentColor] text-accent" />
        )}
      </button>
      <button
        onClick={() => openSheet({ type: 'settings' })}
        className="no-drag p-1 text-ink-muted hover:text-ink rounded hover:bg-card-strong"
        title="Settings (⌘,)"
      >
        {/* Clean 8-tooth gear. Previous icon had too many sub-paths at
            16px and rendered fuzzy; this one uses a single stroked path
            plus a center hole so it crisps at display resolution. */}
        <svg width="16" height="16" viewBox="0 0 20 20" fill="none" strokeLinejoin="round" strokeLinecap="round">
          <path
            d="M10 2.5 11 4.3a6 6 0 0 1 1.4.6L14.3 4l1.7 1.7-.9 1.9a6 6 0 0 1 .6 1.4L17.5 10l-1.8 1a6 6 0 0 1-.6 1.4l.9 1.9L14.3 16l-1.9-.9a6 6 0 0 1-1.4.6L10 17.5l-1-1.8a6 6 0 0 1-1.4-.6L5.7 16 4 14.3l.9-1.9a6 6 0 0 1-.6-1.4L2.5 10l1.8-1a6 6 0 0 1 .6-1.4L4 5.7 5.7 4l1.9.9A6 6 0 0 1 9 4.3L10 2.5Z"
            stroke="currentColor"
            strokeWidth="1.3"
          />
          <circle cx="10" cy="10" r="2.2" stroke="currentColor" strokeWidth="1.3" />
        </svg>
      </button>
    </div>
  );
}

/// The one loud thing the bar is allowed: everything waiting on you, from any
/// tab, as a chip that opens a tray of the items themselves. How loud comes
/// from `attentionLevel` — a tint when fresh, a slow violet breath once it has
/// waited, amber and quicker for a stopped run.
function AttentionAlert({
  items,
  recent,
  level,
  workers,
  onOpen,
}: {
  items: AttentionItem[];
  recent: RecentItem[];
  /// Null once nothing is waiting: the chip stays, grey and quiet, for as long
  /// as there is recent work to get back to.
  level: AttentionLevel | null;
  workers: Record<string, Parameters<typeof WorkerAvatar>[0]['worker']>;
  onOpen: (item: AttentionItem) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const chip =
    level === 'blocking'
      ? 'border border-amber-400/60 bg-amber-400/15 text-amber-700 dark:text-amber-300 font-semibold needs-you-loud'
      : level === 'waiting'
        ? 'border border-violet-400/60 bg-violet-400/20 text-violet-700 dark:text-violet-200 font-semibold needs-you-breathe'
        : level === 'calm'
          ? 'bg-violet-400/10 text-violet-700 dark:text-violet-300'
          : // Quiet, not absent: ink-faint on an unfilled chip is invisible on
            // a dark title bar, and a doorway you can't find is no doorway.
            'border border-card-strong bg-card-strong/60 text-ink-muted';
  const now = Date.now();

  return (
    <div ref={ref} className="relative mr-1">
      <button
        onClick={() => setOpen((o) => !o)}
        title={level ? 'Things waiting on you' : 'Nothing waiting — what you were just doing'}
        className={'h-6 px-2.5 rounded-full text-xs flex items-center gap-1.5 ' + chip}
      >
        {level === null ? (
          <span aria-hidden className="w-1.5 h-1.5 rounded-full bg-ink-faint" />
        ) : level === 'calm' ? (
          <span aria-hidden className="w-1.5 h-1.5 rounded-full bg-violet-500 dark:bg-violet-400" />
        ) : (
          <svg aria-hidden width="10" height="10" viewBox="0 0 12 12" fill="currentColor">
            <rect x="3" y="2.5" width="2" height="7" rx="0.6" />
            <rect x="7" y="2.5" width="2" height="7" rx="0.6" />
          </svg>
        )}
        {level === null ? quietLabel(recent) : attentionLabel(items)}
        <svg
          aria-hidden
          width="9"
          height="9"
          viewBox="0 0 10 10"
          fill="none"
          className={open ? '' : 'rotate-180'}
        >
          <path d="M2.5 6.5 5 4l2.5 2.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
      {open && (
        <div className="absolute right-0 top-full mt-1.5 z-50 w-[420px] rounded-lg border border-card-strong bg-surface-elevated shadow-2xl overflow-hidden">
          {items.length > 0 && (
            <div className="px-3.5 py-2 border-b border-card-strong text-[10px] font-semibold uppercase tracking-wider text-violet-700 dark:text-violet-400">
              Needs you · {items.length}
            </div>
          )}
          <div className="max-h-[60vh] overflow-y-auto">
            {groupAttention(items).map((group) => (
              <div key={group.kind}>
                {/* Sticky, so thirty rows still say which pile you're in. */}
                <div className="sticky top-0 z-10 flex items-center justify-between bg-surface-elevated px-3.5 pb-1 pt-2 text-[10px] text-ink-faint">
                  <span>{group.title}</span>
                  <span>{group.items.length}</span>
                </div>
                {group.items.map((item) => {
                  const worker = item.workerId ? workers[item.workerId] : undefined;
                  return (
                    <button
                      key={item.key}
                      onClick={() => {
                        setOpen(false);
                        onOpen(item);
                      }}
                      className="group w-full flex items-center gap-2.5 px-3.5 py-2 text-left hover:bg-card-strong"
                    >
                      <span className="flex w-6 shrink-0 justify-center">
                        {worker ? (
                          <WorkerAvatar worker={worker} size="sm" />
                        ) : (
                          <AttentionGlyph kind={item.kind} />
                        )}
                      </span>
                      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                        <span className="truncate text-xs text-ink">{item.title}</span>
                        <span
                          className={
                            'truncate text-[11px] ' +
                            (item.kind === 'run' && item.urgent
                              ? 'text-amber-600 dark:text-amber-400'
                              : 'text-ink-muted')
                          }
                        >
                          {item.reason}
                        </span>
                      </span>
                      {item.at !== null && (
                        <span className="shrink-0 text-[11px] text-ink-faint">
                          {relativeTime(item.at, now)}
                        </span>
                      )}
                      {/* Every row the same weight — colour matches the row's
                          reason, so only a run that is truly stuck goes amber. */}
                      <span
                        className={
                          'shrink-0 rounded-md border px-2.5 py-0.5 text-[11px] font-medium ' +
                          (item.kind === 'run' && item.urgent
                            ? 'border-amber-400/40 bg-amber-400/15 text-amber-700 group-hover:bg-amber-400/25 dark:text-amber-300'
                            : 'border-violet-400/40 bg-violet-400/15 text-violet-700 group-hover:bg-violet-400/25 dark:text-violet-300')
                        }
                      >
                        Open
                      </span>
                    </button>
                  );
                })}
              </div>
            ))}
            {recent.length > 0 && (
              <div className={items.length > 0 ? 'border-t border-card-strong' : undefined}>
                {/* Two headers, not one: these no longer share a lifetime —
                    the top half lives as long as the work does, the bottom
                    half has minutes left. A row crossing between them is the
                    flow finishing, which is worth seeing. */}
                {recentSections(recent).map((section) => (
                  <div key={section.title}>
                    <div className="sticky top-0 z-10 flex items-center justify-between bg-surface-elevated px-3.5 pb-1 pt-2 text-[10px] text-ink-faint">
                      <span>{section.title}</span>
                      <span>{section.rows.length}</span>
                    </div>
                    {section.rows.map(({ item, at, status }) => (
                      <button
                        key={item.key}
                        onClick={() => {
                          setOpen(false);
                          onOpen(item);
                        }}
                        className={
                          'group w-full flex items-center gap-2.5 px-3.5 py-2 text-left hover:bg-card-strong hover:opacity-100 ' +
                          // Still moving, so it keeps its weight; finished work
                          // recedes.
                          (status.continuing ? 'opacity-95' : 'opacity-70')
                        }
                      >
                    <span className="flex w-6 shrink-0 justify-center">
                      {item.workerId && workers[item.workerId] ? (
                        <WorkerAvatar
                          worker={workers[item.workerId] as Parameters<typeof WorkerAvatar>[0]['worker']}
                          size="sm"
                        />
                      ) : (
                        <AttentionGlyph kind={item.kind} />
                      )}
                    </span>
                    <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                      <span
                        className={
                          'truncate text-xs ' + (status.continuing ? 'text-ink' : 'text-ink-muted')
                        }
                      >
                        {item.title}
                      </span>
                      {/* Its old pause reason is stale the moment it leaves;
                          what it is doing now is the thing worth reading. */}
                      <span
                        className={
                          'truncate text-[11px] ' +
                          (status.continuing
                            ? 'text-emerald-600 dark:text-emerald-400'
                            : 'text-ink-faint')
                        }
                      >
                        {status.label} · {relativeTime(at, now)}
                      </span>
                    </span>
                        <span className="shrink-0 text-[11px] text-ink-faint group-hover:text-ink-muted">
                          Open
                        </span>
                      </button>
                    ))}
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

/// The chip when nothing is waiting. A count of what is still moving is the
/// useful half — "3 recent" tells you only that time passed.
function quietLabel(recent: RecentItem[]): string {
  const going = recent.filter((c) => c.status.continuing).length;
  if (going > 0) return `${going} carrying on`;
  return recent.length === 1 ? '1 just finished' : `${recent.length} just finished`;
}

/// Live work first, and an empty half is simply absent.
function recentSections(recent: RecentItem[]): { title: string; rows: RecentItem[] }[] {
  const going = recent.filter((c) => c.status.continuing);
  const over = recent.filter((c) => !c.status.continuing);
  return [
    { title: 'Carrying on', rows: going },
    { title: 'Just finished', rows: over },
  ].filter((s) => s.rows.length > 0);
}

/// Stand-in for the avatar on rows that don't belong to a worker.
function AttentionGlyph({ kind }: { kind: AttentionItem['kind'] }) {
  return (
    <span className="flex h-6 w-6 items-center justify-center rounded-full bg-card-strong text-ink-muted">
      <svg aria-hidden width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
        {kind === 'run' ? (
          <path d="M3 4h4v8H3zM9 4h4v8H9z" />
        ) : kind === 'approval' ? (
          <path d="M3 8.5 6.5 12 13 4.5" />
        ) : (
          <path d="M8 3v10M3 8h10" />
        )}
      </svg>
    </span>
  );
}

/// Dot + label for unattended activity — a schedule's next firing or the
/// roster's next shift — sitting with the passive dashboards on the right.
/// It's a status readout that happens to be clickable, not a tab, so it
/// doesn't take the active-tab treatment, and it disappears entirely when
/// nothing anywhere is armed. `headlineStatus` decides which of the two it is
/// talking about; this only draws it, and opens whatever it named.
function AutomationIndicator({
  status,
  onClick,
}: {
  status: AutomationHeadline;
  onClick: () => void;
}) {
  // Green for armed — the universal "powered on and ready" signal, and far
  // more legible at 6px than the hollow ring it replaces. It's solid where
  // `running` pulses, which is what keeps the two apart: green sitting still
  // means ready, blue breathing means working.
  const dot =
    status.tone === 'waiting'
      ? 'bg-violet-500 dark:bg-violet-400'
      : status.tone === 'running'
        ? 'bg-sky-500 dark:bg-sky-400 animate-pulse'
        : 'bg-emerald-500 dark:bg-emerald-400';
  // The label stays muted in the idle state on purpose. A green dot is enough
  // to say "armed"; colouring the text too would make a resting schedule
  // compete with the states that actually want you to look.
  const text =
    status.tone === 'waiting'
      ? 'text-violet-700 dark:text-violet-300'
      : status.tone === 'running'
        ? 'text-sky-700 dark:text-sky-300'
        : 'text-ink-muted';
  return (
    <button
      onClick={onClick}
      title={status.title}
      className={
        'px-2.5 py-1 rounded-md text-xs font-medium flex items-center gap-1.5 hover:bg-card-strong ' +
        text
      }
    >
      <span aria-hidden className={'inline-block w-1.5 h-1.5 rounded-full ' + dot} />
      {status.label}
    </button>
  );
}

/// Browser-style back/forward pair, sitting between the sidebar toggle and
/// the tabs — the same slot a browser puts them in, which is the whole
/// reason they're recognisable without a label.
///
/// They stay mounted (rather than appearing once there's history) so the
/// tabs don't shift sideways the first time you navigate; an exhausted
/// direction is dimmed and inert instead.
function HistoryArrows() {
  // Subscribe to the stacks themselves, not just their lengths: the tooltip
  // names the destination, so it has to re-read when the top entry changes
  // even though the arrow stays enabled throughout.
  const back = useNavHistory((s) => s.back);
  const forward = useNavHistory((s) => s.forward);
  const backTo = back[back.length - 1];
  const forwardTo = forward[forward.length - 1];
  const backHint = shortcutHint('nav.back');
  const forwardHint = shortcutHint('nav.forward');
  return (
    <div className="flex items-center no-drag mr-2">
      <HistoryArrow
        dir="back"
        enabled={!!backTo}
        title={backTo ? `Back to ${describeLocation(backTo)}${backHint}` : 'Nothing to go back to'}
        onClick={navigateBack}
      />
      <HistoryArrow
        dir="forward"
        enabled={!!forwardTo}
        title={
          forwardTo
            ? `Forward to ${describeLocation(forwardTo)}${forwardHint}`
            : 'Nothing to go forward to'
        }
        onClick={navigateForward}
      />
    </div>
  );
}

function shortcutHint(id: string): string {
  const def = SHORTCUTS.find((s) => s.id === id);
  return def ? ` (${formatShortcutDef(def)})` : '';
}

function HistoryArrow({
  dir,
  enabled,
  title,
  onClick,
}: {
  dir: 'back' | 'forward';
  enabled: boolean;
  title: string;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      disabled={!enabled}
      title={title}
      aria-label={title}
      className={
        'p-1 rounded ' +
        (enabled
          ? 'text-ink-muted hover:text-ink hover:bg-card-strong'
          : 'text-ink-muted/30 cursor-default')
      }
    >
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none" strokeLinecap="round" strokeLinejoin="round">
        <path
          d={dir === 'back' ? 'M10 3 5 8l5 5' : 'M6 3l5 5-5 5'}
          stroke="currentColor"
          strokeWidth="1.6"
        />
      </svg>
    </button>
  );
}

function NavButton({
  label,
  active,
  onClick,
  badge,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
  /// Live count, same shape and tones as the segmented control's: violet for
  /// blocked-on-you, sky for merely-working.
  badge?: { count: number; tone: 'waiting' | 'running' };
}) {
  return (
    <button
      onClick={onClick}
      className={
        // Weight stays `font-medium` on both states on purpose: bolding the
        // active label re-measures it and shunts every tab to its right.
        'px-3 py-1 rounded-md text-xs font-medium flex items-center gap-1.5 ' +
        (active
          ? // Elevated surface plus a hairline, so the selected tab reads as
            // lifted off the bar in BOTH themes. The old `bg-white/10` was a
            // white wash: fine on the dark bar, nearly invisible on the light
            // one, where 10% white over #f6f6f8 is no contrast at all.
            //
            // Deliberately monochrome. An accent underline was tried here and
            // removed: every colour in this bar is a state you do not already
            // know (violet blocked-on-you, sky running, amber degraded), and
            // spending one on the tab you just clicked both dilutes that
            // vocabulary and makes the bar read as browser chrome.
            'text-ink shadow-[inset_0_0_0_1px_var(--c-card-border-strong)]'
          : 'text-ink-muted hover:text-ink hover:bg-card-strong')
      }
      style={
        active
          ? {
              // Lifted OFF the elevated surface, not set to it. The bar is
              // `--c-surface` (#1c1c21 dark), so the old `bg-white/10` landed
              // near #35353a — lighter than `--c-surface-elevated` (#2a2a33),
              // which made a straight swap read as a darker pill. Mixing ink
              // in keeps the old lightness in dark mode and still goes the
              // right way in light, where it sits just under the bar.
              background: 'color-mix(in srgb, var(--c-ink) 6%, var(--c-surface-elevated))',
            }
          : undefined
      }
    >
      {label}
      {badge && (
        <span
          className={
            'flex items-center gap-1 text-[10px] ' +
            (badge.tone === 'waiting'
              ? 'text-violet-700 dark:text-violet-300'
              : 'text-sky-700 dark:text-sky-300')
          }
        >
          <span
            aria-hidden
            className={
              'w-1.5 h-1.5 rounded-full ' +
              (badge.tone === 'waiting'
                ? 'bg-violet-500 dark:bg-violet-400'
                : 'bg-sky-500 dark:bg-sky-400')
            }
          />
          {badge.count}
        </span>
      )}
    </button>
  );
}
