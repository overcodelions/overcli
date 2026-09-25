// "Run these services on this branch", from the changes bar of a chat or flow.
//
// The conversation already knows which files it changed and which checkout
// they are in; the services stack already knows which repo and subpath each
// service runs from. This joins the two and hands the result to the same
// rebind the Services pane uses — then starts or restarts what moved, since a
// rebind on its own leaves a stopped service stopped.
//
// Always a click, never automatic: see the header of `servicesRebindPlan.ts`.

import { useCallback, useEffect, useRef, useState } from 'react';
import type { StackView } from '@shared/services';
import { runnableServices } from '../servicesGrouping';
import { planChangedFilesRebind, type ChangedCheckout, type RebindTarget } from '../servicesRebindPlan';
import { worktreeChoices, type WorktreeChoice } from '../worktreeChoices';
import { isServiceLive, logKey, useServicesStore } from '../servicesStore';

interface Row {
  workspaceId: string;
  serviceId: string;
  name: string;
  subpath?: string;
  target: RebindTarget;
  /// `here` = already bound to this checkout; nothing to move.
  kind: 'move' | 'here' | 'pinned';
  pinnedRef?: string;
  status: StackView['runtimes'][number]['status'] | 'stopped';
  /// Names of dependencies not ready yet. A bulk start goes layer by layer, so
  /// a stopped service with these is queued behind them, not refusing to run.
  waitingOn: string[];
}

export function RunOnBranchButton({
  workspaceIds,
  checkouts,
  files,
}: {
  workspaceIds: readonly string[];
  checkouts: readonly ChangedCheckout[];
  files: readonly string[];
}) {
  const startMany = useServicesStore((s) => s.startMany);
  const loadAll = useServicesStore((s) => s.loadAll);
  const [rows, setRows] = useState<Row[]>([]);
  const [open, setOpen] = useState(false);
  const [ticked, setTicked] = useState<Record<string, boolean>>({});
  const [needsInstall, setNeedsInstall] = useState<string[]>([]);
  /// Set between the click and the first sign the engine picked it up.
  const [initiating, setInitiating] = useState(false);
  /// The popover opens on the click and fills in behind this: `refresh` runs
  /// `git worktree list` per checkout, which on a few repos is long enough for
  /// the click to read as dead if the popover waits for it.
  const [refreshing, setRefreshing] = useState(false);
  /// Rows whose own Restart button is in flight. That invoke resolves only
  /// once the service is ready again, and without this the button says exactly
  /// what it said before for the whole of a cold restart.
  const [restarting, setRestarting] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  /// What the last click asked to start, until each is live or has failed.
  /// Without it a service queued behind a slow dependency reads as "stopped"
  /// and the button looks like it did nothing.
  const [pending, setPending] = useState<string[]>([]);

  const wsKey = workspaceIds.join('|');
  const checkoutKey = checkouts.map((c) => `${c.prefix ?? ''}:${c.path}`).join('|');
  const filesKey = files.join('\n');
  const inputs = useRef({ workspaceIds, checkouts, files });
  inputs.current = { workspaceIds, checkouts, files };

  const refresh = useCallback(async (): Promise<Row[]> => {
    const { workspaceIds, checkouts, files } = inputs.current;
    if (workspaceIds.length === 0 || checkouts.length === 0 || files.length === 0) return [];
    const views: StackView[] = await window.overcli.invoke('services:viewAll', [...workspaceIds]);
    // One `git worktree list` per checkout, not per service: a monorepo's ten
    // services share one answer.
    const byPath = new Map<string, Promise<WorktreeChoice[]>>();
    const choices: Record<string, WorktreeChoice[]> = {};
    await Promise.all(
      views.flatMap((view) =>
        view.bindings.map(async (b) => {
          if (!byPath.has(b.path)) byPath.set(b.path, worktreeChoices(b.path));
          choices[b.serviceId] = await byPath.get(b.path)!;
        }),
      ),
    );
    const out: Row[] = [];
    for (const view of views) {
      const paths = Object.fromEntries(view.bindings.map((b) => [b.serviceId, b.path]));
      // Same rows the Services pane shows — never a base whose copies are
      // what actually runs.
      const plan = planChangedFilesRebind(runnableServices(view.services), paths, choices, checkouts, files);
      const base = (id: string) => {
        const spec = view.services.find((s) => s.id === id);
        return {
          workspaceId: view.workspaceId,
          serviceId: id,
          name: spec?.name ?? id,
          subpath: spec?.subpath,
          status: view.runtimes.find((r) => r.serviceId === id)?.status ?? ('stopped' as const),
          waitingOn: (spec?.deps ?? [])
            .filter((dep) => {
              const rt = view.runtimes.find((r) => r.serviceId === dep);
              return rt?.status !== 'ready' && rt?.status !== 'done';
            })
            .map((dep) => view.services.find((s) => s.id === dep)?.name ?? dep),
        };
      };
      for (const t of plan.targets) out.push({ ...base(t.serviceId), target: t, kind: 'move' });
      for (const id of plan.alreadyThere) {
        const binding = view.bindings.find((b) => b.serviceId === id)!;
        out.push({ ...base(id), target: { serviceId: id, ref: binding.ref, path: binding.path }, kind: 'here' });
      }
      for (const p of plan.pinned) {
        out.push({ ...base(p.serviceId), target: p.target, kind: 'pinned', pinnedRef: p.pinnedRef });
      }
    }
    return out;
  }, []);

  useEffect(() => {
    let cancelled = false;
    const reload = () =>
      void refresh()
        .then((next) => {
          if (!cancelled) setRows(next);
        })
        .catch(() => {});
    reload();
    // Status and rebind events are what keep the "N running" count honest
    // while services come up in the background. Coalesced: a start is a burst.
    let timer: ReturnType<typeof setTimeout> | undefined;
    const off = window.overcli.onMainEvent((e) => {
      if (
        (e.type === 'serviceStatus' || e.type === 'serviceRebound') &&
        inputs.current.workspaceIds.includes(e.workspaceId)
      ) {
        if (timer) clearTimeout(timer);
        timer = setTimeout(reload, 250);
      }
    });
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
      off();
    };
  }, [refresh, wsKey, checkoutKey, filesKey]);

  // The click is acknowledged; the moment any chosen service changes state
  // (moved here, starting), the engine has it and the label can go.
  // Rows only reload on the click's own refresh or a status/rebind event for
  // these stacks, so a change after the click means the engine has it. The
  // timer covers a click that changed nothing visible (all already running).
  const rowsAtClick = useRef<Row[] | null>(null);
  useEffect(() => {
    if (initiating && rowsAtClick.current && rows !== rowsAtClick.current) setInitiating(false);
    setPending((keys) => {
      const next = keys.filter((k) => {
        const r = rows.find((row) => logKey(row.workspaceId, row.serviceId) === k);
        // Settled only once it runs from THIS checkout. A running service being
        // moved passes through "stopped, still elsewhere" first — that is the
        // engine at work, not a finished click.
        if (!r) return false;
        if (r.status === 'failed') return false;
        return !(r.kind === 'here' && (isServiceLive(r.status) || r.status === 'done'));
      });
      return next.length === keys.length ? keys : next;
    });
  }, [rows, initiating]);
  // Outside-click close. A full-screen overlay would be simpler, but it would
  // also sit on top of the log drawer this popover opens — and reading a log
  // while picking the next service to start is the whole point of that link.
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const el = e.target instanceof Element ? e.target : null;
      if (!el) return;
      if (root.current?.contains(el)) return;
      if (el.closest('[data-service-log-drawer]')) return;
      setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  useEffect(() => {
    if (!initiating) return;
    const t = setTimeout(() => setInitiating(false), 8000);
    return () => clearTimeout(t);
  }, [initiating]);

  if (rows.length === 0) return null;
  const key = (r: Row) => logKey(r.workspaceId, r.serviceId);
  /// Whether a row starts ticked. Pinned services are opt-in: unpinning is a
  /// stronger act than moving.
  const defaultTick = (r: Row) => r.kind !== 'pinned' && !(r.kind === 'here' && isServiceLive(r.status));
  // Already running from this checkout: nothing to switch, so not part of the
  // bulk action — a restart there is its own button, and ticking one by
  // accident would bounce a service that is mid-start.
  const selectable = (r: Row) => !(r.kind === 'here' && isServiceLive(r.status));
  const selectableRows = rows.filter(selectable);
  const chosen = selectableRows.filter((r) => ticked[key(r)]);
  const branch = rows.find((r) => r.kind !== 'here')?.target.ref ?? rows[0].target.ref;

  const owners = rows.length;
  const hereRows = rows.filter((r) => r.kind === 'here');
  const liveHere = hereRows.filter((r) => isServiceLive(r.status));
  const readyHere = hereRows.filter((r) => r.status === 'ready').length;
  const startingHere = liveHere.length - readyHere;
  const failedHere = hereRows.filter((r) => r.status === 'failed').length;

  const openPopover = () => {
    // Open on the click, with the rows already in hand — status and rebind
    // events have been keeping them current all along. The refresh below only
    // confirms them.
    setError(null);
    setTicked(Object.fromEntries(rows.map((r) => [key(r), defaultTick(r)])));
    setOpen(true);
    setRefreshing(true);
    void (async () => {
      const next = await refresh().catch(() => rows);
      setRows(next);
      // Ticks the user has already changed win: the refresh is a confirmation,
      // not a reason to undo a choice made while it was in flight.
      setTicked((t) =>
        Object.fromEntries(next.map((r) => [key(r), key(r) in t ? t[key(r)] : defaultTick(r)])),
      );
      setRefreshing(false);
      const dirs = [...new Set(next.map(serviceDir))];
      setNeedsInstall(await window.overcli.invoke('services:needsInstall', dirs).catch(() => []));
    })();
  };

  /// Its output, in the side drawer. Deliberately does not close the popover:
  /// the usual move is reading one service's log and then starting the next.
  const openLog = (r: Row) => {
    void useServicesStore.getState().openLogDrawer(r.workspaceId, r.serviceId);
  };

  const restartRow = (r: Row) => {
    const k = key(r);
    if (restarting.includes(k)) return;
    setRestarting((keys) => [...keys, k]);
    // Resolves only once the service is ready again, which is exactly how long
    // the button should keep saying so.
    void window.overcli
      .invoke('services:restart', { workspaceId: r.workspaceId, serviceId: r.serviceId })
      .catch((err) => setError(err instanceof Error ? err.message : String(err)))
      .finally(() => setRestarting((keys) => keys.filter((x) => x !== k)));
  };

  const run = () => {
    const picked = chosen;
    rowsAtClick.current = rows;
    // A restart of something already here stays live throughout; everything
    // else (moves, starts, unpins) is tracked until it lands.
    setPending(picked.filter((r) => !(r.kind === 'here' && isServiceLive(r.status))).map(key));
    setInitiating(true);
    setError(null);
    setOpen(false);
    // Not awaited by the UI: a rebind or start resolves only once the service
    // reports ready, which for a cold build is minutes. Progress arrives as
    // status events and shows on the button instead.
    void (async () => {
      const views: StackView[] = await window.overcli.invoke('services:viewAll', [...workspaceIds]);
      await Promise.all(
        picked.map(async (r) => {
          if (r.kind === 'pinned') {
            await window.overcli.invoke('services:setPinned', {
              workspaceId: r.workspaceId,
              serviceId: r.serviceId,
              pinnedRef: undefined,
            });
          }
          if (r.kind === 'here') {
            if (isServiceLive(r.status)) {
              await window.overcli.invoke('services:restart', { workspaceId: r.workspaceId, serviceId: r.serviceId });
            }
            return;
          }
          const binding = views
            .find((v) => v.workspaceId === r.workspaceId)
            ?.bindings.find((b) => b.serviceId === r.serviceId);
          // Keep the port it is on: moving to a branch is not a reason to
          // collide with whatever took the usual port meanwhile.
          const wasLive = isServiceLive(r.status);
          const moved = window.overcli.invoke('services:rebind', {
            workspaceId: r.workspaceId,
            serviceId: r.serviceId,
            ref: r.target.ref,
            path: r.target.path,
            portOffset: binding?.portOffset,
          });
          // A running service is relaunched by the rebind itself, and that
          // call only returns once it is ready — don't hold the stopped ones
          // hostage to it. A stopped one rebinds instantly, then starts.
          if (!wasLive) await moved;
        }),
      );
      // Starts everything chosen that is not already live, in dep order.
      await startMany(picked.filter((r) => !(r.kind !== 'here' && isServiceLive(r.status))).map(key));
      await loadAll([...workspaceIds]);
    })().catch((err) => {
      setError(err instanceof Error ? err.message : String(err));
      setInitiating(false);
      setPending([]);
    });
  };

  const moving = rows.filter((r) => r.kind === 'move').length;
  const queued = rows.filter((r) => pending.includes(key(r)));
  const blockers = [...new Set(queued.flatMap((r) => r.waitingOn))];
  // Tone of the idle button: how much of this code is actually running.
  const tone =
    queued.length > 0
      ? 'border-amber-500/60 bg-amber-500/15 text-amber-700 dark:text-amber-200 hover:bg-amber-500/25'
      : liveHere.length === 0
      ? 'border-accent/50 bg-accent/15 text-accent hover:bg-accent/25 hover:border-accent'
      : liveHere.length < owners
        ? 'border-amber-500/60 bg-amber-500/15 text-amber-700 dark:text-amber-200 hover:bg-amber-500/25'
        : 'border-emerald-500/60 bg-emerald-500/15 text-emerald-700 dark:text-emerald-200 hover:bg-emerald-500/25';

  let label: string;
  if (initiating) label = 'Initiating…';
  else if (queued.length > 0) {
    label = `Starting ${queued.length}`;
    if (liveHere.length > 0) label = `${liveHere.length}/${owners} running · ${label}`;
    if (blockers.length > 0) label += ` · waiting on ${blockers.slice(0, 2).join(', ')}${blockers.length > 2 ? '…' : ''}`;
  } else if (liveHere.length === 0) {
    label = moving > 0 ? `Run ${moving} service${moving === 1 ? '' : 's'} here` : 'Start services here';
  } else {
    label = `${liveHere.length}/${owners} running this branch`;
    if (startingHere > 0) label += ` · ${startingHere} starting`;
  }

  return (
    <div ref={root} className="relative flex items-center gap-1.5">
      {error && (
        <span className="max-w-[16rem] truncate text-[11px] text-red-600 dark:text-red-300" title={error}>
          {error}
        </span>
      )}
      <button
        onClick={() => (open ? setOpen(false) : openPopover())}
        title={
          hereRows.length > 0
            ? `${readyHere} ready, ${startingHere} starting, ${failedHere} failed on this checkout — click to manage`
            : 'Point the services that own these changes at this checkout and (re)start them'
        }
        className={
          'flex items-center gap-1.5 rounded-md border px-2 py-1 text-[11px] font-medium transition-colors ' +
          (open ? 'border-accent bg-accent text-white' : tone)
        }
      >
        {initiating || startingHere > 0 || queued.length > 0 ? (
          <span aria-hidden className="h-2 w-2 animate-pulse rounded-full bg-current" />
        ) : liveHere.length > 0 ? (
          <span aria-hidden className="h-2 w-2 rounded-full bg-current" />
        ) : (
          <span aria-hidden>▶</span>
        )}
        {label}
      </button>
      {open && (
        <>
          <div className="absolute bottom-full right-0 z-50 mb-2 w-96 overflow-hidden rounded-lg border border-accent/60 bg-surface-elevated text-xs shadow-2xl ring-1 ring-black/10">
            <div className="border-b border-card-strong bg-accent/10 px-3 py-2">
              <div className="text-[13px] font-semibold text-ink">Run services on this branch</div>
              <div className="mt-0.5 truncate font-mono text-[11px] text-accent">⎇ {branch}</div>
            </div>
            <div className="max-h-[50vh] overflow-y-auto p-2">
              {selectableRows.length > 1 && (
                // A repo with no subpaths makes every service in it an owner,
                // so the list can be long; one box flips the lot.
                <label className="mb-1 flex cursor-pointer items-center gap-2 border-b border-card-strong px-2 pb-2 pt-1 text-[11px] text-ink-muted">
                  <input
                    type="checkbox"
                    checked={chosen.length === selectableRows.length}
                    ref={(el) => {
                      if (el) el.indeterminate = chosen.length > 0 && chosen.length < selectableRows.length;
                    }}
                    onChange={() => {
                      const on = chosen.length !== selectableRows.length;
                      setTicked(Object.fromEntries(selectableRows.map((r) => [key(r), on])));
                    }}
                  />
                  <span className="flex-1">
                    {chosen.length === 0
                      ? 'Select all'
                      : chosen.length === selectableRows.length
                        ? 'Deselect all'
                        : `${chosen.length} of ${selectableRows.length} selected`}
                  </span>
                  {chosen.length > 0 && chosen.length < selectableRows.length && (
                    <button
                      type="button"
                      className="text-accent hover:underline"
                      onClick={(e) => {
                        e.preventDefault();
                        setTicked({});
                      }}
                    >
                      Clear
                    </button>
                  )}
                </label>
              )}
              {rows.map((r) =>
                selectable(r) ? (
                  <label
                    key={key(r)}
                    className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-[12px] hover:bg-card-strong"
                  >
                    <input
                      type="checkbox"
                      checked={!!ticked[key(r)]}
                      onChange={(e) => setTicked((t) => ({ ...t, [key(r)]: e.target.checked }))}
                    />
                    <span className="flex-1 truncate text-ink">{r.name}</span>
                    <StatusChip row={r} />
                    <LogsLink row={r} onOpen={openLog} />
                    <span className="shrink-0 rounded bg-card-strong px-1.5 py-0.5 text-[10px] text-ink-muted">
                      {r.kind === 'move' && (isServiceLive(r.status) ? 'move + restart' : 'move + start')}
                      {r.kind === 'here' && 'start'}
                      {r.kind === 'pinned' && `pinned to ${r.pinnedRef} — unpin`}
                    </span>
                  </label>
                ) : (
                  <div key={key(r)} className="flex items-center gap-2 rounded-md px-2 py-1.5 text-[12px]">
                    {/* Keeps names aligned with the checkbox rows. */}
                    <span aria-hidden className="inline-block w-[13px]" />
                    <span className="flex-1 truncate text-ink">{r.name}</span>
                    <StatusChip row={r} />
                    <LogsLink row={r} onOpen={openLog} />
                    <button
                      type="button"
                      disabled={restarting.includes(key(r))}
                      title="Restart now — it is already running this branch"
                      className="shrink-0 rounded border border-card-strong px-1.5 py-0.5 text-[10px] text-ink-muted hover:border-accent hover:text-accent disabled:opacity-60 disabled:hover:border-card-strong disabled:hover:text-ink-muted"
                      onClick={() => restartRow(r)}
                    >
                      {restarting.includes(key(r)) ? '⟳ Restarting…' : '↻ Restart'}
                    </button>
                  </div>
                ),
              )}
              {needsInstall.length > 0 && (
                <div className="mt-1.5 rounded bg-amber-500/10 px-2 py-1 text-[11px] text-amber-700 dark:text-amber-200">
                  No node_modules in {needsInstall.length === 1 ? 'this checkout' : `${needsInstall.length} folders`} —
                  install first or the start will fail.
                </div>
              )}
            </div>
            <div className="flex justify-end gap-2 border-t border-card-strong px-3 py-2">
              <button className="px-2 py-1 text-[12px] text-ink-muted hover:text-ink" onClick={() => setOpen(false)}>
                Close
              </button>
              <button
                className="rounded-md bg-accent px-3 py-1.5 text-[12px] font-semibold text-white hover:brightness-110 disabled:opacity-50"
                disabled={chosen.length === 0}
                onClick={run}
              >
                {`Switch & start ${chosen.length}`}
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

/// Takes the user to this service's output without taking them out of the
/// conversation — see `ServiceLogDrawer`. Inside a <label>, so the click has to
/// be kept off the checkbox it would otherwise toggle.
function LogsLink({ row, onOpen }: { row: Row; onOpen: (row: Row) => void }) {
  return (
    <button
      type="button"
      title="Show this service's output beside the chat"
      className="shrink-0 rounded px-1 py-0.5 text-[10px] text-ink-faint hover:bg-card-strong hover:text-accent"
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        onOpen(row);
      }}
    >
      logs
    </button>
  );
}

/// Whether this service is running THIS branch's code right now. Only a
/// service bound here can be; one elsewhere is running other code, live or not.
function StatusChip({ row }: { row: Row }) {
  if (row.kind !== 'here') {
    return <span className="shrink-0 text-[10px] text-ink-faint">elsewhere</span>;
  }
  const map: Partial<Record<Row['status'], [string, string]>> = {
    ready: ['on this branch', 'text-emerald-600 dark:text-emerald-300'],
    starting: ['starting', 'text-amber-600 dark:text-amber-300'],
    unready: ['not ready', 'text-amber-600 dark:text-amber-300'],
    failed: ['failed', 'text-red-600 dark:text-red-300'],
  };
  const [text, cls] =
    map[row.status] ??
    (row.waitingOn.length > 0
      ? [`waiting on ${row.waitingOn.join(', ')}`, 'text-amber-600 dark:text-amber-300']
      : ['stopped', 'text-ink-faint']);
  return <span className={`shrink-0 text-[10px] ${cls}`}>● {text}</span>;
}

/// The folder a service actually runs in on its target checkout.
function serviceDir(row: Row): string {
  const root = row.target.path.replace(/[\\/]+$/, '');
  const sub = (row.subpath ?? '').replace(/^\.\/?/, '').replace(/[\\/]+$/, '');
  return sub ? `${root}/${sub}` : root;
}
