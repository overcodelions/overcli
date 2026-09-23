// Everything the app knows about getting a coding CLI onto the machine:
// which ones exist, what to run, and how to render that as something you
// can act on without leaving the window.
//
// Split out of WelcomePane because the welcome screen only renders it on a
// machine with zero projects. Somebody who added a project in March and
// signed out of Claude in May needs the same guide, so the Setup sheet
// (Help → Setup, or Settings → Backends) renders it too.

import { useEffect, useState } from 'react';
import { useStore } from '../../store';
import { CopyButton } from '../ManualCommand';
import { backendColor } from '../../theme';
import type { Backend, BackendHealth } from '@shared/types';
import { CLI_SETUP, cliSetupPlan, type CliSetupRowData } from './cliSetupPlan';

export { ALL_SETUP_BACKENDS, CLI_SETUP, joinNames, type CliSetupEntry } from './cliSetupPlan';

/// Says what already works as well as what still needs doing — otherwise a
/// healthy machine opens Setup and is told nothing at all. Both the welcome
/// screen and the Setup sheet render it the same way.
export function CliSetupGuide({
  backendHealth,
}: {
  backendHealth: Record<string, BackendHealth>;
}) {
  const refreshBackendHealth = useStore((s) => s.refreshBackendHealth);
  const openSheet = useStore((s) => s.openSheet);
  const [recheckedAt, setRecheckedAt] = useState(0);

  const { ready, rows, signIn, featured, others, done, headline, subline } =
    cliSetupPlan(backendHealth);

  // Someone staring at this screen is, right now, in a terminal running one
  // of the commands below. Poll while something is still unset so the app
  // notices on its own — the alternative is a user who installs a CLI, comes
  // back to a screen that still says "install a CLI", and concludes the app
  // is broken. `force` drops main's 15s probe cache; only when the window has
  // focus, so a backgrounded app isn't respawning CLIs forever. Nothing left
  // to wait for (the sheet on a fully set-up machine) means no polling.
  const watching = rows.length > 0;
  useEffect(() => {
    if (!watching) return;
    const tick = () => {
      if (!document.hasFocus()) return;
      void refreshBackendHealth(true);
    };
    const id = setInterval(tick, 4000);
    // Coming back from the terminal is the exact moment the answer changes.
    window.addEventListener('focus', tick);
    return () => {
      clearInterval(id);
      window.removeEventListener('focus', tick);
    };
  }, [refreshBackendHealth, watching]);

  if (rows.length === 0 && ready.length === 0) {
    return (
      <div className={frame('amber')}>
        <div className="text-sm font-medium text-ink">Every CLI is switched off</div>
        <div className="mt-1 text-[12px] text-ink-muted">
          All five backends are disabled in settings, so there's nothing for overcli to
          drive. Re-enable one to get started.
        </div>
        <button
          onClick={() => openSheet({ type: 'settings' })}
          className="mt-3 px-3 py-1.5 rounded-md bg-accent/25 text-accent hover:bg-accent/35 text-xs font-medium"
        >
          Open settings
        </button>
      </div>
    );
  }

  return (
    <div className={frame(done ? 'ok' : 'amber')}>
      <div className="text-sm font-medium text-ink">{headline}</div>
      <div className="mt-1 mb-4 text-[12px] leading-relaxed text-ink-muted">{subline}</div>

      {/* Leads with what already works, because "is my machine fine?" is
          the question that brought the user here. */}
      {ready.length > 0 && (
        <>
          <div className="mb-1.5 text-[10px] uppercase tracking-[0.18em] text-ink-faint">
            Ready
          </div>
          <div className="flex flex-col gap-1.5 mb-4">
            {ready.map((row) => (
              <CliSetupRow key={row.backend} row={row} compact />
            ))}
          </div>
        </>
      )}

      {rows.length > 0 && (
        <>
          {ready.length > 0 && (
            <div className="mb-1.5 text-[10px] uppercase tracking-[0.18em] text-ink-faint">
              Not set up yet
            </div>
          )}
          <div className="flex flex-col gap-1.5">
            {signIn.map((row) => (
              <CliSetupRow key={row.backend} row={row} />
            ))}
            {featured.map((row) => (
              <CliSetupRow key={row.backend} row={row} />
            ))}
          </div>
        </>
      )}

      {others.length > 0 && (
        <>
          <div className="mt-4 mb-1.5 text-[10px] uppercase tracking-[0.18em] text-ink-faint">
            Also supported
          </div>
          <div className="flex flex-col gap-1.5">
            {others.map((row) => (
              <CliSetupRow key={row.backend} row={row} compact />
            ))}
          </div>
        </>
      )}

      <div className="mt-4 pt-3 border-t border-card flex items-center gap-2 text-[10.5px] text-ink-faint">
        {watching && <Spinner />}
        <span className="flex-1">
          {watching
            ? 'Watching for a CLI — no need to restart overcli.'
            : 'Signed out of one later? This page notices on its own.'}
        </span>
        <button
          onClick={() => {
            setRecheckedAt(Date.now());
            void refreshBackendHealth(true);
          }}
          className="rounded px-1.5 py-0.5 font-medium text-ink-muted hover:text-ink hover:bg-card-strong"
        >
          {recheckedAt ? 'Check again' : 'Check now'}
        </button>
      </div>
    </div>
  );
}

/// The card around the guide. Amber while something is unfinished, plain
/// once it isn't — and no top margin, since both hosts bring their own.
function frame(tone: 'amber' | 'ok'): string {
  const border = tone === 'amber' ? 'border-amber-500/40' : 'border-card';
  return `rounded-lg border ${border} bg-surface-elevated p-5 text-left`;
}

function CliSetupRow({ row, compact }: { row: CliSetupRowData; compact?: boolean }) {
  const { backend, name, blurb, install, auth, docs, kind, health } = row;
  const isAuth = kind === 'unauthenticated';
  // A CLI that already works has nothing to run. Printing its install
  // command next to a green tick reads as "do this", which is how people
  // end up reinstalling a working toolchain.
  const isReady = kind === 'ready';
  const command = isAuth && auth ? auth : install;
  // "Download from ollama.com" is prose, not something to paste in a shell.
  const canCopy = !isReady && (command.startsWith('npm') || isAuth);
  return (
    <div className="rounded-md px-3 py-2 bg-card/60">
      <div className="flex items-center gap-2.5">
        <span
          className="w-1.5 h-1.5 rounded-full shrink-0"
          style={{
            backgroundColor: isAuth ? '#f59e0b' : backendColor(backend),
            opacity: isAuth || isReady ? 1 : 0.45,
          }}
        />
        <span className="text-xs font-semibold shrink-0" style={{ color: backendColor(backend) }}>
          {name}
        </span>
        {isAuth ? (
          <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-amber-500/15 text-amber-600 dark:text-amber-300 shrink-0">
            installed · signed out
          </span>
        ) : isReady ? (
          <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-emerald-500/15 text-emerald-600 dark:text-emerald-300 shrink-0">
            ✓ signed in
          </span>
        ) : (
          <code className="flex-1 min-w-0 text-[11px] font-mono text-ink truncate">{command}</code>
        )}
        {(isAuth || isReady) && <span className="flex-1" />}
        {isAuth && <SignInButton backend={backend} name={name} />}
        {canCopy && <CopyButton value={command} />}
        <a
          href={docs}
          target="_blank"
          rel="noopener noreferrer"
          className="shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium text-ink-muted hover:text-accent hover:bg-card-strong"
          title={`${name} install & sign-in docs`}
        >
          Docs ↗
        </a>
      </div>
      {isAuth && (
        <code className="mt-1 block text-[11px] font-mono text-ink-muted truncate">{command}</code>
      )}
      {!compact && !isAuth && !isReady && (
        <div className="mt-0.5 text-[10.5px] text-ink-faint">{blurb}</div>
      )}
      {/* An `error` kind means the binary is there but wouldn't run — a
          version mismatch, a broken shim, a quarantined binary. The install
          command won't fix that, so show what actually went wrong. */}
      {kind === 'error' && health?.message && (
        <div className="mt-1 text-[10.5px] text-red-500 dark:text-red-400 break-words">
          Found it, but it wouldn't run: {health.message}
        </div>
      )}
    </div>
  );
}

/// Opens Terminal on the backend's login command (same path the in-chat
/// auth banner uses). Beats "copy this, find a terminal, paste it".
function SignInButton({ backend, name }: { backend: Backend; name: string }) {
  const [launching, setLaunching] = useState(false);
  const [launched, setLaunched] = useState(false);
  const [error, setError] = useState<{ text: string; command?: string } | null>(null);
  return (
    <>
      {error && <span className="text-[10px] text-red-400 shrink-0">{error.text}</span>}
      {error?.command && <CopyButton value={error.command} />}
      <button
        onClick={async () => {
          setLaunching(true);
          setError(null);
          try {
            const res = await window.overcli.invoke('auth:openCliLogin', backend);
            if (res.ok) setLaunched(true);
            else setError({ text: res.error, command: res.command });
          } catch (err) {
            // The IPC itself failed — say so where the click happened, with
            // the command to run by hand, rather than a button that just
            // stops spinning.
            setError({
              text: `Couldn't open Terminal: ${err instanceof Error ? err.message : String(err)}`,
              command: CLI_SETUP.find((c) => c.backend === backend)?.auth ?? undefined,
            });
          } finally {
            setLaunching(false);
          }
        }}
        disabled={launching}
        title={`Open Terminal and sign into ${name}`}
        className="shrink-0 rounded px-2 py-0.5 text-[10px] font-medium bg-amber-500/20 text-amber-700 dark:text-amber-200 hover:bg-amber-500/30 disabled:opacity-50"
      >
        {launching ? 'Opening…' : launched ? 'Reopen Terminal' : 'Sign in'}
      </button>
    </>
  );
}

export function Spinner() {
  return (
    <svg className="w-3 h-3 animate-spin shrink-0" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <circle cx="8" cy="8" r="6" stroke="currentColor" strokeWidth="2" opacity="0.25" />
      <path d="M14 8a6 6 0 00-6-6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}
