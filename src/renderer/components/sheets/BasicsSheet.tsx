// "How overcli works" — the explanation the welcome screen gives once and
// then takes away forever the moment a project exists.
//
// Everything here is vocabulary the app uses in its own UI without ever
// defining it: worktrees, run modes, permission modes, rebound. Someone six
// weeks in hits "Review a branch" for the first time and has nowhere to ask
// what it means. This is that place — Help → How Overcli Works, or the
// command palette. Cut to match the About sheet, which is the one people
// already like, and it ends where About begins: on the way through to it.

import { useStore } from '../../store';
import { BasicsCards } from '../onboarding/basics';
import { permissionNote } from '../conversationHeaderHelpers';
import { HelpFooter, HelpHeader, HelpLink, HelpRow, HelpSection } from './helpChrome';
import type { PermissionMode } from '@shared/types';

/// The run modes exactly as the composer offers them, in the same order,
/// with the sentence its menu shows plus the paragraph a pill has no room
/// for. Worktrees get explained here because this is the only surface in the
/// app where there is space to say what one is.
const RUN_MODES: { label: string; note: string; body: string }[] = [
  {
    label: 'Work locally',
    note: 'in the project directory',
    body: 'Edits land in your actual checkout, on the branch you have open. The same as running the CLI in a terminal there — nothing is isolated, so this is the mode for work you intend to keep.',
  },
  {
    label: 'Run as agent',
    note: 'isolated worktree, new branch',
    body: 'Git can check the same repository out into a second directory. Overcli makes one, puts the agent in it on a fresh branch, and leaves your working copy alone — so a long run can go wrong at no cost. Afterwards you read the diff and merge it, or delete the worktree and lose nothing.',
  },
  {
    label: 'Review a branch',
    note: 'detached worktree, read-only',
    body: 'Checks a branch out somewhere else on disk and reviews it with no write access. Nothing it does can change a file, which makes it the safe way to point a model at code you did not write.',
  },
  {
    label: 'Document a branch',
    note: 'detached worktree, read-only',
    body: 'The same read-only worktree, pointed at "what would someone need to be told about this branch?" rather than "what is wrong with it?". Comes back as markdown.',
  },
];

const PERMISSION_MODES: { mode: PermissionMode; label: string }[] = [
  { mode: 'plan', label: 'Plan' },
  { mode: 'default', label: 'Default' },
  { mode: 'auto', label: 'Auto' },
  { mode: 'acceptEdits', label: 'Accept edits' },
  { mode: 'bypassPermissions', label: 'Bypass (dangerous)' },
];

const PAIRINGS: { title: string; body: string }[] = [
  {
    title: 'Rebound',
    body: 'A second model reviews each turn, or trades rounds with the first. Chosen as a preset beside the model, so pairing two CLIs is one click rather than a copy-paste of a transcript.',
  },
  {
    title: 'Colosseum',
    body: 'The same prompt against every backend at once, each in its own worktree. You read the diffs side by side and keep one.',
  },
  {
    title: 'Flows',
    body: 'A saved pipeline: plan on a premium model, build on a local one, review on a third, with the artifacts handed forward automatically. Install one from the registry or describe the pipeline and have a CLI draft it.',
  },
];

export function BasicsSheet() {
  const openSheet = useStore((s) => s.openSheet);
  return (
    <div className="flex max-h-[86vh] flex-col">
      <HelpHeader
        title="Overcli drives the CLIs you already signed into."
        lead={
          <>
            It adds no model of its own and holds no API key. What it adds is one window
            for all of them, and a way to keep their work off your checkout until you have
            read it.
          </>
        }
      />

      <div className="min-h-0 flex-1 overflow-y-auto px-7 py-5">
        <HelpSection title="The four nouns" className="mt-0">
          <BasicsCards />
        </HelpSection>

        <HelpSection
          title="Where the work happens"
          lead="Every send picks one of four run modes. The pill under the composer is where you change it, and the choice decides which copy of your repository the model can touch."
        >
          <div className="grid gap-2.5 sm:grid-cols-2">
            {RUN_MODES.map((m) => (
              <HelpRow key={m.label} title={m.label} kicker={m.note} body={m.body} />
            ))}
          </div>
        </HelpSection>

        <HelpSection
          title="What it may do without asking"
          lead="Permission mode is per conversation and can change mid-thread. It travels down to the CLI's own permission flags, so it means what it says."
        >
          <div className="grid gap-2.5 sm:grid-cols-2">
            {PERMISSION_MODES.map((m) => (
              <HelpRow
                key={m.mode}
                title={m.label}
                body={permissionNote(m.mode)}
                tone={m.mode === 'bypassPermissions' ? 'warn' : undefined}
              />
            ))}
          </div>
        </HelpSection>

        <HelpSection
          title="Two models on one problem"
          lead="None of this needs a second CLI. All of it gets better with one."
        >
          <div className="grid gap-2.5 sm:grid-cols-3">
            {PAIRINGS.map((p) => (
              <HelpRow key={p.title} title={p.title} body={p.body} />
            ))}
          </div>
        </HelpSection>
      </div>

      <HelpFooter>
        <HelpLink label="Setup" onClick={() => openSheet({ type: 'setup' })} />
        <HelpLink label="Keyboard shortcuts" onClick={() => openSheet({ type: 'shortcutsHelp' })} />
        <HelpLink label="About overcli" onClick={() => openSheet({ type: 'about' })} />
        <span className="flex-1" />
        <HelpLink label="Close" onClick={() => openSheet(null)} />
      </HelpFooter>
    </div>
  );
}
