import { useEffect, useMemo, useState } from 'react';

import { useStore } from '../store';
import { useFlowsStore } from '../flowsStore';
import { useSchedulesStore } from '../schedulesStore';
import { useOrchestratorStore } from '../orchestratorStore';
import { isOrchestrationAwaitingApproval } from '@shared/flows/orchestration';
import { untilLabel } from '@shared/flows/schedule';

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
  const schedules = useSchedulesStore((s) => s.schedules);
  const nextFireAt = useSchedulesStore((s) => s.nextFireAt);
  const orchestrations = useOrchestratorStore((s) => s.orchestrations);

  // The idle state shows a countdown, which is a lie the moment it's painted
  // unless something re-renders it. One 30s tick, and only while a schedule is
  // actually armed — the indicator isn't on screen otherwise, so neither is
  // the timer.
  const anyArmed = useMemo(
    () => Object.values(schedules).some((s) => s.enabled),
    [schedules],
  );
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!anyArmed) return;
    const t = setInterval(() => setTick((n) => n + 1), 30_000);
    return () => clearInterval(t);
  }, [anyArmed]);

  // What the schedule indicator has to say, in priority order. Nothing armed
  // → nothing rendered: a permanently-lit chrome item for a feature you don't
  // use is just noise in the one strip that's always on screen.
  const scheduleStatus = useMemo(() => {
    const armed = Object.values(schedules).filter((s) => s.enabled);
    if (armed.length === 0) return null;
    const running = armed.filter((s) => s.activeRunId).length;
    // A parked proposal outranks a running run: one is blocked on the user,
    // the other is just working.
    const waiting = Object.values(orchestrations).filter(
      isOrchestrationAwaitingApproval,
    ).length;
    // Every state leads with the same word and varies only the tail. The chip
    // has no context around it — a title bar isn't a list with a header — so
    // the noun has to be in the label itself, and repeating it means the user
    // learns what this thing is once rather than re-reading it each time.
    if (waiting > 0) {
      return {
        tone: 'waiting' as const,
        label: waiting === 1 ? 'Scheduled · needs approval' : `Scheduled · ${waiting} to approve`,
        title: 'A scheduled batch is waiting for you to approve it',
      };
    }
    if (running > 0) {
      return {
        tone: 'running' as const,
        label: running === 1 ? 'Scheduled · running' : `Scheduled · ${running} running`,
        title: 'A schedule is running right now',
      };
    }
    // Armed but idle. The countdown is what proves the thing is alive rather
    // than forgotten, but it only means anything with the noun in front of it
    // — "in 3h" on its own is a time with no subject.
    const soonest = armed
      .map((s) => nextFireAt[s.id])
      .filter((at): at is number => typeof at === 'number')
      .sort((a, b) => a - b)[0];
    const counted = `${armed.length} ${armed.length === 1 ? 'schedule' : 'schedules'} armed`;
    return {
      tone: 'armed' as const,
      label: soonest ? `Scheduled · ${untilLabel(soonest)}` : 'Scheduled',
      title: soonest ? `${counted} · next at ${new Date(soonest).toLocaleString()}` : counted,
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [schedules, nextFireAt, orchestrations, tick]);

  function openSchedules(): void {
    setActiveRun(null);
    closeFlowEditor();
    setLibrarySegment('schedules');
    setDetailMode('flows');
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
      <div className="flex items-center gap-1 no-drag">
        <NavButton label="Chat" active={detailMode === 'conversation'} onClick={() => setDetailMode('conversation')} />
        <NavButton
          label="Flows"
          active={detailMode === 'flows'}
          onClick={() => {
            // Clicking Flows in the title bar always lands on the
            // library — never the run detail, the editor, or the
            // Schedules segment. The user's mental model is "Flows tab =
            // the list of flows"; jumping them back into a half-edited
            // draft or a finished run from a previous session breaks
            // that expectation.
            setActiveRun(null);
            closeFlowEditor();
            setLibrarySegment('flows');
            setDetailMode('flows');
          }}
        />
        <NavButton
          label="Orchestrator"
          active={detailMode === 'orchestrator'}
          onClick={() => {
            // Like Flows, clicking the tab should land on the Orchestrator's
            // own surface, not a leftover run detail from another tab.
            setActiveRun(null);
            closeFlowEditor();
            setDetailMode('orchestrator');
          }}
        />
        <NavButton
          label="Workers"
          active={detailMode === 'workers'}
          onClick={() => {
            setActiveRun(null);
            closeFlowEditor();
            setDetailMode('workers');
          }}
        />
      </div>
      <div className="flex-1" />
      {/* Local + Usage are passive dashboards, not action surfaces, so
          they sit on the right alongside the info/settings controls.
          They stay text tabs (they swap the main pane), with a divider
          before the icon buttons so "tabs | icons" reads cleanly. */}
      <div className="flex items-center gap-1 no-drag">
        {scheduleStatus && (
          <ScheduleIndicator status={scheduleStatus} onClick={openSchedules} />
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

/// Dot + label for scheduled activity, sitting with the passive dashboards on
/// the right. It's a status readout that happens to be clickable, not a tab —
/// so it doesn't take the active-tab treatment, and it disappears entirely
/// when nothing is armed.
function ScheduleIndicator({
  status,
  onClick,
}: {
  status: { tone: 'waiting' | 'running' | 'armed'; label: string; title: string };
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

function NavButton({ label, active, onClick }: { label: string; active: boolean; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className={
        'px-3 py-1 rounded-md text-xs font-medium ' +
        (active
          ? 'bg-white/10 text-ink'
          : 'text-ink-muted hover:text-ink hover:bg-card-strong')
      }
    >
      {label}
    </button>
  );
}
