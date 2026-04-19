import { useState } from 'react';
import { useStore } from '../../store';
import { UUID } from '@shared/types';
import { SheetActionButton } from './SettingsSheet';
import { BaseBranchSelect } from './BaseBranchSelect';

export function NewAgentSheet({ projectId }: { projectId: UUID }) {
  const projects = useStore((s) => s.projects);
  const settings = useStore((s) => s.settings);
  const saveProjects = useStore((s) => s.saveProjects);
  const selectConversation = useStore((s) => s.selectConversation);
  const openSheet = useStore((s) => s.openSheet);
  const project = projects.find((p) => p.id === projectId);
  const [name, setName] = useState('');
  const [baseBranch, setBaseBranch] = useState('');
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!project) return null;

  const go = async () => {
    const agentName = slugify(name.trim());
    if (!agentName) return;
    setWorking(true);
    setError(null);
    const res = await window.overcli.invoke('git:createWorktree', {
      projectPath: project.path,
      agentName,
      baseBranch,
      branchPrefix: settings.agentBranchPrefix,
    });
    if (!res.ok) {
      setError(res.error);
      setWorking(false);
      return;
    }
    const conv = {
      id: crypto.randomUUID(),
      name: name.trim(),
      createdAt: Date.now(),
      totalCostUSD: 0,
      turnCount: 0,
      currentModel: '',
      permissionMode: settings.defaultPermissionMode,
      primaryBackend: 'claude' as const,
      worktreePath: res.worktreePath,
      branchName: res.branchName,
      baseBranch,
    };
    useStore.setState((s) => ({
      projects: s.projects.map((p) =>
        p.id === projectId ? { ...p, conversations: [...p.conversations, conv] } : p,
      ),
    }));
    await saveProjects();
    selectConversation(conv.id);
    openSheet(null);
    setWorking(false);
  };

  return (
    <div className="flex flex-col p-5 gap-3">
      <div>
        <div className="text-lg font-semibold">New agent</div>
        <div className="text-xs text-ink-faint">
          Spins up a git worktree in <code>~/.overcli/worktrees/{project.name}/</code> on a new branch.
        </div>
      </div>
      <div className="flex flex-col gap-1">
        <label className="text-xs text-ink-faint">Name</label>
        <input
          autoFocus
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="refactor-payments"
          className="field px-3 py-1.5 text-sm"
        />
      </div>
      <div className="flex flex-col gap-1">
        <label className="text-xs text-ink-faint">Base branch</label>
        <BaseBranchSelect
          repoPaths={[project.path]}
          value={baseBranch}
          onChange={setBaseBranch}
        />
      </div>
      {error && <div className="text-xs text-red-400">{error}</div>}
      <div className="flex justify-end gap-2 mt-2">
        <SheetActionButton label="Cancel" onClick={() => openSheet(null)} />
        <SheetActionButton
          primary
          label={working ? 'Creating…' : 'Create'}
          disabled={working || !name.trim() || !baseBranch}
          onClick={() => void go()}
        />
      </div>
    </div>
  );
}

function slugify(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '');
}
