// One org worker, on the Org tab: a conversation first.
//
// The header says who it is and what state it's in, with Run now and Pause.
// Conversation is what you asked it and what it answered (formatted, not raw
// markdown), anything it needs from you on top, and a box to ask it more.
// Runs open into a reader: the answer as a document, the steps as a
// timeline, and a follow-up in the same thread. Settings and Journal manage
// it in place. A sidebar keeps what it's doing, this month, recent runs and
// its tools in view. Everything goes to the server it lives on, and the
// server decides who may do what.

import { useEffect, useMemo, useRef, useState } from 'react';
import type { OrgServerStatus } from '@shared/types';
import { Markdown } from '../../Markdown';
import { ago, enc, initials, money, orgCall, STATE_DOT, STATE_LABEL, useDirectoryData, useOrgTab, type OrgProposal, type OrgWaiting, type OrgWorker } from './orgTabStore';
import { OrgWorkerSettings, type SettingsDetail } from './OrgWorkerSettings';
import { OrgWorkerTuning } from './OrgWorkerTuning';
import { DesktopTaskCard } from './DesktopTaskCard';
import { Face, ProposalCard, WaitingCard } from './OrgPane';

// ---- shapes the server sends (OrgService) ----------------------------------

interface RunNow {
  runId: string;
  runNumber?: number;
  title: string;
  startedAt: number;
  step: { index: number; total: number; name: string };
  state: 'working' | 'question' | 'approval' | 'interrupted' | 'paused';
  costUSD?: number;
}
interface RunPast {
  runId: string;
  runNumber?: number;
  title: string;
  at: number;
  minutes: number;
  outcome: 'done' | 'failed' | 'stopped';
  costUSD?: number;
  error?: string;
  pullRequests?: Array<{ repo?: string; url: string }>;
}
interface Ask {
  id: string;
  by: string;
  text: string;
  at: number;
  status: 'working' | 'answered' | 'failed';
  via?: string;
  reply?: string;
  choices?: string[];
  error?: string;
  doneAt?: number;
  /// The server's own follow-up once work the worker sent off finished: not
  /// someone speaking, the second half of the worker's answer.
  handedBack?: boolean;
  /// For a Slack message that set it off: who wrote it, and where.
  from?: { slackUserId?: string; where?: string };
}
type Cadence = { kind: 'daily'; time: string; days?: number[] } | { kind: 'interval'; everyMinutes: number } | null;
interface DetailWorker extends OrgWorker {
  cadence?: Cadence;
  anyoneMayStart?: boolean;
  continueOpenPrs?: boolean;
  skipCheckpoints?: boolean;
  audience?: unknown;
  tools?: Array<{ name: string; ok: boolean; scope?: { mode: string } }>;
}
interface Detail {
  worker: DetailWorker;
  jobDescription: string;
  stats: { runs: number; failed: number; rated: number; usefulPct: number | null };
  now: RunNow[];
  deciding: { since: number; task: 'shift' | 'errand' } | null;
  history: RunPast[];
  waiting: OrgWaiting[];
  asks: Ask[];
  missingTools: string[];
  toolProblems?: string[];
}

type Tab = 'talk' | 'runs' | 'settings' | 'tuning' | 'journal';

const card = 'rounded-xl border border-card bg-card';
const label = 'text-[11px] uppercase tracking-wider text-ink-faint';
const btn = 'inline-flex min-h-[34px] items-center gap-1.5 rounded-lg border border-card-strong bg-surface px-3 py-1.5 text-xs font-medium text-ink hover:bg-card-strong disabled:opacity-50';
const primary = 'inline-flex min-h-[34px] items-center gap-1.5 rounded-lg bg-accent px-3.5 py-1.5 text-xs font-semibold text-white disabled:opacity-50';

export function OrgWorkerPage({ serverId, workerId, runId, initialTab }: { serverId: string; workerId: string; runId?: string; initialTab?: Tab }) {
  const select = useOrgTab((s) => s.select);
  const server = useOrgTab((s) => s.servers.find((x) => x.id === serverId));
  // The store's own list, filtered here: a selector that built a new array
  // each time would re-render forever.
  const serverProposals = useOrgTab((s) => s.proposals[serverId]);
  const proposals = useMemo(() => (serverProposals ?? []).filter((p) => p.workerId === workerId), [serverProposals, workerId]);
  const refreshAll = useOrgTab((s) => s.refresh);
  const refreshedAt = useOrgTab((s) => s.refreshedAt);
  const [detail, setDetail] = useState<Detail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>(initialTab ?? 'talk');
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  // The header stays at the top as the page scrolls, and the sidebar sits
  // pinned just under it: its height, measured, is where the sidebar starts.
  const head = useRef<HTMLElement>(null);
  const [headH, setHeadH] = useState(0);
  useEffect(() => {
    const el = head.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => setHeadH(el.offsetHeight));
    ro.observe(el);
    setHeadH(el.offsetHeight);
    return () => ro.disconnect();
  });

  const load = () =>
    orgCall(serverId, 'GET', `/api/workers/${enc(workerId)}/detail`).then((res) => {
      if (res.ok) {
        setDetail(res.data as Detail);
        setError(null);
      } else setError(res.error);
    });
  useEffect(() => {
    void load();
  }, [serverId, workerId, refreshedAt]);

  const act = (path: string, body: unknown, done: string) => {
    setBusy(true);
    setNote(null);
    void orgCall(serverId, 'POST', path, body).then((res) => {
      setBusy(false);
      setNote(res.ok ? done : res.error);
      void load();
      void refreshAll();
    });
  };
  const openRun = (id: string | null) => select({ serverId, workerId, ...(id ? { runId: id } : {}) });

  if (!detail || !server) {
    return (
      <div className="flex min-h-0 flex-1 flex-col px-8 pt-6">
        <Crumbs server={server} name={null} onOrg={() => select(null)} />
        {error ? <div role="alert" className="mt-6 text-sm text-red-600 dark:text-red-300">{error}</div> : <div className="mt-6 text-sm text-ink-muted">Opening…</div>}
      </div>
    );
  }
  const w = detail.worker;

  if (runId) {
    return (
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
        <div className="px-8 pt-5">
          <Crumbs server={server} name={w.name} onOrg={() => select(null)} onWorker={() => openRun(null)} run={runId} history={detail.history} />
        </div>
        <RunPage key={runId} server={server} worker={w} runId={runId} past={detail.history.find((r) => r.runId === runId)} onChanged={() => void load()} onTuning={() => { openRun(null); setTab('tuning'); }} />
      </div>
    );
  }

  const tabs: Array<{ id: Tab; label: string; count?: string }> = [
    { id: 'talk', label: 'Conversation' },
    { id: 'runs', label: 'Runs', count: String(detail.history.length + detail.now.length) },
    { id: 'settings', label: 'Settings' },
    { id: 'tuning', label: 'Tuning' },
    { id: 'journal', label: 'Journal' },
  ];

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
      <header ref={head} className="sticky top-0 z-20 border-b border-card bg-surface px-8 pt-5">
        <Crumbs server={server} name={w.name} onOrg={() => select(null)} />
        <div className="mt-4 flex flex-wrap items-center gap-4">
          <Face worker={w} size={56} square />
          <div className="min-w-[240px] flex-1">
            <h1 className="m-0 text-2xl font-semibold tracking-tight text-ink">{w.name}</h1>
            {w.tagline && <div className="mt-0.5 text-sm text-ink-muted">{w.tagline}</div>}
            <div className="mt-2.5 flex flex-wrap gap-1.5">
              <Pill tone={w.state === 'idle' ? 'green' : w.state === 'waiting' ? 'amber' : w.state === 'stuck' ? 'red' : w.state === 'working' ? 'accent' : 'plain'}>{STATE_LABEL[w.state]}</Pill>
              <Pill>{w.trust === 'probation' ? 'On probation' : w.trust === 'trusted' ? 'Trusted' : 'Autonomous'}</Pill>
              <Pill>{w.schedule}</Pill>
              {w.manager && <Pill>Managed by {w.manager}</Pill>}
              {!w.youManage && <Pill>You can ask it; changes are its manager’s</Pill>}
            </div>
          </div>
          {w.youManage && (
            <div className="flex flex-wrap gap-2">
              <button disabled={busy || !w.enabled} className={btn} onClick={() => act(`/api/workers/${enc(w.id)}/run`, {}, w.trust === 'probation' ? 'Started. On probation, it proposes its work for you to approve.' : 'Started a run now.')}>
                <Icon d="M6 4l14 8-14 8z" /> Run now
              </button>
              <button disabled={busy} className={btn} onClick={() => act(`/api/workers/${enc(w.id)}/paused`, { paused: w.enabled }, w.enabled ? 'Paused: no shifts, no errands.' : 'Resumed.')}>
                <Icon d={w.enabled ? 'M8 5v14M16 5v14' : 'M6 4l14 8-14 8z'} /> {w.enabled ? 'Pause' : 'Resume'}
              </button>
            </div>
          )}
        </div>
        {note && <div role="status" className="mt-3 text-xs text-ink-muted">{note}</div>}
        <div role="tablist" className="mt-5 flex gap-6">
          {tabs.map((t) => (
            <button key={t.id} role="tab" aria-selected={tab === t.id} onClick={() => setTab(t.id)} className={'-mb-px border-b-2 pb-3 text-sm ' + (tab === t.id ? 'border-accent font-semibold text-ink' : 'border-transparent text-ink-muted hover:text-ink')}>
              {t.label}
              {t.count ? <span className="ml-1.5 font-normal text-ink-faint">{t.count}</span> : null}
            </button>
          ))}
        </div>
      </header>

      <div className="flex flex-wrap items-start gap-7 px-8 pb-10 pt-6">
        <section className="min-w-0 flex-[999_1_520px]">
          {tab === 'talk' && <Conversation server={server} worker={w} detail={detail} proposals={proposals} onChanged={() => void load()} onOpenRun={openRun} onTuning={() => setTab('tuning')} />}
          {tab === 'runs' && <RunsList detail={detail} onOpen={openRun} />}
          {tab === 'settings' && <OrgWorkerSettings server={server} detail={detail as unknown as SettingsDetail} top={headH} onChanged={() => { void load(); void refreshAll(); }} />}
          {tab === 'tuning' && <OrgWorkerTuning server={server} worker={w} job={detail.jobDescription} can={w.youManage} onOpenRun={openRun} onChanged={() => void load()} />}
          {tab === 'journal' && <JournalTab serverId={serverId} worker={w} />}
        </section>
        {tab !== 'settings' && <Sidebar worker={w} detail={detail} onOpen={openRun} onAllRuns={() => setTab('runs')} top={headH} />}
      </div>
    </div>
  );
}

// ---- pieces --------------------------------------------------------------

function Crumbs({ server, name, onOrg, onWorker, run, history }: { server?: OrgServerStatus; name: string | null; onOrg: () => void; onWorker?: () => void; run?: string; history?: RunPast[] }) {
  const n = run ? history?.find((r) => r.runId === run)?.runNumber : undefined;
  return (
    <nav aria-label="Where you are" className="flex flex-wrap items-center gap-1.5 text-xs text-ink-faint">
      <button onClick={onOrg} className="hover:text-ink">Org</button>
      {server && <><span aria-hidden="true">/</span><span>{server.name ?? server.url}</span></>}
      {name && (
        <>
          <span aria-hidden="true">/</span>
          {onWorker ? <button onClick={onWorker} className="hover:text-ink">{name}</button> : <span className="text-ink-muted">{name}</span>}
        </>
      )}
      {run && <><span aria-hidden="true">/</span><span className="text-ink-muted">{n ? `Run #${n}` : 'Run'}</span></>}
    </nav>
  );
}

function Pill({ children, tone = 'plain' }: { children: React.ReactNode; tone?: 'plain' | 'green' | 'amber' | 'red' | 'accent' }) {
  const tones = {
    plain: 'bg-card-strong text-ink-muted',
    green: 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300',
    amber: 'bg-amber-500/15 text-amber-700 dark:text-amber-300',
    red: 'bg-red-500/15 text-red-700 dark:text-red-300',
    accent: 'bg-accent/15 text-ink',
  };
  return <span className={'rounded-full px-2.5 py-0.5 text-[11px] font-medium ' + tones[tone]}>{children}</span>;
}

function Icon({ d, size = 14 }: { d: string; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={d} />
    </svg>
  );
}

function Me({ server }: { server: OrgServerStatus }) {
  return <span className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full bg-card-strong text-xs font-semibold text-ink">{initials(server.me?.name ?? 'You')}</span>;
}

// ---- Conversation: threads -------------------------------------------------

const POLL_MS = 3000;
const POLL_LIMIT_MS = 6 * 60_000;

type Stage = 'deciding' | 'waiting' | 'running' | 'needsYou' | 'done' | 'answered' | 'nothing' | 'declined' | 'failed' | 'stopped';
interface ThreadRun {
  runId: string;
  title: string;
  state: string;
  startedAt: number;
  costUSD?: number;
  summary?: string;
}
export interface Thread {
  id: string;
  at: number;
  lastAt: number;
  source: 'ask' | 'runNow' | 'schedule' | 'trigger' | 'colleague' | 'followUp' | 'run';
  prompt: string;
  by?: string;
  via?: string;
  stage: Stage;
  headline: string;
  reply?: { text: string; at: number; tookMs?: number };
  proposal?: { batchId: string; waiting: boolean; items: Array<{ candidateId: string; title: string; status: string }> };
  runs: ThreadRun[];
  costUSD: number;
  error?: string;
  choices?: string[];
  followUps?: Thread[];
}

const STAGE: Record<Stage, { label: string; tone: 'plain' | 'green' | 'amber' | 'red' | 'accent' }> = {
  deciding: { label: 'Deciding', tone: 'accent' },
  waiting: { label: 'Queued', tone: 'plain' },
  running: { label: 'Working', tone: 'accent' },
  needsYou: { label: 'Needs you', tone: 'amber' },
  done: { label: 'Done', tone: 'green' },
  answered: { label: 'Answered', tone: 'green' },
  nothing: { label: 'Nothing to do', tone: 'plain' },
  declined: { label: 'Declined', tone: 'plain' },
  failed: { label: 'Failed', tone: 'red' },
  stopped: { label: 'Stopped', tone: 'plain' },
};

/// Who started a thread, and where, as it should read. A Slack message that
/// set the worker off is found in the asks by the thread's id (`ask:<id>`),
/// whose stored brief carries the message's author.
function startedBy(t: Thread, asks: Map<string, Ask>, names: Map<string, string>, server: OrgServerStatus): { who: string; where: string } {
  const ask = t.id.startsWith('ask:') ? asks.get(t.id.slice(4)) : undefined;
  if (ask) {
    const where = ask.via === 'trigger' ? (ask.from?.where ? `in ${ask.from.where}` : said(ask.text).where ?? 'from a trigger') : ask.via === 'slack' ? 'in Slack' : ask.via === 'mcp' ? 'from a chat' : 'in overcli';
    return { who: asker(ask, names, server), where };
  }
  if (t.source === 'schedule') return { who: 'On its schedule', where: '' };
  if (t.source === 'runNow') return { who: t.by && t.by === server.me?.name ? 'You' : t.by ?? 'Someone', where: 'pressed Run now' };
  if (t.source === 'trigger') return { who: 'A trigger', where: '' };
  if (t.source === 'colleague') return { who: t.by ?? 'A colleague', where: 'another worker' };
  return { who: t.by === server.me?.name ? 'You' : t.by ?? 'Someone', where: t.via === 'slack' ? 'in Slack' : '' };
}

function startedInSlack(t: Thread, asks: Map<string, Ask>): boolean {
  const ask = t.id.startsWith('ask:') ? asks.get(t.id.slice(4)) : undefined;
  return ask?.via === 'slack' || ask?.via === 'trigger' || t.via === 'slack';
}

/// A part of a thread the server added itself, to finish an answer once the
/// work behind it was done: shown as the worker's answer, never as someone
/// speaking.
function handedBack(t: Thread, asks: Map<string, Ask>): boolean {
  return t.id.startsWith('ask:') && asks.get(t.id.slice(4))?.handedBack === true;
}

/// The thread's newest word from the worker: the latest reply's, or its own.
function latest(t: Thread): Thread {
  return t.followUps?.length ? t.followUps[t.followUps.length - 1] : t;
}

/// A line of markdown as plain words, for a card's preview.
function plain(md: string): string {
  return md.replace(/```[\s\S]*?```/g, ' ').replace(/[*_`#>]+/g, '').replace(/\[([^\]]+)\]\([^)]+\)/g, '$1').replace(/\s+/g, ' ').trim();
}

/// Send a question (or a reply in a thread), then follow it until answered.
function useAsk(server: OrgServerStatus, worker: DetailWorker, onChanged: () => void) {
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<Array<{ askId: string; text: string; replyTo?: string }>>([]);
  const timers = useRef<number[]>([]);
  useEffect(() => () => timers.current.forEach((t) => window.clearTimeout(t)), []);
  const ask = (text: string, replyTo?: string): Promise<boolean> => {
    const message = text.trim();
    if (!message) return Promise.resolve(false);
    setSending(true);
    setError(null);
    return orgCall(server.id, 'POST', '/api/ask', { worker: worker.id, message, ...(replyTo ? { replyTo } : {}) }).then((res) => {
      setSending(false);
      if (!res.ok) {
        setError(res.error);
        return false;
      }
      const askId = String((res.data as { askId?: string }).askId ?? '');
      setPending((p) => [...p, { askId, text: message, ...(replyTo ? { replyTo } : {}) }]);
      const started = Date.now();
      const poll = () => {
        void orgCall(server.id, 'GET', `/api/asks/${enc(askId)}`).then((r) => {
          const status = r.ok ? (r.data as { ask?: Ask }).ask?.status : undefined;
          if (status && status !== 'working') {
            setPending((p) => p.filter((x) => x.askId !== askId));
            onChanged();
          } else if (Date.now() - started < POLL_LIMIT_MS) timers.current.push(window.setTimeout(poll, POLL_MS));
          else setPending((p) => p.filter((x) => x.askId !== askId));
        });
      };
      timers.current.push(window.setTimeout(poll, POLL_MS));
      onChanged();
      return true;
    });
  };
  return { ask, sending, error, pending };
}

function Conversation({ server, worker, detail, proposals, onChanged, onOpenRun, onTuning }: { server: OrgServerStatus; worker: DetailWorker; detail: Detail; proposals: OrgProposal[]; onChanged: () => void; onOpenRun: (runId: string) => void; onTuning: () => void }) {
  const refreshedAt = useOrgTab((s) => s.refreshedAt);
  const names = useDirectory(server.id);
  const [threads, setThreads] = useState<Thread[] | null>(null);
  const [older, setOlder] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const asks = useMemo(() => new Map(detail.asks.map((a) => [a.id, a])), [detail.asks]);
  const serverDesk = useOrgTab((s) => s.desktop[server.id]);
  const deskTasks = useMemo(() => (serverDesk ?? []).filter((t) => t.workerId === worker.id), [serverDesk, worker.id]);

  const load = () =>
    orgCall(server.id, 'GET', `/api/workers/${enc(worker.id)}/threads?limit=30`).then((res) => {
      if (!res.ok) return setError(res.error);
      const d = res.data as { threads: Thread[]; nextBefore: number | null };
      setThreads(d.threads ?? []);
      setOlder(d.nextBefore);
      setError(null);
    });
  const loadOlder = () => {
    if (older == null) return;
    void orgCall(server.id, 'GET', `/api/workers/${enc(worker.id)}/threads?limit=30&before=${older}`).then((res) => {
      if (!res.ok) return setError(res.error);
      const d = res.data as { threads: Thread[]; nextBefore: number | null };
      setThreads((t) => [...(t ?? []), ...(d.threads ?? [])]);
      setOlder(d.nextBefore);
    });
  };
  useEffect(() => {
    void load();
  }, [server.id, worker.id, refreshedAt]);
  const changed = () => {
    void load();
    onChanged();
  };
  const { ask, sending, error: askError, pending } = useAsk(server, worker, changed);

  const thread = open ? threads?.find((t) => t.id === open) : undefined;
  if (open && thread) {
    return (
      <ThreadView
        server={server}
        worker={worker}
        thread={thread}
        asks={asks}
        names={names}
        waiting={detail.waiting.filter((w) => [thread, ...(thread.followUps ?? [])].some((t) => t.runs.some((r) => r.runId === w.runId)))}
        pending={pending.filter((p) => p.replyTo === thread.id)}
        sending={sending}
        error={askError}
        onBack={() => setOpen(null)}
        onReply={(text) => ask(text, thread.id)}
        onChanged={changed}
        onOpenRun={onOpenRun}
        onTuning={onTuning}
      />
    );
  }

  const fresh = pending.filter((p) => !p.replyTo);
  return (
    <div className="flex flex-col gap-4">
      {deskTasks.map((task) => (
        <DesktopTaskCard key={task.id} server={server} task={task} showServer={false} onDone={() => { void useOrgTab.getState().refresh(); changed(); }} />
      ))}
      {detail.waiting.map((item) => (
        <WaitingCard key={`${item.runId}/${item.stepId}`} server={server} item={item} showServer={false} onDone={changed} />
      ))}
      {proposals.map((batch) => (
        <ProposalCard key={batch.batchId} server={server} batch={batch} showServer={false} onDone={changed} />
      ))}
      {error && <div role="alert" className="text-sm text-red-700 dark:text-red-300">{error}</div>}
      {!threads && !error && <div className="text-sm text-ink-muted">Reading its conversations…</div>}
      {threads && !threads.length && !fresh.length && (
        <div className={card + ' px-5 py-6 text-sm text-ink-muted'}>No conversations yet. Start one below: {worker.name} plans from its job and journal, and tells you if answering means starting work.</div>
      )}

      {fresh.map((p) => (
        <div key={p.askId} className={card + ' flex items-center gap-3 px-4 py-3'}>
          <Me server={server} />
          <div className="min-w-0 flex-1">
            <div className="truncate text-sm text-ink">{p.text}</div>
            <div className="mt-0.5 flex items-center gap-2 text-xs text-ink-muted"><span className="h-1.5 w-1.5 animate-pulse rounded-full bg-accent" />{worker.name} is working on it</div>
          </div>
        </div>
      ))}

      {threads && threads.length > 0 && (
        <ol className="flex flex-col gap-2.5" aria-label="Conversations">
          {threads.map((t) => {
            const { who, where } = startedBy(t, asks, names, server);
            const last = latest(t);
            const replies = (t.followUps ?? []).filter((f) => !handedBack(f, asks)).length;
            const stage = STAGE[t.stage] ?? STAGE.done;
            const answer = last.reply?.text ? (quiet(last.reply.text) ? 'Stayed quiet: nothing it could add.' : plain(slackText(last.reply.text, names))) : last.headline;
            return (
              <li key={t.id}>
                <button onClick={() => setOpen(t.id)} className={card + ' flex w-full gap-3.5 px-4 py-3.5 text-left hover:border-card-strong'}>
                  <span className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full bg-card-strong text-xs font-semibold text-ink">{initials(who)}</span>
                  <span className="min-w-0 flex-1">
                    <span className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-ink-faint">
                      <span className="font-medium text-ink-muted">{who}</span>
                      {where && <span>{where}</span>}
                      <span>· {ago(t.lastAt)}</span>
                      <span className="ml-auto"><Pill tone={stage.tone}>{stage.label}</Pill></span>
                    </span>
                    <span className="mt-1 line-clamp-2 block text-sm font-medium text-ink">{slackText(said(t.prompt).headline, names)}</span>
                    <span className="mt-1 line-clamp-2 block text-sm text-ink-muted">
                      <span className="font-medium text-ink-muted">{worker.name}: </span>
                      {answer}
                    </span>
                    <span className="mt-2 flex flex-wrap gap-3 text-[11px] text-ink-faint">
                      {replies > 0 && <span>{replies} {replies === 1 ? 'reply' : 'replies'}</span>}
                      {t.runs.length > 0 && <span>{t.runs.length} {t.runs.length === 1 ? 'run' : 'runs'}</span>}
                      {t.costUSD > 0 && <span>{money(t.costUSD)}</span>}
                    </span>
                  </span>
                </button>
              </li>
            );
          })}
        </ol>
      )}
      {older != null && (
        <button onClick={loadOlder} className="self-center text-xs text-ink-muted hover:text-ink">
          Older conversations
        </button>
      )}

      <Composer
        id="org-ask"
        label={`Start a new conversation with ${worker.name}`}
        placeholder={`Ask ${worker.name} something new…`}
        hint={`${worker.name} plans from its job and journal. If answering means starting work, it says so first. Enter sends; Shift+Enter for a new line.`}
        sending={sending}
        error={askError}
        onSend={(text) => ask(text)}
      />
    </div>
  );
}

/// One conversation, in order: what started it, the worker's answer, and
/// every reply since, each with the runs it led to. A reply here joins it.
function ThreadView({
  server, worker, thread, asks, names, waiting, pending, sending, error, onBack, onReply, onChanged, onOpenRun, onTuning,
}: {
  server: OrgServerStatus; worker: DetailWorker; thread: Thread; asks: Map<string, Ask>; names: Map<string, string>; waiting: OrgWaiting[];
  pending: Array<{ askId: string; text: string }>; sending: boolean; error: string | null; onBack: () => void; onReply: (text: string) => Promise<boolean>; onChanged: () => void; onOpenRun: (runId: string) => void;
  onTuning: () => void;
}) {
  const parts = [thread, ...(thread.followUps ?? [])];
  const inSlack = startedInSlack(thread, asks);
  const stage = STAGE[thread.stage] ?? STAGE.done;
  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-center gap-3">
        <button onClick={onBack} className="text-xs text-ink-muted hover:text-ink">← All conversations</button>
        <span className="ml-auto"><Pill tone={stage.tone}>{stage.label}</Pill></span>
      </div>
      {inSlack && (
        <div className="rounded-lg border border-card bg-card px-3.5 py-2.5 text-xs text-ink-muted">
          This conversation started in Slack. What you add here stays in overcli: {worker.name} sees the whole thread, but your reply and its answer aren’t posted to Slack.
        </div>
      )}
      {waiting.map((item) => (
        <WaitingCard key={`${item.runId}/${item.stepId}`} server={server} item={item} showServer={false} onDone={onChanged} />
      ))}
      {exchanges(parts, asks).map(({ said: t, steps }, i) => {
        const who = i === 0 ? startedBy(t, asks, names, server) : { who: t.by === server.me?.name ? 'You' : t.by ?? 'Someone', where: t.via === 'slack' ? 'in Slack' : '' };
        // The answer people saw: the last hand-back's, else its own. What
        // came before it (a note that work was sent off, the runs) folds
        // under it as how it got there.
        const final = steps.length ? steps[steps.length - 1] : t;
        const working = steps.length ? [t, ...steps.slice(0, -1)] : [];
        const runs = [t, ...steps].flatMap((x) => x.runs);
        const busy = final.stage === 'running' || final.stage === 'deciding' || (steps.length === 0 && (t.stage === 'running' || t.stage === 'deciding'));
        const tookMs = final.reply?.at ? final.reply.at - t.at : undefined;
        return (
          <div key={t.id} className="flex flex-col gap-3.5">
            <article className="flex gap-3.5">
              <span className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full bg-card-strong text-xs font-semibold text-ink">{initials(who.who)}</span>
              <div className="min-w-0 flex-1">
                <div className="text-xs text-ink-faint">
                  <span className="font-medium text-ink-muted">{who.who}</span>
                  {who.where ? ` · ${who.where}` : ''} · {ago(t.at)}
                </div>
                <Folded text={slackText(said(t.prompt).headline, names)} />
              </div>
            </article>
            <article className="flex gap-3.5">
              <Face worker={worker} size={32} square />
              <div className={'min-w-0 flex-1 px-5 py-4 ' + card}>
                <div className="flex flex-wrap items-center gap-2 text-xs text-ink-faint">
                  <span className="font-semibold text-ink">{worker.name}</span>
                  {tookMs && tookMs > 0 && !busy ? <span>· took {Math.max(1, Math.round(tookMs / 60_000))}m</span> : null}
                  {busy && <span className="flex items-center gap-1.5"><span className="h-1.5 w-1.5 animate-pulse rounded-full bg-accent" />working on it</span>}
                </div>
                {final.reply?.text && !(busy && steps.length === 0 && !t.reply) ? (
                  quiet(final.reply.text) ? (
                    <div className="mt-1.5 text-sm text-ink-muted">Stayed quiet: nothing it could add to this one.</div>
                  ) : (
                    <div className="org-answer mt-2 text-sm leading-relaxed text-ink">
                      <Markdown source={slackText(final.reply.text, names)} />
                    </div>
                  )
                ) : (
                  <div className="mt-1.5 text-sm text-ink-muted">{final.error ?? (steps.length ? 'Finishing up its answer…' : final.headline)}</div>
                )}
                {(working.length > 0 || runs.length > 0) && (
                  <details className="mt-3 border-t border-card pt-2.5">
                    <summary className="cursor-pointer text-xs text-ink-muted hover:text-ink">
                      How {worker.name} worked it out{runs.length ? ` · ${runs.length} ${runs.length === 1 ? 'run' : 'runs'}` : ''}
                      {runs.some((r) => r.costUSD) ? ` · ${money(runs.reduce((n, r) => n + (r.costUSD ?? 0), 0))}` : ''}
                    </summary>
                    <div className="mt-2 flex flex-col gap-2">
                      {working.map((w) =>
                        w.reply?.text && !quiet(w.reply.text) ? (
                          <div key={w.id} className="org-answer rounded-lg bg-surface px-3 py-2 text-xs text-ink-muted">
                            <Markdown source={slackText(w.reply.text, names)} />
                          </div>
                        ) : null,
                      )}
                      {runs.map((r) => (
                        <button key={r.runId} onClick={() => onOpenRun(r.runId)} className="flex items-center gap-2 text-left text-xs text-ink hover:underline">
                          <span className={'h-1.5 w-1.5 flex-shrink-0 rounded-full ' + (r.state === 'done' ? 'bg-emerald-400' : r.state === 'failed' ? 'bg-red-400' : r.state === 'stopped' ? 'bg-ink-faint' : 'bg-accent animate-pulse')} />
                          <span className="truncate">{r.title}</span>
                          <span className="flex-shrink-0 text-ink-faint">{r.state}{r.costUSD ? ` · ${money(r.costUSD)}` : ''}</span>
                        </button>
                      ))}
                    </div>
                  </details>
                )}
                {final.choices?.length ? (
                  <div className="mt-3 flex flex-wrap gap-1.5">
                    {final.choices.map((c) => (
                      <button key={c} disabled={sending} className={btn} onClick={() => void onReply(c)}>{c}</button>
                    ))}
                  </div>
                ) : null}
                {!busy && final.reply?.text && !quiet(final.reply.text) && (
                  <AnswerFeedback server={server} worker={worker} runs={runs} question={said(t.prompt).headline} onTuning={onTuning} />
                )}
              </div>
            </article>
          </div>
        );
      })}
      {pending.map((p) => (
        <div key={p.askId} className="flex flex-col gap-3.5">
          <article className="flex gap-3.5">
            <Me server={server} />
            <div className="min-w-0 flex-1">
              <div className="text-xs text-ink-faint">You · just now</div>
              <div className="mt-1 whitespace-pre-wrap text-sm leading-relaxed text-ink">{p.text}</div>
            </div>
          </article>
          <article className="flex gap-3.5">
            <Face worker={worker} size={32} square />
            <Thinking name={worker.name} />
          </article>
        </div>
      ))}
      <Composer
        id="org-reply"
        label={`Reply to ${worker.name} in this conversation`}
        placeholder={`Reply in this conversation…`}
        hint={`${worker.name} sees everything above.${inSlack ? ' Stays in overcli.' : ''} Enter sends; Shift+Enter for a new line.`}
        sending={sending}
        error={error}
        onSend={onReply}
      />
    </div>
  );
}

/// Under an answer: say whether it was useful (on the run it came from, the
/// rating tuning reads), or that it missed, which starts overgo's review of
/// the worker with your words and that question, for Tuning to show.
function AnswerFeedback({ server, worker, runs, question, onTuning }: { server: OrgServerStatus; worker: DetailWorker; runs: Array<{ runId: string; title: string; state: string; startedAt: number }>; question: string; onTuning: () => void }) {
  const done = runs.filter((r) => r.state === 'done');
  const entryId = done.length ? `run:${done[done.length - 1].runId}` : null;
  const [rated, setRated] = useState<'useful' | 'not' | null>(null);
  const [open, setOpen] = useState<'note' | 'missed' | null>(null);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string; tuning?: boolean } | null>(null);
  const rate = (useful: boolean, note?: string) => {
    if (!entryId) return;
    setBusy(true);
    void orgCall(server.id, 'POST', '/api/rate', { entryId, useful, ...(note?.trim() ? { note: note.trim() } : {}) }).then((r) => {
      setBusy(false);
      if (!r.ok) return setMsg({ ok: false, text: r.error });
      setRated(useful ? 'useful' : 'not');
      setOpen(null);
      setText('');
      setMsg({ ok: true, text: useful ? `Thanks: ${worker.name} leans toward answers like this.` : `Noted. ${worker.name} reads that before its next run.` });
    });
  };
  const missed = () => {
    const what = text.trim();
    if (!what) return;
    setBusy(true);
    setMsg({ ok: true, text: `overgo is reviewing ${worker.name}’s work with this… (a minute or two)` });
    const complaint = `${what}\n\nAbout its answer to: “${question.slice(0, 300)}”${done.length ? ` (${done.map((r) => r.title).slice(-1)[0]})` : ''}`;
    void orgCall(server.id, 'POST', `/api/workers/${enc(worker.id)}/review`, { complaint }).then((r) => {
      setBusy(false);
      if (!r.ok) return setMsg({ ok: false, text: r.error });
      setOpen(null);
      setText('');
      setMsg({ ok: true, text: 'Reviewed. Its suggestions are on Tuning.', tuning: true });
    });
  };
  return (
    <div className="mt-3 border-t border-card pt-2.5">
      <div className="flex flex-wrap items-center gap-1.5">
        {entryId && rated === null && (
          <>
            <button disabled={busy} className={btn} onClick={() => rate(true)}>Useful</button>
            <button disabled={busy} className={btn} onClick={() => setOpen(open === 'note' ? null : 'note')}>Not useful</button>
          </>
        )}
        {worker.youManage && (
          <button disabled={busy} className={btn} onClick={() => setOpen(open === 'missed' ? null : 'missed')}>This missed: improve {worker.name}…</button>
        )}
        {msg && (
          <span role="status" className={'text-xs ' + (msg.ok ? 'text-ink-muted' : 'text-red-700 dark:text-red-300')}>
            {msg.text} {msg.tuning && <button className="text-accent hover:underline" onClick={onTuning}>Open Tuning</button>}
          </span>
        )}
      </div>
      {open && (
        <div className="mt-2 flex flex-wrap gap-2">
          <label htmlFor={`fb-${entryId ?? question.slice(0, 8)}`} className="sr-only">{open === 'note' ? 'What was off' : 'What it should have done'}</label>
          <input
            id={`fb-${entryId ?? question.slice(0, 8)}`}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (!sendsOnEnter(e) || busy) return;
              e.preventDefault();
              if (open === 'note') rate(false, text);
              else if (text.trim()) missed();
            }}
            placeholder={open === 'note' ? 'What was off? (optional)' : `What should ${worker.name} have done?`}
            className="min-w-[260px] flex-1 rounded-lg border border-card-strong bg-surface px-3 py-1.5 text-sm text-ink"
          />
          {open === 'note' ? (
            <button disabled={busy} className={primary} onClick={() => rate(false, text)}>Send</button>
          ) : (
            <button disabled={busy || !text.trim()} className={primary} onClick={missed}>{busy ? 'Reviewing…' : `Improve ${worker.name}`}</button>
          )}
        </div>
      )}
    </div>
  );
}

/// A thread as people had it: each thing someone said, with the parts the
/// server added afterwards to finish that answer (hand-backs) gathered under it.
function exchanges(parts: Thread[], asks: Map<string, Ask>): Array<{ said: Thread; steps: Thread[] }> {
  const out: Array<{ said: Thread; steps: Thread[] }> = [];
  for (const p of parts) {
    if (handedBack(p, asks) && out.length) out[out.length - 1].steps.push(p);
    else out.push({ said: p, steps: [] });
  }
  return out;
}

/// Enter sends, as in every chat here; Shift+Enter is a new line. ⌘/Ctrl+Enter
/// too. Never while an input method is still composing a character.
export function sendsOnEnter(e: { key: string; shiftKey: boolean; nativeEvent: { isComposing?: boolean } }): boolean {
  return e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing;
}

/// The box at the foot of the page: solid, pinned, Enter sends; Shift+Enter for a new line.
function Composer({ id, label: l, placeholder, hint, sending, error, onSend }: { id: string; label: string; placeholder: string; hint: string; sending: boolean; error: string | null; onSend: (text: string) => Promise<boolean> }) {
  const [draft, setDraft] = useState('');
  const send = () => void onSend(draft).then((ok) => ok && setDraft(''));
  return (
    <div className="sticky bottom-4 z-10 rounded-2xl border border-card-strong bg-surface p-3 shadow-[0_10px_30px_rgba(0,0,0,0.35)]">
      <label htmlFor={id} className="sr-only">{l}</label>
      <textarea
        id={id}
        rows={2}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (sendsOnEnter(e)) {
            e.preventDefault();
            send();
          }
        }}
        placeholder={placeholder}
        className="w-full resize-none border-0 bg-transparent text-sm leading-relaxed text-ink outline-none placeholder:text-ink-faint"
      />
      <div className="mt-1.5 flex flex-wrap items-center gap-3">
        <span className="flex-1 text-xs text-ink-faint">{error ? <span role="alert" className="text-red-600 dark:text-red-300">{error}</span> : hint}</span>
        <button disabled={sending || !draft.trim()} className={primary} onClick={send}>
          {sending ? 'Sending…' : 'Send'} <Icon d="M5 12h14M13 6l6 6-6 6" />
        </button>
      </div>
    </div>
  );
}

/// What a question said, as the person put it. A Slack message that set a
/// worker off (a listen or follow-up trigger) is stored as the worker's whole
/// brief: its instructions, then the message as untrusted data. Show the
/// message, and say where it came from.
export function said(text: string): { headline: string; source?: string; where?: string; userId?: string } {
  if (!text.includes('<untrusted-data>')) return { headline: text.trim() };
  const data = text.slice(text.indexOf('<untrusted-data>') + '<untrusted-data>'.length);
  const title = /^\s*Title:\s*(.+)$/m.exec(data)?.[1]?.trim();
  // The event's own text is the whole message; the title line is clipped.
  const raw = /"text":\s*"((?:[^"\\]|\\.)*)"/.exec(data)?.[1];
  let fromJson = '';
  if (raw) {
    try {
      fromJson = String(JSON.parse(`"${raw}"`)).trim();
    } catch {
      fromJson = raw.replace(/\\n/g, '\n').replace(/\\"/g, '"').trim();
    }
  }
  const message = fromJson.length > (title?.length ?? 0) ? fromJson : title ?? fromJson;
  const where = /set off by an? (Slack message|[a-z ]+?)(?: \(["“]?([^)"”]+)["”]?\))?:/i.exec(text);
  const source = where ? `${where[1].replace(/^Slack message$/i, 'A Slack message')}${where[2] ? ` in ${where[2]}` : ''}` : 'A trigger';
  // Who wrote it: the Slack event's own author, the first "user" in it (the
  // thread's replies come after, each under "from").
  const userId = /"user":\s*"([UW][A-Z0-9]+)"/.exec(data)?.[1];
  return { headline: message || text.split('\n')[0].trim(), source, where: where ? (where[2] ? `in ${where[2]}` : 'in Slack') : undefined, ...(userId ? { userId } : {}) };
}

/// Who asked: you, the person by name, or for a Slack message that set the
/// worker off, its author from the org's directory.
function asker(a: Ask, names: Map<string, string>, server: OrgServerStatus): string {
  if (a.via === 'trigger') {
    // Recorded by the server since asks carry it; read out of the brief before.
    const id = a.from?.slackUserId ?? said(a.text).userId;
    return (id && names.get(id)) || (id ? 'Someone' : 'A trigger');
  }
  return a.by === server.me?.name ? 'You' : a.by;
}

/// Slack's own markup as people read it: mentions by name, links, channels.
export function slackText(text: string, names: Map<string, string>): string {
  return text
    .replace(/<@([UW][A-Z0-9]+)(?:\|([^>]+))?>/g, (_m, id: string, label?: string) => `@${names.get(id) ?? label ?? 'someone'}`)
    .replace(/<#[CG][A-Z0-9]+\|([^>]+)>/g, '#$1')
    .replace(/<(https?:[^|>\s]+)\|([^>]+)>/g, '[$2]($1)')
    .replace(/<(https?:[^>\s]+)>/g, '$1');
}

/// A worker stays silent in a channel by answering PASS.
function quiet(reply?: string): boolean {
  return /^\s*PASS\.?\s*$/i.test(reply ?? '');
}

/// Slack ids to names, from the org's directory.
function useDirectory(serverId: string): Map<string, string> {
  return useDirectoryData(serverId).names;
}

/// A question, folded after a few lines when it runs long.
function Folded({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  const long = text.length > 400 || text.split('\n').length > 6;
  return (
    <div className="mt-1">
      <div className={'whitespace-pre-wrap break-words text-sm leading-relaxed text-ink ' + (long && !open ? 'line-clamp-4' : '')}>{text}</div>
      {long && (
        <button onClick={() => setOpen(!open)} className="mt-1 text-xs text-accent hover:underline">
          {open ? 'Show less' : 'Show all'}
        </button>
      )}
    </div>
  );
}

function Thinking({ name }: { name: string }) {
  return (
    <div className="flex flex-1 items-center gap-2.5 rounded-xl border border-dashed border-card-strong px-4 py-3 text-sm text-ink-muted">
      <span className="h-2 w-2 animate-pulse rounded-full bg-accent" />
      {name} is working on it · answers usually take about a minute
    </div>
  );
}

// ---- Sidebar -----------------------------------------------------------------

function Sidebar({ worker: w, detail, onOpen, onAllRuns, top = 0 }: { worker: DetailWorker; detail: Detail; onOpen: (runId: string) => void; onAllRuns: () => void; top?: number }) {
  const live = detail.now[0];
  const waitingRun = detail.waiting[0];
  const pct = w.budgetUSDPerMonth > 0 ? Math.min(100, (w.spentThisMonthUSD / w.budgetUSDPerMonth) * 100) : 0;
  const tools = w.tools ?? [];
  const problems = new Set([...(detail.toolProblems ?? []), ...detail.missingTools]);
  return (
    <aside className="sticky flex max-w-[340px] flex-[1_1_280px] flex-col gap-3.5 self-start overflow-y-auto pb-2" style={{ top: top + 24, maxHeight: `calc(100vh - ${top + 48}px)` }}>
      <div className={card + ' p-4'}>
        <div className={label}>Now</div>
        {waitingRun ? (
          <>
            <div className="mt-2 flex items-center gap-2 text-sm text-ink"><span className="h-2 w-2 rounded-full bg-amber-400" />Waiting on you{waitingRun.runNumber ? ` · run #${waitingRun.runNumber}` : ''}</div>
            <div className="mt-1 text-xs text-ink-muted">{waitingRun.kind === 'question' ? 'Asked a question' : 'Wants an approval'} {ago(waitingRun.since)}</div>
          </>
        ) : live ? (
          <button className="mt-2 block w-full text-left" onClick={() => onOpen(live.runId)}>
            <div className="flex items-center gap-2 text-sm text-ink"><span className="h-2 w-2 animate-pulse rounded-full bg-accent" /><span className="truncate">{live.title}</span></div>
            <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-card-strong"><div className="h-full bg-accent" style={{ width: `${Math.round((live.step.index / Math.max(1, live.step.total)) * 100)}%` }} /></div>
            <div className="mt-1 text-xs text-ink-muted">Step {live.step.index} of {live.step.total}, {live.step.name.replace(/[-_]+/g, ' ')} · started {ago(live.startedAt)}</div>
          </button>
        ) : detail.deciding ? (
          <div className="mt-2 flex items-center gap-2 text-sm text-ink"><span className="h-2 w-2 animate-pulse rounded-full bg-accent" />Deciding what to do</div>
        ) : (
          <>
            <div className="mt-2 flex items-center gap-2 text-sm text-ink"><span className={'h-2 w-2 rounded-full ' + STATE_DOT[w.state]} />{STATE_LABEL[w.state]}</div>
            <div className="mt-1 text-xs text-ink-muted">{w.last30.lastRun ? `Last run ${ago(w.last30.lastRun.at)}` : 'No runs yet'}{w.nextRunAt ? ` · next ${new Date(w.nextRunAt).toLocaleString(undefined, { weekday: 'short', hour: '2-digit', minute: '2-digit' })}` : ''}</div>
          </>
        )}
      </div>

      <div className={card + ' p-4'}>
        <div className={label}>This month</div>
        <div className="mt-2 flex items-baseline gap-1.5"><span className="text-2xl font-semibold text-ink">{money(w.spentThisMonthUSD)}</span><span className="text-sm text-ink-muted">of {money(w.budgetUSDPerMonth)}</span></div>
        <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-card-strong"><div className={'h-full ' + (pct >= 90 ? 'bg-red-400' : pct >= 70 ? 'bg-amber-400' : 'bg-accent')} style={{ width: `${pct}%` }} /></div>
        <div className="mt-3.5 grid grid-cols-3 gap-2">
          <Num n={String(w.month.runs)} label="runs" />
          <Num n={String(w.month.failed)} label="failed" />
          <Num n={detail.stats.usefulPct === null ? '—' : `${detail.stats.usefulPct}%`} label="rated useful" />
        </div>
      </div>

      <div className={card + ' p-4'}>
        <div className="flex items-baseline justify-between">
          <span className={label}>Recent runs</span>
          {detail.history.length > 0 && <button onClick={onAllRuns} className="text-xs text-accent hover:underline">All {detail.history.length}</button>}
        </div>
        {detail.history.length ? (
          <div className="mt-2 flex flex-col">
            {detail.history.slice(0, 4).map((r) => (
              <button key={r.runId} onClick={() => onOpen(r.runId)} className="flex items-start gap-2 border-t border-card py-2 text-left first:border-t-0">
                <span className={'mt-1.5 h-1.5 w-1.5 flex-shrink-0 rounded-full ' + outcomeDot(r.outcome)} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-xs text-ink">{r.title}</span>
                  <span className="block text-[11px] text-ink-faint">{r.outcome} · {r.minutes}m{r.costUSD ? ` · ${money(r.costUSD)}` : ''} · {ago(r.at)}</span>
                </span>
              </button>
            ))}
          </div>
        ) : (
          <div className="mt-2 text-xs text-ink-muted">No runs yet.</div>
        )}
      </div>

      {(tools.length > 0 || problems.size > 0) && (
        <div className={card + ' p-4'}>
          <div className={label}>Tools</div>
          <div className="mt-2.5 flex flex-col gap-2">
            {tools.map((t) => (
              <div key={t.name} className="flex items-center gap-2 text-xs">
                <span className={'h-1.5 w-1.5 rounded-full ' + (t.ok && !problems.has(t.name) ? 'bg-emerald-400' : 'bg-amber-400')} />
                <span className="flex-1 text-ink">{t.name}</span>
                <span className="text-ink-faint">{!t.ok ? 'not on the server' : problems.has(t.name) ? 'needs a sign-in' : t.scope?.mode === 'read' ? 'read' : t.scope?.mode === 'only' ? 'some calls' : 'full'}</span>
              </div>
            ))}
            {[...problems].filter((p) => !tools.some((t) => t.name === p)).map((p) => (
              <div key={p} className="flex items-center gap-2 text-xs">
                <span className="h-1.5 w-1.5 rounded-full bg-amber-400" />
                <span className="flex-1 text-ink">{p}</span>
                <span className="text-ink-faint">not on the server</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </aside>
  );
}

function Num({ n, label: l }: { n: string; label: string }) {
  return (
    <div>
      <div className="text-lg font-semibold text-ink">{n}</div>
      <div className="text-[11px] text-ink-muted">{l}</div>
    </div>
  );
}

function outcomeDot(o: string): string {
  return o === 'done' ? 'bg-emerald-400' : o === 'failed' ? 'bg-red-400' : 'bg-ink-faint';
}

// ---- Runs --------------------------------------------------------------------

function RunsList({ detail, onOpen }: { detail: Detail; onOpen: (runId: string) => void }) {
  const row = (id: string, title: string, n: number | undefined, dot: string, meta: string) => (
    <button key={id} onClick={() => onOpen(id)} className="flex w-full items-center gap-3 border-b border-card px-4 py-3 text-left last:border-b-0 hover:bg-card-strong">
      <span className={'h-2 w-2 flex-shrink-0 rounded-full ' + dot} />
      <span className="min-w-0 flex-1 truncate text-sm text-ink">{title}</span>
      {n ? <span className="text-xs text-ink-faint">#{n}</span> : null}
      <span className="w-44 text-right text-xs text-ink-muted">{meta}</span>
    </button>
  );
  return (
    <div className="flex flex-col gap-6">
      {detail.now.length > 0 && (
        <section>
          <h3 className="mb-2 text-sm font-semibold text-ink">Going now</h3>
          <div className={card + ' overflow-hidden'}>{detail.now.map((r) => row(r.runId, r.title, r.runNumber, 'bg-accent animate-pulse', `step ${r.step.index}/${r.step.total} · ${r.state} · ${ago(r.startedAt)}`))}</div>
        </section>
      )}
      <section>
        <h3 className="mb-2 text-sm font-semibold text-ink">Finished</h3>
        {detail.history.length ? (
          <div className={card + ' overflow-hidden'}>{detail.history.map((r) => row(r.runId, r.title, r.runNumber, outcomeDot(r.outcome), `${r.outcome} · ${r.minutes}m${r.costUSD ? ` · ${money(r.costUSD)}` : ''} · ${ago(r.at)}`))}</div>
        ) : (
          <div className="text-sm text-ink-muted">No finished runs yet.</div>
        )}
      </section>
    </div>
  );
}

interface RunInfo {
  run: { id: string; title: string; state: string; startedAt: number; endedAt?: number; steps: number; costUSD?: number; error?: string };
  thread: { id: string; prompt: string; by?: string; via?: string } | null;
  waiting: OrgWaiting[];
  youManage: boolean;
}
interface RunStep {
  id: string;
  output?: string;
  body?: string;
  startedAt?: number;
  endedAt?: number;
  outcome?: string;
  error?: string;
}

/// A run read properly: the answer as a document, the steps as a timeline,
/// and a follow-up in the same thread.
function RunPage({ server, worker, runId, past, onChanged, onTuning }: { server: OrgServerStatus; worker: DetailWorker; runId: string; past?: RunPast; onChanged: () => void; onTuning: () => void }) {
  const [info, setInfo] = useState<RunInfo | null>(null);
  const [steps, setSteps] = useState<RunStep[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [draft, setDraft] = useState('');
  const [sent, setSent] = useState<string | null>(null);
  const names = useDirectory(server.id);
  const load = () =>
    Promise.all([orgCall(server.id, 'GET', `/api/runs/${enc(runId)}`), orgCall(server.id, 'GET', `/api/runs/${enc(runId)}/steps`)]).then(([a, b]) => {
      if (a.ok) setInfo(a.data as RunInfo);
      else setError(a.error);
      if (b.ok) setSteps((b.data as { steps: RunStep[] }).steps ?? []);
    });
  useEffect(() => {
    void load();
  }, [server.id, runId]);
  const act = (path: string, body: unknown = {}) => {
    setBusy(true);
    void orgCall(server.id, 'POST', path, body).then((res) => {
      setBusy(false);
      if (!res.ok) setError(res.error);
      void load();
      onChanged();
    });
  };
  const followUp = () => {
    const message = draft.trim();
    if (!message) return;
    setBusy(true);
    void orgCall(server.id, 'POST', '/api/ask', { worker: worker.id, message, ...(info?.thread?.id ? { replyTo: info.thread.id } : {}) }).then((res) => {
      setBusy(false);
      if (!res.ok) return setError(res.error);
      setDraft('');
      setSent(`Sent. ${worker.name} picks it up in the same thread; the answer shows in Conversation.`);
      onChanged();
    });
  };

  if (!info) return <div className="px-8 pt-6 text-sm text-ink-muted">{error ?? 'Reading the run…'}</div>;
  const r = info.run;
  // The answer: the last step that wrote something.
  const answer = [...steps].reverse().find((s) => s.body?.trim());
  const going = r.state === 'running' || r.state === 'paused';
  const tone = r.state === 'done' ? 'green' : r.state === 'failed' ? 'red' : going ? 'accent' : 'plain';

  return (
    <div className="px-8 pb-10 pt-4">
      <div className="flex flex-wrap items-start gap-4">
        <div className="min-w-[300px] flex-1">
          <div className="flex flex-wrap items-center gap-2 text-xs text-ink-muted">
            <Pill tone={tone}>{r.state === 'done' ? 'Done' : r.state === 'failed' ? 'Failed' : r.state === 'stopped' ? 'Stopped' : r.state === 'paused' ? 'Paused' : 'Running'}</Pill>
            <span>
              {info.thread?.by ? `Asked by ${info.thread.by === server.me?.name ? 'you' : info.thread.by}` : 'Started'}
              {info.thread?.via && info.thread.via !== 'console' ? ` in ${info.thread.via === 'slack' ? 'Slack' : info.thread.via === 'mcp' ? 'a chat' : info.thread.via}` : ''} · {ago(r.startedAt)}
              {r.endedAt ? ` · took ${Math.max(1, Math.round((r.endedAt - r.startedAt) / 60_000))}m` : ''}
              {r.costUSD ? ` · ${money(r.costUSD)}` : ''}
            </span>
          </div>
          <h1 className="mt-3 text-2xl font-semibold leading-snug tracking-tight text-ink">{said(info.thread?.prompt ?? '').headline || r.title}</h1>
        </div>
        {info.youManage && (
          <div className="flex gap-2">
            {going && <button disabled={busy} className={btn} onClick={() => act(`/api/runs/${enc(r.id)}/stop`)}>Stop</button>}
            {r.state === 'paused' && <button disabled={busy} className={btn} title="Carry on a run the server stopped mid-step" onClick={() => act(`/api/runs/${enc(r.id)}/resume`)}>Carry on</button>}
          </div>
        )}
      </div>

      <div className="mt-6 flex flex-wrap items-start gap-7">
        <section className="flex min-w-0 flex-[999_1_520px] flex-col gap-4">
          {info.waiting.map((item) => (
            <WaitingCard key={`${item.runId}/${item.stepId}`} server={server} item={item} showServer={false} onDone={() => { void load(); onChanged(); }} />
          ))}
          {(r.error || error) && <div role="alert" className="rounded-xl border border-red-400/40 bg-red-500/5 px-4 py-3 text-sm text-red-700 dark:text-red-300">{r.error ?? error}</div>}
          <article className={card + ' px-7 py-6'}>
            <div className="flex items-center gap-2.5 text-xs text-ink-faint">
              <Face worker={worker} size={26} square />
              <span><b className="text-ink">{worker.name}’s {answer?.output ? answer.output.replace(/\.md$/, '').replace(/[-_]+/g, ' ') : 'answer'}</b>{answer ? ` · from ${answer.id.replace(/[-_]+/g, ' ')}` : ''}</span>
            </div>
            <div className="org-answer org-doc mt-4 text-[15px] leading-relaxed text-ink">
              {answer ? <Markdown source={slackText(answer.body!, names)} /> : <span className="text-ink-muted">{going ? 'Nothing written yet.' : 'This run wrote nothing.'}</span>}
            </div>
            {!going && (
              <AnswerFeedback server={server} worker={worker} runs={[{ runId: r.id, title: r.title, state: r.state, startedAt: r.startedAt }]} question={said(info.thread?.prompt ?? r.title).headline} onTuning={onTuning} />
            )}
          </article>
          <div className="rounded-2xl border border-card-strong bg-card p-3">
            <label htmlFor="org-follow" className="mb-1 block text-xs text-ink-muted">Follow up with {worker.name} on this</label>
            <textarea id="org-follow" rows={2} value={draft} onChange={(e) => { setDraft(e.target.value); setSent(null); }} onKeyDown={(e) => { if (sendsOnEnter(e)) { e.preventDefault(); if (!busy && draft.trim()) followUp(); } }} placeholder="e.g. Show me where that happens in the code" className="w-full resize-none border-0 bg-transparent text-sm leading-relaxed text-ink outline-none placeholder:text-ink-faint" />
            <div className="flex items-center justify-end gap-3">
              {sent && <span role="status" className="text-xs text-emerald-700 dark:text-emerald-300">{sent}</span>}
              <button disabled={busy || !draft.trim()} className={primary} onClick={followUp}>Ask</button>
            </div>
          </div>
        </section>

        <aside className="flex max-w-[340px] flex-[1_1_280px] flex-col gap-3.5">
          <div className={card + ' p-4'}>
            <div className={label}>How it went</div>
            <ol className="mt-3 flex flex-col">
              {steps.map((s, i) => {
                const mark = s.outcome === 'success' ? 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300' : s.outcome === 'error' || s.outcome === 'reboundExhausted' ? 'bg-red-500/15 text-red-700 dark:text-red-300' : s.startedAt ? 'bg-accent/20 text-ink' : 'bg-card-strong text-ink-faint';
                const glyph = s.outcome === 'success' ? '✓' : s.outcome === 'error' || s.outcome === 'reboundExhausted' ? '!' : String(i + 1);
                return (
                  <li key={s.id} className="flex gap-3">
                    <div className="flex flex-col items-center">
                      <span className={'flex h-[22px] w-[22px] items-center justify-center rounded-full text-[11px] font-bold ' + mark}>{glyph}</span>
                      {i < steps.length - 1 && <span className="min-h-[18px] w-0.5 flex-1 bg-card-strong" />}
                    </div>
                    <div className="min-w-0 flex-1 pb-3.5">
                      <button onClick={() => setOpen(open === s.id ? null : s.id)} className="text-left text-sm font-medium text-ink hover:underline">{s.id.replace(/[-_]+/g, ' ')}</button>
                      <div className="text-xs text-ink-muted">
                        {s.outcome ?? (s.startedAt ? 'going' : 'not started')}
                        {s.startedAt ? ` · ${Math.max(0, Math.round(((s.endedAt ?? Date.now()) - s.startedAt) / 1000)) < 90 ? `${Math.max(1, Math.round(((s.endedAt ?? Date.now()) - s.startedAt) / 1000))}s` : `${Math.round(((s.endedAt ?? Date.now()) - s.startedAt) / 60_000)}m`}` : ''}
                      </div>
                      {s.error && <div className="mt-1 text-xs text-red-700 dark:text-red-300">{s.error}</div>}
                      {open === s.id && (
                        <div className="org-answer mt-2 max-h-80 overflow-auto rounded-lg border border-card bg-surface px-3 py-2 text-xs text-ink">
                          {s.body ? <Markdown source={s.body} /> : <span className="text-ink-muted">Nothing written.</span>}
                        </div>
                      )}
                    </div>
                  </li>
                );
              })}
            </ol>
          </div>
          <div className={card + ' p-4'}>
            <div className={label}>What it handed back</div>
            <div className="mt-2.5 flex flex-col gap-2 text-xs">
              {past?.pullRequests?.length ? (
                past.pullRequests.map((p) => (
                  <a key={p.url} href={p.url} target="_blank" rel="noreferrer" className="truncate text-accent hover:underline">
                    {p.repo ? `${p.repo}: ` : ''}pull request
                  </a>
                ))
              ) : (
                <span className="text-ink-muted">{going ? 'Nothing yet.' : 'No pull requests. Answers and reports land in the thread.'}</span>
              )}
            </div>
          </div>
        </aside>
      </div>
    </div>
  );
}

// ---- Journal -----------------------------------------------------------------

interface Journal {
  notes: Array<{ id: string; at: number; note: string }>;
  entries: Array<{ id: string; at: number; kind: string; title: string; note?: string; costUSD?: number; runId?: string }>;
  canChange: boolean;
}

function JournalTab({ serverId, worker }: { serverId: string; worker: DetailWorker }) {
  const [j, setJ] = useState<Journal | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const load = () =>
    orgCall(serverId, 'GET', `/api/workers/${enc(worker.id)}/journal?limit=40`).then((res) => {
      if (res.ok) setJ(res.data as Journal);
      else setError(res.error);
    });
  useEffect(() => {
    void load();
  }, [serverId, worker.id]);
  const post = (path: string, body: unknown, then?: () => void) => {
    setBusy(true);
    void orgCall(serverId, 'POST', path, body).then((res) => {
      setBusy(false);
      if (!res.ok) return setError(res.error);
      then?.();
      void load();
    });
  };
  if (!j) return <div className="text-sm text-ink-muted">{error ?? 'Reading its journal…'}</div>;
  return (
    <div className="flex flex-col gap-6">
      <section>
        <h3 className="mb-1 text-sm font-semibold text-ink">What it keeps in mind</h3>
        <p className="mb-3 text-xs text-ink-muted">Notes it reads before every run. Add what it should know; forget what’s no longer true.</p>
        <div className={card + ' overflow-hidden'}>
          {j.notes.map((n) => (
            <div key={n.id} className="flex items-start gap-3 border-b border-card px-4 py-3 last:border-b-0">
              <span className="min-w-0 flex-1 whitespace-pre-wrap text-sm text-ink">{n.note}</span>
              <span className="flex-shrink-0 text-[11px] text-ink-faint">{ago(n.at)}</span>
              {j.canChange && <button disabled={busy} onClick={() => post(`/api/workers/${enc(worker.id)}/journal/forget`, { entryId: n.id })} className="flex-shrink-0 text-xs text-ink-muted hover:text-ink disabled:opacity-50">Forget</button>}
            </div>
          ))}
          {!j.notes.length && <div className="px-4 py-3 text-sm text-ink-muted">Nothing yet.</div>}
          {j.canChange && (
            <div className="flex gap-2 border-t border-card p-3">
              <label htmlFor="org-note" className="sr-only">A note for {worker.name}</label>
              <input id="org-note" value={draft} onChange={(e) => setDraft(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && draft.trim()) post(`/api/workers/${enc(worker.id)}/journal`, { note: draft.trim() }, () => setDraft('')); }} placeholder="e.g. The reporting service moved to the platform repo in October." className="flex-1 rounded-lg border border-card-strong bg-surface px-3 py-2 text-sm text-ink" />
              <button disabled={busy || !draft.trim()} className={primary} onClick={() => post(`/api/workers/${enc(worker.id)}/journal`, { note: draft.trim() }, () => setDraft(''))}>Add</button>
            </div>
          )}
        </div>
      </section>
      <section>
        <h3 className="mb-3 text-sm font-semibold text-ink">What it did</h3>
        <ol className="flex flex-col gap-0.5">
          {j.entries.map((e) => (
            <li key={e.id} className="flex gap-3 rounded-lg px-2 py-2 hover:bg-card">
              <span className="w-20 flex-shrink-0 text-xs text-ink-faint">{ago(e.at)}</span>
              <span className="min-w-0 flex-1">
                <span className="block text-sm text-ink">{e.title}</span>
                {e.note && <span className="block text-xs text-ink-muted">{e.note}</span>}
              </span>
              {e.costUSD ? <span className="flex-shrink-0 text-xs text-ink-faint">{money(e.costUSD)}</span> : null}
            </li>
          ))}
          {!j.entries.length && <li className="text-sm text-ink-muted">Nothing yet.</li>}
        </ol>
      </section>
      {error && <div role="alert" className="text-xs text-red-700 dark:text-red-300">{error}</div>}
    </div>
  );
}
