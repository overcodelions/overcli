// The Schedules segment of the Flows tab: the list of armed triggers, and the
// editor for one of them.
//
// It lives under Flows rather than as its own top-level tab because a schedule
// isn't a mode of work — it's a trigger on work the user already defined. A
// fourth tab would have meant a third place to launch a flow from, and the
// user would have had to learn which launcher owned which run.

import { useEffect, useMemo, useState } from 'react';

import { useStore } from '../../store';
import { useFlowsStore } from '../../flowsStore';
import {
  draftFromSchedule,
  newScheduleDraft,
  useSchedulesStore,
  type ScheduleDraft,
} from '../../schedulesStore';
import {
  WEEKDAY_SET,
  describeTrigger,
  untilLabel,
  validateSchedule,
  type Schedule,
  type ScheduleRunRecord,
} from '@shared/flows/schedule';
import { BaseBranchSelect } from '../sheets/BaseBranchSelect';
import { useOrchestratorStore } from '../../orchestratorStore';
import { isOrchestrationAwaitingApproval } from '@shared/flows/orchestration';
import type { Orchestration } from '@shared/flows/orchestration';

export function SchedulesPane() {
  const projects = useStore((s) => s.projects);
  const workspaces = useStore((s) => s.workspaces);
  const loaded = useSchedulesStore((s) => s.loaded);
  const schedules = useSchedulesStore((s) => s.schedules);
  const draft = useSchedulesStore((s) => s.draft);
  const error = useSchedulesStore((s) => s.error);
  const reload = useSchedulesStore((s) => s.reload);
  const openEditor = useSchedulesStore((s) => s.openEditor);
  const clearError = useSchedulesStore((s) => s.clearError);

  useEffect(() => {
    void reload();
  }, []);

  const rows = useMemo(
    () => Object.values(schedules).sort((a, b) => b.createdAt - a.createdAt),
    [schedules],
  );

  const nameForPath = useMemo(() => {
    const m = new Map<string, string>();
    for (const p of projects) m.set(p.path, p.name);
    for (const w of workspaces) m.set(w.rootPath, w.name);
    return m;
  }, [projects, workspaces]);

  const canCreate = projects.length > 0 || workspaces.length > 0;

  if (draft) return <ScheduleEditor />;

  return (
    <div>
      <div className="flex items-center gap-3 mb-4">
        <div className="text-xs text-ink-faint">
          Runs a flow, or asks the orchestrator for a batch to approve, on a timer.
        </div>
        <button
          disabled={!canCreate}
          onClick={() =>
            openEditor(newScheduleDraft(projects[0]?.path ?? workspaces[0]?.rootPath ?? ''))
          }
          className="ml-auto text-xs px-3 py-1.5 rounded-md bg-accent text-white hover:opacity-90 disabled:opacity-40"
        >
          + New schedule
        </button>
      </div>

      {error && (
        <div
          onClick={clearError}
          className="mb-4 text-sm text-red-700 dark:text-red-300 bg-red-500/15 border border-red-400/40 rounded px-3 py-2 cursor-pointer"
        >
          {error}
        </div>
      )}

      {!loaded ? (
        <div className="text-sm text-ink-muted">Loading schedules…</div>
      ) : rows.length === 0 ? (
        <SchedulesEmptyState />
      ) : (
        <div className="space-y-2">
          {rows.map((s) => (
            <ScheduleRow key={s.id} schedule={s} projectLabel={nameForPath.get(s.projectPath)} />
          ))}
        </div>
      )}

      <ClosedAppNote count={rows.filter((s) => s.enabled).length} />
    </div>
  );
}

function SchedulesEmptyState() {
  return (
    <div className="border border-card-strong rounded-lg p-5 text-sm text-ink-muted space-y-3">
      <div className="text-ink font-medium">Nothing scheduled</div>
      <p>
        A schedule fires work you&apos;ve already set up. Two shapes:
      </p>
      <ul className="space-y-1.5 text-[13px]">
        <li>
          <span className="text-ink">Run a flow</span> — launches one run with a fixed prompt.
          Isolate it in a worktree and read the diff when you get in.
        </li>
        <li>
          <span className="text-ink">Propose a batch</span> — runs the orchestrator&apos;s
          producer against your sources and parks what it finds. Nothing launches until you
          approve it, so a bad morning costs you a read, not a dozen worktrees.
        </li>
      </ul>
    </div>
  );
}

/// Schedules only fire while overcli is running. Saying so once, quietly, at
/// the bottom of the list beats letting someone discover it by wondering why
/// their 9am run never happened.
function ClosedAppNote({ count }: { count: number }) {
  if (count === 0) return null;
  return (
    <div className="mt-6 text-[11px] text-ink-faint">
      Schedules fire while overcli is open. Anything missed while it was closed follows each
      schedule&apos;s catch-up setting.
    </div>
  );
}

function ScheduleRow({
  schedule,
  projectLabel,
}: {
  schedule: Schedule;
  projectLabel?: string;
}) {
  const nextFireAt = useSchedulesStore((s) => s.nextFireAt[schedule.id]);
  const busy = useSchedulesStore((s) => s.busy);
  const setEnabled = useSchedulesStore((s) => s.setEnabled);
  const remove = useSchedulesStore((s) => s.remove);
  const runNow = useSchedulesStore((s) => s.runNow);
  const openEditor = useSchedulesStore((s) => s.openEditor);
  const setActiveRun = useFlowsStore((s) => s.setActiveRun);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [showHistory, setShowHistory] = useState(false);

  const running = !!schedule.activeRunId;
  const last = schedule.history[0];
  // Batches this schedule proposed that nobody has approved yet. A parked
  // proposal is the one outcome a schedule produces that's blocked on a human,
  // so it has to be visible from the surface the user came to — making them
  // remember to check Orchestrator would waste the overnight work.
  const orchestrations = useOrchestratorStore((s) => s.orchestrations);
  const awaiting = useMemo(
    () =>
      Object.values(orchestrations).filter(
        (o) => o.origin?.scheduleId === schedule.id && isOrchestrationAwaitingApproval(o),
      ),
    [orchestrations, schedule.id],
  );

  return (
    <div
      className={
        'rounded-lg px-3 py-2.5 border ' +
        (awaiting.length > 0 ? 'border-violet-400/50 bg-violet-500/5' : 'border-card-strong')
      }
    >
      <div className="flex items-center gap-2.5">
        <button
          onClick={() => void setEnabled(schedule.id, !schedule.enabled)}
          title={schedule.enabled ? 'Disable' : 'Enable'}
          className={
            'shrink-0 w-8 h-[18px] rounded-full transition-colors relative ' +
            (schedule.enabled ? 'bg-accent' : 'bg-white/15')
          }
        >
          <span
            className={
              'absolute top-[2px] w-[14px] h-[14px] rounded-full bg-white transition-all ' +
              (schedule.enabled ? 'left-[16px]' : 'left-[2px]')
            }
          />
        </button>

        <button
          onClick={() => openEditor(draftFromSchedule(schedule))}
          className="flex-1 min-w-0 text-left"
        >
          <div className="flex items-center gap-2">
            {running && (
              <span
                aria-hidden
                className="inline-block w-1.5 h-1.5 rounded-full bg-sky-500 dark:bg-sky-400 animate-pulse"
              />
            )}
            <span
              className={
                'text-sm truncate ' + (schedule.enabled ? 'text-ink' : 'text-ink-faint')
              }
            >
              {schedule.name}
            </span>
            {schedule.target.kind === 'orchestrate' && (
              <span className="text-[10px] px-1.5 py-0.5 rounded uppercase tracking-wider bg-violet-500/20 text-violet-700 dark:text-violet-300">
                proposes
              </span>
            )}
          </div>
          <div className="text-[11px] text-ink-faint truncate">
            {describeTrigger(schedule.trigger)}
            {' · '}
            {schedule.target.flowId || 'no flow'}
            {projectLabel ? ` · ${projectLabel}` : ''}
          </div>
        </button>

        <div className="shrink-0 text-[11px] text-ink-faint text-right w-[112px]">
          {running ? (
            <button
              onClick={() => schedule.activeRunId && setActiveRun(schedule.activeRunId)}
              className="hover:text-ink"
            >
              running now →
            </button>
          ) : schedule.enabled && nextFireAt ? (
            <span title={new Date(nextFireAt).toLocaleString()}>{untilLabel(nextFireAt)}</span>
          ) : (
            <span>paused</span>
          )}
        </div>

        {confirmingDelete ? (
          <div className="flex gap-1 shrink-0">
            <button
              onClick={() => void remove(schedule.id)}
              className="text-[11px] px-2 py-0.5 rounded bg-red-500/80 text-white"
            >
              Confirm
            </button>
            <button
              onClick={() => setConfirmingDelete(false)}
              className="text-[11px] px-2 py-0.5 rounded border border-card-strong"
            >
              Cancel
            </button>
          </div>
        ) : (
          <div className="flex gap-1 shrink-0">
            <button
              disabled={busy || running}
              onClick={() => void runNow(schedule.id)}
              title={running ? 'A run from this schedule is still going' : 'Fire once, now'}
              className="text-[11px] px-2 py-0.5 rounded border border-card-strong hover:bg-white/5 disabled:opacity-40"
            >
              Run now
            </button>
            <button
              onClick={() => setConfirmingDelete(true)}
              className="text-[11px] px-2 py-0.5 rounded text-ink-faint hover:text-red-400"
            >
              Delete
            </button>
          </div>
        )}
      </div>

      {awaiting.map((o) => (
        <PendingProposal key={o.id} orchestration={o} />
      ))}

      {last && (
        <button
          onClick={() => setShowHistory((v) => !v)}
          className="mt-1.5 flex items-center gap-1.5 text-[11px] text-ink-faint hover:text-ink"
        >
          <span>{showHistory ? '▼' : '▶'}</span>
          <HistoryLine record={last} />
        </button>
      )}
      {showHistory && (
        <div className="mt-1.5 pl-4 space-y-1">
          {schedule.history.map((h, i) => (
            <div key={`${h.at}-${i}`} className="text-[11px] text-ink-faint">
              <HistoryLine record={h} />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/// A batch this schedule proposed overnight, shown inline on its row.
///
/// The asks themselves are listed rather than just counted: "5 proposed" tells
/// you there's a decision to make but nothing about whether it's a good one,
/// and the whole promise of a scheduled proposal is that you can judge it in a
/// glance. Per-item approval still lives in Orchestrator — that UI already
/// exists and a second copy would drift — so the deep-link is the way in when
/// the list isn't unanimous.
function PendingProposal({ orchestration }: { orchestration: Orchestration }) {
  const setDetailMode = useStore((s) => s.setDetailMode);
  const setActiveOrchestration = useOrchestratorStore((s) => s.setActiveOrchestration);
  const [busy, setBusy] = useState(false);
  const [expanded, setExpanded] = useState(false);

  const proposed = orchestration.items.filter((i) => i.status === 'proposed');
  const SHOWN = 3;
  const visible = expanded ? proposed : proposed.slice(0, SHOWN);
  const hidden = proposed.length - visible.length;

  function review(): void {
    setActiveOrchestration(orchestration.id);
    setDetailMode('orchestrator');
  }

  async function launchAll(): Promise<void> {
    if (busy) return;
    setBusy(true);
    try {
      await window.overcli.invoke('orchestrator:approveBatch', { id: orchestration.id });
      review();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mt-2.5 rounded-md border border-violet-400/40 bg-violet-500/10 px-3 py-2">
      <div className="flex items-center gap-2">
        <span className="text-[11px] uppercase tracking-wider text-violet-700 dark:text-violet-300">
          Waiting for you
        </span>
        <span className="text-[11px] text-ink-muted">
          {proposed.length} {proposed.length === 1 ? 'ask' : 'asks'} proposed
          {orchestration.createdAt ? ` · ${relativeTime(orchestration.createdAt)}` : ''}
        </span>
      </div>

      <ul className="mt-1.5 space-y-0.5">
        {visible.map((item) => (
          <li
            key={item.candidate.id}
            className="text-[12px] text-ink truncate"
            title={item.candidate.prompt}
          >
            <span className="text-ink-faint mr-1.5">·</span>
            {item.candidate.title}
          </li>
        ))}
      </ul>
      {hidden > 0 && (
        <button
          onClick={() => setExpanded(true)}
          className="mt-0.5 text-[11px] text-ink-faint hover:text-ink"
        >
          and {hidden} more…
        </button>
      )}

      <div className="mt-2 flex items-center gap-2">
        <button
          onClick={review}
          className="text-[11px] px-2.5 py-1 rounded-md bg-accent text-white hover:opacity-90"
        >
          Review &amp; pick →
        </button>
        <button
          onClick={() => void launchAll()}
          disabled={busy}
          className="text-[11px] px-2.5 py-1 rounded-md border border-card-strong hover:bg-white/5 disabled:opacity-40"
        >
          {busy ? 'Launching…' : `Launch all ${proposed.length}`}
        </button>
        <button
          onClick={() => void window.overcli.invoke('orchestrator:abort', { id: orchestration.id })}
          className="text-[11px] px-2 py-1 rounded text-ink-faint hover:text-red-400"
        >
          Discard
        </button>
      </div>
    </div>
  );
}

function HistoryLine({ record }: { record: ScheduleRunRecord }) {
  const colour =
    record.outcome === 'failed'
      ? 'text-red-500 dark:text-red-400'
      : record.outcome === 'skipped'
        ? 'text-ink-faint'
        : 'text-ink-muted';
  return (
    <span className={colour}>
      {relativeTime(record.at)} · {record.outcome}
      {record.note ? ` · ${record.note}` : ''}
    </span>
  );
}

// ---- editor ---------------------------------------------------------------

function ScheduleEditor() {
  const draft = useSchedulesStore((s) => s.draft)!;
  const busy = useSchedulesStore((s) => s.busy);
  const error = useSchedulesStore((s) => s.error);
  const patch = useSchedulesStore((s) => s.patchDraft);
  const save = useSchedulesStore((s) => s.save);
  const close = useSchedulesStore((s) => s.closeEditor);

  const projects = useStore((s) => s.projects);
  const workspaces = useStore((s) => s.workspaces);
  const flows = useFlowsStore((s) => s.flows);

  const problem = validateSchedule(draft as never);
  const isWorktree = draft.target.runIn === 'worktree';

  // Whether the target is a git repo at all. `null` while we're finding out.
  // A schedule that pulls data or pokes an API doesn't need one, and main
  // silently runs those in the folder itself rather than failing preflight —
  // so the form says that here instead of letting them find out at 9am.
  const [isRepo, setIsRepo] = useState<boolean | null>(null);
  useEffect(() => {
    if (!draft.projectPath) {
      setIsRepo(null);
      return;
    }
    let cancelled = false;
    setIsRepo(null);
    void window.overcli
      .invoke('git:commitStatus', { cwd: draft.projectPath })
      .then((res) => {
        if (!cancelled) setIsRepo(res.isRepo);
      })
      .catch(() => {
        if (!cancelled) setIsRepo(null);
      });
    return () => {
      cancelled = true;
    };
  }, [draft.projectPath]);

  function patchTarget(p: Partial<ScheduleDraft['target']>): void {
    patch({ target: { ...draft.target, ...p } as ScheduleDraft['target'] });
  }

  return (
    <div className="max-w-[720px]">
      <div className="flex items-center gap-3 mb-5">
        <button onClick={close} className="text-xs text-ink-faint hover:text-ink">
          ← Schedules
        </button>
        <div className="text-lg font-semibold">
          {draft.id ? 'Edit schedule' : 'New schedule'}
        </div>
      </div>

      <div className="space-y-5">
        <Field label="Name">
          <input
            value={draft.name}
            onChange={(e) => patch({ name: e.target.value })}
            placeholder="Morning triage"
            className="w-full bg-card border border-card-strong rounded px-2.5 py-1.5 text-sm text-ink"
          />
        </Field>

        <Field
          label="What it does"
          hint={
            draft.target.kind === 'flow'
              ? 'Launches one run, unattended.'
              : 'Runs the producer and parks the batch. Nothing launches until you approve it.'
          }
        >
          <div className="flex gap-1.5 mb-2">
            <Segment
              active={draft.target.kind === 'flow'}
              onClick={() =>
                patch({
                  target: {
                    kind: 'flow',
                    flowId: draft.target.flowId,
                    prompt: draft.target.prompt,
                    runIn: draft.target.runIn,
                    baseBranch: draft.target.baseBranch,
                  },
                })
              }
            >
              Run a flow
            </Segment>
            <Segment
              active={draft.target.kind === 'orchestrate'}
              onClick={() =>
                patch({
                  target: {
                    kind: 'orchestrate',
                    flowId: draft.target.flowId,
                    prompt: draft.target.prompt,
                    runIn: draft.target.runIn,
                    baseBranch: draft.target.baseBranch,
                    maxConcurrent: 2,
                  },
                })
              }
            >
              Propose a batch
            </Segment>
          </div>
        </Field>

        <div className="grid grid-cols-2 gap-4">
          <Field label="Project">
            <select
              value={draft.projectPath}
              onChange={(e) => patch({ projectPath: e.target.value })}
              className="w-full bg-card border border-card-strong rounded px-2 py-1.5 text-sm text-ink"
            >
              <option value="">Pick a target…</option>
              {projects.length > 0 && (
                <optgroup label="Projects">
                  {projects.map((p) => (
                    <option key={p.id} value={p.path}>
                      {p.name}
                    </option>
                  ))}
                </optgroup>
              )}
              {workspaces.length > 0 && (
                <optgroup label="Workspaces">
                  {workspaces.map((w) => (
                    <option key={w.id} value={w.rootPath}>
                      {w.name}
                    </option>
                  ))}
                </optgroup>
              )}
            </select>
          </Field>

          <Field
            label={draft.target.kind === 'flow' ? 'Flow' : 'Flow for each candidate'}
          >
            <select
              value={draft.target.flowId}
              onChange={(e) => patchTarget({ flowId: e.target.value })}
              className="w-full bg-card border border-card-strong rounded px-2 py-1.5 text-sm text-ink"
            >
              <option value="">Pick a flow…</option>
              {flows.map((f) => (
                <option key={`${f.source}:${f.id}`} value={f.id}>
                  {f.name}
                </option>
              ))}
            </select>
          </Field>
        </div>

        <Field
          label={draft.target.kind === 'flow' ? 'Prompt' : 'What to look for'}
          hint="Fixed — there is nobody there to type one when it fires."
        >
          <textarea
            value={draft.target.prompt}
            onChange={(e) => patchTarget({ prompt: e.target.value })}
            rows={4}
            placeholder={
              draft.target.kind === 'flow'
                ? 'Update the changelog from the commits since the last release.'
                : 'Pull new ProductBoard feedback from the last day and triage it into small asks.'
            }
            className="w-full bg-card border border-card-strong rounded px-2.5 py-1.5 text-sm text-ink font-mono"
          />
        </Field>

        <TriggerField />

        <Field label="Where it works">
          <div className="flex gap-1.5">
            <Segment
              active={isWorktree && isRepo !== false}
              onClick={() => patchTarget({ runIn: 'worktree' })}
            >
              Fresh worktree
            </Segment>
            <Segment
              active={!isWorktree || isRepo === false}
              onClick={() => patchTarget({ runIn: 'cwd' })}
            >
              Project tree
            </Segment>
          </div>
          {isRepo === false ? (
            <div className="mt-1.5 text-[11px] text-ink-faint">
              Not a git repo — this runs in the folder itself. Fine for schedules that pull
              data or talk to other systems rather than editing code.
            </div>
          ) : (
            !isWorktree && (
              <div className="mt-1.5 text-[11px] text-amber-600 dark:text-amber-400">
                Unattended edits land straight in your working tree. A worktree is the safer
                default for anything that runs while you&apos;re away.
              </div>
            )
          )}
          {isWorktree && isRepo === true && draft.projectPath && (
            <div className="mt-2">
              <BaseBranchSelect
                value={draft.target.baseBranch ?? ''}
                onChange={(v) => patchTarget({ baseBranch: v })}
                repoPaths={[draft.projectPath]}
              />
            </div>
          )}
        </Field>

        <div className="grid grid-cols-2 gap-4">
          <Field label="If the last run is still going">
            <select
              value={draft.onOverlap}
              onChange={(e) => patch({ onOverlap: e.target.value as ScheduleDraft['onOverlap'] })}
              className="w-full bg-card border border-card-strong rounded px-2 py-1.5 text-sm text-ink"
            >
              <option value="skip">Skip this one</option>
              <option value="queue">Run it when the current one ends</option>
              <option value="replace">Cancel it and start fresh</option>
            </select>
          </Field>
          <Field label="If overcli was closed">
            <select
              value={draft.catchUp}
              onChange={(e) => patch({ catchUp: e.target.value as ScheduleDraft['catchUp'] })}
              className="w-full bg-card border border-card-strong rounded px-2 py-1.5 text-sm text-ink"
            >
              <option value="skip">Skip what was missed</option>
              <option value="once">Run once to catch up</option>
            </select>
          </Field>
        </div>

        {(problem || error) && (
          <div className="text-sm text-red-700 dark:text-red-300 bg-red-500/15 border border-red-400/40 rounded px-3 py-2">
            {error ?? problem}
          </div>
        )}

        <div className="flex items-center gap-2 pt-1">
          <button
            disabled={!!problem || busy}
            onClick={() => void save()}
            className="text-xs px-3 py-1.5 rounded-md bg-accent text-white hover:opacity-90 disabled:opacity-40"
          >
            {busy ? 'Saving…' : draft.id ? 'Save changes' : 'Create schedule'}
          </button>
          <button
            onClick={close}
            className="text-xs px-3 py-1.5 rounded-md border border-card-strong hover:bg-white/5"
          >
            Cancel
          </button>
          <label className="ml-auto flex items-center gap-1.5 text-xs text-ink-muted">
            <input
              type="checkbox"
              checked={draft.enabled}
              onChange={(e) => patch({ enabled: e.target.checked })}
            />
            Enabled
          </label>
        </div>
      </div>
    </div>
  );
}

/// Cadence picker. Presets rather than a cron box: the two shapes below cover
/// what people actually ask a coding agent for, and neither has to be taught.
///
/// Both shapes take a day set. The interval also takes an active window, so
/// "every hour, weekdays, 8am–5pm" is expressible — a repeating check that
/// shouldn't run overnight or at the weekend is the normal case, not an
/// exotic one, and without the window you'd get 24 runs a day to get 9.
function TriggerField() {
  const draft = useSchedulesStore((s) => s.draft)!;
  const patch = useSchedulesStore((s) => s.patchDraft);
  const trigger = draft.trigger;
  const windowed = trigger.kind === 'interval' && !!trigger.window;

  const setDays = (days: number[]) => patch({ trigger: { ...trigger, days } });

  return (
    <Field label="When" hint={describeTrigger(trigger)}>
      <div className="flex gap-1.5 mb-3">
        <Segment
          active={trigger.kind === 'daily'}
          onClick={() =>
            patch({ trigger: { kind: 'daily', time: '09:00', days: trigger.days ?? WEEKDAY_SET } })
          }
        >
          At a time of day
        </Segment>
        <Segment
          active={trigger.kind === 'interval'}
          onClick={() =>
            patch({ trigger: { kind: 'interval', everyMinutes: 240, days: trigger.days } })
          }
        >
          On an interval
        </Segment>
      </div>

      <div className="space-y-3">
        {trigger.kind === 'daily' ? (
          <input
            type="time"
            value={trigger.time}
            onChange={(e) => patch({ trigger: { ...trigger, time: e.target.value } })}
            className="bg-card border border-card-strong rounded px-2 py-1 text-sm text-ink"
          />
        ) : (
          <div className="flex items-center gap-2">
            <span className="text-sm text-ink-muted">Every</span>
            <select
              value={trigger.everyMinutes}
              onChange={(e) =>
                patch({ trigger: { ...trigger, everyMinutes: Number(e.target.value) } })
              }
              className="bg-card border border-card-strong rounded px-2 py-1 text-sm text-ink"
            >
              {[15, 30, 60, 120, 240, 480, 720, 1440].map((m) => (
                <option key={m} value={m}>
                  {m < 60 ? `${m} minutes` : m === 60 ? 'hour' : `${m / 60} hours`}
                </option>
              ))}
            </select>
          </div>
        )}

        <DayPicker days={trigger.days} onChange={setDays} />

        {trigger.kind === 'interval' && (
          <div>
            <label className="flex items-center gap-1.5 text-xs text-ink-muted">
              <input
                type="checkbox"
                checked={windowed}
                onChange={(e) =>
                  patch({
                    trigger: {
                      ...trigger,
                      // Default to a working day — the reason anyone reaches
                      // for this in the first place.
                      window: e.target.checked ? { start: '08:00', end: '17:00' } : undefined,
                    },
                  })
                }
              />
              Only between certain hours
            </label>
            {trigger.window && (
              <div className="mt-2 flex items-center gap-2">
                <input
                  type="time"
                  value={trigger.window.start}
                  onChange={(e) =>
                    patch({
                      trigger: {
                        ...trigger,
                        window: { start: e.target.value, end: trigger.window!.end },
                      },
                    })
                  }
                  className="bg-card border border-card-strong rounded px-2 py-1 text-sm text-ink"
                />
                <span className="text-xs text-ink-faint">to</span>
                <input
                  type="time"
                  value={trigger.window.end}
                  onChange={(e) =>
                    patch({
                      trigger: {
                        ...trigger,
                        window: { start: trigger.window!.start, end: e.target.value },
                      },
                    })
                  }
                  className="bg-card border border-card-strong rounded px-2 py-1 text-sm text-ink"
                />
                <span className="text-[11px] text-ink-faint">
                  {isWrappedWindow(trigger.window)
                    ? 'overnight — runs through midnight'
                    : 'inclusive of both ends'}
                </span>
              </div>
            )}
          </div>
        )}
      </div>
    </Field>
  );
}

/// End time before start time means the window crosses midnight. Worth saying
/// out loud rather than letting it look like a mistake the user made.
function isWrappedWindow(window: { start: string; end: string }): boolean {
  return window.start > window.end;
}

function DayPicker({
  days,
  onChange,
}: {
  days?: number[];
  onChange: (days: number[]) => void;
}) {
  const list = days ?? [];
  // An empty set means every day, so render that as all-on rather than
  // all-off — the control has to agree with the "Every day" hint above it.
  const everyDay = list.length === 0;
  const toggle = (d: number) => {
    const base = everyDay ? [0, 1, 2, 3, 4, 5, 6] : list;
    onChange(base.includes(d) ? base.filter((x) => x !== d) : [...base, d]);
  };
  return (
    <div className="flex items-center gap-2 flex-wrap">
      <div className="flex gap-1">
        {['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map((label, d) => {
          const on = everyDay || list.includes(d);
          return (
            <button
              key={label}
              onClick={() => toggle(d)}
              title={label}
              className={
                'w-9 py-1 rounded text-[11px] ' +
                (on ? 'bg-accent text-white' : 'border border-card-strong text-ink-faint')
              }
            >
              {label[0]}
            </button>
          );
        })}
      </div>
      <button
        onClick={() => onChange(WEEKDAY_SET)}
        className="text-[11px] text-ink-faint hover:text-ink px-1.5 py-0.5 rounded hover:bg-white/5"
      >
        Weekdays
      </button>
      <button
        onClick={() => onChange([])}
        className="text-[11px] text-ink-faint hover:text-ink px-1.5 py-0.5 rounded hover:bg-white/5"
      >
        Every day
      </button>
    </div>
  );
}

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <div className="flex items-baseline gap-2 mb-1.5">
        <span className="text-[11px] uppercase tracking-wider text-ink-faint">{label}</span>
        {hint && <span className="text-[11px] text-ink-faint normal-case">{hint}</span>}
      </div>
      {children}
    </div>
  );
}

function Segment({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className={
        'px-3 py-1 rounded-md text-xs ' +
        (active
          ? 'bg-accent text-white'
          : 'border border-card-strong text-ink-muted hover:bg-white/5')
      }
    >
      {children}
    </button>
  );
}


function relativeTime(ts: number): string {
  const diff = Date.now() - ts;
  if (diff < 60_000) return 'just now';
  if (diff < 3_600_000) return `${Math.round(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.round(diff / 3_600_000)}h ago`;
  if (diff < 7 * 86_400_000) return `${Math.round(diff / 86_400_000)}d ago`;
  return new Date(ts).toLocaleDateString();
}
