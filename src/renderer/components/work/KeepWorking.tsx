// Pick a piece of work back up from its record.
//
// A run or agent chat that worked in a worktree left its files and branch
// behind, and "where was that, and how do I get back in" was a trip through
// the run pane, the sidebar and a terminal. This finds the trees the work
// used, says which are still on disk, and opens a chat in one — or, when the
// tree was cleaned up but the branch lives on, checks the branch back out
// first. Every chat it opens starts with the record's context in the composer,
// unsent.

import { useEffect, useMemo, useState } from 'react';

import type { WorkRecord } from '@shared/workRecords';
import { isSamePath } from '@shared/pathScope';
import { useStore } from '../../store';

interface Tree {
  path: string;
  /// What worked in it, for the row's caption.
  from: string;
  alive: boolean | null;
  branch?: string;
}

/// Worktrees the record's runs and chats worked in. A run's coordinator dir
/// is where a workspace run's agents talk, not a checkout, so it is left out.
function candidateTrees(r: WorkRecord): Array<{ path: string; from: string }> {
  const out: Array<{ path: string; from: string }> = [];
  const add = (p: string | undefined, from: string) => {
    if (!p || isSamePath(p, r.placePath) || /[\\/]coordinators[\\/]/.test(p)) return;
    if (out.some((t) => isSamePath(t.path, p))) return;
    out.push({ path: p, from });
  };
  for (const run of r.runs) add(run.cwd, `flow run · ${run.flowName}`);
  for (const chat of r.chats) add(chat.worktreePath, `chat · ${chat.name}`);
  return out;
}

/// The note a new chat opens with: enough to pick the work up without
/// re-reading the record.
export function contextDraft(r: WorkRecord, ask: string): string {
  const lines = [`Picking up earlier work: ${r.title}`];
  if (r.branch) lines.push(`Branch: ${r.branch}`);
  if (r.pr) lines.push(`PR: #${r.pr.number} (${r.pr.state.toLowerCase()}) ${r.pr.url}`);
  if (r.ticket) lines.push(`Ticket: ${r.ticket}`);
  if (r.headline) lines.push(`Where it got to: ${r.headline}`);
  if (ask) lines.push('', 'What was asked back then:', ask.length > 1500 ? `${ask.slice(0, 1500)}…` : ask);
  lines.push('', '');
  return lines.join('\n');
}

/// A new chat in the record's own place — its project, or its workspace — with
/// `draft` waiting in the message box. False when the place is gone.
export async function openChatInPlace(r: WorkRecord, draft: string): Promise<boolean> {
  const st = useStore.getState();
  const project = st.projects.find((p) => isSamePath(p.path, r.placePath));
  const workspace = st.workspaces.find((w) => isSamePath(w.rootPath, r.placePath));
  const conv = project
    ? await st.newConversation(project.id)
    : workspace
      ? await st.newConversationInWorkspace(workspace.id)
      : null;
  if (conv) st.setDraft(conv.id, draft);
  return !!conv;
}

export function KeepWorking({ record: r, ask }: { record: WorkRecord; ask: string }) {
  const projects = useStore((s) => s.projects);
  const workspaces = useStore((s) => s.workspaces);
  const project = projects.find((p) => isSamePath(p.path, r.placePath));
  const workspace = workspaces.find((w) => isSamePath(w.rootPath, r.placePath));
  const candidates = useMemo(() => candidateTrees(r), [r]);
  const [trees, setTrees] = useState<Tree[]>(() => candidates.map((c) => ({ ...c, alive: null })));
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Which trees are still on disk — a cleaned-up tree answers "not a repo".
  useEffect(() => {
    let live = true;
    setTrees(candidates.map((c) => ({ ...c, alive: null })));
    void Promise.all(
      candidates.map(async (c) => {
        try {
          const res = await window.overcli.invoke('git:currentBranch', { cwd: c.path });
          return { ...c, alive: res.isRepo, ...(res.branch ? { branch: res.branch } : {}) };
        } catch {
          return { ...c, alive: false };
        }
      }),
    ).then((checked) => live && setTrees(checked));
    return () => {
      live = false;
    };
  }, [candidates]);

  const draftInto = (convId: string) => useStore.getState().setDraft(convId, contextDraft(r, ask));

  const chatInTree = async (worktreePath: string, branch?: string) => {
    if (!project) return;
    const conv = await useStore.getState().newConversationInWorktree({
      projectPath: project.path,
      worktreePath,
      ...(branch ?? r.branch ? { branchName: branch ?? r.branch } : {}),
      name: `Continue · ${r.title}`.slice(0, 80),
    });
    if (conv) draftInto(conv.id);
  };

  const checkOutBranch = async () => {
    if (!project || !r.branch) return;
    setBusy('branch');
    setError(null);
    try {
      const res = await window.overcli.invoke('git:worktreeForBranch', { projectPath: project.path, branch: r.branch });
      if (!res.ok) {
        setError(res.error);
        return;
      }
      if (res.mainCheckout) {
        // The project itself is on the branch: a plain chat there is it.
        const conv = await useStore.getState().newConversation(project.id);
        draftInto(conv.id);
      } else {
        await chatInTree(res.worktreePath, r.branch);
      }
    } finally {
      setBusy(null);
    }
  };

  const chatInPlace = async () => {
    setBusy('place');
    try {
      await openChatInPlace(r, contextDraft(r, ask));
    } finally {
      setBusy(null);
    }
  };

  const alive = trees.filter((t) => t.alive);
  const canCheckOut = !!project && !!r.branch && alive.length === 0;

  return (
    <section>
      <h2 className="text-[11px] uppercase tracking-wider text-ink-faint font-bold m-0 mb-3">Keep working</h2>
      <div className="rounded-lg border border-card bg-card px-5 py-4 flex flex-col gap-3">
        {trees.length > 0 && (
          <ul className="m-0 p-0 list-none flex flex-col gap-2">
            {trees.map((t) => (
              <li key={t.path} className="flex items-start gap-3">
                <span
                  className={
                    'mt-1 w-2 h-2 rounded-full flex-none ' +
                    (t.alive === null ? 'bg-ink-faint/40' : t.alive ? 'bg-green-500' : 'bg-ink-faint/60')
                  }
                  aria-hidden
                />
                <span className="flex-1 min-w-0">
                  <span className="block font-mono text-[11px] text-ink truncate" title={t.path}>
                    {t.path.split(/[\\/]/).slice(-2).join('/')}
                  </span>
                  <span className="block text-[11px] text-ink-faint truncate">
                    {t.alive === null
                      ? 'Checking…'
                      : t.alive
                        ? `Worktree on disk${t.branch ? ` · on ${t.branch}` : ''} · ${t.from}`
                        : `Worktree removed · ${t.from}`}
                  </span>
                </span>
                {t.alive && project && (
                  <button
                    onClick={() => void chatInTree(t.path, t.branch)}
                    className="flex-none text-xs font-medium text-accent hover:underline"
                  >
                    Chat here
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
        {trees.length > 0 && alive.length > 0 && !project && (
          <div className="text-[11px] text-ink-faint">
            Chatting in a worktree needs its repo added as a place.
          </div>
        )}
        {canCheckOut && (
          <button
            onClick={() => void checkOutBranch()}
            disabled={busy !== null}
            className="self-start text-xs font-semibold px-3 py-1.5 rounded-md bg-accent text-white hover:opacity-90 disabled:opacity-50"
          >
            {busy === 'branch' ? 'Checking out…' : `Check out ${r.branch} and chat`}
          </button>
        )}
        {error && <div className="text-[11px] text-red-600 dark:text-red-300 whitespace-pre-wrap">{error}</div>}
        {(project || workspace) && (
          // The main way back in when there is no tree to reopen — so it is
          // the page's filled button then, and a bordered one beside the
          // worktree actions otherwise.
          <button
            onClick={() => void chatInPlace()}
            disabled={busy !== null}
            className={
              'self-start flex items-center gap-2 text-xs font-semibold px-4 py-2 rounded-md disabled:opacity-50 ' +
              (alive.length === 0 && !canCheckOut
                ? 'bg-accent text-white hover:opacity-90'
                : 'border border-accent/50 text-accent hover:bg-accent/10')
            }
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" aria-hidden>
              <path d="M4 5h16v11H9l-5 4z" />
            </svg>
            {busy === 'place' ? 'Opening…' : `Continue in a new chat in ${r.placeName}`}
          </button>
        )}
        <div className="text-[11px] text-ink-faint">
          Each chat opens with a note about this work in the message box — nothing is sent until you send it.
        </div>
      </div>
    </section>
  );
}
