import { useState } from 'react';
import { useStore } from '../../store';
import { UUID } from '@shared/types';
import { isEverydayProject, looksLikeEverydayProjectPath } from '@shared/everydayProjects';
import { SheetActionButton } from './SettingsSheet';

/// Both directions of "is this folder an everyday project?", for a folder the
/// user already had rather than one Overcli scaffolded. One sheet rather than
/// two because the decision is the same one seen from either side, and
/// someone who just converted by mistake should find the way back where they
/// found the way in.
export function EverydayConversionSheet({ projectId }: { projectId: UUID }) {
  const project = useStore((s) => s.projects.find((p) => p.id === projectId));
  const isGitRepo = useStore((s) => s.projectIsGitRepo[projectId]);
  const convert = useStore((s) => s.convertToEverydayProject);
  const revert = useStore((s) => s.revertEverydayProject);
  const openSheet = useStore((s) => s.openSheet);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!project) return null;
  const everyday = isEverydayProject(project);
  // `isEverydayProject` also answers yes for anything sitting in the managed
  // folder, so turning the flag off there would change nothing the user can
  // see. Say so instead of offering a button that appears to do nothing.
  const pinnedByPath = looksLikeEverydayProjectPath(project.path);
  const needsHistory = !everyday && isGitRepo === false;

  const run = async () => {
    setWorking(true);
    setError(null);
    const res = everyday ? await revert(project.id) : await convert(project.id);
    setWorking(false);
    if (res.ok) openSheet(null);
    else setError(res.error);
  };

  return (
    <div className="flex flex-col p-5 gap-3">
      <div>
        <div className="text-lg font-semibold">
          {everyday ? 'Treat this as an ordinary project' : 'Make this an everyday project'}
        </div>
        <div className="text-xs text-ink-faint">{project.path}</div>
      </div>

      {everyday ? (
        <div className="text-xs text-ink-muted leading-relaxed flex flex-col gap-2">
          <div>
            <span className="text-ink">{project.name}</span> will go back to the standard Overcli
            layout — the file list instead of the documents view, and the usual developer wording.
          </div>
          <div>Your files are not touched, and the history stays, so Undo keeps working.</div>
          {pinnedByPath && (
            <div className="text-amber-400/90">
              This folder lives in your Overcli Projects folder, so it will keep being treated as an
              everyday project until you move it somewhere else.
            </div>
          )}
        </div>
      ) : (
        <div className="text-xs text-ink-muted leading-relaxed flex flex-col gap-2">
          <div>
            <span className="text-ink">{project.name}</span> will show its documents instead of a
            file tree, save as you type, and describe changes in plain words.
          </div>
          <div>
            {needsHistory
              ? 'Overcli will start keeping a history of the folder first, so you can undo anything it changes. Nothing is uploaded and your files stay where they are.'
              : 'This folder already has a history, so Undo will work straight away.'}
          </div>
          <div className="text-ink-faint">You can turn this back off at any time.</div>
        </div>
      )}

      {error && <div className="text-xs text-red-500">{error}</div>}

      <div className="flex justify-end gap-2">
        <SheetActionButton label="Cancel" onClick={() => openSheet(null)} />
        <SheetActionButton
          primary
          disabled={working || (everyday && pinnedByPath)}
          label={
            working
              ? everyday
                ? 'Turning off…'
                : 'Setting up…'
              : everyday
                ? 'Turn off'
                : 'Make it everyday'
          }
          onClick={run}
        />
      </div>
    </div>
  );
}
