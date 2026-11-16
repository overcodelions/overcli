// The Org tab's state: the org servers this app is signed in to, each one's
// workers and what waits on you there, and which worker is open.
//
// Every call goes through main (`org:call`), which holds the tokens and only
// lets the tab's own list of console routes through (org/orgTabRoutes.ts).
// Each server is asked on its own: one that can't be reached shows its error
// and the others carry on.

import { useEffect, useState } from 'react';
import { create } from 'zustand';
import type { OrgServerStatus } from '@shared/types';

export type OrgWorkerState = 'working' | 'waiting' | 'paused' | 'stuck' | 'idle';

/// A worker as the server's /api/workers lists it (OrgService.WorkerSummary);
/// only what the tab reads.
export interface OrgWorker {
  id: string;
  name: string;
  tagline: string;
  enabled: boolean;
  trust: 'probation' | 'trusted' | 'autonomous';
  manager?: string;
  reportsTo?: { id: string; name: string };
  visibility: 'private' | 'team' | 'org';
  avatarUrl?: string;
  budgetUSDPerMonth: number;
  spentThisMonthUSD: number;
  month: { runs: number; failed: number; pullRequests: number };
  last30: { jobs: number; failed: number; prior: number; lastRun?: { at: number; outcome: 'done' | 'failed' | 'stopped' } };
  waiting: number;
  youManage: boolean;
  /// One of the caller's own (they manage it, not merely as an admin). Older
  /// servers don't send it; `youManage` stands in.
  yours?: boolean;
  state: OrgWorkerState;
  schedule: string;
  nextRunAt?: number | null;
  tools?: Array<{ name: string; ok: boolean }>;
  place?: { kind: 'repo' | 'workspace' | 'folder'; name: string; repos?: string[] };
}

/// A question or approval waiting on you (OrgService.WaitingItem).
export interface OrgWaiting {
  runId: string;
  runNumber?: number;
  workerId: string;
  workerName: string;
  kind: 'question' | 'approval';
  title: string;
  stepId: string;
  question?: string;
  why?: string;
  since: number;
  options?: string[];
  instructions?: string;
  reaches?: string[];
  coversLater?: number;
}

/// Work a worker on probation proposed, waiting for you (OrgService.ProposalBatch).
export interface OrgProposal {
  batchId: string;
  workerId: string;
  workerName: string;
  at: number;
  task: 'shift' | 'errand';
  items: Array<{ candidateId: string; title: string; detail?: string; size?: string }>;
}

/// A task a worker handed to this person's desktop (server desktopTasks.ts).
export interface OrgDesktopTask {
  id: string;
  workerId: string;
  workerName: string;
  task: string;
  kind: 'browser' | 'design' | 'other';
  at: number;
  status: 'waiting' | 'claimed';
}

export interface OrgSelection {
  serverId: string;
  workerId: string;
  /// A run of that worker, open in the run reader.
  runId?: string;
  /// The tab its page opens on (Tuning, Settings…), when not Conversation.
  tab?: 'talk' | 'runs' | 'settings' | 'tuning' | 'journal';
}

/// Finished work (OrgService.WorkItem): rateable by its entryId.
export interface OrgWorkItem {
  entryId: string;
  workerId: string;
  workerName: string;
  title: string;
  summary?: string;
  at: number;
  costUSD?: number;
  runId?: string;
  rating?: { useful: boolean; by: string; note?: string };
}

/// The server's own summary of the caller's day (OrgService.TodayView).
export interface OrgToday {
  org: string;
  delivered: OrgWorkItem[];
  crew: Array<{ id: string; name: string; state: OrgWorkerState; nextShiftAt?: number | null; spentUSD?: number; budgetUSDPerMonth?: number }>;
  spend: { spentUSD: number; projectedUSD: number; allowanceUSD?: number; committedUSD?: number };
  toolTrouble?: Array<{ name: string; detail?: string }>;
}

/// Something moving now (the console's /api/inflight): a run or a team task.
export interface OrgInFlight {
  kind: string;
  id: string;
  workerId?: string;
  title: string;
  who: string;
  total: number;
  at: number;
  now: string;
  since: number;
  needsYou?: boolean;
}

/// A worker's recent run grades and verdict (from /tuning), for its card.
export interface OrgWorkerTrend {
  runs: Array<'good' | 'rough' | 'failed' | 'running'>;
  verdict: 'better' | 'same' | 'worse' | 'waiting' | 'early';
  open: number;
  at: number;
}

type CallResult = { ok: true; data: any } | { ok: false; error: string; status?: number; signIn?: true };

/// One call to one server's console API, through main.
export function orgCall(serverId: string, method: 'GET' | 'POST', path: string, body?: unknown): Promise<CallResult> {
  return window.overcli.invoke('org:call', { serverId, method, path, ...(body !== undefined ? { body } : {}) });
}

export const enc = encodeURIComponent;

export interface OrgDirectory {
  people: Array<{ name: string; slackUserId: string }>;
  groups: Array<{ id: string; name: string }>;
  /// Roles an audience can name: admins, hire approvers, people who can hire.
  roles: Array<{ id: string; name: string }>;
  /// Slack id to name.
  names: Map<string, string>;
}
const EMPTY_DIRECTORY: OrgDirectory = { people: [], groups: [], roles: [], names: new Map() };
const directories = new Map<string, Promise<OrgDirectory>>();

/// The org's people and groups, once per server: for names in place of
/// Slack ids, and for picking who can ask a worker. A failed read isn't
/// kept, so the next page to open asks again.
export function useDirectoryData(serverId: string): OrgDirectory {
  const [dir, setDir] = useState<OrgDirectory>(EMPTY_DIRECTORY);
  useEffect(() => {
    let live = true;
    if (!directories.has(serverId)) {
      directories.set(
        serverId,
        orgCall(serverId, 'GET', '/api/directory').then((res) => {
          if (!res.ok) {
            directories.delete(serverId);
            return EMPTY_DIRECTORY;
          }
          const d = res.data as { people?: Array<{ name?: string; slackUserId?: string }>; groups?: Array<{ id?: string; name?: string }>; roles?: Array<{ id?: string; name?: string }> };
          const people = (d.people ?? []).filter((p): p is { name: string; slackUserId: string } => !!p.slackUserId && !!p.name);
          const groups = (d.groups ?? []).filter((g): g is { id: string; name: string } => !!g.id && !!g.name);
          const roles = (d.roles ?? []).filter((r): r is { id: string; name: string } => !!r.id && !!r.name);
          return { people: [...people].sort((a, b) => a.name.localeCompare(b.name)), groups, roles, names: new Map(people.map((p) => [p.slackUserId, p.name])) };
        }),
      );
    }
    void directories.get(serverId)!.then((x) => live && setDir(x));
    return () => {
      live = false;
    };
  }, [serverId]);
  return dir;
}

const pictures = new Map<string, Promise<string | null>>();

/// A worker's picture as the window may show it (fetched in main from the
/// picture services the server uses), or null for initials.
export function usePicture(url: string | undefined): string | null {
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    setSrc(null);
    if (!url) return;
    let live = true;
    if (!pictures.has(url)) pictures.set(url, window.overcli.invoke('org:picture', url).catch(() => null));
    void pictures.get(url)!.then((s) => live && setSrc(s));
    return () => {
      live = false;
    };
  }, [url]);
  return src;
}

interface OrgTabState {
  servers: OrgServerStatus[];
  loaded: boolean;
  loading: boolean;
  /// A server id, or 'all'.
  filter: string;
  workers: Record<string, OrgWorker[]>;
  waiting: Record<string, OrgWaiting[]>;
  proposals: Record<string, OrgProposal[]>;
  desktop: Record<string, OrgDesktopTask[]>;
  today: Record<string, OrgToday>;
  inflight: Record<string, OrgInFlight[]>;
  work: Record<string, OrgWorkItem[]>;
  /// `${serverId}/${workerId}`: loaded lazily, kept a few minutes.
  trends: Record<string, OrgWorkerTrend>;
  loadTrends(serverId: string, workerIds: string[]): Promise<void>;
  errors: Record<string, string>;
  selected: OrgSelection | null;
  refreshedAt: number | null;
  refresh(): Promise<void>;
  setFilter(filter: string): void;
  select(selection: OrgSelection | null): void;
}

let inFlight: Promise<void> | null = null;

export const useOrgTab = create<OrgTabState>((set, get) => ({
  servers: [],
  loaded: false,
  loading: false,
  filter: 'all',
  workers: {},
  waiting: {},
  proposals: {},
  desktop: {},
  today: {},
  inflight: {},
  work: {},
  trends: {},
  errors: {},
  selected: null,
  refreshedAt: null,

  refresh() {
    // One refresh at a time: focus, the minute timer and a button press can
    // all land together.
    if (inFlight) return inFlight;
    set({ loading: true });
    inFlight = (async () => {
      const servers: OrgServerStatus[] = await window.overcli.invoke('org:servers').catch(() => []);
      const workers: Record<string, OrgWorker[]> = {};
      const waiting: Record<string, OrgWaiting[]> = {};
      const proposals: Record<string, OrgProposal[]> = {};
      const desktop: Record<string, OrgDesktopTask[]> = {};
      const today: Record<string, OrgToday> = {};
      const inflight: Record<string, OrgInFlight[]> = {};
      const work: Record<string, OrgWorkItem[]> = {};
      const errors: Record<string, string> = {};
      await Promise.all(
        servers.map(async (s) => {
          if (!s.tokenConfigured) {
            errors[s.id] = 'Signed out. Sign in again under Settings → Your orgs.';
            return;
          }
          const [w, q, p] = await Promise.all([orgCall(s.id, 'GET', '/api/workers'), orgCall(s.id, 'GET', '/api/waiting'), orgCall(s.id, 'GET', '/api/proposals')]);
          if (p.ok && Array.isArray(p.data)) proposals[s.id] = (p.data as OrgProposal[]).filter((b) => b.items?.length);
          const [td, fl, wk] = await Promise.all([orgCall(s.id, 'GET', '/api/today'), orgCall(s.id, 'GET', '/api/inflight'), orgCall(s.id, 'GET', '/api/work?days=14')]);
          if (td.ok) today[s.id] = td.data as OrgToday;
          if (fl.ok) {
            const d = fl.data as { items?: OrgInFlight[] } | OrgInFlight[];
            inflight[s.id] = (Array.isArray(d) ? d : d.items ?? []).filter((x) => x && typeof x.title === 'string');
          }
          if (wk.ok) {
            const d = wk.data as { items?: OrgWorkItem[] } | OrgWorkItem[];
            work[s.id] = Array.isArray(d) ? d : d.items ?? [];
          }
          if (s.takesWork) {
            const d = await orgCall(s.id, 'GET', '/api/desktop/tasks');
            if (d.ok) desktop[s.id] = ((d.data as { tasks?: OrgDesktopTask[] }).tasks ?? []);
          }
          if (w.ok && Array.isArray(w.data)) workers[s.id] = w.data as OrgWorker[];
          else errors[s.id] = w.ok ? 'The server sent something unexpected.' : w.error;
          if (q.ok && Array.isArray(q.data)) waiting[s.id] = q.data as OrgWaiting[];
        }),
      );
      const { filter, selected } = get();
      set({
        servers,
        workers,
        waiting,
        proposals,
        desktop,
        today,
        inflight,
        work,
        errors,
        loaded: true,
        loading: false,
        refreshedAt: Date.now(),
        // A server that went away takes its filter and selection with it.
        filter: filter === 'all' || servers.some((s) => s.id === filter) ? filter : 'all',
        selected: selected && servers.some((s) => s.id === selected.serverId) ? selected : null,
      });
    })().finally(() => {
      inFlight = null;
      set({ loading: false });
    });
    return inFlight;
  },

  async loadTrends(serverId, workerIds) {
    const fresh = Date.now() - 5 * 60_000;
    const want = workerIds.filter((id) => (get().trends[`${serverId}/${id}`]?.at ?? 0) < fresh);
    // A few at a time: a card's strip can wait; the rest of the page can't.
    for (let i = 0; i < want.length; i += 4) {
      const got = await Promise.all(
        want.slice(i, i + 4).map(async (id) => {
          const r = await orgCall(serverId, 'GET', `/api/workers/${enc(id)}/tuning`);
          if (!r.ok) return null;
          const t = r.data as { score?: { runs?: Array<{ result: OrgWorkerTrend['runs'][number] }>; verdict?: { kind: OrgWorkerTrend['verdict'] } }; reviews?: Array<{ suggestions?: Array<{ state?: string }> }> };
          const trend: OrgWorkerTrend = {
            runs: (t.score?.runs ?? []).slice(0, 12).map((x) => x.result).reverse(),
            verdict: t.score?.verdict?.kind ?? 'early',
            open: (t.reviews ?? []).reduce((n, rv) => n + (rv.suggestions ?? []).filter((x) => !x.state).length, 0),
            at: Date.now(),
          };
          return [`${serverId}/${id}`, trend] as [string, OrgWorkerTrend];
        }),
      );
      set({ trends: { ...get().trends, ...Object.fromEntries(got.filter((x): x is [string, OrgWorkerTrend] => !!x)) } });
    }
  },

  setFilter(filter) {
    set({ filter });
  },

  select(selected) {
    set({ selected });
  },
}));

/// "3m ago", "2h ago", "yesterday", "12 Nov".
export function ago(at: number, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - at) / 1000));
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86_400) return `${Math.round(s / 3600)}h ago`;
  if (s < 2 * 86_400) return 'yesterday';
  if (s < 7 * 86_400) return `${Math.round(s / 86_400)}d ago`;
  return new Date(at).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
}

export function money(usd: number): string {
  return usd >= 100 ? `$${Math.round(usd)}` : `$${usd.toFixed(2)}`;
}

export const STATE_LABEL: Record<OrgWorkerState, string> = {
  working: 'Working',
  waiting: 'Waiting on someone',
  paused: 'Paused',
  stuck: 'Stuck',
  idle: 'Idle',
};

export const STATE_DOT: Record<OrgWorkerState, string> = {
  working: 'bg-accent animate-pulse',
  waiting: 'bg-amber-400',
  paused: 'bg-ink-faint',
  stuck: 'bg-red-400',
  idle: 'bg-emerald-400',
};

export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  return ((parts[0]?.[0] ?? '?') + (parts[1]?.[0] ?? '')).toUpperCase();
}

// ---- YOURS AND SHARED --------------------------------------------------------

/// One of the person's own workers, rather than one shared with them.
export function isYours(w: OrgWorker): boolean {
  return w.yours ?? w.youManage;
}

/// What the workers that aren't yours are called: shared with you, or (for
/// an admin, who can change them all) simply everyone else's.
export function othersLabel(others: OrgWorker[]): string {
  return others.length && others.every((w) => w.youManage) ? 'Everyone else’s' : 'Shared with you';
}

/// Whether a list of others' workers is open: remembered per place, and
/// closed to begin with when it is long and there are workers of your own.
export function useOthersOpen(key: string, count: number, haveOwn: boolean): [boolean, () => void] {
  const storeKey = `overcli.org.others.${key}`;
  const [saved, setSaved] = useState<boolean | null>(() => {
    try {
      const v = localStorage.getItem(storeKey);
      return v === null ? null : v === '1';
    } catch {
      return null;
    }
  });
  const open = saved ?? !(haveOwn && count > OTHERS_OPEN_UP_TO);
  return [
    open,
    () => {
      setSaved(!open);
      try {
        localStorage.setItem(storeKey, open ? '0' : '1');
      } catch {
        /* a private window: remembered for this visit only */
      }
    },
  ];
}

/// Shared workers shown open by default, up to this many.
export const OTHERS_OPEN_UP_TO = 8;
