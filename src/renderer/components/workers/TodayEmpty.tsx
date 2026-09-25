// The reader when there is nothing to read: a crew is hired but nothing has
// happened this week — a fresh install, or a quiet stretch.
//
// Half a screen saying "nothing yet" was true and useless. This says when
// something WILL happen (every worker's next shift), and offers the two ways
// to make something happen now: hand a worker a job, or start its shift.

import { useMemo, useState } from 'react';

import { useWorkersStore } from '../../workersStore';
import { SectionLabel } from './NowSection';
import { WorkerAvatar } from './WorkerAvatar';
import { clockStamp } from './todaySpine';
import type { UpcomingRow } from './workQueue';

import { sortRoster } from '@shared/flows/worker';
import { untilLabel } from '@shared/flows/schedule';

export function TodayEmpty({ upcoming, now }: { upcoming: UpcomingRow[]; now: number }) {
  return (
    <div className="min-h-0 flex-1 overflow-y-auto px-10 pb-12 pt-10">
      <div className="flex max-w-[860px] flex-col gap-9">
        <header>
          <h2 className="text-[22px] font-semibold tracking-[-0.015em] text-ink">Nothing has landed yet</h2>
          <p className="mt-1 text-[13.5px] text-ink-muted">
            Your crew’s results, questions and checkpoints show up here as they happen.
            {upcoming[0] ? ` The next one is due ${untilLabel(upcoming[0].at, now)}.` : ''}
          </p>
        </header>
        <HandAJob />
        <UpNext upcoming={upcoming} now={now} />
      </div>
    </div>
  );
}

/// Give one worker something to do right now — the same errand the desk
/// sends, without opening the desk.
function HandAJob() {
  const workers = useWorkersStore((s) => s.workers);
  const runErrand = useWorkersStore((s) => s.runErrand);
  const crew = useMemo(() => sortRoster(Object.values(workers)).filter((w) => w.enabled), [workers]);
  const [workerId, setWorkerId] = useState<string>('');
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [sentTo, setSentTo] = useState<string | null>(null);
  const target = crew.find((w) => w.id === workerId) ?? crew[0];
  if (!target) return null;

  const submit = async () => {
    const ask = text.trim();
    if (!ask || busy) return;
    setBusy(true);
    const ok = await runErrand(target.id, ask);
    setBusy(false);
    if (ok) {
      setText('');
      setSentTo(target.name);
    }
  };

  return (
    <section className="flex flex-col gap-2">
      <SectionLabel>Hand someone a job</SectionLabel>
      <form
        className="flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <label className="sr-only" htmlFor="today-empty-worker">
          Worker
        </label>
        <select
          id="today-empty-worker"
          value={target.id}
          onChange={(e) => {
            setWorkerId(e.target.value);
            setSentTo(null);
          }}
          className="shrink-0 rounded-md border border-card-strong bg-card px-2 py-2 text-[13px] text-ink"
        >
          {crew.map((w) => (
            <option key={w.id} value={w.id}>
              {w.name}
            </option>
          ))}
        </select>
        <label className="sr-only" htmlFor="today-empty-ask">
          What should {target.name} do?
        </label>
        <input
          id="today-empty-ask"
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            setSentTo(null);
          }}
          placeholder={`What should ${target.name} do?`}
          className="min-w-0 flex-1 rounded-md border border-card-strong bg-surface px-3 py-2 text-[13px] text-ink placeholder:text-ink-faint focus:outline-none focus-visible:ring-1 focus-visible:ring-accent/50"
        />
        <button
          type="submit"
          disabled={busy || !text.trim()}
          className="shrink-0 rounded-md bg-accent px-4 py-2 text-[12.5px] font-medium text-white hover:opacity-90 disabled:opacity-40"
        >
          {busy ? 'Sending…' : 'Send'}
        </button>
      </form>
      {sentTo && (
        <span className="text-[11.5px] text-ink-faint">Sent — it shows up under Working while {sentTo} is on it.</span>
      )}
    </section>
  );
}

/// Every worker's next shift, soonest first, each with a way to start it now.
function UpNext({ upcoming, now }: { upcoming: UpcomingRow[]; now: number }) {
  const workers = useWorkersStore((s) => s.workers);
  const workShiftNow = useWorkersStore((s) => s.workShiftNow);
  const [started, setStarted] = useState<Record<string, boolean>>({});
  if (upcoming.length === 0) {
    return (
      <section className="flex flex-col gap-2">
        <SectionLabel>Up next</SectionLabel>
        <p className="text-[12.5px] text-ink-muted">
          No shifts are scheduled — every worker here works when you ask. Hand one a job above.
        </p>
      </section>
    );
  }
  return (
    <section className="flex flex-col gap-2">
      <SectionLabel>Up next</SectionLabel>
      <div className="overflow-hidden rounded-lg border border-card">
        {upcoming.map((row) => {
          const worker = workers[row.workerId];
          return (
            <div key={row.workerId} className="flex items-center gap-3 border-b border-card px-3.5 py-2.5 last:border-b-0">
              {worker && <WorkerAvatar worker={worker} size="xs" />}
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[13px] text-ink">{row.workerName}</span>
                <span className="block truncate text-[11.5px] text-ink-faint">{row.cadence}</span>
              </span>
              <span className="shrink-0 text-right text-[12px] tabular-nums text-ink-muted">
                {clockStamp(row.at)}
                <span className="block text-[11px] text-ink-faint">{untilLabel(row.at, now)}</span>
              </span>
              <button
                onClick={() => {
                  setStarted((s) => ({ ...s, [row.workerId]: true }));
                  void workShiftNow(row.workerId);
                }}
                disabled={started[row.workerId]}
                className="shrink-0 rounded-md border border-card-strong px-2.5 py-1 text-[11.5px] text-ink-muted hover:bg-card-strong hover:text-ink disabled:opacity-50"
              >
                {started[row.workerId] ? 'Started' : 'Work now'}
              </button>
            </div>
          );
        })}
      </div>
    </section>
  );
}
