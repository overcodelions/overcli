import { useEffect, useState } from 'react';
import { useStore } from '../../store';
import { UUID } from '@shared/types';
import { SheetActionButton } from './SettingsSheet';

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
  const ws = workspaces.find((w) => w.id === workspaceId);
  const [name, setName] = useState('');
  const [bases, setBases] = useState<Record<UUID, string | null>>({});
  const [loadingBases, setLoadingBases] = useState(true);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const members = ws
    ? ws.projectIds
        .map((pid) => projects.find((p) => p.id === pid))
        .filter((p): p is NonNullable<typeof p> => !!p)
    : [];

  useEffect(() => {
    if (members.length === 0) return;
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
    // members.map(...).join is fine — workspace members rarely change while
    // this sheet is mounted, so the dependency on the joined ids is enough.
  }, [members.map((m) => m.id).join('\0')]);

  if (!ws) return null;

  const allResolved = members.length > 0 && members.every((p) => bases[p.id]);
  const missing = members.filter((p) => !bases[p.id]);

  const go = async () => {
    setWorking(true);
    setError(null);
    const baseBranches: Record<UUID, string> = {};
    for (const p of members) {
      const b = bases[p.id];
      if (b) baseBranches[p.id] = b;
    }
    const res = await newWorkspaceAgent({ workspaceId, name: name.trim(), baseBranches });
    if (!res) {
      setError('All worktree creations failed. Check that each member repo has a usable branch.');
      setWorking(false);
      return;
    }
    openSheet(null);
    setWorking(false);
  };

  return (
    <div className="flex flex-col p-5 gap-3">
      <div>
        <div className="text-lg font-semibold">New workspace agent</div>
        <div className="text-xs text-ink-faint">
          Spins a git worktree in each member project so one coordinator agent can edit across
          them all.
        </div>
      </div>
      <div className="flex flex-col gap-1">
        <label className="text-xs text-ink-faint">Name</label>
        <input
          autoFocus
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="refactor-auth-flow"
          className="field px-3 py-1.5 text-sm"
        />
      </div>
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
      {error && <div className="text-xs text-red-400">{error}</div>}
      <div className="flex justify-end gap-2 mt-2">
        <SheetActionButton label="Cancel" onClick={() => openSheet(null)} />
        <SheetActionButton
          primary
          label={working ? 'Creating…' : 'Create'}
          disabled={working || !name.trim() || !allResolved}
          onClick={() => void go()}
        />
      </div>
    </div>
  );
}
