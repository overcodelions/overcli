// A chat wants to change something on an org server, and the person decides
// (main's confirmOrgChange asks through `orgChangeRequest`). Shown in the
// app's own window rather than a system alert, so the change can be laid out
// readably: what it is in words ("Change Oscar's job"), each field with its
// value (long text in a box, money as money, a flow as code), which chat is
// asking and on which org. "Don't allow" has the focus; Escape refuses too.

import { useEffect, useRef, useState } from 'react';

interface Ask {
  id: string;
  chat?: string;
  org?: string;
  name?: string;
  args?: unknown;
}

const FIELD: Record<string, string> = {
  jobDescription: 'Its job',
  tagline: 'The line under its name',
  name: 'Name',
  budgetUSDPerMonth: 'Monthly budget',
  visibility: 'Who can ask it',
  audience: 'Who can ask it',
  startAudience: 'Starts work for',
  approvers: 'Who else approves',
  anyoneMayStart: 'Starts work for anyone who can ask it',
  continueOpenPrs: 'Looks after the team’s open pull requests',
  prAuthors: 'Whose pull requests',
  prCommentAuthors: 'Whose review comments',
  skipCheckpoints: 'Runs through its flows’ checkpoints',
  toolScopes: 'How much of each tool',
  manager: 'Manager',
  reportsTo: 'Reports to',
  note: 'The note',
  yaml: 'The flow, as it would be',
  everyone: 'For every worker that shares it',
  answer: 'The answer',
  approve: 'Approve',
  forRun: 'For the rest of this run too',
  message: 'What it asks',
  trust: 'Trust',
  paused: 'Paused',
  runId: 'Run',
  flowId: 'Flow',
  task: 'The task',
};

/// What the call does, in words, from its name and the worker it names.
export function changeTitle(name: string | undefined, args: Record<string, unknown>): string {
  const w = typeof args.worker === 'string' ? args.worker : 'a worker';
  const keys = Object.keys(args).filter((k) => k !== 'worker');
  switch (name) {
    case 'update_worker':
      return keys.length === 1 && FIELD[keys[0]] ? `Change ${w}’s ${FIELD[keys[0]].toLowerCase().replace(/^its /, '')}` : `Change ${w}’s settings`;
    case 'add_worker_note': return `Add a note for ${w}`;
    case 'save_flow_change': return `Change how ${w} works`;
    case 'try_flow_change': return `Try a change to how ${w} works, on a past run`;
    case 'set_worker_paused': return args.paused ? `Pause ${w}` : `Resume ${w}`;
    case 'set_worker_trust': return `Make ${w} ${String(args.trust ?? '')}`;
    case 'set_worker_schedule': return `Change when ${w} runs`;
    case 'run_worker_now': return `Start a run of ${w} now`;
    case 'retire_worker': return `Let ${w} go, for good`;
    case 'ask_worker': return `Ask ${w} to do something`;
    case 'answer_question': return 'Answer a worker’s question';
    case 'decide_approval': return args.approve ? 'Approve a worker’s step' : 'Refuse a worker’s step';
    case 'decide_proposal': return 'Decide on proposed work';
    case 'rate_work': return 'Rate a worker’s work';
    case 'set_org_rules': return 'Change the org’s rules';
    default: return (name ?? 'a change').replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase());
  }
}

function Value({ k, v }: { k: string; v: unknown }) {
  if (v === null) return <span className="text-ink-muted">cleared</span>;
  if (typeof v === 'boolean') return <span className="text-ink">{v ? 'Yes' : 'No'}</span>;
  if (typeof v === 'number') return <span className="text-ink">{k.toLowerCase().includes('usd') ? `$${v}` : v}</span>;
  if (typeof v === 'string') {
    const long = v.length > 120 || v.includes('\n');
    if (k === 'yaml') return <pre className="max-h-[32vh] overflow-auto rounded-lg border border-card bg-surface-muted p-3 font-mono text-[11px] leading-relaxed text-ink">{v}</pre>;
    return long ? (
      <div className="max-h-[32vh] overflow-auto whitespace-pre-wrap rounded-lg border border-card bg-surface-muted p-3 text-[13px] leading-relaxed text-ink">{v.replace(/\\n/g, '\n')}</div>
    ) : (
      <span className="text-ink">{v}</span>
    );
  }
  if (Array.isArray(v)) return v.length ? <span className="flex flex-wrap gap-1">{v.map((x, i) => <span key={i} className="rounded-full bg-card-strong px-2 py-0.5 text-xs text-ink">{String(x)}</span>)}</span> : <span className="text-ink-muted">none</span>;
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    if (['people', 'groups', 'roles'].some((x) => x in o)) {
      const all = [...((o.people as string[]) ?? []), ...((o.groups as string[]) ?? []).map((g) => g.replace(/^team:/, '') + ' (group)'), ...((o.roles as string[]) ?? [])];
      return <Value k={k} v={all} />;
    }
    return <pre className="max-h-[24vh] overflow-auto rounded-lg border border-card bg-surface-muted p-2.5 font-mono text-[11px] text-ink">{JSON.stringify(v, null, 2)}</pre>;
  }
  return <span className="text-ink">{String(v)}</span>;
}

export function OrgChangeDialog() {
  const [queue, setQueue] = useState<Ask[]>([]);
  const refuse = useRef<HTMLButtonElement>(null);
  useEffect(
    () =>
      window.overcli.onMainEvent((e) => {
        if (e.type !== 'orgChangeRequest') return;
        if (e.done) setQueue((q) => q.filter((x) => x.id !== e.id));
        else setQueue((q) => [...q, { id: e.id, chat: e.chat, org: e.org, name: e.name, args: e.args }]);
      }),
    [],
  );
  const ask = queue[0];
  useEffect(() => {
    if (ask) refuse.current?.focus();
  }, [ask?.id]);
  if (!ask) return null;
  const answer = (allow: boolean) => {
    void window.overcli.invoke('org:answerChange', { id: ask.id, allow });
    setQueue((q) => q.slice(1));
  };
  const args = ask.args && typeof ask.args === 'object' && !Array.isArray(ask.args) ? (ask.args as Record<string, unknown>) : { value: ask.args };
  const fields = Object.entries(args).filter(([k]) => k !== 'worker');
  return (
    <div
      className="fixed inset-0 z-[1000] flex items-center justify-center bg-black/50 p-6 backdrop-blur-[2px]"
      role="presentation"
      onKeyDown={(e) => {
        if (e.key === 'Escape') answer(false);
      }}
    >
      <div role="alertdialog" aria-modal="true" aria-labelledby="org-change-title" aria-describedby="org-change-who" className="flex max-h-[86vh] w-full max-w-[620px] flex-col overflow-hidden rounded-2xl border border-card-strong bg-surface shadow-2xl">
        <div className="border-b border-card px-6 pb-4 pt-5">
          <div className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-widest text-accent">
            overgo{ask.org ? <span className="font-normal normal-case tracking-normal text-ink-faint">· {ask.org}</span> : null}
            {queue.length > 1 && <span className="ml-auto font-normal normal-case tracking-normal text-ink-faint">1 of {queue.length}</span>}
          </div>
          <h2 id="org-change-title" className="mt-1.5 text-lg font-semibold text-ink">{changeTitle(ask.name, args)}?</h2>
          <p id="org-change-who" className="mt-1 text-sm text-ink-muted">
            {ask.chat ? <>The chat <b className="text-ink">“{ask.chat}”</b> wants to do this</> : 'A chat wants to do this'}, as you{ask.org ? ` on ${ask.org}` : ''}.
          </p>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-6 py-4">
          <dl className="flex flex-col gap-3.5">
            {fields.map(([k, v]) => (
              <div key={k}>
                <dt className="mb-1 text-xs font-medium text-ink-muted">{FIELD[k] ?? k.replace(/([A-Z])/g, ' $1').replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase())}</dt>
                <dd className="text-sm"><Value k={k} v={v} /></dd>
              </div>
            ))}
            {!fields.length && <div className="text-sm text-ink-muted">No details beyond the worker.</div>}
          </dl>
        </div>
        <div className="flex flex-wrap items-center gap-3 border-t border-card bg-card px-6 py-3.5">
          <p className="min-w-[220px] flex-1 text-xs text-ink-muted">Only allow it if you asked for this. A chat can be talked into a change by something it read.</p>
          <button ref={refuse} type="button" onClick={() => answer(false)} className="cursor-pointer rounded-lg border border-card-strong bg-surface px-4 py-2 text-sm font-medium text-ink hover:bg-card-strong">
            Don’t allow
          </button>
          <button type="button" onClick={() => answer(true)} className="cursor-pointer rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-white hover:brightness-110">
            Allow
          </button>
        </div>
      </div>
    </div>
  );
}
