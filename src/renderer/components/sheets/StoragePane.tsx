// Settings → Storage. Reclaims disk from worktrees that outlived whatever
// created them.
//
// Scoped deliberately to ORPHANS — trees no conversation and no flow run
// points at any more. Releasing a worktree a conversation still owns means
// deleting that conversation, which is about your history rather than your
// disk, so it lives in Settings → Conversations instead. Bundling the two
// here made a pane that deleted hundreds of conversations to reclaim
// kilobytes, which is the wrong trade wearing the wrong label.

import { useEffect, useMemo, useState } from 'react';
import { useStore } from '../../store';
import {
  WorktreeSweepEntry,
  WorktreeSweepBucket,
  Conversation,
  AGE_FILTER_CHOICES,
} from '@shared/types';
import { Group, SheetActionButton } from './settingsChrome';

/// Buckets the user can act on, in the order they're shown. `live` and
/// `foreign` are reported below as read-only context — they exist so the
/// totals add up and the user can see nothing was hidden from them.
const ACTIONABLE: WorktreeSweepBucket[] = ['reclaimable', 'has-work'];

function formatSize(kb: number): string {
  if (kb <= 0) return '—';
  if (kb < 1024) return `${kb} KB`;
  if (kb < 1024 * 1024) return `${(kb / 1024).toFixed(0)} MB`;
  return `${(kb / 1024 / 1024).toFixed(1)} GB`;
}

/// Every worktree path app state still claims. Read from the live store
/// rather than from disk — `overcli.json` lags in-memory state by a save, and
/// a stale read would report a live tree as an orphan and offer it for
/// deletion. Read through `getState()` at call time rather than a memo so the
/// rescan after a sweep sees current state.
function claimedPaths(): string[] {
  const { projects, workspaces } = useStore.getState();
  const out: string[] = [];
  const add = (c: Conversation) => {
    if (c.worktreePath) out.push(c.worktreePath);
  };
  for (const p of projects) for (const c of p.conversations) add(c);
  for (const w of workspaces) for (const c of w.conversations ?? []) add(c);
  return out;
}

function formatAge(at: number | undefined): string | null {
  if (!at) return null;
  const days = Math.floor((Date.now() - at) / (24 * 60 * 60 * 1000));
  if (days < 1) return 'today';
  if (days === 1) return 'yesterday';
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  return months === 1 ? '1mo ago' : `${months}mo ago`;
}

export function StoragePane() {
  const projects = useStore((s) => s.projects);
  const workspaces = useStore((s) => s.workspaces);

  const [entries, setEntries] = useState<WorktreeSweepEntry[] | null>(null);
  const [minAgeDays, setMinAgeDays] = useState(0);
  const [scanning, setScanning] = useState(false);
  const [progress, setProgress] = useState<{ completed: number; total: number } | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [confirming, setConfirming] = useState(false);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<string | null>(null);

  // Inspecting a candidate walks its working tree twice (git status, then
  // du), so a large install sits here for a minute or more. Subscribed
  // locally rather than through the store: nothing outside this pane cares,
  // and the subscription should die with it.
  useEffect(() => {
    return window.overcli.onMainEvent((event) => {
      if (event.type === 'worktreeScanProgress') {
        setProgress({ completed: event.completed, total: event.total });
      }
    });
  }, []);

  const runScan = async () => {
    setScanning(true);
    setProgress(null);
    setError(null);
    setResult(null);
    setConfirming(false);
    try {
      const res = await window.overcli.invoke('git:scanWorktrees', {
        projects: projects.map((p) => ({ path: p.path, name: p.name })),
        conversationPaths: claimedPaths(),
      });
      setEntries(res.entries);
      // Pre-select only what's provably safe. Anything holding work stays
      // unchecked — the user opts in per row after reading what it holds.
      setSelected(
        new Set(
          res.entries.filter((e) => e.bucket === 'reclaimable').map((e) => e.worktreePath),
        ),
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setScanning(false);
      setProgress(null);
    }
  };

  /// Entries passing the "older than" filter — dated by the worktree's last
  /// commit, since an orphan has no conversation left to date it by.
  const visible = useMemo(() => {
    if (!entries) return [];
    if (minAgeDays <= 0) return entries;
    const cutoff = Date.now() - minAgeDays * 24 * 60 * 60 * 1000;
    return entries.filter((e) => {
      const at = e.lastCommitAt;
      // Undated entries stay visible. Hiding something we simply couldn't
      // date would quietly shrink the list without the user knowing why.
      return at === undefined || at < cutoff;
    });
  }, [entries, minAgeDays]);

  const byBucket = useMemo(() => {
    const map = new Map<WorktreeSweepBucket, WorktreeSweepEntry[]>();
    for (const e of visible) {
      const list = map.get(e.bucket);
      if (list) list.push(e);
      else map.set(e.bucket, [e]);
    }
    return map;
  }, [visible]);

  // Intersected with what's on screen, deliberately. Narrowing the filter
  // after selecting must not leave invisible entries armed for deletion —
  // the count in the action bar has to mean exactly what you can see.
  const selectedEntries = useMemo(
    () => visible.filter((e) => selected.has(e.worktreePath)),
    [visible, selected],
  );
  const hiddenSelected = useMemo(() => {
    if (minAgeDays <= 0) return 0;
    const shown = new Set(visible.map((e) => e.worktreePath));
    return (entries ?? []).filter(
      (e) => selected.has(e.worktreePath) && !shown.has(e.worktreePath),
    ).length;
  }, [entries, visible, selected, minAgeDays]);
  const selectedKb = selectedEntries.reduce((sum, e) => sum + e.sizeKb, 0);
  const selectedWithWork = selectedEntries.filter((e) => e.bucket === 'has-work');

  const toggle = (worktreePath: string) => {
    setConfirming(false);
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(worktreePath)) next.delete(worktreePath);
      else next.add(worktreePath);
      return next;
    });
  };

  const toggleMany = (paths: string[], on: boolean) => {
    setConfirming(false);
    setSelected((prev) => {
      const next = new Set(prev);
      for (const p of paths) {
        if (on) next.add(p);
        else next.delete(p);
      }
      return next;
    });
  };

  const toggleBucket = (bucket: WorktreeSweepBucket, on: boolean) =>
    toggleMany((byBucket.get(bucket) ?? []).map((e) => e.worktreePath), on);

  /// Pure git. Everything on offer here is an orphan, so there is no
  /// conversation row to keep in step — that case moved to Settings →
  /// Conversations, which owns `removeAgent`.
  const runSweep = async () => {
    setWorking(true);
    setError(null);
    try {
      const res = await window.overcli.invoke('git:sweepWorktrees', {
        entries: selectedEntries.map((e) => ({
          projectPath: e.projectPath,
          worktreePath: e.worktreePath,
          branchName: e.branchName,
          baseBranch: e.baseBranch,
        })),
      });
      const parts = [`Removed ${res.removed} worktree${res.removed === 1 ? '' : 's'}`];
      if (res.freedKb > 0) parts.push(`freed ${formatSize(res.freedKb)}`);
      setResult(parts.join(', ') + '.');
      if (res.failures.length > 0) {
        setError(
          `${res.failures.length} could not be removed:\n` +
            res.failures.map((f) => `${f.worktreePath}: ${f.error}`).join('\n'),
        );
      }
      setConfirming(false);
      // Re-scan so the list reflects what's actually left rather than an
      // optimistic local filter — a partial failure must stay visible.
      const rescan = await window.overcli.invoke('git:scanWorktrees', {
        projects: projects.map((p) => ({ path: p.path, name: p.name })),
        conversationPaths: claimedPaths(),
      });
      setEntries(rescan.entries);
      setSelected(new Set());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setWorking(false);
    }
  };

  // Only candidates were measured (see `scanWorktrees`), so this total covers
  // what's on offer — it is never the disk usage of every worktree found.
  const suggested = byBucket.get('reclaimable')?.length ?? 0;
  const suggestedKb = (byBucket.get('reclaimable') ?? []).reduce(
    (sum, e) => sum + e.sizeKb,
    0,
  );

  return (
    <div className="space-y-5">
      <Group
        title="Orphaned worktrees"
        description="Agent and flow worktrees live under ~/.overcli/worktrees. Scan to find the ones nothing points at any more — their conversation or flow run is already gone. Worktrees a conversation still owns are left alone here; releasing those means deleting the conversation, which lives under Conversations."
      >
        <div className="flex items-center gap-3 flex-wrap">
          <SheetActionButton
            primary
            label={scanning ? 'Scanning…' : entries ? 'Rescan' : 'Scan worktrees'}
            onClick={() => void runScan()}
            disabled={scanning || working}
          />
          {entries && !scanning && (
            <div className="text-xs text-ink-muted">
              {entries.length} found ·{' '}
              <span className="text-green-300">
                {suggested} suggested ({formatSize(suggestedKb)})
              </span>
            </div>
          )}
        </div>
        {entries && entries.length > 0 && !scanning && (
          <div className="flex items-center gap-2 flex-wrap pt-1">
            <span className="text-xs text-ink-muted">Show only older than</span>
            <div className="flex gap-0.5 p-0.5 rounded bg-card w-fit">
              {AGE_FILTER_CHOICES.map((d) => (
                <button
                  key={d}
                  onClick={() => setMinAgeDays(d)}
                  disabled={working}
                  className={
                    'text-[11px] px-2 py-0.5 rounded disabled:opacity-40 ' +
                    (minAgeDays === d
                      ? 'bg-accent/30 text-accent'
                      : 'text-ink-muted hover:text-ink')
                  }
                >
                  {d === 0 ? 'Any' : d >= 180 ? '6mo' : `${d}d`}
                </button>
              ))}
            </div>
            {minAgeDays > 0 && (
              <span className="text-[11px] text-ink-faint">
                {visible.length} of {entries.length} shown
                {hiddenSelected > 0 && ` · ${hiddenSelected} selected but hidden, not counted`}
              </span>
            )}
          </div>
        )}
        {scanning && (
          <div className="flex flex-col gap-1">
            <div className="text-[11px] text-ink-faint">
              {progress
                ? `Inspecting ${progress.total} candidate${progress.total === 1 ? '' : 's'} — ${progress.completed} of ${progress.total}. Reading git status and disk usage for each.`
                : `Listing worktrees across ${projects.length} project${projects.length === 1 ? '' : 's'}…`}
            </div>
            {progress && progress.total > 0 && (
              <div className="h-1 rounded bg-card-strong overflow-hidden">
                <div
                  className="h-full bg-accent transition-all"
                  style={{ width: `${Math.round((progress.completed / progress.total) * 100)}%` }}
                />
              </div>
            )}
          </div>
        )}
      </Group>

      {result && (
        <div className="text-xs text-green-300 bg-green-500/10 border border-green-500/30 rounded px-3 py-2">
          {result}
        </div>
      )}
      {error && (
        <div className="text-xs text-red-300 bg-red-500/10 border border-red-500/30 rounded px-3 py-2 whitespace-pre-wrap max-h-40 overflow-y-auto">
          {error}
        </div>
      )}

      {entries && entries.length === 0 && (
        <div className="text-xs text-ink-faint">
          No worktrees found. Nothing to clean up.
        </div>
      )}

      {selectedEntries.length > 0 && (
        <ActionBar
          count={selectedEntries.length}
          sizeKb={selectedKb}
          withWork={selectedWithWork.length}
          confirming={confirming}
          working={working}
          onArm={() => setConfirming(true)}
          onCancel={() => setConfirming(false)}
          onConfirm={() => void runSweep()}
        />
      )}

      {entries &&
        ACTIONABLE.map((bucket) => {
          const list = byBucket.get(bucket) ?? [];
          if (list.length === 0) return null;
          const allOn = list.every((e) => selected.has(e.worktreePath));
          return (
            <BucketSection
              key={bucket}
              bucket={bucket}
              entries={list}
              selected={selected}
              allOn={allOn}
              onToggle={toggle}
              onToggleMany={toggleMany}
              onToggleAll={(on) => toggleBucket(bucket, on)}
              disabled={working}
            />
          );
        })}

      {entries && (byBucket.get('live')?.length || byBucket.get('foreign')?.length) ? (
        <ContextSection
          live={byBucket.get('live') ?? []}
          foreign={byBucket.get('foreign') ?? []}
        />
      ) : null}

    </div>
  );
}

/// The commit bar. Sticks to the TOP of the scrolling pane, not the bottom:
/// the Settings sheet already owns a fixed footer, and a `bottom-0` bar inside
/// the scroll area rendered straight over the rows.
function ActionBar({
  count,
  sizeKb,
  withWork,
  confirming,
  working,
  onArm,
  onCancel,
  onConfirm,
}: {
  count: number;
  sizeKb: number;
  withWork: number;
  confirming: boolean;
  working: boolean;
  onArm: () => void;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <div
      className={
        'sticky top-0 z-10 -mx-1 px-3 py-2 rounded-lg border backdrop-blur ' +
        (withWork > 0
          ? 'border-red-500/40 bg-red-500/20'
          : 'border-accent/40 bg-surface-muted/95')
      }
    >
      <div className="flex items-center gap-3 flex-wrap">
        <div className="text-xs mr-auto">
          <span className="text-ink font-medium">{count} selected</span>
          <span className="text-ink-muted"> · {formatSize(sizeKb)}</span>
        </div>
        {confirming ? (
          <>
            <SheetActionButton label="Back" onClick={onCancel} disabled={working} />
            <button
              onClick={onConfirm}
              disabled={working}
              className="px-3 py-1 rounded text-xs border bg-red-500/30 border-red-500/60 text-red-200 hover:bg-red-500/40 disabled:opacity-40 disabled:cursor-not-allowed"
            >
              {working ? 'Removing…' : 'Remove them'}
            </button>
          </>
        ) : (
          <SheetActionButton
            label={`Remove ${count}…`}
            onClick={onArm}
            disabled={working}
          />
        )}
      </div>
      {withWork > 0 && (
        <div className="text-[11px] text-red-300 mt-1">
          {withWork} hold uncommitted or unmerged work that will be destroyed.
        </div>
      )}
      {confirming && (
        <div className="text-[11px] text-ink-muted mt-1">
          Removes the worktree{count === 1 ? '' : 's'} and deletes the branch
          {count === 1 ? '' : 'es'}
          .
        </div>
      )}
    </div>
  );
}

function BucketSection({
  bucket,
  entries,
  selected,
  allOn,
  onToggle,
  onToggleMany,
  onToggleAll,
  disabled,
}: {
  bucket: WorktreeSweepBucket;
  entries: WorktreeSweepEntry[];
  selected: Set<string>;
  allOn: boolean;
  onToggle: (worktreePath: string) => void;
  onToggleMany: (paths: string[], on: boolean) => void;
  onToggleAll: (on: boolean) => void;
  disabled: boolean;
}) {
  const [open, setOpen] = useState<Set<string>>(new Set());

  // Biggest project first, biggest worktree first within it — the point of
  // the list is reclaiming space, so lead with where the space is.
  const groups = useMemo(() => {
    const byProject = new Map<string, WorktreeSweepEntry[]>();
    for (const e of entries) {
      const list = byProject.get(e.projectName);
      if (list) list.push(e);
      else byProject.set(e.projectName, [e]);
    }
    return [...byProject.entries()]
      .map(([projectName, list]) => ({
        projectName,
        entries: [...list].sort((a, b) => b.sizeKb - a.sizeKb),
        sizeKb: list.reduce((sum, e) => sum + e.sizeKb, 0),
      }))
      .sort((a, b) => b.sizeKb - a.sizeKb || a.projectName.localeCompare(b.projectName));
  }, [entries]);

  const totalKb = entries.reduce((sum, e) => sum + e.sizeKb, 0);
  const title = bucket === 'reclaimable' ? 'Safe to remove' : 'Holds work';
  const description =
    bucket === 'reclaimable'
      ? 'Nothing points at these — the conversation or flow run that made them is already gone. Clean, with nothing unmerged.'
      : 'Also unreferenced, but these hold changes that removing would destroy. Selected individually only.';

  return (
    <div>
      <div className="flex items-baseline justify-between mb-1">
        <div className="text-[10px] uppercase tracking-wider text-ink-faint">
          {title} · {entries.length} · {formatSize(totalKb)}
        </div>
        <button
          onClick={() => onToggleAll(!allOn)}
          disabled={disabled}
          className="text-[10px] text-ink-muted hover:text-ink disabled:opacity-40"
        >
          {allOn ? 'Deselect all' : 'Select all'}
        </button>
      </div>
      <div className="text-xs text-ink-faint mb-2">{description}</div>
      <div className="flex flex-col gap-1">
        {groups.map((g) => (
          <ProjectGroup
            key={g.projectName}
            group={g}
            selected={selected}
            expanded={open.has(g.projectName)}
            onExpand={() =>
              setOpen((prev) => {
                const next = new Set(prev);
                if (next.has(g.projectName)) next.delete(g.projectName);
                else next.add(g.projectName);
                return next;
              })
            }
            onToggle={onToggle}
            onToggleMany={onToggleMany}
            disabled={disabled}
          />
        ))}
      </div>
    </div>
  );
}

/// One project's worth of entries, collapsed by default. With hundreds of
/// candidates a flat list is unreadable, and they cluster hard by project —
/// collapsing turns 220 rows into ~15. Sorted biggest-first at both levels so
/// the first thing on screen is where the disk actually went.
function ProjectGroup({
  group,
  selected,
  expanded,
  onExpand,
  onToggle,
  onToggleMany,
  disabled,
}: {
  group: { projectName: string; entries: WorktreeSweepEntry[]; sizeKb: number };
  selected: Set<string>;
  expanded: boolean;
  onExpand: () => void;
  onToggle: (worktreePath: string) => void;
  onToggleMany: (paths: string[], on: boolean) => void;
  disabled: boolean;
}) {
  const paths = group.entries.map((e) => e.worktreePath);
  const selectedCount = paths.filter((p) => selected.has(p)).length;
  const allOn = selectedCount === paths.length;

  return (
    <div className="rounded border border-card bg-card">
      <div className="flex items-center gap-2 px-2 py-1.5">
        <input
          type="checkbox"
          checked={allOn}
          ref={(el) => {
            // Partial selection reads as neither on nor off.
            if (el) el.indeterminate = selectedCount > 0 && !allOn;
          }}
          onChange={() => onToggleMany(paths, !allOn)}
          disabled={disabled}
          className="accent-current"
        />
        <button
          onClick={onExpand}
          className="flex items-center gap-1.5 min-w-0 flex-1 text-left"
        >
          <span className="text-ink-faint text-[10px] w-2">{expanded ? '▾' : '▸'}</span>
          <span className="text-xs text-ink truncate">{group.projectName}</span>
          <span className="text-[11px] text-ink-faint">
            {group.entries.length} · {formatSize(group.sizeKb)}
          </span>
          {selectedCount > 0 && !allOn && (
            <span className="text-[10px] text-accent">{selectedCount} selected</span>
          )}
        </button>
      </div>
      {expanded && (
        <div className="border-t border-card divide-y divide-card/60">
          {group.entries.map((e) => (
            <EntryRow
              key={e.worktreePath}
              entry={e}
              checked={selected.has(e.worktreePath)}
              onToggle={() => onToggle(e.worktreePath)}
              disabled={disabled}
            />
          ))}
        </div>
      )}
    </div>
  );
}

/// A single worktree, on one line. Deliberately terse: the project is already
/// the group header, and the branch name is derived from the conversation
/// name, so showing branch + conversation + full path (as this first did) was
/// the same string three times. Tags appear only for the exceptional — a "no
/// changes vs master" pill on every row of a bucket *defined* by having no
/// changes is noise that hides the rows that do differ.
function EntryRow({
  entry,
  checked,
  onToggle,
  disabled,
}: {
  entry: WorktreeSweepEntry;
  checked: boolean;
  onToggle: () => void;
  disabled: boolean;
}) {
  const danger = entry.bucket === 'has-work';
  // An orphan has no conversation to date it by; the last commit stands in.
  const age = formatAge(entry.lastCommitAt);
  return (
    <label
      className={
        'flex items-center gap-2.5 px-2 py-1.5 cursor-pointer select-none ' +
        (checked ? (danger ? 'bg-red-500/10' : 'bg-accent/5') : 'hover:bg-card-strong') +
        (disabled ? ' opacity-50 cursor-not-allowed' : '')
      }
      title={entry.worktreePath}
    >
      <input
        type="checkbox"
        checked={checked}
        onChange={onToggle}
        disabled={disabled}
        className="accent-current flex-shrink-0"
      />
      <span className="font-mono text-[11px] text-ink truncate flex-1 min-w-0">
        {entry.branchName ?? '(detached HEAD)'}
      </span>
      {entry.dirtyFiles > 0 && <Tag tone="amber">{entry.dirtyFiles} dirty</Tag>}
      {entry.commitsAhead > 0 && !entry.isMergedIntoBase && (
        <Tag tone="amber">{entry.commitsAhead} unmerged</Tag>
      )}
      {entry.locked && <Tag tone="amber">locked</Tag>}
      {entry.prunable && <Tag tone="neutral">gone</Tag>}
      {age && (
        <span className="text-[10px] text-ink-faint flex-shrink-0 w-14 text-right">
          {age}
        </span>
      )}
      <span className="text-[10px] text-ink-faint flex-shrink-0 w-16 text-right">
        {formatSize(entry.sizeKb)}
      </span>
    </label>
  );
}

/// Read-only accounting for everything the sweep will not touch, so the
/// counts on screen add up to every worktree git reported. No sizes here —
/// these are deliberately left unmeasured (see `scanWorktrees`).
function ContextSection({
  live,
  foreign,
}: {
  live: WorktreeSweepEntry[];
  foreign: WorktreeSweepEntry[];
}) {
  return (
    <Group title="Not offered">
      {live.length > 0 && (
        <div className="text-xs text-ink-muted">
          <span className="text-ink">{live.length}</span> in use — a conversation or flow
          run still points at them. Delete the conversation or run to release these.
        </div>
      )}
      {foreign.length > 0 && (
        <div className="text-xs text-ink-muted">
          <span className="text-ink">{foreign.length}</span> outside overcli — worktrees
          under a path overcli doesn't manage. Yours or another tool's; left alone.
        </div>
      )}
    </Group>
  );
}

function Tag({ children, tone }: { children: React.ReactNode; tone: 'green' | 'amber' | 'neutral' }) {
  const cls =
    tone === 'green'
      ? 'bg-green-500/15 text-green-300 border-green-500/30'
      : tone === 'amber'
        ? 'bg-amber-500/15 text-amber-300 border-amber-500/30'
        : 'bg-accent/5 text-ink-muted border-accent/30';
  return (
    <span className={'rounded-full border px-2 py-0.5 text-[10px] font-medium ' + cls}>
      {children}
    </span>
  );
}
