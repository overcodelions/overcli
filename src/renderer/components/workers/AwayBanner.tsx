// Shown across the top of every Workers screen while the crew is away, so a
// quiet Today page reads as "you told them to stop" rather than as a crew
// that broke. It is also where a return date other than the rail's presets
// gets picked.

import { useTickingNow } from "../../hooks";
import { useWorkersStore } from "../../workersStore";
import { awayLine, dateValueOf, morningAfter, morningOf } from "./awayMode";

export function AwayBanner() {
  const away = useWorkersStore((s) => s.away);
  const heldCount = useWorkersStore((s) => s.heldHandoffs.length);
  const goAway = useWorkersStore((s) => s.goAway);
  const comeBack = useWorkersStore((s) => s.comeBack);
  const now = useTickingNow(60_000);
  if (!away) return null;
  return (
    <div className="shrink-0 px-6 pt-4">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-md border border-amber-400/40 bg-amber-400/5 px-3 py-2 text-[11px]">
        <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-amber-400" />
        <span className="min-w-0 flex-1 text-ink-muted">
          <span className="font-medium text-ink">{awayLine(away, now)}.</span>{" "}
          No shifts start and handoffs wait
          {heldCount > 0 ? ` (${heldCount} waiting)` : ""}. Anything you start by hand still runs.
        </span>
        <label className="flex shrink-0 items-center gap-1.5 text-ink-faint">
          Back on
          <input
            type="date"
            value={away.until !== undefined ? dateValueOf(away.until) : ""}
            min={dateValueOf(morningAfter(now, 1))}
            onChange={(e) => {
              if (!e.target.value) return void goAway();
              const until = morningOf(e.target.value);
              if (until !== null) void goAway(until);
            }}
            title="The crew comes back at 9am that day. Clear it to stay away until you come back by hand."
            className="field px-1.5 py-0.5 text-[11px]"
          />
        </label>
        <button
          onClick={() => void comeBack()}
          title="Back on duty — every worker's schedule restarts from now"
          className="shrink-0 rounded-md bg-accent px-2.5 py-1 text-white hover:opacity-90"
        >
          I&apos;m back
        </button>
      </div>
    </div>
  );
}
