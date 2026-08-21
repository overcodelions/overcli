// Top-level flows pane. Library list + (in Phase 3) the editor + (in
// Phase 4) the run pane. For Phase 2 this is a list view with create /
// edit / delete; Run is wired in Phase 4 when the runtime can execute
// the steps.

import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';

import { useFlowsStore } from '../../flowsStore';
import { useStore } from '../../store';
import {
  flowProjectPath,
  flowRunActivityAt,
  flowRunOwnerPath,
  flowRunTitle as runTitle,
  flowStarKey,
  type Flow,
} from '@shared/flows/schema';
import { deleteFlowRunWithDirtyGuard } from './deleteRun';
import {
  flowTagCounts,
  installedRegistryKeys,
  registryEntryMatchesQuery,
} from './flowGrouping';
import {
  SCOPES, SORTS, filterFlows, scopeCounts, sortFlows,
  type FlowScope, type FlowSort,
} from './flowLibraryFilters';
import { compactStepModel } from './flowSpine';
import { FlowOverviewPanel } from './FlowOverviewPanel';
import { FlowEditor } from './FlowEditor';
import { FlowRunPane } from './FlowRunPane';
import { NewFlowPicker } from './NewFlowPicker';
import { BrowseLibraryModal } from './BrowseLibraryModal';
import { FlowMonogram } from './FlowMonogram';
import { FlowRunLauncher } from './FlowLaunch';
import { FlowsAboutContent, FlowsAboutModal } from './FlowsAbout';
import { SchedulesPane } from './SchedulesPane';
import { useSchedulesStore } from '../../schedulesStore';
import { useWorkersStore } from '../../workersStore';
import { describeTrigger, untilLabel } from '@shared/flows/schedule';
import { useOrchestratorStore } from '../../orchestratorStore';
import { isOrchestrationAwaitingApproval } from '@shared/flows/orchestration';
import type { FlowRun } from '@shared/flows/schema';

export function FlowsLibraryPane() {
  const projects = useStore((s) => s.projects);
  const flows = useFlowsStore((s) => s.flows);
  const loaded = useFlowsStore((s) => s.loaded);
  const reload = useFlowsStore((s) => s.reload);
  const editor = useFlowsStore((s) => s.editor);
  const openEditor = useFlowsStore((s) => s.openEditor);
  const activeRunId = useFlowsStore((s) => s.activeRunId);
  const justSaved = useFlowsStore((s) => s.justSaved);
  const dismissJustSaved = useFlowsStore((s) => s.dismissJustSaved);
  // The overview drawer is `fixed`, so nothing above it reflows on its own.
  // FlowLibraryList already reserves the width for the rows; the page header
  // lives up here, so it has to be told separately or "+ New flow" and
  // "Browse library" sit underneath the drawer.
  const [overviewOpen, setOverviewOpen] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [browseOpen, setBrowseOpen] = useState(false);
  // Seeded from the library's own filter when the user browses out of a
  // failed local search, so they don't retype it in the modal.
  const [browseQuery, setBrowseQuery] = useState('');
  const [aboutOpen, setAboutOpen] = useState(false);
  // Schedules are a segment here rather than a top-level tab: a schedule is a
  // trigger on a flow, not a separate kind of work, and a fourth tab would
  // have made a third place to launch a run from. The segment lives in the
  // store so the title bar can deep-link into it from any tab.
  const segment = useFlowsStore((s) => s.librarySegment);
  const setSegment = useFlowsStore((s) => s.setLibrarySegment);
  const settings = useStore((s) => s.settings);
  const saveSettings = useStore((s) => s.saveSettings);
  const schedules = useSchedulesStore((s) => s.schedules);
  const orchestrations = useOrchestratorStore((s) => s.orchestrations);
  const allRuns = useFlowsStore((s) => s.runs);
  // The Runs tab's badge mirrors the schedule one: blocked-on-you outranks
  // merely-working.
  const runsBadge = useMemo((): { count: number; tone: 'waiting' | 'running' } | undefined => {
    const t = triageRunCounts(allRuns);
    if (t.needsYou > 0) return { count: t.needsYou, tone: 'waiting' };
    if (t.running > 0) return { count: t.running, tone: 'running' };
    return undefined;
  }, [allRuns]);
  // A parked proposal outranks a running run on the tab: one is blocked on the
  // user, the other is just working and will notify when it's done.
  const scheduleBadge = useMemo((): { count: number; tone: 'waiting' | 'running' } | undefined => {
    const waiting = Object.values(orchestrations).filter(
      (o) => o.origin?.kind === 'schedule' && isOrchestrationAwaitingApproval(o),
    ).length;
    if (waiting > 0) return { count: waiting, tone: 'waiting' };
    const running = Object.values(schedules).filter((s) => s.activeRunId).length;
    return running > 0 ? { count: running, tone: 'running' } : undefined;
  }, [schedules, orchestrations]);

  // Arriving on Schedules retires the discovery glow, however the user got
  // here — the segment button, the library strip, or the title bar.
  useEffect(() => {
    if (segment === 'schedules' && !settings.seenSchedules) {
      void saveSettings({ ...settings, seenSchedules: true });
    }
  }, [segment, settings.seenSchedules]);

  function showSchedules(): void {
    setSegment('schedules');
  }

  // Auto-dismiss the "Saved" banner after 3 seconds.
  useEffect(() => {
    if (!justSaved) return;
    const t = setTimeout(dismissJustSaved, 3000);
    return () => clearTimeout(t);
  }, [justSaved?.at]);

  const projectPaths = useMemo(() => projects.map((p) => p.path), [projects]);

  useEffect(() => {
    void reload(projectPaths);
    // re-run when project list changes so newly added projects' .overcli/flows show up
  }, [projectPaths.join('|')]);

  // Seed persisted runs from disk on first mount so the Active + Recent
  // sections light up immediately after an app restart instead of only
  // showing runs started this session.
  useEffect(() => {
    void window.overcli.invoke('flows:listRuns').then((runs) => {
      useFlowsStore.getState().applyRunsBulk(runs);
    });
  }, []);

  // Key on the run id so switching flows mounts a fresh FlowRunPane
  // instead of reusing the instance — otherwise per-run local state
  // (focusStepId / autoFollowedId) carries over. A step manually picked
  // in the previous flow would stay selected, and since that step id
  // doesn't exist in the new flow, nothing highlights and the body
  // falsely reads "no participants".
  if (activeRunId) return <FlowRunPane key={activeRunId} runId={activeRunId} />;
  if (editor.kind !== 'idle') return <FlowEditor />;

  return (
    <div className="flex-1 overflow-y-auto p-6">
      <div
        className={
          'flex flex-wrap items-center gap-3 mb-2 transition-[padding] duration-150 ' +
          (overviewOpen ? 'pr-[440px]' : '')
        }
      >
        <div className="text-2xl font-semibold">Flows</div>
        {/* A real segmented control, not two bare words. The track is what
            makes the inactive half legible as an option: without an enclosing
            surface, "Schedules" was just grey text next to a heading and read
            as a subtitle rather than something you could click. The filled
            pill then says which one you're on.

            Sits well clear of the title, too — butted against a 2xl heading
            the two read as one crowded lump instead of a title and a control. */}
        <div className="flex items-center gap-0.5 ml-5 p-0.5 rounded-lg bg-card border border-card-strong">
          <SegmentTab
            label="Library"
            active={segment === 'flows'}
            onClick={() => setSegment('flows')}
          />
          <SegmentTab
            label="Runs"
            active={segment === 'runs'}
            onClick={() => setSegment('runs')}
            badge={runsBadge}
          />
          <SegmentTab
            label="Schedules"
            glyph={<ClockGlyph />}
            active={segment === 'schedules'}
            onClick={showSchedules}
            discover={!settings.seenSchedules && segment !== 'schedules'}
            badge={scheduleBadge}
          />
        </div>
        {segment === 'flows' && (
          <>
            {/* `ink-muted` and a glyph, not `ink-faint` on its own: faint is
                this codebase's tone for disabled and for metadata, and sat
                between a segmented control and two filled buttons it read as
                the least pressable thing on the row. It's the answer to "what
                is this page", which is not a footnote. */}
            <button
              onClick={() => setAboutOpen(true)}
              className="text-xs text-ink-muted hover:text-ink ml-auto hover:bg-white/5 px-2 py-1 rounded flex items-center gap-1.5"
              title="What is a flow?"
            >
              <span aria-hidden>?</span>
              What's a flow
            </button>
            <button
              onClick={() => void reload(projectPaths)}
              className="text-xs text-ink-faint hover:text-ink hover:bg-white/5 px-2 py-1 rounded"
            >
              ↻ Refresh
            </button>
            <button
              onClick={() => setPickerOpen(true)}
              className="text-xs px-3 py-1.5 rounded-md bg-accent text-white hover:opacity-90"
            >
              + New flow
            </button>
            <button
              onClick={() => { setBrowseQuery(''); setBrowseOpen(true); }}
              className="text-xs px-3 py-1.5 rounded-md border border-card-strong hover:bg-white/5"
            >
              Browse library
            </button>
          </>
        )}
      </div>
      {/* One line on what this rung of the ladder is (chat → flows →
          orchestrator → workers). Under the title, not beside it — beside a
          2xl heading a sentence reads as misalignment, not a subtitle. */}
      <div className="text-xs text-ink-muted mb-6">
        {segment === 'schedules'
          ? 'Flows on a timer — a saved run, or a batch proposal, firing on a cadence.'
          : segment === 'runs'
            ? 'What the flows have been doing — live, waiting on you, stalled, and finished.'
            : 'Organized threads of work — one ask runs through a repeatable chain of roles, reviews, and artifacts.'}
      </div>

      {justSaved && (
        <div
          onClick={dismissJustSaved}
          className="flex items-center gap-2 mb-4 text-sm text-emerald-700 dark:text-emerald-200 bg-emerald-500/15 border border-emerald-400/40 rounded px-3 py-2 cursor-pointer"
        >
          <span>✓</span>
          <span>Saved <span className="font-semibold">{justSaved.name}</span>.</span>
          <span className="ml-auto text-[11px] text-emerald-700 dark:text-emerald-200/70">dismiss</span>
        </div>
      )}

      {segment === 'schedules' ? (
        <SchedulesPane />
      ) : segment === 'runs' ? (
        <RunsOverview standalone />
      ) : (
        <>
          <ScheduleStrip onOpen={showSchedules} />
          <RunsStrip onOpen={() => setSegment('runs')} />

          {!loaded ? (
            <div className="text-sm text-ink-muted">Loading flows…</div>
          ) : flows.length === 0 ? (
            <EmptyState onCreate={() => setPickerOpen(true)} />
          ) : (
            <FlowLibraryList
              flows={flows}
              projectPaths={projectPaths}
              onBrowse={(q) => { setBrowseQuery(q); setBrowseOpen(true); }}
              onOverviewOpenChange={setOverviewOpen}
            />
          )}
        </>
      )}

      {pickerOpen && <NewFlowPicker onClose={() => setPickerOpen(false)} />}
      {browseOpen && (
        <BrowseLibraryModal
          initialQuery={browseQuery}
          onClose={() => {
            setBrowseOpen(false);
            // Pick up anything installed while the modal was open.
            void reload(projectPaths);
          }}
        />
      )}
      {aboutOpen && (
        <FlowsAboutModal
          onClose={() => setAboutOpen(false)}
          onCreate={() => setPickerOpen(true)}
          onBrowse={() => {
            setBrowseQuery('');
            setBrowseOpen(true);
          }}
        />
      )}
    </div>
  );
}

/// One line about schedules, sitting in the default view so the feature is
/// findable without clicking anything.
///
/// Escalates rather than nags. With schedules armed it's a status line (what
/// fires next, or what's running now). With none and the segment never opened,
/// it's a one-time invitation. With none and the segment already seen, it
/// renders nothing at all — the user has looked and decided, and a permanent
/// prompt to use a feature is just clutter.
function ScheduleStrip({ onOpen }: { onOpen: () => void }) {
  const schedules = useSchedulesStore((s) => s.schedules);
  const nextFireAt = useSchedulesStore((s) => s.nextFireAt);
  const seen = useStore((s) => s.settings.seenSchedules);

  const rows = useMemo(() => Object.values(schedules), [schedules]);
  const running = rows.filter((s) => s.activeRunId);
  // Soonest enabled schedule. `nextFireAt` comes from main so this never
  // second-guesses the engine's own arithmetic.
  const next = useMemo(() => {
    let best: { name: string; at: number; trigger: string } | null = null;
    for (const s of rows) {
      const at = nextFireAt[s.id];
      if (!s.enabled || !at) continue;
      if (!best || at < best.at) {
        best = { name: s.name, at, trigger: describeTrigger(s.trigger) };
      }
    }
    return best;
  }, [rows, nextFireAt]);

  if (rows.length === 0) {
    if (seen) return null;
    return (
      <button
        onClick={onOpen}
        className="w-full mb-5 flex items-center gap-2.5 text-left rounded-lg border border-accent/40 bg-accent/5 px-3.5 py-2.5 hover:bg-accent/10 transition-colors"
      >
        <span className="text-base leading-none">⏱</span>
        <span className="flex-1 min-w-0">
          <span className="block text-[13px] text-ink">Run flows on a schedule</span>
          <span className="block text-[11px] text-ink-muted">
            Launch a flow on a timer — or have the orchestrator triage overnight and leave a
            batch waiting for your approval.
          </span>
        </span>
        <span className="text-[11px] text-accent whitespace-nowrap">Set one up →</span>
      </button>
    );
  }

  return (
    <button
      onClick={onOpen}
      className="w-full mb-5 flex items-center gap-2 text-left rounded-md border border-card px-3 py-1.5 hover:bg-card/40 transition-colors"
    >
      <span className="text-ink-faint text-[11px]">⏱</span>
      {running.length > 0 ? (
        <span className="text-[11px] text-sky-700 dark:text-sky-300 flex items-center">
          <RunningDot />
          {running.length === 1
            ? `${running[0].name} is running now`
            : `${running.length} schedules running now`}
        </span>
      ) : next ? (
        <span className="text-[11px] text-ink-muted truncate" title={next.trigger}>
          Next: <span className="text-ink">{next.name}</span> {untilLabel(next.at)}
        </span>
      ) : (
        <span className="text-[11px] text-ink-faint">
          {rows.length} {rows.length === 1 ? 'schedule' : 'schedules'} · all paused
        </span>
      )}
      <span className="ml-auto text-[11px] text-ink-faint">Schedules →</span>
    </button>
  );
}


/// A paused run this quiet isn't waiting for a decision — it's been left
/// behind. Five days keeps a long weekend's worth of honest "I'll get to it"
/// out of the stalled pile.
const STALL_AFTER_DAYS = 5;
const STALL_AFTER_MS = STALL_AFTER_DAYS * 24 * 60 * 60 * 1000;

/// One triage, three consumers: the Runs tab badge, the library's one-line
/// strip, and the overview's sections — so the counts can never disagree.
function triageRunCounts(runs: Record<string, FlowRun>): {
  running: number;
  needsYou: number;
  stalled: number;
} {
  const now = Date.now();
  let running = 0;
  let needsYou = 0;
  let stalled = 0;
  for (const r of Object.values(runs)) {
    if (r.state.kind === 'running' || r.state.kind === 'watching') running++;
    else if (r.state.kind === 'paused') {
      if (now - flowRunActivityAt(r) <= STALL_AFTER_MS) needsYou++;
      else stalled++;
    }
  }
  return { running, needsYou, stalled };
}

/// The library's one-line teaser for the Runs tab — activity belongs to Runs
/// now, so the library only says how much of it there is and where it went.
function RunsStrip({ onOpen }: { onOpen: () => void }) {
  const runs = useFlowsStore((s) => s.runs);
  const t = useMemo(() => triageRunCounts(runs), [runs]);
  if (t.running + t.needsYou + t.stalled === 0) return null;
  return (
    <button
      onClick={onOpen}
      className="w-full mb-5 flex items-center gap-3 text-left rounded-md border border-card px-3 py-1.5 hover:bg-card/40 transition-colors"
    >
      {t.running > 0 && (
        <span className="text-[11px] text-sky-700 dark:text-sky-300 flex items-center">
          <RunningDot />
          {t.running} running
        </span>
      )}
      {t.needsYou > 0 && (
        <span className="flex items-center gap-1 text-[11px] text-violet-700 dark:text-violet-300">
          <span aria-hidden className="w-1.5 h-1.5 rounded-full bg-violet-500 dark:bg-violet-400" />
          {t.needsYou} need{t.needsYou === 1 ? 's' : ''} you
        </span>
      )}
      {t.stalled > 0 && (
        <span className="text-[11px] text-ink-faint">{t.stalled} stalled</span>
      )}
      <span className="ml-auto text-[11px] text-ink-faint whitespace-nowrap">Runs →</span>
    </button>
  );
}

/// The Runs segment: every run triaged by what it wants from the user —
/// Running (nothing — just visibility), Needs you (a decision), Stalled
/// (collapsed, sweepable), Recent (collapsed history). Renders as rows (not
/// grid cards) so timestamps + project + actions fit cleanly on each line
/// and the layout reads top-to-bottom like a log. `standalone` renders the
/// empty state instead of vanishing — as its own tab it can't just be blank.
function RunsOverview({ standalone }: { standalone?: boolean } = {}) {
  const runs = useFlowsStore((s) => s.runs);
  const projects = useStore((s) => s.projects);
  const workspaces = useStore((s) => s.workspaces);
  const sorted = useMemo(
    () => Object.values(runs).sort((a, b) => b.createdAt - a.createdAt),
    [runs],
  );
  // "Active" used to be one undifferentiated pile, and with standing workers
  // and schedules feeding it, it became an untriaged inbox — the one live run
  // buried under sixteen paused ones from three weeks ago. Split by what each
  // run wants from the user: nothing (running), a decision (paused recently),
  // or an admission that it's been abandoned (paused and quiet for days).
  const now = Date.now();
  const running = sorted.filter(
    (r) =>
      r.state.kind === 'running' ||
      // A watching run is an ongoing commitment (it's polling), so it belongs
      // with the live set, not buried in recent.
      r.state.kind === 'watching',
  );
  const paused = sorted.filter((r) => r.state.kind === 'paused');
  const needsYou = paused.filter((r) => now - flowRunActivityAt(r) <= STALL_AFTER_MS);
  const stalled = paused.filter((r) => now - flowRunActivityAt(r) > STALL_AFTER_MS);
  const recent = sorted.filter(
    (r) =>
      r.state.kind === 'done' || r.state.kind === 'aborted' || r.state.kind === 'archived',
  );
  const [showRecent, setShowRecent] = useState(false);
  const [showStalled, setShowStalled] = useState(false);
  const [sweeping, setSweeping] = useState(false);

  // The sweep: archive the whole stalled tail in one act. Archiving never
  // touches worktrees (only explicit delete does), so there is nothing to
  // guard — an archived run stays in Recent and can still be reopened.
  async function archiveStalled(): Promise<void> {
    if (sweeping) return;
    setSweeping(true);
    try {
      for (const run of stalled) {
        await window.overcli.invoke('flows:archiveRun', { runId: run.id });
      }
    } finally {
      setSweeping(false);
    }
  }

  // Resolve project / workspace display names for the run rows. Cheap
  // map by path; falls back to the path basename if no match.
  const nameForPath = useMemo(() => {
    const m = new Map<string, string>();
    for (const p of projects) m.set(p.path, p.name);
    for (const w of workspaces) m.set(w.rootPath, w.name);
    return m;
  }, [projects, workspaces]);

  if (running.length === 0 && paused.length === 0 && recent.length === 0) {
    if (!standalone) return null;
    return (
      <div className="rounded-xl bg-card p-6 text-sm text-ink-muted">
        Nothing has run yet. Launch a flow from the Library, let a schedule fire, or work a
        worker&apos;s shift — every run lands here, sorted by what it needs from you.
      </div>
    );
  }

  return (
    <div className="mb-6">
      {running.length > 0 && (
        <>
          <SectionHeading title="Running" count={running.length} accent />
          <div className="space-y-1.5 mb-4">
            {running.map((run) => (
              <RunRow key={run.id} run={run} projectLabel={nameForPath.get(flowRunOwnerPath(run))} />
            ))}
          </div>
        </>
      )}
      {needsYou.length > 0 && (
        <>
          <SectionHeading title="Needs you" count={needsYou.length} waiting />
          <div className="space-y-1.5 mb-4">
            {needsYou.map((run) => (
              <RunRow key={run.id} run={run} projectLabel={nameForPath.get(flowRunOwnerPath(run))} />
            ))}
          </div>
        </>
      )}
      {stalled.length > 0 && (
        <>
          <div className="flex items-center gap-2 mb-2">
            <button
              onClick={() => setShowStalled((v) => !v)}
              className="flex items-center gap-2 text-[11px] uppercase tracking-wider text-ink-faint hover:text-ink"
            >
              <span>{showStalled ? '▼' : '▶'}</span>
              <span>Stalled</span>
              <span className="text-ink-faint normal-case tracking-normal">
                · {stalled.length} paused, quiet for {STALL_AFTER_DAYS}+ days
              </span>
            </button>
            <button
              onClick={() => void archiveStalled()}
              disabled={sweeping}
              title="Archive every stalled run. They stay under Recent and can be reopened — worktrees are untouched."
              className="text-[11px] px-2 py-0.5 rounded border border-card-strong text-ink-faint hover:text-ink hover:bg-white/5 disabled:opacity-40"
            >
              {sweeping ? 'Archiving…' : 'Archive all'}
            </button>
          </div>
          {showStalled && (
            <div className="space-y-1.5 mb-4">
              {stalled.map((run) => (
                <RunRow key={run.id} run={run} projectLabel={nameForPath.get(flowRunOwnerPath(run))} />
              ))}
            </div>
          )}
        </>
      )}
      {recent.length > 0 && (
        <>
          <button
            onClick={() => setShowRecent((v) => !v)}
            className="flex items-center gap-2 text-[11px] uppercase tracking-wider text-ink-faint hover:text-ink mb-2"
          >
            <span>{showRecent ? '▼' : '▶'}</span>
            <span>Recent</span>
            <span className="text-ink-faint normal-case tracking-normal">
              · {recent.length}
            </span>
          </button>
          {showRecent && (
            <div className="space-y-1.5 mb-4">
              {recent.slice(0, 15).map((run) => (
                <RunRow key={run.id} run={run} projectLabel={nameForPath.get(flowRunOwnerPath(run))} />
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}

function RunRow({ run, projectLabel }: { run: FlowRun; projectLabel?: string }) {
  const setActiveRun = useFlowsStore((s) => s.setActiveRun);
  const removeRun = useFlowsStore((s) => s.removeRun);
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  const stateLabel =
    run.state.kind === 'running'
      ? 'running…'
      : run.state.kind === 'paused'
        ? 'paused'
        : run.state.kind === 'watching'
          ? 'watching'
          : run.state.kind === 'done'
            ? 'done'
            : run.state.kind === 'archived'
              ? 'archived'
              : 'aborted';
  const stateColor =
    run.state.kind === 'running'
      ? 'text-sky-700 dark:text-sky-300'
      : run.state.kind === 'paused'
        ? 'text-amber-700 dark:text-amber-300'
        : run.state.kind === 'watching'
          ? 'text-sky-700 dark:text-sky-300'
          : run.state.kind === 'done'
            ? 'text-emerald-700 dark:text-emerald-300/80'
            : run.state.kind === 'archived'
              ? 'text-ink-muted'
              : 'text-red-700 dark:text-red-300';
  const isActive =
    run.state.kind === 'running' ||
    run.state.kind === 'paused' ||
    run.state.kind === 'watching';
  // Latest attempt end-time → "completed at". Falls back to the run's
  // createdAt for runs with no completed attempts yet.
  const lastEnd = run.attempts
    .map((a) => a.endedAt)
    .filter((n): n is number => typeof n === 'number')
    .sort((a, b) => b - a)[0];
  const completedAt =
    run.state.kind === 'done' || run.state.kind === 'aborted' || run.state.kind === 'archived'
      ? lastEnd ?? run.createdAt
      : null;

  async function handleDelete(e: React.MouseEvent) {
    e.stopPropagation();
    const res = await deleteFlowRunWithDirtyGuard(run.id);
    if (res.error) {
      // Server failed but the optimistic remove already happened — re-add isn't
      // worth the complexity; the next listRuns refresh would restore it. Just
      // surface the error.
      alert(`Couldn't delete: ${res.error}`);
      return;
    }
    if (res.deleted) removeRun(run.id);
  }

  return (
    <div
      className={
        // Shading, not an outline. The previous version was `border` plus
        // `bg-card/40` — and an opacity modifier on a CSS-var colour compiles
        // to nothing (see the palette note in styles.css), so every one of
        // these rows rendered as a bare rectangle with no fill at all. The
        // named blends in `.run-row` do what those classes were meant to.
        'group flex items-center gap-3 rounded-md px-3 py-2 cursor-pointer transition-colors ' +
        (isActive ? 'run-row run-row-active' : 'run-row')
      }
      onClick={() => setActiveRun(run.id)}
    >
      <FlowMonogram name={run.flowSnapshot.name} size="sm" />
      <div className="flex-1 min-w-0 flex items-baseline gap-2">
        <span className="text-sm font-semibold truncate" title={run.userPrompt}>{runTitle(run)}</span>
        {/* A run nobody remembers starting is alarming; say who did. */}
        {run.scheduleName && (
          <span
            className="text-[10px] px-1.5 py-0.5 rounded bg-violet-500/20 text-violet-700 dark:text-violet-300 whitespace-nowrap"
            title={`Launched by the "${run.scheduleName}" schedule`}
          >
            ⏱ {run.scheduleName}
          </span>
        )}
        <span className="text-[11px] text-ink-faint truncate">
          {run.flowSnapshot.name}
          <span className="mx-1">·</span>
          {projectLabel ?? pathBasenameSafe(flowRunOwnerPath(run))}
          {run.worktreePath && <span className="ml-1">· worktree</span>}
        </span>
      </div>
      <span className={'text-[11px] font-medium ' + stateColor + ' flex items-center gap-1.5'}>
        {run.state.kind === 'running' && <RunningDot />}
        {stateLabel}
      </span>
      <span
        className="text-[11px] text-ink-faint w-28 text-right"
        title={new Date(completedAt ?? run.createdAt).toLocaleString()}
      >
        {completedAt
          ? `done ${relativeTime(completedAt)}`
          : `started ${relativeTime(run.createdAt)}`}
      </span>
      {confirmingDelete ? (
        <div className="flex gap-1" onClick={(e) => e.stopPropagation()}>
          <button
            onClick={handleDelete}
            className="text-[11px] px-2 py-0.5 rounded bg-red-500/80 text-white"
          >
            Confirm
          </button>
          <button
            onClick={(e) => {
              e.stopPropagation();
              setConfirmingDelete(false);
            }}
            className="text-[11px] px-2 py-0.5 rounded bg-card"
          >
            Cancel
          </button>
        </div>
      ) : (
        <button
          onClick={(e) => {
            e.stopPropagation();
            setConfirmingDelete(true);
          }}
          className="text-[11px] text-ink-faint hover:text-red-400 opacity-0 group-hover:opacity-100 transition-opacity px-2 py-0.5 rounded hover:bg-card-strong"
          title="Delete this run"
        >
          ✕
        </button>
      )}
    </div>
  );
}

/// Short "5m ago" / "2h ago" / "3d ago" relative timestamp. Beyond a
/// week we fall back to a date string so the user gets a real anchor.
function relativeTime(ts: number): string {
  const diff = Date.now() - ts;
  if (diff < 60_000) return 'just now';
  if (diff < 3_600_000) return `${Math.round(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.round(diff / 3_600_000)}h ago`;
  if (diff < 7 * 86_400_000) return `${Math.round(diff / 86_400_000)}d ago`;
  return new Date(ts).toLocaleDateString();
}

function RunningDot() {
  return (
    <span
      aria-hidden
      className="inline-block w-1.5 h-1.5 rounded-full bg-sky-500 dark:bg-sky-400 animate-pulse mr-1.5 align-middle"
    />
  );
}

function pathBasenameSafe(p: string): string {
  if (!p) return '';
  const segs = p.split(/[\\/]/).filter(Boolean);
  return segs[segs.length - 1] ?? p;
}

/// Drawn rather than typed. "⏱" is an emoji: the platform picks the shape, it
/// renders a size smaller than the label beside it, and on the inactive half of
/// the track it was simply hard to see. A stroked path takes `currentColor`,
/// so it inherits the violet and the bloom.
function ClockGlyph() {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <circle cx="8" cy="8" r="6.1" stroke="currentColor" strokeWidth="1.5" />
      <path
        d="M8 4.6 V8.2 L10.3 9.7"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function SegmentTab({
  label,
  active,
  onClick,
  glyph,
  discover,
  badge,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
  /// Small mark before the label. "Library" and "Schedules" as two bare words
  /// on one track read as the same kind of thing seen twice; a clock says one
  /// of them is about time before you've read it.
  glyph?: ReactNode;
  /// Draw the one-time discovery glow. Retires the moment the user opens it.
  discover?: boolean;
  /// Live count. Earned attention, so unlike the glow it stays for as long as
  /// it's true. `waiting` outranks `running` at the call site: one is blocked
  /// on the user, the other is just working.
  badge?: { count: number; tone: 'waiting' | 'running' };
}) {
  return (
    <button
      onClick={onClick}
      className={
        'relative px-3.5 py-1.5 rounded-md text-xs font-medium flex items-center gap-2 transition-colors ' +
        // The inactive half is `ink-muted`, not `ink-faint`: faint is the tone
        // this codebase uses for disabled and for metadata, and a tab you can
        // click shouldn't wear it.
        // `surface-elevated`, not `card-strong`: card-strong is 4% white in
        // dark and the track behind it is 2%, so the pill would barely lift
        // off it. A segmented control only works if the track reads recessed
        // and the selection reads raised.
        (active
          ? 'bg-surface-elevated text-ink shadow-sm'
          : 'text-ink-muted hover:text-ink hover:bg-white/5') +
        (discover ? ' nav-segment-discover text-ink' : '')
      }
    >
      {/* Violet, not a dimmed grey. This app already speaks violet for
          everything a schedule touches — the badge on a scheduled run, a
          parked proposal, the origin banner on its batch — so the tab wearing
          it is the same word, not decoration. It also gives the inactive half
          of the track something other than muted text, which was the whole
          reason "Schedules" read as unclickable. */}
      {glyph && (
        <span
          aria-hidden
          className="flex-none text-violet-600 dark:text-violet-400 glyph-bloom"
        >
          {glyph}
        </span>
      )}
      {label}
      {badge ? (
        badge.tone === 'waiting' ? (
          <span className="flex items-center gap-1 text-[10px] text-violet-700 dark:text-violet-300">
            <span aria-hidden className="w-1.5 h-1.5 rounded-full bg-violet-500 dark:bg-violet-400" />
            {badge.count}
          </span>
        ) : (
          <span className="flex items-center gap-1 text-[10px] text-sky-700 dark:text-sky-300">
            <RunningDot />
            {badge.count}
          </span>
        )
      ) : (
        discover && (
          <span className="text-[9px] uppercase tracking-wider px-1.5 py-0.5 rounded bg-accent text-white leading-none">
            new
          </span>
        )
      )}
    </button>
  );
}

/// The library list proper: a filter box, tag chips, then flows grouped by
/// where they came from. Flat-and-alphabetical worked at five flows; past
/// twenty (most of them installed from a registry) the ones you wrote
/// yourself become the hardest to find, which is exactly backwards.
function FlowLibraryList({
  flows,
  projectPaths,
  onBrowse,
  onOverviewOpenChange,
}: {
  flows: Flow[];
  projectPaths: string[];
  onBrowse: (query: string) => void;
  onOverviewOpenChange: (open: boolean) => void;
}) {
  const starredFlows = useStore((s) => s.settings.starredFlows ?? []);
  const installedFlows = useStore((s) => s.settings.installedRegistryFlows);
  const registryEntries = useFlowsStore((s) => s.registryEntries);
  const registryLoaded = useFlowsStore((s) => s.registryLoaded);
  const browseRegistries = useFlowsStore((s) => s.browseRegistries);
  const installFromRegistry = useFlowsStore((s) => s.installFromRegistry);
  const reload = useFlowsStore((s) => s.reload);
  const [query, setQuery] = useState('');
  const [tags, setTags] = useState<Set<string>>(new Set());
  const [installingKey, setInstallingKey] = useState<string | null>(null);
  const [installError, setInstallError] = useState<string | null>(null);
  const [drafting, setDrafting] = useState(false);
  const openEditor = useFlowsStore((s) => s.openEditor);

  const [scope, setScope] = useState<FlowScope>('all');
  const [sort, setSort] = useState<FlowSort>('usage');
  const [selectedId, setSelectedId] = useState<string | null>(null);

  // All-time run tallies, so most-used flows float and dusty ones sink.
  const [runCounts, setRunCounts] = useState<Record<string, { count: number; lastAt: number }>>(
    {},
  );
  useEffect(() => {
    void window.overcli.invoke('flows:runCounts').then(setRunCounts);
  }, []);

  const tagCounts = useMemo(() => flowTagCounts(flows), [flows]);
  const scopeOpts = { starred: starredFlows, installed: installedFlows, query, tags };
  const counts = useMemo(
    () => scopeCounts(flows, scopeOpts),
    [flows, starredFlows, installedFlows, query, tags],
  );
  const rows = useMemo(
    () => sortFlows(filterFlows(flows, { ...scopeOpts, scope }), sort, runCounts),
    [flows, starredFlows, installedFlows, query, tags, scope, sort, runCounts],
  );
  const matchCount = rows.length;
  // Keyed on `flowStarKey` (source:id), not the bare id — a user flow and a
  // project flow can share an id, and selecting one shouldn't also select
  // (or edit) the other.
  const selected = rows.find((f) => flowStarKey(f) === selectedId) ?? null;
  // Tell the page header the drawer is up. Cleared on unmount too, or
  // switching to Runs/Schedules would leave the header indented.
  const overviewOpen = !!selected;
  useEffect(() => {
    onOverviewOpenChange(overviewOpen);
    return () => onOverviewOpenChange(false);
  }, [overviewOpen, onOverviewOpenChange]);
  const filtering = query.trim().length > 0 || tags.size > 0;
  const searching = query.trim().length > 0;

  // Fetch the registry index lazily on first search — same policy as the
  // welcome gallery, so neither view pays for a network call nobody asked
  // for and both read from the store's cached copy afterwards.
  useEffect(() => {
    if (query.trim().length >= 2 && !registryLoaded) void browseRegistries(false);
  }, [query, registryLoaded]);

  const registryMatches = useMemo(() => {
    if (!searching) return [];
    const have = installedRegistryKeys(flows, installedFlows);
    return registryEntries
      .filter((e) => !have.has(`${e.registryId}:${e.id}`))
      .filter((e) => registryEntryMatchesQuery(e, query))
      .slice(0, 8);
  }, [searching, registryEntries, flows, installedFlows, query]);

  /// Same third rail as the welcome gallery: search text becomes the
  /// drafter's brief, and the draft opens in the editor for review rather
  /// than running unseen.
  async function draft() {
    const description = query.trim();
    if (!description || drafting) return;
    setDrafting(true);
    setInstallError(null);
    try {
      const result = await window.overcli.invoke('flows:draftFromPrompt', { description });
      if (!result.ok) setInstallError(result.error);
      else openEditor({ kind: 'new' }, result.flow);
    } finally {
      setDrafting(false);
    }
  }

  async function install(entry: { registryId: string; id: string; version: string }) {
    const key = `${entry.registryId}:${entry.id}`;
    setInstallingKey(key);
    setInstallError(null);
    try {
      const res = await installFromRegistry(entry);
      if (!res.ok) setInstallError(res.error || 'Install failed.');
      else await reload(projectPaths);
    } finally {
      setInstallingKey(null);
    }
  }

  // Most-used tags first, capped — the chip row is a shortcut, not a
  // complete index of every label anyone ever typed.
  const chips = useMemo(
    () => [...tagCounts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 12),
    [tagCounts],
  );

  return (
    // Reserve the drawer's width on the right while it's open — the drawer
    // itself is `fixed`, so without this the row action column (Run / ⋯)
    // and the registry results sit underneath it and become unreachable.
    <div className={selected ? 'pr-[440px]' : undefined}>
      <div className="flex items-center gap-2 mb-2">
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search your flows and the registry…"
          className="field flex-1 text-sm px-3 py-1.5"
        />
        <select
          value={sort}
          onChange={(e) => setSort(e.target.value as FlowSort)}
          aria-label="Sort flows"
          className="field text-xs px-2 py-1.5"
        >
          {SORTS.map((s) => (
            <option key={s.key} value={s.key}>{s.label}</option>
          ))}
        </select>
        {filtering && (
          <button
            onClick={() => { setQuery(''); setTags(new Set()); }}
            className="text-xs text-ink-faint hover:text-ink px-2 py-1"
          >
            Clear
          </button>
        )}
      </div>
      <div className="flex flex-wrap items-center gap-1 mb-3">
        {SCOPES.filter((s) => counts[s.key] > 0 || s.key === scope || s.key === 'all').map((s) => (
          <button
            key={s.key}
            onClick={() => { setScope(s.key); setSelectedId(null); }}
            className={
              'text-[11px] px-2.5 py-1 rounded-md border transition-colors ' +
              (scope === s.key
                ? 'border-accent/60 bg-accent/15 text-accent'
                : 'border-transparent text-ink-faint hover:text-ink hover:border-card')
            }
          >
            {s.label} <span className="opacity-60 tabular-nums">{counts[s.key]}</span>
          </button>
        ))}
      </div>
      {scope === 'generated' && (
        <div className="text-[11px] text-ink-faint/60 mb-3">
          Drafted by a worker to answer an errand — edit one to adopt it as your own.
        </div>
      )}

      {chips.length > 0 && (
        <div className="flex flex-wrap gap-1.5 mb-4">
          {chips.map(([tag, count]) => (
            <button
              key={tag}
              onClick={() => setTags((prev) => {
                const n = new Set(prev);
                if (n.has(tag)) n.delete(tag); else n.add(tag);
                return n;
              })}
              className={
                'text-[11px] px-2 py-0.5 rounded-full border transition-colors ' +
                (tags.has(tag)
                  ? 'border-accent/60 bg-accent/20 text-accent'
                  : 'border-card text-ink-faint hover:text-ink hover:border-card-strong')
              }
            >
              {tag} <span className="opacity-60">{count}</span>
            </button>
          ))}
        </div>
      )}

      {matchCount === 0 ? (
        <div className="text-sm text-ink-muted py-6 text-center">
          Nothing here. Try another scope or clear the search.
        </div>
      ) : (
        <div className="border-t border-card mb-6">
          {rows.map((flow) => (
            <FlowTableRow
              key={`${flow.source}:${flow.id}`}
              flow={flow}
              projectPaths={projectPaths}
              usage={runCounts[flow.id]}
              selected={selectedId === flowStarKey(flow)}
              onSelect={() => setSelectedId(flowStarKey(flow))}
            />
          ))}
        </div>
      )}
      {selected && (
        <FlowOverviewPanel
          flow={selected}
          usage={runCounts[selected.id]}
          onClose={() => setSelectedId(null)}
          onEdit={() => openEditor({ kind: 'editing', flowId: selected.id })}
          onTagClick={(tag) => setTags((prev) => {
            const n = new Set(prev);
            if (n.has(tag)) n.delete(tag); else n.add(tag);
            return n;
          })}
        />
      )}

      {/* Registry results for the same query, inline. Only while searching:
          unfiltered, this would be a second full library competing with
          the user's own. */}
      {searching && (
        <div className="mb-6">
          <div className="flex items-center gap-2 mb-2">
            <span className="text-[11px] uppercase tracking-wider text-ink-faint">
              From the registry
            </span>
            {registryMatches.length > 0 && (
              <span className="text-[11px] text-ink-faint">· {registryMatches.length}</span>
            )}
            <span className="text-[11px] text-ink-faint/60">not installed yet</span>
          </div>
          {!registryLoaded ? (
            <div className="text-xs text-ink-faint py-2">Searching the registry…</div>
          ) : registryMatches.length === 0 ? (
            <div className="text-xs text-ink-faint py-2">
              Nothing new in the registry for that.
              {matchCount === 0 && (
                <button
                  onClick={() => void draft()}
                  disabled={drafting}
                  className="ml-2 text-accent hover:underline disabled:opacity-60"
                >
                  {drafting ? 'Drafting…' : `Build one for “${query.trim()}” with AI →`}
                </button>
              )}
            </div>
          ) : (
            <div className="space-y-2">
              {registryMatches.map((entry) => (
                <div
                  key={`${entry.registryId}:${entry.id}`}
                  className="flex items-center gap-3 rounded-lg border border-dashed border-card-strong px-3 py-2.5"
                >
                  <div className="min-w-0 flex-1">
                    <div className="text-sm font-semibold truncate">{entry.name}</div>
                    {entry.description && (
                      <div className="text-xs text-ink-faint line-clamp-1 mt-0.5">
                        {entry.description}
                      </div>
                    )}
                  </div>
                  <span className="text-[10px] text-ink-faint flex-shrink-0">
                    {entry.registryId} · {entry.version}
                  </span>
                  <button
                    onClick={() => void install(entry)}
                    disabled={installingKey === `${entry.registryId}:${entry.id}`}
                    className="text-xs px-2.5 py-1 rounded-md border border-card-strong hover:bg-white/5 disabled:opacity-50 flex-shrink-0"
                  >
                    {installingKey === `${entry.registryId}:${entry.id}` ? 'Installing…' : 'Install'}
                  </button>
                </div>
              ))}
            </div>
          )}
          {installError && <div className="mt-2 text-xs text-red-400">{installError}</div>}
        </div>
      )}

      {/* Always reachable from the bottom of the list — the modal is where
          you browse by tag axis rather than by a term you already have. */}
      <button
        onClick={() => onBrowse(query)}
        className="w-full rounded-lg border border-dashed border-card-strong px-3 py-2.5 text-left hover:bg-white/5 transition-colors"
      >
        <div className="text-[13px] text-ink">Browse the full flow registry →</div>
        <div className="text-[11px] text-ink-faint mt-0.5">
          Filter published flows by activity, surface, or domain.
        </div>
      </button>
    </div>
  );
}

function SectionHeading({
  title,
  count,
  accent,
  waiting,
}: {
  title: string;
  count?: number;
  accent?: boolean;
  /// Violet — the app-wide tone for "blocked on the user".
  waiting?: boolean;
}) {
  return (
    <div className="flex items-center gap-2 mb-2">
      <span
        className={
          'text-[11px] uppercase tracking-wider ' +
          (accent
            ? 'text-accent'
            : waiting
              ? 'text-violet-600 dark:text-violet-400'
              : 'text-ink-faint')
        }
      >
        {title}
      </span>
      {typeof count === 'number' && (
        <span className="text-[11px] text-ink-faint">· {count}</span>
      )}
    </div>
  );
}

function EmptyState({ onCreate }: { onCreate: () => void }) {
  // No flows yet → use the empty-state card as the "About flows" page
  // itself. The About modal in the header has the exact same content,
  // but a first-time user shouldn't have to know to click it.
  return (
    <div className="rounded-xl border border-card bg-card/30 p-6 shadow-sm">
      <div className="flex items-baseline gap-3 mb-5">
        <div className="text-lg font-semibold">Flows orchestrate multiple models</div>
        <div className="text-xs text-ink-faint">— here's what you get</div>
      </div>
      <FlowsAboutContent compact />
      <div className="mt-6 pt-4 border-t border-card flex items-center gap-3">
        <button
          onClick={onCreate}
          className="text-xs px-4 py-2 rounded-md bg-accent text-white hover:opacity-90 font-medium"
        >
          + Create your first flow
        </button>
        <span className="text-[11px] text-ink-faint">
          Start from a template or describe one — Claude can draft it.
        </span>
      </div>
    </div>
  );
}

function FlowTableRow({
  flow,
  projectPaths,
  usage,
  selected,
  onSelect,
}: {
  flow: Flow;
  projectPaths: string[];
  usage?: { count: number; lastAt: number };
  selected: boolean;
  onSelect: () => void;
}) {
  const openEditor = useFlowsStore((s) => s.openEditor);
  const reload = useFlowsStore((s) => s.reload);
  const renameFlow = useFlowsStore((s) => s.renameFlow);
  const [running, setRunning] = useState(false);
  // Non-null while the row's title is an editable input. Renaming happens
  // in place so the common "I picked a bad name" fix doesn't require a
  // trip through the full editor.
  const [renameValue, setRenameValue] = useState<string | null>(null);
  // Was the rename input open when the current click started? Clicking the
  // card to dismiss the input blurs it (which commits and closes it) before
  // the click lands, so by the time onClick runs `renameValue` is already
  // null and the card would open the editor. Sampling at mousedown records
  // the state the user actually clicked in.
  const renamingAtMouseDown = useRef(false);
  const starred = useStore(
    (s) => (s.settings.starredFlows ?? []).includes(flowStarKey(flow)),
  );
  const toggleFlowStar = useStore((s) => s.toggleFlowStar);

  // Picking "Run" swaps the row's contents for the shared run panel
  // (Composer + target/worktree controls) in place — no cramped popover,
  // no vertical jump. Mirrors the start page's flow launcher.
  if (running) {
    return <FlowRunLauncher flow={flow} onClose={() => setRunning(false)} />;
  }

  async function handleDelete() {
    const result = await window.overcli.invoke('flows:delete', {
      flowId: flow.id,
      source: flow.source,
      projectPath: flowProjectPath(flow),
    });
    if (result.ok) {
      await reload(projectPaths);
    } else {
      alert(result.error);
    }
  }

  /// Shelve/unshelve. Persisted in the flow's own YAML (an `archived: true`
  /// key), so it survives restarts and syncs with the file like every other
  /// property.
  async function handleArchiveToggle() {
    const result = await window.overcli.invoke('flows:save', {
      flow: { ...flow, archived: !flow.archived ? true : undefined },
      target: flow.source,
      projectPath: flowProjectPath(flow) ?? undefined,
    });
    if (result.ok) {
      await reload(projectPaths);
    } else {
      alert(result.error);
    }
  }

  async function commitRename() {
    const next = renameValue ?? '';
    setRenameValue(null);
    const result = await renameFlow(flow, next, projectPaths);
    if (!result.ok && result.error) alert(result.error);
  }

  return (
    <div
      role="button"
      tabIndex={0}
      onMouseDownCapture={() => {
        renamingAtMouseDown.current = renameValue !== null;
      }}
      onClick={() => {
        // Mid-rename the row is a form, not a link — clicking around the
        // input shouldn't yank the user into the overview.
        if (renameValue === null && !renamingAtMouseDown.current) {
          onSelect();
        }
      }}
      onKeyDown={(e) => {
        // Only the row itself opens the overview on Enter/Space — a keypress
        // while an inner button (Run / ⋯) is focused must not also select.
        if (e.target !== e.currentTarget) return;
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onSelect();
        }
      }}
      title="Click to see the overview"
      className={
        'group grid grid-cols-[auto_minmax(0,1.6fr)_minmax(0,2fr)_auto_auto] items-center gap-3 px-3 py-2 border-b border-card cursor-pointer transition-colors ' +
        (selected ? 'bg-accent/[0.10]' : 'hover:bg-white/[0.04]')
      }
    >
      <button
        onClick={(e) => {
          e.stopPropagation();
          void toggleFlowStar({ source: flow.source, id: flow.id });
        }}
        className={
          'text-sm leading-none px-1 ' +
          (starred ? 'text-amber-400' : 'text-ink-faint hover:text-amber-400')
        }
        title={starred ? 'Unstar' : 'Star to pin to the welcome pane'}
        aria-label={starred ? 'Unstar flow' : 'Star flow'}
      >
        {starred ? '★' : '☆'}
      </button>
      {renameValue !== null ? (
        <input
          autoFocus
          value={renameValue}
          onChange={(e) => setRenameValue(e.target.value)}
          onClick={(e) => e.stopPropagation()}
          onBlur={() => void commitRename()}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === 'Enter') {
              e.preventDefault();
              void commitRename();
            } else if (e.key === 'Escape') {
              e.preventDefault();
              setRenameValue(null);
            }
          }}
          aria-label="Flow name"
          className="flex-1 min-w-0 bg-transparent border border-accent rounded px-1.5 py-0.5 text-sm font-semibold outline-none"
        />
      ) : (
        <div className="flex items-center gap-1.5 min-w-0">
          <span className="text-sm font-medium truncate">{flow.name}</span>
          <SourceBadge source={flow.source} />
          <WorkerUsageBadge flowId={flow.id} />
        </div>
      )}
      <div className="flex items-center gap-1 min-w-0 overflow-hidden">
        {flow.steps.slice(0, 5).flatMap((step, i) => [
          i > 0 && (
            <span key={`sep-${step.id}`} className="text-[10px] text-ink-faint/50">
              ▸
            </span>
          ),
          <span
            key={step.id}
            title={compactStepModel(flow, step)}
            className="text-[11px] text-ink-faint whitespace-nowrap"
          >
            {step.id}
          </span>,
        ])}
        {flow.steps.length > 5 && (
          <span className="text-[11px] text-ink-faint">+{flow.steps.length - 5}</span>
        )}
      </div>
      <span className="text-[11px] text-ink-faint tabular-nums whitespace-nowrap">
        {usage?.count ? `${usage.count}×` : '—'}
      </span>
      <div className="flex items-center gap-1.5" onClick={(e) => e.stopPropagation()}>
        <button
          onClick={() => setRunning(true)}
          className="text-[11px] px-2 py-0.5 rounded-md bg-accent text-white hover:opacity-90"
        >
          Run
        </button>
        <RowActionsMenu
          onEdit={() => openEditor({ kind: 'editing', flowId: flow.id })}
          onRename={() => setRenameValue(flow.name)}
          archived={!!flow.archived}
          onArchive={handleArchiveToggle}
          onDelete={handleDelete}
        />
      </div>
    </div>
  );
}

/// Overflow menu for a flow row — holds the secondary Edit/Rename/Delete
/// actions so they don't each claim a permanent button. Delete confirms
/// inline inside the menu rather than firing a modal.
function RowActionsMenu({
  onEdit,
  onRename,
  archived,
  onArchive,
  onDelete,
}: {
  onEdit: () => void;
  onRename: () => void;
  archived?: boolean;
  onArchive?: () => void | Promise<void>;
  onDelete: () => void | Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) {
        setOpen(false);
        setConfirming(false);
      }
    };
    window.addEventListener('mousedown', handler);
    return () => window.removeEventListener('mousedown', handler);
  }, [open]);

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen((o) => !o)}
        className="text-xs px-2.5 py-1 rounded-md bg-card hover:bg-card-strong text-ink-muted leading-none"
        title="More actions"
        aria-label="More actions"
      >
        ⋯
      </button>
      {open && (
        <div className="absolute right-0 mt-1 z-10 min-w-[130px] bg-surface border border-card-strong rounded-md shadow-lg py-1">
          <button
            onClick={() => {
              setOpen(false);
              onEdit();
            }}
            className="w-full text-left text-xs px-3 py-1.5 text-ink-muted hover:bg-card-strong hover:text-ink"
          >
            Edit
          </button>
          <button
            onClick={() => {
              setOpen(false);
              onRename();
            }}
            className="w-full text-left text-xs px-3 py-1.5 text-ink-muted hover:bg-card-strong hover:text-ink"
          >
            Rename
          </button>
          {onArchive && (
            <button
              onClick={() => {
                setOpen(false);
                void onArchive();
              }}
              title={
                archived
                  ? 'Bring it back into the library and the pickers'
                  : 'Shelve it: hidden from the library and every launch picker, file kept'
              }
              className="w-full text-left text-xs px-3 py-1.5 text-ink-muted hover:bg-card-strong hover:text-ink"
            >
              {archived ? 'Unarchive' : 'Archive'}
            </button>
          )}
          {!confirming ? (
            <button
              onClick={() => setConfirming(true)}
              className="w-full text-left text-xs px-3 py-1.5 text-ink-muted hover:bg-card-strong hover:text-red-400"
            >
              Delete
            </button>
          ) : (
            <div className="flex items-center gap-1 px-3 py-1.5">
              <button
                onClick={() => {
                  void onDelete();
                  setOpen(false);
                  setConfirming(false);
                }}
                className="text-[11px] px-2 py-0.5 rounded bg-red-500/80 text-white"
              >
                Delete
              </button>
              <button
                onClick={() => setConfirming(false)}
                className="text-[11px] px-2 py-0.5 rounded bg-card"
              >
                Cancel
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/// Marks a flow that's on a worker's contract. The link matters here for two
/// reasons: it explains why Delete will refuse (main guards referenced flows),
/// and it says who is quietly running this flow while nobody watches.
function WorkerUsageBadge({ flowId }: { flowId: string }) {
  const workers = useWorkersStore((s) => s.workers);
  const names = Object.values(workers)
    .filter((w) => w.flowIds.includes(flowId))
    .map((w) => w.name);
  if (names.length === 0) return null;
  return (
    <span
      title={`On ${names.join(', ')}'${names.length === 1 && !names[0].endsWith('s') ? 's' : ''} contract — the flow can't be deleted while a worker runs it.`}
      className="text-[10px] px-1.5 py-0.5 rounded uppercase tracking-wider bg-violet-500/20 text-violet-700 dark:text-violet-300 whitespace-nowrap"
    >
      worker · {names.length === 1 ? names[0] : `${names[0]} +${names.length - 1}`}
    </span>
  );
}

function SourceBadge({ source }: { source: Flow['source'] }) {
  const cls =
    source === 'project'
      ? 'bg-emerald-500/20 text-emerald-700 dark:text-emerald-300'
      : source === 'generated'
        ? 'bg-violet-500/20 text-violet-700 dark:text-violet-300'
        : 'bg-sky-500/20 text-sky-700 dark:text-sky-300';
  return (
    <span className={`text-[10px] px-1.5 py-0.5 rounded uppercase tracking-wider ${cls}`}>
      {source}
    </span>
  );
}
