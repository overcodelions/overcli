// The zero-projects screen: the one moment overcli gets to explain itself
// before it is just another window with a text box in it.
//
// Built from the shared landing vocabulary (./landing) so Chat, Flows,
// Orchestrator, Workers and Services read as five pages of one document set
// rather than five people's idea of an empty state. The document states what
// a project IS and what you are agreeing to; the specimen beside it is this
// machine — the CLIs actually installed, right now, which is both the proof
// that nothing needs configuring and the only thing that can block you.
//
// The setup guide and the concept cards stay reachable from the Help menu,
// because this screen never comes back.

import { backendHealthLoaded, noBackendReady, useStore } from '../../store';
import { backendName } from '../../theme';
import { ALL_SETUP_BACKENDS, CLI_SETUP, CliSetupGuide, Spinner } from './cliSetup';
import { HeroArt } from './basics';
import {
  LandingColumns,
  LandingHero,
  LandingPage,
  PrimaryAction,
  QuietAction,
  SecondaryAction,
  Specimen,
  SpecimenRow,
  Terms,
} from './landing';
import { useGitAvailability } from '../GitInstallNotice';
import type { BackendHealth } from '@shared/types';

/// What you are getting, as terms rather than as feature cards. Not the Basics
/// sheet's four nouns (projects, agents, flows, workspaces) — those explain
/// what to build with overcli. These answer what happens to your folder when
/// you point it here, which is the question you have before adding one. The
/// one term both share, the project, is worded to agree: a folder, git
/// optional.
const TERMS = [
  {
    label: 'The project',
    value:
      'A folder on your disk. A git repo unlocks agents and diffs; any folder at all is enough to chat about what is in it.',
  },
  {
    label: 'The turn',
    value:
      'Runs in that folder, through a CLI you have already signed into. Edits come back as diffs, commands as real terminal blocks.',
  },
  // Workspaces, not worktrees: a worktree is how a run stays out of your way,
  // and is best explained the first time an agent makes one. A workspace is
  // a choice you make when adding a folder, so it belongs here.
  {
    label: 'The workspace',
    value:
      'Several repos that belong together. Add the folder that holds them and one conversation can read and change all of them.',
  },
  {
    label: 'The keys',
    value: 'There are none. Overcli holds no API key and adds no model of its own.',
  },
];

export function EmptyWelcome({
  onPick,
  backendHealth,
}: {
  onPick: () => void;
  backendHealth: Record<string, BackendHealth>;
}) {
  const openSheet = useStore((s) => s.openSheet);
  // Three states, not two. Until the first probe lands we know *nothing*,
  // and rendering the happy path in the meantime meant a fresh install
  // painted an enabled "Add your first project" button and then yanked it
  // away a moment later when the setup card shoved everything down the
  // page. "Checking" is its own state so the first frame is never a lie.
  const probed = backendHealthLoaded(backendHealth);
  const blocked = noBackendReady(backendHealth);

  return (
    <LandingPage
      title="Chat"
      subtitle="One conversation per task, against any CLI on this machine."
    >
      <LandingHero
        mark={<Lockup />}
        eyebrow="Nothing open yet"
        title={
          <>
            A project is a folder
            <br />
            your CLIs already work in.
          </>
        }
        lead={
          <>
            Overcli is one window over the coding CLIs on this machine — Claude, Codex,
            Gemini, Copilot and Ollama. Point it at a folder and any of them can work
            there, whether it holds code or documents.
          </>
        }
        actions={
          <>
            {/* New or existing — the one question everyone can answer. What
                kind of folder it is (code, several repos, documents) Overcli
                works out from the folder itself; see pickProject. */}
            <PrimaryAction
              label="Open a folder"
              onClick={onPick}
              disabled={blocked || !probed}
              title={blocked ? 'Set up a CLI first to add a project' : undefined}
            />
            <SecondaryAction
              label="Start something new"
              onClick={() => openSheet({ type: 'newEverydayProject' })}
              disabled={blocked || !probed}
              title={blocked ? 'Set up a CLI first to add a project' : undefined}
            />
            <QuietAction
              label="or read how overcli works"
              onClick={() => openSheet({ type: 'basics' })}
            />
            <QuietAction
              label="or see the shortcuts"
              onClick={() => openSheet({ type: 'shortcutsHelp' })}
            />
          </>
        }
        note={
          !probed
            ? 'One moment — checking what you already have installed.'
            : blocked
              ? 'Set up a CLI first; this unlocks the moment one is ready.'
              : 'Pick one repo, or a folder of repos to work on them together. Everything here stays on this machine.'
        }
      />

      <LandingColumns>
        <Terms title="What you get" items={TERMS} />
        <MachineSpecimen backendHealth={backendHealth} probed={probed} blocked={blocked} />
      </LandingColumns>
    </LandingPage>
  );
}

/// The app's own mark, which is the only stamp this page can honestly carry:
/// the other four tabs draw their subject, and Chat's subject is overcli.
function Lockup() {
  return (
    <div className="flex items-center gap-3">
      <HeroArt size={84} />
      <span className="text-[30px] font-semibold tracking-tight">
        <span className="text-ink-muted">over</span>
        <span className="text-accent">cli</span>
      </span>
    </div>
  );
}

/// The specimen for this tab is not an illustration — it is the machine.
/// Five rows off the real health probe, plus the git row that decides whether
/// agents are available at all. When something is missing it grows the full
/// setup guide underneath rather than pushing the document down the page.
function MachineSpecimen({
  backendHealth,
  probed,
  blocked,
}: {
  backendHealth: Record<string, BackendHealth>;
  probed: boolean;
  blocked: boolean;
}) {
  const git = useGitAvailability();
  const readyCount = ALL_SETUP_BACKENDS.filter((b) => backendHealth[b]?.kind === 'ready').length;

  return (
    <div>
      <Specimen
        label="This machine"
        aside={probed ? `${readyCount} of ${ALL_SETUP_BACKENDS.length} ready` : 'still checking'}
        tint={readyCount > 0 ? '#34d399' : '#f59e0b'}
        footnote={
          probed && !blocked
            ? 'Whatever those CLIs are signed into is what overcli runs as — Ollama needs no account at all. Sign out of one later and this list notices on its own.'
            : undefined
        }
      >
        {CLI_SETUP.map((cli) => {
          const kind = backendHealth[cli.backend]?.kind;
          return (
            <SpecimenRow
              key={cli.backend}
              tint={probed ? dotTint(kind) : ''}
              title={backendName(cli.backend)}
              titleClass="w-24"
              detail={stateLabel(kind, probed, cli.auth !== null)}
            />
          );
        })}
        <SpecimenRow
          tint={git == null ? '' : git.state === 'ok' ? '#34d399' : ''}
          title="Git"
          titleClass="w-24"
          detail={
            git == null
              ? 'checking…'
              : git.state === 'ok'
                ? `${git.version}, so agents and worktrees work`
                : 'not installed — agents and worktrees need it'
          }
        />
      </Specimen>

      {!probed && (
        <div className="mt-4 flex items-center gap-2 text-[11px] text-ink-faint">
          <Spinner />
          Looking for installed CLIs…
        </div>
      )}
      {/* Grows under the ledger rather than pushing the document down the
          page: the answer to "why can't I add a project" belongs beside the
          list that shows why. */}
      {probed && blocked && (
        <div className="mt-4">
          <CliSetupGuide backendHealth={backendHealth} />
        </div>
      )}
    </div>
  );
}

/// The ledger's one piece of colour: green for ready, amber for one step
/// away, red for broken, and an empty ring for absent.
function dotTint(kind: BackendHealth['kind'] | undefined): string {
  switch (kind) {
    case 'ready':
      return '#34d399';
    case 'unauthenticated':
      return '#f59e0b';
    case 'error':
      return '#f87171';
    default:
      return '';
  }
}

/// `account` is false for Ollama, which has no login at all — saying "signed
/// in" of a local runtime is the kind of small lie a first-run screen cannot
/// afford, since the whole claim of this page is that it tells you the truth
/// about your machine.
function stateLabel(
  kind: BackendHealth['kind'] | undefined,
  probed: boolean,
  account: boolean,
): string {
  if (!probed) return 'checking…';
  switch (kind) {
    case 'ready':
      return account ? 'signed in, ready to run' : 'installed, runs locally';
    case 'unauthenticated':
      return 'installed — needs a sign-in';
    case 'error':
      return 'found it, but it would not run';
    case 'unknown':
      return 'switched off in settings';
    default:
      return 'not installed';
  }
}
