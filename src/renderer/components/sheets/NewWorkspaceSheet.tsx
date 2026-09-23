import { useMemo, useState } from 'react';
import { useStore } from '../../store';
import { SheetActionButton } from './SettingsSheet';
import { sheetSubmitKeys } from './sheetSubmit';
import { ProjectPicker } from './ProjectPicker';
import { suggestWorkspaceName } from '@shared/suggestWorkspaceName';

export function NewWorkspaceSheet() {
  const projects = useStore((s) => s.projects);
  const newWorkspace = useStore((s) => s.newWorkspace);
  const openSheet = useStore((s) => s.openSheet);
  const [name, setName] = useState('');
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [instructions, setInstructions] = useState('');
  const [showInstructions, setShowInstructions] = useState(false);

  // Repos first, name second: the name falls out of what was picked, so the
  // field is only for overriding it.
  const suggested = useMemo(
    () => suggestWorkspaceName(projects.filter((p) => picked.has(p.id)).map((p) => p.name)),
    [projects, picked],
  );
  const effectiveName = name.trim() || suggested;
  const canCreate = picked.size > 0 && !!effectiveName;

  const submit = async () => {
    if (!canCreate) return;
    const ws = await newWorkspace(effectiveName, Array.from(picked), instructions);
    if (ws) openSheet(null);
  };

  return (
    <div className="flex flex-col min-h-0 flex-1" onKeyDown={sheetSubmitKeys(() => void submit())}>
      <div className="flex-1 min-h-0 overflow-y-auto p-5 flex flex-col gap-3">
        <div>
          <div className="text-lg font-semibold">New workspace</div>
          <div className="text-xs text-ink-faint">
            Pick the repos that belong together. One conversation can then read and change all of
            them, and you review the changes side by side. Each stays its own git repo.
          </div>
        </div>
        <div>
          <label className="text-xs text-ink-faint">Repos</label>
          <ProjectPicker projects={projects} picked={picked} onChange={setPicked} />
        </div>
        <div>
          <label className="text-xs text-ink-faint">Name</label>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={suggested || 'Pick repos above'}
            className="field mt-1 w-full px-3 py-1.5 text-sm"
          />
        </div>
        {!showInstructions ? (
          <button
            onClick={() => setShowInstructions(true)}
            className="self-start text-xs text-ink-faint hover:text-ink-muted"
          >
            + Add instructions for this workspace (optional)
          </button>
        ) : (
          <div>
            <label className="text-xs text-ink-faint">
              Workspace instructions <span className="text-ink-faint/70">(optional)</span>
            </label>
            <textarea
              value={instructions}
              onChange={(e) => setInstructions(e.target.value)}
              placeholder={'e.g. product name, terminology, conventions, or anything every agent in this workspace should know.'}
              rows={4}
              className="field mt-1 w-full px-3 py-1.5 text-sm resize-y"
            />
            <div className="text-[10px] text-ink-faint mt-1">
              Appended to CLAUDE.md / AGENTS.md / GEMINI.md in this workspace — every conversation
              and agent sees it.
            </div>
          </div>
        )}
      </div>
      <div className="flex justify-end gap-2 px-5 py-3 border-t border-card bg-surface-elevated">
        <SheetActionButton label="Cancel" onClick={() => openSheet(null)} />
        <SheetActionButton
          primary
          label="Create"
          disabled={!canCreate}
          onClick={() => void submit()}
        />
      </div>
    </div>
  );
}
