import { useMemo, useState } from 'react';
import { useStore } from '../store';
import { useRunnerEvents } from '../runnersStore';
import { findConvLocation } from '../conversationLookup';
import { isEverydayProject } from '@shared/everydayProjects';
import { siblingProjectsTouched } from '../siblingRepos';
import type { UUID } from '@shared/types';

/// Offers once per conversation per app session; "Stay here" means stay.
const dismissed = new Set<UUID>();

/// "This changes acme-api too." Shown above the composer once a conversation
/// in one project changes files in a sibling repo, with the file it changed
/// so the card never appears for no visible reason. Sits in the same stack as the changes bar and the composer,
/// so it takes their width and shape rather than its own margins. It is the most honest
/// place to meet workspaces: the user has just hit the limit they remove.
///
/// Continuing starts a fresh conversation in the workspace with a pointer
/// back to this one; the transcript itself stays where it is.
export function SiblingRepoCard({ conversationId }: { conversationId: UUID }) {
  const projects = useStore((s) => s.projects);
  const workspaces = useStore((s) => s.workspaces);
  const openWorkspaceWith = useStore((s) => s.openWorkspaceWith);
  const events = useRunnerEvents(conversationId);
  const [hidden, setHidden] = useState(() => dismissed.has(conversationId));

  const location = findConvLocation({ projects, workspaces }, conversationId);
  const owner = location?.kind === 'project' ? location.project : null;
  const conversation = location?.conversation;

  const edits = useMemo(
    () =>
      // Skipped once dismissed: this reruns as the transcript streams.
      !hidden && owner && !isEverydayProject(owner) && events
        ? siblingProjectsTouched(owner, projects, events).filter((e) => !isEverydayProject(e.project))
        : [],
    [hidden, owner, projects, events],
  );

  if (hidden || !owner || edits.length === 0) return null;

  const names = edits.map((e) => e.project.name);
  const named = names.length === 1 ? names[0] : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
  // The evidence, so the card is never a mystery: the first file changed in
  // each sibling, which is what the chat above will show too.
  const why = edits.map((e) => `${e.project.name}/${e.file}`);
  const dismiss = () => {
    dismissed.add(conversationId);
    setHidden(true);
  };
  const cont = () => {
    dismiss();
    void openWorkspaceWith(
      [owner.id, ...edits.map((e) => e.project.id)],
      `Carrying on from "${conversation?.name ?? 'an earlier chat'}" in ${owner.name}: `,
    );
  };

  return (
    <div className="rounded-xl border border-card-strong bg-card px-3 py-2 flex items-center gap-3">
      <div className="flex-1 min-w-0">
        <div className="text-xs font-medium text-ink">This changes {named} too.</div>
        <div className="text-[11px] text-ink-muted">
          Continue in a workspace with {owner.name} and {named}, so one conversation can change
          all of them and you review the changes together.
        </div>
        <div className="text-[11px] text-ink-faint truncate mt-0.5" title={why.join('\n')}>
          Edited <span className="font-mono">{why[0]}</span>
          {why.length > 1 ? ` and ${why.length - 1} more` : ''}
        </div>
      </div>
      <button
        onClick={dismiss}
        className="shrink-0 px-2.5 py-1 rounded text-xs text-ink-muted hover:text-ink hover:bg-card-strong"
      >
        Stay here
      </button>
      <button
        onClick={cont}
        className="shrink-0 px-2.5 py-1 rounded text-xs border bg-accent/30 border-accent/60 text-accent hover:bg-accent/40"
      >
        Continue in workspace
      </button>
    </div>
  );
}
