// The Workers tab's front page, in three columns that each do one job: the
// sidebar is WHO (the roster), the centre is WHAT NEEDS YOU and what is
// working, and the rail on the right is THE DAY — how it went and what is
// next.
//
// It was one long column: a day headline, a tick strip, pinned decisions, a
// spine of every finished job, and the whole crew as a grid of cards. Every
// fact was on the page three or four times — "Triage has two paused" was in
// the sidebar, a card, the crew grid and the spine — and what needed you sat
// halfway down it. Now each fact is drawn once, in the column whose job it is,
// and the centre leads with the only number that decides whether you have
// anything to do.

import { useEffect, useMemo, useRef, useState } from 'react';

import { useFlowsStore } from '../../flowsStore';
import { useOrchestratorStore } from '../../orchestratorStore';
import { useRunningMap } from '../../runnersStore';
import { useStore } from '../../store';
import { useWorkersStore } from '../../workersStore';
import { InboxList, defaultItem, findRow, type DigestModel, type OpenItem } from './TodayDigest';
import { TodayEmpty } from './TodayEmpty';
import { TodayReader } from './TodayReader';
import { clearStateOf, useTodayCleared } from './todayCleared';
import { buildTodaySpine } from './todaySpine';
import { earlierDays, finishedJobs } from './todayLayout';
import { useDigest } from './useDigest';
import { buildWorkQueue, upcomingShifts, type QueueRow } from './workQueue';
import { useDeliverables } from './useDeliverables';

/// The item Today had open when you last left it, for this session.
let lastPicked: OpenItem = null;

export function TodayPane() {
  const workers = useWorkersStore((s) => s.workers);
  const nextShiftAt = useWorkersStore((s) => s.nextShiftAt);
  const shiftProgress = useWorkersStore((s) => s.shiftProgress);
  const orchestrations = useOrchestratorStore((s) => s.orchestrations);
  const runs = useFlowsStore((s) => s.runs);
  const runsLoaded = useFlowsStore((s) => s.runsLoaded);
  const runners = useRunningMap();

  // Every stamp here is an age or a countdown, and the now-line is the page's
  // whole spine — a minute is as coarse as this may ever get.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(t);
  }, []);

  const previewNoWork = useWorkersStore((s) => s.previewNoWork);
  const setPreviewNoWork = useWorkersStore((s) => s.setPreviewNoWork);
  const previewEmpty = useWorkersStore((s) => s.previewEmpty);
  const setPreviewEmpty = useWorkersStore((s) => s.setPreviewEmpty);
  const showDebug = useStore((s) => s.settings.showDebug ?? false);
  const queue = useMemo(
    () =>
      buildWorkQueue(previewNoWork ? {} : orchestrations, runs, workers, previewNoWork ? {} : shiftProgress, now, runsLoaded, runners),
    [orchestrations, runs, workers, shiftProgress, now, runsLoaded, runners, previewNoWork],
  );
  // Every pending shift, soonest first. No horizon: the spine trims it
  // itself, and the empty reader lists them all.
  const soon = useMemo(
    () => upcomingShifts(workers, nextShiftAt, shiftProgress, now, Infinity),
    [workers, nextShiftAt, shiftProgress, now],
  );
  const spine = useMemo(() => buildTodaySpine(queue, soon, now), [queue, soon, now]);

  const finishedToday = useMemo(() => finishedJobs(spine), [spine]);
  // The week before today, so what landed overnight is still here.
  const earlier = useMemo(() => earlierDays(queue.finished, now), [queue.finished, now]);
  const summarised = useMemo(
    () => [...finishedToday, ...earlier.flatMap((g) => g.rows)],
    [finishedToday, earlier],
  );
  const filed = useDeliverables(summarised, now);
  const digest = useDigest(summarised, filed);
  const model: DigestModel = useMemo(
    () => ({
      spine,
      now,
      // A queue you work through: the one that has waited longest first.
      needs: [...spine.pinned].reverse(),
      working: spine.live,
      // A quiet SHIFT looked and found nothing. A quiet ERRAND is a question
      // the worker answered in chat — an outcome, and it belongs with the rest.
      done: finishedToday.filter((row) => !(row.status === 'quiet' && row.task === 'shift')),
      quiet: finishedToday.filter((row) => row.status === 'quiet' && row.task === 'shift'),
      earlier,
      filed,
      digest,
    }),
    [spine, now, finishedToday, earlier, filed, digest],
  );

  // What the reader shows. Something is always open — the oldest thing
  // waiting on you, else the newest result — so the page never lands on an
  // empty half. An item that leaves the list (answered, rejected) falls back
  // to the default rather than leaving a stale reader behind.
  // Survives leaving the tab: Chat and back should land on the item you had
  // open, not on whatever the inbox would pick fresh.
  const [picked, setPicked] = useState<OpenItem>(() => lastPicked);
  useEffect(() => {
    lastPicked = picked;
  }, [picked]);
  const pickedRow = picked ? findRow(model, picked) : undefined;
  // Keep the open item's key on the row it resolved to, so the list still
  // highlights it after an answer folds into a group.
  useEffect(() => {
    if (picked && pickedRow && pickedRow.key !== picked.key) setPicked({ kind: picked.kind, key: pickedRow.key });
  }, [picked, pickedRow]);

  // Clearing a decision. When the thing you had open leaves "Needs you" —
  // you answered it, continued it, rejected it — the reader says so for a
  // moment before moving on, instead of silently swapping to the next item
  // (which read as your answer vanishing). Then it opens what is next, like
  // clearing an inbox; the run you handed back is under Working if you want
  // to watch it.
  const lastNeeds = useRef<QueueRow | null>(null);
  const [handoff, setHandoff] = useState<QueueRow | null>(null);
  useEffect(() => {
    // Reading something else: whatever decision was open is no longer the
    // one you are clearing.
    if (picked && picked.kind !== 'needs') {
      lastNeeds.current = null;
      return;
    }
    if (picked?.kind === 'needs' && pickedRow) {
      lastNeeds.current = pickedRow;
      return;
    }
    if (picked?.kind === 'needs' && !pickedRow && lastNeeds.current?.key === picked.key) {
      setHandoff(lastNeeds.current);
      lastNeeds.current = null;
      setPicked(null);
    }
  }, [picked, pickedRow]);
  useEffect(() => {
    if (!handoff) return;
    const t = window.setTimeout(() => setHandoff(null), HANDOFF_MS);
    return () => window.clearTimeout(t);
  }, [handoff]);
  // The default item stands in for "whatever you had" — which, when you
  // opened nothing, is the oldest decision. Track it too, so answering the
  // item the inbox opened on gets the same handoff.
  const cleared = useTodayCleared((s) => s.cleared);
  const open = pickedRow
    ? picked
    : defaultItem(model, (row) => clearStateOf(cleared, row.key, row.at) === 'cleared');
  const openRow = open ? findRow(model, open) : undefined;
  // A file opened from the reader belongs to the item it came from: reading
  // the next item under the last one's report is the same mistake as
  // carrying it onto another page.
  const closeFile = useStore((s) => s.closeFile);
  const readerKey = open?.key;
  const shownKey = useRef(readerKey);
  useEffect(() => {
    if (shownKey.current === readerKey) return;
    shownKey.current = readerKey;
    closeFile();
  }, [readerKey, closeFile]);
  useEffect(() => {
    if (!picked && open?.kind === 'needs' && openRow) lastNeeds.current = openRow;
  }, [picked, open?.kind, openRow]);
  useEffect(() => {
    const was = lastNeeds.current;
    if (!picked && was && !model.needs.some((r) => r.key === was.key)) {
      setHandoff(was);
      lastNeeds.current = null;
    }
  }, [picked, model.needs]);
  const handedBack = handoff
    ? [...model.working, ...model.done].find((r) => r.key === handoff.key)
    : undefined;

  return (
    <div className="flex min-h-0 flex-1">
      <div className="min-h-0 w-[420px] shrink-0 overflow-y-auto border-r border-card px-5 pb-10 pt-6">
        <InboxList model={model} open={open} onOpen={setPicked} />
        {/* Debug only: the empty states are screens you can never reach
            again once the crew has worked, so they need a way in. */}
        {showDebug && (
          <div className="mt-8 flex flex-wrap gap-1.5 border-t border-card pt-3 text-[10.5px] text-ink-faint">
            <span>Preview:</span>
            <button onClick={() => setPreviewNoWork(!previewNoWork)} className={previewNoWork ? 'text-amber-500' : 'hover:text-ink'}>
              {previewNoWork ? 'no work yet (on)' : 'no work yet'}
            </button>
            <span>·</span>
            <button onClick={() => setPreviewEmpty(!previewEmpty)} className={previewEmpty ? 'text-amber-500' : 'hover:text-ink'}>
              nobody hired
            </button>
          </div>
        )}
      </div>
      {handoff ? (
        <HandoffNote
          row={handoff}
          stillWorking={!!handedBack && model.working.some((r) => r.key === handoff.key)}
          onWatch={
            handedBack
              ? () => {
                  setHandoff(null);
                  setPicked({ kind: 'done', key: handoff.key });
                }
              : undefined
          }
          onNext={() => setHandoff(null)}
        />
      ) : open && openRow ? (
        <TodayReader
          row={openRow}
          kind={open.kind}
          file={model.filed[openRow.key] ?? null}
          digest={model.digest[openRow.key]}
          now={now}
        />
      ) : (
        <TodayEmpty upcoming={soon} now={now} />
      )}
    </div>
  );
}

/// How long the handoff note stays before the next item opens.
const HANDOFF_MS = 2600;

/// "Handed back" — the beat between clearing one decision and the next.
function HandoffNote({
  row,
  stillWorking,
  onWatch,
  onNext,
}: {
  row: QueueRow;
  stillWorking: boolean;
  onWatch?: () => void;
  onNext: () => void;
}) {
  return (
    <div className="flex flex-1 items-center justify-center px-10">
      <div className="flex max-w-[520px] flex-col items-center gap-3 text-center">
        <span
          aria-hidden
          className="flex h-10 w-10 items-center justify-center rounded-full text-[18px] text-emerald-400"
          style={{ background: 'color-mix(in srgb, #34d399 14%, transparent)' }}
        >
          ✓
        </span>
        <p className="text-[16px] font-semibold text-ink" role="status">
          {stillWorking ? `Back to ${row.workerName}` : 'Done'}
        </p>
        <p className="text-[13px] leading-relaxed text-ink-muted">
          {stillWorking
            ? `${row.workerName} is working on “${row.title}” again. It’s under Working if you want to watch.`
            : `“${row.title}” is off your list.`}
        </p>
        <div className="mt-1 flex gap-2">
          {onWatch && (
            <button
              onClick={onWatch}
              className="rounded-md border border-card-strong px-3 py-1.5 text-[12px] text-ink hover:bg-card-strong"
            >
              {stillWorking ? 'Watch it' : 'Open it'}
            </button>
          )}
          <button onClick={onNext} className="rounded-md bg-accent px-3 py-1.5 text-[12px] font-medium text-white hover:opacity-90">
            Next
          </button>
        </div>
      </div>
    </div>
  );
}
