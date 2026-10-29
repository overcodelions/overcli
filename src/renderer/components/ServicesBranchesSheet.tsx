// A branch for each service, picked one after another and moved together.
//
// The row's own menu moves a service the moment you click; the toolbar's
// switch moves every service to one ref. Setting up a stack where each
// service wants something different took both, a service at a time, with a
// relaunch between every click. Here the list is on the left, a branch search
// for the selected service on the right, and Enter picks and moves to the
// next service — nothing changes until Apply.
//
// The folder rules (who moves with a checkout, which picks collide) live in
// `servicesBranchPicks.ts`; this file is the sheet around them.

import { useEffect, useMemo, useRef, useState } from 'react';
import type { ServiceSpec } from '@shared/services';
import { isServiceLive, logKey, splitKey, useServicesStore } from '../servicesStore';
import { useStore } from '../store';
import { groupServices } from '../servicesGrouping';
import { rankRefs, refChoices, shortenPath, type BranchChoice, type WorktreeChoice } from '../worktreeChoices';
import { landsAs, planPicks, resolveRef, stepTarget, type BranchPick, type PickStep } from '../servicesBranchPicks';

interface Row {
  key: string;
  workspaceId: string;
  spec: ServiceSpec;
  ref: string;
  path: string;
  live: boolean;
}

interface Refs {
  worktrees: WorktreeChoice[];
  branches: BranchChoice[];
  defaultBranch?: string;
}

interface Option {
  id: string;
  label: string;
  note?: string;
  pick: BranchPick;
}

interface Picked {
  pick: BranchPick;
  pin: boolean;
}

type Outcome = { ok: true } | { ok: false; reason: string };

export function ServicesBranchesSheet({ onClose }: { onClose: () => void }) {
  const stacks = useServicesStore((s) => s.stacks);
  const rebind = useServicesStore((s) => s.rebind);
  const checkoutRef = useServicesStore((s) => s.checkoutRef);
  const setPinned = useServicesStore((s) => s.setPinned);
  const workspaces = useStore((s) => s.workspaces);
  const projects = useStore((s) => s.projects);

  // The list as the pane shows it — stack by stack, group by group — frozen at
  // open, so a relaunch mid-apply does not reshuffle the rows under the reader.
  // "Switch more" reads it again, from where Apply left everything.
  const [readAt, setReadAt] = useState(0);
  const sections = useMemo(() => {
    const several = Object.keys(stacks).length > 1;
    return Object.values(stacks).flatMap((stack) => {
      const owner =
        workspaces.find((w) => w.id === stack.workspaceId)?.name ??
        projects.find((p) => p.id === stack.workspaceId)?.name;
      return groupServices(stack.services).map((group) => ({
        id: `${stack.workspaceId}:${group.name}`,
        title: several && owner ? `${owner} · ${group.name}` : group.name,
        rows: group.entries
          .flatMap((e) => [e.spec, ...e.copies])
          .flatMap((spec): Row[] => {
            const binding = stack.bindings.find((b) => b.serviceId === spec.id);
            if (!binding) return [];
            const runtime = stack.runtimes.find((r) => r.serviceId === spec.id);
            return [{
              key: logKey(stack.workspaceId, spec.id),
              workspaceId: stack.workspaceId,
              spec,
              ref: binding.ref,
              path: binding.path,
              live: runtime ? isServiceLive(runtime.status) : false,
            }];
          }),
      }));
    }).filter((s) => s.rows.length > 0);
  }, [readAt]);
  const rows = useMemo(() => sections.flatMap((s) => s.rows), [sections]);
  const byKey = useMemo(() => new Map(rows.map((r) => [r.key, r])), [rows]);

  const [selected, setSelected] = useState(rows[0]?.key);
  const [picks, setPicks] = useState<Record<string, Picked>>({});
  const [query, setQuery] = useState('');
  const [highlight, setHighlight] = useState(0);
  const [together, setTogether] = useState(false);
  const [pin, setPin] = useState(false);
  const [refsByPath, setRefsByPath] = useState<Record<string, Refs>>({});
  const [applying, setApplying] = useState(false);
  const [outcomes, setOutcomes] = useState<Record<string, Outcome> | null>(null);
  const field = useRef<HTMLInputElement>(null);

  const current = selected ? byKey.get(selected) : undefined;
  const projectPath = projects.find((p) => p.id === current?.spec.projectId)?.path;
  const refs = current ? refsByPath[current.path] : undefined;

  // Once per folder. A bound folder that has gone — a flow deleting its
  // scratch tree is routine — falls back to the project's own checkout, which
  // is exactly where someone fixing that wants to choose from.
  useEffect(() => {
    if (!current || refsByPath[current.path]) return;
    let cancelled = false;
    void (async () => {
      let loaded = await refChoices(current.path);
      if (loaded.worktrees.length === 0 && loaded.branches.length === 0 && projectPath && projectPath !== current.path) {
        loaded = await refChoices(projectPath);
      }
      if (!cancelled) setRefsByPath((all) => ({ ...all, [current.path]: loaded }));
    })();
    return () => {
      cancelled = true;
    };
  }, [current, projectPath, refsByPath]);

  useEffect(() => {
    field.current?.focus();
  }, [selected]);

  // Same project and stack: the services one repository runs.
  const mates = useMemo(
    () =>
      current?.spec.projectId
        ? rows.filter(
            (r) => r.key !== current.key && r.workspaceId === current.workspaceId && r.spec.projectId === current.spec.projectId,
          )
        : [],
    [rows, current],
  );

  const plan = useMemo(
    () =>
      planPicks(
        rows,
        Object.fromEntries(Object.entries(picks).map(([key, p]) => [key, p.pick])),
      ),
    [rows, picks],
  );
  const stepFor = useMemo(() => new Map(plan.steps.map((s) => [s.key, s])), [plan]);
  const conflictFor = useMemo(() => new Map(plan.conflicts.map((c) => [c.key, c.with])), [plan]);

  // Where every service will be after Apply — what "on other services" counts.
  const destination = (row: Row): string => {
    const step = stepFor.get(row.key);
    if (!step) return row.ref;
    return stepTarget(step);
  };

  const options = useMemo(() => {
    if (!current || !refs) return { inUse: [] as (Option & { count: number })[], checkouts: [] as Option[], branches: [] as Option[], hidden: 0 };
    const counts = new Map<string, number>();
    for (const row of rows) {
      if (row.key === current.key) continue;
      const ref = destination(row);
      counts.set(ref, (counts.get(ref) ?? 0) + 1);
    }
    const needle = query.trim().toLowerCase();
    const inUse = [...counts.entries()]
      .filter(([ref]) => ref !== current.ref && ref !== refs.defaultBranch && (!needle || ref.toLowerCase().includes(needle)))
      .flatMap(([ref, count]) => {
        const pick = resolveRef(ref, refs);
        return pick ? [{ id: `use:${ref}`, label: ref, pick, count }] : [];
      })
      .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
    const shown = new Set(inUse.map((o) => o.label));
    const ranked = rankRefs({
      worktrees: refs.worktrees,
      branches: refs.branches,
      current: current.ref,
      defaultBranch: refs.defaultBranch,
      query,
      limit: 12,
    });
    return {
      inUse,
      checkouts: ranked.checkouts
        .filter((w) => !shown.has(w.ref))
        .map((w): Option => ({
          id: `tree:${w.path}`,
          label: w.ref,
          note: w.primary ? 'main checkout' : shortenPath(w.path),
          pick: { kind: 'checkout', ref: w.ref, path: w.path },
        })),
      branches: ranked.branches
        .filter((b) => !shown.has(landsAs({ kind: 'branch', ref: b.ref, remote: b.remote })))
        .map((b): Option => ({
          id: `branch:${b.ref}`,
          label: b.ref,
          note: b.when,
          pick: { kind: 'branch', ref: b.ref, remote: b.remote },
        })),
      hidden: ranked.hiddenBranches,
    };
  }, [current, refs, rows, query, stepFor]);
  const flat: Option[] = [...options.inUse, ...options.checkouts, ...options.branches];
  const lit = Math.min(highlight, Math.max(0, flat.length - 1));

  function select(key: string) {
    setSelected(key);
    setQuery('');
    setHighlight(0);
  }

  function nextWithoutPick(from: string, after: Record<string, Picked>): string {
    const at = rows.findIndex((r) => r.key === from);
    for (let i = 1; i <= rows.length; i++) {
      const row = rows[(at + i) % rows.length];
      if (!after[row.key]) return row.key;
    }
    return from;
  }

  function choose(option: Option) {
    if (!current || !refs) return;
    const next = { ...picks };
    const targets = together ? [current, ...mates] : [current];
    for (const row of targets) {
      // A mate gets the same ref from the shared list, which may be a
      // different folder than the one picked for the selected service.
      const pick = row === current ? option.pick : resolveRef(landsAs(option.pick), refs);
      if (!pick) continue;
      const stays = landsAs(pick) === row.ref && (pick.kind === 'branch' || pick.path === row.path);
      if (stays && !pin) delete next[row.key];
      else next[row.key] = { pick, pin };
    }
    setPicks(next);
    select(nextWithoutPick(current.key, next));
  }

  function unpick(key: string) {
    setPicks((all) => {
      const next = { ...all };
      delete next[key];
      return next;
    });
  }

  async function runStep(step: PickStep, failed: Set<string>): Promise<Outcome> {
    const { workspaceId, serviceId } = splitKey(step.key);
    if (step.kind === 'follow' && failed.has(step.after)) {
      return { ok: false, reason: `${byKey.get(step.after)?.spec.name ?? 'The folder'} did not move, so neither did this.` };
    }
    // A pin elsewhere would make the supervisor refuse the move, rightly. A
    // hand-picked branch replaces it, the same as the row's own menu.
    const spec = byKey.get(step.key)?.spec;
    const ref = stepTarget(step);
    if (spec?.pinnedRef && spec.pinnedRef !== ref) await setPinned(workspaceId, serviceId, undefined);
    try {
      if (step.kind === 'checkout') {
        const outcome = await checkoutRef(workspaceId, serviceId, step.ref);
        if (!outcome.ok) return outcome;
      } else {
        await rebind(workspaceId, serviceId, step.ref, step.path);
      }
      if (picks[step.key]?.pin) await setPinned(workspaceId, serviceId, ref);
      return { ok: true };
    } catch (err) {
      if (spec?.pinnedRef) await setPinned(workspaceId, serviceId, spec.pinnedRef);
      return { ok: false, reason: err instanceof Error ? err.message : String(err) };
    }
  }

  async function apply() {
    setApplying(true);
    const done: Record<string, Outcome> = {};
    const failed = new Set<string>();
    for (const step of plan.steps) {
      const outcome = await runStep(step, failed);
      if (!outcome.ok) failed.add(step.key);
      done[step.key] = outcome;
    }
    // A pin on a service already where it was picked to be: no move, just the pin.
    for (const [key, p] of Object.entries(picks)) {
      if (done[key] || !p.pin || conflictFor.has(key)) continue;
      const { workspaceId, serviceId } = splitKey(key);
      await setPinned(workspaceId, serviceId, landsAs(p.pick));
      done[key] = { ok: true };
    }
    setOutcomes(done);
    setApplying(false);
  }

  const moving = plan.steps.length;
  const restarting = plan.steps.filter((s) => byKey.get(s.key)?.live).length;
  const pinOnly = Object.entries(picks).filter(([key, p]) => p.pin && !stepFor.has(key) && !conflictFor.has(key)).length;
  const changes = moving + pinOnly;

  function onKey(e: React.KeyboardEvent) {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setHighlight(Math.min(lit + 1, flat.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setHighlight(Math.max(lit - 1, 0));
    } else if (e.key === 'Enter' && flat[lit]) {
      e.preventDefault();
      choose(flat[lit]);
    }
  }

  const close = () => {
    if (!applying) onClose();
  };

  let index = 0;
  const renderOption = (option: Option, extra?: React.ReactNode) => {
    const at = index++;
    const isCurrent = current && landsAs(option.pick) === current.ref && (option.pick.kind === 'branch' || option.pick.path === current.path);
    const isPicked = current && picks[current.key] && landsAs(picks[current.key].pick) === landsAs(option.pick);
    return (
      <button
        key={option.id}
        type="button"
        onMouseEnter={() => setHighlight(at)}
        onClick={() => choose(option)}
        className={
          'flex w-full items-center gap-2.5 rounded-[5px] px-2.5 py-1.5 text-left ' +
          (at === lit ? 'bg-card-strong' : '')
        }
      >
        {option.pick.kind === 'checkout' ? <FolderGlyph /> : <BranchGlyph />}
        <span className="min-w-0 flex-1 truncate font-mono text-[12px]" title={option.label}>
          {option.label}
        </span>
        {isCurrent && <span className="rounded border border-card-strong px-1.5 text-[10px] text-ink-muted">current</span>}
        {isPicked && <span className="rounded bg-accent/15 px-1.5 text-[10px] text-accent">picked</span>}
        {extra}
        {option.note && <span className="max-w-[160px] flex-shrink-0 truncate text-[10.5px] text-ink-faint">{option.note}</span>}
      </button>
    );
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={close}>
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Switch branches"
        className="flex h-[min(720px,calc(100vh-64px))] w-[min(1080px,calc(100vw-64px))] flex-col overflow-hidden rounded-lg border border-card-strong bg-surface-elevated shadow-2xl"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => e.key === 'Escape' && close()}
      >
        <div className="flex flex-shrink-0 items-start gap-3 border-b border-card px-5 py-3.5">
          <div className="min-w-0 flex-1">
            <div className="text-[15px] font-semibold text-ink">Switch branches</div>
            <div className="mt-1 text-[11.5px] text-ink-muted">
              Pick a branch for each service you want to move. Nothing changes until you apply.
            </div>
          </div>
          {!outcomes && (
            <div className="flex items-center gap-1.5 self-center text-[10.5px] text-ink-faint">
              <Kbd>↑↓</Kbd> results <Kbd>↵</Kbd> pick &amp; next
            </div>
          )}
          <button
            type="button"
            aria-label="Close"
            onClick={close}
            className="flex h-6 w-6 items-center justify-center rounded text-ink-muted hover:bg-card-strong hover:text-ink"
          >
            ✕
          </button>
        </div>

        {outcomes ? (
          <Results rows={rows} steps={plan.steps} outcomes={outcomes} onDone={onClose} onMore={() => {
            setOutcomes(null);
            setPicks({});
            setRefsByPath({});
            setReadAt(Date.now());
          }} />
        ) : (
          <>
            <div className="flex min-h-0 flex-1">
              <div className="flex w-[380px] flex-shrink-0 flex-col border-r border-card">
                <div className="flex items-center gap-2 px-4 pb-1 pt-3">
                  <span className="text-[11px] font-semibold text-ink-muted">Services</span>
                  <span className="text-[11px] text-ink-faint">{rows.length}</span>
                  <span className="flex-1" />
                  {current && (
                    <button
                      type="button"
                      className="rounded px-1.5 py-0.5 text-[11px] text-accent hover:bg-card-strong"
                      onClick={() => select(nextWithoutPick(current.key, picks))}
                    >
                      Next without a pick →
                    </button>
                  )}
                </div>
                <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
                  {sections.map((section) => (
                    <div key={section.id} className="mt-1.5">
                      <div className="px-2 pb-1 pt-1.5 text-[10.5px] font-semibold uppercase tracking-wide text-ink-faint">
                        {section.title}
                      </div>
                      {section.rows.map((row) => (
                        <ServiceRow
                          key={row.key}
                          row={row}
                          selected={row.key === selected}
                          picked={picks[row.key]}
                          step={stepFor.get(row.key)}
                          conflictWith={byKey.get(conflictFor.get(row.key) ?? '')?.spec.name}
                          followName={(() => {
                            const step = stepFor.get(row.key);
                            return step?.kind === 'follow' ? byKey.get(step.after)?.spec.name : undefined;
                          })()}
                          onSelect={() => select(row.key)}
                          onUnpick={() => unpick(row.key)}
                        />
                      ))}
                    </div>
                  ))}
                </div>
              </div>

              <div className="flex min-w-0 flex-1 flex-col">
                {current && (
                  <div className="flex flex-col gap-2.5 border-b border-card px-5 pb-3 pt-4">
                    <div className="flex items-baseline gap-2.5">
                      <span className="text-[14px] font-semibold text-ink">{current.spec.name}</span>
                      <span className="text-[11px] text-ink-faint">
                        {rows.indexOf(current) + 1} of {rows.length}
                      </span>
                      <span className="flex-1" />
                      <span className="text-[11px] text-ink-muted">
                        now on <span className="font-mono text-ink">{current.ref}</span>
                      </span>
                    </div>
                    <div className="truncate font-mono text-[11px] text-ink-faint" title={current.path}>
                      {current.path}
                      {current.live ? ' · running' : ''}
                    </div>
                    <input
                      ref={field}
                      aria-label={`Find a branch for ${current.spec.name}`}
                      className="h-9 w-full rounded-md border border-card-strong bg-surface px-3 font-mono text-[12px] outline-none focus:border-accent"
                      placeholder="Find a checkout or branch…"
                      value={query}
                      onChange={(e) => {
                        setQuery(e.target.value);
                        setHighlight(0);
                      }}
                      onKeyDown={onKey}
                    />
                  </div>
                )}

                <div className="min-h-0 flex-1 overflow-y-auto px-3 py-2">
                  {!refs ? (
                    <div className="px-2.5 py-3 text-[11px] text-ink-faint">Reading branches…</div>
                  ) : flat.length === 0 ? (
                    <div className="px-2.5 py-3 text-[11px] text-ink-faint">
                      {query ? `Nothing matches “${query}”.` : 'Nothing else to run this from.'}
                    </div>
                  ) : (
                    <>
                      {options.inUse.length > 0 && (
                        <OptionGroup title="On other services">
                          {options.inUse.map((o) =>
                            renderOption(o, <span className="flex-shrink-0 text-[10.5px] text-ink-muted">on {o.count}</span>),
                          )}
                        </OptionGroup>
                      )}
                      {options.checkouts.length > 0 && (
                        <OptionGroup title="Checkouts" note="folders that exist — nothing else moves">
                          {options.checkouts.map((o) => renderOption(o))}
                        </OptionGroup>
                      )}
                      {options.branches.length > 0 && (
                        <OptionGroup title="Branches" note="checks out this service's folder">
                          {options.branches.map((o) => renderOption(o))}
                          {options.hidden > 0 && (
                            <div className="px-2.5 py-1 text-[10.5px] text-ink-faint">
                              {options.hidden} more — type to find
                            </div>
                          )}
                        </OptionGroup>
                      )}
                    </>
                  )}
                </div>

                <div className="flex flex-col gap-1.5 border-t border-card px-5 py-2.5 text-[11.5px] text-ink-muted">
                  {mates.length > 0 && (
                    <label className="flex cursor-pointer items-center gap-2">
                      <input type="checkbox" checked={together} onChange={(e) => setTogether(e.target.checked)} />
                      Also pick it for the {mates.length} other service{mates.length === 1 ? '' : 's'} from this repo
                    </label>
                  )}
                  <label className="flex cursor-pointer items-center gap-2">
                    <input type="checkbox" checked={pin} onChange={(e) => setPin(e.target.checked)} />
                    Pin, so “Switch everything” leaves it alone
                  </label>
                </div>
              </div>
            </div>

            <div className="flex flex-shrink-0 items-center gap-3 border-t border-card bg-surface-muted px-5 py-3">
              <div className="flex-1 text-[11px] text-ink-muted">
                {plan.conflicts.length > 0 ? (
                  <span className="text-amber-600 dark:text-amber-300">
                    {plan.conflicts.length} pick{plan.conflicts.length === 1 ? ' wants' : 's want'} a folder another pick
                    already moves. {plan.conflicts.length === 1 ? 'It' : 'They'} will be skipped.
                  </span>
                ) : changes === 0 ? (
                  'Nothing picked yet.'
                ) : (
                  <>
                    <span className="font-semibold text-ink">
                      {moving} service{moving === 1 ? '' : 's'} will switch
                    </span>
                    {pinOnly > 0 && ` · ${pinOnly} pinned in place`}
                    {restarting > 0 && ` · ${restarting} running restart on the new branch`}
                  </>
                )}
              </div>
              <button type="button" className="svc-btn" disabled={applying} onClick={() => setPicks({})}>
                Clear picks
              </button>
              <button
                type="button"
                disabled={changes === 0 || applying}
                onClick={() => void apply()}
                className="h-[26px] rounded-md bg-accent px-3 text-[12px] font-semibold text-white hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {applying ? 'Switching…' : changes === 0 ? 'Apply' : `Apply ${changes} change${changes === 1 ? '' : 's'}`}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function ServiceRow({
  row,
  selected,
  picked,
  step,
  conflictWith,
  followName,
  onSelect,
  onUnpick,
}: {
  row: Row;
  selected: boolean;
  picked?: Picked;
  step?: PickStep;
  conflictWith?: string;
  followName?: string;
  onSelect: () => void;
  onUnpick: () => void;
}) {
  const to = step ? stepTarget(step) : undefined;
  return (
    <div
      className={
        'group/pick flex items-center rounded-md ' +
        (selected ? 'bg-accent/15 ring-1 ring-inset ring-accent/50' : picked || step ? 'bg-card' : 'hover:bg-card')
      }
    >
      <button
        type="button"
        aria-current={selected ? 'true' : undefined}
        onClick={onSelect}
        className="flex min-w-0 flex-1 items-center gap-2.5 px-2 py-1.5 text-left"
      >
        <span
          aria-hidden
          className={
            'h-1.5 w-1.5 flex-shrink-0 rounded-full ' +
            (row.live ? 'bg-green-500 dark:bg-green-400' : 'border border-card-border-strong')
          }
        />
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="truncate text-[12.5px] text-ink">{row.spec.name}</span>
          <span className="flex min-w-0 items-center gap-1.5 font-mono text-[10.5px]">
            <span className={'truncate ' + (to ? 'text-ink-faint line-through' : 'text-ink-muted')}>{row.ref}</span>
            {to && (
              <>
                <span className="text-ink-faint">→</span>
                <span className="truncate rounded bg-accent/15 px-1 text-accent">{to}</span>
              </>
            )}
            {picked?.pin && <span className="text-ink-faint">pinned</span>}
          </span>
          {followName && !picked && (
            <span className="text-[10.5px] text-ink-faint">moves with {followName} — same folder</span>
          )}
          {conflictWith && (
            <span className="text-[10.5px] text-amber-600 dark:text-amber-300">
              shares a folder with {conflictWith}, which is going elsewhere
            </span>
          )}
        </span>
      </button>
      {picked && (
        <button
          type="button"
          aria-label={`Undo pick for ${row.spec.name}`}
          title="Undo"
          onClick={onUnpick}
          className="mr-1 flex h-6 w-6 flex-shrink-0 items-center justify-center rounded text-ink-faint hover:bg-card-strong hover:text-ink"
        >
          ✕
        </button>
      )}
    </div>
  );
}

function Results({
  rows,
  steps,
  outcomes,
  onDone,
  onMore,
}: {
  rows: Row[];
  steps: PickStep[];
  outcomes: Record<string, Outcome>;
  onDone: () => void;
  onMore: () => void;
}) {
  const failed = Object.values(outcomes).filter((o) => !o.ok).length;
  const moved = Object.keys(outcomes).length - failed;
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3 px-5 py-4">
      <div className="text-[13px] font-semibold text-ink">
        Switched {moved} service{moved === 1 ? '' : 's'}
        {failed > 0 && <span className="text-amber-600 dark:text-amber-300"> · {failed} didn't move</span>}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto rounded-md border border-card">
        {rows
          .filter((r) => outcomes[r.key])
          .map((row) => {
            const outcome = outcomes[row.key];
            const step = steps.find((s) => s.key === row.key);
            const to = step ? stepTarget(step) : row.ref;
            return (
              <div key={row.key} className="grid grid-cols-[200px_minmax(0,1fr)_minmax(0,1fr)] items-center gap-3 border-b border-card px-3.5 py-2 text-[12px] last:border-b-0">
                <span className="truncate">{row.spec.name}</span>
                <span className="truncate font-mono text-[11px] text-ink-muted">
                  {row.ref} <span className="text-ink-faint">→</span> <span className="text-accent">{to}</span>
                </span>
                <span className={'truncate text-[11px] ' + (outcome.ok ? 'text-ink-muted' : 'text-amber-600 dark:text-amber-300')} title={outcome.ok ? undefined : outcome.reason}>
                  {outcome.ok ? (row.live ? 'Restarting on the new branch' : 'Ready — stopped') : outcome.reason}
                </span>
              </div>
            );
          })}
      </div>
      <div className="flex justify-end gap-2">
        <button type="button" className="svc-btn" onClick={onMore}>
          Switch more
        </button>
        <button
          type="button"
          onClick={onDone}
          className="h-[26px] rounded-md bg-accent px-3 text-[12px] font-semibold text-white hover:brightness-110"
        >
          Done
        </button>
      </div>
    </div>
  );
}

function OptionGroup({ title, note, children }: { title: string; note?: string; children: React.ReactNode }) {
  return (
    <div className="mb-2">
      <div className="flex items-baseline gap-2 px-2.5 pb-1 pt-2">
        <span className="text-[10.5px] font-semibold uppercase tracking-wide text-ink-faint">{title}</span>
        {note && <span className="text-[10.5px] text-ink-faint">{note}</span>}
      </div>
      {children}
    </div>
  );
}

function Kbd({ children }: { children: React.ReactNode }) {
  return <span className="rounded border border-card-strong px-1 font-mono">{children}</span>;
}

function BranchGlyph() {
  return (
    <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" className="flex-shrink-0 text-ink-faint" aria-hidden>
      <circle cx="4.5" cy="3.5" r="1.6" />
      <circle cx="4.5" cy="12.5" r="1.6" />
      <circle cx="11.5" cy="5.5" r="1.6" />
      <path d="M4.5 5.1v5.8M11.5 7.1c0 2.4-2 3-5.4 3.9" />
    </svg>
  );
}

function FolderGlyph() {
  return (
    <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" className="flex-shrink-0 text-ink-faint" aria-hidden>
      <path d="M2 4.5h4l1.5 1.5H14v6.5H2z" />
    </svg>
  );
}
