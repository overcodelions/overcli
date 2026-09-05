import { useEffect, useMemo, useState } from 'react';

import { useStore } from '../store';
import { mostRecentConversationId } from '../conversationLookup';
import { useFlowsStore } from '../flowsStore';
import { flowsLandingSegment, runAttentionBadge } from './flows/runTriage';
import { useSchedulesStore } from '../schedulesStore';
import { useOrchestratorStore } from '../orchestratorStore';
import { useWorkersStore } from '../workersStore';
import {
  describeLocation,
  navigateBack,
  navigateForward,
  navigateToTab,
  useNavHistory,
} from '../navHistory';
import { formatShortcutDef, SHORTCUTS } from '../shortcuts';
import {
  SCHEDULE_LABELS,
  SHIFT_LABELS,
  awaitingApproval,
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
  const orchestrations = useOrchestratorStore((s) => s.orchestrations);

  const flowsBadge = useMemo(() => runAttentionBadge(flowRuns), [flowRuns]);

  // Workers carries the same kind of count, for the one thing on that tab
  // that happens while you are somewhere else: a hire. It drafts for minutes
  // and then sits on a review screen you cannot see from here, which read as
  // the hire having quietly failed. Violet once it is drafted and waiting on
  // you, sky while it is still being written.
  const workersBadge: { count: number; tone: 'waiting' | 'running' } | undefined = pendingHire
    ? { count: 1, tone: 'waiting' }
    : hireRunning
      ? { count: 1, tone: 'running' }
      : undefined;

  // The idle state shows a countdown, which is a lie the moment it's painted
  // unless something re-renders it. One 30s tick, and only while something is
  // actually armed — the indicators aren't on screen otherwise, so neither is
  // the timer.
  const anyArmed = useMemo(
    () =>
      Object.values(schedules).some((s) => s.enabled) ||
      Object.values(workers).some((w) => w.enabled),
    [schedules, workers],
  );
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!anyArmed) return;
    const t = setInterval(() => setTick((n) => n + 1), 30_000);
    return () => clearInterval(t);
  }, [anyArmed]);

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
          waiting: awaitingApproval(orchestrations, 'worker'),
          labels: SHIFT_LABELS,
        },
        {
          source: 'schedule',
          subjects: scheduleSubjects(schedules, nextFireAt),
          waiting: awaitingApproval(orchestrations, 'schedule'),
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

  // Each tab's front page — where the tab lands you on the first visit of the
  // session, and where clicking it while you're already inside it takes you
  // back up to.
  function chatRoot(): void {
    // Chat's front page is the conversation you were last in, not the empty
    // composer. Every other tab's front page is a list you can look at and
    // choose from; Chat's would be a blank prompt, which answers "start
    // something new" — a question the sidebar's + already answers, and not
    // the one you're asking when you press Chat.
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
        {/* Every tab click means the same thing: take me to this tab's front
            page. Not "where I last was inside it" — that made the button you
            press to escape a run the one control that wouldn't, and made the
            click do different things depending on state you can't see.
            Retracing your steps is the Back arrow's job. */}
        <NavButton
          label="Chat"
          active={detailMode === 'conversation'}
          onClick={() => navigateToTab(chatRoot)}
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
        <NavButton
          label="Orchestrator"
          active={detailMode === 'orchestrator'}
          onClick={() => navigateToTab(orchestratorRoot)}
        />
        <NavButton
          label="Workers"
          active={detailMode === 'workers'}
          onClick={() => navigateToTab(workersRoot)}
          badge={workersBadge}
        />
      </div>
      <div className="flex-1" />
      {/* Local + Usage are passive dashboards, not action surfaces, so
          they sit on the right alongside the info/settings controls.
          They stay text tabs (they swap the main pane), with a divider
          before the icon buttons so "tabs | icons" reads cleanly. */}
      <div className="flex items-center gap-1 no-drag">
        {status && (
          <AutomationIndicator
            status={status}
            onClick={
              status.source === 'worker'
                ? () => navigateToTab(workersRoot)
                : openSchedules
            }
          />
        )}
        <NavButton label="Local" active={detailMode === 'local'} onClick={() => setDetailMode('local')} />
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
        'px-3 py-1 rounded-md text-xs font-medium flex items-center gap-1.5 ' +
        (active
          ? 'bg-white/10 text-ink'
          : 'text-ink-muted hover:text-ink hover:bg-card-strong')
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
