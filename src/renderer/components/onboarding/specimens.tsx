// The canned examples the app uses to show what a feature is like.
//
// One copy of each, because they now appear in two places: the tab's landing
// (components/onboarding/landing) and the About sheet. A rota that said
// "06:45 Chief of Staff" on one screen and "07:15" on the other would give
// away that both are inventions; keeping them here means they are the same
// Tuesday wherever you meet it.
//
// Everything here is fictional but shaped like real output — the states are
// the ones you actually meet (a worker that asked a question, a process that
// died and is restarting, a proposal you struck out), because a specimen
// where nothing has gone wrong is an advert.

import { useEffect, useState } from 'react';

import { Specimen, SpecimenRow } from './landing';

interface RotaEntry {
  at: string;
  who: string;
  what: string;
  tint: string;
}

/// Colours are the identity palette, so the three names read as three people
/// here for the same reason they do on the calendar.
const ROTA: RotaEntry[] = [
  { at: '06:45', who: 'Chief of Staff', what: 'Filed your morning brief', tint: '#a78bfa' },
  { at: '08:00', who: 'Fielder', what: 'Started its hourly pass', tint: '#38bdf8' },
  {
    at: '11:04',
    who: 'Test Runner',
    what: 'why did the nightly build get slower this week?',
    tint: '#34d399',
  },
  { at: '17:00', who: 'Fielder', what: 'Last pass — 2 proposals waiting', tint: '#38bdf8' },
  { at: '19:00', who: 'Test Runner', what: 'Suite green, 1,821 passed', tint: '#34d399' },
];

/// One Tuesday, as a rota — the half of the story that happens without you.
/// No list of terms renders a DAY, and the day is what a worker is for.
export function RotaSpecimen({ footnote = true }: { footnote?: boolean }) {
  return (
    <Specimen
      label="A Tuesday"
      aside="nobody asked for any of it"
      tint="#38bdf8"
      footnote={
        footnote
          ? "Three hires, one day, no prompting. Each one re-read the project and its own journal that morning and decided what today's version of its job was."
          : undefined
      }
    >
      {ROTA.map((entry) => (
        <SpecimenRow
          key={entry.at}
          lead={entry.at}
          tint={entry.tint}
          title={entry.who}
          detail={entry.what}
        />
      ))}
    </Specimen>
  );
}

/// The four processes almost every project actually has, in the states you
/// meet them in — including the one that just died.
const STACK: { name: string; port: string; state: string; tint: string }[] = [
  { name: 'web', port: ':3000', state: 'running · vite, ready in 412ms', tint: '#34d399' },
  { name: 'api', port: ':8080', state: 'running · 2 requests in flight', tint: '#34d399' },
  { name: 'worker', port: '—', state: 'restarting · exited 1, log kept', tint: '#f59e0b' },
  { name: 'postgres', port: ':5432', state: 'stopped · started with the stack', tint: '#64748b' },
];

export function StackSpecimen({ footnote = true }: { footnote?: boolean }) {
  return (
    <Specimen
      label="A stack, mid-morning"
      aside="four processes, one window"
      tint="#34d399"
      footnote={
        footnote ? (
          <>
            Every row is a real process with its own log — stop it, restart it, move it to
            another branch, or read what it printed three hours ago. And the log is one
            keystroke from a conversation: typing{' '}
            <code className="rounded bg-card px-1 py-0.5 font-mono text-[10.5px]">@worker</code>{' '}
            in any chat hands the model what that process just printed.
          </>
        ) : undefined
      }
    >
      {STACK.map((row) => (
        <SpecimenRow
          key={row.name}
          tint={row.tint}
          title={
            <span className="flex items-baseline gap-1.5">
              {row.name}
              <span className="tabular-nums text-[10.5px] text-ink-faint">{row.port}</span>
            </span>
          }
          titleClass="w-[104px]"
          detail={row.state}
        />
      ))}
    </Specimen>
  );
}

/// Three empty chairs, which are also the trust ladder: the rings a worker
/// wears once hired, drawn without a face. Dashed → solid → doubled is the
/// same progression `WorkerAvatar` renders, so the mark teaches the vocabulary
/// before there is anyone to read it on.
export function TrustLadderMark({ scale = 1 }: { scale?: number }) {
  const rungs = [
    { tint: "#f59e0b", label: "probation", style: "dashed" as const },
    { tint: "#38bdf8", label: "trusted", style: "solid" as const },
    { tint: "#34d399", label: "autonomous", style: "double" as const },
  ];
  return (
    <div className="flex items-start gap-3" aria-hidden>
      {rungs.map((rung, i) => (
        <div key={rung.label} className="flex items-start gap-3">
          <div className="flex flex-col items-center gap-2">
            <span
              className="rounded-full"
              style={{
                width: 36 * scale,
                height: 36 * scale,
                border: `1.5px ${rung.style === "double" ? "solid" : rung.style} color-mix(in srgb, ${rung.tint} 55%, transparent)`,
                boxShadow:
                  rung.style === "double"
                    ? `0 0 0 2px color-mix(in srgb, ${rung.tint} 18%, transparent)`
                    : undefined,
              }}
            />
            <span className="text-[9px] uppercase tracking-[0.1em] text-ink-faint">
              {rung.label}
            </span>
          </div>
          {i < rungs.length - 1 && (
            <span
              className="h-px w-6"
              style={{
                // Meets the rings on their centre line, which moves with scale.
                marginTop: 18 * scale,
                background: "color-mix(in srgb, var(--c-ink) 14%, transparent)",
              }}
            />
          )}
        </div>
      ))}
    </div>
  );
}

/// The one thing on these landings that moves.
///
/// Everything else in this module is a still: a rota, a stack, a pipeline.
/// This is a demo, and it earns the exception because what it shows IS a
/// sequence — you type an @, a log you never opened is handed to the model,
/// and an answer comes back about a process that is still running. Written
/// out as four bullet points that reads as nothing; played once, it reads as
/// the feature.
///
/// Rules it keeps: it plays ONCE on mount and then sits still forever, it
/// respects `prefers-reduced-motion` by rendering the finished state
/// immediately, and every timer is cleaned up. Nothing else on a landing
/// animates, so this stays the single orchestrated moment rather than the
/// first of many.
export function ServiceAskDemo() {
  const ASK = 'why did @web stop serving assets?';
  const [typed, setTyped] = useState(0);
  const [phase, setPhase] = useState<'typing' | 'attached' | 'thinking' | 'answered'>(
    'typing',
  );

  useEffect(() => {
    const reduced =
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (reduced) {
      setTyped(ASK.length);
      setPhase('answered');
      return;
    }
    const timers: ReturnType<typeof setTimeout>[] = [];
    // One character every 38ms is close to a fast typist and slow enough to
    // read the `@web` land as a chip rather than as text.
    const typing = setInterval(() => {
      setTyped((n) => {
        if (n >= ASK.length) {
          clearInterval(typing);
          timers.push(setTimeout(() => setPhase('attached'), 260));
          timers.push(setTimeout(() => setPhase('thinking'), 900));
          timers.push(setTimeout(() => setPhase('answered'), 2100));
          return n;
        }
        return n + 1;
      });
    }, 38);
    return () => {
      clearInterval(typing);
      for (const t of timers) clearTimeout(t);
    };
  }, []);

  // The @ reference is a chip in the composer, so it is a chip here too.
  const head = ASK.slice(0, Math.max(0, Math.min(typed, ASK.indexOf('@web'))));
  const mentionTyped = Math.max(0, typed - ASK.indexOf('@web'));
  const tail = typed > ASK.indexOf('@web') + 4 ? ASK.slice(ASK.indexOf('@web') + 4, typed) : '';

  return (
    <Specimen
      label="Asking about a service"
      aside="the log goes to the model, not through you"
      tint="var(--c-accent)"
      footnote="Nothing was pasted and no file was opened. The reference resolves at send time, so the model reads what the process printed a second ago rather than whatever was on screen when you started typing."
    >
      <div className="px-4 py-3.5">
        <div className="flex justify-end">
          <div className="max-w-[92%] rounded-xl bg-accent/20 px-3 py-2 text-[12px] leading-snug text-ink">
            {head}
            {mentionTyped > 0 && (
              <span className="mx-0.5 rounded bg-accent/30 px-1.5 py-0.5 font-medium text-ink">
                {'@web'.slice(0, Math.min(4, mentionTyped))}
              </span>
            )}
            {tail}
            {phase === 'typing' && (
              <span className="ml-0.5 inline-block h-[13px] w-[1.5px] translate-y-[2px] bg-ink/70" />
            )}
          </div>
        </div>

        {phase !== 'typing' && (
          <div className="mt-2 flex items-center justify-end gap-1.5 text-[10.5px] text-ink-faint">
            <span
              className="h-1.5 w-1.5 rounded-full"
              style={{ background: '#34d399' }}
              aria-hidden
            />
            attached · web, its newest output
          </div>
        )}

        {phase === 'thinking' && (
          <div className="mt-2.5 text-[11px] text-ink-faint">Claude is reading the log…</div>
        )}

        {phase === 'answered' && (
          <div
            className="relative mt-2.5 overflow-hidden rounded-xl"
            style={{
              background: 'color-mix(in srgb, var(--c-backend-claude) 5%, transparent)',
              border: '1px solid color-mix(in srgb, var(--c-backend-claude) 18%, transparent)',
            }}
          >
            <div
              className="absolute bottom-0 left-0 top-0 w-[2px]"
              style={{ background: 'var(--c-backend-claude)' }}
            />
            <div className="px-3 py-2.5 pl-[11px]">
              <div
                className="mb-1 text-[9px] font-medium"
                style={{ color: 'var(--c-backend-claude)' }}
              >
                Claude
              </div>
              <div className="text-[11.5px] leading-[1.6] text-ink-muted">
                It did not stop — it restarted at 09:41 and the new process never got the
                port: <span className="font-mono text-[11px] text-ink">EADDRINUSE :3000</span>.
                The worker you started a minute earlier binds 3000 too. Give one of them an
                offset port and both come up.
              </div>
            </div>
          </div>
        )}
      </div>
    </Specimen>
  );
}
