import { useRef, useState } from 'react';
import { useStore } from '../../store';
import { UUID, Colosseum } from '@shared/types';
import { SheetActionButton } from './SettingsSheet';
import { BaseBranchSelect } from './BaseBranchSelect';
import { WorktreeCreatingStatus } from '../WorktreeCreatingStatus';

interface Contender {
  backend: 'claude' | 'codex' | 'gemini';
  model: string;
  label: string;
}

export function NewColosseumSheet({ projectId }: { projectId: UUID }) {
  const projects = useStore((s) => s.projects);
  const settings = useStore((s) => s.settings);
  const saveProjects = useStore((s) => s.saveProjects);
  const saveColosseums = useStore((s) => s.saveColosseums);
  const openSheet = useStore((s) => s.openSheet);
  const project = projects.find((p) => p.id === projectId);
  const [prompt, setPrompt] = useState('');
  const [baseBranch, setBaseBranch] = useState('');
  const [contenders, setContenders] = useState<Contender[]>([
    { backend: 'claude', model: '', label: 'claude' },
    { backend: 'codex', model: '', label: 'codex' },
  ]);
  const [working, setWorking] = useState(false);
  const [progress, setProgress] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const launchLock = useRef(false);
  if (!project) return null;

  const go = async () => {
    if (launchLock.current) return;
    if (!prompt.trim() || contenders.length < 2) return;
    launchLock.current = true;
    setWorking(true);
    setError(null);
    try {
      const id = crypto.randomUUID();
      const promptText = prompt.trim();
      const namePrefix = slugify(promptText.slice(0, 20)) || 'colosseum';
      const suffix = id.slice(0, 4);
      const agentIds: UUID[] = [];
      for (let i = 0; i < contenders.length; i++) {
        const c = contenders[i];
        const agentName = `${namePrefix}-${c.backend}-${i}-${suffix}`;
        setProgress(`Creating worktree ${i + 1} of ${contenders.length} (${c.backend})…`);
        const res = await window.overcli.invoke('git:createWorktree', {
          projectPath: project.path,
          agentName,
          baseBranch,
          branchPrefix: settings.agentBranchPrefix,
        });
        if (!res.ok) {
          setError(res.error);
          return;
        }
        const convId = crypto.randomUUID();
        agentIds.push(convId);
        useStore.setState((s) => ({
          projects: s.projects.map((p) =>
            p.id === projectId
              ? {
                  ...p,
                  conversations: [
                    ...p.conversations,
                    {
                      id: convId,
                      name: agentName,
                      createdAt: Date.now(),
                      totalCostUSD: 0,
                      turnCount: 0,
                      currentModel: c.model,
                      permissionMode: settings.defaultPermissionMode,
                      primaryBackend: c.backend,
                      claudeModel: c.backend === 'claude' ? c.model : undefined,
                      codexModel: c.backend === 'codex' ? c.model : undefined,
                      geminiModel: c.backend === 'gemini' ? c.model : undefined,
                      worktreePath: res.worktreePath,
                      branchName: res.branchName,
                      baseBranch,
                      colosseumId: id,
                    },
                  ],
                }
              : p,
          ),
        }));
      }
      const colosseum: Colosseum = {
        id,
        name: namePrefix,
        prompt: promptText,
        baseBranch,
        projectId,
        contenderIds: agentIds,
        createdAt: Date.now(),
        status: 'running',
      };
      useStore.setState((s) => ({ colosseums: [...s.colosseums, colosseum] }));
      await saveProjects();
      await saveColosseums();
      setProgress(`Starting ${agentIds.length} agents…`);
      for (const convId of agentIds) {
        await useStore.getState().send(convId, promptText);
      }
      openSheet(null);
    } finally {
      launchLock.current = false;
      setWorking(false);
      setProgress(null);
    }
  };

  return (
    <div className="flex flex-col p-5 gap-3 max-h-[80vh] overflow-y-auto">
      <div>
        <div className="text-lg font-semibold">New colosseum</div>
        <div className="text-xs text-ink-faint">
          Spawns N agents on the same prompt in parallel git worktrees so you can compare their
          solutions side by side.
        </div>
      </div>
      <div>
        <label className="text-xs text-ink-faint">Prompt</label>
        <textarea
          autoFocus
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          rows={4}
          placeholder="What should every contender try to do?"
          className="field mt-1 w-full px-3 py-1.5 text-sm select-text"
        />
      </div>
      <div>
        <label className="text-xs text-ink-faint">Base branch</label>
        <BaseBranchSelect
          repoPaths={project ? [project.path] : []}
          value={baseBranch}
          onChange={setBaseBranch}
          className="field mt-1 w-full px-3 py-1.5 text-sm"
        />
      </div>
      <div>
        <label className="text-xs text-ink-faint">Contenders</label>
        <div className="flex flex-col gap-1 mt-1">
          {contenders.map((c, i) => (
            <div key={i} className="flex gap-1 items-center">
              <select
                value={c.backend}
                onChange={(e) => {
                  const next = [...contenders];
                  next[i] = { ...c, backend: e.target.value as any };
                  setContenders(next);
                }}
                className="field px-2 py-1 text-xs"
              >
                <option value="claude">claude</option>
                <option value="codex">codex</option>
                <option value="gemini">gemini</option>
              </select>
              <input
                placeholder="model (optional)"
                value={c.model}
                onChange={(e) => {
                  const next = [...contenders];
                  next[i] = { ...c, model: e.target.value };
                  setContenders(next);
                }}
                className="field flex-1 px-2 py-1 text-xs"
              />
              <button
                onClick={() => setContenders(contenders.filter((_, j) => j !== i))}
                className="text-ink-faint hover:text-red-400 px-1"
              >
                ✕
              </button>
            </div>
          ))}
          <button
            onClick={() => setContenders([...contenders, { backend: 'claude', model: '', label: 'claude' }])}
            className="text-xs text-ink-faint hover:text-ink text-left"
          >
            + Add contender
          </button>
        </div>
      </div>
      {error && <div className="text-xs text-red-400">{error}</div>}
      {working && <WorktreeCreatingStatus message={progress ?? 'Creating worktrees…'} />}
      <div className="flex justify-end gap-2 mt-2">
        <SheetActionButton label="Cancel" onClick={() => openSheet(null)} />
        <SheetActionButton
          primary
          label={working ? 'Starting…' : 'Start'}
          disabled={working || !prompt.trim() || !baseBranch || contenders.length < 2}
          onClick={() => void go()}
        />
      </div>
    </div>
  );
}

function slugify(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}
