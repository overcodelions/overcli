// Clean up — one surface for everything workers, flows and agent chats leave
// on disk.
//
// It replaces two half-surfaces. Settings → Storage could only see ORPHANS
// (trees whose conversation was already gone), and the bulk conversation
// modal could only see conversation ROWS, with no idea what any of them cost
// or which worker had made forty of them. Neither could answer the actual
// question — "this worker has been running nightly for a month, clear the
// finished ones" — because the unit that question is about (tree + branch +
// conversation + run row) was split across both.
//
// The grouping is the design: rows are filed under the WORKER, FLOW or CHAT
// that made them, so a runaway producer is one decision instead of forty.

import { useEffect, useMemo, useState } from 'react';
import { OrphanTranscriptEntry, UUID, WorktreeSweepEntry } from '@shared/types';
import { useStore } from '../../store';
import { useAllRunners } from '../../runnersStore';
import { SheetActionButton } from './settingsChrome';
import {
  DEFAULT_CLEANUP_RULES,
  describeRules,
  retirable,
  runawayProducers,
} from '@shared/cleanupRules';
import {
  CleanupGroup,
  CleanupGroupKind,
  CleanupGroupMode,
  conversationClaims,
  entryAgeAt,
  groupKeyFor,
  filterEntries,
  formatAge,
  formatSize,
  groupEntries,
  isActionable,
  planCleanup,
  planRelease,
  totalsFor,
} from './cleanup';

const AGE_CHOICES = [0, 7, 30, 90] as const;

/// How many runaway producers the banner names before it stops. A warning
/// that fills the pane is not a warning.
const RUNAWAY_SHOWN = 3;

/// The last scan, kept alive across sheet opens.
///
/// A full scan reads git status and `du` for every idle worktree and takes
/// minutes on a big install. Reviewing a diff before deciding closes this
/// sheet (sheets are singular), so without this cache the price of looking at
/// one row would be re-paying for the whole scan — which in practice means
/// people don't look, and tick things they haven't read.
let scanCache: {
  entries: WorktreeSweepEntry[];
  scannedAt: number;
  selected: string[];
  measuredSizes: boolean;
} | null = null;

/// What arrives pre-ticked: the auto-tidy rules' answer, or every safe row
/// when the rules are off.
function ruleSelection(entries: WorktreeSweepEntry[], rules: typeof DEFAULT_CLEANUP_RULES): string[] {
  if (rules.retireAfterDays <= 0) {
    return entries.filter((e) => e.bucket === 'reclaimable').map((e) => e.worktreePath);
  }
  return retirable(entries, rules, (e) => groupKeyFor(e).key, entryAgeAt, Date.now()).map(
    (e) => e.worktreePath,
  );
}

export function CleanupSheet() {
  const projects = useStore((s) => s.projects);
  const workspaces = useStore((s) => s.workspaces);
  const runners = useAllRunners();
  const openSheet = useStore((s) => s.openSheet);
  const removeAgent = useStore((s) => s.removeAgent);
  const removeConversation = useStore((s) => s.removeConversation);
  const releaseWorktree = useStore((s) => s.releaseWorktree);
  const setConversationHidden = useStore((s) => s.setConversationHidden);
  const rules = useStore((s) => s.settings.cleanup) ?? DEFAULT_CLEANUP_RULES;

  const [entries, setEntries] = useState<WorktreeSweepEntry[] | null>(scanCache?.entries ?? null);
  const [scannedAt, setScannedAt] = useState<number>(scanCache?.scannedAt ?? 0);
  const [selected, setSelected] = useState<Set<string>>(new Set(scanCache?.selected ?? []));
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [scanning, setScanning] = useState(false);
  const [progress, setProgress] = useState<{ completed: number; total: number } | null>(null);
  const [query, setQuery] = useState('');
  const [minAgeDays, setMinAgeDays] = useState(0);
  const [bucket, setBucket] = useState<'all' | 'reclaimable' | 'has-work' | 'live' | 'foreign'>(
    'all',
  );
  const [groupMode, setGroupMode] = useState<CleanupGroupMode>('producer');
  const [keepBranch, setKeepBranch] = useState(true);
  /// Sizes cost a `du` walk per worktree and are most of the wait. Left on
  /// `'auto'`, the scan measures them on installs small enough for it to be
  /// worth it and reports counts on the ones where it isn't — see
  /// `SIZE_MEASURE_LIMIT` in worktreeSweep.
  const [measureSizes, setMeasureSizes] = useState<boolean | 'auto'>('auto');
  const [measuredSizes, setMeasuredSizes] = useState(scanCache?.measuredSizes ?? false);
  /// Transcript folders left behind by worktrees that are already gone.
  /// Kept apart from the worktree selection on purpose: it is a different
  /// unit (folders, not worktrees), and folding it into "N selected" would
  /// make that number mean two things at once.
  const [leftovers, setLeftovers] = useState<OrphanTranscriptEntry[]>([]);
  const [view, setView] = useState<'list' | 'confirm'>('list');
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<string | null>(null);

  const runningById = useMemo(() => {
    const out: Record<UUID, boolean> = {};
    for (const id of Object.keys(runners)) out[id] = runners[id]?.isRunning ?? false;
    return out;
  }, [runners]);

  useEffect(() => {
    return window.overcli.onMainEvent((event) => {
      if (event.type === 'worktreeScanProgress') {
        setProgress({ completed: event.completed, total: event.total });
      }
    });
  }, []);

  const runScan = async (opts?: { measureSizes?: boolean | 'auto' }) => {
    const sizes = opts?.measureSizes ?? measureSizes;
    setScanning(true);
    setProgress(null);
    setError(null);
    setResult(null);
    setView('list');
    try {
      // Claims are read at call time from live store state rather than from
      // `overcli.json`, which lags in-memory state by a save — a stale read
      // would report a live tree as an orphan and offer to delete it.
      const { projects: ps, workspaces: ws } = useStore.getState();
      const res = await window.overcli.invoke('git:scanWorktrees', {
        projects: ps.map((p) => ({ path: p.path, name: p.name })),
        claims: conversationClaims([...ps, ...ws], runningById),
        measureSizes: sizes,
      });
      setEntries(res.entries);
      setScannedAt(res.scannedAt);
      setMeasuredSizes(res.measuredSizes);
      // Pre-select what the auto-tidy rules would retire — which is provably
      // safe work, minus the newest few per producer that stay reopenable.
      // With the rules off it falls back to everything provably safe. Either
      // way nothing holding work is ever pre-ticked: that is opted into per
      // row, after reading what it holds.
      // Cheap enough to ride along with every scan: a handful of file stats
      // per folder, no git and no `du`.
      void window.overcli
        .invoke('transcripts:scanOrphans')
        .then((r) => setLeftovers(r.entries))
        .catch(() => setLeftovers([]));
      const preselect = ruleSelection(res.entries, rules);
      setSelected(new Set(preselect));
      scanCache = {
        entries: res.entries,
        scannedAt: res.scannedAt,
        selected: preselect,
        measuredSizes: res.measuredSizes,
      };
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setScanning(false);
      setProgress(null);
    }
  };

  // Scan on open. This is the only thing the sheet does, and making people
  // click a button to see an empty page first helps nobody.
  useEffect(() => {
    if (!entries && !scanning) void runScan();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const now = Date.now();
  const visible = useMemo(
    () => (entries ? filterEntries(entries, { query, minAgeDays, bucket, now: Date.now() }) : []),
    [entries, query, minAgeDays, bucket],
  );
  const groups = useMemo(() => groupEntries(visible, groupMode), [visible, groupMode]);
  const totals = useMemo(() => totalsFor(entries ?? []), [entries]);

  const selectedEntries = useMemo(
    () => visible.filter((e) => selected.has(e.worktreePath)),
    [visible, selected],
  );
  // The full entry list goes in too: a run's other worktrees are separate
  // rows, and without them there is no way to see that deleting a run would
  // take a tree the user was never shown.
  const plan = useMemo(
    () => planCleanup(selectedEntries, entries ?? []),
    [selectedEntries, entries],
  );
  const release = useMemo(() => planRelease(selectedEntries), [selectedEntries]);
  const runaways = useMemo(() => runawayProducers(groups, rules), [groups, rules]);
  const hiddenSelected = useMemo(() => {
    const shown = new Set(visible.map((e) => e.worktreePath));
    return (entries ?? []).filter((e) => selected.has(e.worktreePath) && !shown.has(e.worktreePath))
      .length;
  }, [entries, visible, selected]);

  const setSelection = (next: Set<string>) => {
    setSelected(next);
    setView('list');
    if (scanCache) scanCache = { ...scanCache, selected: [...next] };
  };

  const toggle = (worktreePath: string) => {
    const next = new Set(selected);
    if (next.has(worktreePath)) next.delete(worktreePath);
    else next.add(worktreePath);
    setSelection(next);
  };

  const toggleMany = (list: WorktreeSweepEntry[], on: boolean) => {
    const next = new Set(selected);
    for (const e of list) {
      if (!isActionable(e)) continue;
      if (on) next.add(e.worktreePath);
      else next.delete(e.worktreePath);
    }
    setSelection(next);
  };

  /// Drop what we just removed from the list, keeping everything else.
  ///
  /// Deliberately NOT a rescan. On a large install the scan costs minutes,
  /// and paying that again to confirm a removal we already have the result of
  /// would make clearing three groups an afternoon. Anything that failed is
  /// passed in as `keptPaths` and stays on the list, which is the case where
  /// showing stale rows would actually mislead.
  const pruneRemoved = (removedPaths: string[], keptPaths: string[] = []) => {
    const gone = new Set(removedPaths.filter((p) => !keptPaths.includes(p)));
    setEntries((cur) => {
      const next = (cur ?? []).filter((e) => !gone.has(e.worktreePath));
      if (scanCache) scanCache = { ...scanCache, entries: next, selected: [] };
      return next;
    });
    setSelection(new Set());
  };

  /// Remove whole units. Each producer has its own teardown and using the
  /// wrong one strands half a unit — see `planCleanup`.
  const runRemove = async () => {
    setWorking(true);
    setError(null);
    setResult(null);
    const warnings: string[] = [];
    // A unit that fails must stay on the list — that is the case where a
    // pruned row would lie about what is on disk.
    const kept: string[] = [];
    const attempted = selectedEntries.filter(isActionable).map((e) => e.worktreePath);
    const pathsFor = (match: (e: WorktreeSweepEntry) => boolean) =>
      selectedEntries.filter(match).map((e) => e.worktreePath);
    try {
      for (const runId of plan.removeRunIds) {
        // `force` bypasses the flow runtime's own guard against deleting a run
        // whose worktrees hold unreviewed work. It is only ours to pass when
        // every tree that run owns is in this selection — the user has then
        // seen each one, with its "holds work" badge, and confirmed. When the
        // run owns trees beyond the selection (a workspace run holds one per
        // member repo), the guard gets the final say instead.
        const force = !plan.runsHoldingMore.includes(runId);
        const res = await window.overcli.invoke('flows:deleteRun', { runId, force });
        if (!res.ok) {
          const title = selectedEntries.find((e) => e.claim?.runId === runId)?.claim?.title ?? runId;
          warnings.push(
            'needsConfirm' in res
              ? `${title}: kept — it owns ${res.dirty.length} worktree${res.dirty.length === 1 ? '' : 's'} with unreviewed work that this selection did not cover. Open the run to review, or tick every one of its rows.`
              : `${title}: ${'error' in res ? res.error : 'delete refused'}`,
          );
          kept.push(...pathsFor((e) => e.claim?.runId === runId));
        }
      }
      for (const convId of plan.removeAgentIds) {
        const res = await removeAgent(convId, { keepBranch });
        if (!res.ok) {
          if (res.error) warnings.push(res.error);
          kept.push(...pathsFor((e) => e.claim?.convId === convId));
        } else if (res.warning) warnings.push(res.warning);
      }
      for (const convId of plan.removeAdoptedIds) await removeConversation(convId);
      if (plan.sweepEntries.length > 0) {
        const res = await window.overcli.invoke('git:sweepWorktrees', {
          entries: plan.sweepEntries.map((e) => ({
            ...e,
            branchName: keepBranch ? null : e.branchName,
          })),
        });
        for (const f of res.failures) {
          warnings.push(`${f.worktreePath}: ${f.error}`);
          kept.push(f.worktreePath);
        }
      }
      const removedCount = plan.worktreeCount - new Set(kept).size;
      setResult(
        `Removed ${removedCount} worktree${removedCount === 1 ? '' : 's'}` +
          (plan.freedKb > 0 && measuredSizes ? `, freed ${formatSize(plan.freedKb)}` : '') +
          '.',
      );
      if (warnings.length > 0) setError(`Finished with warnings:\n${warnings.join('\n')}`);
      pruneRemoved(attempted, kept);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setWorking(false);
      setView('list');
    }
  };

  /// Drop the trees, keep the transcripts.
  const runRelease = async () => {
    setWorking(true);
    setError(null);
    setResult(null);
    const warnings: string[] = [];
    try {
      const kept: string[] = [];
      for (const convId of release.releaseIds) {
        const res = await releaseWorktree(convId, { keepBranch });
        if (!res.ok) {
          if (res.error) warnings.push(res.error);
          kept.push(
            ...selectedEntries.filter((e) => e.claim?.convId === convId).map((e) => e.worktreePath),
          );
        } else if (res.warning) warnings.push(res.warning);
      }
      const releasedCount = release.releaseIds.length - new Set(kept).size;
      setResult(
        `Released ${releasedCount} worktree${releasedCount === 1 ? '' : 's'}` +
          (release.freedKb > 0 && measuredSizes ? `, freed ${formatSize(release.freedKb)}` : '') +
          '. The conversations stayed.',
      );
      if (warnings.length > 0) setError(`Finished with warnings:\n${warnings.join('\n')}`);
      pruneRemoved(
        selectedEntries
          .filter((e) => e.claim?.convId && release.releaseIds.includes(e.claim.convId))
          .map((e) => e.worktreePath),
        kept,
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setWorking(false);
    }
  };

  const runArchive = async () => {
    setWorking(true);
    setError(null);
    try {
      const ids = selectedEntries
        .map((e) => e.claim?.convId)
        .filter((id): id is UUID => !!id && !(runningById[id] ?? false));
      for (const id of ids) await setConversationHidden(id, true);
      setResult(`Archived ${ids.length} conversation${ids.length === 1 ? '' : 's'}.`);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setWorking(false);
    }
  };

  if (view === 'confirm') {
    return (
      <ConfirmView
        plan={plan}
        keepBranch={keepBranch}
        working={working}
        onBack={() => setView('list')}
        onConfirm={() => void runRemove()}
      />
    );
  }

  return (
    <div className="flex flex-col w-full h-full">
      <div className="px-5 pt-4 pb-3 border-b border-card flex items-start gap-4">
        <div className="flex-1 min-w-0">
          <div className="text-lg font-semibold">Clean up</div>
          <div className="text-xs text-ink-muted mt-1 max-w-[760px]">
            Everything workers, flows and agent chats have left on disk. Removing something here
            takes the whole unit — worktree, branch, conversation and run record — so nothing is
            left half-deleted.
          </div>
        </div>
        <div className="flex items-center gap-2 pt-0.5">
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search name, branch, path"
            className="field px-2 py-1 text-xs w-[220px]"
          />
          {entries && !scanning && !measuredSizes && (
            <SheetActionButton
              label="Measure disk"
              onClick={() => {
                setMeasureSizes(true);
                void runScan({ measureSizes: true });
              }}
              disabled={working}
            />
          )}
          <SheetActionButton
            label={scanning ? 'Scanning…' : 'Rescan'}
            onClick={() => void runScan()}
            disabled={scanning || working}
          />
        </div>
      </div>

      <div className="px-5 py-3 border-b border-card">
        <div className="text-[11px] text-ink-faint mb-2">
          {scanning
            ? progress
              ? `Inspecting ${progress.total} worktree${progress.total === 1 ? '' : 's'} — ${progress.completed} of ${progress.total}. Reading git status and disk usage for each.`
              : `Listing worktrees across ${projects.length} project${projects.length === 1 ? '' : 's'}…`
            : entries
              ? `Scanned ${formatAge(scannedAt, now) ?? 'just now'} · ${entries.length} worktrees across ${projects.length} projects${measuredSizes ? ` · ${formatSize(totals.totalKb)}` : ' · sizes not measured'}`
              : 'Not scanned yet.'}
          {entries && !scanning && <span className="ml-2">· {describeRules(rules)}</span>}
        </div>
        {scanning && progress && progress.total > 0 && (
          <div className="h-1 rounded bg-card-strong overflow-hidden mb-3">
            <div
              className="h-full bg-accent transition-all"
              style={{ width: `${Math.round((progress.completed / progress.total) * 100)}%` }}
            />
          </div>
        )}
        <div className="grid grid-cols-4 gap-2.5">
          <Tile
            tone="safe"
            label="Safe to remove"
            count={totals.safe}
            sub={measuredSizes ? `${formatSize(totals.safeKb)} · merged or empty` : 'merged or empty'}
            active={bucket === 'reclaimable'}
            onClick={() => setBucket(bucket === 'reclaimable' ? 'all' : 'reclaimable')}
          />
          <Tile
            tone="work"
            label="Holds work"
            count={totals.hasWork}
            sub="Uncommitted or unmerged"
            active={bucket === 'has-work'}
            onClick={() => setBucket(bucket === 'has-work' ? 'all' : 'has-work')}
          />
          <Tile
            tone="live"
            label="Still live"
            count={totals.live}
            sub="Working right now"
            active={bucket === 'live'}
            onClick={() => setBucket(bucket === 'live' ? 'all' : 'live')}
          />
          <Tile
            tone="foreign"
            label="Not ours"
            count={totals.foreign}
            sub="Outside ~/.overcli/worktrees"
            active={bucket === 'foreign'}
            onClick={() => setBucket(bucket === 'foreign' ? 'all' : 'foreign')}
          />
        </div>
      </div>

      <div className="px-5 py-2 border-b border-card flex items-center gap-4 flex-wrap">
        <Segmented
          label="Group by"
          options={[
            { value: 'producer', label: 'Who made it' },
            { value: 'project', label: 'Project' },
          ]}
          value={groupMode}
          onChange={(v) => setGroupMode(v as CleanupGroupMode)}
          disabled={working}
        />
        <Segmented
          label="Older than"
          options={AGE_CHOICES.map((d) => ({
            value: String(d),
            label: d === 0 ? 'Any' : `${d}d`,
          }))}
          value={String(minAgeDays)}
          onChange={(v) => setMinAgeDays(Number(v))}
          disabled={working}
        />
        {hiddenSelected > 0 && (
          <span className="text-[11px] text-ink-faint">
            {hiddenSelected} selected but filtered out — not counted
          </span>
        )}
        <div className="ml-auto flex items-center gap-2">
          <SheetActionButton
            label="Apply auto-tidy rule"
            onClick={() => setSelection(new Set(ruleSelection(entries ?? [], rules)))}
            disabled={working || !entries}
          />
          <SheetActionButton
            label={`Select all ${totals.safe} safe`}
            onClick={() =>
              setSelection(
                new Set((entries ?? []).filter((e) => e.bucket === 'reclaimable').map((e) => e.worktreePath)),
              )
            }
            disabled={working || totals.safe === 0}
          />
        </div>
      </div>

      {runaways.length > 0 && (
        <div className="mx-5 mt-2 text-xs text-amber-800 dark:text-amber-200 bg-amber-500/10 border border-amber-500/30 rounded px-3 py-2 flex flex-col gap-1">
          {/* Only the worst few. On an install where thirty producers are over
              the threshold, listing them all buries the list this banner is
              supposed to point at. */}
          {runaways.slice(0, RUNAWAY_SHOWN).map((r) => (
            <div key={r.key} className="flex items-center gap-2">
              <span>
                <span className="font-medium">{r.name}</span> — {r.count} worktrees
                {measuredSizes ? `, ${formatSize(r.totalKb)}` : ''}, {r.safeCount} finished
              </span>
              {r.safeCount > 0 && (
                <button
                  className="ml-auto text-[11px] underline hover:no-underline shrink-0"
                  onClick={() => {
                    const group = groups.find((g) => g.key === r.key);
                    if (group) toggleMany(group.safe, true);
                  }}
                >
                  Select its {r.safeCount} finished
                </button>
              )}
            </div>
          ))}
          {runaways.length > RUNAWAY_SHOWN && (
            <div className="text-[11px] opacity-80">
              and {runaways.length - RUNAWAY_SHOWN} more producer
              {runaways.length - RUNAWAY_SHOWN === 1 ? '' : 's'} over the limit — they are all in
              the list below.
            </div>
          )}
        </div>
      )}

      {result && (
        <div className="mx-5 mt-2 text-xs text-green-700 dark:text-green-300 bg-green-500/10 border border-green-500/30 rounded px-3 py-2">
          {result}
        </div>
      )}
      {error && (
        <div className="mx-5 mt-2 text-xs text-red-700 dark:text-red-300 bg-red-500/10 border border-red-500/30 rounded px-3 py-2 whitespace-pre-wrap max-h-32 overflow-y-auto">
          {error}
        </div>
      )}

      <div className="flex-1 min-h-0 overflow-y-auto px-5 py-3">
        {!entries && scanning && <div className="text-xs text-ink-faint">Scanning…</div>}
        {entries && groups.length === 0 && (
          <div className="text-xs text-ink-faint">
            {entries.length === 0
              ? 'No worktrees found. Nothing to clean up.'
              : 'Nothing matches the current filters.'}
          </div>
        )}
        <div className="flex flex-col gap-2.5">
          {leftovers.length > 0 && (
            <LeftoverTranscripts
              entries={leftovers}
              disabled={working}
              onRemoved={(removed, freedKb, failures) => {
                setResult(
                  `Removed ${removed} leftover transcript folder${removed === 1 ? '' : 's'}` +
                    (freedKb > 0 ? `, freed ${formatSize(freedKb)}` : '') +
                    '.',
                );
                if (failures.length > 0) {
                  setError(
                    `Some folders were kept:\n${failures.map((f) => `${f.dirPath}: ${f.error}`).join('\n')}`,
                  );
                }
                void window.overcli
                  .invoke('transcripts:scanOrphans')
                  .then((r) => setLeftovers(r.entries))
                  .catch(() => setLeftovers([]));
              }}
            />
          )}
          {groups.map((group) => (
            <GroupCard
              key={group.key}
              group={group}
              expanded={expanded.has(group.key)}
              selected={selected}
              disabled={working}
              onToggleExpand={() => {
                const next = new Set(expanded);
                if (next.has(group.key)) next.delete(group.key);
                else next.add(group.key);
                setExpanded(next);
              }}
              onToggleEntry={toggle}
              onToggleMany={toggleMany}
              onReview={(entry) => {
                const convId = entry.claim?.kind === 'conversation' ? entry.claim.convId : undefined;
                if (convId) openSheet({ type: 'worktreeDiff', convId });
                else if (entry.claim?.runId) openSheet({ type: 'flowRunReview', runId: entry.claim.runId });
              }}
            />
          ))}
        </div>
      </div>

      <div className="px-5 py-3 border-t border-card flex items-center gap-3">
        <div className="flex flex-col gap-0.5 min-w-0">
          <div className="text-xs">
            <span className="font-medium">{plan.worktreeCount} selected</span>
            <span className="text-ink-muted">
              {' '}
              {measuredSizes ? ` · frees ${formatSize(plan.freedKb)}` : ''}
              {plan.conversationCount > 0 && ` · ${plan.conversationCount} conversations close`}
              {plan.runCount > 0 && ` · ${plan.runCount} runs removed`}
            </span>
          </div>
          <div className="text-[11px]">
            {plan.withWorkCount > 0 ? (
              <span className="text-red-700 dark:text-red-300">
                {plan.withWorkCount} of these hold uncommitted or unmerged work.
              </span>
            ) : plan.worktreeCount > 0 ? (
              <span className="text-green-700 dark:text-green-300">Nothing selected holds uncommitted work.</span>
            ) : (
              <span className="text-ink-faint">Tick a group or a row to act on it.</span>
            )}
          </div>
        </div>
        <div className="ml-auto flex items-center gap-2">
          <label className="flex items-center gap-1.5 text-[11px] text-ink-muted mr-1">
            <input
              type="checkbox"
              checked={keepBranch}
              onChange={(e) => setKeepBranch(e.target.checked)}
              className="h-3.5 w-3.5 accent-accent"
              disabled={working}
            />
            Keep the branches
          </label>
          <SheetActionButton
            label={
              working
                ? 'Releasing…'
                : `Release worktree only${release.releaseIds.length ? ` (${release.releaseIds.length})` : ''}`
            }
            onClick={() => void runRelease()}
            disabled={working || release.releaseIds.length === 0}
          />
          <SheetActionButton
            label="Archive"
            onClick={() => void runArchive()}
            disabled={working || plan.conversationCount === 0}
          />
          <SheetActionButton
            primary
            label={`Review & remove${plan.worktreeCount ? ` ${plan.worktreeCount}` : ''}`}
            onClick={() => setView('confirm')}
            disabled={working || plan.worktreeCount === 0}
          />
          <SheetActionButton label="Close" onClick={() => openSheet(null)} disabled={working} />
        </div>
      </div>
    </div>
  );
}

/// Transcript folders whose worktree is gone.
///
/// Its own card, with its own button, because it is not the same kind of
/// thing as the rows above: no worktree, no branch, no conversation — just
/// text Claude wrote that nothing can reach any more. Folding it into the
/// main selection would make "1,352 selected · frees 2.4 GB" mean two
/// different units at once.
function LeftoverTranscripts({
  entries,
  disabled,
  onRemoved,
}: {
  entries: OrphanTranscriptEntry[];
  disabled: boolean;
  onRemoved: (
    removed: number,
    freedKb: number,
    failures: Array<{ dirPath: string; error: string }>,
  ) => void;
}) {
  const [confirming, setConfirming] = useState(false);
  const [working, setWorking] = useState(false);
  const [showAll, setShowAll] = useState(false);
  const totalKb = entries.reduce((sum, e) => sum + e.sizeKb, 0);
  const totalFiles = entries.reduce((sum, e) => sum + e.fileCount, 0);

  const run = async () => {
    setWorking(true);
    try {
      const res = await window.overcli.invoke('transcripts:removeOrphans', {
        dirPaths: entries.map((e) => e.dirPath),
      });
      onRemoved(res.removed, res.freedKb, res.failures);
    } finally {
      setWorking(false);
      setConfirming(false);
    }
  };

  return (
    <div className="rounded-lg border border-card bg-card overflow-hidden">
      <div className="flex items-center gap-2.5 px-3 py-2 bg-card-strong">
        <div className="w-5 h-5 rounded flex items-center justify-center text-[10px] font-bold bg-ink/10 text-ink-muted">
          T
        </div>
        <span className="text-[13px] font-semibold">Leftover transcripts</span>
        <span className="text-[11px] text-ink-faint truncate">
          Claude&rsquo;s own chat logs from worktrees that are already gone
        </span>
        <div className="ml-auto flex items-center gap-3 text-[11px] shrink-0">
          <span className="text-ink-muted">
            {entries.length} folder{entries.length === 1 ? '' : 's'} · {totalFiles} file
            {totalFiles === 1 ? '' : 's'} · {formatSize(totalKb)}
          </span>
          {confirming ? (
            <>
              <SheetActionButton
                label="Cancel"
                onClick={() => setConfirming(false)}
                disabled={working}
              />
              <button
                onClick={() => void run()}
                disabled={disabled || working}
                className="px-2 py-0.5 rounded text-[11px] border bg-red-500/30 border-red-500/60 text-red-800 dark:text-red-200 hover:bg-red-500/40 disabled:opacity-40"
              >
                {working ? 'Removing…' : 'Delete them'}
              </button>
            </>
          ) : (
            <SheetActionButton
              label="Review & delete"
              onClick={() => setConfirming(true)}
              disabled={disabled || working}
            />
          )}
        </div>
      </div>
      <div className="px-3 py-2 text-[11px] text-ink-muted border-t border-card">
        Deleting a conversation never removed these: Claude writes its transcripts under
        <span className="font-mono"> ~/.claude/projects</span>, keyed by the folder the session ran
        in. Once that worktree is gone, nothing in overcli can reach the transcript again — but it
        stays on disk. Nothing here belongs to a worktree that still exists, and transcripts from
        your real project checkouts are never touched.
      </div>
      {confirming && (
        <div className="px-3 pb-2">
          <div className="text-[10px] text-ink-faint font-mono max-h-28 overflow-y-auto">
            {(showAll ? entries : entries.slice(0, 5)).map((e) => (
              <div key={e.dirPath} className="truncate">
                {e.dirPath} · {formatSize(e.sizeKb)}
              </div>
            ))}
          </div>
          {!showAll && entries.length > 5 && (
            <button
              onClick={() => setShowAll(true)}
              className="text-[11px] text-ink-faint hover:text-ink mt-1"
            >
              Show all {entries.length}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

const TONES = {
  safe: { ring: 'border-green-500/40 bg-green-500/10', ink: 'text-green-700 dark:text-green-300' },
  work: { ring: 'border-amber-500/40 bg-amber-500/10', ink: 'text-amber-700 dark:text-amber-300' },
  live: { ring: 'border-card bg-card', ink: 'text-accent' },
  foreign: { ring: 'border-card bg-card', ink: 'text-ink-muted' },
} as const;

function Tile({
  tone,
  label,
  count,
  sub,
  active,
  onClick,
}: {
  tone: keyof typeof TONES;
  label: string;
  count: number;
  sub: string;
  active: boolean;
  onClick: () => void;
}) {
  const t = TONES[tone];
  return (
    <button
      onClick={onClick}
      className={
        'text-left rounded-lg border px-3 py-2.5 transition-colors ' +
        t.ring +
        (active ? ' ring-1 ring-accent/60' : ' hover:bg-card-strong')
      }
    >
      <div className={'text-[11px] font-semibold uppercase tracking-wider ' + t.ink}>{label}</div>
      <div className="text-xl font-semibold mt-1.5">{count}</div>
      <div className="text-[11px] text-ink-muted mt-0.5">{sub}</div>
    </button>
  );
}

function Segmented({
  label,
  options,
  value,
  onChange,
  disabled,
}: {
  label: string;
  options: Array<{ value: string; label: string }>;
  value: string;
  onChange: (v: string) => void;
  disabled?: boolean;
}) {
  return (
    <div className="flex items-center gap-2">
      <span className="text-[11px] text-ink-faint">{label}</span>
      <div className="flex gap-0.5 p-0.5 rounded bg-card w-fit">
        {options.map((o) => (
          <button
            key={o.value}
            onClick={() => onChange(o.value)}
            disabled={disabled}
            className={
              'text-[11px] px-2 py-0.5 rounded disabled:opacity-40 ' +
              (value === o.value ? 'bg-accent/30 text-accent' : 'text-ink-muted hover:text-ink')
            }
          >
            {o.label}
          </button>
        ))}
      </div>
    </div>
  );
}

const KIND_BADGE: Record<CleanupGroupKind, { letter: string; className: string; tag?: string }> = {
  worker: { letter: 'W', className: 'bg-backend-claude/20 text-backend-claude', tag: 'worker' },
  flow: { letter: 'F', className: 'bg-backend-gemini/20 text-backend-gemini', tag: 'flow' },
  chat: { letter: 'Y', className: 'bg-ink/10 text-ink-muted' },
  orphan: { letter: '?', className: 'bg-red-500/15 text-red-700 dark:text-red-300' },
  foreign: { letter: '·', className: 'bg-ink/10 text-ink-faint' },
};

function GroupCard({
  group,
  expanded,
  selected,
  disabled,
  onToggleExpand,
  onToggleEntry,
  onToggleMany,
  onReview,
}: {
  group: CleanupGroup;
  expanded: boolean;
  selected: Set<string>;
  disabled: boolean;
  onToggleExpand: () => void;
  onToggleEntry: (worktreePath: string) => void;
  onToggleMany: (entries: WorktreeSweepEntry[], on: boolean) => void;
  onReview: (entry: WorktreeSweepEntry) => void;
}) {
  const actionable = group.entries.filter(isActionable);
  const allOn = actionable.length > 0 && actionable.every((e) => selected.has(e.worktreePath));
  const badge = KIND_BADGE[group.kind];
  return (
    <div className="rounded-lg border border-card bg-card overflow-hidden">
      <div className="flex items-center gap-2.5 px-3 py-2 bg-card-strong">
        <input
          type="checkbox"
          checked={allOn}
          onChange={(e) => onToggleMany(actionable, e.target.checked)}
          className="h-3.5 w-3.5 accent-accent"
          disabled={disabled || actionable.length === 0}
          title={
            actionable.length === 0
              ? 'Nothing in this group can be removed'
              : 'Select everything removable in this group'
          }
        />
        <button
          onClick={onToggleExpand}
          className="text-ink-faint hover:text-ink text-[10px] w-3"
          aria-label={expanded ? 'Collapse' : 'Expand'}
        >
          {expanded ? '▾' : '▸'}
        </button>
        <div
          className={
            'w-5 h-5 rounded flex items-center justify-center text-[10px] font-bold ' +
            badge.className
          }
        >
          {badge.letter}
        </div>
        <span className="text-[13px] font-semibold truncate max-w-[260px]">{group.name}</span>
        {badge.tag && (
          <span className="text-[10px] text-ink-muted border border-card rounded px-1.5 py-px">
            {badge.tag}
          </span>
        )}
        <span className="text-[11px] text-ink-faint truncate">{group.subtitle}</span>
        <div className="ml-auto flex items-center gap-3 text-[11px] shrink-0">
          {group.safe.length > 0 && (
            <span className="text-green-700 dark:text-green-300">{group.safe.length} safe</span>
          )}
          {group.hasWork.length > 0 && (
            <span className="text-amber-700 dark:text-amber-300">{group.hasWork.length} hold work</span>
          )}
          {group.live.length > 0 && <span className="text-accent">{group.live.length} live</span>}
          <span className="text-ink-muted">
            {group.entries.length} · {formatSize(group.totalKb)}
          </span>
        </div>
      </div>
      {expanded &&
        group.entries.map((entry) => (
          <EntryRow
            key={entry.worktreePath}
            entry={entry}
            checked={selected.has(entry.worktreePath)}
            disabled={disabled}
            onToggle={() => onToggleEntry(entry.worktreePath)}
            onReview={() => onReview(entry)}
          />
        ))}
      {!expanded && group.entries.length > 0 && (
        <button
          onClick={onToggleExpand}
          className="w-full text-left px-3 py-1.5 text-[11px] text-ink-faint hover:text-ink"
        >
          Show {group.entries.length} worktree{group.entries.length === 1 ? '' : 's'}
        </button>
      )}
    </div>
  );
}

const DOT: Record<string, string> = {
  reclaimable: 'bg-green-400',
  'has-work': 'bg-amber-400',
  live: 'bg-accent',
  foreign: 'bg-ink-faint',
};

function EntryRow({
  entry,
  checked,
  disabled,
  onToggle,
  onReview,
}: {
  entry: WorktreeSweepEntry;
  checked: boolean;
  disabled: boolean;
  onToggle: () => void;
  onReview: () => void;
}) {
  const actionable = isActionable(entry);
  const age = formatAge(entryAgeAt(entry), Date.now());
  const reviewable = !!entry.claim?.convId || !!entry.claim?.runId;
  return (
    <div
      className={
        'flex items-center gap-2.5 px-3 py-2 border-t border-card text-xs ' +
        (entry.bucket === 'has-work' ? 'bg-amber-500/5 ' : '') +
        'hover:bg-card-strong'
      }
    >
      <input
        type="checkbox"
        checked={checked}
        onChange={onToggle}
        disabled={disabled || !actionable}
        className="h-3.5 w-3.5 accent-accent"
        title={
          actionable
            ? undefined
            : entry.bucket === 'live'
              ? 'Working right now'
              : 'Outside ~/.overcli/worktrees — not ours to remove'
        }
      />
      <span className={'w-1.5 h-1.5 rounded-full shrink-0 ' + (DOT[entry.bucket] ?? 'bg-ink-faint')} />
      <div className="flex-1 min-w-0">
        <div className="truncate">{entry.claim?.title ?? entry.branchName ?? 'Unnamed worktree'}</div>
        <div className="text-[10px] text-ink-faint truncate font-mono">
          {entry.branchName ?? 'detached'} · {entry.worktreePath}
        </div>
      </div>
      <StateBadge entry={entry} />
      <span className="text-[11px] text-ink-faint w-14 text-right shrink-0">{age ?? '—'}</span>
      <span className="text-[11px] text-ink-muted w-14 text-right shrink-0">
        {formatSize(entry.sizeKb)}
      </span>
      {reviewable ? (
        <button
          onClick={onReview}
          className="text-[11px] px-2 py-0.5 rounded border border-card text-ink-muted hover:text-ink hover:bg-card-strong shrink-0"
        >
          Review
        </button>
      ) : (
        <span className="w-[52px] shrink-0" />
      )}
    </div>
  );
}

function StateBadge({ entry }: { entry: WorktreeSweepEntry }) {
  if (entry.bucket === 'live') {
    return <span className="text-[10px] text-accent shrink-0">working now</span>;
  }
  if (entry.bucket === 'foreign') {
    return <span className="text-[10px] text-ink-faint shrink-0">not ours</span>;
  }
  if (entry.bucket === 'has-work') {
    const parts = [
      entry.dirtyFiles > 0 ? `${entry.dirtyFiles} files uncommitted` : '',
      entry.commitsAhead > 0 && !entry.isMergedIntoBase ? `${entry.commitsAhead} ahead` : '',
    ].filter(Boolean);
    return (
      <span className="text-[10px] text-amber-700 dark:text-amber-300 bg-amber-500/10 rounded px-1.5 py-px shrink-0">
        {parts.join(' · ')}
      </span>
    );
  }
  if (entry.prunable) {
    return <span className="text-[10px] text-ink-faint shrink-0">already gone</span>;
  }
  if (entry.isMergedIntoBase && entry.commitsAhead > 0) {
    return (
      <span className="text-[10px] text-green-700 dark:text-green-300 bg-green-500/10 rounded px-1.5 py-px shrink-0">
        merged into {entry.baseBranch}
      </span>
    );
  }
  return <span className="text-[10px] text-ink-faint shrink-0">no commits</span>;
}

/// The confirm step. Replaces a `window.confirm` that could only manage a
/// paragraph of prose — this says what goes, what stays, and what was refused,
/// which is the whole difference between a deliberate cleanup and a leap.
function ConfirmView({
  plan,
  keepBranch,
  working,
  onBack,
  onConfirm,
}: {
  plan: ReturnType<typeof planCleanup>;
  keepBranch: boolean;
  working: boolean;
  onBack: () => void;
  onConfirm: () => void;
}) {
  const busy = plan.skipped.filter((s) => s.reason === 'busy');
  const foreign = plan.skipped.filter((s) => s.reason === 'foreign');
  return (
    <div className="flex flex-col w-full h-full">
      <div className="px-5 pt-4 pb-3 border-b border-card">
        <div className="text-lg font-semibold">Remove {plan.worktreeCount} items</div>
        <div className="text-xs text-ink-muted mt-1">
          Here is exactly what goes and what stays. This cannot be undone.
        </div>
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto px-5 py-4 flex flex-col gap-4">
        <section>
          <div className="text-[11px] font-semibold uppercase tracking-wider text-red-700 dark:text-red-300 mb-2">
            Deleted
          </div>
          <div className="rounded-lg border border-card overflow-hidden">
            <ConfirmRow
              tone="bad"
              title={`${plan.worktreeCount} worktree${plan.worktreeCount === 1 ? '' : 's'} on disk`}
              sub={`frees ${formatSize(plan.freedKb)} under ~/.overcli/worktrees`}
            />
            {plan.conversationCount > 0 && (
              <ConfirmRow
                tone="bad"
                title={`${plan.conversationCount} conversation${plan.conversationCount === 1 ? '' : 's'}`}
                sub="removed from overcli — the CLI's own transcript file is left where it wrote it"
              />
            )}
            {plan.runCount > 0 && (
              <ConfirmRow
                tone="bad"
                title={`${plan.runCount} flow run${plan.runCount === 1 ? '' : 's'}`}
                sub={
                  'run record and artifacts' +
                  (plan.runsHoldingMore.length > 0
                    ? ` — ${plan.runsHoldingMore.length} of them own worktrees outside this selection and will only go if nothing in them holds work`
                    : '')
                }
              />
            )}
            {plan.withWorkCount > 0 && (
              <ConfirmRow
                tone="bad"
                title={`${plan.withWorkCount} of these hold work`}
                sub="uncommitted files or commits not merged into their base — this is the part that cannot be recovered"
              />
            )}
          </div>
        </section>

        <section>
          <div className="text-[11px] font-semibold uppercase tracking-wider text-green-700 dark:text-green-300 mb-2">
            Left alone
          </div>
          <div className="rounded-lg border border-card overflow-hidden">
            <ConfirmRow
              tone="good"
              title={keepBranch ? 'Every branch' : 'Merged branches only'}
              sub={
                keepBranch
                  ? 'the trees go, the branches stay — the work is still reachable by name'
                  : 'unmerged branches are force-deleted and only recoverable through the reflog'
              }
            />
            {busy.length > 0 && (
              <ConfirmRow
                tone="good"
                title={`${busy.length} working right now`}
                sub="skipped — try again once they finish"
              />
            )}
            {foreign.length > 0 && (
              <ConfirmRow
                tone="good"
                title={`${foreign.length} outside ~/.overcli/worktrees`}
                sub="never ours to delete"
              />
            )}
          </div>
        </section>
      </div>

      <div className="px-5 py-3 border-t border-card flex items-center gap-2">
        <span className="text-[11px] text-ink-faint">
          {plan.worktreeCount} items · {formatSize(plan.freedKb)}
        </span>
        <div className="ml-auto flex gap-2">
          <SheetActionButton label="Back" onClick={onBack} disabled={working} />
          <button
            onClick={onConfirm}
            disabled={working}
            className="px-3 py-1 rounded text-xs border bg-red-500/30 border-red-500/60 text-red-800 dark:text-red-200 hover:bg-red-500/40 disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {working ? 'Removing…' : 'Remove them'}
          </button>
        </div>
      </div>
    </div>
  );
}

function ConfirmRow({
  tone,
  title,
  sub,
}: {
  tone: 'bad' | 'good';
  title: string;
  sub: string;
}) {
  return (
    <div
      className={
        'px-3 py-2.5 border-b border-card last:border-b-0 ' +
        (tone === 'bad' ? 'bg-red-500/5' : 'bg-card')
      }
    >
      <div className="text-xs">{title}</div>
      <div className="text-[11px] text-ink-faint mt-0.5">{sub}</div>
    </div>
  );
}
