import { useMemo, useState } from 'react';
import { useStore } from '../../store';
import { SheetActionButton } from './SettingsSheet';
import { UUID } from '@shared/types';

export function EditWorkspaceSheet({ workspaceId }: { workspaceId: UUID }) {
  const projects = useStore((s) => s.projects);
  const workspace = useStore((s) => s.workspaces.find((w) => w.id === workspaceId));
  const updateWorkspaceProjects = useStore((s) => s.updateWorkspaceProjects);
  const updateWorkspaceInstructions = useStore((s) => s.updateWorkspaceInstructions);
  const openSheet = useStore((s) => s.openSheet);
  const [picked, setPicked] = useState<Set<string>>(
    () => new Set(workspace?.projectIds ?? []),
  );
  const [instructions, setInstructions] = useState<string>(workspace?.instructions ?? '');
  const [saving, setSaving] = useState(false);

  const referencedProjectIds = useMemo(() => {
    const ids = new Set<string>();
    for (const c of workspace?.conversations ?? []) {
      if (c.workspaceAgentCoordinatorId || c.worktreePath) {
        for (const p of projects) {
          if (c.worktreePath?.startsWith(p.path)) ids.add(p.id);
        }
      }
    }
    return ids;
  }, [workspace, projects]);

  if (!workspace) return null;

  return (
    <div className="flex flex-col p-5 gap-3">
      <div>
        <div className="text-lg font-semibold">Edit workspace</div>
        <div className="text-xs text-ink-faint">
          Add or remove member projects. Existing agents keep their worktrees — dropping a
          project here only updates future agents.
        </div>
      </div>
      <div>
        <label className="text-xs text-ink-faint">Name</label>
        <div className="mt-1 px-3 py-1.5 text-sm text-ink-muted">{workspace.name}</div>
      </div>
      <div>
        <label className="text-xs text-ink-faint">Member projects</label>
        <div className="mt-1 border border-card rounded max-h-[240px] overflow-y-auto">
          {projects.map((p) => {
            const checked = picked.has(p.id);
            const inUse = referencedProjectIds.has(p.id);
            return (
              <label
                key={p.id}
                className="flex items-center gap-2 px-3 py-2 text-xs hover:bg-card-strong cursor-pointer border-b border-card last:border-b-0"
              >
                <input
                  type="checkbox"
                  checked={checked}
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
                {inUse && !checked && (
                  <div
                    className="text-[10px] text-amber-500"
                    title="Existing workspace agents reference this project — its worktrees stay but no new agents will include it."
                  >
                    in use
                  </div>
                )}
              </label>
            );
          })}
        </div>
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
          label={saving ? 'Saving…' : 'Save'}
          onClick={async () => {
            if (picked.size === 0 || saving) return;
            setSaving(true);
            const projectsOk = await updateWorkspaceProjects(workspaceId, Array.from(picked));
            const instructionsChanged = (workspace.instructions ?? '') !== instructions;
            const instructionsOk = instructionsChanged
              ? await updateWorkspaceInstructions(workspaceId, instructions)
              : true;
            setSaving(false);
            if (projectsOk && instructionsOk) openSheet(null);
          }}
        />
      </div>
    </div>
  );
}
