import { useEffect, useState } from 'react';
import { useStore } from '../../store';
import { UUID } from '@shared/types';
import { isEverydayProject, looksLikeEverydayProjectPath } from '@shared/everydayProjects';
import { SheetActionButton } from './SettingsSheet';
import { GitInstallNotice, useGitAvailability } from '../GitInstallNotice';

/// Both directions of "is this folder an everyday project?", for a folder the
/// user already had rather than one Overcli scaffolded. One sheet rather than
/// two because the decision is the same one seen from either side, and
/// someone who just converted by mistake should find the way back where they
/// found the way in.
///
/// `suggested` is the same offer made unprompted, right after "Open a folder"
/// found mostly documents in it — so it is worded as a question about the
/// folder rather than a setting, and never says "everyday".
export function EverydayConversionSheet({
  projectId,
  suggested = false,
}: {
  projectId: UUID;
  suggested?: boolean;
}) {
  const project = useStore((s) => s.projects.find((p) => p.id === projectId));
  const isGitRepo = useStore((s) => s.projectIsGitRepo[projectId]);
  const convert = useStore((s) => s.convertToEverydayProject);
  const revert = useStore((s) => s.revertEverydayProject);
  const openSheet = useStore((s) => s.openSheet);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const alreadyEveryday = !!project && isEverydayProject(project);
  // A folder that already carries the marker became a documents project the
  // moment it was added; there is nothing left to suggest.
  useEffect(() => {
    if (suggested && alreadyEveryday) openSheet(null);
  }, [suggested, alreadyEveryday, openSheet]);

  if (!project) return null;
  const everyday = alreadyEveryday;
  // `isEverydayProject` also answers yes for anything sitting in the managed
  // folder, so turning the flag off there would change nothing the user can
  // see. Say so instead of offering a button that appears to do nothing.
  const pinnedByPath = looksLikeEverydayProjectPath(project.path);
  const needsHistory = !everyday && isGitRepo === false;
  /// Converting starts a history FIRST and refuses to relabel if that fails,
  /// so on a machine without git this direction is closed outright. Ask up
  /// front rather than after a click that could never have worked.
  const availability = useGitAvailability(needsHistory);
  const gitMissing = needsHistory && availability !== null && availability.state !== 'ok';
  // After every hook: the marker sync can flip this while the sheet is open.
  if (suggested && everyday) return null;

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
          {everyday
            ? 'Show this as files'
            : suggested
              ? 'This looks like a folder of documents'
              : 'Show this as documents'}
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
              This folder lives in your Overcli Projects folder, so it will keep being shown as
              documents until you move it somewhere else.
            </div>
          )}
        </div>
      ) : (
        <div className="text-xs text-ink-muted leading-relaxed flex flex-col gap-2">
          <div>
            {suggested ? 'Show it as documents? ' : ''}
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

      {gitMissing && (
        <GitInstallNotice
          state={availability.state === 'needs-xcode-tools' ? 'needs-xcode-tools' : 'missing'}
          lead="This folder has no history yet, and Overcli starts one before converting."
        />
      )}

      {error && <div className="text-xs text-red-500">{error}</div>}

      <div className="flex justify-end gap-2">
        <SheetActionButton
          label={suggested ? 'Keep it as files' : 'Cancel'}
          onClick={() => openSheet(null)}
        />
        <SheetActionButton
          primary
          disabled={working || (everyday && pinnedByPath) || gitMissing}
          label={
            working
              ? everyday
                ? 'Switching…'
                : 'Setting up…'
              : everyday
                ? 'Show as files'
                : 'Show as documents'
          }
          onClick={run}
        />
      </div>
    </div>
  );
}
