// The Workers tab: standing personas you hire against a job description.
// A worker is not a saved prompt on a timer — every shift it re-plans from
// its job description plus its journal, parks proposals through the
// orchestrator, and earns (or loses) the right to launch work unattended.
//
// Three surfaces in one pane, mutually exclusive like SchedulesPane:
//   - the roster (list of hired workers, each with scorecard + budget burn)
//   - the hire screen (job description → drafted contract → editor)
//   - the editor (review/adjust the contract; the only place Save lives)

import { useEffect, useMemo, useState } from 'react';

import { useStore } from '../../store';
import { useFlowsStore } from '../../flowsStore';
import { useOrchestratorStore } from '../../orchestratorStore';
import {
  draftFromContract,
  draftFromWorker,
  newWorkerDraft,
  useWorkersStore,
} from '../../workersStore';
import {
  WORKER_MAX_ITEMS_PER_SHIFT,
  WORKER_MIN_INTERVAL_MINUTES,
  validateWorker,
  workerAutoApproveCap,
  type Worker,
  type WorkerJournalEntry,
  type WorkerScorecard,
  type WorkerTrustLevel,
} from '@shared/flows/worker';
import { describeTrigger, untilLabel, type ScheduleTrigger } from '@shared/flows/schedule';
import { isOrchestrationAwaitingApproval, type Orchestration } from '@shared/flows/orchestration';
import { Markdown } from '../Markdown';
import { FlowMonogram } from '../flows/FlowMonogram';

export function WorkersPane() {
  const projects = useStore((s) => s.projects);
  const workspaces = useStore((s) => s.workspaces);
  const loaded = useWorkersStore((s) => s.loaded);
  const workers = useWorkersStore((s) => s.workers);
  const draft = useWorkersStore((s) => s.draft);
  const error = useWorkersStore((s) => s.error);
  const reload = useWorkersStore((s) => s.reload);
  const openEditor = useWorkersStore((s) => s.openEditor);
  const clearError = useWorkersStore((s) => s.clearError);
  const [hiring, setHiring] = useState(false);

  useEffect(() => {
    void reload();
    // The editor's flow picker needs the flow library even when the user has
    // never opened the Flows tab this session.
    if (useFlowsStore.getState().flows.length === 0) {
      void useFlowsStore.getState().reload(projects.map((p) => p.path));
    }
  }, []);

  const rows = useMemo(
    () => Object.values(workers).sort((a, b) => b.createdAt - a.createdAt),
    [workers],
  );

  const nameForPath = useMemo(() => {
    const m = new Map<string, string>();
    for (const p of projects) m.set(p.path, p.name);
    for (const w of workspaces) m.set(w.rootPath, w.name);
    return m;
  }, [projects, workspaces]);

  const defaultProjectPath = workspaces[0]?.rootPath ?? projects[0]?.path ?? '';
  const canHire = defaultProjectPath !== '';

  if (draft) return <WorkerEditor />;
  if (hiring) return <HireWorker defaultProjectPath={defaultProjectPath} onClose={() => setHiring(false)} />;

  return (
    <div className="flex-1 overflow-y-auto p-6">
      {/* Same header idiom as the Flows tab: one row, text-2xl title, actions
          pushed right with ml-auto on the first button, and the what-is-this
          line UNDER the title — beside it, a sentence next to a 2xl heading
          reads as misalignment rather than a subtitle. */}
      <div className="flex items-center gap-3 mb-2">
        <div className="text-2xl font-semibold">Workers</div>
        <button
          disabled={!canHire}
          onClick={() => openEditor(newWorkerDraft(defaultProjectPath))}
          className="ml-auto text-xs px-3 py-1.5 rounded-md border border-card-strong hover:bg-white/5 disabled:opacity-40"
        >
          Add by hand
        </button>
        <button
          disabled={!canHire}
          onClick={() => setHiring(true)}
          className="text-xs px-3 py-1.5 rounded-md bg-accent text-white hover:opacity-90 disabled:opacity-40"
        >
          ✨ Hire a worker
        </button>
      </div>
      <div className="text-xs text-ink-muted mb-6">
        Standing personas on a clock — each shift they plan their own batch of work and file it
        for your approval.
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
        <div className="text-sm text-ink-muted">Loading workers…</div>
      ) : rows.length === 0 ? (
        <WorkersEmptyState />
      ) : (
        <div className="space-y-2">
          {rows.map((w) => (
            <WorkerRow key={w.id} worker={w} projectLabel={nameForPath.get(w.projectPath)} />
          ))}
        </div>
      )}

      {rows.some((w) => w.enabled) && (
        <div className="mt-6 text-[11px] text-ink-faint">
          Shifts only fire while overcli is open. A shift missed while it was closed is
          journaled, not silently replayed.
        </div>
      )}
    </div>
  );
}

function WorkersEmptyState() {
  return (
    <div className="rounded-xl bg-card p-6 text-sm text-ink-muted space-y-3">
      <div className="text-ink font-medium">Nobody works here yet.</div>
      <p>
        A worker is a job description with a clock: <em>&ldquo;Read the new tickets every
        morning, reproduce what you can, and hand me ready-to-run fix candidates.&rdquo;</em>{' '}
        Each shift it re-reads the project and its own journal, decides what today&apos;s most
        valuable version of that job is, and files proposals for you to approve.
      </p>
      <p>
        Every hire starts on <span className="text-amber-500">probation</span> — nothing runs
        unattended until you promote it. Rejected proposals are remembered and never come back.
      </p>
    </div>
  );
}

// ---- Roster row ----------------------------------------------------------

const TRUST_LABEL: Record<WorkerTrustLevel, { text: string; cls: string }> = {
  probation: { text: 'probation', cls: 'text-amber-600 dark:text-amber-400 border-amber-400/40' },
  trusted: { text: 'trusted', cls: 'text-sky-600 dark:text-sky-400 border-sky-400/40' },
  autonomous: {
    text: 'autonomous',
    cls: 'text-emerald-600 dark:text-emerald-400 border-emerald-400/40',
  },
};

function WorkerRow({ worker, projectLabel }: { worker: Worker; projectLabel?: string }) {
  const nextShiftAt = useWorkersStore((s) => s.nextShiftAt[worker.id] ?? null);
  const scorecard = useWorkersStore((s) => s.scorecards[worker.id]);
  const shift = useWorkersStore((s) => s.shiftProgress[worker.id]);
  const busy = useWorkersStore((s) => s.busy);
  const setEnabled = useWorkersStore((s) => s.setEnabled);
  const remove = useWorkersStore((s) => s.remove);
  const workShiftNow = useWorkersStore((s) => s.workShiftNow);
  const openEditor = useWorkersStore((s) => s.openEditor);
  const [confirmingFire, setConfirmingFire] = useState(false);
  const [expanded, setExpanded] = useState<'journal' | 'plan' | null>(null);

  // A worker's parked shift output surfaces on its own row — the whole point
  // of a probationary worker is that its overnight work waits HERE.
  const orchestrations = useOrchestratorStore((s) => s.orchestrations);
  const mine = useMemo(
    () =>
      Object.values(orchestrations)
        .filter((o) => o.origin?.kind === 'worker' && o.origin.workerId === worker.id)
        .sort((a, b) => b.createdAt - a.createdAt),
    [orchestrations, worker.id],
  );
  const awaiting = mine.filter(isOrchestrationAwaitingApproval);
  const latest = mine[0];

  const trust = TRUST_LABEL[worker.trust];
  const cap = workerAutoApproveCap(worker);
  const budgetPct =
    scorecard && worker.budgetUSDPerMonth > 0
      ? Math.min(100, (scorecard.spentThisMonthUSD / worker.budgetUSDPerMonth) * 100)
      : 0;

  return (
    <div
      className={
        'rounded-lg px-3 py-2.5 border ' +
        (awaiting.length > 0 ? 'border-violet-400/40 bg-violet-500/5' : 'border-card-strong')
      }
    >
      <div className="flex items-start gap-3">
        {/* Enable toggle */}
        <button
          onClick={() => void setEnabled(worker.id, !worker.enabled)}
          title={worker.enabled ? 'Pause this worker' : 'Resume this worker'}
          className={
            'mt-1 w-8 rounded-full relative transition-colors shrink-0 ' +
            (worker.enabled ? 'bg-accent' : 'bg-card-strong')
          }
          style={{ height: 18 }}
        >
          <span
            className="absolute top-0.5 w-3.5 h-3.5 rounded-full bg-white transition-all"
            style={{ left: worker.enabled ? 16 : 2 }}
          />
        </button>

        <button className="flex-1 min-w-0 text-left" onClick={() => openEditor(draftFromWorker(worker))}>
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium text-ink truncate">{worker.name}</span>
            <span className={`text-[10px] px-1.5 py-0.5 rounded border ${trust.cls}`}>
              {trust.text}
            </span>
            {cap > 0 && (
              <span className="text-[10px] text-ink-faint">auto-runs {cap}/shift</span>
            )}
          </div>
          <div className="text-xs text-ink-muted mt-0.5 truncate">
            {describeTrigger(worker.cadence)}
            {projectLabel ? ` · ${projectLabel}` : ''}
            {(worker.shiftCount ?? 0) > 0
              ? ` · ${worker.shiftCount} shift${worker.shiftCount === 1 ? '' : 's'} worked`
              : ' · no shifts yet'}
            {worker.lastShiftAt ? ` · last ${relativeTime(worker.lastShiftAt)}` : ''}
            {worker.enabled && nextShiftAt != null ? ` · next ${untilLabel(nextShiftAt)}` : ''}
            {!worker.enabled ? ' · paused' : ''}
          </div>
          {scorecard && <ScorecardChips scorecard={scorecard} />}
          {scorecard && (
            <div className="mt-1.5 flex items-center gap-2">
              <div className="h-1 rounded-full bg-card-strong overflow-hidden" style={{ width: 120 }}>
                <div
                  className={`h-full ${budgetPct >= 100 ? 'bg-red-500' : 'bg-accent'}`}
                  style={{ width: `${budgetPct}%` }}
                />
              </div>
              <span className="text-[10px] text-ink-faint">
                ${scorecard.spentThisMonthUSD.toFixed(2)} of ${worker.budgetUSDPerMonth.toFixed(0)}{' '}
                this month
              </span>
            </div>
          )}
        </button>

        {confirmingFire ? (
          <div className="flex gap-1 shrink-0">
            <button
              onClick={() => void remove(worker.id)}
              className="text-[11px] px-2 py-0.5 rounded bg-red-500/80 text-white"
            >
              Confirm
            </button>
            <button
              onClick={() => setConfirmingFire(false)}
              className="text-[11px] px-2 py-0.5 rounded border border-card-strong"
            >
              Cancel
            </button>
          </div>
        ) : (
          <div className="flex gap-1 shrink-0">
            <TrustControls worker={worker} />
            <button
              disabled={busy || !!shift}
              onClick={() => void workShiftNow(worker.id)}
              title="Work one shift now, out of band"
              className="text-[11px] px-2 py-0.5 rounded border border-card-strong hover:bg-white/5 disabled:opacity-40"
            >
              Work now
            </button>
            {latest && (
              <button
                onClick={() => setExpanded((v) => (v === 'plan' ? null : 'plan'))}
                title="What the worker planned on its last shift"
                className={
                  'text-[11px] px-2 py-0.5 rounded border hover:bg-white/5 ' +
                  (expanded === 'plan' ? 'border-accent text-ink' : 'border-card-strong')
                }
              >
                Plan
              </button>
            )}
            <button
              onClick={() => setExpanded((v) => (v === 'journal' ? null : 'journal'))}
              className={
                'text-[11px] px-2 py-0.5 rounded border hover:bg-white/5 ' +
                (expanded === 'journal' ? 'border-accent text-ink' : 'border-card-strong')
              }
            >
              Journal
            </button>
            <button
              onClick={() => setConfirmingFire(true)}
              title="Fire this worker. Its runs and journal survive."
              className="text-[11px] px-2 py-0.5 rounded text-ink-faint hover:text-red-400"
            >
              Fire
            </button>
          </div>
        )}
      </div>

      {shift && <LiveShiftStrip text={shift.text} tools={shift.tools} />}
      {awaiting.map((o) => (
        <WorkerPendingProposal key={o.id} orchestration={o} />
      ))}
      {expanded === 'journal' && <JournalList workerId={worker.id} />}
      {expanded === 'plan' && latest && <ShiftPlan orchestration={latest} />}
    </div>
  );
}

/// The planning turn, live: the row's proof that "Work now" is doing
/// something. Streams the investigation's tools and running text.
function LiveShiftStrip({ text, tools }: { text: string; tools: string[] }) {
  const tail = text.length > 220 ? `…${text.slice(-220)}` : text;
  return (
    <div className="mt-2 rounded-md border border-accent/40 bg-accent/5 px-2.5 py-2">
      <div className="flex items-center gap-2 text-[11px] text-ink">
        <span className="w-1.5 h-1.5 rounded-full bg-accent animate-pulse shrink-0" />
        <span className="font-medium">Working a shift — planning…</span>
        {tools.length > 0 && (
          <span className="text-ink-faint truncate">
            {tools.length} tool{tools.length === 1 ? '' : 's'} · latest: {tools[tools.length - 1]}
          </span>
        )}
      </div>
      {tail && (
        <div className="mt-1 text-[11px] text-ink-muted whitespace-pre-wrap break-words max-h-20 overflow-hidden">
          {tail}
        </div>
      )}
    </div>
  );
}

/// The last shift's plan: the planning turn's own prose (its reasoning about
/// what this shift's job is), then what each planned item became.
function ShiftPlan({ orchestration }: { orchestration: Orchestration }) {
  // The reply's <candidates> block is machine payload — the items below
  // render it better than raw JSON would.
  const prose = (orchestration.producer?.reply ?? '')
    .replace(/<candidates>[\s\S]*$/i, '')
    .trim();
  return (
    <div className="mt-2 border-t border-card-strong pt-2">
      <div className="flex items-baseline gap-2 mb-1.5">
        <span className="text-[11px] uppercase tracking-wider text-ink-faint">Last plan</span>
        <span className="text-[11px] text-ink-faint">
          {orchestration.title} · {new Date(orchestration.createdAt).toLocaleString()}
        </span>
      </div>
      {prose ? (
        <div className="text-xs text-ink-muted max-h-56 overflow-y-auto rounded-md bg-card-strong/30 px-3 py-2">
          <Markdown source={prose} />
        </div>
      ) : (
        <div className="text-[11px] text-ink-faint">The planning turn left no notes.</div>
      )}
      {orchestration.items.length > 0 ? (
        <div className="mt-2 space-y-1">
          {orchestration.items.map((it) => (
            <div key={it.candidate.id} className="flex items-baseline gap-2 text-[11px]">
              <span className={`shrink-0 w-16 ${PLAN_STATUS[it.status]?.cls ?? 'text-ink-faint'}`}>
                {PLAN_STATUS[it.status]?.text ?? it.status}
              </span>
              <span className="text-ink truncate">{it.candidate.title}</span>
              {it.note && <span className="text-ink-faint truncate">— {it.note}</span>}
            </div>
          ))}
        </div>
      ) : (
        <div className="mt-1 text-[11px] text-ink-faint">
          Nothing proposed — the worker judged there was nothing worth doing.
        </div>
      )}
    </div>
  );
}

const PLAN_STATUS: Record<string, { text: string; cls: string }> = {
  proposed: { text: 'proposed', cls: 'text-violet-500' },
  queued: { text: 'queued', cls: 'text-ink-muted' },
  running: { text: 'running', cls: 'text-sky-500' },
  paused: { text: 'paused', cls: 'text-amber-500' },
  done: { text: 'done', cls: 'text-emerald-500' },
  failed: { text: 'failed', cls: 'text-red-500' },
  cancelled: { text: 'rejected', cls: 'text-red-400' },
};

function ScorecardChips({ scorecard }: { scorecard: WorkerScorecard }) {
  const chips: Array<{ label: string; value: number; cls?: string }> = [
    { label: 'proposed', value: scorecard.proposed },
    { label: 'approved', value: scorecard.approved, cls: 'text-emerald-600 dark:text-emerald-400' },
    { label: 'rejected', value: scorecard.rejected, cls: 'text-red-600 dark:text-red-400' },
    { label: 'completed', value: scorecard.completed },
    { label: 'failed', value: scorecard.failed },
  ];
  return (
    <div className="mt-1 flex items-center gap-2 text-[10px] text-ink-faint">
      {chips
        .filter((c) => c.value > 0)
        .map((c) => (
          <span key={c.label}>
            <span className={`font-semibold ${c.cls ?? 'text-ink-muted'}`}>{c.value}</span>{' '}
            {c.label}
          </span>
        ))}
      {scorecard.rejectionStreak >= 2 && (
        <span className="text-amber-500">{scorecard.rejectionStreak} rejections in a row</span>
      )}
      {scorecard.costPerCompletedUSD != null && (
        <span>${scorecard.costPerCompletedUSD.toFixed(2)}/completed</span>
      )}
    </div>
  );
}

/// Promote/demote, one step at a time — the explicit act that moves trust.
/// Tooltips say exactly what changes, in numbers, so the click is informed.
function TrustControls({ worker }: { worker: Worker }) {
  const setTrust = useWorkersStore((s) => s.setTrust);
  const up: WorkerTrustLevel | null =
    worker.trust === 'probation' ? 'trusted' : worker.trust === 'trusted' ? 'autonomous' : null;
  const down: WorkerTrustLevel | null =
    worker.trust === 'autonomous' ? 'trusted' : worker.trust === 'trusted' ? 'probation' : null;
  const upCap = up ? workerAutoApproveCap({ trust: up, caps: worker.caps }) : 0;
  const downCap = down ? workerAutoApproveCap({ trust: down, caps: worker.caps }) : 0;
  return (
    <>
      {up && (
        <button
          onClick={() => void setTrust(worker.id, up)}
          title={`Promote to ${up}: its best ${upCap} proposal${upCap === 1 ? '' : 's'} per shift will launch WITHOUT waiting for your approval. The rest still park.`}
          className="text-[11px] px-2 py-0.5 rounded border border-emerald-400/40 text-emerald-600 dark:text-emerald-400 hover:bg-emerald-500/10"
        >
          Promote
        </button>
      )}
      {down && (
        <button
          onClick={() => void setTrust(worker.id, down)}
          title={
            down === 'probation'
              ? 'Demote to probation: nothing launches unattended — every proposal waits for your approval again.'
              : `Demote to ${down}: unattended launches drop to ${downCap} per shift.`
          }
          className="text-[11px] px-2 py-0.5 rounded border border-card-strong text-ink-faint hover:bg-white/5"
        >
          Demote
        </button>
      )}
    </>
  );
}

/// A worker's parked shift output, inline on its row. Per-item picking stays
/// in the Orchestrator (same reasoning as the schedules card): one approval
/// surface, deep-linked, instead of a second drifting copy.
function WorkerPendingProposal({ orchestration }: { orchestration: Orchestration }) {
  const setDetailMode = useStore((s) => s.setDetailMode);
  const setActiveOrchestration = useOrchestratorStore((s) => s.setActiveOrchestration);
  const [busy, setBusy] = useState(false);
  const proposed = orchestration.items.filter((i) => i.status === 'proposed');

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

  async function discard(): Promise<void> {
    if (busy) return;
    setBusy(true);
    try {
      await window.overcli.invoke('orchestrator:abort', { id: orchestration.id });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mt-2 rounded-md border border-violet-400/40 bg-violet-500/10 px-2.5 py-2">
      <div className="text-[12px] text-ink">
        <span className="font-semibold">{orchestration.title}</span>
        <span className="text-ink-muted">
          {' '}
          — {proposed.length} proposal{proposed.length === 1 ? '' : 's'} waiting for your review.
        </span>
      </div>
      <div className="mt-1.5 flex items-center gap-2">
        <button
          onClick={review}
          className="text-[11px] px-2 py-0.5 rounded border border-card-strong hover:bg-white/5"
        >
          Review &amp; pick →
        </button>
        <button
          disabled={busy}
          onClick={() => void launchAll()}
          className="text-[11px] px-2 py-0.5 rounded bg-accent text-white hover:opacity-90 disabled:opacity-40"
        >
          Launch all {proposed.length}
        </button>
        <button
          disabled={busy}
          onClick={() => void discard()}
          className="text-[11px] px-2 py-0.5 rounded text-ink-faint hover:text-red-400"
        >
          Reject all
        </button>
      </div>
    </div>
  );
}

// ---- Journal -------------------------------------------------------------

const KIND_LABEL: Record<WorkerJournalEntry['kind'], { text: string; cls: string }> = {
  shift: { text: 'shift', cls: 'text-ink-muted' },
  proposed: { text: 'proposed', cls: 'text-violet-500' },
  launched: { text: 'launched', cls: 'text-sky-500' },
  approved: { text: 'approved', cls: 'text-emerald-500' },
  rejected: { text: 'rejected', cls: 'text-red-500' },
  completed: { text: 'completed', cls: 'text-emerald-600' },
  failed: { text: 'failed', cls: 'text-red-600' },
  demoted: { text: 'demoted', cls: 'text-amber-600' },
};

function JournalList({ workerId }: { workerId: string }) {
  const entries = useWorkersStore((s) => s.journals[workerId]);
  const loadJournal = useWorkersStore((s) => s.loadJournal);

  useEffect(() => {
    void loadJournal(workerId);
  }, [workerId]);

  if (!entries) return <div className="mt-2 text-[11px] text-ink-faint">Loading journal…</div>;
  if (entries.length === 0) {
    return (
      <div className="mt-2 text-[11px] text-ink-faint">
        Empty journal — this worker hasn&apos;t worked a shift yet.
      </div>
    );
  }
  return (
    <div className="mt-2 border-t border-card-strong pt-2 space-y-1 max-h-64 overflow-y-auto">
      {entries.slice(0, 60).map((e) => {
        const kind = KIND_LABEL[e.kind];
        return (
          <div key={e.id} className="flex items-baseline gap-2 text-[11px]">
            <span className="text-ink-faint shrink-0 tabular-nums">
              {new Date(e.at).toLocaleDateString()}
            </span>
            <span className={`shrink-0 w-16 ${kind.cls}`}>{kind.text}</span>
            <span className="text-ink-muted truncate">{e.title || e.note || ''}</span>
            {e.title && e.note && <span className="text-ink-faint truncate">— {e.note}</span>}
          </div>
        );
      })}
    </div>
  );
}

// ---- Hire screen ---------------------------------------------------------

/// The catalog: ready-to-hire personas. Clicking one drops its full job
/// description into the textarea — a worked example of the level of detail a
/// worker plans well from, and still editable before drafting.
const PERSONA_PRESETS: Array<{
  name: string;
  group: 'code' | 'beyond';
  tagline: string;
  job: string;
}> = [
  {
    name: 'The Innovator',
    group: 'code',
    tagline: 'One genuinely new idea a day, judged against the codebase and the market.',
    job: `You're the Innovator. Once a day, study this codebase — its architecture, recent commits, TODOs, and rough edges — and think about what comparable products ship. Propose exactly ONE genuinely new improvement worth building: something that removes a step users endure, makes a manual thing ambient, or exposes data the app already has but hides. Skip anything that is merely a settings toggle or a restyle, anything already in flight, and anything your journal shows was rejected. The proposal must be buildable in one autonomous run: give it a sharp title, two sentences on why it matters, and a self-contained implementation prompt.`,
  },
  {
    name: 'The Support Triage Worker',
    group: 'code',
    tagline: 'Reads new tickets, reproduces what it can, hands off ready-to-run fixes.',
    job: `You're the Support Triage Worker. Each weekday morning, read the new support tickets and bug reports reachable from this project (use whatever MCP tools and trackers are available). For each one, try to REPRODUCE the problem against the repo and trace it to the code most likely at fault. Hand off only what you could reproduce or trace: one candidate per bug, carrying the reproduction steps, the suspect files, and a self-contained fix instruction a coding agent can act on alone. Never propose a fix for something you couldn't trace to code — say in your summary why you set it aside instead.`,
  },
  {
    name: 'The Insight Miner',
    group: 'code',
    tagline: 'Reads the product board and feedback, surfaces the loudest theme as buildable work.',
    job: `You're the Insight Miner. Twice a week, read the product feedback reachable from this project — the product board, feedback channels, and tracker labels (use your MCP tools). Cluster what's NEW since your last shift into themes and weigh them by how often they come up and how much pain they describe. Propose up to three concrete, buildable items that would address the loudest theme, each citing the specific feedback it came from and carrying a self-contained implementation prompt. Never re-propose a theme your journal shows was rejected — find the next one down. If nothing new reached a threshold worth acting on, say so and propose nothing.`,
  },
  {
    name: 'The Docs Gardener',
    group: 'code',
    tagline: 'Finds where the docs drifted from the code this week and proposes fixes.',
    job: `You're the Docs Gardener. Every Friday afternoon, compare the documentation — README, docs folders, and comments that describe behavior — against what actually changed in the code this week. Find the places where the docs now lie: renamed commands, changed defaults, removed flags, new features nobody wrote up. Propose one candidate per drifted document, quoting the stale text and stating what is true now, with a self-contained instruction to fix it. Chase factual drift only — never style, tone, or formatting.`,
  },
  {
    name: 'The Test Warden',
    group: 'code',
    tagline: 'Hunts risky recent changes that landed without tests.',
    job: `You're the Test Warden. Twice a week, look at what changed in this repo recently and find the riskiest changes that landed WITHOUT tests: bug fixes with no regression test, new branches nothing covers, error paths that would fail silently. Propose up to three candidates, each naming the file, the behavior at risk, and a self-contained instruction to write the missing test in this repo's existing test style — match its frameworks, fixtures, and naming exactly. Skip code that is trivially unlikely to break and anything your journal shows was already covered or rejected.`,
  },
  {
    name: 'The Dependency Steward',
    group: 'code',
    tagline: 'Weekly dependency review — advisories first, changelogs actually read.',
    job: `You're the Dependency Steward. Once a week, review this project's dependencies for updates that matter: security advisories first, then majors with breaking changes worth planning for, then safe minor bumps. READ the changelogs — never propose a bump whose release notes you haven't read. Propose at most three candidates: each names the package, the from→to versions, why now, what in this repo touches it, and a self-contained instruction to do the update and prove the tests still pass. Skip cosmetic version churn entirely.`,
  },
  {
    name: 'The Bug Sweeper',
    group: 'code',
    tagline: 'Hunts latent bugs nobody filed — flaky tests, swallowed errors, edge cases.',
    job: `You're the Bug Sweeper. Every other day, hunt for latent bugs nobody has filed: flaky or failing tests, TODO/FIXME comments marking real defects, error paths that swallow exceptions, and recent changes with suspicious edge cases. Verify each suspect by READING the code — propose only what you can argue concretely is wrong, with the file, the exact failure scenario, and a self-contained fix instruction. Quality over quantity: an honest empty shift beats a speculative finding, and anything your journal shows was rejected stays gone.`,
  },
  {
    name: 'The Security Sentry',
    group: 'code',
    tagline: 'Weekly sweep for real, exploitable security debt — not scanner noise.',
    job: `You're the Security Sentry. Once a week, sweep this repo for security debt: dependencies with known advisories, secrets or tokens committed by mistake, permissive auth or CORS defaults, and input paths that skip validation. Rank findings by real exploitability in THIS codebase, not by scanner severity labels. Propose at most two candidates per shift, each with the concrete evidence, the risk in one sentence, and a self-contained remediation instruction. If the sweep is clean, say so — a quiet shift from you is good news, not a failure.`,
  },
  {
    name: 'The Personal Assistant',
    group: 'beyond',
    tagline: 'Plans your day each morning — meeting prep, stale threads, drafted replies.',
    job: `You're the Personal Assistant. Every weekday morning, look across what's reachable from your tools — calendar, mail, and messages — and plan the day's paperwork: meetings that need prep or an agenda, threads that have waited more than a day for a reply, commitments made in writing with no follow-up yet. Propose up to three items, each a concrete deliverable you can draft (an agenda, a reply, a follow-up note) with everything needed to draft it carried in the prompt. Never send anything yourself — every draft parks for approval — and skip anything your journal shows was already handled or declined.`,
  },
  {
    name: 'The Note Aggregator',
    group: 'beyond',
    tagline: 'Merges the notes that piled up into tidy, cited summaries.',
    job: `You're the Note Aggregator. Each evening, read what's new in this folder since your last shift — meeting notes, scratch files, exports. Cluster the new material by topic, and where one topic is scattered across several notes, propose ONE consolidation: a tidy summary document that merges them, keeps every decision and open question, and cites which notes it drew from. Never delete or rewrite the originals — you propose new summary documents only. If nothing meaningful accumulated, say so and propose nothing.`,
  },
  {
    name: 'The Study Coach',
    group: 'beyond',
    tagline: "Turns this week's course material into summaries, questions, and gap flags.",
    job: `You're the Study Coach. Three evenings a week, read the course materials and notes in this folder and find what was added or changed this week. Propose up to three study aids for the newest material: a one-page plain-language summary, a set of practice questions with answers, or a flash-card list of terms that appeared for the first time. Separately, flag any topic the syllabus lists that the notes never cover — that gap is worth a proposal of its own. Match the course's terminology exactly, and never invent facts that aren't in the materials.`,
  },
  {
    name: 'The Customer Success Scout',
    group: 'beyond',
    tagline: 'Finds accounts going quiet and drafts the check-in, evidence attached.',
    job: `You're the Customer Success Scout. Each weekday morning, review the customer activity reachable from your tools — tickets, shared channels, CRM notes. Find the accounts that need a human touch: threads that went quiet after a complaint, questions nobody answered, renewals approaching with no recent contact. Propose up to three check-ins, each naming the account, quoting the evidence, and carrying a drafted message ready to review. Never contact anyone directly — drafts only — and never re-propose an account your journal shows was declined recently.`,
  },
  {
    name: 'The Ops Coordinator',
    group: 'beyond',
    tagline: 'Sweeps runbooks and checklists for drift from how things actually run.',
    job: `You're the Ops Coordinator. Once a week, sweep the operational documents in this folder and the trackers reachable through your tools — runbooks, checklists, process docs. Find the drift: steps that no longer match how things are actually done, recurring tasks with no owner, checklists that quietly stopped being filled in. Propose one fix per finding: what's stale, the evidence, and a self-contained instruction to update the document or file the task. Chase process drift only — never propose reorganizing things that demonstrably work.`,
  },
];

const CATALOG_GROUPS: Array<{ key: 'code' | 'beyond'; label: string; hint: string }> = [
  {
    key: 'code',
    label: 'For the codebase',
    hint: 'click one to load its job description — then edit it to fit your project',
  },
  {
    key: 'beyond',
    label: 'Beyond code — assistants, students, success, ops',
    hint: 'these lean on your connected tools, and any folder is a fine project — a notes vault, a course, a runbook directory',
  },
];

/// The lifecycle, as five numbered stages in equal-width cards: wake → plan
/// → propose → launch → learn. Derived from real values where the caller has
/// them (the editor), generic where it doesn't (the hire page). Five cards in
/// a grid instead of eight wrapping pills: the sequence reads left-to-right
/// in one pass, and each stage has room for its one sentence of detail.
function WorkerLifecycle(props: {
  cadence?: ScheduleTrigger;
  heartbeatModel?: string;
  maxItemsPerShift?: number;
  trust?: WorkerTrustLevel;
  caps?: Worker['caps'];
  flowName?: string;
  budgetUSDPerMonth?: number;
}) {
  const cap =
    props.trust && props.caps ? workerAutoApproveCap({ trust: props.trust, caps: props.caps }) : 0;
  const flow = props.flowName ? `“${props.flowName}”` : 'its flow';
  const n = props.maxItemsPerShift;
  const stages: Array<{ title: string; detail: string }> = [
    {
      title: 'Wakes',
      detail: props.cadence
        ? describeTrigger(props.cadence)
        : 'On its cadence, while overcli is open.',
    },
    {
      title: 'Plans',
      detail: `Reads its journal and the repo, then decides this shift's work on ${
        props.heartbeatModel?.trim() || 'a cheap heartbeat model'
      }.`,
    },
    {
      title: 'Proposes',
      detail: `Up to ${n ?? 'a few'} small candidate${n === 1 ? '' : 's'} — anything you rejected before is filtered out.`,
    },
    {
      title: 'Launches',
      detail:
        cap > 0
          ? `Its best ${cap} run ${flow} unattended; the rest park for your approval.`
          : `Everything parks for your approval; each approved item runs ${flow} in a worktree.`,
    },
    {
      title: 'Learns',
      detail: `Your verdicts land in its journal${
        props.budgetUSDPerMonth
          ? `, and it stops at $${props.budgetUSDPerMonth}/month`
          : ', and it stops when its monthly budget is spent'
      }.`,
    },
  ];
  return (
    <div className="rounded-xl bg-card p-4 shadow-sm">
      <div className="text-[11px] uppercase tracking-wider text-ink-faint mb-2">
        A shift, start to finish
      </div>
      <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-5 gap-2">
        {stages.map((s, i) => (
          <div key={s.title} className="rounded-lg border border-card-strong p-3">
            <div className="flex items-center gap-2 mb-1">
              <span className="w-5 h-5 rounded-[4px] bg-accent/15 text-accent text-[10px] font-semibold flex items-center justify-center shrink-0">
                {i + 1}
              </span>
              <span className="text-xs font-medium text-ink">{s.title}</span>
              {i < stages.length - 1 && <LifecycleArrow />}
            </div>
            <div className="text-[11px] text-ink-muted leading-relaxed">{s.detail}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

function LifecycleArrow() {
  return (
    <svg
      width="16"
      height="12"
      viewBox="0 0 20 14"
      className="text-ink-faint flex-shrink-0 ml-auto"
    >
      <path d="M2 7 H16" stroke="currentColor" strokeWidth="1.4" />
      <path d="M14 3 L18 7 L14 11" stroke="currentColor" strokeWidth="1.4" fill="none" />
    </svg>
  );
}

function HireWorker({
  defaultProjectPath,
  onClose,
}: {
  defaultProjectPath: string;
  onClose: () => void;
}) {
  const openEditor = useWorkersStore((s) => s.openEditor);
  const projects = useStore((s) => s.projects);
  const workspaces = useStore((s) => s.workspaces);
  const [jobDescription, setJobDescription] = useState('');
  const [projectPath, setProjectPath] = useState(defaultProjectPath);
  // Whether the user picked the project themselves. An explicit choice beats
  // the drafter's suggestion; the untouched default loses to it.
  const [projectTouched, setProjectTouched] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const targets = [
    ...workspaces.map((w) => ({ name: `${w.name} (workspace)`, path: w.rootPath })),
    ...projects.map((p) => ({ name: p.name, path: p.path })),
  ];

  // Highlight the card whose job description is (still) in the textarea, so
  // editing the text visibly turns a preset into "your own".
  const selectedPreset = PERSONA_PRESETS.find((p) => p.job === jobDescription.trim())?.name;

  async function handleDraft(): Promise<void> {
    if (!jobDescription.trim()) {
      setError('Describe the job first — the worker plans every shift from it.');
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const result = await window.overcli.invoke('workers:draftFromPrompt', { jobDescription });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      // The drafter may recognize which project the job is about; honor that
      // only when the user left the picker on its default.
      const chosenPath = projectTouched
        ? projectPath
        : (result.contract.projectPath ?? projectPath);
      openEditor(draftFromContract(result.contract, chosenPath, result.contract.flowId), {
        draftedFlow: result.draftedFlow,
        hireSummary: result.summary || undefined,
      });
      onClose();
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="flex-1 overflow-y-auto p-6">
      <div className="flex items-center gap-3 mb-1">
        <button
          onClick={onClose}
          className="text-xs text-ink-faint hover:text-ink px-2 py-1 rounded hover:bg-white/5"
        >
          ← Workers
        </button>
        <div className="text-2xl font-semibold">Hire a worker</div>
      </div>
      <div className="text-xs text-ink-muted mb-5 ml-1">
        One drafting turn turns a job description into the whole standing configuration —
        persona, cadence, caps, budget, and the flow it runs. You review everything before
        anything is saved.
      </div>

      <div className="space-y-5">
        {/* What am I actually hiring? The lifecycle, before any form. */}
        <WorkerLifecycle />

        {CATALOG_GROUPS.map((group) => (
          <div key={group.key}>
            <div className="flex items-baseline gap-2 mb-2">
              <span className="text-[11px] uppercase tracking-wider text-ink-faint">
                {group.label}
              </span>
              <span className="text-[11px] text-ink-faint normal-case">{group.hint}</span>
            </div>
            <div className="grid grid-cols-2 xl:grid-cols-4 gap-2">
              {PERSONA_PRESETS.filter((p) => p.group === group.key).map((p) => {
                const selected = selectedPreset === p.name;
                return (
                  <button
                    key={p.name}
                    onClick={() => {
                      setJobDescription(p.job);
                      setError(null);
                    }}
                    className={
                      'text-left rounded-lg border p-3 transition-colors ' +
                      (selected
                        ? 'border-accent bg-accent/10'
                        : 'border-card-strong hover:bg-white/5')
                    }
                  >
                    <div className="flex items-center gap-2 mb-1">
                      {/* Same monogram idiom as flows everywhere else — the
                          app's icon language is a letter in a tinted square,
                          not emoji. */}
                      <FlowMonogram name={p.name.replace(/^The /, '')} size="md" />
                      <span className="text-sm font-medium text-ink">{p.name}</span>
                    </div>
                    <div className="text-[11px] text-ink-muted leading-relaxed">{p.tagline}</div>
                  </button>
                );
              })}
            </div>
          </div>
        ))}

        {/* Same 1fr + rail grid as the editors: the form keeps a readable
            measure and the rail absorbs the slack, so nothing hangs against
            the full-width catalog above. */}
        <div className="grid grid-cols-[1fr_minmax(280px,360px)] gap-6 items-start">
          <div className="min-w-0 rounded-xl bg-card p-5 shadow-sm space-y-5">
            <Field
              label="Works against"
              hint="the drafter can override this when the job clearly names another project"
            >
              <select
                value={projectPath}
                onChange={(e) => {
                  setProjectPath(e.target.value);
                  setProjectTouched(true);
                }}
                className="w-full max-w-[360px] bg-card border border-card-strong rounded px-2 py-1.5 text-sm text-ink"
              >
                {targets.map((t) => (
                  <option key={t.path} value={t.path}>
                    {t.name}
                  </option>
                ))}
              </select>
            </Field>

            <div>
              <div className="flex items-baseline gap-2 mb-2">
                <span className="text-[11px] uppercase tracking-wider text-ink-faint">
                  The job description
                </span>
                <span className="text-[11px] text-ink-faint normal-case">
                  pick from the catalog, or write your own — the worker plans every shift from
                  exactly this text
                </span>
              </div>
              <textarea
                rows={9}
                value={jobDescription}
                onChange={(e) => {
                  setJobDescription(e.target.value);
                  setError(null);
                }}
                placeholder={`You're the …\n\nSay what it should look at, how often, what a good proposal looks like, and what it must never do.`}
                className="w-full bg-card border border-card-strong rounded p-3 text-sm text-ink leading-relaxed"
              />
            </div>

            {error && (
              <div className="text-sm text-red-700 dark:text-red-300 bg-red-500/15 border border-red-400/40 rounded px-3 py-2">
                {error}
              </div>
            )}

            <div className="flex items-center gap-3 border-t border-card-strong pt-4">
              <span className="text-[11px] text-ink-faint">
                You&apos;ll land in the editor with the drafted contract — nothing is saved until
                you click Hire there.
              </span>
              <button
                disabled={loading || !jobDescription.trim()}
                onClick={() => void handleDraft()}
                className="ml-auto shrink-0 text-xs px-4 py-2 rounded-md bg-accent text-white hover:opacity-90 disabled:opacity-40"
              >
                {loading ? 'Drafting the contract…' : '✨ Draft the contract'}
              </button>
            </div>
            {loading && (
              <WorkingStrip message="Drafting — one turn writes the contract (persona, cadence, caps, budget); if no existing flow fits, a second turn drafts the flow too. Usually under two minutes." />
            )}
          </div>

          <div className="space-y-3">
            <div className="rounded-lg border border-card-strong p-4">
              <div className="text-[11px] uppercase tracking-wider text-ink-faint mb-1.5">
                What drafting produces
              </div>
              <div className="text-[11px] text-ink-faint leading-relaxed">
                One turn of your preferred CLI returns the full contract for review:
              </div>
              <ul className="mt-1.5 space-y-1 text-[11px] text-ink-muted list-disc pl-4">
                <li>the persona, with the job description refined to stand alone</li>
                <li>a cadence that fits the job (no 3am shifts for morning work)</li>
                <li>items-per-shift cap and a monthly budget</li>
                <li>a cheap heartbeat model for the planning turns</li>
                <li>the flow launched items run — an existing one, or drafted fresh</li>
              </ul>
            </div>
            <div className="rounded-lg border border-card-strong p-4">
              <div className="text-[11px] uppercase tracking-wider text-ink-faint mb-1.5">
                Probation first
              </div>
              <div className="text-[11px] text-ink-faint leading-relaxed">
                Every hire starts on <span className="text-amber-500">probation</span> — nothing
                runs unattended until you promote it, and rejected proposals never come back.
                Promote from the roster once its scorecard has earned it.
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

// ---- Editor --------------------------------------------------------------

function WorkerEditor() {
  const draft = useWorkersStore((s) => s.draft)!;
  const draftedFlow = useWorkersStore((s) => s.draftedFlow);
  const hireSummary = useWorkersStore((s) => s.hireSummary);
  const busy = useWorkersStore((s) => s.busy);
  const error = useWorkersStore((s) => s.error);
  const patch = useWorkersStore((s) => s.patchDraft);
  const save = useWorkersStore((s) => s.save);
  const close = useWorkersStore((s) => s.closeEditor);

  const projects = useStore((s) => s.projects);
  const workspaces = useStore((s) => s.workspaces);
  const flows = useFlowsStore((s) => s.flows);
  const workers = useWorkersStore((s) => s.workers);
  const existing = draft.id ? workers[draft.id] : undefined;

  // Trust isn't editable here (hires start on probation; promotion is a
  // roster action), but validation needs it to judge the cwd rule.
  const problem = validateWorker({
    ...draft,
    trust: existing?.trust ?? 'probation',
    flowIds: draft.flowIds.length > 0 ? draft.flowIds : draftedFlow ? [draftedFlow.id] : [],
    createdAt: 0,
    id: draft.id ?? 'draft',
  });

  const targets = [
    ...workspaces.map((w) => ({ name: `${w.name} (workspace)`, path: w.rootPath })),
    ...projects.map((p) => ({ name: p.name, path: p.path })),
  ];

  // Trust never overrides the flow's own checkpoints: a `pause_before` step
  // parks the run for review even under an autonomous worker. Say so here,
  // where trust and flow are both on screen — not at 8am via a stuck run.
  const selectedFlow =
    draftedFlow && (draft.flowIds.length === 0 || draft.flowIds[0] === draftedFlow.id)
      ? draftedFlow
      : flows.find((f) => f.id === draft.flowIds[0]);
  const pauseSteps = selectedFlow?.steps.filter((s) => s.pauseBefore).length ?? 0;

  return (
    <div className="flex-1 overflow-y-auto p-6">
      <div className="flex items-center gap-3 mb-4">
        <button
          onClick={close}
          className="text-xs text-ink-faint hover:text-ink px-2 py-1 rounded hover:bg-white/5"
        >
          ← Workers
        </button>
        <div className="text-2xl font-semibold">
          {draft.id ? `Edit ${draft.name || 'worker'}` : 'Review the contract'}
        </div>
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
            {busy ? 'Saving…' : draft.id ? 'Save changes' : 'Hire'}
          </button>
        </div>
      </div>

      {/* Same two-column body as the flow and schedule editors: the 1fr main
          column keeps a readable measure, the rail absorbs the slack —
          left-aligned width control without centering anything. */}
      <div className="grid grid-cols-[1fr_minmax(280px,360px)] gap-6 items-start">
        <div className="min-w-0 space-y-4">
          {/* First, like the flow editor's AI row: editing-by-instruction is
              the front door, the form below is the fine adjustment. */}
          <WorkerAiRevise />
          {/* Derived, never stored — every pill is a projection of the form
              below, so "what will this worker do" can't drift from the truth. */}
          <WorkerLifecycle
            cadence={draft.cadence}
            heartbeatModel={draft.heartbeatModel}
            maxItemsPerShift={draft.caps.maxItemsPerShift}
            trust={existing?.trust ?? 'probation'}
            caps={draft.caps}
            budgetUSDPerMonth={draft.budgetUSDPerMonth}
            flowName={
              draftedFlow && draft.flowIds.length === 0
                ? draftedFlow.name
                : flows.find((f) => f.id === draft.flowIds[0])?.name
            }
          />
          {hireSummary && (
            <div className="rounded-lg border border-card-strong bg-card px-4 py-3 text-xs text-ink-muted">
              <div className="text-[11px] uppercase tracking-wider text-ink-faint mb-1.5">
                The drafter&apos;s read on the job
              </div>
              <Markdown source={hireSummary} />
            </div>
          )}
          <div className="rounded-xl bg-card p-5 shadow-sm space-y-5">
            <Field label="Name" hint="the persona, not the task">
              <input
                value={draft.name}
                onChange={(e) => patch({ name: e.target.value })}
                placeholder="Scout"
                className="w-full bg-card border border-card-strong rounded px-2 py-1.5 text-sm text-ink"
              />
            </Field>
            <Field
              label="Job description"
              hint="the worker plans every shift from ONLY this text plus its journal"
            >
              <textarea
                rows={5}
                value={draft.jobDescription}
                onChange={(e) => patch({ jobDescription: e.target.value })}
                className="w-full bg-card border border-card-strong rounded p-3 text-sm text-ink"
              />
            </Field>
          </div>

          <div className="rounded-xl bg-card p-5 shadow-sm space-y-5">
            <CadenceField
              cadence={draft.cadence}
              onChange={(cadence) => patch({ cadence })}
            />
          </div>

          <div className="rounded-xl bg-card p-5 shadow-sm space-y-5">
            <Field label="Project">
              <select
                value={draft.projectPath}
                onChange={(e) => patch({ projectPath: e.target.value })}
                className="w-full bg-card border border-card-strong rounded px-2 py-1.5 text-sm text-ink"
              >
                <option value="">Pick a project…</option>
                {targets.map((t) => (
                  <option key={t.path} value={t.path}>
                    {t.name}
                  </option>
                ))}
              </select>
            </Field>

            <Field
              label="Flow for launched items"
              hint="each approved proposal becomes one run of this flow"
            >
              {draftedFlow && draft.flowIds.length === 0 ? (
                <div className="text-sm text-ink rounded border border-emerald-400/40 bg-emerald-500/10 px-3 py-2">
                  New flow <span className="font-medium">{draftedFlow.name}</span> — drafted for
                  this worker, saved with the hire.
                </div>
              ) : (
                <>
                  <select
                    value={draft.flowIds[0] ?? ''}
                    onChange={(e) => patch({ flowIds: e.target.value ? [e.target.value] : [] })}
                    className="w-full bg-card border border-card-strong rounded px-2 py-1.5 text-sm text-ink"
                  >
                    <option value="">Pick a flow…</option>
                    {flows.filter((f) => !f.archived).map((f) => (
                      <option key={f.id} value={f.id}>
                        {f.name}
                      </option>
                    ))}
                  </select>
                  {draftedFlow && draft.flowIds[0] === draftedFlow.id && (
                    <div className="mt-1.5 text-[11px] text-emerald-600 dark:text-emerald-400">
                      “{draftedFlow.name}” has unsaved AI changes — they save with this worker.
                    </div>
                  )}
                </>
              )}
              {pauseSteps > 0 && (
                <div className="mt-1.5 text-[11px] text-amber-600 dark:text-amber-400">
                  This flow pauses at {pauseSteps === 1 ? 'one step' : `${pauseSteps} steps`} for
                  your review — runs wait there even for an autonomous worker. Use the AI box
                  above (&ldquo;remove the pause before…&rdquo;) if this worker should ship
                  unattended.
                </div>
              )}
            </Field>

            <div className="grid grid-cols-3 gap-4">
              <Field label="Items per shift" hint={`max ${WORKER_MAX_ITEMS_PER_SHIFT}`}>
                <input
                  type="number"
                  min={1}
                  max={WORKER_MAX_ITEMS_PER_SHIFT}
                  value={draft.caps.maxItemsPerShift}
                  onChange={(e) =>
                    patch({
                      caps: { ...draft.caps, maxItemsPerShift: Math.floor(Number(e.target.value)) },
                    })
                  }
                  className="w-full bg-card border border-card-strong rounded px-2 py-1.5 text-sm text-ink"
                />
              </Field>
              <Field label="Budget / month" hint="shifts stop when it's spent">
                <div className="flex items-center gap-1">
                  <span className="text-sm text-ink-muted">$</span>
                  <input
                    type="number"
                    min={1}
                    value={draft.budgetUSDPerMonth}
                    onChange={(e) => patch({ budgetUSDPerMonth: Number(e.target.value) })}
                    className="w-full bg-card border border-card-strong rounded px-2 py-1.5 text-sm text-ink"
                  />
                </div>
              </Field>
              <Field label="Heartbeat model" hint="plans shifts; keep it cheap">
                <input
                  value={draft.heartbeatModel}
                  onChange={(e) => patch({ heartbeatModel: e.target.value })}
                  placeholder="model id"
                  className="w-full bg-card border border-card-strong rounded px-2 py-1.5 text-sm text-ink"
                />
              </Field>
            </div>

            <div className="text-[11px] text-ink-faint">
              {existing
                ? `Trust: ${existing.trust} — change it from the roster with Promote/Demote.`
                : 'Hired on probation: every proposal parks for your approval, and rejected ones are never re-proposed. Promote from the roster once it has earned it.'}
            </div>
          </div>

          {(problem || error) && (
            <div className="text-sm text-red-700 dark:text-red-300 bg-red-500/15 border border-red-400/40 rounded px-3 py-2">
              {error ?? problem}
            </div>
          )}
        </div>

        <WorkerHelpRail trust={existing?.trust ?? 'probation'} caps={draft.caps} />
      </div>
    </div>
  );
}

/// The editor's right rail: what the knobs mean, and — since Promote/Demote
/// live on the roster — what each trust level actually permits.
function WorkerHelpRail({
  trust,
  caps,
}: {
  trust: WorkerTrustLevel;
  caps: Worker['caps'];
}) {
  const trustedCap = workerAutoApproveCap({ trust: 'trusted', caps });
  const autonomousCap = workerAutoApproveCap({ trust: 'autonomous', caps });
  const levels: Array<{ level: WorkerTrustLevel; what: string }> = [
    { level: 'probation', what: 'Every proposal parks and waits for your approval. Nothing runs unattended.' },
    { level: 'trusted', what: `Its best ${trustedCap} proposal${trustedCap === 1 ? '' : 's'} per shift launch on their own; the rest still park.` },
    { level: 'autonomous', what: `Up to ${autonomousCap} launch per shift unattended, and it may earn the working copy.` },
  ];
  return (
    <div className="space-y-3 sticky top-0">
      <div className="rounded-lg border border-card-strong p-4">
        <div className="text-[11px] uppercase tracking-wider text-ink-faint mb-2">
          How trust works
        </div>
        <div className="space-y-2.5">
          {levels.map((l) => (
            <div key={l.level} className="text-xs">
              <span
                className={'font-medium ' + (l.level === trust ? 'text-ink' : 'text-ink-muted')}
              >
                {l.level}
                {l.level === trust ? ' — current' : ''}
              </span>
              <div className="text-ink-faint leading-relaxed">{l.what}</div>
            </div>
          ))}
        </div>
        <div className="mt-2.5 text-[11px] text-ink-faint leading-relaxed">
          Promote and demote from the roster. Three rejections in a row demote it automatically.
        </div>
      </div>
      <div className="rounded-lg border border-card-strong p-4">
        <div className="text-[11px] uppercase tracking-wider text-ink-faint mb-1.5">
          The journal
        </div>
        <div className="text-[11px] text-ink-faint leading-relaxed">
          Every proposal and your verdict on it is remembered. The next shift plans against that
          memory — a rejected idea is filtered out even if the model suggests it again.
        </div>
      </div>
      <div className="rounded-lg border border-card-strong p-4">
        <div className="text-[11px] uppercase tracking-wider text-ink-faint mb-1.5">
          The budget
        </div>
        <div className="text-[11px] text-ink-faint leading-relaxed">
          Run costs roll up against the monthly budget; when it&apos;s spent the worker idles until
          the month turns. The heartbeat model only plans shifts — keep it cheap and the idle cost
          is pennies.
        </div>
      </div>
    </div>
  );
}

/// Feedback for the long drafting turns (hire, revise): a greyed button
/// alone reads as "stuck" by second 20. Pulsing dot, honest copy about what
/// is actually running, and an elapsed counter so time visibly passes.
function WorkingStrip({ message }: { message: string }) {
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    const started = Date.now();
    const t = setInterval(() => setElapsed(Math.floor((Date.now() - started) / 1000)), 1000);
    return () => clearInterval(t);
  }, []);
  return (
    <div className="mt-2 flex items-center gap-2 rounded-md border border-accent/40 bg-accent/5 px-3 py-2 text-[11px]">
      <span className="w-1.5 h-1.5 rounded-full bg-accent animate-pulse shrink-0" />
      <span className="text-ink-muted">{message}</span>
      <span className="ml-auto text-ink-faint tabular-nums shrink-0">{elapsed}s</span>
    </div>
  );
}

const REVISE_EXAMPLES = [
  'File a ticket in our tracker for each fix',
  'Also post a summary to Slack when done',
  'Work twice a day instead',
  'Remove the pause so it ships unattended',
];

/// One instruction, routed across the worker's two halves: the job
/// description (what it plans) and its flow (how approved items execute).
/// "File a ticket for each fix" lands in BOTH — the flow gains the ticket
/// step, the job description starts carrying what that step needs. Nothing
/// is saved here: changes land on the draft, and only Save commits them
/// (the revised flow included).
///
/// Same collapsed-row idiom as FlowAiEdit — one input-height at rest so it
/// never outweighs the contract it edits, expanding only while in use.
function WorkerAiRevise() {
  const draft = useWorkersStore((s) => s.draft);
  const draftedFlow = useWorkersStore((s) => s.draftedFlow);
  const applyRevision = useWorkersStore((s) => s.applyRevision);
  const [instruction, setInstruction] = useState('');
  const [busy, setBusy] = useState(false);
  const [focused, setFocused] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const expanded = focused || instruction.length > 0;

  if (!draft) return null;

  async function handleRevise(): Promise<void> {
    if (!draft || busy) return;
    const text = instruction.trim();
    if (!text) return;
    setBusy(true);
    setError(null);
    try {
      // A ride-along flow (hire-drafted or already revised) is unsaved —
      // main can't load it by id, so ship the object; it's also the freshest
      // state when the flow was revised before. But only when it's still the
      // SELECTED flow — after a manual re-pick, the saved pick wins.
      const rideAlong =
        draftedFlow && (draft.flowIds.length === 0 || draft.flowIds[0] === draftedFlow.id)
          ? draftedFlow
          : undefined;
      const res = await window.overcli.invoke('workers:reviseFromPrompt', {
        jobDescription: draft.jobDescription,
        flow: rideAlong,
        flowId: rideAlong ? undefined : draft.flowIds[0],
        instruction: text,
      });
      if (!res.ok) {
        setError(res.error);
        return;
      }
      applyRevision({ jobDescription: res.jobDescription, flow: res.flow });
      setNote(res.note);
      setInstruction('');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <div className="flex items-start gap-2 rounded-lg border border-card bg-card px-3 py-1.5 focus-within:border-card-strong transition-colors">
        <span className="text-xs text-ink-faint select-none leading-6" aria-hidden>
          ✨
        </span>
        <textarea
          value={instruction}
          onChange={(e) => {
            setInstruction(e.target.value);
            setError(null);
          }}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          onKeyDown={(e) => {
            // ⌘/Ctrl+Enter submits — Enter alone stays a newline so a
            // multi-sentence instruction doesn't fire off half-written.
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              void handleRevise();
            }
          }}
          rows={1}
          disabled={busy}
          style={{ fieldSizing: 'content', maxHeight: 160 } as React.CSSProperties}
          placeholder="Change this worker with AI — the change lands on the job description, the flow, or both…"
          className="flex-1 bg-transparent text-sm text-ink placeholder:text-ink-faint focus:outline-none resize-none leading-6 disabled:opacity-60"
        />
        {(busy || instruction.trim()) && (
          <button
            onClick={() => void handleRevise()}
            disabled={busy || !instruction.trim()}
            className="text-xs px-2.5 py-1 rounded-md bg-accent text-white hover:opacity-90 disabled:opacity-50 whitespace-nowrap self-center"
            title="⌘↵"
          >
            {busy ? 'Revising…' : 'Apply'}
          </button>
        )}
      </div>

      {expanded && !busy && (
        <div className="flex flex-wrap items-center gap-1.5 mt-1.5 px-1">
          {!instruction &&
            REVISE_EXAMPLES.map((ex) => (
              <button
                key={ex}
                // Blur fires before click, and blur collapses this row — so
                // claim the press before the row can disappear under it.
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => setInstruction(ex)}
                className="text-[11px] px-2 py-0.5 rounded-full border border-card text-ink-faint hover:text-ink hover:bg-card-strong"
              >
                {ex}
              </button>
            ))}
          <span className="ml-auto text-[10px] text-ink-faint">
            ⌘↵ to apply · you review before saving
          </span>
        </div>
      )}

      {busy && (
        <WorkingStrip message="Revising — one drafting turn decides what changes (job description, flow, or both); a flow change runs a second pass through the flow editor. Usually under two minutes." />
      )}

      {error && (
        <div className="text-xs text-red-700 dark:text-red-300 bg-red-500/10 border border-red-500/20 rounded p-2.5 mt-2">
          {error}
        </div>
      )}

      {note && (
        <div className="flex items-start gap-2 text-xs text-emerald-800 dark:text-emerald-200 bg-emerald-500/10 border border-emerald-500/20 rounded p-2 mt-2">
          <div className="min-w-0 flex-1 whitespace-pre-wrap">
            {note}
            {'\n'}Nothing is saved until you hit Save.
          </div>
          <button
            onClick={() => setNote(null)}
            aria-label="Dismiss"
            className="opacity-60 hover:opacity-100 leading-none"
          >
            ×
          </button>
        </div>
      )}
    </div>
  );
}

// ---- Cadence picker ------------------------------------------------------

function CadenceField({
  cadence,
  onChange,
}: {
  cadence: ScheduleTrigger;
  onChange: (t: ScheduleTrigger) => void;
}) {
  return (
    <div className="space-y-4">
      <Field label="Shift cadence">
        <div className="flex gap-2">
          <Segment
            active={cadence.kind === 'daily'}
            onClick={() =>
              cadence.kind !== 'daily' &&
              onChange({ kind: 'daily', time: '09:00', days: cadence.days })
            }
          >
            At a time of day
          </Segment>
          <Segment
            active={cadence.kind === 'interval'}
            onClick={() =>
              cadence.kind !== 'interval' &&
              onChange({ kind: 'interval', everyMinutes: 120, days: cadence.days })
            }
          >
            Every N minutes
          </Segment>
        </div>
      </Field>

      {cadence.kind === 'daily' ? (
        <Field label="Time" hint="24h local">
          <input
            value={cadence.time}
            onChange={(e) => onChange({ ...cadence, time: e.target.value })}
            placeholder="09:00"
            className="w-28 bg-card border border-card-strong rounded px-2 py-1.5 text-sm text-ink"
          />
        </Field>
      ) : (
        <div className="grid grid-cols-3 gap-4">
          <Field label="Every" hint={`min ${WORKER_MIN_INTERVAL_MINUTES} minutes`}>
            <div className="flex items-center gap-1.5">
              <input
                type="number"
                min={WORKER_MIN_INTERVAL_MINUTES}
                value={cadence.everyMinutes}
                onChange={(e) =>
                  onChange({ ...cadence, everyMinutes: Math.floor(Number(e.target.value)) })
                }
                className="w-24 bg-card border border-card-strong rounded px-2 py-1.5 text-sm text-ink"
              />
              <span className="text-xs text-ink-muted">minutes</span>
            </div>
          </Field>
          <Field label="Active from" hint="optional">
            <input
              value={cadence.window?.start ?? ''}
              placeholder="08:00"
              onChange={(e) => {
                const start = e.target.value;
                onChange({
                  ...cadence,
                  window: start
                    ? { start, end: cadence.window?.end ?? '18:00' }
                    : undefined,
                });
              }}
              className="w-24 bg-card border border-card-strong rounded px-2 py-1.5 text-sm text-ink"
            />
          </Field>
          <Field label="Until">
            <input
              value={cadence.window?.end ?? ''}
              placeholder="18:00"
              disabled={!cadence.window}
              onChange={(e) =>
                cadence.window &&
                onChange({ ...cadence, window: { ...cadence.window, end: e.target.value } })
              }
              className="w-24 bg-card border border-card-strong rounded px-2 py-1.5 text-sm text-ink disabled:opacity-40"
            />
          </Field>
        </div>
      )}

      <Field label="Days" hint="none selected = every day">
        <DayPicker days={cadence.days} onChange={(days) => onChange({ ...cadence, days })} />
      </Field>
    </div>
  );
}

const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function DayPicker({
  days,
  onChange,
}: {
  days?: number[];
  onChange: (days: number[] | undefined) => void;
}) {
  const selected = new Set(days ?? []);
  return (
    <div className="flex gap-1">
      {DAY_NAMES.map((name, i) => {
        const on = selected.has(i);
        return (
          <button
            key={name}
            onClick={() => {
              const next = new Set(selected);
              if (on) next.delete(i);
              else next.add(i);
              const arr = [...next].sort((a, b) => a - b);
              onChange(arr.length === 0 || arr.length === 7 ? undefined : arr);
            }}
            className={
              'px-2 py-1 rounded text-[11px] ' +
              (on
                ? 'bg-accent text-white'
                : 'border border-card-strong text-ink-muted hover:bg-white/5')
            }
          >
            {name}
          </button>
        );
      })}
    </div>
  );
}

// ---- Local primitives (same shapes as SchedulesPane's) -------------------

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

/// "5m ago" / "2h ago" / "3d ago" — for the roster's last-shift stamp.
function relativeTime(t: number): string {
  const mins = Math.max(0, Math.round((Date.now() - t) / 60_000));
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
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
        (active ? 'bg-accent text-white' : 'border border-card-strong text-ink-muted hover:bg-white/5')
      }
    >
      {children}
    </button>
  );
}
