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
  SCHEDULE_AUTO_APPROVE_MAX,
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
            openEditor(newScheduleDraft(workspaces[0]?.rootPath ?? projects[0]?.path ?? ''))
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
            {schedule.target.kind === 'orchestrate' &&
              (schedule.target.autoApprove ? (
                <span
                  title={`Launches up to ${schedule.target.autoApprove.maxItems} unattended.`}
                  className="text-[10px] px-1.5 py-0.5 rounded uppercase tracking-wider bg-amber-500/20 text-amber-700 dark:text-amber-300"
                >
                  auto ×{schedule.target.autoApprove.maxItems}
                </span>
              ) : (
                <span className="text-[10px] px-1.5 py-0.5 rounded uppercase tracking-wider bg-violet-500/20 text-violet-700 dark:text-violet-300">
                  proposes
                </span>
              ))}
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
  const autoApprove =
    draft.target.kind === 'orchestrate' ? draft.target.autoApprove : undefined;
  const projectLabel =
    [...workspaces.map((w) => ({ name: w.name, path: w.rootPath })), ...projects].find(
      (t) => t.path === draft.projectPath,
    )?.name ?? null;

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
    // A workspace root is never itself a git repo, but a run targeting one
    // gets a worktree per member — so asking git about the root alone would
    // grey out "Fresh worktree" for every workspace schedule and quietly pin
    // it to the working tree.
    if (workspaces.some((w) => w.rootPath === draft.projectPath)) {
      setIsRepo(true);
      return;
    }
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
  }, [draft.projectPath, workspaces]);

  function patchTarget(p: Partial<ScheduleDraft['target']>): void {
    patch({ target: { ...draft.target, ...p } as ScheduleDraft['target'] });
  }

  // Don't hold a base branch the form doesn't show. The picker below is
  // gated off for workspace targets (one name can't be picked against 20
  // repos here the way the flow launcher does it), so a value left over
  // from an earlier single-repo target would be invisible here and still
  // shipped to every member at 4am. Runs re-detect per repo without it.
  const targetIsWorkspace = workspaces.some((w) => w.rootPath === draft.projectPath);
  useEffect(() => {
    if (targetIsWorkspace && draft.target.baseBranch) patchTarget({ baseBranch: undefined });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [targetIsWorkspace, draft.target.baseBranch]);

  return (
    <div>
      {/* Header, two-column body, card sections, summary-at-the-top: the same
          skeleton as the flow editor. These are the two places in the app
          where you build a thing rather than run one, and they were shaped
          differently for no reason a user could see. */}
      <div className="flex items-center gap-3 mb-4">
        <button
          onClick={close}
          className="text-xs text-ink-faint hover:text-ink px-2 py-1 rounded hover:bg-white/5"
        >
          ← Schedules
        </button>
        <div className="text-2xl font-semibold">
          {draft.id ? 'Edit schedule' : 'New schedule'}
        </div>
        {/* Save at the top, like the flow editor's. It used to sit under a
            long form, so on a tall schedule you had to scroll past everything
            you'd just decided to commit it. */}
        <div className="ml-auto flex items-center gap-2">
          <label className="flex items-center gap-1.5 text-xs text-ink-muted mr-1">
            <input
              type="checkbox"
              checked={draft.enabled}
              onChange={(e) => patch({ enabled: e.target.checked })}
            />
            Enabled
          </label>
          <button
            onClick={close}
            className="text-xs px-3 py-1.5 rounded-md border border-card-strong hover:bg-white/5"
          >
            Cancel
          </button>
          <button
            disabled={!!problem || busy}
            onClick={() => void save()}
            className="text-xs px-3 py-1.5 rounded-md bg-accent text-white hover:opacity-90 disabled:opacity-40"
          >
            {busy ? 'Saving…' : draft.id ? 'Save changes' : 'Create schedule'}
          </button>
        </div>
      </div>

      <div className="grid grid-cols-[1fr_minmax(280px,360px)] gap-6 items-start">
        <div className="min-w-0 space-y-4">
          <ScheduleTimeline draft={draft} projectLabel={projectLabel} />

          <div className="rounded-xl bg-card p-5 shadow-sm">
            <div className="text-[10px] uppercase tracking-[0.18em] text-ink-faint mb-2">
              Schedule
            </div>
            <input
              value={draft.name}
              onChange={(e) => patch({ name: e.target.value })}
              placeholder="Untitled schedule"
              className="w-full bg-transparent text-2xl font-semibold text-ink placeholder:text-ink-faint focus:outline-none mb-4"
            />
            <TriggerField />
          </div>

          <div className="rounded-xl bg-card p-5 shadow-sm space-y-5">
            <div className="text-sm font-semibold -mb-1">What it does</div>
        <Field
          label="What it does"
          hint={
            draft.target.kind === 'flow'
              ? 'Launches one run, unattended.'
              : draft.target.autoApprove
                ? 'Runs the producer and launches what it finds, up to the cap below.'
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
          <Field label="Workspace / Project">
            <select
              value={draft.projectPath}
              onChange={(e) =>
                patch({
                  projectPath: e.target.value,
                  // A base branch is only meaningful against the repos it was
                  // picked from. Carrying it across a target change is how a
                  // schedule ends up forking a workspace off a branch that
                  // only ever existed in some unrelated project — and since
                  // the picker below is hidden for workspace targets, a stale
                  // name is invisible AND unclearable from here.
                  target: { ...draft.target, baseBranch: undefined },
                })
              }
              className="w-full bg-card border border-card-strong rounded px-2 py-1.5 text-sm text-ink"
            >
              <option value="">Pick a target…</option>
              {/* Workspaces first, as in the Orchestrator's picker: scheduled
                  work more often spans a whole workspace than one repo, and a
                  list that opens on the less likely answer makes you scroll to
                  the usual one every time. */}
              {workspaces.length > 0 && (
                <optgroup label="Workspaces">
                  {workspaces.map((w) => (
                    <option key={w.id} value={w.rootPath}>
                      {w.name}
                    </option>
                  ))}
                </optgroup>
              )}
              {projects.length > 0 && (
                <optgroup label="Projects">
                  {projects.map((p) => (
                    <option key={p.id} value={p.path}>
                      {p.name}
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

          </div>

          <div className="rounded-xl bg-card p-5 shadow-sm space-y-5">
            <div className="text-sm font-semibold -mb-1">How it runs</div>
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
          {isWorktree && isRepo === true && draft.projectPath && !targetIsWorkspace && (
            <div className="mt-2">
              <BaseBranchSelect
                value={draft.target.baseBranch ?? ''}
                onChange={(v) => patchTarget({ baseBranch: v })}
                repoPaths={[draft.projectPath]}
              />
            </div>
          )}
        </Field>

        {draft.target.kind === 'orchestrate' && (
          <Field
            label="When the producer comes back"
            hint={
              autoApprove
                ? 'Anything past the cap still waits for you.'
                : 'The safe default — you see the list before anything runs.'
            }
          >
            <div className="flex gap-1.5">
              <Segment
                active={!autoApprove}
                onClick={() => patchTarget({ autoApprove: undefined })}
              >
                Wait for my approval
              </Segment>
              <Segment
                active={!!autoApprove}
                onClick={() => patchTarget({ autoApprove: { maxItems: 3 } })}
              >
                Launch it
              </Segment>
            </div>
            {autoApprove && (
              <>
                <div className="mt-2.5 flex items-center gap-2 text-xs text-ink-muted">
                  <span>Launch at most</span>
                  <input
                    type="number"
                    min={1}
                    max={SCHEDULE_AUTO_APPROVE_MAX}
                    value={autoApprove.maxItems}
                    onChange={(e) =>
                      patchTarget({
                        autoApprove: { maxItems: Number(e.target.value) },
                      })
                    }
                    className="w-16 bg-card border border-card-strong rounded px-2 py-1 text-sm text-ink"
                  />
                  <span>
                    {autoApprove.maxItems === 1 ? 'ask' : 'asks'} per firing, the rest parked
                  </span>
                </div>
                <div className="mt-1.5 text-[11px] text-amber-600 dark:text-amber-400">
                  The producer decides what these are, and they run with nobody watching.
                  {isWorktree
                    ? ' Each gets its own worktree.'
                    : ' They land straight in your working tree, one at a time.'}
                </div>
              </>
            )}
          </Field>
        )}

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

          </div>

          {(problem || error) && (
            <div className="text-sm text-red-700 dark:text-red-300 bg-red-500/15 border border-red-400/40 rounded px-3 py-2">
              {error ?? problem}
            </div>
          )}
        </div>
        <HelpRail draft={draft} patch={patch} />
      </div>
    </div>
  );
}

/// The schedule's answer to the flow editor's pipeline diagram: what this
/// thing will actually do, read left to right, before you've read a single
/// field. Same grammar — pills and arrows on a card — because it's the same
/// question in a different editor.
///
/// Derived, never stored. Every chip is a projection of the draft, so it can't
/// drift from the form the way a hand-written summary would.
function ScheduleTimeline({
  draft,
  projectLabel,
}: {
  draft: ScheduleDraft;
  projectLabel: string | null;
}) {
  const t = draft.target;
  const auto = t.kind === 'orchestrate' ? t.autoApprove : undefined;
  const chips: string[] = [
    t.kind === 'flow' ? 'Run one flow' : 'Ask the producer',
    projectLabel ?? 'no project',
    t.runIn === 'worktree' ? 'Fresh worktree' : 'Project tree',
  ];
  if (t.kind === 'orchestrate') {
    chips.push(
      auto
        ? `Launch up to ${auto.maxItems}, park the rest`
        : 'Park it for your approval',
    );
  }
  return (
    <div className="rounded-xl bg-card p-4 shadow-sm">
      <div className="text-[11px] uppercase tracking-wider text-ink-faint mb-2">Timeline</div>
      <div className="flex flex-wrap items-center gap-x-1 gap-y-3">
        <div className="rounded-full bg-card-strong px-3 py-1.5 text-[11px] text-ink shadow-sm">
          {describeTrigger(draft.trigger)}
        </div>
        {chips.map((c) => (
          <span key={c} className="flex items-center gap-1">
            <TimelineArrow />
            <span className="rounded-full bg-card-strong px-3 py-1.5 text-[11px] text-ink-muted shadow-sm">
              {c}
            </span>
          </span>
        ))}
      </div>
      {!draft.target.flowId && (
        <div className="mt-3 text-[11px] text-amber-600 dark:text-amber-400">
          No flow picked yet — a schedule can&apos;t fire without one.
        </div>
      )}
    </div>
  );
}

function TimelineArrow() {
  return (
    <svg width="20" height="14" viewBox="0 0 20 14" className="text-ink-faint flex-shrink-0">
      <path d="M2 7 H16" stroke="currentColor" strokeWidth="1.4" />
      <path d="M14 3 L18 7 L14 11" stroke="currentColor" strokeWidth="1.4" fill="none" />
    </svg>
  );
}

/// Four shapes a schedule actually takes, as one-click starters. They fill
/// everything except the project and the flow — those are yours, and guessing
/// at them would make the button feel like it did the wrong thing.
///
/// Chosen to differ on the axes the form asks about rather than on subject
/// matter: one runs a single flow, one proposes a batch and waits, one
/// proposes and launches, one repeats on an interval inside working hours and
/// never touches the tree. Read together they answer "what are these controls
/// for" better than any amount of prose next to each field.
const SCHEDULE_PRESETS: Array<{
  label: string;
  blurb: string;
  patch: Omit<ScheduleDraft, 'id' | 'projectPath' | 'enabled'>;
}> = [
  {
    label: 'Morning triage',
    blurb: 'Asks your tracker for small jobs before you start, and parks them for you.',
    patch: {
      name: 'Morning triage',
      target: {
        kind: 'orchestrate',
        flowId: '',
        prompt:
          'Look at my open tickets and recent feedback, and pull out the small, self-contained ones I could knock out individually today.',
        runIn: 'worktree',
        maxConcurrent: 2,
      },
      trigger: { kind: 'daily', time: '08:00', days: [1, 2, 3, 4, 5] },
      onOverlap: 'skip',
      catchUp: 'skip',
    },
  },
  {
    label: 'Overnight sweep',
    blurb: 'Proposes a batch at 2am and launches the first few unattended.',
    patch: {
      name: 'Overnight sweep',
      target: {
        kind: 'orchestrate',
        flowId: '',
        prompt:
          'Find the flaky or failing tests from the last day and the small fixes they point at.',
        runIn: 'worktree',
        maxConcurrent: 2,
        autoApprove: { maxItems: 3 },
      },
      trigger: { kind: 'daily', time: '02:00', days: [1, 2, 3, 4, 5] },
      onOverlap: 'skip',
      catchUp: 'skip',
    },
  },
  {
    // The one preset that repeats through the day rather than firing once,
    // and the one that has no business making a worktree — it answers people,
    // it doesn't write code. Both of those are hard to discover from the form
    // alone, which is why this shape is worth a button.
    //
    // Reaches Slack through whatever the user has connected, like every other
    // prompt here; if they haven't, the run says so rather than inventing an
    // answer, which is the same failure a mis-typed tracker prompt gives.
    label: 'Answer Slack questions',
    blurb: 'Hourly through the working day — replies in the thread, from what it can read here.',
    patch: {
      name: 'Answer Slack questions',
      target: {
        kind: 'flow',
        flowId: '',
        // Standing on its own matters more here than anywhere else: it fires
        // 9 times a day with nobody watching, and it writes where other people
        // can see it. Hence the explicit "leave it alone" — an unattended run
        // that guesses in public is worse than one that does nothing.
        prompt:
          'Check Slack for questions aimed at me or my team that nobody has answered yet, and reply in the thread. Answer from the code and docs in this project. If a question is already answered, or you cannot answer it confidently from what you can read, leave it alone rather than guessing.',
        // No worktree: it reads to answer and writes to Slack, so forking the
        // repo every hour would leave a trail of empty branches.
        runIn: 'cwd',
      },
      trigger: {
        kind: 'interval',
        everyMinutes: 60,
        days: [1, 2, 3, 4, 5],
        window: { start: '09:00', end: '17:00' },
      },
      onOverlap: 'skip',
      // A missed hour is a stale hour — the next firing covers the same
      // backlog, so there is nothing to catch up on.
      catchUp: 'skip',
    },
  },
  {
    label: 'Weekly changelog',
    blurb: 'One run, one flow, same prompt every Monday.',
    patch: {
      name: 'Weekly changelog',
      target: {
        kind: 'flow',
        flowId: '',
        prompt: 'Update the changelog from the commits since the last release.',
        runIn: 'worktree',
      },
      trigger: { kind: 'daily', time: '09:00', days: [1] },
      onOverlap: 'skip',
      catchUp: 'once',
    },
  },
];

/// What each section of the form is deciding, in the order the form asks. Kept
/// to one line each: a rail you have to read is a rail you stop reading, and
/// the fields already carry their own hints for the details.
const HELP_NOTES: Array<{ title: string; body: string }> = [
  {
    title: 'What it does',
    body: 'One run with a fixed prompt, or a producer turn that finds several jobs and fans them out.',
  },
  {
    title: 'What to look for',
    body: 'Fires with nobody watching, so the prompt has to stand on its own — no “the ticket I mentioned”.',
  },
  {
    title: 'Where it works',
    body: 'A fresh worktree keeps unattended edits off your checked-out branch. A workspace forks one per repo.',
  },
  {
    title: 'When the producer comes back',
    body: 'Waiting is the safe default. Launching is capped per firing, so a big morning parks the overflow instead of forking a dozen worktrees.',
  },
  {
    title: 'If it overlaps or you were closed',
    body: 'Schedules only fire while overcli is open. These two decide what a missed or overlapping slot costs you.',
  },
];

/// Sits beside the form rather than above it: the form is already long, and
/// help stacked on top of it is help you scroll past once and never see again.
/// Hidden below `xl` — under that the form has the width and the rail would
/// squeeze it.
function HelpRail({
  draft,
  patch,
}: {
  draft: ScheduleDraft;
  patch: (p: Partial<ScheduleDraft>) => void;
}) {
  return (
    <aside className="sticky top-4 space-y-4">
      <div className="rounded-lg border border-card-strong p-4">
        <div className="text-[11px] uppercase tracking-wider text-ink-faint font-bold mb-2.5">
          Start from an example
        </div>
        <div className="space-y-1.5">
          {SCHEDULE_PRESETS.map((p) => (
            <button
              key={p.label}
              // Project and flow survive on purpose — the user picked those,
              // and a starter that silently reset them would be a trap.
              onClick={() =>
                patch({
                  ...p.patch,
                  target: { ...p.patch.target, flowId: draft.target.flowId },
                })
              }
              className="group w-full text-left p-2.5 rounded-md bg-card hover:bg-card-strong transition-colors"
            >
              <div className="flex items-center gap-2">
                <span className="text-[13px] font-medium text-ink">{p.label}</span>
                <span className="ml-auto text-[11px] text-accent opacity-0 group-hover:opacity-100 transition-opacity">
                  use →
                </span>
              </div>
              <div className="text-[11px] text-ink-faint mt-0.5 leading-snug">{p.blurb}</div>
            </button>
          ))}
        </div>
        <p className="text-[11px] text-ink-faint mt-2.5 mb-0 leading-snug">
          Fills everything but the project and flow — those stay as you set them.
        </p>
      </div>

      <div className="rounded-lg border border-card-strong p-4 space-y-3">
        <div className="text-[11px] uppercase tracking-wider text-ink-faint font-bold">
          What you&apos;re deciding
        </div>
        {HELP_NOTES.map((n) => (
          <div key={n.title}>
            <div className="text-xs text-ink font-medium">{n.title}</div>
            <div className="text-[11px] text-ink-faint leading-snug mt-0.5">{n.body}</div>
          </div>
        ))}
      </div>
    </aside>
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
