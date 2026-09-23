// The setup guide, reachable on purpose.
//
// The same card the first-run screen shows, except that screen only exists on
// a machine with zero projects. Sign out of Claude three months in and the app
// can tell you a turn failed, but the commands that fix it used to live behind
// a state you could never get back to. They live here now: Help → Setup, the
// command palette, and Settings → Backends.

import { useStore } from '../../store';
import { ALL_SETUP_BACKENDS, CliSetupGuide } from '../onboarding/cliSetup';
import { GitInstallNotice, useGitAvailability } from '../GitInstallNotice';
import { HelpFooter, HelpHeader, HelpLink, HelpSection } from './helpChrome';

export function SetupSheet() {
  const openSheet = useStore((s) => s.openSheet);
  const backendHealth = useStore((s) => s.backendHealth);
  // Git is the other thing overcli cannot do without: no git, no agents, no
  // worktrees, no version history on an everyday project. It belongs on this
  // screen because "why can't I run an agent?" and "why is Claude signed
  // out?" are the same question asked of the same page.
  const git = useGitAvailability();
  const ready = ALL_SETUP_BACKENDS.filter((b) => backendHealth[b]?.kind === 'ready').length;

  return (
    <div className="flex max-h-[86vh] flex-col">
      <HelpHeader
        title="What this machine can run."
        lead={
          <>
            Overcli has no account and no API key of its own. It drives the coding CLIs you
            have signed into yourself, so setup is whatever those need — an install, a
            sign-in, and git.
          </>
        }
        trailing={
          <div className="shrink-0 rounded-lg border border-card bg-card/50 px-3 py-2 text-right">
            <div className="text-[18px] font-semibold leading-none tabular-nums text-ink">
              {ready}
              <span className="text-ink-faint">/{ALL_SETUP_BACKENDS.length}</span>
            </div>
            <div className="mt-1 font-mono text-[10px] uppercase tracking-[0.14em] text-ink-faint">
              signed in
            </div>
          </div>
        }
      />

      <div className="min-h-0 flex-1 overflow-y-auto px-7 py-5">
        <CliSetupGuide backendHealth={backendHealth} />

        <HelpSection
          title="Git"
          lead="Agents, worktrees, diffs and the version history of a documents project are all git underneath."
        >
          {git == null ? (
            <div className="text-[12px] text-ink-faint">Checking…</div>
          ) : git.state === 'ok' ? (
            <div className="rounded-lg border border-card bg-card/40 px-4 py-3 text-[12px] text-ink-muted">
              <span className="text-emerald-600 dark:text-emerald-300">✓</span> git {git.version}{' '}
              — worktrees, diffs and version history all available.
            </div>
          ) : (
            <GitInstallNotice state={git.state} lead="Agents and worktrees need Git." />
          )}
        </HelpSection>
      </div>

      <HelpFooter>
        <HelpLink label="How overcli works" onClick={() => openSheet({ type: 'basics' })} />
        <HelpLink label="Settings" onClick={() => openSheet({ type: 'settings' })} />
        <span className="flex-1" />
        <HelpLink label="Close" onClick={() => openSheet(null)} />
      </HelpFooter>
    </div>
  );
}
