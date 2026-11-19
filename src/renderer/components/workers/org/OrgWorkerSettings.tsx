// An org worker's settings, as the console has them: General (name, picture,
// its job with an AI rewrite you read over, who it answers to, when it runs,
// budget), Access (who can ask it, whose asks start straight away, who
// approves the rest, how much it does alone), Tools and how it works, Slack,
// Pull requests (admin), History (restore) and Pause or let go. One save bar
// lists what changed; only those go to the server, which decides who may
// change what.

import { useEffect, useMemo, useState } from 'react';
import type { OrgServerStatus } from '@shared/types';
import { ago, enc, money, orgCall, useDirectoryData, useOrgTab, type OrgWorker } from './orgTabStore';
import { Face } from './OrgPane';

type Audience = { people?: string[]; groups?: string[]; roles?: string[] };
type Cadence = { kind: 'daily'; time: string; days?: number[] } | { kind: 'interval'; everyMinutes: number; days?: number[] } | null;
type Scope = { mode: 'read' | 'only'; calls?: string[] };

export interface SettingsWorker extends OrgWorker {
  formerNames?: string[];
  managerSlackUserId?: string;
  cadence?: Cadence;
  audience?: Audience;
  startAudience?: Audience;
  approvers?: Audience;
  anyoneMayStart?: boolean;
  continueOpenPrs?: boolean;
  desktopHandOff?: boolean;
  skipCheckpoints?: boolean;
  prAuthors?: string[];
  prCommentAuthors?: string[];
  alwaysAllow?: string[];
  writesCode?: boolean;
  slackHomeChannels?: string[];
  canDelegate?: boolean;
  delegatesTo?: Array<{ id: string; name: string }>;
  answersAtOnce?: number;
  role?: string;
  tools?: Array<{ name: string; ok: boolean; scope?: Scope; scopeFrom?: 'default' | 'own'; fromRole?: string }>;
  place?: { kind: 'repo' | 'workspace' | 'folder'; name: string; repos?: string[] };
}
export interface SettingsDetail {
  worker: SettingsWorker;
  jobDescription: string;
  flows?: Array<{ id: string; name: string }>;
  preferredFlowId?: string;
}

const card = 'rounded-xl border border-card bg-card p-6';
const field = 'w-full rounded-lg border border-card-strong bg-surface px-3 py-2 text-sm text-ink disabled:opacity-60';
const btn = 'inline-flex min-h-[32px] items-center gap-1.5 rounded-lg border border-card-strong bg-surface px-3 py-1.5 text-xs font-medium text-ink hover:bg-card-strong disabled:opacity-50';
const primary = 'inline-flex min-h-[34px] items-center gap-1.5 rounded-lg bg-accent px-3.5 py-1.5 text-xs font-semibold text-white disabled:opacity-50';
const hint = 'text-xs text-ink-muted';

const SECTIONS = [
  ['general', 'General'],
  ['access', 'Access'],
  ['tools', 'Tools and how it works'],
  ['desktop', 'Your desktop'],
  ['slack', 'Answering in Slack'],
  ['prs', 'Pull requests'],
  ['history', 'History'],
  ['letgo', 'Pause or let go'],
] as const;

interface Form {
  name: string;
  tagline: string;
  avatarUrl: string;
  job: string;
  manager: string;
  reportsTo: string;
  ask: 'private' | 'team' | 'org' | 'picked';
  audience: Audience;
  start: 'manager' | 'anyone' | 'picked';
  startAudience: Audience;
  approve: 'manager' | 'picked';
  approvers: Audience;
  trust: 'probation' | 'trusted' | 'autonomous';
  when: 'asked' | 'daily' | 'every';
  time: string;
  every: string;
  budget: string;
  role: string;
  tools: string[];
  scopes: Record<string, 'full' | 'read' | 'only'>;
  writesCode: 'flows' | 'yes' | 'no';
  flow: string;
  answersAtOnce: string;
  homeChannels: string[];
  desktopHandOff: boolean;
  continueOpenPrs: boolean;
  prAuthors: string;
  prCommentAuthors: string;
  skipCheckpoints: boolean;
  alwaysAllow: string[];
  canDelegate: boolean;
  delegatesTo: string[];
}

const LABELS: Partial<Record<keyof Form, string>> = {
  name: 'Name', tagline: 'What it does', avatarUrl: 'Picture', job: 'Its job', manager: 'Manager', reportsTo: 'Reports to', ask: 'Who can ask it', audience: 'Who can ask it',
  start: 'Starts work for', startAudience: 'Starts work for', approve: 'Approves the rest', approvers: 'Approves the rest', trust: 'Trust', when: 'When it runs', time: 'When it runs',
  every: 'When it runs', budget: 'Budget', role: 'Role', tools: 'Tools', scopes: 'Tools', writesCode: 'Writes code', flow: 'Preferred flow', answersAtOnce: 'Conversations at once',
  homeChannels: 'Home channels', desktopHandOff: 'Your desktop', continueOpenPrs: 'Team pull requests', prAuthors: 'Team pull requests', prCommentAuthors: 'Team pull requests', skipCheckpoints: 'Checkpoints', alwaysAllow: 'Always allowed',
  canDelegate: 'Handing work on', delegatesTo: 'Handing work on',
};

function formOf(d: SettingsDetail): Form {
  const w = d.worker;
  const c = w.cadence ?? null;
  const scopes: Form['scopes'] = {};
  for (const t of w.tools ?? []) scopes[t.name] = t.scope?.mode ?? 'full';
  return {
    name: w.name,
    tagline: w.tagline ?? '',
    avatarUrl: w.avatarUrl ?? '',
    job: d.jobDescription,
    manager: w.managerSlackUserId ?? '',
    reportsTo: w.reportsTo?.id ?? '',
    ask: w.audience && !emptyAudience(w.audience) ? 'picked' : w.visibility,
    audience: w.audience ?? {},
    start: w.anyoneMayStart ? 'anyone' : w.startAudience ? 'picked' : 'manager',
    startAudience: w.startAudience ?? {},
    approve: w.approvers ? 'picked' : 'manager',
    approvers: w.approvers ?? {},
    trust: w.trust,
    when: c?.kind === 'daily' ? 'daily' : c?.kind === 'interval' ? 'every' : 'asked',
    time: c?.kind === 'daily' ? c.time : '09:00',
    every: c?.kind === 'interval' ? String(c.everyMinutes) : '60',
    budget: String(w.budgetUSDPerMonth),
    role: w.role ?? '',
    tools: (w.tools ?? []).filter((t) => !t.fromRole).map((t) => t.name),
    scopes,
    writesCode: w.writesCode === undefined ? 'flows' : w.writesCode ? 'yes' : 'no',
    flow: d.preferredFlowId ?? '',
    answersAtOnce: String(w.answersAtOnce ?? 1),
    homeChannels: w.slackHomeChannels ?? [],
    desktopHandOff: !!w.desktopHandOff,
    continueOpenPrs: !!w.continueOpenPrs,
    prAuthors: (w.prAuthors ?? []).join(', '),
    prCommentAuthors: (w.prCommentAuthors ?? []).join(', '),
    skipCheckpoints: !!w.skipCheckpoints,
    alwaysAllow: w.alwaysAllow ?? [],
    canDelegate: !!w.canDelegate,
    delegatesTo: (w.delegatesTo ?? []).map((x) => x.id),
  };
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const list = (s: string) => s.split(',').map((x) => x.trim()).filter(Boolean);
const emptyAudience = (a: Audience) => !(a.people?.length || a.groups?.length || a.roles?.length);

/// What changed, as the server's update and trust calls take it.
export function patchOf(f: Form, i: Form): { patch: Record<string, unknown>; trust?: string; error?: string } {
  const patch: Record<string, unknown> = {};
  if (f.name.trim() !== i.name.trim()) patch.name = f.name.trim();
  if (f.tagline !== i.tagline) patch.tagline = f.tagline;
  if (f.avatarUrl !== i.avatarUrl) patch.avatarUrl = f.avatarUrl.trim() || null;
  if (f.job.trim() !== i.job.trim()) patch.jobDescription = f.job.trim();
  if (f.reportsTo !== i.reportsTo) patch.reportsTo = f.reportsTo || null;
  if (f.ask !== i.ask || !same(f.audience, i.audience)) {
    if (f.ask === 'picked') {
      if (emptyAudience(f.audience)) return { patch, error: 'Pick at least one person, group or role who can ask it.' };
      patch.audience = f.audience;
    } else {
      patch.audience = null;
      patch.visibility = f.ask;
    }
  }
  if (f.start !== i.start || !same(f.startAudience, i.startAudience)) {
    patch.anyoneMayStart = f.start === 'anyone';
    patch.startAudience = f.start === 'picked' ? f.startAudience : null;
    if (f.start === 'picked' && emptyAudience(f.startAudience)) return { patch, error: 'Pick whose asks it starts on straight away.' };
  }
  if (f.approve !== i.approve || !same(f.approvers, i.approvers)) patch.approvers = f.approve === 'picked' && !emptyAudience(f.approvers) ? f.approvers : null;
  if (f.when !== i.when || f.time !== i.time || f.every !== i.every) {
    const every = Number(f.every);
    if (f.when === 'every' && !(every >= 30)) return { patch, error: 'Every N minutes needs 30 or more.' };
    patch.cadence = f.when === 'asked' ? null : f.when === 'daily' ? { kind: 'daily', time: f.time } : { kind: 'interval', everyMinutes: Math.round(every) };
  }
  if (f.budget !== i.budget) {
    const n = Number(f.budget);
    if (!(n > 0)) return { patch, error: 'The budget should be a number of dollars above zero.' };
    patch.budgetUSDPerMonth = n;
  }
  if (f.role !== i.role) patch.role = f.role || null;
  if (!same(f.tools, i.tools)) patch.mcpServers = f.tools;
  if (!same(f.scopes, i.scopes)) {
    const scopes: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(f.scopes)) if (v !== i.scopes[k] && v !== 'only') scopes[k] = v === 'full' ? null : { mode: 'read' };
    if (Object.keys(scopes).length) patch.toolScopes = scopes;
  }
  if (f.writesCode !== i.writesCode) patch.writesCode = f.writesCode === 'flows' ? null : f.writesCode === 'yes';
  if (f.flow !== i.flow) patch.preferredFlowId = f.flow || null;
  if (f.answersAtOnce !== i.answersAtOnce) patch.answersAtOnce = Number(f.answersAtOnce);
  if (!same(f.homeChannels, i.homeChannels)) patch.slackHomeChannels = f.homeChannels.length ? f.homeChannels : null;
  if (f.desktopHandOff !== i.desktopHandOff) patch.desktopHandOff = f.desktopHandOff;
  if (f.continueOpenPrs !== i.continueOpenPrs) patch.continueOpenPrs = f.continueOpenPrs;
  if (f.prAuthors !== i.prAuthors) patch.prAuthors = list(f.prAuthors);
  if (f.prCommentAuthors !== i.prCommentAuthors) patch.prCommentAuthors = list(f.prCommentAuthors);
  if (f.skipCheckpoints !== i.skipCheckpoints) patch.skipCheckpoints = f.skipCheckpoints;
  if (!same(f.alwaysAllow, i.alwaysAllow)) patch.alwaysAllow = f.alwaysAllow;
  if (f.canDelegate !== i.canDelegate) patch.canDelegate = f.canDelegate;
  if (!same(f.delegatesTo, i.delegatesTo)) patch.delegatesTo = f.delegatesTo.length ? f.delegatesTo : null;
  return { patch, ...(f.trust !== i.trust ? { trust: f.trust } : {}) };
}

export function OrgWorkerSettings({ server, detail, onChanged, top = 0 }: { server: OrgServerStatus; detail: SettingsDetail; onChanged: () => void; top?: number }) {
  const w = detail.worker;
  const admin = server.me?.admin === true;
  const can = w.youManage;
  const initial = useMemo(() => formOf(detail), [detail]);
  const [f, setF] = useState(initial);
  useEffect(() => setF(initial), [initial]);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);
  // An edit after a save starts counting changes again.
  const set = <K extends keyof Form>(k: K, v: Form[K]) => {
    setNote(null);
    setF((x) => ({ ...x, [k]: v }));
  };
  const [section, setSection] = useState<string>('general');
  const dir = useDirectoryData(server.id);
  const workers = useOrgTab((s) => s.workers[server.id]);
  const [roles, setRoles] = useState<string[]>([]);
  useEffect(() => {
    void orgCall(server.id, 'GET', '/api/roles').then((r) => r.ok && Array.isArray(r.data) && setRoles((r.data as Array<{ name: string }>).map((x) => x.name)));
  }, [server.id]);

  const changed = useMemo(() => [...new Set((Object.keys(f) as Array<keyof Form>).filter((k) => !same(f[k], initial[k])).map((k) => LABELS[k] ?? k))], [f, initial]);

  const save = async () => {
    const { patch, trust, error } = patchOf(f, initial);
    if (error) return setNote({ ok: false, text: error });
    if (!Object.keys(patch).length && !trust) return;
    setBusy(true);
    setNote(null);
    const results = await Promise.all([
      Object.keys(patch).length ? orgCall(server.id, 'POST', `/api/workers/${enc(w.id)}/update`, { patch }) : Promise.resolve({ ok: true as const, data: null }),
      trust ? orgCall(server.id, 'POST', `/api/workers/${enc(w.id)}/trust`, { trust }) : Promise.resolve({ ok: true as const, data: null }),
    ]);
    setBusy(false);
    const failed = results.find((r) => !r.ok) as { ok: false; error: string } | undefined;
    setNote(failed ? { ok: false, text: failed.error } : { ok: true, text: 'Saved.' });
    onChanged();
  };

  const go = (id: string) => {
    setSection(id);
    document.getElementById(`org-set-${id}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  return (
    <div className="flex flex-wrap items-start gap-8">
      <nav aria-label="Settings sections" className="sticky flex flex-[0_1_200px] flex-col gap-0.5" style={{ top: top + 16 }}>
        {SECTIONS.map(([id, l]) => (
          <button key={id} onClick={() => go(id)} className={'rounded-lg px-3 py-1.5 text-left text-sm ' + (section === id ? 'bg-card-strong font-medium text-ink' : 'text-ink-muted hover:text-ink')}>
            {l}
            {id === 'prs' && !admin ? <span className="ml-2 text-[10px] text-ink-faint">admin</span> : null}
          </button>
        ))}
      </nav>

      <div className="flex min-w-0 flex-[999_1_600px] flex-col gap-5 pb-24">
        {!can && <div className={card + ' !p-4 text-sm text-ink-muted'}>Only {w.manager ?? 'its manager'} or an admin can change {w.name}. You can see how it’s set up.</div>}

        <fieldset disabled={!can || busy} className="contents">
          <section id="org-set-general" className={card}>
            <h2 className="text-base font-semibold text-ink">General</h2>
            <div className="mt-4 flex flex-wrap items-start gap-6">
              <div className="flex flex-col items-center gap-2">
                <Face worker={{ ...w, avatarUrl: f.avatarUrl || undefined }} size={72} square />
              </div>
              <div className="grid min-w-[300px] flex-1 grid-cols-1 gap-4 md:grid-cols-2">
                <Field id="s-name" label="Name" help="What people call it, in Slack and here. Its old name keeps working.">
                  <input id="s-name" value={f.name} onChange={(e) => set('name', e.target.value)} className={field} />
                </Field>
                <Field id="s-tag" label="What it does, in a line" help="The line under its name, here and wherever it is listed.">
                  <input id="s-tag" value={f.tagline} onChange={(e) => set('tagline', e.target.value)} className={field} />
                </Field>
                <Field id="s-pic" label="Picture" help="A link to an image, or leave it empty for initials. Pick from the console’s gallery there.">
                  <input id="s-pic" value={f.avatarUrl} onChange={(e) => set('avatarUrl', e.target.value)} placeholder="https://…" className={field} />
                </Field>
              </div>
            </div>
            <JobEditor serverId={server.id} workerId={w.id} name={w.name} job={f.job} initial={initial.job} onJob={(j) => set('job', j)} disabled={!can} />
            <div className="mt-6 grid grid-cols-1 gap-6 border-t border-card pt-5 md:grid-cols-2">
              <div className="flex flex-col gap-3">
                <SubHead title="Who it answers to" help="Its questions and approvals go here, climbing the chain if its boss can’t answer." />
                <Field id="s-mgr" label="Manager" help={admin ? undefined : 'Handing it to someone else is an admin’s call.'}>
                  <input id="s-mgr" disabled value={w.manager ?? 'No manager'} className={field} />
                </Field>
                <Field id="s-rep" label="Reports to (another worker)">
                  <select id="s-rep" value={f.reportsTo} onChange={(e) => set('reportsTo', e.target.value)} className={field}>
                    <option value="">Nobody, it’s at the top</option>
                    {(workers ?? []).filter((x) => x.id !== w.id).map((x) => (
                      <option key={x.id} value={x.id}>{x.name}</option>
                    ))}
                  </select>
                </Field>
              </div>
              <div className="flex flex-col gap-3">
                <SubHead title="When it runs" help="On its own schedule, or only when someone asks. In the org’s time zone." />
                <Segmented value={f.when} onChange={(v) => set('when', v)} options={[['asked', 'Only when asked'], ['daily', 'Every day'], ['every', 'Every N minutes']]} label="When it runs" />
                {f.when === 'daily' && <input aria-label="Time of day" type="time" value={f.time} onChange={(e) => set('time', e.target.value)} className={field + ' w-32'} />}
                {f.when === 'every' && (
                  <div className="flex items-center gap-2 text-sm text-ink-muted">
                    Every <input aria-label="Minutes between runs" inputMode="numeric" value={f.every} onChange={(e) => set('every', e.target.value)} className={field + ' w-20'} /> minutes
                  </div>
                )}
                <SubHead title="Budget" help="At its budget it stops until the month turns." />
                <div className="flex items-center gap-2 text-sm text-ink-muted">
                  <label htmlFor="org-budget" className="sr-only">Monthly budget, dollars</label>$
                  <input id="org-budget" inputMode="decimal" value={f.budget} onChange={(e) => set('budget', e.target.value)} className={field + ' w-24'} />
                  a month · {money(w.spentThisMonthUSD)} spent so far
                </div>
              </div>
            </div>
          </section>

          <section id="org-set-access" className={card}>
            <h2 className="text-base font-semibold text-ink">Access</h2>
            <p className={hint + ' mt-1'}>Who may ask it, whose asks it starts on straight away, and who approves the rest.</p>
            <div className="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-3">
              <Choice legend="Who can ask it" name="ask" value={f.ask} onChange={(v) => set('ask', v)} options={[['private', 'Only its manager'], ['team', 'Its manager’s team'], ['org', 'Anyone in the org'], ['picked', 'People and groups I pick']]}>
                {f.ask === 'picked' && <Picker dir={dir} value={f.audience} onChange={(a) => set('audience', a)} label="who can ask it" />}
              </Choice>
              <Choice legend="Starts work for" badge={admin ? undefined : 'admin'} disabled={!admin} name="start" value={f.start} onChange={(v) => set('start', v)} options={[['manager', 'Only its manager'], ['anyone', 'Anyone who can ask it'], ['picked', 'Its manager, and…']]}>
                {f.start === 'picked' && <Picker dir={dir} value={f.startAudience} onChange={(a) => set('startAudience', a)} label="whose asks start" disabled={!admin} />}
              </Choice>
              <Choice legend="Approves the rest" badge={admin ? undefined : 'admin'} disabled={!admin} name="approve" value={f.approve} onChange={(v) => set('approve', v)} options={[['manager', 'Its manager'], ['picked', 'Its manager, and…']]}>
                {f.approve === 'picked' && <Picker dir={dir} value={f.approvers} onChange={(a) => set('approvers', a)} label="who else approves" disabled={!admin} />}
              </Choice>
            </div>
            <div className="mt-4 rounded-lg border border-accent/30 bg-accent/10 px-4 py-2.5 text-sm text-ink">{accessSummary(f, w, dir.names)}</div>
            <SubHead title="How much it does alone" className="mt-6" />
            <div className="mt-2 grid grid-cols-1 gap-3 md:grid-cols-3">
              {(
                [
                  ['probation', 'Asks before work', 'It proposes each run’s work and asks before anything leaves the server.'],
                  ['trusted', 'Trusted', 'It starts its own runs, and still asks before anything that changes something outside the server: a ticket, a message, a push.'],
                  ['autonomous', 'On its own', 'It starts its own work and acts outside the server without asking. Only for work you’d never want to check first.'],
                ] as const
              ).map(([id, l, d]) => (
                <button
                  key={id}
                  type="button"
                  aria-pressed={f.trust === id}
                  disabled={id === 'autonomous' && !admin && initial.trust !== 'autonomous'}
                  onClick={() => set('trust', id)}
                  className={'rounded-xl border p-4 text-left disabled:opacity-50 ' + (f.trust === id ? 'border-accent bg-accent/10' : 'border-card-strong bg-surface hover:border-ink-faint')}
                >
                  <span className="block text-sm font-semibold text-ink">{l}{id === 'autonomous' && !admin ? <span className="ml-2 text-[10px] font-normal text-ink-faint">admins</span> : null}</span>
                  <span className="mt-1 block text-xs leading-relaxed text-ink-muted">{d}</span>
                </button>
              ))}
            </div>
            <SubHead title="Handing work on" className="mt-6" />
            <Check
              checked={f.canDelegate}
              onChange={(v) => set('canDelegate', v)}
              label="Let it hand work to colleagues"
              help={`When something it finds is another worker's job, it asks them to take it, and in Slack the thread sees the ask and their answer. The work runs on the colleague's budget.${f.canDelegate && f.trust === 'probation' ? ' Not while it asks before work: trust it first.' : ''}`}
            />
            {f.canDelegate && (
              <fieldset className="mt-3">
                <legend className="text-sm text-ink">Who it may hand work to</legend>
                <p className={hint + ' mb-2'}>
                  {f.delegatesTo.length
                    ? 'Exactly the ticked colleagues. Untick them all to go back to anyone working in the same place.'
                    : 'Anyone working in the same place (its repo or workspace); it picks by their jobs. Tick names to choose exactly who. A colleague someone else manages needs their OK.'}
                </p>
                <div className="flex flex-wrap gap-2">
                  {(workers ?? []).filter((x) => x.id !== w.id).map((x) => {
                    const on = f.delegatesTo.includes(x.id);
                    return (
                      <label key={x.id} className={'inline-flex cursor-pointer items-center gap-1.5 rounded-lg border px-2.5 py-1 text-xs ' + (on ? 'border-accent bg-accent/10 text-ink' : 'border-card-strong bg-surface text-ink-muted')}>
                        <input type="checkbox" checked={on} onChange={(e) => set('delegatesTo', e.target.checked ? [...f.delegatesTo, x.id] : f.delegatesTo.filter((id) => id !== x.id))} />
                        {x.name}
                      </label>
                    );
                  })}
                </div>
              </fieldset>
            )}
          </section>

          <section id="org-set-tools" className={card}>
            <h2 className="text-base font-semibold text-ink">Tools and how it works</h2>
            <div className="mt-4 grid grid-cols-1 gap-4 md:grid-cols-2">
              <Field id="s-place" label="Where it works" help="The repo, or workspace of repos, it reads and changes. Connected repos are set on the console.">
                <input id="s-place" disabled value={w.place ? `${w.place.kind === 'repo' ? 'Repo' : w.place.kind === 'workspace' ? 'Workspace' : 'Folder'}: ${w.place.name}${w.place.repos?.length ? ` (${w.place.repos.length} repos)` : ''}` : 'Nowhere yet: it can’t change code'} className={field} />
              </Field>
              <Field id="s-role" label="Role" help="Its job in the role catalog. The role’s tools come with it, in every run, under its trust.">
                <select id="s-role" value={f.role} onChange={(e) => set('role', e.target.value)} className={field}>
                  <option value="">None</option>
                  {[...new Set([...(f.role ? [f.role] : []), ...roles])].map((r) => <option key={r} value={r}>{r}</option>)}
                </select>
              </Field>
            </div>
            <SubHead title="Tools" help="What it can reach, and how much of each. Calls outside a tool’s scope are refused, even with your OK." className="mt-5" />
            <div className="mt-2 overflow-hidden rounded-lg border border-card">
              {(w.tools ?? []).filter((t) => t.fromRole || f.tools.includes(t.name)).map((t) => (
                <div key={t.name} className="flex flex-wrap items-center gap-3 border-b border-card px-4 py-2.5 last:border-b-0">
                  <span className={'h-2 w-2 rounded-full ' + (t.ok ? 'bg-emerald-400' : 'bg-amber-400')} />
                  <span className="min-w-[160px] flex-1 text-sm text-ink">{t.name}{t.fromRole ? <span className="ml-2 text-xs text-ink-faint">from its role</span> : !t.ok ? <span className="ml-2 text-xs text-ink-faint">not on the server</span> : null}</span>
                  <select aria-label={`How much of ${t.name}`} value={f.scopes[t.name] ?? 'full'} onChange={(e) => set('scopes', { ...f.scopes, [t.name]: e.target.value as 'full' | 'read' | 'only' })} className={field + ' w-40 !py-1 text-xs'}>
                    <option value="full">Full</option>
                    <option value="read">Read only</option>
                    {f.scopes[t.name] === 'only' && <option value="only">Only some calls</option>}
                  </select>
                  {!t.fromRole && <button type="button" onClick={() => set('tools', f.tools.filter((x) => x !== t.name))} className="text-xs text-ink-muted hover:text-ink">Remove</button>}
                </div>
              ))}
              {!(w.tools ?? []).length && <div className="px-4 py-3 text-sm text-ink-muted">No tools yet. Add them on the console’s Tools page.</div>}
            </div>
            <div className="mt-5 grid grid-cols-1 gap-4 md:grid-cols-3">
              <Field id="s-code" label="Writes code">
                <select id="s-code" value={f.writesCode} onChange={(e) => set('writesCode', e.target.value as Form['writesCode'])} className={field}>
                  <option value="flows">From its flows</option>
                  <option value="yes">Writes code: a checkout and a pull request per run</option>
                  <option value="no">Only reads code</option>
                </select>
              </Field>
              <Field id="s-flow" label="Preferred flow">
                <select id="s-flow" value={f.flow} onChange={(e) => set('flow', e.target.value)} className={field}>
                  <option value="">Let it choose{detail.flows?.[0] ? ` (first: ${detail.flows[0].name})` : ''}</option>
                  {(detail.flows ?? []).map((fl) => <option key={fl.id} value={fl.id}>{fl.name}</option>)}
                </select>
              </Field>
              <Field id="s-convs" label="Conversations at once">
                <select id="s-convs" value={f.answersAtOnce} onChange={(e) => set('answersAtOnce', e.target.value)} className={field}>
                  {[1, 2, 3, 4, 5].map((n) => <option key={n} value={String(n)}>{n === 1 ? 'One at a time' : n}</option>)}
                </select>
              </Field>
            </div>
          </section>

          <section id="org-set-desktop" className={card}>
            <h2 className="text-base font-semibold text-ink">Your desktop</h2>
            <Check
              checked={f.desktopHandOff}
              onChange={(v) => set('desktopHandOff', v)}
              label={`Can hand work to my desktop`}
              help={`When a step needs what its server can’t do (your logged-in browser, design work, files on your Mac), ${w.name} can hand it to ${w.manager ?? 'its manager'}’s overcli. It waits there for an Allow, opens as a local chat, and you check what goes back. Turn on “Take work from my org workers” in Settings → Your orgs to get them.`}
            />
          </section>

          <section id="org-set-slack" className={card}>
            <h2 className="text-base font-semibold text-ink">Answering in Slack</h2>
            <p className={hint + ' mt-1'}>Home channels: it answers there without being named. Invite the overgo bot to each one too.</p>
            <ChannelEditor value={f.homeChannels} onChange={(v) => set('homeChannels', v)} />
          </section>

          <section id="org-set-prs" className={card}>
            <div className="flex items-baseline gap-2">
              <h2 className="text-base font-semibold text-ink">Pull requests and approvals</h2>
              {!admin && <span className="text-[11px] text-ink-faint">admins change these</span>}
            </div>
            <fieldset disabled={!admin} className="contents">
              <Check checked={f.continueOpenPrs} onChange={(v) => set('continueOpenPrs', v)} label="Push fixes to the team’s open pull requests" help="Broken builds and conflicts, on branches other people opened." />
              {f.continueOpenPrs && (
                <div className="mt-3 grid grid-cols-1 gap-4 pl-7 md:grid-cols-2">
                  <Field id="s-by" label="Only pull requests by" help="As Bitbucket or GitHub names them, comma separated. Empty: everyone’s.">
                    <input id="s-by" value={f.prAuthors} onChange={(e) => set('prAuthors', e.target.value)} placeholder="Everyone’s" className={field} />
                  </Field>
                  <Field id="s-cm" label="Also fix review comments on pull requests by" help="Empty: none; it leaves review comments to people.">
                    <input id="s-cm" value={f.prCommentAuthors} onChange={(e) => set('prCommentAuthors', e.target.value)} placeholder="Nobody’s" className={field} />
                  </Field>
                </div>
              )}
              <Check checked={f.skipCheckpoints} onChange={(v) => set('skipCheckpoints', v)} label="Run straight through its flows’ checkpoints" help="A checkpoint is where someone meant to look." />
            </fieldset>
            <SubHead title="Always allowed" help="Steps you said it may always run without asking. Take one off and it asks again." className="mt-5" />
            <div className="mt-2 flex flex-col gap-1.5">
              {f.alwaysAllow.map((s) => (
                <div key={s} className="flex items-center gap-3 rounded-lg border border-card bg-surface px-3 py-2 text-sm text-ink">
                  <span className="flex-1">{s.replace(/\//g, ' / ').replace(/[-_]+/g, ' ')}</span>
                  <button type="button" onClick={() => set('alwaysAllow', f.alwaysAllow.filter((x) => x !== s))} className="text-xs text-accent hover:underline">Take off</button>
                </div>
              ))}
              {!f.alwaysAllow.length && <div className="text-sm text-ink-muted">Nothing yet. Every step that reaches outside asks, as its trust says.</div>}
            </div>
          </section>
        </fieldset>

        <HistorySection serverId={server.id} worker={w} can={can} onChanged={onChanged} />

        <section id="org-set-letgo" className="flex flex-wrap items-center gap-3 rounded-xl border border-red-400/40 p-5">
          <div className="min-w-[260px] flex-1">
            <div className="text-sm font-semibold text-ink">Pause or let go</div>
            <div className={hint}>Pausing keeps everything; letting go retires it for good. Its finished work and journal stay.</div>
          </div>
          <button type="button" disabled={!can || busy} className={btn} onClick={() => { setBusy(true); void orgCall(server.id, 'POST', `/api/workers/${enc(w.id)}/paused`, { paused: w.enabled }).then(() => { setBusy(false); onChanged(); }); }}>
            {w.enabled ? 'Pause' : 'Resume'}
          </button>
          <button
            type="button"
            disabled={!can || busy}
            onClick={() => {
              if (!window.confirm(`Let ${w.name} go? Its finished work and journal stay; its reports move up to its own boss.`)) return;
              setBusy(true);
              void orgCall(server.id, 'POST', `/api/workers/${enc(w.id)}/retire`, {}).then((r) => {
                setBusy(false);
                if (!r.ok) return setNote({ ok: false, text: r.error });
                useOrgTab.getState().select(null);
                void useOrgTab.getState().refresh();
              });
            }}
            className="min-h-[32px] rounded-lg border border-red-400/50 px-3 py-1.5 text-xs font-medium text-red-700 hover:bg-red-500/10 disabled:opacity-50 dark:text-red-300"
          >
            Let {w.name} go…
          </button>
        </section>
      </div>

      {can && (changed.length > 0 || note) && (
        <div className="sticky bottom-0 z-10 -mx-8 flex w-[calc(100%+4rem)] flex-wrap items-center gap-3 border-t border-card bg-surface px-8 py-3">
          {changed.length > 0 && !note?.ok && <span className="h-2 w-2 rounded-full bg-amber-400" />}
          <span role="status" className={'min-w-[200px] flex-1 text-sm ' + (note && !note.ok ? 'text-red-700 dark:text-red-300' : 'text-ink-muted')}>
            {note ? note.text : `${changed.length} unsaved ${changed.length === 1 ? 'change' : 'changes'}: ${changed.join(', ')}`}
          </span>
          {changed.length > 0 && !note?.ok && (
            <>
              <button type="button" disabled={busy} className={btn} onClick={() => { setF(initial); setNote(null); }}>Discard</button>
              <button type="button" disabled={busy} className={primary} onClick={() => void save()}>{busy ? 'Saving…' : 'Save changes'}</button>
            </>
          )}
        </div>
      )}
    </div>
  );
}

// ---- parts -------------------------------------------------------------------

function Field({ id, label, help, children }: { id: string; label: string; help?: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className="text-sm font-semibold text-ink">{label}</label>
      {children}
      {help && <span className={hint}>{help}</span>}
    </div>
  );
}

function SubHead({ title, help, className = '' }: { title: string; help?: string; className?: string }) {
  return (
    <div className={className}>
      <h3 className="text-sm font-semibold text-ink">{title}</h3>
      {help && <p className={hint + ' mt-0.5'}>{help}</p>}
    </div>
  );
}

function Segmented<T extends string>({ value, onChange, options, label }: { value: T; onChange: (v: T) => void; options: ReadonlyArray<readonly [T, string]>; label: string }) {
  return (
    <div role="radiogroup" aria-label={label} className="flex gap-1 rounded-lg border border-card-strong bg-surface p-1">
      {options.map(([v, l]) => (
        <button key={v} type="button" role="radio" aria-checked={value === v} onClick={() => onChange(v)} className={'flex-1 rounded-md px-2 py-1.5 text-xs ' + (value === v ? 'bg-card-strong font-medium text-ink' : 'text-ink-muted hover:text-ink')}>
          {l}
        </button>
      ))}
    </div>
  );
}

function Choice<T extends string>({ legend, badge, name, value, onChange, options, disabled, children }: { legend: string; badge?: string; name: string; value: T; onChange: (v: T) => void; options: ReadonlyArray<readonly [T, string]>; disabled?: boolean; children?: React.ReactNode }) {
  return (
    <fieldset disabled={disabled} className="rounded-lg border border-card px-4 pb-3 pt-1">
      <legend className="px-1 text-sm font-semibold text-ink">{legend}{badge ? <span className="ml-1.5 text-[10px] font-normal text-ink-faint">{badge}</span> : null}</legend>
      {options.map(([v, l]) => (
        <label key={v} className="mt-1.5 flex cursor-pointer items-center gap-2 text-sm text-ink">
          <input type="radio" name={name} checked={value === v} onChange={() => onChange(v)} />
          {l}
        </label>
      ))}
      {children}
    </fieldset>
  );
}

function Check({ checked, onChange, label, help }: { checked: boolean; onChange: (v: boolean) => void; label: string; help: string }) {
  return (
    <label className="mt-4 flex cursor-pointer items-start gap-2.5 text-sm text-ink">
      <input type="checkbox" className="mt-1" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span>
        <span className="font-medium">{label}</span>
        <span className={'block ' + hint}>{help}</span>
      </span>
    </label>
  );
}

type Dir = ReturnType<typeof useDirectoryData>;

/// People, groups and roles, as chips. Clicking into the box lists the
/// org's directory (everyone, its groups, and the roles an audience can name),
/// narrowing as you type; Enter adds the first, Escape closes it.
function Picker({ dir, value, onChange, label, disabled }: { dir: Dir; value: Audience; onChange: (a: Audience) => void; label: string; disabled?: boolean }) {
  const [q, setQ] = useState('');
  const [open, setOpen] = useState(false);
  const groups = dir.groups.filter((g) => g.id.startsWith('team:'));
  const chips = [
    ...(value.people ?? []).map((id) => ({ key: `p:${id}`, text: dir.names.get(id) ?? id, drop: () => onChange({ ...value, people: (value.people ?? []).filter((x) => x !== id) }) })),
    ...(value.groups ?? []).map((id) => ({ key: `g:${id}`, text: `${groups.find((g) => g.id === id)?.name ?? id.replace(/^team:/, '')} (group)`, drop: () => onChange({ ...value, groups: (value.groups ?? []).filter((x) => x !== id) }) })),
    ...(value.roles ?? []).map((id) => ({ key: `r:${id}`, text: dir.roles.find((r) => r.id === id)?.name ?? id, drop: () => onChange({ ...value, roles: (value.roles ?? []).filter((x) => x !== id) }) })),
  ];
  const needle = q.trim().toLowerCase();
  const fits = (s: string) => !needle || s.toLowerCase().includes(needle);
  const options = [
    ...dir.roles.filter((r) => fits(r.name) && !(value.roles ?? []).includes(r.id)).map((r) => ({ key: `r:${r.id}`, text: r.name, kind: 'Role', add: () => onChange({ ...value, roles: [...(value.roles ?? []), r.id] }) })),
    ...groups.filter((g) => fits(g.name) && !(value.groups ?? []).includes(g.id)).map((g) => ({ key: g.id, text: g.name, kind: 'Group', add: () => onChange({ ...value, groups: [...(value.groups ?? []), g.id] }) })),
    ...dir.people.filter((p) => fits(p.name) && !(value.people ?? []).includes(p.slackUserId)).map((p) => ({ key: p.slackUserId, text: p.name, kind: '', add: () => onChange({ ...value, people: [...(value.people ?? []), p.slackUserId] }) })),
  ];
  const empty = !dir.people.length && !groups.length && !dir.roles.length;
  return (
    <div className="mt-2 pl-6">
      {chips.length > 0 && (
        <div className="mb-2 flex flex-wrap gap-1.5">
          {chips.map((c) => (
            <span key={c.key} className="inline-flex items-center gap-1 rounded-full bg-card-strong px-2.5 py-0.5 text-xs text-ink">
              {c.text}
              <button type="button" disabled={disabled} aria-label={`Remove ${c.text}`} onClick={c.drop} className="text-ink-faint hover:text-ink">×</button>
            </span>
          ))}
        </div>
      )}
      <div className="relative">
        <input
          role="combobox"
          aria-expanded={open}
          aria-label={`Add to ${label}`}
          disabled={disabled}
          value={q}
          onFocus={() => setOpen(true)}
          onBlur={() => window.setTimeout(() => setOpen(false), 150)}
          onChange={(e) => {
            setQ(e.target.value);
            setOpen(true);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Escape') setOpen(false);
            if (e.key === 'Enter') {
              e.preventDefault();
              if (options[0]) {
                options[0].add();
                setQ('');
              }
            }
          }}
          placeholder="Add a person, group or role…"
          className={field + ' !py-1.5 text-xs'}
        />
        {open && !disabled && (
          <div role="listbox" className="absolute z-20 mt-1 max-h-60 w-full overflow-auto rounded-lg border border-card-strong bg-surface shadow-lg">
            {options.slice(0, 50).map((o) => (
              <button
                key={o.key}
                type="button"
                role="option"
                aria-selected={false}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => {
                  o.add();
                  setQ('');
                }}
                className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs text-ink hover:bg-card-strong"
              >
                <span className="flex-1">{o.text}</span>
                {o.kind && <span className="text-[10px] text-ink-faint">{o.kind}</span>}
              </button>
            ))}
            {!options.length && (
              <div className="px-3 py-2 text-xs text-ink-muted">
                {empty ? 'The org’s directory is empty here: connect Slack people on the console (Setup), or define groups in its rules.' : needle ? `Nobody matching “${q.trim()}”.` : 'Everyone is already picked.'}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

/// What the access settings come to, in a sentence.
function accessSummary(f: Form, w: SettingsWorker, names: Map<string, string>): string {
  const roleName: Record<string, string> = { admin: 'admins', approver: 'hire approvers', hirer: 'people who can hire' };
  const who = (a: Audience) => [...(a.people ?? []).map((id) => names.get(id) ?? 'someone'), ...(a.groups ?? []).map((g) => `the ${g.replace(/^team:/, '')} group`), ...(a.roles ?? []).map((r) => roleName[r] ?? r)].join(', ');
  const mgr = w.manager ?? 'its manager';
  const cap = (t: string) => t.charAt(0).toUpperCase() + t.slice(1);
  const ask = f.ask === 'private' ? `Only ${mgr} can ask it.` : f.ask === 'org' ? 'Anyone in the org can ask it.' : f.ask === 'team' ? `${mgr}’s team can ask it.` : who(f.audience) ? `${cap(who(f.audience))} can ask it.` : 'Nobody can ask it yet: pick people, groups or roles.';
  const start = f.start === 'anyone' ? 'What anyone who can ask it asks for starts straight away.' : f.start === 'picked' && who(f.startAudience) ? `What ${who(f.startAudience)} ask for starts straight away; anyone else’s waits for an OK.` : `Only ${mgr}’s asks start straight away; anyone else’s waits for an OK.`;
  const approve = f.approve === 'picked' && who(f.approvers) ? `${mgr} and ${who(f.approvers)} approve the rest.` : `${mgr} approves the rest.`;
  return `${ask} ${start} ${approve}`;
}

/// Slack home channels: ids, or channel links pasted in.
function ChannelEditor({ value, onChange }: { value: string[]; onChange: (v: string[]) => void }) {
  const [q, setQ] = useState('');
  const add = () => {
    const ids = q.split(/[\s,]+/).map((x) => /\/archives\/([CG][A-Z0-9]+)/.exec(x)?.[1] ?? x.trim()).filter((x) => /^[CG][A-Z0-9]{6,}$/.test(x));
    if (ids.length) onChange([...new Set([...value, ...ids])]);
    setQ('');
  };
  return (
    <div className="mt-3 flex flex-wrap items-center gap-2">
      {value.map((c) => (
        <span key={c} className="inline-flex items-center gap-1 rounded-full bg-card-strong px-3 py-1 text-xs text-ink">
          {c}
          <button type="button" aria-label={`Remove ${c}`} onClick={() => onChange(value.filter((x) => x !== c))} className="text-ink-faint hover:text-ink">×</button>
        </span>
      ))}
      <input aria-label="Add a channel" value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); add(); } }} placeholder="Channel ID or link, then Enter" className={field + ' max-w-xs !py-1.5 text-xs'} />
    </div>
  );
}

/// What `/revise` hands back: its job rewritten, how it works changed, or
/// both, and any tool the new steps need that it doesn't have.
interface Revision {
  note?: string;
  job?: string;
  flow?: { flowId: string; name: string; yaml: string; changes: string[]; sharedWith: string[]; othersNotYours: string[] };
  flowProblem?: string;
  needsTools?: string[];
}

/// Its job, folded, with the console's rewrite: say what should change once,
/// and it's routed to its job, how it works, or both. The job saves with
/// everything else; a change to how it works saves on its own, now.
function JobEditor({ serverId, workerId, name, job, initial, onJob, disabled }: { serverId: string; workerId: string; name: string; job: string; initial: string; onJob: (j: string) => void; disabled: boolean }) {
  const [open, setOpen] = useState(false);
  const [ask, setAsk] = useState('');
  const [busy, setBusy] = useState(false);
  const [before, setBefore] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [rev, setRev] = useState<(Revision & { ask: string }) | null>(null);
  const [everyone, setEveryone] = useState(false);
  const [flowSaved, setFlowSaved] = useState<string | null>(null);
  const [given, setGiven] = useState<Record<string, string>>({});
  const rewrite = () => {
    if (!ask.trim()) return;
    setBusy(true);
    setError(null);
    setFlowSaved(null);
    void orgCall(serverId, 'POST', `/api/workers/${enc(workerId)}/revise`, { ask: ask.trim(), job }).then((r) => {
      setBusy(false);
      if (!r.ok) return setError(r.error);
      const x = r.data as Revision;
      setRev({ ...x, ask: ask.trim() });
      setEveryone(false);
      setGiven({});
      if (x.job) {
        setBefore(job);
        onJob(x.job);
        setOpen(true);
      }
      setAsk('');
    });
  };
  const useFlow = () => {
    if (!rev?.flow) return;
    setBusy(true);
    void orgCall(serverId, 'POST', `/api/workers/${enc(workerId)}/how-it-works`, { flowId: rev.flow.flowId, yaml: rev.flow.yaml, everyone }).then((r) => {
      setBusy(false);
      if (!r.ok) return setError(r.error);
      setFlowSaved((r.data as { copied?: boolean }).copied ? `Saved as ${name}’s own copy. Its next run works this way.` : 'Saved. Its next run works this way.');
      setRev({ ...rev, flow: undefined });
    });
  };
  const give = (tool: string) => {
    void orgCall(serverId, 'POST', `/api/workers/${enc(workerId)}/tools/request`, { tool, why: `For: ${rev?.ask ?? 'a change to how it works'}` }).then((r) => {
      if (!r.ok) return setGiven((g) => ({ ...g, [tool]: r.error }));
      setGiven((g) => ({ ...g, [tool]: (r.data as { given?: boolean }).given ? 'Given. Rewrite it again to change how it works too.' : 'Asked the admins. Rewrite it again once it’s given.' }));
    });
  };
  return (
    <div className="mt-6 border-t border-card pt-5">
      <div className="flex flex-wrap items-baseline gap-3">
        <h3 className="text-sm font-semibold text-ink">Its job</h3>
        <span className={hint}>What it was hired for. It reads this before every run.</span>
        <button type="button" onClick={() => setOpen(!open)} className="ml-auto text-xs text-accent hover:underline">{open ? 'Fold' : 'Read or edit'}</button>
      </div>
      {open ? (
        <textarea aria-label="Its job" rows={10} value={job} onChange={(e) => onJob(e.target.value)} disabled={disabled} className={field + ' mt-3 leading-relaxed'} />
      ) : (
        <div className="relative mt-3 max-h-24 overflow-hidden rounded-lg border border-card bg-surface px-4 py-3 text-sm leading-relaxed text-ink-muted">
          {job}
          <div className="pointer-events-none absolute inset-x-0 bottom-0 h-10 bg-gradient-to-t from-[var(--c-surface)] to-transparent" />
        </div>
      )}
      {before !== null && (
        <div className="mt-2 flex items-center gap-3 text-xs text-emerald-700 dark:text-emerald-300">
          Rewritten above. Read it over, then save.
          <button type="button" onClick={() => { onJob(before); setBefore(null); }} className="text-accent hover:underline">Undo</button>
        </div>
      )}
      {!disabled && (
        <div className="mt-3 flex flex-wrap items-center gap-2 rounded-lg border border-card-strong bg-surface px-3 py-2">
          <label htmlFor="s-change" className="text-xs text-ink-muted">What should change</label>
          <input id="s-change" value={ask} onChange={(e) => setAsk(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); rewrite(); } }} placeholder={`e.g. also check the Ops board on Fridays`} className="min-w-[220px] flex-1 border-0 bg-transparent text-sm text-ink outline-none placeholder:text-ink-faint" />
          <button type="button" disabled={busy || !ask.trim()} onClick={rewrite} className={btn}>{busy ? 'Rewriting…' : 'Rewrite it'}</button>
        </div>
      )}
      {error && <div role="alert" className="mt-1 text-xs text-red-700 dark:text-red-300">{error}</div>}
      {job.trim() !== initial.trim() && before === null && <div className="mt-1 text-xs text-ink-faint">Changed; saves with the rest. {name} reads the new job from its next run.</div>}
      {rev && (rev.note || rev.flow || rev.flowProblem) && (
        <div className="mt-3 flex flex-col gap-2 rounded-lg border border-card bg-surface px-4 py-3 text-sm">
          {rev.note && <p className="text-ink-muted">{rev.note}</p>}
          {!rev.job && <p className="text-xs text-ink-faint">Its job stays as it is.</p>}
          {rev.flowProblem && <p className="text-xs text-amber-700 dark:text-amber-300">{rev.flowProblem}</p>}
          {(rev.needsTools ?? []).map((t) => (
            <div key={t} className="flex items-center gap-3">
              <button type="button" disabled={!!given[t]} onClick={() => give(t)} className={btn}>Give it {t}</button>
              {given[t] && <span className="text-xs text-ink-muted">{given[t]}</span>}
            </div>
          ))}
          {rev.flow && (
            <>
              <h4 className="text-xs font-semibold text-ink">How it works changes too: {rev.flow.name}</h4>
              <ul className="list-disc pl-5 text-xs text-ink-muted">
                {rev.flow.changes.map((c) => <li key={c}>{c}</li>)}
              </ul>
              {rev.flow.sharedWith.length > 0 && (
                <label className="flex items-center gap-2 text-xs text-ink-muted">
                  <input type="checkbox" checked={everyone} disabled={rev.flow.othersNotYours.length > 0} onChange={(e) => setEveryone(e.target.checked)} />
                  Change it for {rev.flow.sharedWith.join(', ')} too. Left unticked, {name} gets its own copy.
                </label>
              )}
              <div className="flex gap-2">
                <button type="button" disabled={busy || disabled} onClick={useFlow} className={btn}>Use this</button>
                <button type="button" onClick={() => setRev({ ...rev, flow: undefined })} className="text-xs text-accent hover:underline">Keep how it works as it is</button>
              </div>
            </>
          )}
        </div>
      )}
      {flowSaved && <div className="mt-1 text-xs text-emerald-700 dark:text-emerald-300">{flowSaved}</div>}
    </div>
  );
}

interface Version {
  id: string;
  at: number;
  by: string;
  changed: string[];
}

function HistorySection({ serverId, worker, can, onChanged }: { serverId: string; worker: SettingsWorker; can: boolean; onChanged: () => void }) {
  const [versions, setVersions] = useState<Version[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const load = () => orgCall(serverId, 'GET', `/api/workers/${enc(worker.id)}/history`).then((r) => (r.ok ? setVersions((r.data as { versions: Version[] }).versions ?? []) : setError(r.error)));
  useEffect(() => {
    void load();
  }, [serverId, worker.id]);
  const restore = (v: Version) => {
    if (!window.confirm(`Put ${worker.name} back as it was ${ago(v.at)}? Its job, tools, trust and settings go back to then.`)) return;
    setBusy(true);
    void orgCall(serverId, 'POST', `/api/workers/${enc(worker.id)}/restore`, { versionId: v.id }).then((r) => {
      setBusy(false);
      if (!r.ok) return setError(r.error);
      void load();
      onChanged();
    });
  };
  return (
    <section id="org-set-history" className={card}>
      <h2 className="text-base font-semibold text-ink">History</h2>
      <p className={hint + ' mt-1'}>Every change to its job, tools, trust and settings. Restore one to go back to it.</p>
      {error && <div role="alert" className="mt-2 text-xs text-red-700 dark:text-red-300">{error}</div>}
      <ol className="mt-3 flex flex-col">
        {(versions ?? []).slice(0, 30).map((v, i) => (
          <li key={v.id} className="flex flex-wrap items-center gap-3 border-t border-card py-2.5 text-sm first:border-t-0">
            <span className="w-28 text-xs text-ink-faint">{ago(v.at)}</span>
            <span className="min-w-[200px] flex-1 text-ink">
              {v.changed.length ? `Changed ${v.changed.join(', ')}` : 'Saved'} <span className="text-ink-faint">· {v.by}</span>
            </span>
            {i === 0 ? <span className="text-xs text-ink-faint">Now</span> : can && <button type="button" disabled={busy} onClick={() => restore(v)} className={btn}>Restore</button>}
          </li>
        ))}
        {versions && !versions.length && <li className="text-sm text-ink-muted">No changes recorded yet.</li>}
        {!versions && !error && <li className="text-sm text-ink-muted">Reading its history…</li>}
      </ol>
    </section>
  );
}
