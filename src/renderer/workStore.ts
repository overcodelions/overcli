// The Work view's state: the main-process work log (runs that outlived
// eviction), the PRs each repo's branches landed in, and the search. The
// records themselves are derived — `useWorkRecords` rebuilds them from what
// the other stores already hold, so there is nothing here to fall out of step.

import { useEffect, useMemo } from 'react';
import { create } from 'zustand';

import {
  buildWorkRecords,
  isWorkBranch,
  type BranchStatus,
  type PromptHit,
  type RepoBranch,
  type WorkLogEntry,
  type WorkPlace,
  type WorkPr,
  type WorkRecord,
} from '@shared/workRecords';
import { useFlowsStore } from './flowsStore';
import { useOrchestratorStore } from './orchestratorStore';
import { useStore } from './store';
import { useTeamsStore } from './teamsStore';

const LAST_SEEN_KEY = 'work.lastSeenAt';
const SIDEBAR_KEY = 'work.sidebar';

function readSidebarWork(): boolean {
  try {
    return localStorage.getItem(SIDEBAR_KEY) === 'true';
  } catch {
    return false;
  }
}

function readLastSeen(): number {
  // First launch with Work: start the count now, or every record ever made
  // would read as new.
  try {
    const stored = Number(localStorage.getItem(LAST_SEEN_KEY));
    if (stored) return stored;
    const now = Date.now();
    localStorage.setItem(LAST_SEEN_KEY, String(now));
    return now;
  } catch {
    return Date.now();
  }
}

interface WorkState {
  log: WorkLogEntry[];
  logLoaded: boolean;
  prsByRepo: Record<string, WorkPr[]>;
  /// Repos already asked about this session, so a re-render never re-asks.
  prsAsked: Record<string, true>;
  /// Where each record's branch stands in git, keyed `${repo}::${branch}`.
  branchStatus: Record<string, BranchStatus>;
  /// When each key was last asked — re-asked after a couple of minutes, so a
  /// push or a merge shows up without a restart.
  branchAskedAt: Record<string, number>;
  loadBranchStatus(items: Array<{ repo: string; branch: string; worktreePath?: string }>): Promise<void>;
  /// Branches named for each ticket key (upper case), across the place repos.
  ticketBranches: Record<string, RepoBranch[]>;
  ticketAskedAt: Record<string, number>;
  loadTicketBranches(repos: string[], keys: string[]): Promise<void>;
  query: string;
  selectedKey: string | null;
  promptHits: PromptHit[];
  /// The query `promptHits` answers — a stale answer is never shown.
  promptHitsFor: string;
  /// When you last looked at Work — the sidebar counts records finished since.
  lastSeenAt: number;
  /// The sidebar is on its Work tab (beside Places and Recent). Kept apart
  /// from the persisted Places/Recent layout, so leaving Work goes back to
  /// whichever of those you had.
  sidebarWork: boolean;
  setSidebarWork(on: boolean): void;
  loadLog(): Promise<void>;
  loadPrs(repoPaths: string[]): Promise<void>;
  setQuery(query: string): void;
  select(key: string | null): void;
  /// Show one record full width on the right.
  openRecord(key: string): void;
  markSeen(): void;
  /// Open the Work view, optionally already searching.
  open(query?: string): void;
}

let searchTimer: ReturnType<typeof setTimeout> | null = null;

export const useWorkStore = create<WorkState>((set, get) => ({
  log: [],
  logLoaded: false,
  prsByRepo: {},
  prsAsked: {},
  branchStatus: {},
  branchAskedAt: {},
  ticketBranches: {},
  ticketAskedAt: {},

  async loadTicketBranches(repos, keys) {
    const now = Date.now();
    const askedAt = get().ticketAskedAt;
    const fresh = keys.filter((k) => now - (askedAt[k] ?? 0) > 2 * 60_000);
    if (!fresh.length || !repos.length) return;
    set({ ticketAskedAt: { ...askedAt, ...Object.fromEntries(fresh.map((k) => [k, now])) } });
    try {
      const found = await window.overcli.invoke('work:ticketBranches', { repos, keys: fresh });
      // A key that matched nothing is still an answer: it stops being asked.
      set((s) => ({
        ticketBranches: { ...s.ticketBranches, ...Object.fromEntries(fresh.map((k) => [k, found[k] ?? []])) },
      }));
    } catch {
      // Not repos, or git missing — records go without ticket branches.
    }
  },

  async loadBranchStatus(items) {
    const now = Date.now();
    const askedAt = get().branchAskedAt;
    const fresh = items.filter((i) => now - (askedAt[`${i.repo}::${i.branch}`] ?? 0) > 2 * 60_000);
    if (!fresh.length) return;
    set({
      branchAskedAt: { ...askedAt, ...Object.fromEntries(fresh.map((i) => [`${i.repo}::${i.branch}`, now])) },
    });
    try {
      const statuses = await window.overcli.invoke('work:branchStatus', { items: fresh });
      set((s) => ({ branchStatus: { ...s.branchStatus, ...statuses } }));
    } catch {
      // Not a repo, or git missing — records just go without it.
    }
  },
  query: '',
  selectedKey: null,
  promptHits: [],
  promptHitsFor: '',
  lastSeenAt: readLastSeen(),
  sidebarWork: readSidebarWork(),

  setSidebarWork(on) {
    try {
      localStorage.setItem(SIDEBAR_KEY, String(on));
    } catch {
      // Forgetting the tab across launches is fine.
    }
    set({ sidebarWork: on });
  },

  async loadLog() {
    try {
      const log = await window.overcli.invoke('work:log');
      set({ log, logLoaded: true });
    } catch {
      set({ logLoaded: true });
    }
  },

  async loadPrs(repoPaths) {
    const asked = get().prsAsked;
    const fresh = repoPaths.filter((p) => !asked[p]);
    if (!fresh.length) return;
    set({ prsAsked: { ...asked, ...Object.fromEntries(fresh.map((p) => [p, true as const])) } });
    try {
      const prs = await window.overcli.invoke('work:prs', { repoPaths: fresh });
      set((s) => ({ prsByRepo: { ...s.prsByRepo, ...prs } }));
    } catch {
      // No gh, or not signed in: records just go without their PRs.
    }
  },

  setQuery(query) {
    set({ query });
    if (searchTimer) clearTimeout(searchTimer);
    const q = query.trim();
    if (q.length < 3) {
      set({ promptHits: [], promptHitsFor: '' });
      return;
    }
    searchTimer = setTimeout(async () => {
      try {
        const hits = await window.overcli.invoke('work:searchPrompts', { query: q });
        if (get().query.trim() === q) set({ promptHits: hits, promptHitsFor: q });
      } catch {
        // The typed-prompt search is a bonus; names and runs still match.
      }
    }, 250);
  },

  select(key) {
    set({ selectedKey: key });
  },

  openRecord(key) {
    set({ selectedKey: key });
    useStore.getState().setDetailMode('work');
  },

  markSeen() {
    const now = Date.now();
    try {
      localStorage.setItem(LAST_SEEN_KEY, String(now));
    } catch {
      // A badge that forgets is fine.
    }
    set({ lastSeenAt: now });
  },

  open(query) {
    if (query !== undefined) get().setQuery(query);
    get().setSidebarWork(true);
    set({ selectedKey: null });
    useStore.getState().setDetailMode('work');
  },
}));

/// Every place, with workspace member repos so a PR in any of them counts.
export function useWorkPlaces(): WorkPlace[] {
  const projects = useStore((s) => s.projects);
  const workspaces = useStore((s) => s.workspaces);
  return useMemo(() => {
    const byId = new Map(projects.map((p) => [p.id, p]));
    return [
      ...projects.map((p) => ({ path: p.path, name: p.name, conversations: p.conversations })),
      ...workspaces.map((w) => ({
        path: w.rootPath,
        name: w.name,
        memberPaths: w.projectIds.map((id) => byId.get(id)?.path).filter((p): p is string => !!p),
        conversations: w.conversations,
      })),
    ];
  }, [projects, workspaces]);
}

export function useWorkRecords(): WorkRecord[] {
  const places = useWorkPlaces();
  const runs = useFlowsStore((s) => s.runs);
  const orchestrations = useOrchestratorStore((s) => s.orchestrations);
  const log = useWorkStore((s) => s.log);
  const prsByRepo = useWorkStore((s) => s.prsByRepo);
  const branchStatus = useWorkStore((s) => s.branchStatus);
  const ticketBranches = useWorkStore((s) => s.ticketBranches);
  const teamTasks = useTeamsStore((s) => s.tasks);
  return useMemo(
    () =>
      buildWorkRecords({
        places,
        runs: Object.values(runs),
        log,
        orchestrations: Object.values(orchestrations),
        prsByRepo,
        branchStatus,
        ticketBranches,
        teamTasks,
      }),
    [places, runs, orchestrations, log, prsByRepo, branchStatus, ticketBranches, teamTasks],
  );
}

/// Ask GitHub about the repos with branched work, once each per session.
export function useLoadWorkPrs(records: WorkRecord[], places: WorkPlace[]): void {
  const loadPrs = useWorkStore((s) => s.loadPrs);
  const loadBranchStatus = useWorkStore((s) => s.loadBranchStatus);
  const repos = useMemo(() => reposWithBranches(records, places), [records, places]);
  // Every branched record's branch, in its place's repo — and in each member
  // of a workspace, since the branch lives in whichever one it was made in.
  const branchItems = useMemo(() => {
    const out = new Map<string, { repo: string; branch: string; worktreePath?: string }>();
    for (const r of records) {
      // A workspace run's member branches, and branches named for the ticket —
      // with the worktree when there is one, for its uncommitted changes.
      for (const rb of r.repoBranches) {
        const k = `${rb.repo}::${rb.branch}`;
        if (!out.get(k)?.worktreePath) out.set(k, { repo: rb.repo, branch: rb.branch, ...(rb.worktreePath ? { worktreePath: rb.worktreePath } : {}) });
      }
      if (!isWorkBranch(r.branch)) continue;
      const place = places.find((p) => p.path === r.placePath);
      for (const repo of [r.placePath, ...(place?.memberPaths ?? [])]) {
        out.set(`${repo}::${r.branch}`, { repo, branch: r.branch });
      }
    }
    return [...out.values()];
  }, [records, places]);
  // Ticket keys, per place: each place's repos are searched for its keys.
  const ticketAsks = useMemo(() => {
    const byPlace = new Map<string, { repos: string[]; keys: Set<string> }>();
    for (const r of records) {
      if (!r.ticket || !/^[A-Z]/.test(r.ticket)) continue;
      let entry = byPlace.get(r.placePath);
      if (!entry) {
        const place = places.find((p) => p.path === r.placePath);
        entry = { repos: place?.memberPaths?.length ? place.memberPaths : [r.placePath], keys: new Set() };
        byPlace.set(r.placePath, entry);
      }
      entry.keys.add(r.ticket);
    }
    return [...byPlace.values()].map((e) => ({ repos: e.repos, keys: [...e.keys].sort() }));
  }, [records, places]);
  const ticketKey = ticketAsks.map((a) => a.keys.join(',')).join('|');
  const loadTicketBranches = useWorkStore((s) => s.loadTicketBranches);
  useEffect(() => {
    for (const a of ticketAsks) void loadTicketBranches(a.repos, a.keys);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ticketKey, loadTicketBranches]);
  const branchKey = branchItems.map((i) => `${i.repo}::${i.branch}`).join('|');
  useEffect(() => {
    if (repos.length) void loadPrs(repos);
  }, [repos, loadPrs]);
  useEffect(() => {
    if (branchItems.length) void loadBranchStatus(branchItems);
    // Keyed on the set of branches, not the array: records rebuild whenever
    // a status lands, and that must not re-ask for the same branches.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [branchKey, loadBranchStatus]);
}

/// The repos worth asking GitHub about: ones with branched work in them.
export function reposWithBranches(records: WorkRecord[], places: WorkPlace[]): string[] {
  const out = new Set<string>();
  for (const r of records) {
    if (!isWorkBranch(r.branch)) continue;
    const place = places.find((p) => p.path === r.placePath);
    out.add(r.placePath);
    for (const m of place?.memberPaths ?? []) out.add(m);
  }
  return [...out];
}

/// Work that finished today — shipped, done or failed. Chats finish nothing,
/// and a record still running hasn't finished yet.
export function useWorkDoneToday(): number {
  const records = useWorkRecords();
  return useMemo(() => {
    const now = new Date();
    const start = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    return records.filter((r) => r.kind !== 'chat' && r.status !== 'running' && r.updatedAt >= start).length;
  }, [records]);
}

/// Finished since you last looked: shipped, done, or failed — not chats,
/// which finish nothing.
export function useNewWorkCount(): number {
  const records = useWorkRecords();
  const lastSeenAt = useWorkStore((s) => s.lastSeenAt);
  return useMemo(
    () =>
      records.filter((r) => r.kind !== 'chat' && r.status !== 'running' && r.updatedAt > lastSeenAt).length,
    [records, lastSeenAt],
  );
}
