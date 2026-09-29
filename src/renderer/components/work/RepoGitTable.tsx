// Where a piece of work stands in each repo it touched. A workspace run cuts a
// branch in every member repo and ticket work can spread across several, so a
// single "branch" line can't say it — this is one row per repo that actually
// has commits on its branch, with what git knows about each.

import type { RepoGit, WorkRecord } from '@shared/workRecords';
import { useStore } from '../../store';
import { contextDraft } from './KeepWorking';

function basename(p: string): string {
  return p.split(/[\\/]/).filter(Boolean).pop() ?? p;
}

function when(ms?: number): string {
  return ms ? new Date(ms).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) : '';
}

/// The one state that matters most for a repo's branch, and its tone.
function state(g: RepoGit): { label: string; tone: string } {
  const s = g.status;
  const trunk = s.trunk ?? 'trunk';
  if (s.uncommitted) return { label: `${s.uncommitted} uncommitted`, tone: 'bg-amber-500/15 text-amber-700 dark:text-amber-300' };
  if (s.inTrunk && s.ahead === 0 && s.cutOnly) return { label: 'No commits yet', tone: 'bg-card-strong text-ink-muted' };
  if (s.inTrunk && s.ahead === 0) return { label: s.squashMerged ? `Squash-merged into ${trunk}` : `In ${trunk}`, tone: 'bg-green-500/15 text-green-700 dark:text-green-300' };
  if (s.local && !s.remote && s.remoteGone) return { label: 'Deleted on remote', tone: 'bg-card-strong text-ink-muted' };
  if (s.local && !s.remote) return { label: 'Not pushed', tone: 'bg-amber-500/15 text-amber-700 dark:text-amber-300' };
  if (s.unpushed > 0) return { label: `${s.unpushed} unpushed`, tone: 'bg-amber-500/15 text-amber-700 dark:text-amber-300' };
  return { label: 'Pushed', tone: 'bg-accent/15 text-accent' };
}

export function RepoGitTable({ record: r }: { record: WorkRecord }) {
  const projects = useStore((s) => s.projects);
  if (!r.repoGit.length) return null;
  const untouched = r.repoBranches.length - r.repoGit.length;

  const chatHere = (g: RepoGit) => {
    const project = projects.find((p) => p.path === g.repo);
    if (!project || !g.worktreePath) return;
    void useStore
      .getState()
      .newConversationInWorktree({
        projectPath: project.path,
        worktreePath: g.worktreePath,
        branchName: g.branch,
        name: `Continue · ${r.title}`.slice(0, 80),
      })
      .then((conv) => conv && useStore.getState().setDraft(conv.id, contextDraft(r, '')));
  };

  return (
    <section className="mt-8">
      <div className="flex items-baseline gap-3 mb-3">
        <h2 className="text-[11px] uppercase tracking-wider text-ink-faint font-bold m-0">In git</h2>
        <span className="text-[11px] text-ink-faint">
          {r.repoGit.length} repo{r.repoGit.length === 1 ? '' : 's'} with commits
          {untouched > 0 ? ` · ${untouched} more had the branch cut but nothing on it` : ''}
        </span>
      </div>
      <div className="rounded-lg border border-card bg-card overflow-hidden">
        <table className="w-full text-xs border-collapse">
          <thead>
            <tr className="text-left text-[10px] uppercase tracking-wider text-ink-faint">
              <th className="font-semibold px-4 py-2">Repo</th>
              <th className="font-semibold px-4 py-2">Branch</th>
              <th className="font-semibold px-4 py-2">State</th>
              <th className="font-semibold px-4 py-2">Ahead / behind</th>
              <th className="font-semibold px-4 py-2">Last commit</th>
              <th className="px-4 py-2" />
            </tr>
          </thead>
          <tbody>
            {r.repoGit.map((g) => {
              const s = state(g);
              const project = projects.find((p) => p.path === g.repo);
              return (
                <tr key={`${g.repo}::${g.branch}`} className="border-t border-card align-top">
                  <td className="px-4 py-2.5 font-medium text-ink whitespace-nowrap">{basename(g.repo)}</td>
                  <td className="px-4 py-2.5 font-mono text-[11px] text-ink-muted">{g.branch}</td>
                  <td className="px-4 py-2.5">
                    <span className={`text-[10.5px] font-semibold px-2 py-0.5 rounded-full whitespace-nowrap ${s.tone}`}>{s.label}</span>
                  </td>
                  <td className="px-4 py-2.5 tabular-nums text-ink-muted whitespace-nowrap">
                    {g.status.ahead} ahead · {g.status.behind} behind
                  </td>
                  <td className="px-4 py-2.5 text-ink-muted min-w-0">
                    <span className="block truncate max-w-[36ch]" title={g.status.lastSubject}>
                      {g.status.lastSubject ?? ''}
                    </span>
                    <span className="text-[10.5px] text-ink-faint">{when(g.status.lastCommitAt)}</span>
                  </td>
                  <td className="px-4 py-2.5 text-right whitespace-nowrap">
                    {project && g.worktreePath && (
                      <button onClick={() => chatHere(g)} className="text-accent hover:underline">
                        Chat here
                      </button>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}
