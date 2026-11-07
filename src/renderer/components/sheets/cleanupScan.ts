// The Clean up scan, and the unattended auto-tidy that rides on it.
//
// The scan lives here rather than in the sheet because it outlives the sheet.
// A full scan reads git status (and maybe `du`) for every idle worktree and
// takes minutes on a big install; sheets are singular, so opening anything
// else closes Clean up. When the scan was component state, closing the sheet
// threw away the progress and reopening it started from zero. Here it keeps
// going, and reopening attaches to it.
//
// Auto-tidy is the other half: the rules in `shared/cleanupRules.ts` applied
// on a timer, so finished work retires without anyone opening the sheet. It
// only ever acts on what `retirable` returns — entries the scan proved
// clean and merged — and it is gentler than the sheet's Remove: a chat's
// worktree is RELEASED (the conversation stays), and branches are always
// kept.

import { create } from 'zustand';
import type { OrphanTranscriptEntry, UUID, WorktreeSweepEntry } from '@shared/types';
import { DEFAULT_CLEANUP_RULES, parkedAfterDays, retirable, type CleanupRules } from '@shared/cleanupRules';
import { useStore } from '../../store';
import { getAllRunners } from '../../runnersStore';
import {
  conversationClaims,
  describeAutoTidy,
  entryAgeAt,
  unitKeyFor,
  type AutoTidyReport,
  formatSize,
  groupKeyFor,
  isActionable,
  pickRetirable,
  planCleanup,
  stillRetirable,
  type CleanupPlan,
} from './cleanup';

export { describeAutoTidy, type AutoTidyReport };

interface CleanupScanState {
  entries: WorktreeSweepEntry[] | null;
  scannedAt: number;
  measuredSizes: boolean;
  selected: string[];
  leftovers: OrphanTranscriptEntry[];
  scanning: boolean;
  progress: { completed: number; total: number } | null;
  error: string | null;
  /// What the last unattended pass did, for the sheet to say so.
  lastAutoTidy: AutoTidyReport | null;
  autoTidying: boolean;
  /// What an undecided auto-tidy found and is waiting on a yes for. Nothing
  /// in it has been touched.
  pendingConsent: { selected: WorktreeSweepEntry[]; all: WorktreeSweepEntry[] } | null;
}

export const useCleanupScan = create<CleanupScanState>(() => ({
  entries: null,
  scannedAt: 0,
  measuredSizes: false,
  selected: [],
  leftovers: [],
  scanning: false,
  progress: null,
  error: null,
  lastAutoTidy: null,
  autoTidying: false,
  pendingConsent: null,
}));

/// "Not now" holds for the rest of the session — asking every six hours
/// after someone said not now is nagging.
let consentDeferred = false;

function rulesNow(): CleanupRules {
  return useStore.getState().settings.cleanup ?? DEFAULT_CLEANUP_RULES;
}

function runningById(): Record<UUID, boolean> {
  const runners = getAllRunners();
  const out: Record<UUID, boolean> = {};
  for (const id of Object.keys(runners)) out[id] = runners[id]?.isRunning ?? false;
  return out;
}

/// What arrives pre-ticked: the auto-tidy rules' answer, or every safe row
/// when the rules are off.
export function ruleSelection(entries: WorktreeSweepEntry[], rules: CleanupRules): string[] {
  if (rules.retireAfterDays <= 0) {
    return entries.filter((e) => e.bucket === 'reclaimable').map((e) => e.worktreePath);
  }
  return retirable(entries, rules, (e) => groupKeyFor(e).key, entryAgeAt, Date.now(), unitKeyFor).map(
    (e) => e.worktreePath,
  );
}

let progressWired = false;
function wireProgress() {
  if (progressWired) return;
  progressWired = true;
  window.overcli.onMainEvent((event) => {
    if (event.type === 'worktreeScanProgress' && useCleanupScan.getState().scanning) {
      useCleanupScan.setState({ progress: { completed: event.completed, total: event.total } });
    }
  });
}

let inflight: Promise<WorktreeSweepEntry[] | null> | null = null;

/// Start a scan, or join the one already running. Never two at once: main
/// reports progress on one channel, and two scans would fight over it.
export function startScan(opts?: { measureSizes?: boolean | 'auto' }): Promise<WorktreeSweepEntry[] | null> {
  if (inflight) return inflight;
  wireProgress();
  useCleanupScan.setState({ scanning: true, progress: null, error: null });
  inflight = (async () => {
    try {
      // Claims are read at call time from live store state rather than from
      // `overcli.json`, which lags in-memory state by a save — a stale read
      // would report a live tree as an orphan and offer to delete it.
      const { projects: ps, workspaces: ws } = useStore.getState();
      const res = await window.overcli.invoke('git:scanWorktrees', {
        projects: ps.map((p) => ({ path: p.path, name: p.name })),
        claims: conversationClaims([...ps, ...ws], runningById()),
        measureSizes: opts?.measureSizes ?? 'auto',
        parkedAfterDays: parkedAfterDays(rulesNow()),
      });
      // Cheap enough to ride along with every scan: a handful of file stats
      // per folder, no git and no `du`.
      void window.overcli
        .invoke('transcripts:scanOrphans')
        .then((r) => useCleanupScan.setState({ leftovers: r.entries }))
        .catch(() => useCleanupScan.setState({ leftovers: [] }));
      // Pre-select what the rules would retire. Nothing holding work is ever
      // pre-ticked: that is opted into per row, after reading what it holds.
      useCleanupScan.setState({
        entries: res.entries,
        scannedAt: res.scannedAt,
        measuredSizes: res.measuredSizes,
        selected: ruleSelection(res.entries, rulesNow()),
      });
      return res.entries;
    } catch (e) {
      useCleanupScan.setState({ error: e instanceof Error ? e.message : String(e) });
      return null;
    } finally {
      useCleanupScan.setState({ scanning: false, progress: null });
      inflight = null;
    }
  })();
  return inflight;
}

export function setCleanupSelection(next: Iterable<string>) {
  useCleanupScan.setState({ selected: [...next] });
}

/// Drop what was just removed from the list, keeping everything else.
///
/// Deliberately NOT a rescan — see the sheet. Anything that failed is passed
/// in as `keptPaths` and stays on the list.
export function pruneRemoved(removedPaths: string[], keptPaths: string[] = []) {
  const gone = new Set(removedPaths.filter((p) => !keptPaths.includes(p)));
  useCleanupScan.setState((s) => ({
    entries: s.entries ? s.entries.filter((e) => !gone.has(e.worktreePath)) : s.entries,
    selected: s.selected.filter((p) => !gone.has(p)),
  }));
}

/// Remove whole units. Each producer has its own teardown and using the
/// wrong one strands half a unit — see `planCleanup`.
///
/// `releaseChats` is the unattended mode: a chat's tree is released rather
/// than the chat deleted, so a timer never takes anyone's transcript.
export async function removeUnits(args: {
  selected: WorktreeSweepEntry[];
  all: WorktreeSweepEntry[];
  keepBranch: boolean;
  releaseChats?: boolean;
}): Promise<{ removed: number; freedKb: number; warnings: string[]; kept: string[]; attempted: string[] }> {
  const { selected, keepBranch } = args;
  const store = useStore.getState();
  const plan: CleanupPlan = planCleanup(selected, args.all);
  const warnings: string[] = [];
  // A unit that fails must stay on the list — that is the case where a
  // pruned row would lie about what is on disk.
  const kept: string[] = [];
  const attempted = selected.filter(isActionable).map((e) => e.worktreePath);
  const pathsFor = (match: (e: WorktreeSweepEntry) => boolean) =>
    selected.filter(match).map((e) => e.worktreePath);

  const retireTrees = [...plan.retireRunTrees];
  for (const runId of plan.removeRunIds) {
    // Unattended, a run that owns more than these trees gives up just these:
    // one tree holding work must not keep its clean siblings on disk.
    if (args.releaseChats && plan.runsHoldingMore.includes(runId)) {
      retireTrees.push({ runId, worktreePaths: pathsFor((e) => e.claim?.runId === runId) });
      continue;
    }
    // `force` bypasses the flow runtime's own guard against deleting a run
    // whose worktrees hold unreviewed work. It is only ours to pass when
    // every tree that run owns is in this selection. Unattended, never: the
    // guard always gets the final say.
    const force = !args.releaseChats && !plan.runsHoldingMore.includes(runId);
    const res = await window.overcli.invoke('flows:deleteRun', { runId, force });
    if (!res.ok) {
      const title = selected.find((e) => e.claim?.runId === runId)?.claim?.title ?? runId;
      warnings.push(
        'needsConfirm' in res
          ? `${title}: kept — it owns ${res.dirty.length} worktree${res.dirty.length === 1 ? '' : 's'} with unreviewed work that this selection did not cover. Open the run to review, or tick every one of its rows.`
          : `${title}: ${'error' in res ? res.error : 'delete refused'}`,
      );
      kept.push(...pathsFor((e) => e.claim?.runId === runId));
    }
  }
  for (const { runId, worktreePaths } of retireTrees) {
    const title = selected.find((e) => e.claim?.runId === runId)?.claim?.title ?? runId;
    const res = await window.overcli.invoke('flows:retireRunWorktrees', { runId, worktreePaths });
    if (!res.ok) {
      warnings.push(`${title}: ${res.error}`);
      kept.push(...worktreePaths);
      continue;
    }
    const reasons = [...new Set(res.kept.map((k) => k.reason))];
    if (reasons.length > 0) {
      warnings.push(`${title}: kept ${res.kept.length} worktree${res.kept.length === 1 ? '' : 's'}: ${reasons.join('; ')}`);
    }
    kept.push(...res.kept.map((k) => k.worktreePath));
  }
  for (const convId of plan.removeAgentIds) {
    // Unattended: main checks the tree again at the moment of removal.
    const res = args.releaseChats
      ? await store.releaseWorktree(convId, { keepBranch, unattended: true })
      : await store.removeAgent(convId, { keepBranch });
    const named = (text: string) => {
      const e = selected.find((x) => x.claim?.convId === convId);
      return `${e?.claim?.title ?? e?.worktreePath ?? convId}: ${text}`;
    };
    if (!res.ok) {
      if (res.error) warnings.push(named(res.error));
      kept.push(...pathsFor((e) => e.claim?.convId === convId));
    } else if (res.warning) warnings.push(named(res.warning));
  }
  if (!args.releaseChats) {
    for (const convId of plan.removeAdoptedIds) await store.removeConversation(convId);
  }
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
  const keptSet = new Set(kept);
  const freedKb = selected
    .filter((e) => isActionable(e) && !keptSet.has(e.worktreePath))
    .reduce((n, e) => n + e.sizeKb, 0);
  return { removed: plan.worktreeCount - keptSet.size, freedKb, warnings, kept, attempted };
}

/// One unattended pass: scan without `du` (sizes decide nothing), then
/// retire exactly what the rules say. Skipped while the rules are off, while
/// auto-run is off, or while someone has the sheet mid-decision.
export async function runAutoTidy(): Promise<AutoTidyReport | null> {
  const rules = rulesNow();
  if (!autoRunEnabled(rules) || useCleanupScan.getState().autoTidying) return null;
  // Someone is in the sheet deciding. Retiring rows out from under their
  // selection would be worse than waiting six hours.
  if (useStore.getState().activeSheet?.type === 'cleanup') return null;
  useCleanupScan.setState({ autoTidying: true });
  try {
    const entries = await startScan({ measureSizes: false });
    if (!entries) return null;
    const selected = pickRetirable(entries, rules, Date.now());
    if (selected.length === 0) {
      const report = { at: Date.now(), removed: 0, freedKb: 0, warnings: [] };
      useCleanupScan.setState({ lastAutoTidy: report });
      return report;
    }
    // Undecided: ask, don't act. The prompt's yes is what turns it on.
    if (rules.autoRun !== true) {
      useCleanupScan.setState({ pendingConsent: { selected, all: entries } });
      return null;
    }
    return await retire(selected, entries);
  } finally {
    useCleanupScan.setState({ autoTidying: false });
  }
}

async function retire(selected: WorktreeSweepEntry[], all: WorktreeSweepEntry[], warnings: string[] = []): Promise<AutoTidyReport> {
  const res = await removeUnits({ selected, all, keepBranch: true, releaseChats: true });
  pruneRemoved(res.attempted, res.kept);
  const report = { at: Date.now(), removed: res.removed, freedKb: res.freedKb, warnings: [...warnings, ...res.warnings], kept: res.kept.length };
  useCleanupScan.setState({ lastAutoTidy: report });
  return report;
}

async function saveAutoRun(on: boolean) {
  const { settings, saveSettings } = useStore.getState();
  const rules = settings.cleanup ?? DEFAULT_CLEANUP_RULES;
  await saveSettings({ ...settings, cleanup: { ...rules, autoRun: on } });
}

/// Yes from the prompt: retire this batch and keep doing it on the timer.
export async function confirmAutoTidy(): Promise<AutoTidyReport | null> {
  const pending = useCleanupScan.getState().pendingConsent;
  useCleanupScan.setState({ pendingConsent: null });
  await saveAutoRun(true);
  if (!pending) return null;
  useCleanupScan.setState({ autoTidying: true });
  try {
    // The prompt may have sat for hours: a chat could have been resumed in one
    // of these trees since. Scan again and retire only what is still safe.
    const entries = await startScan({ measureSizes: false });
    if (!entries) return null;
    const { selected, kept: changed } = stillRetirable(pending.selected, entries, rulesNow(), Date.now());
    const warnings = changed > 0 ? [`${changed} worktree${changed === 1 ? '' : 's'} changed since you were asked and ${changed === 1 ? 'was' : 'were'} kept.`] : [];
    if (selected.length === 0) {
      const report = { at: Date.now(), removed: 0, freedKb: 0, warnings };
      useCleanupScan.setState({ lastAutoTidy: report });
      return report;
    }
    return await retire(selected, entries, warnings);
  } finally {
    useCleanupScan.setState({ autoTidying: false });
  }
}

/// "Not now" (ask again next launch) or "Turn off" (stop asking).
export async function declineAutoTidy(turnOff: boolean) {
  useCleanupScan.setState({ pendingConsent: null });
  if (turnOff) await saveAutoRun(false);
  else consentDeferred = true;
}

export function autoRunEnabled(rules: CleanupRules): boolean {
  if (rules.retireAfterDays <= 0 || rules.autoRun === false) return false;
  // Undecided and already told "not now" this session.
  if (rules.autoRun !== true && consentDeferred) return false;
  return true;
}

/// First pass a few minutes after launch (startup is busy enough), then
/// every six hours. Returns the disposer.
const FIRST_PASS_MS = 3 * 60_000;
const EVERY_MS = 6 * 60 * 60_000;
export function installAutoTidy(): () => void {
  const tick = () => void runAutoTidy().catch(() => {});
  const first = setTimeout(tick, FIRST_PASS_MS);
  const every = setInterval(tick, EVERY_MS);
  return () => {
    clearTimeout(first);
    clearInterval(every);
  };
}
