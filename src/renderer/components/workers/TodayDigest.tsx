import { Fragment, useEffect, useRef, useState } from 'react';
// The Today page's list half — an inbox of the crew's work.
//
// What needs you first, then what is working, then what got done: today, and
// the days before it for a week, so a result that landed overnight is still
// here in the morning. Each finished entry is said as what it produced — the
// headline and a line of what it found — not the job it was. Selecting one
// opens it in the reader beside the list; something is always open, so the
// page never lands on an empty half.

import { useFlowsStore } from '../../flowsStore';
import { useWorkersStore } from '../../workersStore';
import { useWorkerColors } from './WorkerAvatar';
import { WorkerAvatar } from './WorkerAvatar';
import { workerColorFor } from './workerPalette';
import { AskCrew } from './AskCrew';
import { clearStateOf, useTodayCleared } from './todayCleared';
import { SectionLabel } from './NowSection';
import { elapsedLabel, latestExchange, waitingLine } from './nowCards';
import { clockStamp, type TodaySpine } from './todaySpine';
import { hourBuckets } from './todayLayout';
import type { DigestSummary } from './digestSummary';
import type { QueueRow } from './workQueue';
import { baseName } from './workQueue';
import type { WorkerFile } from './workerDeskSelectors';

export type OpenItem = { kind: 'needs' | 'done'; key: string } | null;

export interface DigestModel {
  spine: TodaySpine;
  now: number;
  needs: QueueRow[];
  working: QueueRow[];
  /// Finished today, newest first — answers included, empty shifts not.
  done: QueueRow[];
  /// Today's shifts that looked and found nothing.
  quiet: QueueRow[];
  /// Finished before today, grouped by day.
  earlier: Array<{ label: string; rows: QueueRow[] }>;
  filed: Record<string, WorkerFile | null | undefined>;
  digest: Record<string, DigestSummary>;
}

/// The item the inbox opens on: the oldest thing waiting on you, else what is
/// working, else the newest result.
export function defaultItem(model: DigestModel, isCleared: (row: QueueRow) => boolean = () => false): OpenItem {
  if (model.needs[0]) return { kind: 'needs', key: model.needs[0].key };
  // Something you have not read yet, if there is one: landing on a result you
  // already cleared is the page telling you what you told it to put away.
  const unread = (rows: QueueRow[]) => rows.find((r) => !isCleared(r));
  const first =
    model.working[0] ??
    unread(model.done) ??
    model.earlier.map((g) => unread(g.rows)).find(Boolean) ??
    model.done[0] ??
    model.earlier[0]?.rows[0];
  return first ? { kind: 'done', key: first.key } : null;
}

export function findRow(model: DigestModel, item: NonNullable<OpenItem>): QueueRow | undefined {
  if (item.kind === 'needs') return model.needs.find((r) => r.key === item.key);
  const rows = [...model.working, ...model.done, ...model.quiet, ...model.earlier.flatMap((g) => g.rows)];
  // A lone answer folds into its worker's group once a second one lands — a
  // follow-up sent from the reader does exactly that — so the conversation
  // you had open is still the one you have open.
  return rows.find((r) => r.key === item.key) ?? rows.find((r) => r.answers?.some((a) => a.key === item.key));
}

function TodayHeader({ model, unread }: { model: DigestModel; unread: number }) {
  const { spine, now, needs } = model;
  const soonest = spine.upcoming[spine.upcoming.length - 1];
  const title = [
    spine.done > 0 ? `${spine.done} done` : 'Nothing done yet',
    needs.length > 0 ? `${needs.length} need${needs.length === 1 ? 's' : ''} you` : null,
    // Only once you have started clearing: before that, "15 done · 15 left
    // to read" says the same number twice.
    spine.done > 0 && unread < model.done.length ? (unread === 0 ? 'all read' : `${unread} left to read`) : null,
  ]
    .filter(Boolean)
    .join(' · ');
  return (
    <header className="flex flex-col gap-2">
      <div className="flex items-baseline gap-3">
        <div className="min-w-0 flex-1">
          <div className="text-[10.5px] font-semibold uppercase tracking-[0.08em] text-ink-faint">
            {new Date(now).toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' })}
          </div>
          {/* Each phrase stays whole; a narrow pane breaks between them,
              never inside one ("left to / read"). */}
          <h2 className="mt-0.5 text-[19px] font-semibold tracking-[-0.015em] text-ink">
            {title.split(' · ').map((part, i) => (
              <Fragment key={part}>
                {i > 0 && ' · '}
                <span className="whitespace-nowrap">{part}</span>
              </Fragment>
            ))}
          </h2>
        </div>
        {soonest && (
          <span className="shrink-0 text-[11.5px] text-ink-muted">
            Next: {soonest.workerName} {clockStamp(soonest.at)}
          </span>
        )}
      </div>
      <DayChart spine={spine} now={now} />
    </header>
  );
}

/// Where in the day the work fell — one bar per hour, tinted by whose job
/// finished in it. Context for the headline, not a chart to read.
function DayChart({ spine, now }: { spine: TodaySpine; now: number }) {
  const colors = useWorkerColors();
  const buckets = hourBuckets(spine, now);
  const most = Math.max(1, ...buckets.map((b) => b.count));
  return (
    <div className="flex h-5 items-end gap-[2px]" aria-hidden>
      {buckets.map((b) => (
        <span
          key={b.hour}
          className="flex-1 rounded-[2px]"
          title={b.count > 0 ? `${b.count} finished around ${b.hour}:00` : undefined}
          style={{
            height: b.count > 0 ? `${40 + (60 * b.count) / most}%` : b.future ? '10%' : '20%',
            background:
              b.count === 0
                ? 'var(--c-card-border)'
                : b.failed
                  ? 'var(--c-diff-remove-ink)'
                  : workerColorFor(colors, b.workerId ?? ''),
            opacity: b.count === 0 && b.future ? 0.45 : 1,
          }}
        />
      ))}
    </div>
  );
}

export function InboxList({
  model,
  open,
  onOpen,
}: {
  model: DigestModel;
  open: OpenItem;
  onOpen: (item: OpenItem) => void;
}) {
  const isOpen = (kind: 'needs' | 'done', key: string) => open?.kind === kind && open.key === key;
  const cleared = useTodayCleared((s) => s.cleared);
  const clear = useTodayCleared((s) => s.clear);
  const restore = useTodayCleared((s) => s.restore);
  const [undo, setUndo] = useState<{ key: string; title: string } | null>(null);
  useEffect(() => {
    if (!undo) return;
    const t = window.setTimeout(() => setUndo(null), 6000);
    return () => window.clearTimeout(t);
  }, [undo]);
  // A shift that ends in a wrap-up is ONE thing: the wrap-up is the summary
  // and the shift's items are what it summarised. Listed side by side, a busy
  // shift put six rows above the one you would actually read. So when a
  // wrap-up is on the page, its shift's items move under it.
  const listed = [...model.working, ...model.done, ...model.earlier.flatMap((g) => g.rows)];
  const wrapped = new Set(listed.flatMap((r) => (r.wrapUpOf ? [r.wrapUpOf] : [])));
  const nested = (row: QueueRow) => !row.wrapUpOf && !!row.orchestrationId && wrapped.has(row.orchestrationId);
  const childrenOf = (row: QueueRow) =>
    row.wrapUpOf ? listed.filter((r) => !r.wrapUpOf && r.orchestrationId === row.wrapUpOf) : [];
  const clearRow = (row: QueueRow, title: string) => {
    clear(row.key);
    setUndo({ key: row.key, title });
  };
  const nothing =
    model.needs.length + model.working.length + model.done.length + model.quiet.length + model.earlier.length === 0;
  return (
    <div className="flex flex-col gap-5">
      <TodayHeader model={model} unread={model.done.filter((r) => clearStateOf(cleared, r.key, r.at) !== 'cleared').length} />
      <AskCrew
        onOpenBatch={(orchestrationId) => {
          // The errand's own entry — needing you, working, or done.
          const needs = model.needs.find((r) => r.orchestrationId === orchestrationId);
          if (needs) return onOpen({ kind: 'needs', key: needs.key });
          const row = [...model.working, ...model.done].find((r) => r.orchestrationId === orchestrationId);
          if (row) onOpen({ kind: 'done', key: row.key });
        }}
      />
      {nothing && <p className="text-[12.5px] text-ink-faint">Nothing yet — the crew's work lands here as it happens.</p>}
      {model.needs.length > 0 && (
        <section className="flex flex-col gap-1.5">
          <div className="flex flex-wrap items-center justify-between gap-x-2 gap-y-1.5">
            <h3 className="shrink-0 whitespace-nowrap text-[10.5px] font-semibold uppercase tracking-[0.08em] text-amber-500">
              Needs you
            </h3>
            <ApproveAll rows={model.needs} />
          </div>
          <div
            className="overflow-hidden rounded-lg border"
            style={{ borderColor: 'color-mix(in srgb, #fbbf24 30%, var(--c-card-border))' }}
          >
            {model.needs.map((row) => (
              <NeedsLine
                key={row.key}
                row={row}
                now={model.now}
                selected={isOpen('needs', row.key)}
                onOpen={() => onOpen({ kind: 'needs', key: row.key })}
              />
            ))}
          </div>
        </section>
      )}
      <HandedOn now={model.now} />
      {[
        { label: 'Working', rows: model.working },
        { label: 'Today', rows: model.done },
        ...model.earlier,
      ].map(
        (group) =>
          // A heading over rows that all moved under a wrap-up is a heading
          // over nothing.
          group.rows.some((row) => !nested(row)) && (
            <section key={group.label} className="flex flex-col gap-0.5">
              <SectionLabel>{group.label}</SectionLabel>
              <div className="mt-1 flex flex-col">
                {group.rows
                  .filter((row) => !nested(row))
                  .filter((row) => group.label === 'Working' || clearStateOf(cleared, row.key, row.at) !== 'cleared')
                  .map((row) => (
                    <Fragment key={row.key}>
                      <ListEntry
                        row={row}
                        digest={model.digest[row.key]}
                        file={model.filed[row.key] ?? null}
                        showDay={group.label !== 'Working' && group.label !== 'Today'}
                        selected={isOpen('done', row.key)}
                        onOpen={() => onOpen({ kind: 'done', key: row.key })}
                        back={clearStateOf(cleared, row.key, row.at) === 'back'}
                        onClear={group.label === 'Working' ? undefined : (title) => clearRow(row, title)}
                      />
                      {row.wrapUpOf && (
                        <ShiftItems
                          rows={childrenOf(row)}
                          renderRow={(child) => (
                            <ListEntry
                              key={child.key}
                              row={child}
                              digest={model.digest[child.key]}
                              file={model.filed[child.key] ?? null}
                              showDay={group.label !== 'Working' && group.label !== 'Today'}
                              selected={isOpen('done', child.key)}
                              onOpen={() => onOpen({ kind: 'done', key: child.key })}
                            />
                          )}
                          openKey={open?.kind === 'done' ? open.key : null}
                        />
                      )}
                    </Fragment>
                  ))}
              </div>
              {group.label !== 'Working' && (
                <ClearedFold
                  rows={group.rows.filter((row) => clearStateOf(cleared, row.key, row.at) === 'cleared')}
                  label={group.label === 'Today' ? 'today' : ''}
                  cleared={cleared}
                  selectedKey={open?.kind === 'done' ? open.key : null}
                  onOpen={(key) => onOpen({ kind: 'done', key })}
                  onRestore={restore}
                />
              )}
              {group.label === 'Today' && <QuietLine rows={model.quiet} onOpen={(key) => onOpen({ kind: 'done', key })} />}
            </section>
          ),
      )}
      {model.done.length === 0 && model.quiet.length > 0 && (
        <QuietLine rows={model.quiet} onOpen={(key) => onOpen({ kind: 'done', key })} />
      )}
      {undo && (
        <div
          key={undo.key}
          role="status"
          className="today-toast sticky z-10 flex items-center gap-3 rounded-xl border px-4 py-3 shadow-2xl"
          style={{
            // Sticky offsets are measured inside the list's 40px bottom
            // padding; this lands the notice 16px off the pane's real edge.
            bottom: '-1.5rem',
            background: 'color-mix(in srgb, var(--c-ink) 88%, var(--c-surface))',
            borderColor: 'color-mix(in srgb, var(--c-ink) 70%, transparent)',
            color: 'var(--c-surface)',
          }}
        >
          <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-emerald-500 text-white">
            <CheckIcon />
          </span>
          <span className="min-w-0 flex-1">
            <span className="block text-[13px] font-semibold">Cleared</span>
            <span className="block truncate text-[12px] opacity-75">{undo.title}</span>
          </span>
          <button
            onClick={() => {
              restore(undo.key);
              setUndo(null);
            }}
            className="shrink-0 rounded-md px-3 py-1.5 text-[13px] font-semibold hover:opacity-90"
            style={{ background: 'var(--c-accent)', color: '#fff' }}
          >
            Undo
          </button>
        </div>
      )}
    </div>
  );
}

/// Work one worker has dated for another, waiting for its day. On the page
/// because work moving between workers where you cannot see it is how you
/// stop trusting the crew; each can be sent early or called off.
function HandedOn({ now }: { now: number }) {
  const held = useWorkersStore((s) => s.heldHandoffs);
  const workers = useWorkersStore((s) => s.workers);
  const cancel = useWorkersStore((s) => s.cancelHandoff);
  const sendNow = useWorkersStore((s) => s.sendHandoffNow);
  if (held.length === 0) return null;
  return (
    <section className="flex flex-col gap-0.5">
      <SectionLabel>Handed on · waiting for the day</SectionLabel>
      <div className="mt-1 flex flex-col">
        {held.map((h) => {
          const from = workers[h.fromId];
          const to = workers[h.toId];
          return (
            <div key={h.id} className="group flex gap-2.5 rounded-lg px-3 py-2.5 hover:bg-card-strong/50">
              <span className="flex shrink-0 items-center gap-0.5 pt-0.5">
                {from && <WorkerAvatar worker={from} size="xs" />}
                <span aria-hidden className="text-[10px] text-ink-faint">
                  →
                </span>
                {to && <WorkerAvatar worker={to} size="xs" />}
              </span>
              <span className="min-w-0 flex-1">
                <span className="line-clamp-2 text-[13px] font-medium leading-snug text-ink" title={h.instruction}>
                  {h.title}
                </span>
                <span className="mt-0.5 block truncate text-[11px] text-ink-faint">
                  {h.fromName} → {h.toName} · {handoffDay(h.notBefore, now)}
                </span>
                <span className="mt-1 flex gap-3 text-[11px] opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100">
                  <button onClick={() => void sendNow(h.id)} className="text-accent hover:underline">
                    Send now
                  </button>
                  <button onClick={() => void cancel(h.id)} className="text-ink-muted hover:text-red-400 hover:underline">
                    Call it off
                  </button>
                </span>
              </span>
            </div>
          );
        })}
      </div>
    </section>
  );
}

/// "Tomorrow 09:00", "Tue, Oct 13" — when a held handoff goes out.
function handoffDay(at: number, now: number): string {
  const day = (t: number) => new Date(t).toDateString();
  const time = new Date(at).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false });
  if (day(at) === day(now)) return `today ${time}`;
  if (day(at) === day(now + 24 * 60 * 60 * 1000)) return `tomorrow ${time}`;
  return new Date(at).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
}

/// A wrap-up's shift, folded under it: one line saying how many things the
/// shift did and how many are still going, opened to the rows themselves.
/// Opens on its own while one of them is the item in the reader, so picking
/// a child never leaves it hidden.
function ShiftItems({
  rows,
  renderRow,
  openKey,
}: {
  rows: QueueRow[];
  renderRow: (row: QueueRow) => React.ReactNode;
  openKey: string | null;
}) {
  const holdsOpen = rows.some((r) => r.key === openKey);
  const [open, setOpen] = useState(holdsOpen);
  useEffect(() => {
    if (holdsOpen) setOpen(true);
  }, [holdsOpen]);
  if (rows.length === 0) return null;
  const live = rows.filter((r) => r.status === 'running' || r.status === 'planning' || r.status === 'responding').length;
  const failed = rows.filter((r) => r.status === 'failed').length;
  return (
    <div className="mb-1 ml-[22px] border-l border-card pl-2">
      <button
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex items-center gap-1.5 rounded px-2 py-1 text-left text-[11.5px] text-ink-faint hover:text-ink-muted"
      >
        <svg width="9" height="9" viewBox="0 0 16 16" aria-hidden className={'transition-transform ' + (open ? 'rotate-90' : '')}>
          <path d="M6 3.5 10.5 8 6 12.5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
        </svg>
        {rows.length} from this shift
        {live > 0 && <span className="text-emerald-600 dark:text-emerald-300">· {live} working</span>}
        {failed > 0 && <span className="text-red-400">· {failed} failed</span>}
      </button>
      {open && <div className="flex flex-col">{rows.map(renderRow)}</div>}
    </div>
  );
}

/// The day's cleared items, as one line that opens. Nothing here is gone —
/// it is read, and "Bring back" puts it in the list again.
function ClearedFold({
  rows,
  label,
  cleared,
  selectedKey,
  onOpen,
  onRestore,
}: {
  rows: QueueRow[];
  label: string;
  cleared: Record<string, number>;
  selectedKey: string | null;
  onOpen: (key: string) => void;
  onRestore: (key: string) => void;
}) {
  const [open, setOpen] = useState(false);
  if (rows.length === 0) return null;
  return (
    <div className="mt-0.5 flex flex-col">
      <button
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex items-center gap-1.5 rounded px-3 py-1 text-left text-[11.5px] text-ink-faint hover:text-ink-muted"
      >
        <svg width="9" height="9" viewBox="0 0 16 16" aria-hidden className={'transition-transform ' + (open ? 'rotate-90' : '')}>
          <path d="M6 3.5 10.5 8 6 12.5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
        </svg>
        {rows.length} cleared{label ? ` ${label}` : ''}
      </button>
      {open &&
        rows.map((row) => (
          <div
            key={row.key}
            className={
              'group flex items-center gap-2 rounded-lg px-3 py-1.5 ' +
              (selectedKey === row.key ? 'bg-accent/10' : 'hover:bg-card-strong/50')
            }
          >
            <button onClick={() => onOpen(row.key)} className="min-w-0 flex-1 text-left">
              <span className="block truncate text-[12.5px] text-ink-muted">{row.title}</span>
              <span className="block truncate text-[10.5px] text-ink-faint">
                {row.workerName} · {clockStamp(row.at)} · cleared {clockStamp(cleared[row.key] ?? row.at)}
              </span>
            </button>
            <button
              onClick={() => onRestore(row.key)}
              className="shrink-0 rounded px-1.5 py-0.5 text-[11px] text-accent opacity-0 hover:underline group-hover:opacity-100 focus:opacity-100"
            >
              Bring back
            </button>
          </div>
        ))}
    </div>
  );
}

function CheckIcon({ className = '' }: { className?: string }) {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" aria-hidden className={'flex-shrink-0 ' + className}>
      <path d="M3 8.5l3 3 7-7" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}

/// How far a two-finger swipe has to travel before letting go clears the row.
const SWIPE_CLEAR_PX = 90;
const SWIPE_MAX_PX = 160;
/// Slide out, then close the gap: long enough to read as one motion.
const CLEAR_ANIMATION_MS = 320;

/// Paused runs a single click may move on: stopped at a checkpoint, cut off
/// by a restart, or waiting on an outside action or a risky step you are
/// choosing to wave through. A question needs your answer and a failure needs
/// a decision, so those two are never swept up.
const SWEEPABLE = new Set(['preStep', 'interrupted', 'externalAction', 'riskyStep']);

function sweepable(rows: QueueRow[]) {
  const runs = rows.filter((r) => r.status === 'paused' && r.runId && SWEEPABLE.has(r.pausedReason ?? 'preStep'));
  const proposals = rows.filter((r) => r.status === 'proposed' && r.orchestrationId && r.candidateId);
  return { runs, proposals };
}

/// "Approve all": continue every paused run that only needs a go-ahead and
/// launch every proposal, in one click and one confirm. The confirm says how
/// many will act outside the repo, because that is the part worth a second
/// look before sweeping.
function ApproveAll({ rows }: { rows: QueueRow[] }) {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const { runs, proposals } = sweepable(rows);
  const total = runs.length + proposals.length;
  if (total < 2 && !busy && !note) return null;
  const outside = runs.filter((r) => r.pausedReason === 'externalAction' || r.pausedReason === 'riskyStep').length;
  const leftOut = rows.length - total;

  const go = async () => {
    setBusy(true);
    setConfirming(false);
    let failed = 0;
    await Promise.all(
      runs.map(async (r) => {
        const res = await window.overcli.invoke('flows:resumeRun', { runId: r.runId! }).catch(() => null);
        if (!res || res.ok === false) failed++;
      }),
    );
    // One call per batch, naming every proposal in it and leaving any the
    // list does not show alone.
    const byBatch = new Map<string, string[]>();
    for (const r of proposals) byBatch.set(r.orchestrationId!, [...(byBatch.get(r.orchestrationId!) ?? []), r.candidateId!]);
    await Promise.all(
      [...byBatch].map(async ([id, candidateIds]) => {
        const res = await window.overcli
          .invoke('orchestrator:approveBatch', {
            id,
            approve: candidateIds.map((candidateId) => ({ candidateId })),
            keepUnpicked: true,
          })
          .catch(() => null);
        if (!res || res.ok === false) failed += candidateIds.length;
      }),
    );
    setBusy(false);
    setNote(failed > 0 ? `${failed} couldn’t be moved on — open them one by one.` : null);
  };

  if (note) {
    return (
      <span className="text-[11px] text-red-400">
        {note}{' '}
        <button onClick={() => setNote(null)} className="underline">
          ok
        </button>
      </span>
    );
  }
  if (busy) return <span className="text-[11px] text-ink-faint">Approving…</span>;
  if (confirming) {
    // Its own full-width line under the heading: squeezed in beside it, the
    // sentence crushed "Needs you" onto two lines.
    return (
      <span className="flex w-full basis-full items-center gap-1.5 rounded-md border border-amber-400/30 bg-amber-400/5 px-2 py-1.5 text-[11px] text-ink-muted">
        <span className="min-w-0 flex-1">
          {[runs.length ? `Continue ${runs.length}` : null, proposals.length ? `launch ${proposals.length}` : null]
            .filter(Boolean)
            .join(', ')}
          {outside > 0 ? ` · ${outside} act outside the repo` : ''}
          {leftOut > 0 ? ` · ${leftOut} left for you` : ''}?
        </span>
        <button
          onClick={() => void go()}
          className="rounded bg-amber-400 px-2 py-0.5 font-medium text-[#1c1c21] hover:bg-amber-300"
        >
          Approve
        </button>
        <button onClick={() => setConfirming(false)} className="text-ink-faint hover:text-ink">
          Cancel
        </button>
      </span>
    );
  }
  return (
    <button
      onClick={() => setConfirming(true)}
      title="Continue every run that only needs a go-ahead and launch every proposal. Questions and failures stay for you."
      className="rounded border border-amber-400/50 px-2 py-0.5 text-[11px] text-amber-600 hover:bg-amber-400/10 dark:text-amber-300"
    >
      Approve all {total}
    </button>
  );
}

function askOf(row: QueueRow): string {
  if (row.status === 'proposed') return 'Proposed — launch it or turn it down';
  const step = row.steps.find((s) => s.state === 'current')?.id;
  return row.pausedReason === 'needsInput' ? 'Asked you a question' : waitingLine(row.pausedReason, step);
}

function NeedsLine({ row, now, onOpen, selected }: { row: QueueRow; now: number; onOpen: () => void; selected: boolean }) {
  const worker = useWorkersStore((s) => s.workers[row.workerId]);
  // A question the worker already looked at and handed up reads differently
  // from one that came straight to you.
  const escalated = useFlowsStore((s) => {
    const run = row.runId ? s.runs[row.runId] : undefined;
    return run ? latestExchange(run)?.status === 'escalated' : false;
  });
  return (
    <button
      onClick={onOpen}
      aria-current={selected ? 'true' : undefined}
      className="flex w-full items-center gap-3 border-b px-3 py-2.5 text-left last:border-b-0 focus:outline-none focus-visible:ring-1 focus-visible:ring-accent/50"
      style={{
        borderColor: 'color-mix(in srgb, #fbbf24 18%, var(--c-card-border))',
        // The open one has to read as open at a glance — a faint tint alone
        // disappears among rows that are all amber already.
        background: selected
          ? 'color-mix(in srgb, #fbbf24 22%, var(--c-card))'
          : 'color-mix(in srgb, #fbbf24 4%, var(--c-card))',
        boxShadow: selected ? 'inset 3px 0 0 #fbbf24' : undefined,
      }}
    >
      {worker && <WorkerAvatar worker={worker} size="xs" />}
      <span className="min-w-0 flex-1">
        <span className={'block truncate text-[13px] text-ink ' + (selected ? 'font-semibold' : '')}>{row.title}</span>
        <span className="block truncate text-[11.5px] text-amber-600 dark:text-amber-300/90">
          {row.workerName} · {escalated ? 'Escalated a question to you' : askOf(row)}
        </span>
      </span>
      <span className="shrink-0 text-[11px] text-ink-faint">{elapsedLabel(now - row.at)}</span>
    </button>
  );
}

/// One finished (or working) job in the list: what it produced, and a line
/// of what it found.
function ListEntry({
  row,
  digest,
  file,
  showDay,
  selected,
  onOpen,
  back,
  onClear,
}: {
  row: QueueRow;
  digest: DigestSummary | undefined;
  file: WorkerFile | null;
  showDay: boolean;
  selected: boolean;
  onOpen: () => void;
  /// Cleared once, and something has happened to it since.
  back?: boolean;
  /// Absent for work still under way: only finished work can be cleared.
  onClear?: (title: string) => void;
}) {
  const worker = useWorkersStore((s) => s.workers[row.workerId]);
  const live = row.status === 'running' || row.status === 'planning' || row.status === 'responding';
  // Swipe left to clear: the row follows your fingers and uncovers "Clear"
  // on the right, the way Mail does. A trackpad swipe arrives as horizontal
  // wheel deltas whose sign depends on the "natural scrolling" setting, so
  // the finger direction is recovered from `webkitDirectionInvertedFromDevice`
  // rather than assumed. The row tracks the fingers with no easing while they
  // move, then eases on its own — out of the list past the threshold, back
  // into place short of it.
  const [offset, setOffset] = useState(0);
  const [dragging, setDragging] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const settle = useRef<number | undefined>(undefined);
  const leave = useRef<number | undefined>(undefined);
  useEffect(
    () => () => {
      window.clearTimeout(settle.current);
      window.clearTimeout(leave.current);
    },
    [],
  );
  const canClear = !!onClear && !live;
  const failed = row.status === 'failed';
  const answered = row.status === 'quiet' && row.task === 'errand';
  const headline = live
    ? row.title
    : answered
      ? row.answers
        ? `Answered ${row.answers.length} questions`
        : `Answered: ${row.title}`
      : digest?.headline ?? row.title;
  const detail = live || failed ? row.note ?? '' : digest?.points[0] ?? digest?.summary ?? '';
  const when = live
    ? 'working now'
    : showDay
      ? new Date(row.at).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
      : clockStamp(row.at);
  const title = failed ? `Failed: ${row.title}` : headline;
  // Every way of clearing — swipe, ✓, E — leaves the same way: the row slides
  // off to the left, then the gap it leaves closes, and only then does it
  // drop out of the list. Removing it at once made the rows below jump.
  const doClear = () => {
    if (leaving) return;
    window.clearTimeout(settle.current);
    setDragging(false);
    setLeaving(true);
    leave.current = window.setTimeout(() => onClear?.(title), CLEAR_ANIMATION_MS);
  };
  const onWheel = (e: React.WheelEvent) => {
    if (!canClear || leaving || Math.abs(e.deltaX) <= Math.abs(e.deltaY)) return;
    const inverted = (e.nativeEvent as WheelEvent & { webkitDirectionInvertedFromDevice?: boolean })
      .webkitDirectionInvertedFromDevice;
    const fingerDx = inverted ? -e.deltaX : e.deltaX;
    setDragging(true);
    setOffset((o) => Math.min(0, Math.max(-SWIPE_MAX_PX, o + fingerDx)));
    window.clearTimeout(settle.current);
    settle.current = window.setTimeout(() => {
      setDragging(false);
      setOffset((o) => {
        if (o <= -SWIPE_CLEAR_PX) doClear();
        return o <= -SWIPE_CLEAR_PX ? o : 0;
      });
    }, 120);
  };
  const shown = leaving ? 'calc(-100% - 24px)' : `${offset}px`;
  const armed = leaving || offset <= -SWIPE_CLEAR_PX;
  return (
    <div
      className="grid"
      style={{
        gridTemplateRows: leaving ? '0fr' : '1fr',
        opacity: leaving ? 0 : 1,
        transition: leaving
          ? `grid-template-rows ${CLEAR_ANIMATION_MS - 120}ms ease ${120}ms, opacity ${CLEAR_ANIMATION_MS}ms ease`
          : undefined,
      }}
    >
    <div className="group relative min-h-0 overflow-hidden rounded-lg" onWheel={onWheel}>
      {(offset < 0 || leaving) && (
        <div
          aria-hidden
          className={
            'absolute inset-0 flex items-center justify-end gap-1.5 rounded-lg pr-4 text-[12px] font-semibold transition-colors duration-150 ' +
            (armed ? 'bg-emerald-600 text-white' : 'bg-emerald-600/25 text-emerald-700 dark:text-emerald-200')
          }
        >
          <span
            className="flex items-center gap-1.5 transition-transform duration-150"
            style={{ transform: armed ? 'scale(1.08)' : 'scale(1)' }}
          >
            <CheckIcon />
            {armed ? 'Release to clear' : 'Clear'}
          </span>
        </div>
      )}
    <button
      onClick={onOpen}
      onKeyDown={(e) => {
        if (canClear && (e.key === 'e' || e.key === 'E') && !e.metaKey && !e.ctrlKey && !e.altKey) {
          e.preventDefault();
          doClear();
        }
      }}
      aria-current={selected ? 'true' : undefined}
      className={
        'relative flex w-full gap-2.5 rounded-lg border px-3 py-2.5 text-left focus:outline-none focus-visible:ring-1 focus-visible:ring-accent/50 ' +
        (canClear ? 'pr-10 ' : '') +
        (selected
          ? 'border-accent/50 bg-accent/10'
          : back
            ? 'border-amber-400/40 bg-surface'
            : offset < 0
              ? 'border-transparent bg-card-strong'
              : 'border-transparent hover:bg-card-strong/50')
      }
      style={{
        ...(selected ? { boxShadow: 'inset 3px 0 0 var(--c-accent)' } : {}),
        ...(offset < 0 || leaving ? { background: 'var(--c-surface)' } : {}),
        transform: offset < 0 || leaving ? `translateX(${shown})` : undefined,
        transition: dragging ? 'none' : 'transform 220ms cubic-bezier(0.2, 0.8, 0.2, 1)',
      }}
    >
      <span className="pt-0.5">{worker && <WorkerAvatar worker={worker} size="xs" live={live} />}</span>
      <span className="min-w-0 flex-1">
        <span className={'line-clamp-2 text-[13px] font-medium leading-snug ' + (failed ? 'text-red-400' : 'text-ink')}>
          {failed ? `Failed: ${row.title}` : headline}
        </span>
        {detail && <span className="mt-0.5 line-clamp-1 text-[12px] text-ink-muted">{detail}</span>}
        <span className="mt-0.5 block truncate text-[11px] text-ink-faint">
          {[row.workerName, row.from ? `from ${row.from}` : null, when, file ? baseName(file.name) : null]
            .filter(Boolean)
            .join(' · ')}
        </span>
        {back && (
          <span className="mt-0.5 block text-[11px] text-amber-600 dark:text-amber-300">
            Something new since you cleared it
          </span>
        )}
      </span>
    </button>
      {canClear && offset === 0 && !leaving && (
        <button
          onClick={doClear}
          title="Clear from Today (E) — it stays under “cleared”"
          aria-label={`Clear “${title}” from Today`}
          className="absolute right-2 top-2.5 flex h-6 w-6 items-center justify-center rounded-md border border-card-strong bg-surface text-ink-muted opacity-0 hover:border-emerald-500/60 hover:text-emerald-500 focus:opacity-100 group-hover:opacity-100"
        >
          <CheckIcon />
        </button>
      )}
    </div>
    </div>
  );
}

/// Shifts that looked and found nothing are one fact, not one entry each.
function QuietLine({ rows, onOpen }: { rows: QueueRow[]; onOpen: (key: string) => void }) {
  if (rows.length === 0) return null;
  return (
    <p className="mt-1 px-3 text-[11.5px] text-ink-faint">
      {rows.map((row, i) => (
        <span key={row.key}>
          {i > 0 && (i === rows.length - 1 ? ' and ' : ', ')}
          <button onClick={() => onOpen(row.key)} className="hover:text-ink hover:underline focus:outline-none">
            {row.workerName} ({clockStamp(row.at)})
          </button>
        </span>
      ))}{' '}
      looked, found nothing to do.
    </p>
  );
}
