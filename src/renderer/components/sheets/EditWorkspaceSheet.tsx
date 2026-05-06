import { useMemo, useState } from 'react';
import { useStore } from '../../store';
import { SheetActionButton } from './SettingsSheet';
import { ProjectPicker } from './ProjectPicker';
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
        <ProjectPicker
          projects={projects}
          picked={picked}
          onChange={setPicked}
          renderRowBadge={(p, checked) =>
            referencedProjectIds.has(p.id) && !checked ? (
              <div
                className="text-[10px] text-amber-500"
                title="Existing workspace agents reference this project — its worktrees stay but no new agents will include it."
              >
                in use
              </div>
            ) : null
          }
        />
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
