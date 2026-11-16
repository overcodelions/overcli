// The Org tab's home: run the team from here. A line that says how the day
// stands, a box to ask any worker, the month in five numbers, what needs you
// (answerable in place), what's running now, what was delivered (rate it:
// it's how they learn), the team as cards with their recent runs and
// verdict, and a side column of what's worth a look, spend and what's next.
// Full width: cards fill as many columns as fit. All of it from the servers'
// own views (today, inflight, work, tuning), each server asked on its own.

import { useEffect, useMemo, useState } from 'react';
import type { OrgServerStatus } from '@shared/types';
import { useStore } from '../../../store';
import { DesktopTaskCard } from './DesktopTaskCard';
import { Face, ProposalCard, WaitingCard } from './OrgPane';
import { ago, isYours, money, orgCall, othersLabel, STATE_DOT, STATE_LABEL, useOrgTab, useOthersOpen, type OrgSelection, type OrgWorker, type OrgWorkItem } from './orgTabStore';

const card = 'rounded-xl border border-card bg-card';
const label = 'text-[11px] uppercase tracking-wider text-ink-faint';
const btn = 'inline-flex min-h-[30px] items-center gap-1.5 rounded-lg border border-card-strong bg-surface px-3 py-1 text-xs font-medium text-ink hover:bg-card-strong disabled:opacity-50';
const primary = 'inline-flex min-h-[34px] items-center gap-1.5 rounded-lg bg-accent px-3.5 py-1.5 text-xs font-semibold text-white disabled:opacity-50';
const DAY = 86_400_000;
const RUN: Record<string, string> = { good: 'bg-emerald-400', rough: 'bg-amber-400', failed: 'bg-red-400', running: 'bg-accent' };
const VERDICT: Record<string, string> = { better: 'Better since its last change', same: 'Steady', worse: 'Worse since its last change', waiting: 'Waiting to tell', early: 'Too early to tell' };

type Filter = 'all' | 'needs' | 'working' | 'worse';

export function OrgHome() {
  const { servers, loaded, loading, filter, setFilter, workers, waiting, proposals, desktop, today, inflight, work, trends, errors, refresh, refreshedAt, select, loadTrends } = useOrgTab();
  const openSheet = useStore((s) => s.openSheet);
  const [team, setTeam] = useState<Filter>('all');
  const shown = servers.filter((s) => filter === 'all' || s.id === filter);
  const many = servers.length > 1;
  const now = Date.now();

  // Every worker, with its server.
  const roster = useMemo(() => shown.flatMap((s) => (workers[s.id] ?? []).map((w) => ({ server: s, w }))), [shown, workers]);
  // Yours apart from those shared with you. What's running and what it
  // costs count yours, when you have any; delivered work and the team
  // cards show both.
  const own = roster.filter(({ w }) => isYours(w));
  const others = roster.filter(({ w }) => !isYours(w));
  const counted = own.length ? own : roster;
  const ownIds = new Set(own.map(({ server, w }) => `${server.id}/${w.id}`));
  useEffect(() => {
    for (const s of shown) void loadTrends(s.id, (workers[s.id] ?? []).map((w) => w.id));
  }, [shown.map((s) => s.id).join(','), refreshedAt]);

  const inbox = shown.flatMap((s) => (waiting[s.id] ?? []).map((item) => ({ server: s, item })));
  const proposed = shown.flatMap((s) => (proposals[s.id] ?? []).map((batch) => ({ server: s, batch })));
  const forDesk = shown.flatMap((s) => (desktop[s.id] ?? []).map((task) => ({ server: s, task })));
  const needs = inbox.length + proposed.length + forDesk.length;
  const oldest = Math.min(...inbox.map((x) => x.item.since), ...proposed.map((x) => x.batch.at), ...forDesk.map((x) => x.task.at), Infinity);
  const live = shown
    .flatMap((s) => (inflight[s.id] ?? []).map((x) => ({ server: s, x })))
    .filter(({ server, x }) => !own.length || !x.workerId || ownIds.has(`${server.id}/${x.workerId}`) || !(workers[server.id] ?? []).some((w) => w.id === x.workerId));
  const allWork = shown.flatMap((s) => (work[s.id] ?? []).map((item) => ({ server: s, item })));
  const week = allWork.filter((x) => now - x.item.at <= 7 * DAY).length;
  const lastWeek = allWork.filter((x) => now - x.item.at > 7 * DAY && now - x.item.at <= 14 * DAY).length;
  const rated = allWork.filter((x) => x.item.rating);
  const usefulPct = rated.length ? Math.round((rated.filter((x) => x.item.rating!.useful).length / rated.length) * 100) : null;
  const spent = shown.reduce((n, s) => n + (today[s.id]?.spend.spentUSD ?? 0), 0);
  const projected = shown.reduce((n, s) => n + (today[s.id]?.spend.projectedUSD ?? 0), 0);
  const budgets = counted.reduce((n, { w }) => n + w.budgetUSDPerMonth, 0);
  const delivered = shown.flatMap((s) => (today[s.id]?.delivered ?? []).map((item) => ({ server: s, item }))).sort((a, b) => b.item.at - a.item.at).slice(0, 8);
  const me = shown[0]?.me?.name?.split(/\s+/)[0];
  const hour = new Date().getHours();
  const hello = hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';
  const open = (sel: OrgSelection) => select(sel);

  if (loaded && !servers.length) {
    return (
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-8 pt-10">
        <div className="max-w-2xl">
          <div className="text-xs font-semibold uppercase tracking-widest text-accent">overgo</div>
          <h1 className="mt-2 text-3xl font-semibold tracking-tight text-ink">Workers for your whole team, not just this Mac.</h1>
          <p className="mt-3 text-sm leading-relaxed text-ink-muted">
            overgo is the server side of overcli: it runs AI workers for everyone on your team, around the clock. People ask them in Slack or here; managers approve what they do; and you can watch, rate, tune and manage every one of them from this tab, or let your Claude chats work with them (each change asks you first).
          </p>
          <ul className="mt-4 grid grid-cols-1 gap-2 text-sm text-ink sm:grid-cols-2">
            <li className={card + ' px-4 py-3'}>Share a worker you built here with your team</li>
            <li className={card + ' px-4 py-3'}>Answer and approve what they need from you, in one place</li>
            <li className={card + ' px-4 py-3'}>See how each one is doing, and improve it with Claude</li>
            <li className={card + ' px-4 py-3'}>Hand a worker's browser or design step to your desktop</li>
          </ul>
          <div className="mt-6 flex flex-wrap gap-2">
            <button onClick={() => openSheet({ type: 'settings', section: 'org' })} className={primary}>Sign in to your org</button>
            <button onClick={() => openSheet({ type: 'settings', section: 'org' })} className={btn}>Set up an overgo server</button>
          </div>
          <p className="mt-3 text-xs text-ink-faint">Someone on your team already runs one? Paste the invite link they sent under Settings → overgo.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-8 pb-12 pt-7">
      <header className="flex flex-wrap items-center gap-4">
        <div className="min-w-[320px] flex-1">
          <div className="text-xs text-ink-faint">
            <span className="font-semibold uppercase tracking-widest text-accent">overgo</span>
            {shown.length === 1 && shown[0].name ? ` · ${shown[0].name}` : ''} · {new Date().toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' })}
          </div>
          <h1 className="mt-1 text-2xl font-semibold tracking-tight text-ink">
            {hello}{me ? `, ${me}` : ''}.{' '}
            {!loaded ? 'Asking your org servers…' : `${needs ? `${needs} ${needs === 1 ? 'thing needs' : 'things need'} you` : 'Nothing needs you'}; ${live.length ? `${live.length} ${live.length === 1 ? 'worker is' : 'workers are'} on it now` : 'nobody is working right now'}.`}
          </h1>
        </div>
        {many && (
          <div className="flex flex-wrap gap-1" role="tablist" aria-label="Which org">
            {[{ id: 'all', label: 'All orgs' }, ...servers.map((s) => ({ id: s.id, label: s.name ?? s.url }))].map((o) => (
              <button key={o.id} role="tab" aria-selected={filter === o.id} onClick={() => setFilter(o.id)} className={'rounded-full border px-2.5 py-0.5 text-[11px] ' + (filter === o.id ? 'border-accent bg-accent/10 text-ink' : 'border-card-strong text-ink-muted hover:text-ink')}>
                {o.label}
              </button>
            ))}
          </div>
        )}
        <button onClick={() => void refresh()} disabled={loading} className="text-[11px] text-ink-muted hover:text-ink disabled:opacity-50" title={refreshedAt ? `Updated ${ago(refreshedAt)}` : undefined}>
          {loading ? 'Refreshing…' : 'Refresh'}
        </button>
        {shown[0] && (
          <a href={shown[0].url} target="_blank" rel="noreferrer" className={btn}>Hire a worker ↗</a>
        )}
      </header>

      {shown.filter((s) => errors[s.id]).map((s) => (
        <div key={s.id} role="alert" className="mt-4 rounded-md border border-red-400/40 bg-red-500/5 px-3 py-2 text-xs text-red-700 dark:text-red-300">
          <span className="font-medium">{s.name ?? s.url}:</span> {errors[s.id]}
        </div>
      ))}

      <AskBar roster={roster} />

      <section aria-label="At a glance" className="mt-5 grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-5">
        <Kpi label="Needs you" value={String(needs)} sub={needs && oldest < Infinity ? `oldest ${ago(oldest).replace(' ago', '')}` : 'all clear'} tone={needs ? 'text-amber-600 dark:text-amber-300' : undefined} />
        <Kpi label="Working now" value={String(live.length)} sub={live.length ? [...new Set(live.map((l) => l.x.who))].slice(0, 3).join(', ') : 'all idle'} />
        <Kpi label="Delivered, 7 days" value={String(week)} sub={lastWeek ? `${week >= lastWeek ? '▲' : '▼'} ${Math.abs(Math.round(((week - lastWeek) / lastWeek) * 100))}% on last week` : 'first week counted'} tone={lastWeek && week >= lastWeek ? 'text-emerald-700 dark:text-emerald-300' : undefined} />
        <Kpi label="Rated useful" value={usefulPct === null ? '—' : `${usefulPct}%`} sub={rated.length ? `of ${rated.length} rated` : 'rate what they deliver'} />
        <Kpi label="Spend, month" value={money(spent)} sub={projected ? `→ about ${money(projected)} by month end` : budgets ? `of ${money(budgets)} budgets` : ''} />
      </section>

      <div className="mt-6 flex flex-wrap items-start gap-6">
        <div className="flex min-w-0 flex-[999_1_640px] flex-col gap-7">
          <section>
            <h2 className="mb-2.5 text-sm font-semibold text-ink">Needs you{needs ? <span className="ml-1.5 font-normal text-ink-faint">{needs}</span> : null}</h2>
            {needs ? (
              <div className="flex flex-col gap-2">
                {forDesk.map(({ server, task }) => <DesktopTaskCard key={`${server.id}/${task.id}`} server={server} task={task} showServer={many} onDone={() => void refresh()} />)}
                {inbox.map(({ server, item }) => <WaitingCard key={`${server.id}/${item.runId}/${item.stepId}`} server={server} item={item} showServer={many} onDone={() => void refresh()} />)}
                {proposed.map(({ server, batch }) => <ProposalCard key={`${server.id}/${batch.batchId}`} server={server} batch={batch} showServer={many} onDone={() => void refresh()} />)}
              </div>
            ) : (
              <div className={card + ' px-4 py-3 text-sm text-ink-muted'}>All clear. Questions, approvals and proposed work land here.</div>
            )}
          </section>

          {live.length > 0 && (
            <section>
              <h2 className="mb-2.5 text-sm font-semibold text-ink">Working now <span className="font-normal text-ink-faint">{live.length}</span></h2>
              <div className="grid grid-cols-[repeat(auto-fill,minmax(300px,1fr))] gap-3">
                {live.map(({ server, x }) => {
                  const w = x.workerId ? (workers[server.id] ?? []).find((y) => y.id === x.workerId) : undefined;
                  const pct = x.total ? Math.round(((x.at + (x.needsYou ? 0 : 0.5)) / x.total) * 100) : 0;
                  return (
                    <button key={`${server.id}/${x.id}`} disabled={!w} onClick={() => w && open({ serverId: server.id, workerId: w.id, ...(x.kind === 'worker' ? { runId: x.id } : {}) })} className={card + ' block p-3.5 text-left hover:border-card-strong disabled:cursor-default'}>
                      <div className="flex items-center gap-2 text-xs text-ink-muted">
                        {w ? <Face worker={w} size={20} square /> : null}
                        <span className="font-semibold text-ink">{x.who}</span> · {ago(x.since)}
                        {x.needsYou && <span className="ml-auto rounded bg-amber-500/15 px-1.5 text-[10px] text-amber-700 dark:text-amber-300">needs you</span>}
                      </div>
                      <div className="mt-1.5 line-clamp-2 text-sm text-ink">{x.title}</div>
                      <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-card-strong"><div className="h-full bg-accent" style={{ width: `${Math.min(100, pct)}%` }} /></div>
                      <div className="mt-1 text-[11px] text-ink-faint">{x.now}</div>
                    </button>
                  );
                })}
              </div>
            </section>
          )}

          <section>
            <div className="mb-2.5 flex items-baseline gap-2">
              <h2 className="text-sm font-semibold text-ink">Delivered lately</h2>
              <span className="text-xs text-ink-faint">rate them: it’s how they learn</span>
            </div>
            {delivered.length ? (
              <div className={card + ' overflow-hidden'}>
                {delivered.map(({ server, item }) => (
                  <Delivered key={`${server.id}/${item.entryId}`} server={server} item={item} worker={(workers[server.id] ?? []).find((w) => w.id === item.workerId)} onOpen={(w) => open({ serverId: server.id, workerId: w.id, ...(item.runId ? { runId: item.runId } : {}) })} />
                ))}
              </div>
            ) : (
              <div className={card + ' px-4 py-3 text-sm text-ink-muted'}>Nothing delivered since yesterday.</div>
            )}
          </section>

          <TeamSection own={own} others={others} team={team} setTeam={setTeam} trends={trends} many={many} onOpen={open} />
        </div>

        <aside className="sticky top-4 flex max-w-[380px] flex-[1_1_320px] flex-col gap-3.5">
          <WorthALook shown={shown} workers={workers} trends={trends} today={today} onOpen={open} />
          <div className={card + ' p-4'}>
            <div className={label}>Spend this month</div>
            <div className="mt-2 flex items-baseline gap-1.5"><span className="text-2xl font-semibold text-ink">{money(spent)}</span>{budgets ? <span className="text-sm text-ink-muted">of {money(budgets)} budgets</span> : null}</div>
            {projected > 0 && <div className="mt-1 text-xs text-ink-muted">On track for about <b className="text-ink">{money(projected)}</b> by month end</div>}
            <div className="mt-3 flex flex-col gap-1.5">
              {[...counted].sort((a, b) => b.w.spentThisMonthUSD - a.w.spentThisMonthUSD).slice(0, 5).map(({ server, w }, i, all) => (
                <button key={`${server.id}/${w.id}`} onClick={() => open({ serverId: server.id, workerId: w.id, tab: 'settings' })} className="flex items-center gap-2 text-left text-xs">
                  <span className="w-20 truncate text-ink">{w.name}</span>
                  <span className="h-1.5 flex-1 overflow-hidden rounded-full bg-card-strong"><span className={'block h-full ' + (w.spentThisMonthUSD / Math.max(1, w.budgetUSDPerMonth) > 0.8 ? 'bg-red-400' : 'bg-accent')} style={{ width: `${(w.spentThisMonthUSD / Math.max(0.01, all[0].w.spentThisMonthUSD)) * 100}%` }} /></span>
                  <span className="w-14 text-right text-ink-muted">{money(w.spentThisMonthUSD)}</span>
                </button>
              ))}
            </div>
          </div>
          <ComingUp roster={roster} onOpen={open} />
        </aside>
      </div>
    </div>
  );
}

/// The team as cards: yours, filterable, then the workers shared with you
/// (or, for an admin, everyone else's) under a heading that folds.
function TeamSection({ own, others, team, setTeam, trends, many, onOpen }: { own: Row[]; others: Row[]; team: Filter; setTeam: (f: Filter) => void; trends: Record<string, { runs: string[]; verdict: string; open: number }>; many: boolean; onOpen: (s: OrgSelection) => void }) {
  const [open, flip] = useOthersOpen('home', others.length, own.length > 0);
  const keep = ({ server, w }: Row) => team === 'all' || (team === 'needs' && w.waiting > 0) || (team === 'working' && w.state === 'working') || (team === 'worse' && trends[`${server.id}/${w.id}`]?.verdict === 'worse');
  const cards = (rows: Row[]) => (
    <div className="grid grid-cols-[repeat(auto-fill,minmax(300px,1fr))] gap-3">
      {sortTeam(rows)
        .filter(keep)
        .map(({ server, w }) => (
          <TeamCard key={`${server.id}/${w.id}`} server={many ? server : undefined} w={w} trend={trends[`${server.id}/${w.id}`]} onOpen={() => onOpen({ serverId: server.id, workerId: w.id })} />
        ))}
    </div>
  );
  const shownOthers = others.filter(keep);
  const othersName = othersLabel(others.map(({ w }) => w));
  return (
    <>
      <section>
        <div className="mb-2.5 flex flex-wrap items-center gap-2">
          <h2 className="mr-2 text-sm font-semibold text-ink">{own.length ? 'Your workers' : othersName}</h2>
          {([['all', `All ${own.length || others.length}`], ['needs', 'Needs you'], ['working', 'Working'], ['worse', 'Worse lately']] as const).map(([id, l]) => (
            <button key={id} onClick={() => setTeam(id)} aria-pressed={team === id} className={'rounded-full border px-2.5 py-0.5 text-[11px] ' + (team === id ? 'border-accent bg-accent/10 text-ink' : 'border-card-strong text-ink-muted hover:text-ink')}>{l}</button>
          ))}
        </div>
        {cards(own.length ? own : others)}
        {own.length > 0 && !own.some(keep) && <div className={card + ' px-4 py-3 text-sm text-ink-muted'}>None of yours right now.</div>}
      </section>
      {own.length > 0 && others.length > 0 && (
        <section>
          <button type="button" onClick={flip} aria-expanded={open} className="mb-2.5 flex items-center gap-1.5 text-sm font-semibold text-ink">
            <span aria-hidden className={'inline-block text-ink-faint transition-transform ' + (open ? 'rotate-90' : '')}>›</span>
            {othersName}
            <span className="font-normal text-ink-faint">{team === 'all' ? others.length : `${shownOthers.length} of ${others.length}`}</span>
            <span className="ml-1 text-xs font-normal text-ink-faint">{others.every(({ w }) => w.youManage) ? 'as an admin, you can change these' : 'you can ask these; changes are their managers’'}</span>
          </button>
          {open && cards(others)}
        </section>
      )}
    </>
  );
}

function Kpi({ label: l, value, sub, tone }: { label: string; value: string; sub: string; tone?: string }) {
  return (
    <div className={card + ' px-4 py-3.5'}>
      <div className={label}>{l}</div>
      <div className="mt-1.5 text-2xl font-semibold text-ink">{value}</div>
      <div className={'mt-0.5 truncate text-xs ' + (tone ?? 'text-ink-muted')}>{sub}</div>
    </div>
  );
}

type Row = { server: OrgServerStatus; w: OrgWorker };

/// Those that need you first, then those working, then the rest by name.
function sortTeam(rows: Row[]): Row[] {
  const rank = (w: OrgWorker) => (w.waiting > 0 ? 0 : w.state === 'working' ? 1 : w.state === 'stuck' ? 2 : w.enabled ? 3 : 4);
  return [...rows].sort((a, b) => rank(a.w) - rank(b.w) || a.w.name.localeCompare(b.w.name));
}

/// Ask any worker, from the top of the page: the answer lands in its
/// conversation, which a link opens.
function AskBar({ roster }: { roster: Row[] }) {
  const select = useOrgTab((s) => s.select);
  const choices = sortTeam(roster).filter(({ w }) => w.enabled);
  const [who, setWho] = useState('');
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string; to?: Row } | null>(null);
  const pick = choices.find(({ server, w }) => `${server.id}/${w.id}` === who) ?? choices.find(({ w }) => isYours(w)) ?? choices[0];
  const send = () => {
    if (!pick || !text.trim()) return;
    setBusy(true);
    void orgCall(pick.server.id, 'POST', '/api/ask', { worker: pick.w.id, message: text.trim() }).then((r) => {
      setBusy(false);
      if (!r.ok) return setMsg({ ok: false, text: r.error });
      setText('');
      setMsg({ ok: true, text: `Sent to ${pick.w.name}. The answer lands in its conversation.`, to: pick });
    });
  };
  if (!choices.length) return null;
  return (
    <div className="mt-5">
      <div className="flex flex-wrap items-center gap-3 rounded-2xl border border-card-strong bg-card px-4 py-3">
        <label htmlFor="org-ask-any" className="sr-only">Ask a worker</label>
        <input
          id="org-ask-any"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') send(); }}
          placeholder="Ask a worker anything: “why is checkout tax wrong?”, “triage today’s bugs”…"
          className="min-w-[280px] flex-1 border-0 bg-transparent text-sm text-ink outline-none placeholder:text-ink-faint"
        />
        <span className="text-xs text-ink-faint">to</span>
        <select aria-label="Which worker" value={pick ? `${pick.server.id}/${pick.w.id}` : ''} onChange={(e) => setWho(e.target.value)} className="rounded-lg border border-card-strong bg-surface px-2 py-1.5 text-xs text-ink">
          {choices.map(({ server, w }) => <option key={`${server.id}/${w.id}`} value={`${server.id}/${w.id}`}>{w.name}{w.tagline ? ` · ${w.tagline.slice(0, 40)}` : ''}</option>)}
        </select>
        <button disabled={busy || !text.trim()} onClick={send} className={primary}>{busy ? 'Sending…' : 'Ask'}</button>
      </div>
      {msg && (
        <div role="status" className={'mt-1.5 text-xs ' + (msg.ok ? 'text-ink-muted' : 'text-red-700 dark:text-red-300')}>
          {msg.text} {msg.to && <button className="text-accent hover:underline" onClick={() => select({ serverId: msg.to!.server.id, workerId: msg.to!.w.id })}>Open {msg.to.w.name}</button>}
        </div>
      )}
    </div>
  );
}

function Delivered({ server, item, worker, onOpen }: { server: OrgServerStatus; item: OrgWorkItem; worker?: OrgWorker; onOpen: (w: OrgWorker) => void }) {
  const [rated, setRated] = useState<boolean | null>(item.rating ? item.rating.useful : null);
  const [busy, setBusy] = useState(false);
  const rate = (useful: boolean) => {
    setBusy(true);
    void orgCall(server.id, 'POST', '/api/rate', { entryId: item.entryId, useful }).then((r) => {
      setBusy(false);
      if (r.ok) setRated(useful);
    });
  };
  return (
    <div className="flex items-center gap-3 border-b border-card px-4 py-3 last:border-b-0">
      {worker ? <Face worker={worker} size={28} square /> : null}
      <button disabled={!worker} onClick={() => worker && onOpen(worker)} className="min-w-0 flex-1 text-left">
        <div className="truncate text-sm text-ink"><b>{item.workerName}</b> {item.title}</div>
        <div className="text-[11px] text-ink-faint">{ago(item.at)}{item.costUSD ? ` · ${money(item.costUSD)}` : ''}{item.summary ? ` · ${item.summary.slice(0, 120)}` : ''}</div>
      </button>
      {rated === null ? (
        <>
          <button disabled={busy} className={btn} onClick={() => rate(true)}>Useful</button>
          <button disabled={busy} className={btn} onClick={() => rate(false)}>Not useful</button>
        </>
      ) : (
        <span className={'text-[11px] ' + (rated ? 'text-emerald-700 dark:text-emerald-300' : 'text-ink-muted')}>{rated ? 'rated useful' : 'rated not useful'}</span>
      )}
    </div>
  );
}

function TeamCard({ server, w, trend, onOpen }: { server?: OrgServerStatus; w: OrgWorker; trend?: { runs: string[]; verdict: string; open: number }; onOpen: () => void }) {
  const pct = w.budgetUSDPerMonth > 0 ? Math.min(100, (w.spentThisMonthUSD / w.budgetUSDPerMonth) * 100) : 0;
  const runs = trend?.runs ?? [];
  return (
    <button onClick={onOpen} className={card + ' flex flex-col gap-2.5 p-4 text-left hover:border-card-strong'}>
      <div className="flex items-center gap-3">
        <Face worker={w} size={36} square />
        <div className="min-w-0 flex-1">
          <div className="font-semibold text-ink">{w.name}{server ? <span className="ml-1.5 text-[10px] font-normal text-ink-faint">{server.name ?? server.url}</span> : null}</div>
          <div className="truncate text-[11px] text-ink-muted">{w.tagline || w.schedule}</div>
        </div>
        <span className={'flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[10px] font-medium ' + (w.waiting > 0 ? 'bg-amber-500/15 text-amber-700 dark:text-amber-300' : 'bg-card-strong text-ink-muted')}>
          <span className={'h-1.5 w-1.5 rounded-full ' + STATE_DOT[w.state]} />
          {w.waiting > 0 ? `${w.waiting} for you` : STATE_LABEL[w.state]}
        </span>
      </div>
      <div className="flex h-4 gap-[3px]" aria-label={runs.length ? `Last ${runs.length} runs` : 'No runs scored yet'}>
        {runs.length ? runs.map((r, i) => <span key={i} className={'w-2 rounded-[2px] ' + (RUN[r] ?? 'bg-card-strong')} />) : Array.from({ length: 12 }, (_, i) => <span key={i} className="w-2 rounded-[2px] bg-card-strong" />)}
      </div>
      <div className="flex justify-between text-[11px] text-ink-faint">
        <span className={trend?.verdict === 'worse' ? 'text-red-700 dark:text-red-300' : trend?.verdict === 'better' ? 'text-emerald-700 dark:text-emerald-300' : ''}>{trend ? VERDICT[trend.verdict] : 'Reading its runs…'}</span>
        <span>{w.last30.lastRun ? `last run ${ago(w.last30.lastRun.at)}` : 'no runs yet'}</span>
      </div>
      <div>
        <div className="flex justify-between text-[11px] text-ink-muted"><span>{money(w.spentThisMonthUSD)} of {money(w.budgetUSDPerMonth)}</span>{trend?.open ? <span className="text-accent">{trend.open} suggestions</span> : null}</div>
        <div className="mt-1 h-1 overflow-hidden rounded-full bg-card-strong"><div className={'h-full ' + (pct >= 80 ? 'bg-red-400' : 'bg-accent')} style={{ width: `${pct}%` }} /></div>
      </div>
    </button>
  );
}

/// What needs managing, each with the one thing to do about it.
function WorthALook({ shown, workers, trends, today, onOpen }: { shown: OrgServerStatus[]; workers: Record<string, OrgWorker[]>; trends: Record<string, { verdict: string; open: number }>; today: Record<string, { toolTrouble?: Array<{ name: string; detail?: string }> }>; onOpen: (s: OrgSelection) => void }) {
  const items: Array<{ key: string; tone: string; who: string; what: string; action: string; go: () => void }> = [];
  for (const s of shown) {
    for (const w of workers[s.id] ?? []) {
      const t = trends[`${s.id}/${w.id}`];
      const at = { serverId: s.id, workerId: w.id };
      if (w.state === 'stuck') items.push({ key: `${s.id}/${w.id}/stuck`, tone: 'bg-red-400', who: w.name, what: 'is stuck.', action: 'Open it', go: () => onOpen(at) });
      if (t?.verdict === 'worse') items.push({ key: `${s.id}/${w.id}/worse`, tone: 'bg-red-400', who: w.name, what: 'is doing worse since its last change.', action: 'Improve it on Tuning', go: () => onOpen({ ...at, tab: 'tuning' }) });
      if (w.budgetUSDPerMonth > 0 && w.spentThisMonthUSD / w.budgetUSDPerMonth >= 0.8) items.push({ key: `${s.id}/${w.id}/budget`, tone: 'bg-amber-400', who: w.name, what: `has spent ${money(w.spentThisMonthUSD)} of its ${money(w.budgetUSDPerMonth)}.`, action: 'Check its budget', go: () => onOpen({ ...at, tab: 'settings' }) });
      if (t?.open) items.push({ key: `${s.id}/${w.id}/open`, tone: 'bg-accent', who: w.name, what: `has ${t.open} ${t.open === 1 ? 'suggestion' : 'suggestions'} from overgo waiting.`, action: 'See them on Tuning', go: () => onOpen({ ...at, tab: 'tuning' }) });
      const broken = (w.tools ?? []).filter((x) => !x.ok).map((x) => x.name);
      if (broken.length) items.push({ key: `${s.id}/${w.id}/tools`, tone: 'bg-amber-400', who: w.name, what: `can’t reach ${broken.join(', ')}.`, action: 'Check its tools', go: () => onOpen({ ...at, tab: 'settings' }) });
    }
    for (const t of today[s.id]?.toolTrouble ?? []) items.push({ key: `${s.id}/tool/${t.name}`, tone: 'bg-amber-400', who: t.name, what: t.detail ?? 'is failing.', action: 'Fix on the console', go: () => window.open(s.url, '_blank') });
  }
  return (
    <div className={card + ' p-4'}>
      <div className={label}>Worth a look</div>
      <div className="mt-3 flex flex-col gap-3">
        {items.slice(0, 8).map((i) => (
          <button key={i.key} onClick={i.go} className="flex gap-2.5 text-left text-sm">
            <span className={'mt-1.5 h-2 w-2 flex-shrink-0 rounded-full ' + i.tone} />
            <span className="text-ink"><b>{i.who}</b> {i.what}<span className="mt-0.5 block text-xs text-accent">{i.action} →</span></span>
          </button>
        ))}
        {!items.length && <div className="text-sm text-ink-muted">Nothing: every worker is steady, in budget and reaching its tools.</div>}
      </div>
    </div>
  );
}

function ComingUp({ roster, onOpen }: { roster: Row[]; onOpen: (s: OrgSelection) => void }) {
  const next = roster.filter(({ w }) => w.enabled && w.nextRunAt).sort((a, b) => (a.w.nextRunAt ?? 0) - (b.w.nextRunAt ?? 0)).slice(0, 6);
  return (
    <div className={card + ' p-4'}>
      <div className={label}>Coming up</div>
      <div className="mt-2.5 flex flex-col gap-2">
        {next.map(({ server, w }) => (
          <button key={`${server.id}/${w.id}`} onClick={() => onOpen({ serverId: server.id, workerId: w.id })} className="flex gap-2 text-left text-xs">
            <span className="w-24 flex-shrink-0 text-ink-faint">{new Date(w.nextRunAt!).toLocaleString(undefined, { weekday: 'short', hour: '2-digit', minute: '2-digit' })}</span>
            <span className="text-ink"><b>{w.name}</b> · {w.schedule}</span>
          </button>
        ))}
        {!next.length && <div className="text-xs text-ink-muted">Nothing scheduled: every worker works when asked.</div>}
      </div>
    </div>
  );
}
