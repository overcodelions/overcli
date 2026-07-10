import { useMemo, useState } from 'react';
import { useStore } from '../../store';
import { SheetActionButton } from './SettingsSheet';
import { ProjectPicker } from './ProjectPicker';
import { BaseBranchSelect } from './BaseBranchSelect';
import { UUID } from '@shared/types';

export function EditWorkspaceSheet({ workspaceId }: { workspaceId: UUID }) {
  const projects = useStore((s) => s.projects);
  const workspace = useStore((s) => s.workspaces.find((w) => w.id === workspaceId));
  const updateWorkspaceProjects = useStore((s) => s.updateWorkspaceProjects);
  const updateWorkspaceInstructions = useStore((s) => s.updateWorkspaceInstructions);
  const applyProjectsToWorkspaceAgents = useStore((s) => s.applyProjectsToWorkspaceAgents);
  const openSheet = useStore((s) => s.openSheet);
  // The member set as it was when the sheet opened — used to compute which
  // projects were newly added once Save has mutated workspace.projectIds.
  const [originalProjectIds] = useState<Set<string>>(
    () => new Set(workspace?.projectIds ?? []),
  );
  const [picked, setPicked] = useState<Set<string>>(
    () => new Set(workspace?.projectIds ?? []),
  );
  const [instructions, setInstructions] = useState<string>(workspace?.instructions ?? '');
  const [saving, setSaving] = useState(false);

  // Second step: after saving added projects, offer to push them into the
  // workspace's existing worktree agents so those agents get worktrees +
  // context for the new projects.
  const [phase, setPhase] = useState<'edit' | 'apply'>('edit');
  const [addedIds, setAddedIds] = useState<UUID[]>([]);
  const [baseBranches, setBaseBranches] = useState<Record<string, string>>({});
  const [applying, setApplying] = useState(false);
  const [progress, setProgress] = useState('');

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

  const agents = useMemo(
    () => (workspace?.conversations ?? []).filter((c) => (c.workspaceAgentMemberIds?.length ?? 0) > 0),
    [workspace],
  );

  const addedProjects = useMemo(
    () => addedIds.map((id) => projects.find((p) => p.id === id)).filter((p): p is NonNullable<typeof p> => !!p),
    [addedIds, projects],
  );

  if (!workspace) return null;

  if (phase === 'apply') {
    const missingBranch = addedProjects.some((p) => !baseBranches[p.id]);
    return (
      <div className="flex flex-col min-h-0 flex-1">
        <div className="flex-1 min-h-0 overflow-y-auto p-5 flex flex-col gap-3">
          <div>
            <div className="text-lg font-semibold">Add new projects to running agents?</div>
            <div className="text-xs text-ink-faint">
              This workspace has {agents.length} worktree agent{agents.length === 1 ? '' : 's'}. Applying
              creates a new branch + worktree in each new project for every agent, so they can read and
              edit it. Existing worktrees are untouched.
            </div>
          </div>
          <div className="flex flex-col gap-3">
            {addedProjects.map((p) => (
              <div key={p.id}>
                <label className="text-xs text-ink-faint">
                  {p.name} <span className="text-ink-faint/70">— base branch</span>
                </label>
                <BaseBranchSelect
                  repoPaths={[p.path]}
                  value={baseBranches[p.id] ?? ''}
                  onChange={(v) => setBaseBranches((prev) => ({ ...prev, [p.id]: v }))}
                  className="mt-1"
                  disabled={applying}
                />
              </div>
            ))}
          </div>
          <div>
            <div className="text-xs text-ink-faint">Agents to update</div>
            <div className="mt-1 text-sm text-ink-muted">{agents.map((a) => a.name).join(', ')}</div>
          </div>
          {progress && <div className="text-xs text-ink-faint">{progress}</div>}
        </div>
        <div className="flex justify-end gap-2 px-5 py-3 border-t border-card bg-surface-elevated">
          <SheetActionButton label="Skip" onClick={() => openSheet(null)} disabled={applying} />
          <SheetActionButton
            primary
            label={applying ? 'Applying…' : `Apply to ${agents.length} agent${agents.length === 1 ? '' : 's'}`}
            disabled={applying || missingBranch}
            onClick={async () => {
              if (applying || missingBranch) return;
              setApplying(true);
              await applyProjectsToWorkspaceAgents({
                workspaceId,
                projectIds: addedIds,
                baseBranches,
                onProgress: setProgress,
              });
              setApplying(false);
              openSheet(null);
            }}
          />
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col min-h-0 flex-1">
      <div className="flex-1 min-h-0 overflow-y-auto p-5 flex flex-col gap-3">
        <div>
          <div className="text-lg font-semibold">Edit workspace</div>
          <div className="text-xs text-ink-faint">
            Add or remove member projects. Removing a project here only updates future agents;
            adding one lets you push it into existing agents on the next step.
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
      </div>
      <div className="flex justify-end gap-2 px-5 py-3 border-t border-card bg-surface-elevated">
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
            if (!projectsOk || !instructionsOk) return;
            const added = Array.from(picked).filter((id) => !originalProjectIds.has(id));
            if (added.length > 0 && agents.length > 0) {
              setAddedIds(added);
              setPhase('apply');
            } else {
              openSheet(null);
            }
          }}
        />
      </div>
    </div>
  );
}
