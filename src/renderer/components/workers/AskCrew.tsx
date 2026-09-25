// "Ask the crew" — say what you need; the crew works out who takes it.
//
// Type a request and the router picks the worker whose job it is. A clear
// match is sent straight away — naming who took it — and "@Name …" always is;
// only an unsure match stops to show you the pick first, since a wrong worker
// costs a run and a budget. The answer comes back here when the worker has
// it, with a way into whatever work it started. When nobody on the crew covers
// the request, the box says so and offers to hire someone for exactly that.

import { useMemo, useState } from 'react';

import { useStore } from '../../store';
import { useWorkersStore } from '../../workersStore';
import { Markdown } from '../Markdown';
import { WorkerAvatar } from './WorkerAvatar';
import { directTarget } from './crewTarget';
import { workerTagline, sortRoster, type WorkerErrandResult } from '@shared/flows/worker';

type Stage =
  | { kind: 'idle' }
  | { kind: 'routing' }
  | { kind: 'picked'; workerId: string; why: string; direct: boolean }
  | { kind: 'nobody'; why: string }
  | { kind: 'working'; workerId: string; why: string }
  | { kind: 'answered'; workerId: string; result: WorkerErrandResult }
  | { kind: 'error'; message: string };

export function AskCrew({ onOpenBatch }: { onOpenBatch?: (orchestrationId: string) => void }) {
  const workers = useWorkersStore((s) => s.workers);
  const runErrand = useWorkersStore((s) => s.runErrand);
  const openHire = useWorkersStore((s) => s.openHire);
  const patchHire = useWorkersStore((s) => s.patchHire);
  const projects = useStore((s) => s.projects);
  const workspaces = useStore((s) => s.workspaces);
  const crew = useMemo(() => sortRoster(Object.values(workers)).filter((w) => w.enabled), [workers]);
  const [text, setText] = useState('');
  const [ask, setAsk] = useState('');
  const [stage, setStage] = useState<Stage>({ kind: 'idle' });
  const [sending, setSending] = useState(false);

  if (crew.length === 0) return null;

  const route = async () => {
    const t = text.trim();
    if (!t) return;
    const direct = directTarget(t, crew);
    if (direct) {
      // Named outright: nothing to ask.
      void send(direct.workerId, direct.ask || t, 'you asked for them by name');
      return;
    }
    setAsk(t);
    setStage({ kind: 'routing' });
    const res = await window.overcli.invoke('workers:routeErrand', { ask: t });
    if (!res || res.ok === false) {
      setStage({ kind: 'error', message: res?.error ?? 'Could not work out who should take it.' });
      return;
    }
    if (!res.workerId) {
      setStage({ kind: 'nobody', why: res.why });
      return;
    }
    // A clear match goes straight out; an unsure one waits for your say.
    if (res.confident) void send(res.workerId, t, res.why);
    else setStage({ kind: 'picked', workerId: res.workerId, why: res.why, direct: false });
  };

  /// Send, then wait for the worker's turn — which is what carries its answer
  /// back — and show it here.
  const send = async (workerId: string, request: string = ask, why = '') => {
    if (!request || sending) return;
    setSending(true);
    setText('');
    setAsk(request);
    setStage({ kind: 'working', workerId, why });
    const ok = await runErrand(workerId, request);
    setSending(false);
    const result = useWorkersStore.getState().errandResult[workerId];
    if (ok && result) setStage({ kind: 'answered', workerId, result });
    else setStage({ kind: 'error', message: useWorkersStore.getState().errandError[workerId] || 'That errand did not send — try again.' });
  };

  const hireFor = () => {
    const hirePath = workspaces[0]?.rootPath ?? projects[0]?.path ?? '';
    openHire(hirePath);
    // The request becomes the job: onboarding starts from what you needed.
    patchHire({ jobDescription: ask, messages: [], reply: '', error: null });
  };

  const picked = stage.kind === 'picked' ? workers[stage.workerId] : undefined;

  return (
    <section aria-label="Ask the crew" className="flex flex-col gap-2">
      <form
        className="flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          void route();
        }}
      >
        <label htmlFor="ask-crew" className="sr-only">
          Ask the crew
        </label>
        <input
          id="ask-crew"
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            // A new request clears a pick you had not sent — never an errand
            // in flight or an answer you have not read.
            if (stage.kind === 'picked' || stage.kind === 'nobody' || stage.kind === 'error') setStage({ kind: 'idle' });
          }}
          placeholder="Ask the crew… (or @Name)"
          className="min-w-0 flex-1 rounded-lg border border-card-strong bg-surface px-3 py-2 text-[13px] text-ink placeholder:text-ink-faint focus:outline-none focus-visible:ring-1 focus-visible:ring-accent/50"
        />
        <button
          type="submit"
          disabled={!text.trim() || stage.kind === 'routing'}
          className="shrink-0 rounded-lg bg-accent px-3.5 py-2 text-[12.5px] font-medium text-white hover:opacity-90 disabled:opacity-40"
        >
          {stage.kind === 'routing' ? 'Finding…' : 'Ask'}
        </button>
      </form>

      {stage.kind === 'picked' && picked && (
        // Who, why, and one button. The worker's name is the headline; the
        // router's reason is the line under it (its tagline only when the
        // router gave none — both at once said the same thing twice).
        <div className="flex flex-col gap-2 rounded-lg border border-accent/40 bg-accent/5 px-3 py-2.5">
          <div className="flex items-start gap-2.5">
            <WorkerAvatar worker={picked} size="xs" />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[12.5px] font-semibold text-ink">{picked.name}</span>
              {(stage.why || workerTagline(picked)) && (
                <span className="line-clamp-2 text-[11.5px] leading-snug text-ink-muted">
                  {stage.direct ? workerTagline(picked) : stage.why || workerTagline(picked)}
                </span>
              )}
            </span>
            <button
              onClick={() => setStage({ kind: 'idle' })}
              className="-mr-1 -mt-0.5 shrink-0 px-1 text-[13px] leading-none text-ink-faint hover:text-ink"
              aria-label="Cancel"
            >
              ×
            </button>
          </div>
          <div className="flex items-center gap-3">
            <button
              onClick={() => void send(picked.id, ask, stage.why)}
              disabled={sending}
              className="whitespace-nowrap rounded-md bg-accent px-3 py-1 text-[12px] font-medium text-white hover:opacity-90 disabled:opacity-50"
            >
              {sending ? 'Sending…' : 'Send'}
            </button>
            <WorkerPicker crew={crew} value={picked.id} onPick={(id) => setStage({ ...stage, workerId: id })} />
          </div>
        </div>
      )}

      {stage.kind === 'nobody' && (
        <div className="flex flex-col gap-2 rounded-lg border border-card-strong px-3 py-2.5">
          <span className="text-[12.5px] text-ink">
            Nobody on the crew covers this.
            {stage.why && <span className="block text-[11.5px] text-ink-faint">{stage.why}</span>}
          </span>
          <div className="flex items-center gap-2">
            <button
              onClick={hireFor}
              className="rounded-md bg-accent px-3 py-1.5 text-[12px] font-medium text-white hover:opacity-90"
            >
              Hire someone for this
            </button>
            <WorkerPicker
              crew={crew}
              value=""
              placeholder="Send to someone anyway…"
              onPick={(id) => setStage({ kind: 'picked', workerId: id, why: 'your pick', direct: true })}
            />
          </div>
        </div>
      )}

      {stage.kind === 'working' && workers[stage.workerId] && (
        <div className="flex items-center gap-2.5 rounded-lg border border-card-strong px-3 py-2.5" role="status">
          <WorkerAvatar worker={workers[stage.workerId]} size="xs" live />
          <span className="min-w-0 flex-1 text-[12.5px] text-ink">
            <strong className="font-semibold">{workers[stage.workerId].name}</strong> is on it…
            {stage.why && <span className="block truncate text-[11.5px] text-ink-faint">{stage.why}</span>}
            <span className="block truncate text-[11.5px] text-ink-faint">“{ask}”</span>
          </span>
        </div>
      )}

      {stage.kind === 'answered' && workers[stage.workerId] && (
        <div className="flex flex-col gap-2 rounded-lg border border-card-strong px-3 py-2.5">
          <div className="flex items-center gap-2">
            <WorkerAvatar worker={workers[stage.workerId]} size="xs" />
            <span className="min-w-0 flex-1 truncate text-[11.5px] text-ink-muted">
              <strong className="font-semibold text-ink">{workers[stage.workerId].name}</strong> · “{ask}”
            </span>
            <button onClick={() => setStage({ kind: 'idle' })} className="text-[11.5px] text-ink-faint hover:text-ink" aria-label="Dismiss">
              ×
            </button>
          </div>
          {stage.result.reply && (
            <div className="max-h-[260px] overflow-y-auto text-[12.5px] leading-relaxed text-ink">
              <Markdown source={stage.result.reply} />
            </div>
          )}
          {!stage.result.launchedNothing && (
            <div className="flex items-center gap-2 text-[11.5px] text-ink-muted">
              <span>
                {stage.result.queued > 0
                  ? `Started ${stage.result.queued === 1 ? 'a job' : `${stage.result.queued} jobs`} — under Working.`
                  : `Proposed ${stage.result.count === 1 ? 'a job' : `${stage.result.count} jobs`} — waiting on you under Needs you.`}
              </span>
              {onOpenBatch && (
                <button onClick={() => onOpenBatch(stage.result.orchestrationId)} className="text-accent hover:underline">
                  Open
                </button>
              )}
            </div>
          )}
        </div>
      )}
      {stage.kind === 'error' && <span className="text-[11.5px] text-red-500">{stage.message}</span>}
    </section>
  );
}

function WorkerPicker({
  crew,
  value,
  onPick,
  placeholder = 'or someone else…',
}: {
  crew: Array<{ id: string; name: string }>;
  value: string;
  onPick: (id: string) => void;
  placeholder?: string;
}) {
  return (
    <>
      <label htmlFor="ask-crew-pick" className="sr-only">
        Send to
      </label>
      <select
        id="ask-crew-pick"
        value=""
        onChange={(e) => e.target.value && onPick(e.target.value)}
        className="min-w-0 cursor-pointer bg-transparent text-[11.5px] text-ink-faint hover:text-ink focus:outline-none"
      >
        <option value="">{placeholder}</option>
        {crew
          .filter((w) => w.id !== value)
          .map((w) => (
            <option key={w.id} value={w.id}>
              {w.name}
            </option>
          ))}
      </select>
    </>
  );
}
