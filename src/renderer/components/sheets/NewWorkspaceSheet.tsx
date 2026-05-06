import { useState } from 'react';
import { useStore } from '../../store';
import { SheetActionButton } from './SettingsSheet';
import { ProjectPicker } from './ProjectPicker';

export function NewWorkspaceSheet() {
  const projects = useStore((s) => s.projects);
  const newWorkspace = useStore((s) => s.newWorkspace);
  const openSheet = useStore((s) => s.openSheet);
  const [name, setName] = useState('');
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [instructions, setInstructions] = useState('');

  return (
    <div className="flex flex-col p-5 gap-3">
      <div>
        <div className="text-lg font-semibold">New workspace</div>
        <div className="text-xs text-ink-faint">
          Groups multiple projects for cross-project agents. Member projects stay their own git
          repos.
        </div>
      </div>
      <div>
        <label className="text-xs text-ink-faint">Name</label>
        <input
          autoFocus
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="platform-services"
          className="field mt-1 w-full px-3 py-1.5 text-sm"
        />
      </div>
      <div>
        <label className="text-xs text-ink-faint">Member projects</label>
        <ProjectPicker projects={projects} picked={picked} onChange={setPicked} />
      </div>
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
      <div className="flex justify-end gap-2 mt-2">
        <SheetActionButton label="Cancel" onClick={() => openSheet(null)} />
        <SheetActionButton
          primary
          label="Create"
          onClick={async () => {
            const ws = await newWorkspace(name, Array.from(picked), instructions);
            if (ws) openSheet(null);
          }}
        />
      </div>
    </div>
  );
}
