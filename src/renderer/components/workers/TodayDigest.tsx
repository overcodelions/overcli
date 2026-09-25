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
export function defaultItem(model: DigestModel): OpenItem {
  if (model.needs[0]) return { kind: 'needs', key: model.needs[0].key };
  const first = model.working[0] ?? model.done[0] ?? model.earlier[0]?.rows[0];
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

function TodayHeader({ model }: { model: DigestModel }) {
  const { spine, now, needs } = model;
  const soonest = spine.upcoming[spine.upcoming.length - 1];
  const title = [
    spine.done > 0 ? `${spine.done} done` : 'Nothing done yet',
    needs.length > 0 ? `${needs.length} need${needs.length === 1 ? 's' : ''} you` : null,
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
          <h2 className="mt-0.5 text-[19px] font-semibold tracking-[-0.015em] text-ink">{title}</h2>
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
  const nothing =
    model.needs.length + model.working.length + model.done.length + model.quiet.length + model.earlier.length === 0;
  return (
    <div className="flex flex-col gap-5">
      <TodayHeader model={model} />
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
          <h3 className="text-[10.5px] font-semibold uppercase tracking-[0.08em] text-amber-500">Needs you</h3>
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
      {[
        { label: 'Working', rows: model.working },
        { label: 'Today', rows: model.done },
        ...model.earlier,
      ].map(
        (group) =>
          group.rows.length > 0 && (
            <section key={group.label} className="flex flex-col gap-0.5">
              <SectionLabel>{group.label}</SectionLabel>
              <div className="mt-1 flex flex-col">
                {group.rows.map((row) => (
                  <ListEntry
                    key={row.key}
                    row={row}
                    digest={model.digest[row.key]}
                    file={model.filed[row.key] ?? null}
                    showDay={group.label !== 'Working' && group.label !== 'Today'}
                    selected={isOpen('done', row.key)}
                    onOpen={() => onOpen({ kind: 'done', key: row.key })}
                  />
                ))}
              </div>
              {group.label === 'Today' && <QuietLine rows={model.quiet} onOpen={(key) => onOpen({ kind: 'done', key })} />}
            </section>
          ),
      )}
      {model.done.length === 0 && model.quiet.length > 0 && (
        <QuietLine rows={model.quiet} onOpen={(key) => onOpen({ kind: 'done', key })} />
      )}
    </div>
  );
}

function askOf(row: QueueRow): string {
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
        background: selected
          ? 'color-mix(in srgb, #fbbf24 14%, var(--c-card))'
          : 'color-mix(in srgb, #fbbf24 4%, var(--c-card))',
      }}
    >
      {worker && <WorkerAvatar worker={worker} size="xs" />}
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[13px] text-ink">{row.title}</span>
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
}: {
  row: QueueRow;
  digest: DigestSummary | undefined;
  file: WorkerFile | null;
  showDay: boolean;
  selected: boolean;
  onOpen: () => void;
}) {
  const worker = useWorkersStore((s) => s.workers[row.workerId]);
  const live = row.status === 'running' || row.status === 'planning' || row.status === 'responding';
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
  return (
    <button
      onClick={onOpen}
      aria-current={selected ? 'true' : undefined}
      className={
        'flex gap-2.5 rounded-lg border px-3 py-2.5 text-left focus:outline-none focus-visible:ring-1 focus-visible:ring-accent/50 ' +
        (selected ? 'border-accent/50 bg-accent/10' : 'border-transparent hover:bg-card-strong/50')
      }
    >
      <span className="pt-0.5">{worker && <WorkerAvatar worker={worker} size="xs" live={live} />}</span>
      <span className="min-w-0 flex-1">
        <span className={'line-clamp-2 text-[13px] font-medium leading-snug ' + (failed ? 'text-red-400' : 'text-ink')}>
          {failed ? `Failed: ${row.title}` : headline}
        </span>
        {detail && <span className="mt-0.5 line-clamp-1 text-[12px] text-ink-muted">{detail}</span>}
        <span className="mt-0.5 block truncate text-[11px] text-ink-faint">
          {[row.workerName, when, file ? baseName(file.name) : null].filter(Boolean).join(' · ')}
        </span>
      </span>
    </button>
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
