import { useEffect, useMemo, useState } from 'react';
import { useStore } from '../../store';
import { UUID } from '@shared/types';
import { SheetActionButton } from './SettingsSheet';
import { WorktreeCreatingStatus } from '../WorktreeCreatingStatus';
import { BranchCombobox } from './BranchCombobox';

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
  const [branchMode, setBranchMode] = useState<'auto' | 'shared'>('auto');
  const [sharedBranch, setSharedBranch] = useState('');
  const [memberBranches, setMemberBranches] = useState<Record<UUID, string[]>>({});
  const [loadingShared, setLoadingShared] = useState(false);
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

  // For "Shared branch" mode, load each member's branches and present
  // their union — falling back to per-repo auto-detect for any repo
  // that doesn't have the user's pick.
  useEffect(() => {
    if (members.length === 0 || kind !== 'build' || branchMode !== 'shared') return;
    let cancelled = false;
    setLoadingShared(true);
    void Promise.all(
      members.map(async (p) => {
        const list = await window.overcli
          .invoke('git:listBaseBranches', p.path)
          .catch(() => [] as string[]);
        return [p.id, list] as const;
      }),
    ).then((entries) => {
      if (cancelled) return;
      const next: Record<UUID, string[]> = {};
      for (const [pid, list] of entries) next[pid] = list;
      setMemberBranches(next);
      setLoadingShared(false);
    });
    return () => {
      cancelled = true;
    };
  }, [members.map((m) => m.id).join('\0'), kind, branchMode]);

  const sharedOptions = useMemo(() => {
    const seen = new Set<string>();
    const ordered: string[] = [];
    for (const p of members) {
      for (const b of memberBranches[p.id] ?? []) {
        if (seen.has(b)) continue;
        seen.add(b);
        ordered.push(b);
      }
    }
    const priority = ['main', 'master', 'develop', 'dev'];
    ordered.sort((a, b) => {
      const ai = priority.indexOf(a);
      const bi = priority.indexOf(b);
      if (ai === -1 && bi === -1) return 0;
      if (ai === -1) return 1;
      if (bi === -1) return -1;
      return ai - bi;
    });
    return ordered;
  }, [memberBranches, members.map((m) => m.id).join('\0')]);

  useEffect(() => {
    if (branchMode !== 'shared') return;
    if (sharedOptions.length === 0) return;
    if (!sharedBranch || !sharedOptions.includes(sharedBranch)) {
      setSharedBranch(sharedOptions[0]);
    }
  }, [branchMode, sharedOptions, sharedBranch]);

  const sharedCoverage = useMemo(() => {
    if (!sharedBranch) return { has: [], missing: [] as typeof members };
    const has: typeof members = [];
    const missing: typeof members = [];
    for (const p of members) {
      ((memberBranches[p.id] ?? []).includes(sharedBranch) ? has : missing).push(p);
    }
    return { has, missing };
  }, [sharedBranch, memberBranches, members.map((m) => m.id).join('\0')]);

  if (!ws) return null;

  const allResolved = members.length > 0 && members.every((p) => bases[p.id]);
  const missing = members.filter((p) => !bases[p.id]);
  const meta = KINDS.find((k) => k.id === kind) ?? KINDS[0];
  // In shared mode, repos missing the picked branch fall back to their
  // auto-detected base, so we still need every member to have *some*
  // resolvable branch — the same condition as auto mode.
  const buildReady =
    branchMode === 'shared'
      ? members.length > 0 && !!sharedBranch && allResolved
      : allResolved;

  const canSubmit =
    !working &&
    !!name.trim() &&
    (kind === 'docs' ? !!topic.trim() : buildReady);
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
          let b: string | null | undefined;
          if (branchMode === 'shared') {
            const has = (memberBranches[p.id] ?? []).includes(sharedBranch);
            b = has ? sharedBranch : bases[p.id];
          } else {
            b = bases[p.id];
          }
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
          <div className="flex flex-col gap-1">
            <label className="text-xs text-ink-faint">Branch from</label>
            <div className="flex gap-1 rounded border border-card bg-card p-1 w-fit">
              {(
                [
                  { id: 'auto', label: 'Per repo (detected)' },
                  { id: 'shared', label: 'Shared branch' },
                ] as const
              ).map((m) => (
                <button
                  key={m.id}
                  onClick={() => setBranchMode(m.id)}
                  className={
                    'text-xs px-3 py-1 rounded transition-colors ' +
                    (branchMode === m.id
                      ? 'bg-accent text-white shadow-sm'
                      : 'text-ink-muted hover:bg-card-strong hover:text-ink')
                  }
                >
                  {m.label}
                </button>
              ))}
            </div>
          </div>
          {branchMode === 'shared' ? (
            <div className="flex flex-col gap-2">
              <BranchCombobox
                options={sharedOptions}
                value={sharedBranch}
                onChange={setSharedBranch}
                disabled={loadingShared}
                placeholder={loadingShared ? 'Loading branches…' : 'No branches found in any repo'}
              />
              {sharedBranch && (
                <div className="flex flex-col gap-1 rounded border border-card bg-card p-2 max-h-[220px] overflow-y-auto">
                  {members.map((p) => {
                    const has = (memberBranches[p.id] ?? []).includes(sharedBranch);
                    const fallback = bases[p.id];
                    return (
                      <div key={p.id} className="flex items-center gap-2 text-xs">
                        <span className="text-ink-muted truncate flex-1">{p.name}</span>
                        <span className="text-ink-faint">→</span>
                        {has ? (
                          <span className="font-mono text-ink">{sharedBranch}</span>
                        ) : fallback ? (
                          <span className="font-mono text-amber-400" title={`${sharedBranch} not in this repo — falling back to detected base`}>
                            {fallback} (fallback)
                          </span>
                        ) : (
                          <span className="text-amber-400">no base branch found</span>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
              {sharedBranch && sharedCoverage.missing.length > 0 && (
                <div className="text-xs text-ink-faint">
                  {sharedCoverage.missing.length === 1
                    ? `${sharedCoverage.missing[0].name} doesn't have ${sharedBranch}; using its detected base instead.`
                    : `${sharedCoverage.missing.length} repos don't have ${sharedBranch}; each falls back to its detected base.`}
                </div>
              )}
            </div>
          ) : (
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
          )}
          {branchMode === 'auto' && !loadingBases && missing.length > 0 && (
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
