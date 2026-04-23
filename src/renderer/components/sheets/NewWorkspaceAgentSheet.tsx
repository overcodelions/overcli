import { useEffect, useState } from 'react';
import { useStore } from '../../store';
import { UUID } from '@shared/types';
import { SheetActionButton } from './SettingsSheet';
import { WorktreeCreatingStatus } from '../WorktreeCreatingStatus';

type WorkspaceAgentKind = 'build' | 'docs';

interface KindMeta {
  id: WorkspaceAgentKind;
  label: string;
  summary: string;
}

const KINDS: KindMeta[] = [
  {
    id: 'build',
    label: 'Build',
    summary: 'Spins a git worktree in each member project so one coordinator agent can edit across them all.',
  },
  {
    id: 'docs',
    label: 'Docs',
    summary: 'Read-only cross-repo agent that outputs end-user documentation for the workspace as markdown in chat. No worktrees, no commits.',
  },
];

/// Spawns an agent coordinator + one git worktree per workspace-member
/// project. Each member project branches off its own auto-detected base
/// (most repos use `main`, but `master`/`develop` are common too), so
/// mixed-default workspaces just work without forcing the user to find
/// a shared branch name.
export function NewWorkspaceAgentSheet({ workspaceId }: { workspaceId: UUID }) {
  const workspaces = useStore((s) => s.workspaces);
  const projects = useStore((s) => s.projects);
  const openSheet = useStore((s) => s.openSheet);
  const newWorkspaceAgent = useStore((s) => s.newWorkspaceAgent);
  const newWorkspaceDocsAgent = useStore((s) => s.newWorkspaceDocsAgent);
  const ws = workspaces.find((w) => w.id === workspaceId);
  const [kind, setKind] = useState<WorkspaceAgentKind>('build');
  const [name, setName] = useState('');
  const [topic, setTopic] = useState('');
  const [bases, setBases] = useState<Record<UUID, string | null>>({});
  const [loadingBases, setLoadingBases] = useState(true);
  const [working, setWorking] = useState(false);
  const [progress, setProgress] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const members = ws
    ? ws.projectIds
        .map((pid) => projects.find((p) => p.id === pid))
        .filter((p): p is NonNullable<typeof p> => !!p)
    : [];

  useEffect(() => {
    if (members.length === 0 || kind !== 'build') return;
    let cancelled = false;
    setLoadingBases(true);
    void Promise.all(
      members.map(async (p) => {
        const detected = await window.overcli
          .invoke('git:detectBaseBranch', p.path)
          .catch(() => '');
        return [p.id, detected?.trim() || null] as const;
      }),
    ).then((entries) => {
      if (cancelled) return;
      const next: Record<UUID, string | null> = {};
      for (const [pid, branch] of entries) next[pid] = branch;
      setBases(next);
      setLoadingBases(false);
    });
    return () => {
      cancelled = true;
    };
  }, [members.map((m) => m.id).join('\0'), kind]);

  if (!ws) return null;

  const allResolved = members.length > 0 && members.every((p) => bases[p.id]);
  const missing = members.filter((p) => !bases[p.id]);
  const meta = KINDS.find((k) => k.id === kind) ?? KINDS[0];

  const canSubmit =
    !working &&
    !!name.trim() &&
    (kind === 'docs' ? !!topic.trim() : allResolved);
  const submitLabel = working
    ? kind === 'docs'
      ? 'Drafting docs…'
      : 'Creating…'
    : kind === 'docs'
      ? 'Draft docs'
      : 'Create';

  const go = async () => {
    setWorking(true);
    setError(null);
    setProgress(null);
    try {
      if (kind === 'docs') {
        const res = await newWorkspaceDocsAgent({
          workspaceId,
          name: name.trim(),
          topic: topic.trim(),
        });
        if (!res) {
          setError('Could not create docs agent.');
          return;
        }
        openSheet(null);
      } else {
        const baseBranches: Record<UUID, string> = {};
        for (const p of members) {
          const b = bases[p.id];
          if (b) baseBranches[p.id] = b;
        }
        setProgress(
          members.length === 1
            ? 'Creating worktree…'
            : `Creating worktrees across ${members.length} repos…`,
        );
        const res = await newWorkspaceAgent({
          workspaceId,
          name: name.trim(),
          baseBranches,
          onProgress: setProgress,
        });
        if (!res) {
          setError('All worktree creations failed. Check that each member repo has a usable branch.');
          return;
        }
        openSheet(null);
      }
    } finally {
      setWorking(false);
      setProgress(null);
    }
  };

  return (
    <div className="flex flex-col p-5 gap-3">
      <div>
        <div className="text-lg font-semibold">New workspace agent</div>
        <div className="text-xs text-ink-faint">{meta.summary}</div>
      </div>
      <div className="flex flex-col gap-1">
        <label className="text-xs text-ink-faint">Kind</label>
        <div className="flex gap-1 rounded border border-card bg-card p-1 w-fit">
          {KINDS.map((k) => (
            <button
              key={k.id}
              onClick={() => setKind(k.id)}
              className={
                'text-xs px-3 py-1 rounded transition-colors ' +
                (kind === k.id
                  ? 'bg-accent text-white shadow-sm'
                  : 'text-ink-muted hover:bg-card-strong hover:text-ink')
              }
            >
              {k.label}
            </button>
          ))}
        </div>
      </div>
      <div className="flex flex-col gap-1">
        <label className="text-xs text-ink-faint">Name</label>
        <input
          autoFocus
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder={kind === 'docs' ? 'end-user-guide' : 'refactor-auth-flow'}
          className="field px-3 py-1.5 text-sm"
        />
      </div>
      {kind === 'build' && (
        <>
          <div className="text-[10px] uppercase tracking-wide text-ink-faint mt-1">
            Will branch from
          </div>
          <div className="flex flex-col gap-1 rounded border border-card bg-card p-2 max-h-[220px] overflow-y-auto">
            {members.length === 0 ? (
              <div className="text-xs text-ink-faint">No member projects in this workspace.</div>
            ) : loadingBases ? (
              <div className="text-xs text-ink-faint">Detecting base branches…</div>
            ) : (
              members.map((p) => {
                const branch = bases[p.id];
                return (
                  <div key={p.id} className="flex items-center gap-2 text-xs">
                    <span className="text-ink-muted truncate flex-1">{p.name}</span>
                    <span className="text-ink-faint">→</span>
                    {branch ? (
                      <span className="font-mono text-ink">{branch}</span>
                    ) : (
                      <span className="text-amber-400">no base branch found</span>
                    )}
                  </div>
                );
              })
            )}
          </div>
          {!loadingBases && missing.length > 0 && (
            <div className="text-xs text-amber-400">
              {missing.length === 1
                ? `${missing[0].name} has no branches yet — make an initial commit or fetch a remote, then reopen this sheet.`
                : `${missing.length} member projects have no usable branches. Initialize them first.`}
            </div>
          )}
        </>
      )}
      {kind === 'docs' && (
        <>
          <div className="flex flex-col gap-1">
            <label className="text-xs text-ink-faint">What to document</label>
            <textarea
              value={topic}
              onChange={(e) => setTopic(e.target.value)}
              rows={4}
              placeholder="Describe the feature to document — e.g. &quot;the new realtime notifications flow that spans the api and web repos&quot;."
              className="field px-3 py-1.5 text-sm select-text resize-none"
            />
          </div>
          <div className="text-xs text-ink-faint">
            The agent will search across all {members.length} member repo{members.length === 1 ? '' : 's'} for code related to this feature and output end-user docs in chat. No worktrees, no commits.
          </div>
        </>
      )}
      {error && <div className="text-xs text-red-400">{error}</div>}
      {working && kind === 'build' && (
        <WorktreeCreatingStatus message={progress ?? 'Creating worktrees…'} />
      )}
      <div className="flex justify-end gap-2 mt-2">
        <SheetActionButton label="Cancel" onClick={() => openSheet(null)} />
        <SheetActionButton
          primary
          label={submitLabel}
          disabled={!canSubmit}
          onClick={() => void go()}
        />
      </div>
    </div>
  );
}
