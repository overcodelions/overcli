import { useState } from 'react';
import { useStore } from '../../store';
import { SheetActionButton } from './SettingsSheet';

export function NewWorkspaceSheet() {
  const projects = useStore((s) => s.projects);
  const newWorkspace = useStore((s) => s.newWorkspace);
  const openSheet = useStore((s) => s.openSheet);
  const [name, setName] = useState('');
  const [picked, setPicked] = useState<Set<string>>(new Set());

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
        <div className="mt-1 border border-card rounded max-h-[240px] overflow-y-auto">
          {projects.map((p) => (
            <label
              key={p.id}
              className="flex items-center gap-2 px-3 py-2 text-xs hover:bg-card-strong cursor-pointer border-b border-card last:border-b-0"
            >
              <input
                type="checkbox"
                checked={picked.has(p.id)}
                onChange={(e) => {
                  const next = new Set(picked);
                  if (e.target.checked) next.add(p.id);
                  else next.delete(p.id);
                  setPicked(next);
                }}
                className="accent-accent"
              />
              <div className="flex-1 min-w-0">
                <div>{p.name}</div>
                <div className="text-[10px] text-ink-faint truncate">{p.path}</div>
              </div>
            </label>
          ))}
        </div>
      </div>
      <div className="flex justify-end gap-2 mt-2">
        <SheetActionButton label="Cancel" onClick={() => openSheet(null)} />
        <SheetActionButton
          primary
          label="Create"
          onClick={async () => {
            const ws = await newWorkspace(name, Array.from(picked));
            if (ws) openSheet(null);
          }}
        />
      </div>
    </div>
  );
}
