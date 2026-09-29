// A finished flow run, step by step, read back from its transcripts. Opened
// from a Work record when the run itself has been evicted — the run pane has
// nothing to show then, but every step's session is still on disk.
//
// Three columns across the full width: the steps, the conversation, and what
// the run was (its flow, place, time, the files it named). The header carries
// what you can do next: open the flow it ran, run it again, or pick the work
// up in a new chat with the run's plan waiting in the message box.

import { useEffect, useMemo, useRef, useState } from 'react';

import type { RunTranscript, RunTranscriptStep, WorkRecord, WorkRecordRun } from '@shared/workRecords';
import { useFlowsStore } from '../../flowsStore';
import { useStore } from '../../store';
import { Markdown } from '../Markdown';
import { contextDraft, openChatInPlace } from './KeepWorking';

const BRIEF_PREVIEW = 360;
const PLAN_CAP = 6000;

/// Messages you typed into a step — everything but its opening brief.
function fromYou(s: RunTranscriptStep): number {
  return s.messages.filter((m, i) => m.role === 'user' && i > 0).length;
}

/// "plan (planner)" → { step: "Plan", who: "planner" }.
function splitLabel(label: string): { step: string; who: string } {
  const m = label.match(/^(.*?)\s*\(([^)]+)\)\s*$/);
  const step = (m ? m[1] : label).trim();
  return { step: step.charAt(0).toUpperCase() + step.slice(1), who: m ? m[2] : 'agent' };
}

/// The longest thing a step said — in a plan-then-build flow, the plan.
function longestAssistant(s: RunTranscriptStep | undefined): number {
  if (!s) return -1;
  let best = -1;
  let len = 0;
  s.messages.forEach((m, i) => {
    if (m.role === 'assistant' && m.text.length > len) {
      len = m.text.length;
      best = i;
    }
  });
  return len > 600 ? best : -1;
}

/// File names the agents mentioned in code spans — a cheap map of what the
/// run touched, since the run's own diff went with it.
function filesNamed(t: RunTranscript | null): string[] {
  if (!t) return [];
  const seen = new Set<string>();
  const re = /`([\w./-]+\.(?:py|ts|tsx|js|jsx|go|rs|java|kt|rb|md|json|ya?ml|toml|sql|sh|css|html))(?::\d+)?`/g;
  for (const s of t.steps) {
    for (const m of s.messages) {
      if (m.role !== 'assistant') continue;
      for (const hit of m.text.matchAll(re)) seen.add(hit[1]);
    }
  }
  return [...seen].slice(0, 14);
}

function clock(ms: number): string {
  return ms ? new Date(ms).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }) : '';
}

function when(ms: number): string {
  return new Date(ms).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

function took(from: number, to: number): string {
  const min = Math.max(1, Math.round((to - from) / 60_000));
  return min < 90 ? `${min} minute${min === 1 ? '' : 's'}` : `${Math.round(min / 60)} hours`;
}

export function RunTranscriptView({
  run,
  record,
  ask,
  onBack,
}: {
  run: WorkRecordRun;
  record: WorkRecord;
  ask: string;
  onBack: () => void;
}) {
  const [transcript, setTranscript] = useState<RunTranscript | null>(null);
  const [failed, setFailed] = useState(false);
  const [stepIdx, setStepIdx] = useState(0);
  const [opening, setOpening] = useState(false);
  const [noPlace, setNoPlace] = useState(false);
  const scroller = useRef<HTMLDivElement>(null);

  const flows = useFlowsStore((s) => s.flows);
  const flowsLoaded = useFlowsStore((s) => s.loaded);
  const projects = useStore((s) => s.projects);
  useEffect(() => {
    if (!flowsLoaded) void useFlowsStore.getState().reload(projects.map((p) => p.path));
  }, [flowsLoaded, projects]);
  // Runs logged before the log kept flow ids are matched by name.
  const flow = flows.find((f) => (run.flowId ? f.id === run.flowId : f.name === run.flowName));

  useEffect(() => {
    let live = true;
    setTranscript(null);
    setFailed(false);
    window.overcli
      .invoke('work:runTranscript', { runId: run.id, ...(run.cwd ? { cwd: run.cwd } : {}) })
      .then((t) => live && setTranscript(t))
      .catch(() => live && setFailed(true));
    return () => {
      live = false;
    };
  }, [run.id, run.cwd]);

  const step = transcript?.steps[stepIdx];
  const planAt = useMemo(() => longestAssistant(transcript?.steps[0]), [transcript]);
  const files = useMemo(() => filesNamed(transcript), [transcript]);
  const replies = step ? fromYou(step) : 0;
  const lastStep = (transcript?.steps.length ?? 1) - 1;

  const openFlow = () => {
    if (!flow) return;
    useFlowsStore.getState().openEditor({ kind: 'editing', flowId: flow.id });
    useStore.getState().setDetailMode('flows');
  };
  const runAgain = () => flow && useStore.getState().openSheet({ type: 'flowLaunch', flowId: flow.id });
  const continueInChat = async () => {
    setOpening(true);
    const first = transcript?.steps[0];
    const plan = planAt >= 0 && first ? first.messages[planAt].text : '';
    const capped = plan.length > PLAN_CAP ? `${plan.slice(0, PLAN_CAP)}…` : plan;
    const draft =
      contextDraft(record, ask).trimEnd() +
      (capped ? `\n\nThe plan this run wrote (${first?.label ?? 'first step'}):\n${capped}` : '') +
      '\n\n';
    const ok = await openChatInPlace(record, draft);
    setOpening(false);
    if (!ok) setNoPlace(true);
  };
  const jumpTo = (id: string) => document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  const pickStep = (i: number) => {
    setStepIdx(i);
    scroller.current?.scrollTo({ top: 0 });
  };

  return (
    <div className="flex flex-col min-h-0 flex-1">
      <header className="flex-none px-10 pt-4 pb-5 border-b border-card bg-surface-muted/60 flex flex-col gap-2.5">
        <nav aria-label="Breadcrumb" className="flex items-center gap-1.5 text-xs text-ink-faint">
          <button onClick={onBack} className="hover:text-ink">Work</button>
          <span aria-hidden>›</span>
          <button onClick={onBack} className="hover:text-ink truncate max-w-[40ch]">{record.title}</button>
          <span aria-hidden>›</span>
          <span className="text-ink-muted">Transcript</span>
        </nav>
        <div className="flex items-end gap-6">
          <div className="flex-1 min-w-0 flex flex-col gap-2">
            <div className="flex items-center gap-2 text-[11px] uppercase tracking-wider text-ink-faint font-semibold">
              <span className="w-2 h-2 rounded-sm bg-accent" aria-hidden />
              Flow run · {run.flowName}
            </div>
            <h1
              className="m-0 text-[26px] leading-tight font-bold tracking-tight text-ink truncate"
              style={{ fontFamily: "'Bricolage Grotesque', sans-serif" }}
              title={run.title}
            >
              {run.title}
            </h1>
            <div className="flex items-center gap-2 flex-wrap text-xs text-ink-muted">
              <span className="px-2 py-0.5 rounded bg-card-strong">{record.placeName}</span>
              <span className="px-2 py-0.5 rounded-full text-[11px] font-semibold bg-green-500/15 text-green-700 dark:text-green-300">
                Done
              </span>
              <span>
                {when(record.startedAt)} · took {took(record.startedAt, run.at)}
                {transcript ? ` · ${transcript.steps.length} step${transcript.steps.length === 1 ? '' : 's'}` : ''}
              </span>
              <span className="px-2 py-0.5 rounded-full border border-card-strong text-[11px] text-ink-faint">
                Read back from transcripts
              </span>
            </div>
          </div>
          <div className="flex-none flex items-center gap-2">
            {/* No "Open run": the run itself was evicted, and this page is
                what is left of it. Editing the flow's setup is in the rail. */}
            {flow && (
              <button
                onClick={runAgain}
                title="Launch this flow again — you choose the prompt and place"
                className="text-xs px-3.5 py-2 rounded-md border border-card-strong text-ink hover:bg-card-strong"
              >
                Run again…
              </button>
            )}
            <button
              onClick={() => void continueInChat()}
              disabled={opening || !transcript}
              title={`A new chat in ${record.placeName}, with this work and the run's plan in the message box — nothing is sent until you send it`}
              className="text-xs font-semibold px-4 py-2 rounded-md bg-accent text-white hover:opacity-90 disabled:opacity-50"
            >
              {opening ? 'Opening…' : 'Continue in a new chat'}
            </button>
          </div>
        </div>
        {noPlace && (
          <div className="text-[11px] text-red-600 dark:text-red-300">
            {record.placeName} isn’t a place in the sidebar any more, so there’s nowhere to open the chat.
          </div>
        )}
      </header>

      {failed ? (
        <div className="px-10 py-8 text-xs text-ink-muted">Couldn’t read this run’s transcripts.</div>
      ) : !transcript ? (
        <div className="px-10 py-8 text-xs text-ink-faint">Reading transcripts…</div>
      ) : transcript.steps.length === 0 ? (
        <div className="px-10 py-8 text-xs text-ink-muted">
          No transcripts were found for this run. Only Claude steps are kept on disk; other backends’ history isn’t read here yet.
        </div>
      ) : (
        <div className="flex-1 min-h-0 grid grid-cols-[240px_minmax(0,1fr)] xl:grid-cols-[240px_minmax(0,1fr)_300px]">
          <nav aria-label="Steps" className="border-r border-card overflow-y-auto sidebar-scroll py-5 px-4 flex flex-col">
            <div className="px-2 pb-2 text-[10px] uppercase tracking-wider text-ink-faint font-semibold">Steps</div>
            {transcript.steps.map((s, i) => {
              const { step: name, who } = splitLabel(s.label);
              const on = i === stepIdx;
              return (
                <div key={s.sessionId}>
                  {i > 0 && <div className="w-px h-3 bg-[var(--c-card-border-strong)] ml-[21px]" aria-hidden />}
                  <button
                    onClick={() => pickStep(i)}
                    aria-current={on ? 'step' : undefined}
                    className={
                      'w-full text-left rounded-lg p-2.5 flex gap-2.5 ' +
                      (on ? 'bg-accent/15 text-ink' : 'text-ink-muted hover:bg-card-strong hover:text-ink')
                    }
                  >
                    <span
                      className={
                        'flex-none w-[22px] h-[22px] rounded-full text-[11px] font-bold flex items-center justify-center tabular-nums ' +
                        (on ? 'bg-accent text-white' : 'bg-card-strong text-ink-muted')
                      }
                    >
                      {i + 1}
                    </span>
                    <span className="min-w-0">
                      <span className={`block text-[13px] truncate ${on ? 'font-semibold' : ''}`}>{name}</span>
                      <span className="block text-[11px] text-ink-faint truncate">
                        {who}
                        {s.messages[0]?.at ? ` · ${clock(s.messages[0].at)}` : ''} · {s.messages.length} messages
                      </span>
                      {fromYou(s) > 0 && (
                        <span className="block text-[11px] text-accent truncate">
                          {fromYou(s)} from you
                        </span>
                      )}
                    </span>
                  </button>
                </div>
              );
            })}
          </nav>

          <div ref={scroller} className="overflow-y-auto sidebar-scroll px-12 py-6">
            {step && (
              <div className="flex flex-col gap-5 max-w-[1100px]">
                {step.truncated && (
                  <div className="text-[11px] text-ink-faint">A long session — showing its most recent messages.</div>
                )}
                {step.messages.map((m, i) => {
                  const key = `${step.sessionId}:${i}`;
                  const who = splitLabel(step.label).who;
                  if (m.role === 'user') {
                    return i === 0 ? (
                      <Brief key={key} text={m.text} />
                    ) : (
                      <div key={key} id={i === step.messages.length - 1 ? 'run-last' : undefined} className="flex justify-end">
                        <div className="max-w-[70%] rounded-xl bg-accent/15 px-4 py-2.5 text-[13.5px] text-ink whitespace-pre-wrap">
                          <div className="text-[10px] uppercase tracking-wider text-ink-faint font-semibold mb-1">You</div>
                          {m.text}
                        </div>
                      </div>
                    );
                  }
                  const isPlan = stepIdx === 0 && i === planAt;
                  return (
                    <div key={key} id={isPlan ? 'run-plan' : i === step.messages.length - 1 ? 'run-last' : undefined} className="flex gap-3.5">
                      <span
                        className="flex-none w-7 h-7 rounded-full bg-backend-claude/15 text-backend-claude text-[11px] font-bold flex items-center justify-center uppercase"
                        aria-hidden
                      >
                        {who.charAt(0)}
                      </span>
                      <div
                        className={
                          'flex-1 min-w-0 ' +
                          (isPlan ? 'rounded-xl border border-accent/40 bg-card px-5 py-4' : '')
                        }
                      >
                        <div className="flex items-center gap-2 text-[11px] text-ink-faint mb-1">
                          {isPlan && (
                            <span className="px-2 rounded-full bg-accent text-white font-semibold leading-[18px]">The plan</span>
                          )}
                          <span className="text-ink-muted font-semibold">{who}</span>
                          {m.at ? <span>· {clock(m.at)}</span> : null}
                        </div>
                        <Markdown source={m.text} />
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          <aside className="hidden xl:flex flex-col gap-6 border-l border-card overflow-y-auto sidebar-scroll p-5">
            <section className="flex flex-col gap-2">
              <h2 className="m-0 text-[10px] uppercase tracking-wider text-ink-faint font-semibold">About this run</h2>
              <dl className="m-0 grid grid-cols-[72px_minmax(0,1fr)] gap-y-2 text-xs">
                <dt className="text-ink-faint">Flow</dt>
                <dd className="m-0 min-w-0 flex flex-col gap-0.5">
                  <span className="text-ink">{run.flowName}</span>
                  {flow ? (
                    <button onClick={openFlow} className="self-start text-[11px] text-accent hover:underline">
                      Edit flow setup
                    </button>
                  ) : (
                    <span className="text-[11px] text-ink-faint">No longer in your library</span>
                  )}
                </dd>
                <dt className="text-ink-faint">Place</dt>
                <dd className="m-0 text-ink truncate">{record.placeName}</dd>
                <dt className="text-ink-faint">Started</dt>
                <dd className="m-0 text-ink">{when(record.startedAt)}</dd>
                <dt className="text-ink-faint">Took</dt>
                <dd className="m-0 text-ink">{took(record.startedAt, run.at)}</dd>
              </dl>
            </section>
            {files.length > 0 && (
              <section className="flex flex-col gap-2">
                <h2 className="m-0 text-[10px] uppercase tracking-wider text-ink-faint font-semibold">Files it named</h2>
                <ul className="m-0 p-0 list-none flex flex-col gap-1.5 font-mono text-[11px] text-ink-muted">
                  {files.map((f) => (
                    <li key={f} className="truncate" title={f}>
                      {f}
                    </li>
                  ))}
                </ul>
              </section>
            )}
            <section className="flex flex-col gap-1.5 text-xs">
              <h2 className="m-0 mb-0.5 text-[10px] uppercase tracking-wider text-ink-faint font-semibold">Jump to</h2>
              {planAt >= 0 && (
                <button
                  onClick={() => {
                    if (stepIdx !== 0) setStepIdx(0);
                    setTimeout(() => jumpTo('run-plan'), 0);
                  }}
                  className="text-left text-accent hover:underline"
                >
                  The plan (step 1)
                </button>
              )}
              {replies > 0 && <span className="text-ink-faint">You wrote {replies} message{replies === 1 ? '' : 's'} in this step</span>}
              <button
                onClick={() => {
                  if (stepIdx !== lastStep) setStepIdx(lastStep);
                  setTimeout(() => jumpTo('run-last'), 0);
                }}
                className="text-left text-accent hover:underline"
              >
                Where it ended (last message)
              </button>
            </section>
          </aside>
        </div>
      )}
    </div>
  );
}

/// A step's opening prompt is the flow's brief to that agent — thousands of
/// characters of instructions. Folded to its first lines, so the agent's
/// answers are what you read.
function Brief({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  const long = text.length > BRIEF_PREVIEW;
  return (
    <div className="rounded-xl bg-accent/10 px-5 py-3.5 text-xs text-ink-muted">
      <div className="flex items-center gap-2 mb-1.5 text-[11px]">
        <span className="uppercase tracking-wider font-semibold text-accent">Brief</span>
        <span className="text-ink-faint">the flow’s instructions to this step</span>
        <span className="flex-1" />
        {long && (
          <button onClick={() => setOpen((o) => !o)} className="text-accent hover:underline">
            {open ? 'Show less' : 'Show all'}
          </button>
        )}
      </div>
      <div className="whitespace-pre-wrap leading-relaxed">{long && !open ? `${text.slice(0, BRIEF_PREVIEW)}…` : text}</div>
    </div>
  );
}
