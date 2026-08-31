// The work a finished orchestration item left behind, opened by commit
// rather than by run.
//
// Every other diff surface in the app is keyed to something live — a
// Conversation, a FlowRun, a worktree that still exists. This one exists for
// the case where all three are gone: `pruneOldRuns` has evicted the run, the
// flow deleted its own worktree, and the branch the item recorded was a
// scratch branch that no longer resolves. What survives is the commit
// (`OrchestrationItem.headSha`), so that is what this sheet navigates by.
//
// Read-only on purpose. There is no run to resume and no worktree to merge
// from; the useful questions here are "what did it change" and "where did it
// end up", and the answer to the second is whatever branches contain the
// commit today.

import { useEffect, useMemo, useState } from 'react';

import { useStore } from '../../store';
import { FileDiff, fileBaseName, parseUnifiedDiffByFile } from '../../diff-utils';
import { UnifiedDiffBody } from './WorktreeDiffSheet';

/// Field separator for `--format`. A unit separator can't occur in a commit
/// subject, unlike every printable character worth splitting on.
const FS = '\x1f';

interface Commit {
  sha: string;
  subject: string;
  author: string;
  date: string;
}

type Load =
  | { kind: 'loading' }
  /// The commit isn't in the repo any more — the branch that held it was
  /// deleted and gc has since collected it. Nothing to show, and saying so
  /// beats an empty file list that reads as "it changed nothing".
  | { kind: 'gone' }
  | { kind: 'ready'; commits: Commit[]; branches: string[]; files: FileDiff[] };

async function git(args: string[], cwd: string): Promise<{ ok: boolean; out: string }> {
  const res = await window.overcli.invoke('git:run', { args, cwd });
  return { ok: res.exitCode === 0, out: res.stdout };
}

/// What the item added on top of its base, or — when the work has since been
/// merged into that base — the commit itself.
///
/// `<base>..<sha>` goes empty once `sha` is an ancestor of `base`, which is
/// exactly what happens after the work lands. Reading that emptiness as "no
/// changes" would blank the sheet for every shift that succeeded, so we fall
/// back to the single commit (`sha^!` — the commit against its parent).
async function resolveRange(
  cwd: string,
  sha: string,
  baseBranch: string | undefined,
): Promise<{ commits: string[]; diffArgs: string[] }> {
  if (baseBranch) {
    const base = await git(['rev-parse', '--verify', `${baseBranch}^{commit}`], cwd);
    if (base.ok) {
      const log = await git(['log', '--format=%H', `${baseBranch}..${sha}`], cwd);
      const commits = log.out.split('\n').filter(Boolean);
      if (commits.length > 0) {
        return { commits, diffArgs: ['diff', `${baseBranch}...${sha}`] };
      }
    }
  }
  return { commits: [sha], diffArgs: ['diff', `${sha}^!`] };
}

export function ShiftWorkSheet({
  projectPath,
  headSha,
  title,
  baseBranch,
}: {
  projectPath: string;
  headSha: string;
  title: string;
  baseBranch?: string;
}) {
  const close = useStore((s) => s.openSheet);
  const [load, setLoad] = useState<Load>({ kind: 'loading' });
  const [selected, setSelected] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    setLoad({ kind: 'loading' });
    void (async () => {
      const exists = await git(['rev-parse', '--verify', `${headSha}^{commit}`], projectPath);
      if (!live) return;
      if (!exists.ok) {
        setLoad({ kind: 'gone' });
        return;
      }

      const { commits: shas, diffArgs } = await resolveRange(projectPath, headSha, baseBranch);
      // One `log` for every commit in the range rather than one per sha:
      // a shift that made eight commits shouldn't cost eight subprocesses.
      const [detail, contains, diff] = await Promise.all([
        git(['log', '--no-walk', `--format=%H${FS}%s${FS}%an${FS}%ad`, '--date=short', ...shas], projectPath),
        git(['branch', '--contains', headSha, '--format=%(refname:short)'], projectPath),
        git(diffArgs, projectPath),
      ]);
      if (!live) return;

      const commits: Commit[] = detail.out
        .split('\n')
        .filter(Boolean)
        .map((line) => {
          const [sha, subject, author, date] = line.split(FS);
          return { sha: sha ?? '', subject: subject ?? '', author: author ?? '', date: date ?? '' };
        });
      const files = parseUnifiedDiffByFile(diff.out);
      setLoad({
        kind: 'ready',
        commits,
        branches: contains.out.split('\n').map((b) => b.trim()).filter(Boolean),
        files,
      });
      setSelected(files[0]?.path ?? null);
    })();
    return () => {
      live = false;
    };
  }, [projectPath, headSha, baseBranch]);

  const files = load.kind === 'ready' ? load.files : [];
  const selectedFile = useMemo(
    () => files.find((f) => f.path === selected) ?? null,
    [files, selected],
  );

  return (
    <div className="flex flex-col h-full min-h-0">
      <div className="px-4 py-3 border-b border-white/5 flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <div className="text-sm font-medium text-ink truncate" title={title}>
            {title}
          </div>
          <div className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-ink-faint">
            <span className="font-mono">{headSha.slice(0, 10)}</span>
            {load.kind === 'ready' &&
              (load.branches.length > 0 ? (
                <span className="truncate" title={load.branches.join(', ')}>
                  on {load.branches.join(', ')}
                </span>
              ) : (
                // Reachable but on no branch — a detached commit still in the
                // object store. Worth saying: it is one `gc` from the `gone`
                // state above.
                <span>on no branch — reachable only by id</span>
              ))}
          </div>
        </div>
        <button
          onClick={() => close(null)}
          className="text-xs px-2 py-1 rounded text-ink-muted hover:text-ink hover:bg-white/5"
        >
          Close
        </button>
      </div>

      {load.kind === 'gone' ? (
        <div className="flex-1 flex items-center justify-center px-8 text-center">
          <div className="max-w-[420px] text-xs text-ink-muted">
            The commit this item left behind (
            <span className="font-mono">{headSha.slice(0, 10)}</span>) is no longer in{' '}
            {projectPath}. Its branch was deleted and git has since collected it.
          </div>
        </div>
      ) : (
        <div className="flex-1 min-h-0 flex">
          <div className="w-[280px] min-w-[240px] max-w-[360px] border-r border-white/5 flex flex-col">
            {load.kind === 'ready' && load.commits.length > 0 && (
              <div className="border-b border-white/5">
                <div className="px-3 py-2 text-[10px] uppercase tracking-wider text-ink-faint">
                  {load.commits.length === 1 ? 'Commit' : `Commits (${load.commits.length})`}
                </div>
                <div className="max-h-[132px] overflow-y-auto pb-1">
                  {load.commits.map((c) => (
                    <div key={c.sha} className="px-3 py-1">
                      <div className="text-[11px] text-ink truncate" title={c.subject}>
                        {c.subject}
                      </div>
                      <div className="text-[10px] text-ink-faint truncate">
                        <span className="font-mono">{c.sha.slice(0, 8)}</span> · {c.author} · {c.date}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}
            <div className="px-3 py-2 text-[10px] uppercase tracking-wider text-ink-faint border-b border-white/5">
              Files ({files.length})
            </div>
            <div className="flex-1 overflow-y-auto">
              {load.kind === 'loading' ? (
                <div className="px-3 py-2 text-[11px] text-ink-faint">Reading the commit…</div>
              ) : files.length === 0 ? (
                <div className="px-3 py-2 text-[11px] text-ink-faint">
                  This commit changed no files.
                </div>
              ) : (
                files.map((f) => (
                  <button
                    key={f.path}
                    onClick={() => setSelected(f.path)}
                    className={
                      'w-full text-left px-3 py-1.5 border-b border-white/5 last:border-b-0 ' +
                      (selected === f.path
                        ? 'bg-white/10 text-ink'
                        : 'text-ink-muted hover:bg-white/5 hover:text-ink')
                    }
                    title={f.path}
                  >
                    <div className="flex items-center gap-1.5">
                      <span className="text-[11px] truncate flex-1">{fileBaseName(f.path)}</span>
                      {f.added > 0 && <span className="text-[10px] diff-add-ink">+{f.added}</span>}
                      {f.removed > 0 && (
                        <span className="text-[10px] diff-remove-ink">−{f.removed}</span>
                      )}
                    </div>
                    <div className="text-[10px] text-ink-faint truncate">{f.path}</div>
                  </button>
                ))
              )}
            </div>
          </div>
          <div className="flex-1 min-w-0 overflow-auto">
            {selectedFile ? (
              <UnifiedDiffBody text={selectedFile.body} />
            ) : (
              <div className="h-full flex items-center justify-center text-xs text-ink-faint">
                Select a file.
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
