import { useEffect, useState } from 'react';
import { useStore } from '../../store';
import { UUID } from '@shared/types';

interface FileStatus {
  path: string;
  additions: number;
  deletions: number;
}

export function ColosseumCompareSheet({ colosseumId }: { colosseumId: UUID }) {
  const colosseum = useStore((s) => s.colosseums.find((c) => c.id === colosseumId));
  const projects = useStore((s) => s.projects);
  const runners = useStore((s) => s.runners);
  const selectConversation = useStore((s) => s.selectConversation);
  const resolveColosseum = useStore((s) => s.resolveColosseum);
  const project = projects.find((p) => p.id === colosseum?.projectId);
  const contenders = colosseum
    ? colosseum.contenderIds
        .map((cid) => {
          for (const p of projects) {
            const c = p.conversations.find((x) => x.id === cid);
            if (c) return c;
          }
          return null;
        })
        .filter(Boolean)
    : [];
  const contenderKey = colosseum?.contenderIds.join(':') ?? '';
  const [fileStatus, setFileStatus] = useState<Record<UUID, FileStatus[]>>({});
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!colosseum || !project) return;
    setLoading(true);
    void (async () => {
      const result: Record<UUID, FileStatus[]> = {};
      for (const c of contenders) {
        if (!c || !c.worktreePath) continue;
        const diff = await window.overcli.invoke('git:run', {
          args: ['diff', '--numstat', colosseum.baseBranch, '--'],
          cwd: c.worktreePath,
        });
        result[c.id] = diff.stdout
          .trim()
          .split('\n')
          .filter(Boolean)
          .map((line) => {
            const [a, d, ...rest] = line.split(/\t+/);
            return {
              path: rest.join('\t'),
              additions: parseInt(a, 10) || 0,
              deletions: parseInt(d, 10) || 0,
            };
          });
      }
      setFileStatus(result);
      setLoading(false);
    })();
  }, [colosseumId, contenderKey, colosseum?.baseBranch, project?.id]);

  if (!colosseum) return null;

  const openSheet = useStore.getState().openSheet;
  const close = () => openSheet(null);

  return (
    <div className="flex flex-col max-h-[85vh] h-[85vh]">
      <div className="px-5 pt-4 pb-2 border-b border-card">
        <div className="text-lg font-semibold">Compare contenders</div>
        <div className="text-xs text-ink-faint truncate">
          {colosseum.prompt.slice(0, 120)}
        </div>
      </div>
      <div className="overflow-y-auto p-5 flex-1">
        {loading && <div className="text-xs text-ink-faint">Diffing…</div>}
        {contenders.map((c) => {
          if (!c) return null;
          const files = fileStatus[c.id] ?? [];
          const add = files.reduce((s, f) => s + f.additions, 0);
          const del = files.reduce((s, f) => s + f.deletions, 0);
          const isRunning = runners[c.id]?.isRunning ?? false;
          const isWinner = colosseum.winnerId === c.id;
          return (
            <div key={c.id} className="mb-5">
              <div className="flex items-center gap-2 mb-2">
                <div className="text-sm font-medium">{c.name}</div>
                <div className="text-[10px] text-ink-faint">{c.primaryBackend}</div>
                <div className="text-[10px] text-ink-faint truncate">{c.branchName}</div>
                {isWinner && <div className="text-[10px] text-yellow-300">Winner</div>}
                {isRunning && <div className="text-[10px] text-orange-300">Running…</div>}
                <div className="ml-auto flex items-center gap-2">
                  {!isRunning && !isWinner && (
                    <button
                      onClick={() => void resolveColosseum(colosseum.id, c.id)}
                      className="text-[11px] px-2 py-0.5 rounded bg-card text-ink-muted hover:text-ink hover:bg-card-strong border border-card-strong"
                    >
                      Pick winner
                    </button>
                  )}
                  {!isRunning && isWinner && (
                    <button
                      onClick={() => openSheet({ type: 'worktreeDiff', convId: c.id })}
                      className="text-[11px] px-2 py-0.5 rounded bg-accent/20 text-ink hover:bg-accent/30 border border-accent/30"
                    >
                      Merge / PR
                    </button>
                  )}
                  <button
                    onClick={() => {
                      selectConversation(c.id);
                      close();
                    }}
                    className="text-[11px] px-2 py-0.5 rounded bg-card text-ink-muted hover:text-ink hover:bg-card-strong border border-card-strong"
                  >
                    View chat
                  </button>
                  <div className="text-xs">
                    <span className="text-green-400">+{add}</span>{' '}
                    <span className="text-red-400">-{del}</span>
                  </div>
                  <button
                    onClick={() => openSheet({ type: 'worktreeDiff', convId: c.id })}
                    disabled={files.length === 0}
                    className="text-[11px] px-2 py-0.5 rounded bg-card text-ink-muted hover:text-ink hover:bg-card-strong border border-card-strong disabled:opacity-40"
                    title="Open unified diff viewer with merge / push / PR actions"
                  >
                    Diff · merge / push
                  </button>
                </div>
              </div>
              <div className="rounded border border-card bg-card">
                {files.length === 0 ? (
                  <div className="px-3 py-2 text-[11px] text-ink-faint">No changes yet.</div>
                ) : (
                  files.map((f) => (
                    <div key={f.path} className="flex items-center gap-2 px-3 py-1 text-[11px] border-b border-card last:border-b-0">
                      <code className="flex-1 truncate">{f.path}</code>
                      <span className="text-green-400">+{f.additions}</span>
                      <span className="text-red-400">-{f.deletions}</span>
                    </div>
                  ))
                )}
              </div>
            </div>
          );
        })}
      </div>
      <div className="px-5 py-3 border-t border-card flex justify-end">
        <button onClick={close} className="text-xs px-3 py-1 rounded text-ink-muted hover:text-ink hover:bg-white/5">
          Close
        </button>
      </div>
    </div>
  );
}
