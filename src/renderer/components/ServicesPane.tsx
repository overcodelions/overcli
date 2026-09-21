// The Services pane: everything this machine can run, where each one points,
// and what it is saying.
//
// Workspace-scoped state, but NOT a workspace-at-a-time view. A stack left
// running in another workspace is still holding ports, and making someone go
// and find it is how two copies of one service happen.
//
// Three ideas carry the layout:
//
//   GROUPS — free text on the service ("REST services", "Processors", "Front
//     ends"). The useful grouping in one shop is meaningless in the next, so
//     it is typed rather than chosen from a list.
//   COPIES — one module launched several ways. Five processors off one Gradle
//     module differ by a flag each; they nest under the module they share, and
//     the Overrides tab is where that one flag is visible.
//   ROWS, not cards — one line, 28px, a status dot and one quiet action
//     cluster. A branch is said once on its group, not on every row under it.
//     The only loud thing on screen should be a failure.
//
// Rows tick for bulk actions the way Finder selects: ⌘-click, shift-click, or
// the checkbox a row's dot becomes on hover. Removing does not ask first; it
// offers an undo.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import type {
  MachineEntry,
  MachineValueNeed,
  MachineValues,
  ReadinessProbe,
  ServiceOption,
  ServiceRuntime,
  ServiceSpec,
  StackView,
} from '@shared/services';
import { DEFAULT_READY_TIMEOUT_SEC, type TaskPreset } from '@shared/services';
import { isSecretName } from '@shared/machineValues';
import { hardcodedCheckouts, useCheckoutPlaceholder } from '@shared/checkoutPaths';
import { useStore } from '../store';
import { useFlowsStore } from '../flowsStore';
import {
  blockedReason,
  explainKey,
  isServiceLive,
  logKey,
  splitKey,
  useServicesStore,
  type ResolvedOption,
} from '../servicesStore';
import { bulkRefOptions, handoffOffer, planBulkRebind } from '../servicesRebindPlan';
import type { ServiceGroup } from '../servicesGrouping';
import {
  buildServiceList,
  rangeBetween,
  type HeaderItem,
  type WorkspaceItem,
  type RowItem,
  type StatusFilter,
} from '../servicesList';
import {
  createdLabel,
  rankRefs,
  refChoices,
  shortenPath,
  worktreeChoices,
  type BranchChoice,
  type WorktreeChoice,
} from '../worktreeChoices';
import { LogView } from './ServiceLogView';
import { reloadModeOf, watchForMode, type ReloadMode } from '../serviceReloadMode';
import { MachineServicesSection } from './MachineServicesSection';
import { chatTargetFor, flowTargetFor, outputPrompt } from '../askAboutOutput';
import { ResizableDivider } from './ResizableDivider';
import { AddServicesSheet, type AddStack } from './AddServicesSheet';
import { optionsToText, parseOptionText } from './optionText';
import { parseCommandLine } from '../commandLine';
import { joinSteps, splitSteps } from '../commandSteps';

export function ServicesPane() {
  const workspaces = useStore((s) => s.workspaces);
  const projects = useStore((s) => s.projects);
  const settings = useStore((s) => s.settings);
  const saveSettings = useStore((s) => s.saveSettings);
  const stacks = useServicesStore((s) => s.stacks);

  const listPanel = useRef<HTMLDivElement>(null);
  const [listWidth, setListWidth] = useState(settings.servicesListWidth ?? 480);
  useEffect(() => {
    setListWidth(settings.servicesListWidth ?? 480);
  }, [settings.servicesListWidth]);
  const loadAll = useServicesStore((s) => s.loadAll);
  const loadMachine = useServicesStore((s) => s.loadMachine);

  // A project in no workspace is a stack of one. Services are stored against
  // an opaque id, so a project id works exactly as a workspace id does — and
  // without this there is no way at all to run something that was never
  // grouped, which is most people's first project.
  const loose = useMemo(
    () => projects.filter((p) => !workspaces.some((w) => w.projectIds.includes(p.id))),
    [projects, workspaces],
  );
  const stackIds = useMemo(
    () => [...workspaces.map((w) => w.id), ...loose.map((p) => p.id)],
    [workspaces, loose],
  );
  useEffect(() => {
    void loadAll(stackIds);
    void loadMachine();
  }, [stackIds, loadAll, loadMachine]);
  // Coming back from a terminal is when a checkout has most likely moved.
  useEffect(() => {
    const refresh = () => void loadAll(stackIds);
    window.addEventListener('focus', refresh);
    return () => window.removeEventListener('focus', refresh);
  }, [stackIds, loadAll]);

  // Asked once per checkout, not once per service — eleven services on one
  // worktree have one answer — and only when the set of checkouts changes or
  // the window comes back into focus, since a flow may have added a tree.
  // Every status flip replaces `stacks`; asking git again on each of those,
  // service by service, is what made the pane crawl after an edit.
  const checkouts = useMemo(
    () =>
      [...new Set(Object.values(stacks).flatMap((s) => s.bindings.map((b) => b.path)))]
        .sort()
        .join('\n'),
    [stacks],
  );
  const [focusedAt, setFocusedAt] = useState(0);
  useEffect(() => {
    const onFocus = () => setFocusedAt(Date.now());
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, []);
  const [byCheckout, setByCheckout] = useState<Record<string, WorktreeChoice[]>>({});
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const paths = checkouts ? checkouts.split('\n') : [];
      const entries = await Promise.all(
        paths.map(async (p) => [p, await worktreeChoices(p)] as const),
      );
      if (!cancelled) setByCheckout(Object.fromEntries(entries));
    })();
    return () => {
      cancelled = true;
    };
  }, [checkouts, focusedAt]);
  const choices = useMemo(
    () =>
      Object.fromEntries(
        Object.values(stacks)
          .flatMap((s) => s.bindings)
          .map((b) => [b.serviceId, byCheckout[b.path] ?? []]),
      ),
    [stacks, byCheckout],
  );
  // Every switch control reads the same answer from the store.
  const setChoices = useServicesStore((s) => s.setChoices);
  useEffect(() => {
    setChoices(choices);
  }, [choices, setChoices]);

  // Workspaces and lone projects render identically; both are just a named
  // stack.
  const owners = [
    ...workspaces.map((w) => ({ id: w.id, name: w.name })),
    ...loose.map((p) => ({ id: p.id, name: p.name })),
  ];
  const withServices = owners.filter((o) => (stacks[o.id]?.services.length ?? 0) > 0);
  if (withServices.length === 0) {
    return (
      <>
        <SetUp workspaces={workspaces} projects={projects} loose={loose} />
        <MachineValuesHost />
      </>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <MachineValuesHost />
      <Toolbar stacks={stacks} choices={choices} />
      <HandoffBanner stacks={stacks} choices={choices} />
      <div className="flex min-h-0 flex-1">
        <div
          ref={listPanel}
          style={{ width: listWidth }}
          className="relative flex flex-shrink-0 flex-col"
        >
          <ServiceList
            owners={withServices}
            // Below this, uptime is the first thing to go: the name and the
            // port are what a narrow list is for.
            compact={listWidth < 440}
          />
          <Toasts />
          <Footer workspaces={workspaces} projects={projects} loose={loose} stacks={stacks} />
        </div>
        {/* The right balance depends on what you are reading — a stack trace
            wants the log, choosing a branch wants the list. */}
        <ResizableDivider
          width={listWidth}
          panel={listPanel}
          minWidth={300}
          maxWidth={820}
          side="left"
          onChange={setListWidth}
          onCommit={(w) => void saveSettings({ ...settings, servicesListWidth: w })}
        />
        <Detail />
      </div>
    </div>
  );
}

// ── toolbar ─────────────────────────────────────────────────────────────────

function Toolbar({
  stacks,
  choices,
}: {
  stacks: Record<string, StackView>;
  choices: Record<string, WorktreeChoice[]>;
}) {
  const stop = useServicesStore((s) => s.stop);
  const runtimes = Object.values(stacks).flatMap((s) => s.runtimes);
  const running = runtimes.filter((r) => isServiceLive(r.status)).length;
  const stopped = Object.values(stacks).flatMap((s) => s.services).length - running;

  const refs = useMemo(() => {
    const counts = new Map<string, number>();
    for (const binding of Object.values(stacks).flatMap((s) => s.bindings)) {
      counts.set(binding.ref, (counts.get(binding.ref) ?? 0) + 1);
    }
    return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3);
  }, [stacks]);

  return (
    <div className="flex h-[44px] flex-shrink-0 items-center gap-2.5 border-b border-card px-3.5">
      <span className="text-[13px] font-semibold">Services</span>
      <span className="flex items-center gap-1.5 text-[11px] text-ink-muted">
        <span
          aria-hidden
          className={
            'h-1.5 w-1.5 rounded-full ' +
            (running > 0 ? 'bg-green-500 dark:bg-green-400' : 'bg-card-border-strong')
          }
        />
        {running} running
        <span className="text-ink-faint">·</span>
        <span className="text-ink-faint">{stopped} stopped</span>
      </span>

      {refs.length > 0 && (
        <span className="ml-1 flex items-center gap-1.5 rounded border border-card bg-card px-2 py-[3px] text-[11px] text-ink-muted">
          {refs.map(([ref, count], i) => (
            <span key={ref}>
              {i > 0 && <span className="mx-1 text-ink-faint">·</span>}
              <span
                title={ref}
                className={
                  'inline-block max-w-[150px] truncate align-bottom font-mono ' +
                  (i === 0 ? 'text-ink' : 'text-accent')
                }
              >
                {shortRef(ref)}
              </span>
              {count > 1 && <span className="text-ink-faint"> ({count})</span>}
            </span>
          ))}
        </span>
      )}

      <div className="flex-1" />
      <MoveEverything stacks={stacks} choices={choices} />
      <MachineValuesButton />
      {running > 0 && (
        <button
          className="svc-btn"
          onClick={async () => {
            for (const stack of Object.values(stacks)) {
              for (const runtime of stack.runtimes) {
                if (isServiceLive(runtime.status)) await stop(stack.workspaceId, runtime.serviceId);
              }
            }
          }}
        >
          Stop all
        </button>
      )}
    </div>
  );
}

function MoveEverything({
  stacks,
  choices,
}: {
  stacks: Record<string, StackView>;
  choices: Record<string, WorktreeChoice[]>;
}) {
  const rebindAll = useServicesStore((s) => s.rebindAll);
  const [ref, setRef] = useState('');
  const options = useMemo(() => bulkRefOptions(choices), [choices]);

  const plans = useMemo(() => {
    if (!ref) return [];
    return Object.values(stacks).map((stack) => ({
      workspaceId: stack.workspaceId,
      plan: planBulkRebind(
        stack.services,
        choices,
        Object.fromEntries(stack.bindings.map((b) => [b.serviceId, b.ref])),
        ref,
      ),
    }));
  }, [ref, stacks, choices]);
  const moving = plans.reduce((n, p) => n + p.plan.targets.length, 0);

  if (options.length === 0) return null;
  return (
    <div className="flex items-center gap-2">
      <BulkRefPicker
        choices={choices}
        total={Object.values(stacks).reduce((n, s) => n + s.services.length, 0)}
        label={ref || 'Switch everything to…'}
        title="Every service in the list, in every workspace. Pinned ones stay."
        onPick={setRef}
      />
      {ref && (
        <button
          className="svc-btn-primary"
          disabled={moving === 0}
          onClick={async () => {
            for (const { workspaceId, plan } of plans) {
              if (plan.targets.length > 0) await rebindAll(workspaceId, plan.targets);
            }
            setRef('');
          }}
        >
          {moving === 0 ? 'Nothing to move' : `Move ${moving}`}
        </button>
      )}
    </div>
  );
}

function HandoffBanner({
  stacks,
  choices,
}: {
  stacks: Record<string, StackView>;
  choices: Record<string, WorktreeChoice[]>;
}) {
  const runs = useFlowsStore((s) => s.runs);
  const rebindAll = useServicesStore((s) => s.rebindAll);
  const [dismissed, setDismissed] = useState<string[]>([]);

  const latestRef = useMemo(() => {
    const finished = Object.values(runs)
      .filter((r) => r.state.kind === 'done' && r.branchName)
      .sort((a, b) => (b.lastUserTurnAt ?? b.createdAt) - (a.lastUserTurnAt ?? a.createdAt));
    return finished[0]?.branchName;
  }, [runs]);

  const count = useMemo(
    () =>
      Object.values(stacks).reduce(
        (n, stack) =>
          n +
          (handoffOffer(
            stack.services,
            choices,
            Object.fromEntries(stack.bindings.map((b) => [b.serviceId, b.ref])),
            latestRef,
          )?.serviceIds.length ?? 0),
        0,
      ),
    [stacks, choices, latestRef],
  );

  if (!latestRef || count === 0 || dismissed.includes(latestRef)) return null;

  return (
    <div className="flex flex-shrink-0 items-center gap-2.5 border-b border-accent/25 bg-accent/8 px-3.5 py-2">
      <span aria-hidden className="h-1.5 w-1.5 flex-shrink-0 rounded-full bg-accent" />
      <span className="flex-1 text-xs">
        A flow just finished on <span className="font-mono text-accent">{latestRef}</span>. {count}{' '}
        service{count === 1 ? '' : 's'} could be pointed at it.
      </span>
      <button
        className="svc-btn-primary"
        onClick={async () => {
          for (const stack of Object.values(stacks)) {
            const plan = planBulkRebind(
              stack.services,
              choices,
              Object.fromEntries(stack.bindings.map((b) => [b.serviceId, b.ref])),
              latestRef,
            );
            if (plan.targets.length > 0) await rebindAll(stack.workspaceId, plan.targets);
          }
        }}
      >
        Switch them over
      </button>
      <button
        className="px-2 py-1 text-[11px] text-ink-muted hover:text-ink"
        onClick={() => setDismissed((d) => [...d, latestRef])}
      >
        Not now
      </button>
    </div>
  );
}

// ── the list ────────────────────────────────────────────────────────────────

/// Every stack's services as one list: a filter on top, groups that fold, and
/// rows that tick for a bulk action.
function ServiceList({
  owners,
  compact,
}: {
  owners: { id: string; name: string }[];
  compact: boolean;
}) {
  const stacks = useServicesStore((s) => s.stacks);
  const collapsed = useServicesStore((s) => s.collapsed);
  const checked = useServicesStore((s) => s.checked);
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState<StatusFilter>('all');
  const filterInput = useRef<HTMLInputElement>(null);

  const list = buildServiceList({
    stacks: owners.flatMap((o) => (stacks[o.id] ? [{ name: o.name, stack: stacks[o.id] }] : [])),
    showWorkspaceNames: owners.length > 1,
    query,
    status,
    collapsed,
  });
  const ticking = Object.keys(checked).length > 0;
  // With several workspaces the list is three deep, and each level steps in.
  const nested = owners.length > 1;

  // Esc lets go of a selection, `/` goes to the filter, Delete removes what is
  // ticked — it can be undone, so it does not ask. Never while typing.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const state = useServicesStore.getState();
      const keys = Object.keys(state.checked);
      if (e.key === 'Escape' && keys.length > 0) {
        state.clearChecked();
        return;
      }
      const el = e.target as HTMLElement | null;
      if (el && (el.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName))) return;
      if (e.key === '/' && !e.metaKey && !e.ctrlKey) {
        e.preventDefault();
        filterInput.current?.focus();
      } else if ((e.key === 'Backspace' || e.key === 'Delete') && keys.length > 0) {
        e.preventDefault();
        void state.removeMany(keys);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // Finder's rules: a plain click opens the service, ⌘ ticks it, shift ticks a
  // range. Once anything is ticked, a plain click ticks too — reaching for ⌘
  // on every row of a long selection is how one gets dropped.
  const clickRow = (e: React.MouseEvent, row: RowItem) => {
    const state = useServicesStore.getState();
    if (e.shiftKey && state.anchor) {
      state.setChecked(rangeBetween(list.visible, state.anchor, row.key), true);
    } else if (e.metaKey || e.ctrlKey || Object.keys(state.checked).length > 0) {
      state.setChecked([row.key], !state.checked[row.key]);
    } else {
      state.setAnchor(row.key);
      void state.select(row.workspaceId, row.spec.id);
    }
  };

  const chips: { key: StatusFilter; label: string; tone: string }[] = [
    { key: 'all', label: 'All', tone: 'text-ink-faint' },
    { key: 'running', label: 'Running', tone: 'text-green-600 dark:text-green-400' },
    { key: 'problems', label: 'Problems', tone: 'text-red-600 dark:text-red-400' },
  ];

  return (
    <>
      <div className="flex flex-shrink-0 flex-col gap-2 border-b border-card px-2.5 pb-2 pt-2.5">
        <label className="flex h-[26px] items-center gap-1.5 rounded-md border border-card bg-card px-2">
          <svg
            width="12"
            height="12"
            viewBox="0 0 16 16"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            className="flex-shrink-0 text-ink-faint"
          >
            <circle cx="7" cy="7" r="4.5" />
            <path d="M10.5 10.5L14 14" />
          </svg>
          <input
            ref={filterInput}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                setQuery('');
                e.currentTarget.blur();
              }
            }}
            placeholder="Filter services"
            className="min-w-0 flex-1 bg-transparent text-[12px] text-ink outline-none placeholder:text-ink-faint"
          />
          {query ? (
            <button
              aria-label="Clear filter"
              onClick={() => setQuery('')}
              className="text-ink-faint hover:text-ink"
            >
              <svg width="10" height="10" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                <path d="M4 4l8 8M12 4l-8 8" />
              </svg>
            </button>
          ) : (
            <kbd className="rounded border border-card-strong px-1 font-mono text-[10px] leading-[14px] text-ink-faint">
              /
            </kbd>
          )}
        </label>
        <div className="flex items-center gap-0.5">
          {chips.map((chip) => (
            <button
              key={chip.key}
              onClick={() => setStatus(chip.key)}
              className={
                'flex h-[22px] items-center gap-1.5 rounded px-2 text-[11px] ' +
                (status === chip.key ? 'bg-card-strong text-ink' : 'text-ink-muted hover:text-ink')
              }
            >
              {chip.label}
              <span
                className={
                  'font-mono text-[10px] ' + (list.counts[chip.key] > 0 ? chip.tone : 'text-ink-faint')
                }
              >
                {list.counts[chip.key]}
              </span>
            </button>
          ))}
        </div>
      </div>

      <div className="min-h-0 flex-1 select-none overflow-y-auto pb-3">
        {list.items.map((item) =>
          item.kind === 'workspace' ? (
            <WorkspaceHeader key={item.key} item={item} ticking={ticking} />
          ) : item.kind === 'row' ? (
            <Row
              key={item.key}
              item={item}
              ticking={ticking}
              checked={!!checked[item.key]}
              compact={compact}
              nested={nested}
              onClick={(e) => clickRow(e, item)}
            />
          ) : (
            <ListHeader key={item.key} item={item} ticking={ticking} nested={nested} />
          ),
        )}
        {list.items.length === 0 && (
          <div className="px-3.5 py-6 text-xs text-ink-faint">Nothing matches.</div>
        )}
        {/* Not a status filter's business: brew services have no branch and
            no "problems" in the sense the chips mean. Only the text filter
            narrows them. */}
        {status === 'all' && <MachineServicesSection filter={query} />}
      </div>
    </>
  );
}

/// A group or a module. A click folds it; ⌘-click, or its checkbox once
/// something is ticked, selects everything under it — folded or not. A group
/// whose services are all on one feature branch says it once.
/// A workspace: a click folds everything in it, like a group one level up.
function WorkspaceHeader({ item, ticking }: { item: WorkspaceItem; ticking: boolean }) {
  const toggleCollapsed = useServicesStore((s) => s.toggleCollapsed);
  return (
    <div
      onClick={() => toggleCollapsed(item.key)}
      className="group mt-2 flex h-[30px] cursor-default items-center gap-2 border-t border-card pl-2 pr-2 first:mt-0 first:border-t-0 hover:bg-card-strong"
    >
      <span className="flex h-3.5 w-3.5 flex-shrink-0 items-center justify-center">
        <Chevron open={!item.collapsed} />
      </span>
      <span className="truncate text-[11px] font-semibold uppercase tracking-[0.08em] text-ink">
        {item.name}
      </span>
      <span
        className={
          'flex-shrink-0 font-mono text-[10px] ' +
          (item.running > 0 ? 'text-green-600 dark:text-green-400' : 'text-ink-faint')
        }
      >
        {item.running > 0 ? `${item.running}/${item.rows.length}` : item.rows.length}
      </span>
      <span className="flex-1" />
      {!ticking && (
        <span onClick={(e) => e.stopPropagation()}>
          <SwitchMenu keys={item.rows} label={`Switch ${item.name}`} />
        </span>
      )}
    </div>
  );
}

function ListHeader({ item, ticking, nested }: { item: HeaderItem; ticking: boolean; nested: boolean }) {
  const checked = useServicesStore((s) => s.checked);
  const setChecked = useServicesStore((s) => s.setChecked);
  const toggleCollapsed = useServicesStore((s) => s.toggleCollapsed);
  const startMany = useServicesStore((s) => s.startMany);
  const stopMany = useServicesStore((s) => s.stopMany);

  const ticked = item.rows.filter((key) => checked[key]).length;
  const all = ticked === item.rows.length;
  const tickAll = () => setChecked(item.rows, !all);
  const running = (
    <span
      className={
        'flex-shrink-0 font-mono text-[10px] ' +
        (item.running > 0 ? 'text-green-600 dark:text-green-400' : 'text-ink-faint')
      }
    >
      {item.running > 0 ? `${item.running}/${item.rows.length}` : item.rows.length}
    </span>
  );

  return (
    <div
      onClick={(e) => (e.metaKey || e.ctrlKey ? tickAll() : toggleCollapsed(item.key))}
      className={
        'group mt-1 flex h-[28px] cursor-default items-center gap-2 pr-2 hover:bg-card-strong ' +
        (nested ? 'pl-5' : 'pl-3.5')
      }
    >
      <span className="flex h-3.5 w-3.5 flex-shrink-0 items-center justify-center">
        {ticking ? (
          <Checkbox on={all} mixed={ticked > 0} onClick={tickAll} className="flex" />
        ) : (
          <Chevron open={!item.collapsed} />
        )}
      </span>
      <span className="truncate text-[10px] font-semibold uppercase tracking-[0.06em] text-ink-muted">
        {item.name}
      </span>
      {running}
      <span className="min-w-[8px] flex-1" />
      {item.ref && (
        <span title={item.ref} className={refChip}>
          {shortRef(item.ref)}
        </span>
      )}
      {!ticking && (
        <span
          className="hidden flex-shrink-0 items-center text-ink-faint group-hover:flex"
          onClick={(e) => e.stopPropagation()}
        >
          <SwitchMenu keys={item.rows} label={`Switch ${item.name}`} quiet />
          {item.running < item.rows.length && (
            <IconButton
              title="Start group"
              onClick={() => void startMany(item.rows)}
              fill
            >
              <path d="M4.5 3.5l8 4.5-8 4.5z" />
            </IconButton>
          )}
          {item.running > 0 && (
            <IconButton
              title="Stop group"
              onClick={() => void stopMany(item.rows)}
              fill
            >
              <rect x="4.5" y="4.5" width="7" height="7" rx="1" />
            </IconButton>
          )}
        </span>
      )}
    </div>
  );
}

/// One service on one line. The dot says how it is; hovering turns it into a
/// checkbox, and once anything is ticked every row shows one.
function Row({
  item,
  ticking,
  checked,
  compact,
  nested,
  onClick,
}: {
  item: RowItem;
  ticking: boolean;
  checked: boolean;
  compact: boolean;
  nested: boolean;
  onClick: (e: React.MouseEvent) => void;
}) {
  const selectedId = useServicesStore((s) => s.selected[item.workspaceId]);
  const pendingLease = useServicesStore((s) => s.pendingLease[item.workspaceId]);
  const setChecked = useServicesStore((s) => s.setChecked);

  const { spec, runtime, binding } = item;
  const live = isServiceLive(runtime.status);
  const selected = !ticking && selectedId === spec.id;
  const blocked = blockedReason(pendingLease, spec.id);

  return (
    <div
      className={
        'group relative flex h-[28px] items-center gap-2 pr-2 ' +
        (nested ? 'pl-[42px]' : 'pl-[34px]') +
        (checked
          ? ' bg-accent/10'
          : selected
            ? ' bg-accent/15 shadow-[inset_2px_0_0_var(--c-accent)]'
            : ' hover:bg-card-strong')
      }
    >
      {/* The guide down from its group's chevron: which rows belong to which
          header, without reading the indent. */}
      <span
        aria-hidden
        className={'absolute inset-y-0 w-px bg-card-strong ' + (nested ? 'left-[26px]' : 'left-[20px]')}
      />
      <span className="flex h-3.5 w-3.5 flex-shrink-0 items-center justify-center">
        <span className={ticking ? 'hidden' : 'flex group-hover:hidden'}>
          <StatusDot status={blocked ? 'blocked' : runtime.status} />
        </span>
        <Checkbox
          on={checked}
          onClick={() => setChecked([item.key], !checked)}
          className={ticking ? 'flex' : 'hidden group-hover:flex'}
        />
      </span>

      <button
        onClick={onClick}
        title={binding ? `${spec.name} · ${binding.ref}` : spec.name}
        className="flex min-w-0 flex-1 items-center gap-2 self-stretch text-left"
      >
        <span className={'min-w-0 flex-1 truncate text-[12.5px] ' + (selected ? 'font-medium' : '')}>
          {spec.name}
        </span>
        <Trouble runtime={runtime} spec={spec} blocked={blocked} boundRef={binding?.ref} />
        {/* The ref chip only appears off the default branch, so a service
            kept on master said nothing about being kept there — and that is
            the common pin. The pin says it whatever the ref. */}
        {spec.pinnedRef && (
          <span
            className="flex flex-shrink-0 items-center gap-0.5 font-mono text-[10.5px] text-accent"
            title={`Pinned to ${spec.pinnedRef} — a bulk switch leaves it`}
          >
            <PinIcon />
            {!item.showRef && shortRef(spec.pinnedRef)}
          </span>
        )}
        {item.showRef && binding && (
          <span
            className={
              binding.ref === spec.pinnedRef
                ? 'min-w-0 max-w-[40%] flex-shrink truncate rounded px-1 font-mono text-[10.5px] text-ink-faint'
                : refChip
            }
          >
            {shortRef(binding.ref)}
          </span>
        )}
      </button>

      {runtime.debugKind && runtime.debugPort && (
        <span className="flex-shrink-0 font-mono text-[10px] text-amber-700 dark:text-amber-300">
          dbg :{runtime.debugPort}
        </span>
      )}
      {runtime.port !== undefined && (
        <span className="flex-shrink-0 font-mono text-[10.5px] text-ink-muted">:{runtime.port}</span>
      )}
      {!compact && live && runtime.startedAt && (
        <span className="w-[28px] flex-shrink-0 text-right text-[10.5px] text-ink-faint">
          {since(runtime.startedAt)}
        </span>
      )}
      {!ticking && (
        <Actions
          workspaceId={item.workspaceId}
          spec={spec}
          binding={binding}
          live={live}
        />
      )}
    </div>
  );
}

/// Takes the footer's place while anything is ticked.
function SelectionBar() {
  const stacks = useServicesStore((s) => s.stacks);
  const checked = useServicesStore((s) => s.checked);
  const startMany = useServicesStore((s) => s.startMany);
  const stopMany = useServicesStore((s) => s.stopMany);
  const removeMany = useServicesStore((s) => s.removeMany);
  const clearChecked = useServicesStore((s) => s.clearChecked);

  const keys = Object.keys(checked);
  const live = keys.filter((key) => {
    const { workspaceId, serviceId } = splitKey(key);
    const runtime = stacks[workspaceId]?.runtimes.find((r) => r.serviceId === serviceId);
    return runtime ? isServiceLive(runtime.status) : false;
  }).length;

  // Wraps rather than overflows. This bar lives in the service list column,
  // which the user can drag down to 300px — narrower than its own controls,
  // which then painted over the divider and into the detail pane. The spacer
  // is `flex-1` (basis 0), so it absorbs slack without ever being the reason
  // a line breaks.
  return (
    <div className="flex min-h-[40px] flex-shrink-0 flex-wrap items-center gap-x-1 gap-y-1 border-t border-card-strong bg-surface-muted py-1 pl-3.5 pr-1.5">
      <span className="whitespace-nowrap text-[12px] font-medium">{keys.length} selected</span>
      <div className="flex-1" />
      <SwitchMenu keys={keys} label="Switch" />
      <ReloadMenu keys={keys} />
      <button className="svc-btn-go" disabled={live === keys.length} onClick={() => void startMany(keys)}>
        Start
      </button>
      <button className="svc-btn-stop" disabled={live === 0} onClick={() => void stopMany(keys)}>
        Stop
      </button>
      <button
        title={live > 0 ? `Stops the ${live} running first` : undefined}
        onClick={() => void removeMany(keys)}
        className="h-[22px] rounded px-2 text-[11px] font-medium text-red-600 hover:bg-red-500/10 dark:text-red-400"
      >
        Remove
      </button>
      <span className="mx-0.5 h-4 w-px bg-card-border" />
      <IconButton title="Clear selection (Esc)" onClick={clearChecked}>
        <path d="M4 4l8 8M12 4l-8 8" />
      </IconButton>
    </div>
  );
}

/// ⎇ Switch — moves whatever it sits on to another branch: a workspace, a
/// group, or the ticked rows. One control in three places, so there is one
/// thing to learn. Each service moves within its own repository; the menu
/// lists branches that exist in at least one of them, and says how many can
/// reach each when not all can.
function SwitchMenu({ keys, label, quiet }: { keys: string[]; label: string; quiet?: boolean }) {
  const choices = useServicesStore((s) => s.choices);
  const switchKeys = useServicesStore((s) => s.switchKeys);

  const ids = new Set(keys.map((key) => splitKey(key).serviceId));
  const scoped = Object.fromEntries(Object.entries(choices).filter(([id]) => ids.has(id)));
  if (bulkRefOptions(scoped).length === 0) return null;

  return (
    <BulkRefPicker
      choices={scoped}
      total={ids.size}
      label={quiet ? undefined : 'Switch'}
      title={label}
      quiet={quiet}
      onPick={(ref, pin) => void switchKeys(keys, ref, pin)}
    />
  );
}

/// What the ticked rows do when their files change — the bulk form of the
/// Reload setting on one service.
///
/// Services imported before watching existed have no `watch` at all, so a
/// stack of them is uniformly "do nothing" and turning that around was a trip
/// into each service's settings in turn.
///
/// Patterns are deliberately not part of the choice: each service keeps its
/// own globs (see `watchForMode`), because one glob across a selection is
/// wrong the moment two of them live in different repositories.
function ReloadMenu({ keys }: { keys: string[] }) {
  const setWatchMany = useServicesStore((s) => s.setWatchMany);
  const stacks = useServicesStore((s) => s.stacks);
  const [open, setOpen] = useState(false);
  const anchor = useRef<HTMLButtonElement>(null);
  const up = useOpensUp(anchor, open, 180);
  const right = useAnchorsRight(anchor, open, 280);

  const modes = new Set(
    keys.map((key) => {
      const { workspaceId, serviceId } = splitKey(key);
      const spec = stacks[workspaceId]?.services.find((s) => s.id === serviceId);
      return spec ? reloadModeOf(spec) : 'off';
    }),
  );
  // One answer only when they agree; saying "Do nothing" over a mixed
  // selection would be a claim about services it is not true of.
  const current = modes.size === 1 ? [...modes][0] : undefined;

  const choices: { mode: ReloadMode; label: string; note: string }[] = [
    { mode: 'restart', label: 'Restart on change', note: 'overcli watches and restarts the process' },
    { mode: 'self', label: 'Reloads itself', note: 'the runner patches its own process' },
    { mode: 'off', label: 'Do nothing', note: 'left alone when files change' },
  ];

  return (
    <span className="relative flex-shrink-0" onClick={(e) => e.stopPropagation()}>
      <button
        ref={anchor}
        title="What these do when their files change"
        onClick={() => setOpen((o) => !o)}
        className="flex h-[22px] max-w-[200px] items-center gap-1 rounded border border-card bg-card px-1.5 text-[11px] text-ink-muted hover:border-card-strong hover:text-ink"
      >
        <span className="truncate">
          Reload
          <span className="text-ink-faint">
            {' · '}
            {current ? RELOAD_SHORT[current] : 'mixed'}
          </span>
        </span>
        <svg width="8" height="8" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
          <path d="M4 6l4 4 4-4" />
        </svg>
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-10" onClick={() => setOpen(false)} />
          <div
            className={
              'absolute z-20 w-[280px] overflow-hidden rounded-lg border border-card-strong bg-surface-elevated shadow-xl ' +
              (right ? 'right-0 ' : 'left-0 ') +
              (up ? 'bottom-full mb-1' : 'top-full mt-1')
            }
          >
            {choices.map((choice) => (
              <button
                key={choice.mode}
                className="flex w-full flex-col items-start gap-0.5 px-2.5 py-1.5 text-left hover:bg-card-strong"
                onClick={() => {
                  setOpen(false);
                  void setWatchMany(keys, choice.mode);
                }}
              >
                <span className="text-[11.5px] text-ink">
                  {current === choice.mode && <span className="text-accent">✓ </span>}
                  {choice.label}
                </span>
                <span className="text-[10.5px] text-ink-faint">{choice.note}</span>
              </button>
            ))}
            <div className="border-t border-card px-2.5 py-1.5 text-[10.5px] text-ink-faint">
              Each service keeps its own watch patterns.
            </div>
          </div>
        </>
      )}
    </span>
  );
}

const RELOAD_SHORT: Record<ReloadMode, string> = {
  self: 'itself',
  restart: 'on change',
  off: 'nothing',
};

/// Where a ref lives, for the bulk pickers. The same name can be the main
/// checkout in one repo and a worktree in another; main wins, because moving
/// to it touches no scratch folder anywhere.
function refKind(ref: string, choices: Record<string, WorktreeChoice[]>): 'main' | 'worktree' | 'detached' {
  const all = Object.values(choices).flat().filter((c) => c.ref === ref);
  if (all.some((c) => c.primary)) return 'main';
  if (all.every((c) => c.detached)) return 'detached';
  return 'worktree';
}

/// Picking one ref for many services. A native select could not be searched,
/// and it put a detached sha from a Codex scratch tree on the same footing as
/// the main checkout's master.
function BulkRefPicker({
  choices,
  total,
  label,
  title,
  quiet,
  onPick,
}: {
  choices: Record<string, WorktreeChoice[]>;
  total: number;
  label?: string;
  title: string;
  quiet?: boolean;
  onPick: (ref: string, pin: boolean) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const anchor = useRef<HTMLButtonElement>(null);
  const up = useOpensUp(anchor, open, 420);
  const right = useAnchorsRight(anchor, open, 360);

  const sections = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const rows = bulkRefOptions(choices)
      .filter((o) => !needle || o.ref.toLowerCase().includes(needle))
      .map((o) => ({ ...o, kind: refKind(o.ref, choices) }));
    return [
      { title: 'Main checkouts', note: 'the repo folder itself', rows: rows.filter((r) => r.kind === 'main') },
      { title: 'Worktrees', note: 'scratch folders a flow or agent made', rows: rows.filter((r) => r.kind === 'worktree') },
      // A short sha says nothing until someone is looking for it.
      { title: 'Detached', note: 'no branch — type to find', rows: needle ? rows.filter((r) => r.kind === 'detached') : [] },
    ].filter((s) => s.rows.length > 0);
  }, [choices, query]);

  function close() {
    setOpen(false);
    setQuery('');
  }

  return (
    <span className="relative flex-shrink-0" onClick={(e) => e.stopPropagation()}>
      <button
        ref={anchor}
        title={title}
        onClick={() => (open ? close() : setOpen(true))}
        className={
          'flex h-[22px] max-w-[260px] items-center gap-1 rounded px-1.5 text-[11px] ' +
          (quiet
            ? 'text-ink-faint hover:bg-card-strong hover:text-ink'
            : 'border border-card bg-card text-ink-muted hover:border-card-strong hover:text-ink')
        }
      >
        <BranchIcon />
        {label && <span className="truncate font-mono">{label}</span>}
        <svg width="8" height="8" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
          <path d="M4 6l4 4 4-4" />
        </svg>
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-10" onClick={close} />
          <div
            className={
              'absolute z-20 w-[360px] overflow-hidden rounded-lg border border-card-strong bg-surface-elevated shadow-xl ' +
              (right ? 'right-0 ' : 'left-0 ') +
              (up ? 'bottom-full mb-1' : 'top-full mt-1')
            }
          >
            <div className="border-b border-card p-2">
              <input
                autoFocus
                className="w-full rounded-[5px] border border-card-strong bg-surface px-2 py-1 text-[11.5px] outline-none focus:border-accent"
                placeholder="Search branches"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => e.key === 'Escape' && close()}
              />
            </div>
            <div className="max-h-[340px] overflow-y-auto px-1 py-1.5">
              {sections.length === 0 && (
                <div className="px-2.5 py-2 text-[11px] text-ink-faint">
                  {query ? `Nothing matches “${query}”.` : 'Nothing to move to.'}
                </div>
              )}
              {sections.map((section, i) => (
                <div key={section.title} className={i > 0 ? 'mt-1 border-t border-card pt-1.5' : ''}>
                  <SectionHead title={section.title} note={section.note} />
                  {section.rows.map((row) => (
                    <div key={row.ref} className="group/ref flex items-center rounded-[5px] hover:bg-card-strong">
                      <button
                        className="flex min-w-0 flex-1 items-center gap-2 px-2.5 py-1.5 text-left"
                        onClick={() => {
                          close();
                          onPick(row.ref, false);
                        }}
                      >
                        {row.kind === 'main' ? <BranchIcon /> : <FolderIcon current={false} />}
                        <span className="min-w-0 flex-1 truncate font-mono text-[11.5px]" title={row.ref}>
                          {row.ref}
                        </span>
                        {row.reachable < total && (
                          <span className="flex-shrink-0 text-[10px] text-ink-faint">
                            {row.reachable} of {total}
                          </span>
                        )}
                      </button>
                      <button
                        className="mr-1 flex h-6 w-6 flex-shrink-0 items-center justify-center rounded text-ink-faint opacity-40 hover:bg-surface hover:text-accent hover:opacity-100 group-hover/ref:opacity-100"
                        title={`Switch and pin ${total === 1 ? 'this service' : `these ${total} services`} to ${row.ref}`}
                        aria-label={`Switch and pin to ${row.ref}`}
                        onClick={() => {
                          close();
                          onPick(row.ref, true);
                        }}
                      >
                        <PinIcon />
                      </button>
                    </div>
                  ))}
                </div>
              ))}
            </div>
          </div>
        </>
      )}
    </span>
  );
}

/// Whether a menu anchored here should open upward: a row near the bottom of
/// the list opened its menu past the window edge, where nobody could reach it.
/// Whether a panel of this width can hang from the anchor's RIGHT edge and
/// still be on screen.
///
/// These panels are wider than the service list column they open in, so a
/// button near the left of a narrow column put the whole panel off the left
/// of the window — the search box and half the branch names with it. When
/// there is no room that way it hangs from the left edge instead and
/// overflows to the right, over the detail pane, which is what a popover is
/// allowed to do.
function useAnchorsRight(
  anchor: React.RefObject<HTMLElement | null>,
  open: boolean,
  width: number,
): boolean {
  const [right, setRight] = useState(true);
  useEffect(() => {
    if (!open || !anchor.current) return;
    setRight(anchor.current.getBoundingClientRect().right - width >= 8);
  }, [open, anchor, width]);
  return right;
}

function useOpensUp(anchor: React.RefObject<HTMLElement | null>, open: boolean, height: number): boolean {
  const [up, setUp] = useState(false);
  useEffect(() => {
    if (!open || !anchor.current) return;
    const rect = anchor.current.getBoundingClientRect();
    setUp(window.innerHeight - rect.bottom < height && rect.top > window.innerHeight - rect.bottom);
  }, [open, anchor, height]);
  return up;
}

/// Undo for a removal, or the report of a switch. Ten seconds is long enough
/// to notice the wrong row went, or that most of a workspace stayed put.
function Toasts() {
  const removed = useServicesStore((s) => s.removed);
  const undoRemove = useServicesStore((s) => s.undoRemove);
  const dismissRemoved = useServicesStore((s) => s.dismissRemoved);
  const notice = useServicesStore((s) => s.notice);
  const dismissNotice = useServicesStore((s) => s.dismissNotice);

  useEffect(() => {
    if (!removed) return;
    const timer = setTimeout(dismissRemoved, 10_000);
    return () => clearTimeout(timer);
  }, [removed, dismissRemoved]);
  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(dismissNotice, 10_000);
    return () => clearTimeout(timer);
  }, [notice, dismissNotice]);

  const shown = removed
    ? {
        text: `Removed ${removed.count} service${removed.count === 1 ? '' : 's'}`,
        sub: removed.stopped.length > 0 ? `Stopped ${removed.stopped.join(', ')} first` : undefined,
        dismiss: dismissRemoved,
      }
    : notice
      ? { ...notice, dismiss: dismissNotice }
      : null;
  if (!shown) return null;

  return (
    <div className="absolute inset-x-2.5 bottom-[48px] z-10 flex items-center gap-2 rounded-lg border border-card-strong bg-surface-elevated py-2 pl-3 pr-1.5 shadow-xl">
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="truncate text-[12px]">{shown.text}</span>
        {shown.sub && <span className="truncate text-[10.5px] text-ink-muted">{shown.sub}</span>}
      </div>
      {removed && (
        <button
          onClick={() => void undoRemove()}
          className="rounded px-2 py-1 text-[11.5px] font-medium text-accent hover:bg-card-strong"
        >
          Undo
        </button>
      )}
      <IconButton title="Dismiss" onClick={shown.dismiss}>
        <path d="M4 4l8 8M12 4l-8 8" />
      </IconButton>
    </div>
  );
}

function Checkbox({
  on,
  mixed,
  onClick,
  className,
}: {
  on: boolean;
  mixed?: boolean;
  onClick: () => void;
  /// Must carry the display — the row shows it only on hover.
  className: string;
}) {
  return (
    <button
      role="checkbox"
      aria-checked={on ? true : mixed ? 'mixed' : false}
      aria-label="Select"
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      className={
        'h-3 w-3 items-center justify-center rounded-[3px] border ' +
        (on ? 'border-accent bg-accent' : mixed ? 'border-accent bg-accent/35' : 'border-card-strong hover:border-ink-faint') +
        ' ' +
        className
      }
    >
      {on && (
        <svg width="8" height="8" viewBox="0 0 16 16" fill="none" stroke="var(--c-surface)" strokeWidth="2.8" strokeLinecap="round" strokeLinejoin="round">
          <path d="M3 8.5l3.2 3L13 4.5" />
        </svg>
      )}
    </button>
  );
}

function Chevron({ open }: { open: boolean }) {
  return (
    <svg
      width="10"
      height="10"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={'text-ink-faint transition-transform ' + (open ? '' : '-rotate-90')}
    >
      <path d="M4 6l4 4 4-4" />
    </svg>
  );
}

/// A feature branch. Master and main never get one — see `servicesList`.
const refChip = 'min-w-0 max-w-[40%] flex-shrink truncate rounded bg-accent/15 px-1 font-mono text-[10.5px] text-accent';

/// Always on the row: what you can do next is part of how the service is. A
/// running one offers stop and restart, a stopped one offers play, tinted like
/// the footer's Start and Stop so the verb reads before the icon does.
function Actions({
  workspaceId,
  spec,
  binding,
  live,
}: {
  workspaceId: string;
  spec: ServiceSpec;
  binding?: { ref: string; path: string };
  live: boolean;
}) {
  const start = useServicesStore((s) => s.start);
  const stop = useServicesStore((s) => s.stop);
  const restart = useServicesStore((s) => s.restart);
  const setDebug = useServicesStore((s) => s.setDebug);

  const debug = spec.debugPort !== undefined && !spec.task;
  const toggleDebug = async () => {
    const enabling = !spec.debugEnabled;
    await setDebug(workspaceId, spec.id, enabling);
    if (!live && enabling) await start(workspaceId, spec.id);
  };

  return (
    <span className="flex flex-shrink-0 items-center gap-0.5 text-ink-faint">
      {live ? (
        <>
          <IconButton title="Stop" tone="stop" onClick={() => void stop(workspaceId, spec.id)} fill>
            <rect x="4.5" y="4.5" width="7" height="7" rx="1" />
          </IconButton>
          <IconButton title="Restart" tone="restart" onClick={() => void restart(workspaceId, spec.id)}>
            <path d="M13.5 8a5.5 5.5 0 1 1-1.9-4.2" />
            <path d="M13.5 2.5V6H10" />
          </IconButton>
        </>
      ) : (
        <IconButton title={spec.task ? 'Run' : 'Start'} tone="go" onClick={() => void start(workspaceId, spec.id)} fill>
          <path d="M4.5 3.5l8 4.5-8 4.5z" />
        </IconButton>
      )}
      {debug && (
        <IconButton
          title={
            live
              ? spec.debugEnabled ? 'Restart normally' : `Restart with debugger on :${spec.debugPort}`
              : spec.debugEnabled ? 'Debugger enabled for next start' : `Start with debugger on :${spec.debugPort}`
          }
          tone="restart"
          onClick={() => void toggleDebug()}
        >
          <path d="M6 3.5h4M8 2v3M5 7h6v5.5a3 3 0 0 1-6 0zM3 9h2M11 9h2M3 12h2M11 12h2" />
        </IconButton>
      )}
      <RowMenu workspaceId={workspaceId} spec={spec} binding={binding} live={live} />
    </span>
  );
}

/// The one loud thing on a row, and only when something is wrong.
function Trouble({
  runtime,
  spec,
  blocked,
  boundRef,
}: {
  runtime: ServiceRuntime;
  spec: ServiceSpec;
  blocked?: string | null;
  boundRef?: string;
}) {
  // Nothing was spawned, so there is no status to show — but there is a
  // reason, and it belongs on the row that refused rather than only on a
  // page the user may not be looking at.
  if (blocked) {
    return (
      <span className="flex-shrink-0 rounded bg-amber-500/15 px-1 text-[10px] text-amber-700 dark:text-amber-300">
        {blocked}
      </span>
    );
  }
  // Imported from a file that never said how to start it. Every Start would
  // fail the same way, so say it before anyone presses one.
  if (spec.command.length === 0) {
    return (
      <span className="flex-shrink-0 rounded bg-amber-500/15 px-1 text-[10px] text-amber-700 dark:text-amber-300">
        needs a command
      </span>
    );
  }
  if (runtime.status === 'failed') {
    const short = runtime.lastError
      ? runtime.lastError.replace(/^Error:\s*/, '').slice(0, 42)
      : `stopped${runtime.exitCode ? ` (exit ${runtime.exitCode})` : ''}`;
    return (
      <span className="truncate rounded bg-red-500/10 px-1 text-[10px] text-red-700 dark:text-red-300">
        {short}
      </span>
    );
  }
  if (runtime.status === 'unready') {
    return (
      <span className="flex-shrink-0 rounded bg-amber-500/15 px-1 text-[10px] text-amber-700 dark:text-amber-300">
        slow to start
      </span>
    );
  }
  if (runtime.status === 'starting') {
    return (
      <span className="flex-shrink-0 truncate text-[10px] text-ink-faint" title={runtime.waitingOn ? `Starts once ${runtime.waitingOn} is ready` : undefined}>
        {runtime.waitingOn ? `waiting for ${runtime.waitingOn}…` : spec.task ? 'running…' : 'starting…'}
      </span>
    );
  }
  // Rebound since it last ran: what it published came from another branch,
  // and the next dependent to start will run it again.
  if (runtime.status === 'done' && runtime.ranRef && boundRef && runtime.ranRef !== boundRef) {
    return (
      <span className="flex-shrink-0 rounded bg-amber-500/15 px-1 text-[10px] text-amber-700 dark:text-amber-300">
        ran from {shortRef(runtime.ranRef)}
      </span>
    );
  }
  if (runtime.status === 'done' && runtime.finishedAt) {
    return <span className="flex-shrink-0 text-[10px] text-ink-faint">done {since(runtime.finishedAt)} ago</span>;
  }
  if (spec.selfReloads && runtime.status === 'ready') {
    return <span className="flex-shrink-0 text-[10px] text-ink-faint">reloads itself</span>;
  }
  if ((spec.watch?.length ?? 0) > 0 && runtime.status === 'ready') {
    return <span className="flex-shrink-0 text-[10px] text-ink-faint">restarts on changes</span>;
  }
  return null;
}

function RowMenu({
  workspaceId,
  spec,
  binding,
  live,
}: {
  workspaceId: string;
  spec: ServiceSpec;
  binding?: { ref: string; path: string };
  live: boolean;
}) {
  const [open, setOpen] = useState(false);
  const setPinned = useServicesStore((s) => s.setPinned);
  const setDebug = useServicesStore((s) => s.setDebug);
  const removeMany = useServicesStore((s) => s.removeMany);
  const revealConfig = useServicesStore((s) => s.revealConfig);
  const [duplicating, setDuplicating] = useState(false);
  const [addingTask, setAddingTask] = useState(false);
  // Leaving the menu closes it. A short grace covers the gap between the
  // button and the list, and a slightly wobbly pointer on the way in.
  const leaveTimer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(leaveTimer.current), []);
  const anchor = useRef<HTMLSpanElement>(null);
  const up = useOpensUp(anchor, open, 260);

  return (
    <span
      ref={anchor}
      className="relative"
      onMouseEnter={() => window.clearTimeout(leaveTimer.current)}
      onMouseLeave={() => {
        window.clearTimeout(leaveTimer.current);
        leaveTimer.current = window.setTimeout(() => setOpen(false), 250);
      }}
    >
      <IconButton title="More" onClick={() => setOpen((o) => !o)} fill>
        <circle cx="3" cy="8" r="1.2" />
        <circle cx="8" cy="8" r="1.2" />
        <circle cx="13" cy="8" r="1.2" />
      </IconButton>
      {open && (
        <div
          className={
            'absolute right-0 z-20 w-[240px] rounded-md border border-card-strong bg-surface-elevated py-1 text-[11px] shadow-lg ' +
            (up ? 'bottom-full mb-1' : 'top-full mt-1')
          }
        >
          <MenuItem
            onClick={() => {
              setDuplicating(true);
              setOpen(false);
            }}
          >
            Another copy of this…
          </MenuItem>
          {binding && (
            <MenuItem
              onClick={() => {
                setAddingTask(true);
                setOpen(false);
              }}
            >
              Add a task for this checkout…
            </MenuItem>
          )}
          {spec.debugPort !== undefined && (
            <MenuItem
              onClick={() => {
                void setDebug(workspaceId, spec.id, !spec.debugEnabled);
                setOpen(false);
              }}
            >
              {live
                ? spec.debugEnabled ? 'Restart normally' : `Restart with debugger on :${spec.debugPort}`
                : spec.debugEnabled ? 'Use normal launch next time' : `Use debugger on next start (:${spec.debugPort})`}
            </MenuItem>
          )}
          <MenuItem
            onClick={() => {
              void setPinned(workspaceId, spec.id, spec.pinnedRef ? undefined : binding?.ref);
              setOpen(false);
            }}
          >
            {spec.pinnedRef ? `Unpin from ${spec.pinnedRef}` : `Keep on ${binding?.ref ?? 'this branch'}`}
          </MenuItem>
          <MenuItem
            onClick={() => {
              void revealConfig(workspaceId, spec.id);
              setOpen(false);
            }}
          >
            Open its config folder
          </MenuItem>
          <div className="my-1 h-px bg-card-border" />
          {/* No "really?" step: the toast that follows can put it back. */}
          <MenuItem
            danger
            onClick={() => {
              void removeMany([logKey(workspaceId, spec.id)]);
              setOpen(false);
            }}
          >
            Remove from this list
          </MenuItem>
        </div>
      )}
      {duplicating && (
        <DuplicateSheet
          workspaceId={workspaceId}
          spec={spec}
          onClose={() => setDuplicating(false)}
        />
      )}
      {addingTask && (
        <AddTaskSheet workspaceId={workspaceId} spec={spec} onClose={() => setAddingTask(false)} />
      )}
    </span>
  );
}

// ── duplicate ───────────────────────────────────────────────────────────────

/// Another service off the same module, differing only in the options it
/// states. The five processors in one Tiltfile, without five copies of thirty
/// flags to keep in step.
function DuplicateSheet({
  workspaceId,
  spec,
  onClose,
}: {
  workspaceId: string;
  spec: ServiceSpec;
  onClose: () => void;
}) {
  const duplicate = useServicesStore((s) => s.duplicate);
  const [name, setName] = useState(`${spec.name}-copy`);
  const [group, setGroup] = useState(spec.group ?? '');
  const [text, setText] = useState('');

  return (
    <Sheet onClose={onClose}>
      <div className="border-b border-card px-4 py-3">
        <div className="text-sm font-semibold">Another copy of {spec.name}</div>
        <div className="mt-0.5 text-[11px] text-ink-muted">
          Same command, same checkout — a different set of startup options and its own row.
        </div>
      </div>

      <div className="flex flex-col gap-3 px-4 py-3.5">
        <Field label="Call it">
          <input className="field w-full px-2 py-1.5 text-xs" value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field label="Group">
          <input
            className="field w-full px-2 py-1.5 text-xs"
            value={group}
            placeholder="Processors"
            onChange={(e) => setGroup(e.target.value)}
          />
        </Field>
        <Field label="Different how">
          <textarea
            className="field h-[92px] w-full px-2 py-1.5 font-mono text-[11px]"
            placeholder={'-Dprocessor.types=PROC,PROC_HIGH\n-Dhibernate.cache.enabled=true'}
            value={text}
            onChange={(e) => setText(e.target.value)}
          />
          <p className="mt-1 text-[10px] text-ink-faint">
            Paste the flags that differ — everything else comes from {spec.name} and stays in step.
          </p>
        </Field>
      </div>

      <div className="flex items-center gap-2 border-t border-card px-4 py-3">
        <span className="flex-1 text-[10.5px] text-ink-faint">
          Copies share the checkout. Nothing is duplicated on disk.
        </span>
        <button className="review-btn" onClick={onClose}>
          Cancel
        </button>
        <button
          className="review-btn-primary"
          disabled={!name.trim()}
          onClick={async () => {
            await duplicate(workspaceId, spec.id, {
              name: name.trim(),
              group: group.trim() || undefined,
              options: parseOptionText(text),
            });
            onClose();
          }}
        >
          Create
        </button>
      </div>
    </Sheet>
  );
}

// ── detail ──────────────────────────────────────────────────────────────────

type Tab = 'output' | 'settings' | 'overrides';

function Detail() {
  const stacks = useServicesStore((s) => s.stacks);
  const selected = useServicesStore((s) => s.selected);
  const pending = useServicesStore((s) => s.pendingLease);
  const [tab, setTab] = useState<Tab>('output');

  // A refused start explains itself above the output. Landing on Options
  // instead would mean the explanation arrived on a tab nobody was looking at,
  // which is the whole failure this is fixing.
  const blockedOn = Object.values(pending).find(Boolean)?.serviceId;
  const failedAt = useServicesStore((s) => s.failedAt);
  useEffect(() => {
    if (blockedOn) setTab('output');
  }, [blockedOn]);
  useEffect(() => {
    if (failedAt) setTab('output');
  }, [failedAt]);
  // Picking a service is asking to see what it is doing. Settings stay one
  // click away, but they are not what the next service opens on.
  const selectedKey = Object.entries(selected)
    .filter(([, id]) => id)
    .map(([ws, id]) => `${ws}:${id}`)
    .join(',');
  useEffect(() => {
    setTab('output');
  }, [selectedKey]);

  const found = Object.values(stacks)
    .map((stack) => {
      const id = selected[stack.workspaceId];
      const spec = id ? stack.services.find((s) => s.id === id) : undefined;
      return spec ? { stack, spec } : null;
    })
    .find(Boolean) as { stack: StackView; spec: ServiceSpec } | undefined;

  if (!found) {
    return (
      <div className="flex flex-1 items-center justify-center border-l border-card text-xs text-ink-faint">
        Pick a service to see what it is doing
      </div>
    );
  }

  const { stack, spec } = found;
  const binding = stack.bindings.find((b) => b.serviceId === spec.id);
  const runtime = stack.runtimes.find((r) => r.serviceId === spec.id);

  return (
    <div className="flex min-w-0 flex-1 flex-col border-l border-card">
      <div className="flex-shrink-0 px-4 pt-3">
        <div className="flex items-center gap-2.5">
          <span className="text-sm font-semibold">{spec.name}</span>
          {spec.copyOf && (
            <span className="rounded bg-backend-claude/15 px-1.5 py-px text-[10px] text-backend-claude">
              a copy
            </span>
          )}
          {spec.task && (
            <span className="rounded bg-card-strong px-1.5 py-px text-[10px] text-ink-muted">runs once</span>
          )}
          {(runtime?.status === 'ready' || runtime?.status === 'done') && (
            <span className="rounded bg-green-500/15 px-1.5 py-px text-[10px] text-green-700 dark:text-green-300">
              {runtime.status === 'done' && runtime.ranRef ? `done on ${shortRef(runtime.ranRef)}` : runtime.status}
            </span>
          )}
          <div className="flex-1" />
          {/* The row's controls are for picking something out of a list; once
              you are looking AT a service, the thing you want is here, where
              you already are. */}
          {!spec.task && <TaskActions workspaceId={stack.workspaceId} spec={spec} />}
          <HeaderActions
            workspaceId={stack.workspaceId}
            spec={spec}
            live={isServiceLive(runtime?.status ?? 'stopped')}
          />
          {binding && (
            <RebindMenu
              workspaceId={stack.workspaceId}
              serviceId={spec.id}
              binding={binding}
              pinnedRef={spec.pinnedRef}
            />
          )}
        </div>
        <div className="mt-1 flex items-center gap-2 text-[10.5px] text-ink-faint">
          {/* The step that is the service, not the whole line: `. nvm.sh && nvm
              use 12 && … && ng serve` reads as setup. The full command is on
              hover and one click away, where it can be edited. */}
          <button
            className="min-w-0 truncate text-left font-mono hover:text-ink"
            title={spec.command.length > 0 ? `${commandText(spec.command)}\n\nClick to edit` : undefined}
            onClick={() => setTab('settings')}
          >
            {spec.command.length > 0 ? commandSummary(spec.command) : 'no command yet'}
          </button>
          {binding && (
            <>
              <span className="flex-shrink-0">·</span>
              <span title={binding.ref} className="max-w-[260px] flex-shrink-0 truncate font-mono text-accent">
                {shortRef(binding.ref)}
              </span>
            </>
          )}
          {spec.port !== undefined && (
            <>
              <span className="flex-shrink-0">·</span>
              <span className="flex-shrink-0 font-mono">:{spec.port}</span>
            </>
          )}
        </div>

        <div className="mt-3 flex gap-0.5 border-b border-card">
          <TabButton on={tab === 'output'} onClick={() => setTab('output')}>
            Output
          </TabButton>
          <TabButton on={tab === 'settings'} onClick={() => setTab('settings')}>
            Settings
          </TabButton>
          <TabButton on={tab === 'overrides'} onClick={() => setTab('overrides')}>
            Options{' '}
            <span className="text-ink-faint">{(spec.options ?? []).length || ''}</span>
          </TabButton>
        </div>
      </div>

      {tab === 'output' && (
        <Output workspaceId={stack.workspaceId} spec={spec} runtime={runtime} binding={binding} />
      )}
      {tab === 'settings' && (
        <Settings
          key={`${stack.workspaceId}:${spec.id}`}
          workspaceId={stack.workspaceId}
          spec={spec}
          binding={binding}
        />
      )}
      {tab === 'overrides' && <Options workspaceId={stack.workspaceId} spec={spec} stack={stack} />}
    </div>
  );
}

/// What went wrong, and what to do about it.
///
/// The findings come from rules that compare what overcli set against what the
/// process reported, a placeholder against the file that defines it, this
/// service's options against a config file next door. Each shows its evidence,
/// because advice you cannot check is advice you follow once.
function Failure({
  workspaceId,
  spec,
  runtime,
}: {
  workspaceId: string;
  spec: ServiceSpec;
  runtime: ServiceRuntime;
}) {
  const start = useServicesStore((s) => s.start);
  const promptMachineNeeds = useServicesStore((s) => s.promptMachineNeeds);
  const findings = useServicesStore((s) => s.findings[logKey(workspaceId, spec.id)]) ?? [];
  const [shown, setShown] = useState<string | null>(null);

  return (
    <div className="flex-shrink-0 border-b border-red-500/30 bg-red-500/10">
      <div className="flex items-center gap-2 px-4 py-2 text-xs">
        <span className="flex-1">
          {runtime.lastError ?? 'It stopped on its own.'}
          {findings.length === 0 && ' The output says why.'}
        </span>
        {missingNamesFrom(runtime.lastError).length > 0 && (
          <button
            className="svc-btn-primary"
            onClick={() => void promptMachineNeeds([workspaceId])}
          >
            Set values
          </button>
        )}
        <button className="svc-btn" onClick={() => void start(workspaceId, spec.id)}>
          Try again
        </button>
      </div>

      {findings.map((finding) => (
        <div key={finding.id} className="border-t border-red-500/20 px-4 py-2">
          <div className="flex items-center gap-2">
            <span className="text-[11.5px] font-medium">{finding.title}</span>
            <button
              className="text-[10px] text-ink-faint hover:text-ink"
              onClick={() => setShown((s) => (s === finding.id ? null : finding.id))}
            >
              {shown === finding.id ? 'Hide' : 'Why?'}
            </button>
            <div className="flex-1" />
            <FindingAction
              workspaceId={workspaceId}
              spec={spec}
              action={finding.action}
              port={finding.port ?? spec.port}
            />
          </div>
          <p className="mt-0.5 text-[10.5px] leading-4 text-ink-muted">{finding.detail}</p>
          {shown === finding.id && (
            <div className="mt-1.5 flex flex-col gap-0.5">
              {finding.evidence.map((line, i) => (
                <div key={i} className="truncate font-mono text-[10px] text-ink-faint">
                  {line}
                </div>
              ))}
            </div>
          )}
        </div>
      ))}

      <AskAi workspaceId={workspaceId} serviceId={spec.id} ruled={findings.length > 0} />
    </div>
  );
}

/// The long tail, and only the long tail.
///
/// The rules above answer the cases that can be answered by comparing what
/// overcli set against what the process reported. This is what is left, and it
/// is deliberately a button rather than something that happens on its own:
/// asking costs a model call, the answer is a guess, and a confident wrong
/// answer arriving unbidden is worse than a pane that says nothing. When the
/// rules DID find something, this sits quietly underneath them as a second
/// opinion rather than leading.
function AskAi({
  workspaceId,
  serviceId,
  ruled,
}: {
  workspaceId: string;
  serviceId: string;
  ruled: boolean;
}) {
  const askAi = useServicesStore((s) => s.askAi);
  const cancelAskAi = useServicesStore((s) => s.cancelAskAi);
  const state = useServicesStore((s) => s.suggestions[logKey(workspaceId, serviceId)]);

  if (!state) {
    return (
      <div className="flex items-center gap-2 border-t border-red-500/20 px-4 py-1.5">
        <span className="text-[10.5px] text-ink-faint">
          {ruled ? 'Not it?' : 'Nothing here recognised this one.'}
        </span>
        <button className="svc-btn" onClick={() => void askAi(workspaceId, serviceId)}>
          Ask AI
        </button>
      </div>
    );
  }

  if (state.status === 'asking') {
    return (
      <div className="flex items-center gap-2 border-t border-red-500/20 px-4 py-1.5">
        <span className="text-[10.5px] text-ink-muted">Reading the output and the checkout…</span>
        <div className="flex-1" />
        <button className="svc-btn" onClick={() => void cancelAskAi(workspaceId, serviceId)}>
          Stop
        </button>
      </div>
    );
  }

  if (state.status === 'failed') {
    return (
      <div className="flex items-center gap-2 border-t border-red-500/20 px-4 py-1.5">
        <span className="text-[10.5px] text-ink-faint">{state.error}</span>
        <button className="svc-btn" onClick={() => void askAi(workspaceId, serviceId)}>
          Try again
        </button>
      </div>
    );
  }

  return (
    <div className="border-t border-red-500/20 px-4 py-2">
      <div className="flex items-center gap-2">
        {/* Labelled every time. A guess presented like a finding is how people
            stop trusting the findings. */}
        <span className="rounded border border-card-strong px-1 py-px text-[9.5px] leading-none text-ink-faint">
          a guess · {state.backend}
        </span>
        <div className="flex-1" />
        <button
          className="text-[10px] text-ink-faint hover:text-ink"
          onClick={() => void askAi(workspaceId, serviceId)}
        >
          Ask again
        </button>
      </div>
      <p className="mt-1 whitespace-pre-wrap text-[10.5px] leading-4 text-ink-muted">
        {state.text}
      </p>
      {state.command && (
        <SuggestedCommand workspaceId={workspaceId} serviceId={serviceId} command={state.command} />
      )}
    </div>
  );
}

/// The one obvious thing to do, when there is one.
function FindingAction({
  workspaceId,
  spec,
  action,
  port,
}: {
  workspaceId: string;
  spec: ServiceSpec;
  action?: string;
  /// The port the finding is about, which the output may have named
  /// differently from the saved one.
  port?: number;
}) {
  const start = useServicesStore((s) => s.start);
  const freePortAndStart = useServicesStore((s) => s.freePortAndStart);
  const revealConfig = useServicesStore((s) => s.revealConfig);

  if (action === 'free-port' && port !== undefined) {
    return (
      <button
        className="svc-btn"
        onClick={() => void freePortAndStart(workspaceId, spec.id, port)}
      >
        Stop it and start
      </button>
    );
  }
  if (action === 'mirror-config') {
    // Mirroring happens on every start; the useful action is to try again now
    // that the reason is understood.
    return (
      <button className="svc-btn" onClick={() => void start(workspaceId, spec.id)}>
        Link them and start
      </button>
    );
  }
  if (action === 'import-options' || action === 'edit-options') {
    return (
      <button className="svc-btn" onClick={() => void revealConfig(workspaceId, spec.id)}>
        Open its config folder
      </button>
    );
  }
  return null;
}

/// The tasks this service waits for, runnable on their own — publishing to
/// Maven local again shouldn't mean hunting for the task in the list.
function TaskActions({ workspaceId, spec }: { workspaceId: string; spec: ServiceSpec }) {
  const stack = useServicesStore((s) => s.stacks[workspaceId]);
  const start = useServicesStore((s) => s.start);
  const tasks = (spec.deps ?? [])
    .map((id) => stack?.services.find((s) => s.id === id))
    .filter((s): s is ServiceSpec => !!s?.task);

  return (
    <>
      {tasks.map((task) => {
        const status = stack?.runtimes.find((r) => r.serviceId === task.id)?.status ?? 'stopped';
        const running = isServiceLive(status);
        return (
          <button
            key={task.id}
            className="svc-btn"
            disabled={running}
            title={commandText(task.command)}
            onClick={() => void start(workspaceId, task.id)}
          >
            {running ? `${task.name}…` : `Run ${task.name}`}
          </button>
        );
      })}
    </>
  );
}

/// Start, stop and restart for the service on screen.
function HeaderActions({
  workspaceId,
  spec,
  live,
}: {
  workspaceId: string;
  spec: ServiceSpec;
  live: boolean;
}) {
  const start = useServicesStore((s) => s.start);
  const stop = useServicesStore((s) => s.stop);
  const restart = useServicesStore((s) => s.restart);
  const setDebug = useServicesStore((s) => s.setDebug);

  const startDebug = async () => {
    await setDebug(workspaceId, spec.id, true);
    if (!live) await start(workspaceId, spec.id);
  };

  if (!live) {
    return (
      <>
        <button className="svc-btn-go" onClick={() => void start(workspaceId, spec.id)}>
          {spec.task ? 'Run' : 'Start'}
        </button>
        {spec.debugPort !== undefined && !spec.task && !spec.debugEnabled && (
          <button className="svc-btn" onClick={() => void startDebug()}>
            Debug
          </button>
        )}
      </>
    );
  }
  return (
    <>
      <button className="svc-btn" onClick={() => void restart(workspaceId, spec.id)}>
        Restart
      </button>
      {spec.debugPort !== undefined && !spec.task && (
        <button className="svc-btn" onClick={() => void setDebug(workspaceId, spec.id, !spec.debugEnabled)}>
          {spec.debugEnabled ? 'Restart normally' : 'Restart with debugger'}
        </button>
      )}
      <button className="svc-btn-stop" onClick={() => void stop(workspaceId, spec.id)}>
        Stop
      </button>
    </>
  );
}

function Output({
  workspaceId,
  spec,
  runtime,
  binding,
}: {
  workspaceId: string;
  spec: ServiceSpec;
  runtime?: ServiceRuntime;
  binding?: { ref: string; path: string };
}) {
  const lines = useServicesStore((s) => s.logs[logKey(workspaceId, spec.id)]) ?? [];
  const caught = useServicesStore((s) => s.exceptions[logKey(workspaceId, spec.id)]);
  const projects = useStore((s) => s.projects);
  const flows = useFlowsStore((s) => s.flows);
  const flowsLoaded = useFlowsStore((s) => s.loaded);
  const reloadFlows = useFlowsStore((s) => s.reload);
  useEffect(() => {
    if (!flowsLoaded) void reloadFlows(projects.map((p) => p.path));
  }, [flowsLoaded, reloadFlows, projects]);

  // Where a conversation about this output belongs — see `askAboutOutput`.
  const placeFor = (text: string) => {
    const store = useStore.getState();
    const target = chatTargetFor({
      workspaceId,
      projectId: spec.projectId,
      binding,
      projects: store.projects,
      workspaces: store.workspaces,
    });
    const prompt = outputPrompt({ name: spec.name, ref: binding?.ref, command: spec.command, text });
    return { store, target, prompt };
  };

  const askAbout = (text: string) => askWith(placeFor(text).prompt);

  const askWith = async (prompt: string) => {
    const { store, target } = placeFor('');
    if (!target) return;
    if (target.kind === 'worktree') {
      const conv = await store.newConversationInWorktree({
        projectPath: target.projectPath,
        worktreePath: target.worktreePath,
        branchName: target.branch,
        name: `${spec.name} output`,
      });
      if (!conv) return;
      store.setDraft(conv.id, prompt);
      store.setDetailMode('conversation');
      return;
    }
    // Seeded, not sent, like asking about a document.
    store.setDraft('__welcome__', prompt);
    if (target.kind === 'project') store.startNewConversation(target.projectId);
    else store.startNewConversationInWorkspace(target.workspaceId);
  };

  // The whole log, by path: a failure an hour back is long gone from any
  // selection, and an agent can read the file itself.
  const askAboutFile = (file: string) => {
    const command = spec.command.join(' ').replace(/`/g, '');
    const prompt = [
      `The service **${spec.name}**${binding?.ref ? ` (on \`${binding.ref}\`)` : ''} is misbehaving.`,
      command ? `It runs \`${command}\`.` : '',
      '',
      `Its full output, timestamped, is in \`${file}\` — runs are separated by \`── start …\` lines and end with \`── failed/stopped …\`.`,
      'Read the most recent run and tell me what went wrong.',
    ]
      .filter((l, i) => l !== '' || i === 2)
      .join('\n');
    return askWith(prompt);
  };

  const runFlow = (flowId: string, text: string) => {
    const { store, target, prompt } = placeFor(text);
    store.setDraft(`__flow-launch:${flowId}__`, prompt);
    store.openSheet({ type: 'flowLaunch', flowId, target: target ? flowTargetFor(target) : undefined });
  };
  const start = useServicesStore((s) => s.start);
  const lease = useServicesStore((s) => s.pendingLease[workspaceId]);
  const dismiss = useServicesStore((s) => s.dismissLease);
  const freePortAndStart = useServicesStore((s) => s.freePortAndStart);
  const recheckLease = useServicesStore((s) => s.recheckLease);

  const held = lease?.serviceId === spec.id && lease.lease.kind === 'held' ? lease.lease : null;
  const outside = held?.claim.stackId === 'external';
  // Something answered on the port but no lookup could name it — usually a
  // process already exiting, or one owned by another user.
  const unnamed = outside && !held?.claim.holder;
  // overcli's own dev server: never offered for stopping. A service saved
  // with overcli's port usually has the wrong port saved, so starting anyway
  // is the useful way out.
  const ownPort = outside && held?.claim.holderKind === 'self';

  // The port was checked once, when Start was pressed. Keep asking while the
  // banner is up, so it goes away when the port does rather than insisting
  // on something that stopped being true seconds later.
  useEffect(() => {
    if (!outside) return;
    void recheckLease(workspaceId);
    const timer = window.setInterval(() => void recheckLease(workspaceId), 3_000);
    return () => window.clearInterval(timer);
  }, [outside, workspaceId, recheckLease]);

  return (
    <>
      {lease?.serviceId === spec.id && lease.lease.kind === 'held' && (
        <div className="flex flex-shrink-0 items-center gap-2 border-b border-amber-500/30 bg-amber-500/10 px-4 py-2 text-xs">
          <span className="flex-1">
            {unnamed ? (
              <>
                Something was answering on port <span className="font-mono">{lease.lease.claim.port}</span>{' '}
                but could not be identified — it may already be gone.
              </>
            ) : ownPort ? (
              <>
                Port <span className="font-mono">{lease.lease.claim.port}</span> is overcli's own dev server
                {lease.lease.claim.holder ? ` (${lease.lease.claim.holder})` : ''}. If this service does not
                really listen there, correct its port in Settings.
              </>
            ) : held?.claim.holderKind === 'stale' ? (
              <>
                Port <span className="font-mono">{lease.lease.claim.port}</span> is held by a leftover copy of this
                service{lease.lease.claim.holder ? ` — ${lease.lease.claim.holder}` : ''}. Whatever started it has
                exited.
              </>
            ) : (
              <>
                Port <span className="font-mono">{lease.lease.claim.port}</span> is already taken
                {lease.lease.claim.holder ? ` by ${lease.lease.claim.holder}` : ''}.
              </>
            )}
          </span>
          {unnamed ? (
            <button className="svc-btn" onClick={() => void start(workspaceId, spec.id)}>
              Try again
            </button>
          ) : ownPort ? (
            <button
              className="svc-btn"
              onClick={() => {
                dismiss(workspaceId);
                void start(workspaceId, spec.id, undefined, true);
              }}
            >
              Start anyway
            </button>
          ) : (
            /* The commonest cause is a service overcli started that outlived
               the app — killed rather than quit. Stopping it is a deliberate
               click, never automatic, and only offered when there is a named
               process to stop. */
            <button
              className="svc-btn"
              onClick={() =>
                void freePortAndStart(
                  workspaceId,
                  spec.id,
                  lease.lease.kind === 'held' ? lease.lease.claim.port : 0,
                )
              }
            >
              Stop it and start
            </button>
          )}
          {lease.lease.alongside && (
            <button
              className="svc-btn"
              onClick={async () => {
                dismiss(workspaceId);
                await start(workspaceId, spec.id, lease.lease.kind === 'held' ? lease.lease.alongside!.offset : 0);
              }}
            >
              Use :{lease.lease.alongside.port} instead
            </button>
          )}
          <button className="px-2 text-[11px] text-ink-muted" onClick={() => dismiss(workspaceId)}>
            Dismiss
          </button>
        </div>
      )}
      {runtime?.status === 'failed' && (
        <Failure workspaceId={workspaceId} spec={spec} runtime={runtime} />
      )}

      {/* Keyed per service: the search and level toggles are about the log
          being read, and must not follow the user to the next one. */}
      <LogView
        key={logKey(workspaceId, spec.id)}
        lines={lines}
        onClear={() => void useServicesStore.getState().clearLog(workspaceId, spec.id)}
        selection={{ onAsk: (text) => void askAbout(text), flows, onRunFlow: runFlow }}
        exceptions={caught}
        file={{
          reveal: () => void useServicesStore.getState().revealLogFile(workspaceId, spec.id),
          path: () => useServicesStore.getState().logFile(workspaceId, spec.id),
          onAsk: (file) => void askAboutFile(file),
        }}
      />
    </>
  );
}

/// Where this service's settings live, and what reaches the process. The
/// answer to "how do my local properties survive a branch switch": they are
/// not in the checkout at all.
function Settings({
  workspaceId,
  spec,
  binding,
}: {
  workspaceId: string;
  spec: ServiceSpec;
  binding?: { ref: string; path: string };
}) {
  const revealConfig = useServicesStore((s) => s.revealConfig);
  // Every checkout of this service's repo the pane knows of: a command that
  // names any of them is pinned to it, whichever one the service is bound to.
  const choices = useServicesStore((s) => s.choices[spec.id]);
  const checkouts = useMemo(
    () => [binding?.path, ...(choices ?? []).map((c) => c.path)].filter((p): p is string => !!p),
    [binding?.path, choices],
  );
  const setGroup = useServicesStore((s) => s.setGroup);
  const [group, setGroupText] = useState(spec.group ?? '');
  const groupDirty = group.trim() !== (spec.group ?? '');
  const saveGroup = () => {
    if (groupDirty) void setGroup(workspaceId, spec.id, group.trim());
  };
  const injected = Object.entries(spec.config.inject ?? {});
  const linked = Object.keys(spec.config.link ?? {});
  const rendered = Object.keys(spec.config.render ?? {});

  // Grouped by the question someone arrives with — how does it start, where
  // does it run, what does it wait on — rather than a column of every field.
  return (
    <div className="min-h-0 flex-1 overflow-y-auto p-4">
      <div className="flex flex-col gap-4">
        <SettingsCard title="How it starts">
          <SettingsField label="Command">
            <CommandEditor key={spec.id} workspaceId={workspaceId} spec={spec} checkouts={checkouts} />
          </SettingsField>
          <div className="flex flex-wrap items-start gap-x-10 gap-y-4">
            <SettingsField label="Runs">
              <TaskToggle workspaceId={workspaceId} spec={spec} />
            </SettingsField>
            {/* A task is ready when it has finished; there is nothing to probe. */}
            {!spec.task && (
              <SettingsField label="Ready when" note="what anything waiting on it waits for">
                <ReadyEditor key={spec.id} workspaceId={workspaceId} spec={spec} />
              </SettingsField>
            )}
          </div>
          {!spec.task && (
            <SettingsField label="Code changes" note="choose who reloads this service">
              <ReloadEditor workspaceId={workspaceId} spec={spec} />
            </SettingsField>
          )}
        </SettingsCard>

        <div className="grid items-start gap-4 xl:grid-cols-2">
          <SettingsCard title="Where it runs">
            <SettingsField label="Checkout">
              {binding ? (
                <div className="flex min-w-0 items-center gap-2">
                  <span className="flex-shrink-0 font-mono text-[11.5px] text-accent">{shortRef(binding.ref)}</span>
                  <span title={binding.path} className="min-w-0 flex-1 truncate font-mono text-[11px] text-ink-faint">
                    {binding.path}
                  </span>
                  <RebindMenu
                    workspaceId={workspaceId}
                    serviceId={spec.id}
                    binding={binding}
                    pinnedRef={spec.pinnedRef}
                  />
                </div>
              ) : (
                <span className="text-[11px] text-ink-faint">Not on a checkout yet.</span>
              )}
            </SettingsField>

            <SettingsField label="Local settings" note="kept outside every checkout, so they survive a switch">
              <div className="flex items-start gap-3">
                <div className="flex min-w-0 flex-1 flex-col gap-1">
                  {injected.map(([key, value]) => (
                    <div key={key} className="truncate font-mono text-[10.5px]">
                      <span className="text-ink">{key}</span>
                      <span className="text-ink-faint">={value}</span>
                    </div>
                  ))}
                  {linked.map((file) => (
                    <div key={file} className="truncate font-mono text-[10.5px] text-ink">
                      {file} <span className="text-ink-faint">— linked in from that folder</span>
                    </div>
                  ))}
                  {rendered.map((file) => (
                    <div key={file} className="truncate font-mono text-[10.5px] text-ink">
                      {file} <span className="text-ink-faint">— written per branch</span>
                    </div>
                  ))}
                  {injected.length + linked.length + rendered.length === 0 && (
                    <span className="text-[11px] text-ink-faint">
                      Nothing set. A properties or .env file dropped in the folder reaches the next start.
                    </span>
                  )}
                </div>
                <button className="svc-btn flex-shrink-0" onClick={() => void revealConfig(workspaceId, spec.id)}>
                  Open the folder
                </button>
              </div>
            </SettingsField>

            <SettingsField label="Group" note="the list groups by it">
              <div className="flex items-center gap-2">
                <input
                  className="field w-[220px] px-2 py-1 text-xs"
                  value={group}
                  placeholder="REST services"
                  onChange={(e) => setGroupText(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') saveGroup();
                    if (e.key === 'Escape') setGroupText(spec.group ?? '');
                  }}
                  onBlur={saveGroup}
                />
                {groupDirty && (
                  <button className="svc-btn-primary" onMouseDown={(e) => e.preventDefault()} onClick={saveGroup}>
                    Save
                  </button>
                )}
              </div>
            </SettingsField>
          </SettingsCard>

          <SettingsCard title="Startup order">
            <SettingsField label="Waits for" note="started first, and must be ready">
              <DepsPicker workspaceId={workspaceId} spec={spec} />
            </SettingsField>
          </SettingsCard>
        </div>
      </div>
    </div>
  );
}

function ReloadEditor({ workspaceId, spec }: { workspaceId: string; spec: ServiceSpec }) {
  const setWatch = useServicesStore((s) => s.setWatch);
  const mode = reloadModeOf(spec);
  const [patterns, setPatterns] = useState(() => watchForMode(spec, 'restart').watch.join(', '));
  useEffect(
    () => setPatterns(watchForMode(spec, 'restart').watch.join(', ')),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the patterns are what matter, not the object
    [spec.id, spec.watch],
  );
  const savePatterns = () => {
    const watch = patterns.split(',').map((pattern) => pattern.trim()).filter(Boolean);
    if (watch.length > 0) void setWatch(workspaceId, spec.id, false, watch);
  };
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap gap-1.5">
        <ReloadChoice on={mode === 'self'} onClick={() => void setWatch(workspaceId, spec.id, true, [])}>
          Reloads itself
        </ReloadChoice>
        <ReloadChoice
          on={mode === 'restart'}
          onClick={() => {
            const { selfReloads, watch } = watchForMode(spec, 'restart');
            void setWatch(workspaceId, spec.id, selfReloads, watch);
          }}
        >
          Restart service
        </ReloadChoice>
        <ReloadChoice on={mode === 'off'} onClick={() => void setWatch(workspaceId, spec.id, false, [])}>
          Do nothing
        </ReloadChoice>
      </div>
      {mode === 'restart' && (
        <input
          className="field w-full px-2 py-1.5 font-mono text-[11px]"
          value={patterns}
          onChange={(e) => setPatterns(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') savePatterns();
            if (e.key === 'Escape') setPatterns((spec.watch ?? []).join(', '));
          }}
          onBlur={savePatterns}
          placeholder="src/**, config/**"
        />
      )}
      <span className="text-[10.5px] text-ink-faint">
        {mode === 'self'
          ? 'Vite, devtools, or the framework watches its own process.'
          : mode === 'restart'
            ? 'Changes are debounced, then the process restarts and readiness is checked again.'
            : 'The running process is left alone when files change.'}
      </span>
    </div>
  );
}

function ReloadChoice({
  on,
  onClick,
  children,
}: {
  on: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={
        'rounded-full border px-2.5 py-1 text-[10.5px] transition ' +
        (on
          ? 'border-accent/60 bg-accent/15 text-ink'
          : 'border-card-strong text-ink-muted hover:bg-card')
      }
    >
      {children}
    </button>
  );
}

function SettingsCard({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="rounded-md border border-card-strong bg-surface-muted">
      <h3 className="border-b border-card px-3.5 py-2.5 text-[12px] font-semibold text-ink">{title}</h3>
      <div className="flex flex-col gap-4 px-3.5 py-3.5">{children}</div>
    </section>
  );
}

function SettingsField({
  label,
  note,
  children,
}: {
  label: string;
  note?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <div className="flex items-baseline gap-2">
        <span className="text-[11px] font-medium text-ink-muted">{label}</span>
        {note && <span className="text-[10.5px] text-ink-faint">{note}</span>}
      </div>
      {children}
    </div>
  );
}

/// What a typed line runs as. Services spawn without a shell, so a line that
/// needs one — `nvm use 12 && ng serve` — gets one explicitly rather than
/// failing in a confusing way.
function commandArgv(line: string): string[] {
  const text = line.trim();
  const parsed = parseCommandLine(text);
  return parsed.needsShell ? ['sh', '-c', text] : parsed.argv;
}

/// A start command a model proposed, one press from being the service's own.
/// Shown whole: this is about to run on the user's machine.
function SuggestedCommand({
  workspaceId,
  serviceId,
  command,
}: {
  workspaceId: string;
  serviceId: string;
  command: string;
}) {
  const setCommand = useServicesStore((s) => s.setCommand);
  const current = useServicesStore(
    (s) => s.stacks[workspaceId]?.services.find((spec) => spec.id === serviceId)?.command,
  );
  const argv = commandArgv(command);
  const using =
    !!current && argv.length === current.length && argv.every((arg, i) => arg === current[i]);

  return (
    <div className="mt-1.5 flex items-start gap-2">
      <code className="min-w-0 flex-1 whitespace-pre-wrap break-all rounded border border-card-strong bg-surface px-2 py-1 font-mono text-[10.5px] leading-4 text-ink">
        {command}
      </code>
      <button
        className="svc-btn"
        disabled={using || argv.length === 0}
        onClick={() => void setCommand(workspaceId, serviceId, argv)}
      >
        {using ? 'In use' : 'Use this'}
      </button>
    </div>
  );
}

/// The part of a command worth a glance: the last step of a shell chain, with
/// `exec` and a `./node_modules/.bin/` prefix dropped. Everything before it is
/// setup — loading nvm, picking a version, compiling styles.
function commandSummary(command: readonly string[]): string {
  if (!(command.length === 3 && command[0] === 'sh' && command[1] === '-c')) return commandText(command);
  const steps = command[2].split(/&&|;/).map((s) => s.trim()).filter(Boolean);
  const last = steps[steps.length - 1] ?? command[2];
  return last.replace(/^exec\s+/, '').replace(/\.\/node_modules\/\.bin\//g, '');
}

/// argv as someone would type it. A `sh -c` wrapper shows as the line inside
/// it, since that is what was typed to produce it.
function commandText(command: readonly string[]): string {
  if (command.length === 3 && command[0] === 'sh' && command[1] === '-c') return command[2];
  return command
    .map((arg) => (arg === '' || /[\s"']/.test(arg) ? (arg.includes("'") ? `"${arg}"` : `'${arg}'`) : arg))
    .join(' ');
}

/// What the service runs. Saved with a button, like the readiness probe — a
/// half-typed command is not one anyone meant to start.
///
/// Shown one step per line and saved as the one line it was: see
/// `commandSteps`. A command that already holds newlines is left as written.
function CommandEditor({
  workspaceId,
  spec,
  checkouts,
}: {
  workspaceId: string;
  spec: ServiceSpec;
  checkouts: readonly string[];
}) {
  const setCommand = useServicesStore((s) => s.setCommand);
  const askAi = useServicesStore((s) => s.askAi);
  const cancelAskAi = useServicesStore((s) => s.cancelAskAi);
  const explanation = useServicesStore((s) => s.suggestions[explainKey(workspaceId, spec.id)]);
  const saved = commandText(spec.command);
  const asWritten = saved.includes('\n');
  const initial = splitSteps(saved).join('\n');
  const [draft, setDraft] = useState(initial);
  useEffect(() => {
    setDraft(initial);
  }, [initial]);

  const text = (asWritten ? draft : joinSteps(draft)).trim();
  const parsed = parseCommandLine(text);
  const argv = commandArgv(text);
  const changed = text !== saved;
  const pinnedTo = hardcodedCheckouts(draft, checkouts);
  const save = () => {
    if (changed && argv.length > 0) void setCommand(workspaceId, spec.id, argv);
  };

  // Grows with what is in it. A real start line runs to three hundred
  // characters, and the end of it — `--proxy-config` — is where the typo is.
  const box = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight}px`;
  }, [draft]);

  return (
    <div className="flex flex-col gap-2">
      <textarea
        ref={box}
        rows={1}
        spellCheck={false}
        className="field w-full resize-none overflow-hidden whitespace-pre-wrap break-all !bg-surface px-2.5 py-2 font-mono text-[11.5px] leading-[19px]"
        value={draft}
        placeholder="npm run dev"
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          // Enter is a new step now; the save is a deliberate chord.
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            save();
          }
          if (e.key === 'Escape') setDraft(initial);
        }}
      />
      {pinnedTo.length > 0 && (
        <div className="flex items-start gap-2.5 rounded border border-amber-500/30 bg-amber-500/5 px-2.5 py-2 text-[11px] leading-4">
          <span className="min-w-0 flex-1 text-ink">
            Keeps using <code className="break-all font-mono text-amber-700 dark:text-amber-300">{pinnedTo[0]}</code>
            {pinnedTo.length > 1 ? ` and ${pinnedTo.length - 1} more` : ''} after a switch to another worktree.{' '}
            <span className="text-ink-muted">
              <code className="font-mono">{'${CHECKOUT}'}</code> becomes whichever checkout it is on.
            </span>
          </span>
          <button className="svc-btn-primary flex-shrink-0" onClick={() => setDraft(useCheckoutPlaceholder(draft, checkouts))}>
            Replace with {'${CHECKOUT}'}
          </button>
        </div>
      )}
      <div className="flex items-start gap-2">
        <p className="min-w-0 flex-1 text-[10.5px] leading-4 text-ink-faint">
          {spec.command.length === 0 ? (
            'Nothing said how to start this, so it will not start until this is set.'
          ) : (
            <>
              {parsed.needsShell ? 'Runs through sh -c, saved as one line. ' : 'Runs in the checkout it is on. '}
              <code className="font-mono text-ink-muted">{'${CHECKOUT}'}</code> and{' '}
              <code className="font-mono text-ink-muted">{'${REF}'}</code> follow a switch; scripts can read{' '}
              <code className="font-mono text-ink-muted">$OVERCLI_CHECKOUT</code>. ⌘↩ saves.
            </>
          )}
        </p>
        {text !== '' && (
          <button
            className="svc-btn"
            title="Ask a model what this command does, step by step"
            disabled={explanation?.status === 'asking'}
            onClick={() => void askAi(workspaceId, spec.id, 'explain', draft)}
          >
            {explanation?.status === 'asking' ? 'Explaining…' : 'Explain'}
          </button>
        )}
        {changed && (
          <button className="svc-btn" onClick={() => setDraft(initial)}>
            Revert
          </button>
        )}
        <button className="svc-btn-primary" disabled={!changed || argv.length === 0} onClick={save}>
          Save
        </button>
      </div>
      {explanation?.status === 'asking' && (
        <div className="flex items-center gap-2">
          <span className="text-[10.5px] text-ink-muted">Reading the command…</span>
          <button className="svc-btn" onClick={() => void cancelAskAi(workspaceId, spec.id, 'explain')}>
            Stop
          </button>
        </div>
      )}
      {explanation?.status === 'failed' && (
        <div className="flex items-center gap-2">
          <span className="text-[10.5px] text-ink-faint">{explanation.error}</span>
          <button className="svc-btn" onClick={() => void askAi(workspaceId, spec.id, 'explain', draft)}>
            Try again
          </button>
        </div>
      )}
      {explanation?.status === 'answered' && (
        <div className="flex flex-col gap-2 rounded border border-card-strong bg-surface px-2.5 py-2">
          <div className="flex items-center gap-2">
            <span className="rounded border border-card-strong px-1 py-px text-[9.5px] leading-none text-ink-faint">
              a guess · {explanation.backend}
            </span>
            <div className="flex-1" />
            <button
              className="text-[10px] text-ink-faint hover:text-ink"
              onClick={() => void askAi(workspaceId, spec.id, 'explain', draft)}
            >
              Ask again
            </button>
            <button
              className="text-[10px] text-ink-faint hover:text-ink"
              onClick={() => void cancelAskAi(workspaceId, spec.id, 'explain')}
            >
              Dismiss
            </button>
          </div>
          {explanation.text && (
            <p className="whitespace-pre-wrap text-[11px] leading-[17px] text-ink-muted">{explanation.text}</p>
          )}
          {explanation.command && (
            <div className="flex items-start gap-2">
              <code className="min-w-0 flex-1 break-all font-mono text-[10.5px] text-ink">{explanation.command}</code>
              {/* Into the box, not saved: it is a guess, and Save is where someone agrees. */}
              <button className="svc-btn" onClick={() => setDraft(splitSteps(explanation.command!).join('\n'))}>
                Use this
              </button>
            </div>
          )}
        </div>
      )}
      {spec.command.length === 0 && (
        <SuggestCommand workspaceId={workspaceId} serviceId={spec.id} onUse={setDraft} />
      )}
    </div>
  );
}

/// A model's read of the checkout and the imported file, for a service that
/// arrived without a command. Fills the box rather than saving: it is a guess,
/// and Save is where someone agrees with it.
function SuggestCommand({
  workspaceId,
  serviceId,
  onUse,
}: {
  workspaceId: string;
  serviceId: string;
  onUse: (command: string) => void;
}) {
  const askAi = useServicesStore((s) => s.askAi);
  const cancelAskAi = useServicesStore((s) => s.cancelAskAi);
  const state = useServicesStore((s) => s.suggestions[logKey(workspaceId, serviceId)]);
  const ask = () => void askAi(workspaceId, serviceId, 'command');

  if (!state) {
    return (
      <div>
        <button className="svc-btn" onClick={ask}>
          Suggest a command
        </button>
      </div>
    );
  }

  if (state.status === 'asking') {
    return (
      <div className="flex items-center gap-2">
        <span className="text-[10.5px] text-ink-muted">Reading the checkout…</span>
        <button className="svc-btn" onClick={() => void cancelAskAi(workspaceId, serviceId)}>
          Stop
        </button>
      </div>
    );
  }

  if (state.status === 'failed') {
    return (
      <div className="flex items-center gap-2">
        <span className="text-[10.5px] text-ink-faint">{state.error}</span>
        <button className="svc-btn" onClick={ask}>
          Try again
        </button>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-1 rounded border border-card-strong px-2 py-1.5">
      <div className="flex items-center gap-2">
        <span className="rounded border border-card-strong px-1 py-px text-[9.5px] leading-none text-ink-faint">
          a guess · {state.backend}
        </span>
        <div className="flex-1" />
        <button className="text-[10px] text-ink-faint hover:text-ink" onClick={ask}>
          Ask again
        </button>
      </div>
      {state.text && (
        <p className="whitespace-pre-wrap text-[10.5px] leading-4 text-ink-muted">{state.text}</p>
      )}
      {state.command && (
        <div className="flex items-start gap-2">
          <code className="min-w-0 flex-1 break-all font-mono text-[10.5px]">{state.command}</code>
          <button className="svc-btn" onClick={() => onUse(state.command!)}>
            Use this
          </button>
        </div>
      )}
    </div>
  );
}

interface ReadyDraft {
  kind: ReadinessProbe['kind'];
  port: string;
  path: string;
  pattern: string;
  command: string;
  timeout: string;
}

/// Every field filled, whatever the current kind — switching the picker to
/// "a URL answers" should land on a sensible URL, not a blank.
function readyDraft(spec: ServiceSpec): ReadyDraft {
  const ready = spec.ready;
  return {
    kind: ready.kind,
    port: String(ready.kind === 'http' || ready.kind === 'tcp' ? ready.port : (spec.port ?? '')),
    path: ready.kind === 'http' ? ready.path : '/actuator/health',
    pattern: ready.kind === 'log' ? ready.pattern : 'Started .* in',
    command: ready.kind === 'command' ? ready.command.join(' ') : '',
    timeout: String(spec.readyTimeoutSec ?? DEFAULT_READY_TIMEOUT_SEC),
  };
}

/// The probe a draft describes, or what is wrong with it.
function draftProbe(draft: ReadyDraft): ReadinessProbe | string {
  const port = Number(draft.port);
  const portOk = Number.isInteger(port) && port > 0 && port < 65536;
  switch (draft.kind) {
    case 'http':
      if (!portOk) return 'Needs a port.';
      return { kind: 'http', port, path: draft.path.startsWith('/') ? draft.path : `/${draft.path}` };
    case 'tcp':
      return portOk ? { kind: 'tcp', port } : 'Needs a port.';
    case 'log':
      if (!draft.pattern.trim()) return 'Needs something to look for.';
      try {
        new RegExp(draft.pattern);
      } catch {
        return 'That is not a valid pattern.';
      }
      return { kind: 'log', pattern: draft.pattern };
    case 'command': {
      const command = draft.command.trim().split(/\s+/).filter(Boolean);
      return command.length > 0 ? { kind: 'command', command } : 'Needs a command.';
    }
    default:
      return { kind: 'none' };
  }
}

/// Whether `from` already waits on `target`, directly or through something it
/// waits on. What keeps the picker from offering a loop.
function waitsOn(services: readonly ServiceSpec[], from: string, target: string): boolean {
  const seen = new Set<string>();
  const visit = (id: string): boolean => {
    if (id === target) return true;
    if (seen.has(id)) return false;
    seen.add(id);
    return (services.find((s) => s.id === id)?.deps ?? []).some(visit);
  };
  return visit(from);
}

/// What this service waits for, and a way to add a task for it to wait on.
function DepsPicker({ workspaceId, spec }: { workspaceId: string; spec: ServiceSpec }) {
  const services = useServicesStore((s) => s.stacks[workspaceId]?.services) ?? [];
  const setDeps = useServicesStore((s) => s.setDeps);
  const [adding, setAdding] = useState(false);

  const deps = spec.deps ?? [];
  const nameOf = (id: string) => services.find((s) => s.id === id)?.name ?? id;
  // Tasks first: they are what a service most often waits on.
  const candidates = services
    .filter((s) => s.id !== spec.id && !deps.includes(s.id) && !waitsOn(services, s.id, spec.id))
    .sort((a, b) => Number(!!b.task) - Number(!!a.task) || a.name.localeCompare(b.name));

  return (
    <div className="flex flex-col gap-2">
      {deps.length > 0 ? (
        <div className="flex flex-wrap gap-1">
          {deps.map((id) => (
            <span key={id} className="flex items-center gap-1 rounded bg-card-strong px-1.5 py-0.5 text-[11px]">
              {nameOf(id)}
              <button
                className="text-ink-faint hover:text-ink"
                title="Stop waiting for this"
                onClick={() => void setDeps(workspaceId, spec.id, deps.filter((d) => d !== id))}
              >
                ×
              </button>
            </span>
          ))}
        </div>
      ) : (
        <span className="text-[10.5px] text-ink-faint">Starts without waiting for anything.</span>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <select
          className="field px-2 py-1 text-xs"
          value=""
          disabled={candidates.length === 0}
          onChange={(e) => {
            if (e.target.value) void setDeps(workspaceId, spec.id, [...deps, e.target.value]);
          }}
        >
          <option value="">Wait for…</option>
          {candidates.map((s) => (
            <option key={s.id} value={s.id}>
              {s.task ? `${s.name} (runs once)` : s.name}
            </option>
          ))}
        </select>
        <button className="svc-btn" onClick={() => setAdding(true)}>
          Add a task…
        </button>
      </div>
      {adding && <AddTaskSheet workspaceId={workspaceId} spec={spec} onClose={() => setAdding(false)} />}
    </div>
  );
}

/// A task for this service's checkout: publish to Maven local, build the
/// image. Offered from what the repo's own files say it can do, with the
/// command editable before anything is added.
function AddTaskSheet({
  workspaceId,
  spec,
  onClose,
}: {
  workspaceId: string;
  spec: ServiceSpec;
  onClose: () => void;
}) {
  const addTask = useServicesStore((s) => s.addTask);
  const [presets, setPresets] = useState<TaskPreset[] | null>(null);
  const [picked, setPicked] = useState<string>('custom');
  const [name, setName] = useState(`${spec.name}-task`);
  const [command, setCommand] = useState('');
  const [subpath, setSubpath] = useState<string | undefined>(undefined);
  const [runBefore, setRunBefore] = useState(true);
  const [busy, setBusy] = useState(false);

  const choose = (preset: TaskPreset) => {
    setPicked(preset.id);
    setName(preset.name);
    setCommand(commandText(preset.command));
    setSubpath(preset.subpath);
  };

  useEffect(() => {
    let live = true;
    void window.overcli.invoke('services:taskPresets', { workspaceId, serviceId: spec.id }).then((found) => {
      if (!live) return;
      setPresets(found);
      if (found[0]) choose(found[0]);
    });
    return () => {
      live = false;
    };
  }, [workspaceId, spec.id]);

  // `cd lib && ./gradlew publishToMavenLocal` is an ordinary way to write a
  // task, so a line that needs the shell gets one rather than being refused.
  const parsed = parseCommandLine(command);
  const argv = parsed.needsShell ? ['sh', '-c', command.trim()] : parsed.argv;
  const canCreate = name.trim() !== '' && argv.length > 0 && command.trim() !== '' && !busy;

  return (
    <Sheet onClose={onClose}>
      <div className="border-b border-card px-4 py-3">
        <div className="text-sm font-semibold">A task for {spec.name}</div>
        <div className="mt-0.5 text-[11px] text-ink-muted">
          Runs once, in the same checkout, and moves with it when you switch branches.
        </div>
      </div>

      <div className="flex max-h-[60vh] flex-col gap-3 overflow-y-auto px-4 py-3.5">
        <div className="flex flex-col gap-1">
          {presets === null && <span className="text-[11px] text-ink-faint">Looking at the checkout…</span>}
          {presets?.map((preset) => (
            <button
              key={preset.id}
              onClick={() => choose(preset)}
              className={
                'rounded-md border px-2.5 py-1.5 text-left ' +
                (picked === preset.id ? 'border-accent bg-accent/10' : 'border-card hover:bg-card-strong')
              }
            >
              <div className="text-xs font-medium">{preset.label}</div>
              <div className="truncate font-mono text-[10.5px] text-ink-muted">{commandText(preset.command)}</div>
              <div className="text-[10px] text-ink-faint">{preset.why}</div>
            </button>
          ))}
          <button
            onClick={() => {
              setPicked('custom');
              setCommand('');
              setSubpath(undefined);
              setName(`${spec.name}-task`);
            }}
            className={
              'rounded-md border px-2.5 py-1.5 text-left text-xs ' +
              (picked === 'custom' ? 'border-accent bg-accent/10' : 'border-card hover:bg-card-strong')
            }
          >
            Something else
          </button>
        </div>

        <Field label="Call it">
          <input className="field w-full px-2 py-1.5 text-xs" value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field label="Command">
          <input
            className="field w-full px-2 py-1.5 font-mono text-[11px]"
            value={command}
            placeholder="./gradlew publishToMavenLocal"
            onChange={(e) => setCommand(e.target.value)}
          />
          {subpath && <p className="mt-1 text-[10px] text-ink-faint">Runs in {subpath}.</p>}
        </Field>
        <label className="flex items-center gap-2 text-[11px] text-ink-muted">
          <Checkbox on={runBefore} onClick={() => setRunBefore((on) => !on)} className="flex" />
          Run it before {spec.name} starts
        </label>
      </div>

      <div className="flex items-center gap-2 border-t border-card px-4 py-3">
        <span className="flex-1 text-[10.5px] text-ink-faint">Options can be added on the task afterwards.</span>
        <button className="review-btn" onClick={onClose}>
          Cancel
        </button>
        <button
          className="review-btn-primary"
          disabled={!canCreate}
          onClick={async () => {
            setBusy(true);
            try {
              await addTask(workspaceId, spec.id, { name: name.trim(), command: argv, subpath, runBefore });
              onClose();
            } finally {
              setBusy(false);
            }
          }}
        >
          Add task
        </button>
      </div>
    </Sheet>
  );
}

/// Stays up, or runs once and exits — a publish to Maven local, a shared
/// library's build. Saved on click: there is nothing half-typed to protect.
function TaskToggle({ workspaceId, spec }: { workspaceId: string; spec: ServiceSpec }) {
  const setTask = useServicesStore((s) => s.setTask);
  return (
    <div className="flex flex-col gap-1.5">
      <select
        className="field w-fit px-2 py-1 text-xs"
        value={spec.task ? 'once' : 'up'}
        onChange={(e) => void setTask(workspaceId, spec.id, e.target.value === 'once')}
      >
        <option value="up">until stopped</option>
        <option value="once">once, to completion</option>
      </select>
      {spec.task && (
        <p className="text-[10.5px] text-ink-faint">
          Anything that waits on this runs it first, unless it has already finished on the branch it is
          on now. A failure stops them starting.
        </p>
      )}
    </div>
  );
}

/// What "up" means for this service, and how long it gets. Saved with a
/// button rather than on blur: a half-typed pattern is not a probe anyone meant.
function ReadyEditor({ workspaceId, spec }: { workspaceId: string; spec: ServiceSpec }) {
  const setReady = useServicesStore((s) => s.setReady);
  const saved = JSON.stringify([spec.ready, spec.readyTimeoutSec ?? DEFAULT_READY_TIMEOUT_SEC]);
  const [draft, setDraft] = useState(() => readyDraft(spec));
  // Reset when what is saved changes — not every time a reload hands over a
  // new spec object, which would wipe an edit in progress.
  useEffect(() => {
    setDraft(readyDraft(spec));
  }, [saved]);

  const edit = (patch: Partial<ReadyDraft>) => setDraft((d) => ({ ...d, ...patch }));
  const parsed = draftProbe(draft);
  // Keep what the form does not show, rather than dropping it on save.
  const probe =
    typeof parsed === 'string'
      ? null
      : parsed.kind === 'http' && spec.ready.kind === 'http' && spec.ready.okStatuses
        ? { ...parsed, okStatuses: spec.ready.okStatuses }
        : parsed;
  const timeout =
    draft.kind === 'none' ? (spec.readyTimeoutSec ?? DEFAULT_READY_TIMEOUT_SEC) : Number(draft.timeout);
  const timeoutOk = Number.isInteger(timeout) && timeout >= 5 && timeout <= 3600;
  const problem = typeof parsed === 'string' ? parsed : timeoutOk ? null : 'Allow between 5 and 3600 seconds.';
  const dirty = !!probe && JSON.stringify([probe, timeout]) !== saved;

  const portField = (
    <input
      className="field w-[64px] px-2 py-1 font-mono text-xs"
      value={draft.port}
      inputMode="numeric"
      placeholder="8080"
      onChange={(e) => edit({ port: e.target.value })}
    />
  );

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <select
          className="field px-2 py-1 text-xs"
          value={draft.kind}
          onChange={(e) => edit({ kind: e.target.value as ReadyDraft['kind'] })}
        >
          <option value="log">its output says</option>
          <option value="http">a URL answers</option>
          <option value="tcp">its port accepts a connection</option>
          <option value="command">a command succeeds</option>
          <option value="none">as soon as it starts</option>
        </select>
        {draft.kind === 'log' && (
          <input
            className="field w-[240px] px-2 py-1 font-mono text-xs"
            value={draft.pattern}
            placeholder="Started .* in"
            onChange={(e) => edit({ pattern: e.target.value })}
          />
        )}
        {draft.kind === 'http' && (
          <>
            <span className="font-mono text-[11px] text-ink-faint">GET :</span>
            {portField}
            <input
              className="field w-[180px] px-2 py-1 font-mono text-xs"
              value={draft.path}
              placeholder="/actuator/health"
              onChange={(e) => edit({ path: e.target.value })}
            />
          </>
        )}
        {draft.kind === 'tcp' && (
          <>
            <span className="font-mono text-[11px] text-ink-faint">:</span>
            {portField}
          </>
        )}
        {draft.kind === 'command' && (
          <input
            className="field w-[260px] px-2 py-1 font-mono text-xs"
            value={draft.command}
            placeholder="curl -sf localhost:8080/health"
            onChange={(e) => edit({ command: e.target.value })}
          />
        )}
      </div>
      {draft.kind !== 'none' && (
        <div className="flex flex-wrap items-center gap-1.5 text-[11px] text-ink-muted">
          Allow up to
          <input
            className="field w-[56px] px-2 py-1 text-xs"
            value={draft.timeout}
            inputMode="numeric"
            onChange={(e) => edit({ timeout: e.target.value })}
          />
          seconds, then call it slow and keep checking.
        </div>
      )}
      {/* Only once there is something to save: a Save sitting under an
          unchanged probe reads as a step still to do. */}
      {(dirty || problem) && (
      <div className="flex items-center gap-2">
        <button
          className="svc-btn-primary"
          disabled={!dirty || !!problem}
          onClick={() => {
            if (!probe) return;
            void setReady(
              workspaceId,
              spec.id,
              probe,
              timeout === DEFAULT_READY_TIMEOUT_SEC ? undefined : timeout,
            );
          }}
        >
          Save
        </button>
        <span className={'text-[10.5px] ' + (problem ? 'text-red-600 dark:text-red-400' : 'text-ink-faint')}>
          {problem ?? (dirty ? 'Takes effect on the next start.' : '')}
        </span>
      </div>
      )}
    </div>
  );
}

/// Shared options versus the ones that make this copy different — the only
/// place the difference between five nearly identical services is legible.
function Options({
  workspaceId,
  spec,
  stack,
}: {
  workspaceId: string;
  spec: ServiceSpec;
  stack: StackView;
}) {
  const resolved = useServicesStore((s) => s.resolved[logKey(workspaceId, spec.id)]) ?? [];
  const setOptions = useServicesStore((s) => s.setOptions);
  const setDebug = useServicesStore((s) => s.setDebug);
  const runtime = stack.runtimes.find((r) => r.serviceId === spec.id);
  const binding = stack.bindings.find((b) => b.serviceId === spec.id);
  const attachPort = runtime?.debugPort ?? spec.debugPort;
  const attachKind = runtime?.debugKind ?? spec.debugKind;
  const base = spec.copyOf ? stack.services.find((s) => s.id === spec.copyOf) : undefined;
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(() => optionsToText(spec.options ?? []));

  return (
    <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
      {base && (
        <Section title={`Shared with every copy of ${base.name}`}>
          <p className="mb-2 text-[10.5px] text-ink-faint">Edit once and all of them follow.</p>
          <div className="flex flex-wrap gap-1">
            {resolved
              .filter((o) => o.origin === 'shared')
              .map((o) => (
                <span
                  key={o.key}
                  className="rounded bg-card-strong px-1.5 py-0.5 font-mono text-[10.5px] text-ink-muted"
                >
                  {renderOption(o)}
                </span>
              ))}
            {resolved.every((o) => o.origin !== 'shared') && (
              <span className="text-[10.5px] text-ink-faint">Nothing shared yet.</span>
            )}
          </div>
        </Section>
      )}

      <Section title={base ? 'Only this copy' : 'Startup options'}>
        {editing ? (
          <>
            <textarea
              className="field h-[160px] w-full px-2 py-1.5 font-mono text-[11px]"
              value={text}
              onChange={(e) => setText(e.target.value)}
            />
            <div className="mt-2 flex gap-2">
              <button
                className="svc-btn-primary"
                onClick={async () => {
                  await setOptions(workspaceId, spec.id, parseOptionText(text));
                  setEditing(false);
                }}
              >
                Save
              </button>
              <button className="svc-btn" onClick={() => setEditing(false)}>
                Cancel
              </button>
              <span className="self-center text-[10.5px] text-ink-faint">
                Takes effect on the next start.
              </span>
            </div>
          </>
        ) : (
          <>
            <div className="flex flex-col gap-0.5">
              {(spec.options ?? []).length === 0 && (
                <span className="text-[10.5px] text-ink-faint">
                  {base
                    ? 'Identical to the original so far.'
                    : 'None — the command runs as written above.'}
                </span>
              )}
              {(spec.options ?? []).map((o) => {
                const r = resolved.find((x) => x.key === o.key && x.origin === 'own');
                return (
                  <div key={o.key} className="flex items-center gap-2 py-0.5">
                    <span className="w-[240px] truncate font-mono text-[11px] text-ink">{o.key}</span>
                    <span className="flex-1 truncate font-mono text-[11px] text-green-700 dark:text-green-300">
                      {o.value ?? ''}
                    </span>
                    {r?.overrides && (
                      <span className="text-[10px] text-ink-faint">replaces the shared one</span>
                    )}
                  </div>
                );
              })}
            </div>
            <button
              className="svc-btn mt-2"
              onClick={() => {
                setText(optionsToText(spec.options ?? []));
                setEditing(true);
              }}
            >
              Edit
            </button>
          </>
        )}
      </Section>

      {spec.debugPort !== undefined && (
        <Section title="Debugger">
          <label className="flex cursor-pointer items-center gap-2.5">
            <span
              className={
                'relative h-[17px] w-[30px] flex-shrink-0 rounded-full transition-colors ' +
                (spec.debugEnabled ? 'bg-amber-500' : 'bg-card-border-strong')
              }
              onClick={() => void setDebug(workspaceId, spec.id, !spec.debugEnabled)}
            >
              <span
                className={
                  'absolute top-[2px] h-[13px] w-[13px] rounded-full bg-surface transition-all ' +
                  (spec.debugEnabled ? 'right-[2px]' : 'left-[2px]')
                }
              />
            </span>
            <span className="text-[11.5px]">
              Attach on <span className="font-mono">:{attachPort}</span>
            </span>
            <span className="text-[10.5px] text-ink-faint">
              — a running service restarts immediately
            </span>
          </label>
          {attachKind && attachPort && (
            <div className="mt-2 flex items-center gap-2">
              <button
                className="svc-btn"
                onClick={() => void navigator.clipboard.writeText(attachConfiguration(spec.name, attachKind, attachPort))}
              >
                Copy IDE attach config
              </button>
              {binding && (
                <button className="svc-btn" onClick={() => void window.overcli.invoke('fs:openPath', binding.path)}>
                  Reveal bound checkout
                </button>
              )}
              <span className="font-mono text-[10.5px] text-ink-faint">127.0.0.1:{attachPort}</span>
            </div>
          )}
          {attachKind === 'debugpy' && (
            <p className="mt-2 text-[10.5px] text-ink-faint">Requires debugpy in this service's Python environment.</p>
          )}
          {attachKind === 'delve' && (
            <p className="mt-2 text-[10.5px] text-ink-faint">Requires the dlv command on Overcli's PATH.</p>
          )}
        </Section>
      )}
    </div>
  );
}

function renderOption(o: { key: string; value?: string }): string {
  return o.value === undefined || o.value === '' ? o.key : `${o.key}=${o.value}`;
}

function attachConfiguration(name: string, kind: NonNullable<ServiceSpec['debugKind']>, port: number): string {
  const common = { name: `Attach: ${name} (${port})`, request: 'attach' };
  const configuration = kind === 'jdwp'
    ? { ...common, type: 'java', hostName: '127.0.0.1', port }
    : kind === 'node-inspector'
      ? { ...common, type: 'node', address: '127.0.0.1', port, restart: true }
      : kind === 'debugpy'
        ? { ...common, type: 'debugpy', connect: { host: '127.0.0.1', port } }
        : { ...common, type: 'go', mode: 'remote', host: '127.0.0.1', port };
  return JSON.stringify({ version: '0.2.0', configurations: [configuration] }, null, 2);
}

// ── machine values ──────────────────────────────────────────────────────────

/// The handful of things that differ per developer rather than per service —
/// a database user, an SQS prefix, a path. One place, referred to as `${NAME}`
/// from any option.
function MachineValuesButton() {
  const machine = useServicesStore((s) => s.machine);
  const openMachineSheet = useServicesStore((s) => s.openMachineSheet);
  const count = machine.length;

  return (
    <button className="svc-btn" onClick={() => openMachineSheet()}>
      Machine values{count > 0 && <span className="ml-1 text-ink-faint">{count}</span>}
    </button>
  );
}

/// The sheet lives at the pane's root, opened through the store, so the
/// header button, the add flow and a failure can all open it — with the names
/// that are missing already in place.
function MachineValuesHost() {
  const sheet = useServicesStore((s) => s.machineSheet);
  const close = useServicesStore((s) => s.closeMachineSheet);
  if (!sheet) return null;
  return <MachineValuesSheet needs={sheet.needs} onClose={close} />;
}

/// "Missing machine values: DB_USER, DB_PASSWORD" -> the names. The supervisor
/// writes that line; reading it back saves a round trip for a button.
export function missingNamesFrom(lastError: string | undefined): string[] {
  const match = /^Missing machine values?: (.+)$/.exec(lastError ?? '');
  return match ? match[1].split(',').map((n) => n.trim()).filter(Boolean) : [];
}

/// One editable row. `pinned` means the user chose secret/plain themselves, so
/// renaming the value stops second-guessing them.
interface MachineRow extends MachineEntry {
  id: number;
  pinned?: boolean;
  /// Services that refer to this and cannot start without it.
  neededBy?: string[];
}

let nextMachineRowId = 1;

function MachineValuesSheet({
  onClose,
  needs = [],
}: {
  onClose: () => void;
  needs?: MachineValueNeed[];
}) {
  const machine = useServicesStore((s) => s.machine);
  const secureStorage = useServicesStore((s) => s.secureStorage);
  const saveMachine = useServicesStore((s) => s.saveMachine);
  const [rows, setRows] = useState<MachineRow[]>(() => {
    // What is needed goes first, empty and waiting, marked secret by name.
    const wanted = needs
      .filter((n) => !machine.some((e) => e.name === n.name))
      .map<MachineRow>((n) => ({
        id: nextMachineRowId++,
        name: n.name,
        value: '',
        secret: secureStorage && isSecretName(n.name),
        neededBy: n.services,
      }));
    const existing = machine.map((e) => ({ ...e, id: nextMachineRowId++, pinned: true }));
    const all = [...wanted, ...existing];
    return all.length > 0 ? all : [{ id: nextMachineRowId++, name: '', secret: false, value: '' }];
  });
  const neededCount = rows.filter((r) => r.neededBy && !r.value).length;
  const [error, setError] = useState<string>();

  const update = (id: number, patch: Partial<MachineRow>) =>
    setRows((rs) => rs.map((r) => (r.id === id ? { ...r, ...patch } : r)));

  const addRows = (values: MachineValues, replacing?: number) =>
    setRows((rs) => {
      const added = Object.entries(values).map(([name, value]) => ({
        id: nextMachineRowId++,
        name,
        value,
        secret: secureStorage && isSecretName(name),
      }));
      const kept = rs.filter((r) => r.id !== replacing && !(name(r) === '' && !r.value));
      // A pasted name that already exists replaces that row's value.
      return [
        ...kept.filter((r) => !added.some((a) => a.name === r.name)),
        ...added,
      ];
    });

  const secretCount = rows.filter((r) => r.secret).length;

  return (
    <Sheet onClose={onClose} width="w-[760px]">
      <div className="border-b border-card px-5 py-4">
        <div className="text-[15px] font-semibold">Machine values</div>
        <div className="mt-1 text-[12px] leading-relaxed text-ink-muted">
          Shared by every service. Refer to one from any option or variable as{' '}
          <span className="rounded bg-card-strong px-1 font-mono text-[11px]">${'{NAME}'}</span>.
          Paste a .env block into a name to add several at once.
        </div>
        {needs.length > 0 && (
          <div className="mt-3 rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-[12px] leading-relaxed text-amber-800 dark:text-amber-200">
            {neededCount > 0 ? (
              <>
                Your services refer to{' '}
                <b>
                  {needs.length} value{needs.length === 1 ? '' : 's'}
                </b>{' '}
                that {needs.length === 1 ? 'isn’t' : 'aren’t'} set on this machine yet. The run
                configuration only says a value is needed — fill {needs.length === 1 ? 'it' : 'them'}{' '}
                in here and they’ll be used by every service that asks.
              </>
            ) : (
              'All filled in. Save and the services can start.'
            )}
          </div>
        )}
      </div>

      <div className="max-h-[60vh] overflow-y-auto px-5 py-4">
        <div className="mb-2 flex items-center gap-3 px-1 text-[10.5px] font-medium uppercase tracking-wide text-ink-faint">
          <span className="w-[36%]">Name</span>
          <span className="flex-1">Value</span>
          <span className="w-8" />
        </div>

        <div className="flex flex-col gap-2">
          {rows.map((row) => (
            <MachineValueRow
              key={row.id}
              row={row}
              secureStorage={secureStorage}
              onChange={(patch) => update(row.id, patch)}
              onPaste={(values) => addRows(values, row.id)}
              onRemove={() => setRows((rs) => rs.filter((r) => r.id !== row.id))}
            />
          ))}
        </div>

        <button
          className="svc-btn mt-3"
          onClick={() =>
            setRows((rs) => [...rs, { id: nextMachineRowId++, name: '', secret: false, value: '' }])
          }
        >
          + Add value
        </button>

        {error && <p className="mt-3 text-[11.5px] text-red-600 dark:text-red-300">{error}</p>}
      </div>

      <div className="border-t border-card px-5 py-3 text-[11px] leading-relaxed text-ink-faint">
        {secureStorage ? (
          <>
            <span className="text-amber-600 dark:text-amber-300">🔒 Secrets</span> are encrypted
            with your Keychain, masked in service output, and never shown here again. Plain values
            are stored as text in overcli’s data folder.
          </>
        ) : (
          'This machine has no keychain, so nothing can be stored as a secret. Don’t put credentials here.'
        )}
      </div>

      <div className="flex items-center gap-2 border-t border-card px-5 py-3">
        <span className="text-[11px] text-ink-faint">
          {rows.filter((r) => name(r) !== '').length} values
          {secretCount > 0 && ` · ${secretCount} secret`}
        </span>
        <div className="flex-1" />
        <button className="review-btn" onClick={onClose}>
          Cancel
        </button>
        <button
          className="review-btn-primary"
          onClick={async () => {
            const entries = rows
              .filter((r) => name(r) !== '')
              .map<MachineEntry>((r) => ({
                name: name(r),
                secret: r.secret,
                // An untouched stored secret goes back without a value, which
                // tells the engine to keep the one in the keychain. A stored
                // secret made plain without retyping stays a secret there too.
                value: r.stored && !r.value ? undefined : (r.value ?? ''),
              }));
            try {
              setError(undefined);
              await saveMachine(entries);
              onClose();
            } catch (err) {
              setError(err instanceof Error ? err.message : String(err));
            }
          }}
        >
          Save
        </button>
      </div>
    </Sheet>
  );
}

function name(row: MachineEntry): string {
  return row.name.trim();
}

/// One machine value. The secret toggle lives inside the value field, where
/// the thing it protects is, rather than as a third column competing for width.
/// A stored secret is a chip, not an empty input: an empty box with a long
/// placeholder read as "this has no value".
function MachineValueRow({
  row,
  secureStorage,
  onChange,
  onPaste,
  onRemove,
}: {
  row: MachineRow;
  secureStorage: boolean;
  onChange: (patch: Partial<MachineRow>) => void;
  onPaste: (values: MachineValues) => void;
  onRemove: () => void;
}) {
  const [replacing, setReplacing] = useState(false);
  const [revealed, setRevealed] = useState(false);
  const showChip = row.stored && !replacing && !row.value;
  const canToggle = secureStorage || row.secret;
  const waiting = row.neededBy && !row.value;

  return (
    <div className="flex flex-col gap-1">
    <div className="group flex items-center gap-3">
      <input
        className="field w-[36%] min-w-0 px-2.5 py-2 font-mono text-[12px]"
        placeholder="NAME"
        value={row.name}
        spellCheck={false}
        onChange={(e) => {
          const next = e.target.value;
          onChange({
            name: next,
            ...(row.pinned || row.stored ? {} : { secret: secureStorage && isSecretName(next) }),
          });
        }}
        onPaste={(e) => {
          const text = e.clipboardData.getData('text');
          if (!text.includes('=')) return;
          e.preventDefault();
          onPaste(parseMachineValues(text));
        }}
      />

      <div className="relative min-w-0 flex-1">
        {showChip ? (
          <div className="field flex items-center gap-2 py-2 pl-2.5 pr-9 text-[12px]">
            <span className="font-mono tracking-widest text-ink-muted">••••••••</span>
            <span className="truncate text-[11px] text-ink-faint">Stored in Keychain</span>
            <button
              className="ml-auto shrink-0 text-[11px] text-accent hover:underline"
              onClick={() => setReplacing(true)}
            >
              Replace
            </button>
          </div>
        ) : (
          <input
            className={`field w-full py-2 pl-2.5 font-mono text-[12px] ${row.secret ? 'pr-16' : 'pr-9'}`}
            type={row.secret && !revealed ? 'password' : 'text'}
            autoComplete="off"
            spellCheck={false}
            autoFocus={replacing}
            placeholder={row.stored ? 'New value — leave empty to keep the stored one' : 'value'}
            value={row.value ?? ''}
            onChange={(e) => onChange({ value: e.target.value })}
            onBlur={() => {
              if (!row.value) setReplacing(false);
            }}
          />
        )}

        <div className="absolute inset-y-0 right-1 flex items-center gap-0.5">
          {row.secret && !showChip && (
            <button
              className="flex h-7 w-7 items-center justify-center rounded text-[13px] text-ink-faint hover:bg-card-strong hover:text-ink"
              title={revealed ? 'Hide' : 'Show what you typed'}
              onClick={() => setRevealed((r) => !r)}
            >
              {revealed ? '🙈' : '👁'}
            </button>
          )}
          <button
            className={`flex h-7 w-7 items-center justify-center rounded text-[13px] transition ${
              row.secret
                ? 'bg-amber-500/15 text-amber-600 dark:text-amber-300'
                : 'text-ink-faint opacity-60 hover:bg-card-strong hover:opacity-100'
            } disabled:cursor-not-allowed disabled:opacity-30`}
            disabled={!canToggle}
            title={
              !secureStorage
                ? 'No keychain on this machine — secrets cannot be stored safely'
                : row.secret
                  ? row.stored
                    ? 'Secret. To make it plain, replace the value — the stored one is never shown.'
                    : 'Secret — click to store as plain text'
                  : 'Plain text — click to encrypt with the Keychain'
            }
            onClick={() => onChange({ secret: !row.secret, pinned: true })}
          >
            {row.secret ? '🔒' : '🔓'}
          </button>
        </div>
      </div>

      <button
        className="flex h-8 w-8 shrink-0 items-center justify-center rounded text-[15px] text-ink-faint opacity-50 hover:bg-card-strong hover:text-red-500 hover:opacity-100 group-hover:opacity-100"
        title="Remove"
        onClick={onRemove}
      >
        ×
      </button>
    </div>
    {row.neededBy && (
      <div
        className={`truncate pl-1 text-[11px] ${waiting ? 'text-amber-700 dark:text-amber-300' : 'text-ink-faint'}`}
        title={row.neededBy.join(', ')}
      >
        {waiting ? 'Needed by ' : 'Used by '}
        {row.neededBy.slice(0, 3).join(', ')}
        {row.neededBy.length > 3 && ` and ${row.neededBy.length - 3} more`}
      </div>
    )}
    </div>
  );
}

export function parseMachineValues(text: string): MachineValues {
  const out: MachineValues = {};
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    out[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim();
  }
  return out;
}

// ── rebind ──────────────────────────────────────────────────────────────────

function RebindMenu({
  workspaceId,
  serviceId,
  binding,
  pinnedRef,
}: {
  workspaceId: string;
  serviceId: string;
  binding: { ref: string; path: string };
  pinnedRef?: string;
}) {
  const rebind = useServicesStore((s) => s.rebind);
  const setPinned = useServicesStore((s) => s.setPinned);
  const checkoutRef = useServicesStore((s) => s.checkoutRef);
  const [open, setOpen] = useState(false);
  const [refs, setRefs] = useState<{
    worktrees: WorktreeChoice[];
    branches: BranchChoice[];
    defaultBranch?: string;
  } | null>(null);
  const [query, setQuery] = useState('');
  const [refused, setRefused] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const field = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    void (async () => {
      const loaded = await refChoices(binding.path);
      if (!cancelled) setRefs(loaded);
    })();
    field.current?.focus();
    return () => {
      cancelled = true;
    };
  }, [open, binding.path]);

  const rows = useMemo(
    () =>
      rankRefs({
        worktrees: refs?.worktrees ?? [],
        branches: refs?.branches ?? [],
        current: binding.ref,
        defaultBranch: refs?.defaultBranch,
        query,
      }),
    [refs, binding.ref, query],
  );

  function close() {
    setOpen(false);
    setQuery('');
    setRefused(null);
  }

  async function clearOlderPin(nextRef: string): Promise<void> {
    if (pinnedRef && pinnedRef !== nextRef) {
      await setPinned(workspaceId, serviceId, undefined);
    }
  }

  async function restorePinAfterFailure(): Promise<void> {
    if (pinnedRef) await setPinned(workspaceId, serviceId, pinnedRef);
  }

  async function chooseCheckout(choice: WorktreeChoice, pin: boolean): Promise<void> {
    if (pin) await clearOlderPin(choice.ref);
    try {
      if (choice.path !== binding.path || choice.ref !== binding.ref) {
        await rebind(workspaceId, serviceId, choice.ref, choice.path);
      }
      if (pin) await setPinned(workspaceId, serviceId, choice.ref);
      close();
    } catch (error) {
      if (pin) await restorePinAfterFailure();
      throw error;
    }
  }

  async function chooseBranch(choice: BranchChoice, pin: boolean): Promise<void> {
    // A tracked remote `origin/feature/x` is checked out locally as
    // `feature/x`; the pin must match what git reports after the checkout.
    const nextRef = choice.remote ? choice.ref.replace(/^[^/]+\//, '') : choice.ref;
    if (pin) await clearOlderPin(nextRef);
    const outcome = await checkoutRef(workspaceId, serviceId, choice.ref);
    if (!outcome.ok) {
      if (pin) await restorePinAfterFailure();
      setRefused(outcome.reason);
      return;
    }
    if (pin) await setPinned(workspaceId, serviceId, nextRef);
    close();
  }
  const now = Date.now();

  return (
    <div className="relative">
      <button
        className="svc-btn max-w-[220px]"
        onClick={() => (open ? close() : setOpen(true))}
        title={`${binding.ref} — ${binding.path}`}
      >
        <BranchIcon />
        <span className="truncate font-mono">{binding.ref}</span>
        <span className="text-ink-faint">▾</span>
      </button>

      {open && (
        <>
          {/* A menu that only closes on its own button is a menu people leave
              open by accident, over the output they were trying to read. */}
          <div className="fixed inset-0 z-10" onClick={close} />
          <div className="absolute right-0 z-20 mt-1 w-[396px] overflow-hidden rounded-lg border border-card-strong bg-surface-elevated shadow-xl">
            <div className="border-b border-card px-2.5 pb-2 pt-2">
              <div className="pb-1.5 text-[11px] text-ink-muted">Run this from…</div>
              <input
                ref={field}
                className="w-full rounded-[5px] border border-card-strong bg-surface px-2 py-1 text-[11.5px] outline-none focus:border-accent"
                placeholder="Search checkouts and branches"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => e.key === 'Escape' && close()}
              />
            </div>

            <div className="max-h-[420px] overflow-y-auto px-1 py-2">
              {refs === null && <div className="px-2.5 py-2 text-[11px] text-ink-faint">Looking…</div>}

              {rows.checkouts.length > 0 && (
                <div className="pb-1.5">
                  <SectionHead title="Checkouts" note="on disk, newest first — switching is instant" />
                  {rows.checkouts.map((choice) => {
                    // By path, not ref: two detached trees can sit on one sha.
                    const here = choice.path === binding.path;
                    return (
                      <div key={choice.path} className="group/ref flex items-start rounded-[5px] hover:bg-card-strong">
                        <button
                          className="flex min-w-0 flex-1 items-start gap-2 px-2.5 py-1.5 text-left"
                          onClick={() => void chooseCheckout(choice, false)}
                        >
                          <span className="pt-0.5">
                            <FolderIcon current={here} />
                          </span>
                        {/* Two lines rather than two columns. Side by side, a
                            long folder path crushed the branch name down to
                            "feature/…" — the one thing the row is for. */}
                          <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                          <span className="flex min-w-0 items-center gap-1.5">
                            <span
                              className={`min-w-0 flex-1 truncate font-mono text-[11.5px] ${
                                here ? 'text-accent' : ''
                              }`}
                              title={choice.ref}
                            >
                              {choice.ref}
                            </span>
                            {here ? (
                              <Tag accent>here</Tag>
                            ) : choice.primary ? (
                              <Tag>main</Tag>
                            ) : choice.detached ? (
                              <Tag>detached</Tag>
                            ) : null}
                          </span>
                          <span className="flex min-w-0 items-center gap-1.5 text-[10px] text-ink-faint">
                            <span className="min-w-0 truncate font-mono" title={choice.path}>
                              {shortenPath(choice.path)}
                            </span>
                            {choice.createdAt !== undefined && (
                              <span className="flex-shrink-0">
                                · {createdLabel(choice.createdAt, now)}
                              </span>
                            )}
                          </span>
                          </span>
                        </button>
                        <button
                          className="mr-1 mt-1 flex h-6 w-6 flex-shrink-0 items-center justify-center rounded text-ink-faint opacity-40 hover:bg-surface hover:text-accent hover:opacity-100 group-hover/ref:opacity-100"
                          title={`Switch and pin this service to ${choice.ref}`}
                          aria-label={`Switch and pin to ${choice.ref}`}
                          onClick={() => void chooseCheckout(choice, true)}
                        >
                          <PinIcon />
                        </button>
                      </div>
                    );
                  })}
                  {rows.hiddenCheckouts > 0 && (
                    <div className="px-2.5 pt-1 text-[10px] text-ink-faint">
                      {rows.hiddenCheckouts} older — type to narrow
                    </div>
                  )}
                </div>
              )}

              {rows.branches.length > 0 && (
                <div className="border-t border-card pt-1.5">
                  {/* Named for its consequence. Picking one here moves the
                      working tree this service is bound to — the same tree a
                      flow may be running in — which is a different act from
                      pointing at a checkout that already exists. */}
                  <SectionHead title="Branches" note="checked out into this folder" />
                  {rows.branches.map((choice) => (
                    <div key={choice.ref} className="group/ref flex items-center rounded-[5px] hover:bg-card-strong">
                      <button
                        className="flex min-w-0 flex-1 items-center gap-2 px-2.5 py-1.5 text-left disabled:opacity-50"
                        disabled={busy}
                        onClick={async () => {
                          setBusy(true);
                          setRefused(null);
                          try {
                            await chooseBranch(choice, false);
                          } finally {
                            setBusy(false);
                          }
                        }}
                      >
                        <BranchIcon />
                        <span className="flex-1 truncate font-mono text-[11.5px]">{choice.ref}</span>
                        {choice.when && (
                          <span className="text-[10px] text-ink-faint">{choice.when}</span>
                        )}
                        {choice.ref === refs?.defaultBranch ? (
                          <Tag>default</Tag>
                        ) : choice.remote ? (
                          <Tag>remote</Tag>
                        ) : null}
                      </button>
                      <button
                        className="mr-1 flex h-6 w-6 flex-shrink-0 items-center justify-center rounded text-ink-faint opacity-40 hover:bg-surface hover:text-accent hover:opacity-100 disabled:opacity-20 group-hover/ref:opacity-100"
                        disabled={busy}
                        title={`Check out and pin this service to ${choice.ref}`}
                        aria-label={`Check out and pin to ${choice.ref}`}
                        onClick={async () => {
                          setBusy(true);
                          setRefused(null);
                          try {
                            await chooseBranch(choice, true);
                          } finally {
                            setBusy(false);
                          }
                        }}
                      >
                        <PinIcon />
                      </button>
                    </div>
                  ))}
                  {rows.hiddenBranches > 0 && (
                    <div className="px-2.5 pt-1 text-[10px] text-ink-faint">
                      {rows.hiddenBranches} more — type to narrow
                    </div>
                  )}
                </div>
              )}

              {refs !== null && rows.checkouts.length === 0 && rows.branches.length === 0 && (
                <div className="px-2.5 py-4 text-center text-[11px] text-ink-faint">
                  {query ? `Nothing matches “${query}”.` : 'This folder is not a git checkout.'}
                </div>
              )}
            </div>

            {refused && (
              <div className="border-t border-amber-500/30 bg-amber-500/10 px-2.5 py-2 text-[10.5px] leading-4">
                {refused}
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}

function SectionHead({ title, note }: { title: string; note: string }) {
  return (
    <div className="flex items-baseline gap-1.5 px-2.5 pb-1">
      <span className="text-[10px] font-semibold uppercase tracking-wide text-ink-muted">
        {title}
      </span>
      <span className="text-[10px] text-ink-faint">{note}</span>
    </div>
  );
}

function Tag({ children, accent }: { children: React.ReactNode; accent?: boolean }) {
  return (
    <span
      className={`rounded border px-1 py-px text-[9px] leading-none ${
        accent ? 'border-accent/50 text-accent' : 'border-card-strong text-ink-faint'
      }`}
    >
      {children}
    </span>
  );
}

function BranchIcon() {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      className="flex-shrink-0 text-ink-faint"
    >
      <line x1="6" y1="3" x2="6" y2="15" />
      <circle cx="18" cy="6" r="3" />
      <circle cx="6" cy="18" r="3" />
      <path d="M18 9a9 9 0 0 1-9 9" />
    </svg>
  );
}

function FolderIcon({ current }: { current: boolean }) {
  return (
    <svg
      width="13"
      height="13"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={`flex-shrink-0 ${current ? 'text-accent' : 'text-ink-faint'}`}
    >
      <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
    </svg>
  );
}

// ── setting up ──────────────────────────────────────────────────────────────

/// Every project overcli could look through, as one list of stacks.
///
/// A workspace and a lone project are the same thing here: a named set of
/// checkouts that services land against.
function addStacks(
  workspaces: { id: string; name: string; projectIds: string[] }[],
  projects: { id: string; name: string; path: string }[],
  loose: { id: string; name: string; path: string }[],
): AddStack[] {
  return [
    ...workspaces.map((w) => ({
      id: w.id,
      name: w.name,
      projects: projects.filter((p) => w.projectIds.includes(p.id)),
    })),
    ...loose.map((p) => ({ id: p.id, name: p.name, projects: [p] })),
  ];
}

/// The first run: nothing is set up, so the sweep IS the pane.
function SetUp({
  workspaces,
  projects,
  loose,
}: {
  workspaces: { id: string; name: string; projectIds: string[] }[];
  projects: { id: string; name: string; path: string }[];
  loose: { id: string; name: string; path: string }[];
}) {
  const stacks = useMemo(
    () => addStacks(workspaces, projects, loose),
    [workspaces, projects, loose],
  );
  if (stacks.length === 0) {
    return (
      <div className="flex flex-1 items-center justify-center p-8 text-center text-xs text-ink-muted">
        Add a project and overcli can look through it for anything that starts.
      </div>
    );
  }
  return (
    <AddServicesSheet stacks={stacks} existing={new Set()} onClose={() => {}} standalone />
  );
}

/// And afterwards: the same screen, over the pane.
function Footer({
  workspaces,
  projects,
  loose,
  stacks,
}: {
  workspaces: { id: string; name: string; projectIds: string[] }[];
  projects: { id: string; name: string; path: string }[];
  loose: { id: string; name: string; path: string }[];
  stacks: Record<string, StackView>;
}) {
  const [open, setOpen] = useState(false);
  const targets = useMemo(
    () => addStacks(workspaces, projects, loose),
    [workspaces, projects, loose],
  );
  const existing = useMemo(
    () => new Set(Object.values(stacks).flatMap((s) => s.services.map((x) => x.id))),
    [stacks],
  );

  const ticking = useServicesStore((s) => Object.keys(s.checked).length > 0);

  return (
    <>
      {ticking ? (
        <SelectionBar />
      ) : (
        <div className="flex h-[40px] flex-shrink-0 items-center border-t border-card px-3.5">
          <button className="text-[10.5px] text-ink-faint hover:text-ink" onClick={() => setOpen(true)}>
            + Add services
          </button>
          <span className="flex-1" />
          <span className="text-[10.5px] text-ink-faint">⌘-click to select several</span>
        </div>
      )}
      {open && (
        <AddServicesSheet
          stacks={targets}
          existing={existing}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  );
}

// ── small pieces ────────────────────────────────────────────────────────────

function Sheet({
  children,
  onClose,
  width = 'w-[520px]',
}: {
  children: React.ReactNode;
  onClose: () => void;
  width?: string;
}) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
      onClick={onClose}
    >
      <div
        className={`${width} max-w-[calc(100vw-48px)] overflow-hidden rounded-lg border border-card-strong bg-surface-elevated shadow-2xl`}
        onClick={(e) => e.stopPropagation()}
      >
        {children}
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-[11px] text-ink-muted">{label}</span>
      {children}
    </label>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="mb-4">
      <div className="mb-1.5 text-[10px] uppercase tracking-wide text-ink-faint">{title}</div>
      {children}
    </div>
  );
}

function TabButton({
  on,
  onClick,
  children,
}: {
  on: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className={
        'px-2.5 py-1.5 text-[11.5px] ' +
        (on ? 'border-b-2 border-accent text-ink' : 'text-ink-muted hover:text-ink')
      }
    >
      {children}
    </button>
  );
}

function IconButton({
  title,
  onClick,
  children,
  fill,
  tone,
}: {
  title: string;
  onClick: () => void;
  children: React.ReactNode;
  fill?: boolean;
  tone?: 'go' | 'stop' | 'restart';
}) {
  return (
    <button
      title={title}
      aria-label={title}
      onClick={onClick}
      className={
        'flex h-6 w-6 items-center justify-center rounded ' +
        (tone === 'go'
          ? 'text-[color:var(--c-diff-add-ink)] hover:bg-[color-mix(in_srgb,var(--c-diff-add-ink)_18%,transparent)]'
          : tone === 'stop'
            ? 'text-[color:var(--c-diff-remove-ink)] hover:bg-[color-mix(in_srgb,var(--c-diff-remove-ink)_16%,transparent)]'
            : tone === 'restart'
              ? 'text-amber-600 hover:bg-amber-500/15 dark:text-amber-400'
              : 'hover:bg-card-strong hover:text-ink')
      }
    >
      <svg
        width="13"
        height="13"
        viewBox="0 0 16 16"
        fill={fill ? 'currentColor' : 'none'}
        stroke={fill ? 'none' : 'currentColor'}
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        {children}
      </svg>
    </button>
  );
}

function MenuItem({
  children,
  onClick,
  danger,
}: {
  children: React.ReactNode;
  onClick: () => void;
  danger?: boolean;
}) {
  return (
    <button
      className={
        'block w-full px-3 py-1.5 text-left hover:bg-card-strong ' +
        (danger ? 'text-red-700 dark:text-red-300' : 'text-ink-muted')
      }
      onClick={onClick}
    >
      {children}
    </button>
  );
}

function StatusDot({ status }: { status: ServiceRuntime['status'] | 'blocked' }) {
  const tone =
    status === 'blocked'
      ? 'bg-amber-500 dark:bg-amber-400'
      : status === 'ready'
      ? 'bg-green-500 dark:bg-green-400'
      : status === 'done'
      ? 'bg-green-500/50 dark:bg-green-400/50'
      : status === 'starting'
        ? 'bg-amber-500 dark:bg-amber-400'
        : status === 'failed'
          ? 'bg-red-500 dark:bg-red-400'
          : status === 'unready'
            ? 'bg-amber-600 dark:bg-amber-500'
            : 'bg-card-border-strong';
  return <span aria-hidden className={`h-1.5 w-1.5 flex-shrink-0 rounded-full ${tone}`} />;
}

/// A branch name has no length limit and a real one — `bugfix/ABC-5185-
/// campaign-entities-null-mailing-template` — is wider than every other column
/// put together. Drop the conventional prefix, which is the least
/// distinguishing part of it, and let CSS truncate the rest. The full name is
/// always on the title.
function PinIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
      <path d="M5.5 1.5h5l-.7 1.2v3.6l2.4 2.4v1.3H8.6V15L8 15.5 7.4 15v-5H3.8V8.7l2.4-2.4V2.7z" />
    </svg>
  );
}

export function shortRef(ref: string): string {
  return ref.replace(/^(feature|feat|bugfix|fix|hotfix|chore|release|ci|prometheus)\//, '');
}

/// Compact uptime: 3m, 2h, 4d. The pane is not a stopwatch.
function since(startedAt: number): string {
  const seconds = Math.max(0, Math.round((Date.now() - startedAt) / 1000));
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
  if (seconds < 86_400) return `${Math.round(seconds / 3600)}h`;
  return `${Math.round(seconds / 86_400)}d`;
}

export type { ServiceGroup };
