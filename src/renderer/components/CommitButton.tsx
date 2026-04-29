import { useEffect, useMemo, useRef, useState } from 'react';
import { useStore } from '../store';
import { workspaceSymlinkNames } from '@shared/workspaceNames';
import type { UUID } from '@shared/types';
import { useConversation } from '../hooks';
import { findOwningProjectPath } from '../diff-utils';

type CommitTarget =
  | { kind: 'cwd'; cwd: string }
  | { kind: 'workspace'; projects: Array<{ name: string; path: string }> }
  | { kind: 'none' };

export function CommitButton({ conversationId }: { conversationId: UUID }) {
  const conv = useConversation(conversationId);
  const projects = useStore((s) => s.projects);
  const workspaces = useStore((s) => s.workspaces);
  const gitStatus = useStore((s) => s.gitStatusByConv[conversationId]);
  const refreshGitStatus = useStore((s) => s.refreshGitStatus);
  const [open, setOpen] = useState(false);
  const [message, setMessage] = useState('');
  const [messageEdited, setMessageEdited] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [successSubject, setSuccessSubject] = useState<string | null>(null);
  const [flashKey, setFlashKey] = useState(0);
  const prevStatsRef = useRef<{ insertions: number; deletions: number } | null>(null);
  const ref = useRef<HTMLDivElement>(null);

  // Mirror `refreshGitStatus`'s resolution order so a single click commits
  // exactly the changes the popover lists. Worktree-bound or project-hosted
  // convs pin one cwd; multi-project workspace convs (coordinator agents,
  // or workspace conversations with no worktree) commit per-member because
  // the symlink-farm root isn't itself a git repo.
  const target = useMemo<CommitTarget>(() => {
    if (conv?.worktreePath) return { kind: 'cwd', cwd: conv.worktreePath };
    const owning = findOwningProjectPath(projects, conversationId);
    if (owning) return { kind: 'cwd', cwd: owning };
    for (const w of workspaces) {
      const c = (w.conversations ?? []).find((x) => x.id === conversationId);
      if (!c) continue;
      if (c.workspaceAgentMemberIds?.length) {
        const seen = new Set<string>();
        const usedNames = new Set<string>();
        const out: Array<{ name: string; path: string }> = [];
        for (const memberId of c.workspaceAgentMemberIds) {
          for (const proj of projects) {
            const member = proj.conversations.find((x) => x.id === memberId);
            if (!member?.worktreePath || seen.has(member.worktreePath)) continue;
            seen.add(member.worktreePath);
            let name = proj.name;
            let i = 2;
            while (usedNames.has(name)) {
              name = `${proj.name}-${i}`;
              i += 1;
            }
            usedNames.add(name);
            out.push({ name, path: member.worktreePath });
          }
        }
        return out.length ? { kind: 'workspace', projects: out } : { kind: 'none' };
      }
      const projs = w.projectIds
        .map((pid) => projects.find((p) => p.id === pid))
        .filter((p): p is NonNullable<typeof p> => !!p && !!p.path)
        .map((p) => ({ name: p.name, path: p.path }));
      return projs.length
        ? { kind: 'workspace', projects: workspaceSymlinkNames(projs) }
        : { kind: 'none' };
    }
    return { kind: 'none' };
  }, [conv, projects, workspaces, conversationId]);
  const isRepo = gitStatus?.isRepo ?? false;
  const currentBranch = gitStatus?.currentBranch ?? '';
  const changes = gitStatus?.changes ?? [];
  const insertions = gitStatus?.insertions ?? 0;
  const deletions = gitStatus?.deletions ?? 0;

  // Flash the +/- badge whenever the numbers change (other than on the
  // initial probe). Bumping flashKey remounts the span so the CSS
  // animation replays from the start.
  useEffect(() => {
    const prev = prevStatsRef.current;
    if (!prev) {
      prevStatsRef.current = { insertions, deletions };
      return;
    }
    if (prev.insertions === insertions && prev.deletions === deletions) return;
    prevStatsRef.current = { insertions, deletions };
    setFlashKey((k) => k + 1);
  }, [insertions, deletions]);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener('mousedown', handler);
    return () => window.removeEventListener('mousedown', handler);
  }, [open]);

  // Re-probe and seed a draft message every time the popover opens so the
  // user sees the current state + a fresh suggestion, not whatever was
  // there five minutes ago.
  useEffect(() => {
    if (!open) return;
    setError(null);
    setSuccessSubject(null);
    void refreshGitStatus(conversationId).then(() => {
      // Seed draft only if the user hasn't typed their own — preserves
      // in-progress edits when they accidentally click outside.
      if (!messageEdited) {
        setMessage(draftCommitMessage(changes));
      }
    });
    // We intentionally don't add `changes` / `messageEdited` to deps —
    // the draft seeds on popover-open only, not on every state tick.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, conversationId, refreshGitStatus]);

  if (!isRepo) return null;

  const hasChanges = changes.length > 0;

  const onCommit = async () => {
    if (busy) return;
    if (target.kind === 'none') {
      setError("Couldn't resolve a working directory for this conversation.");
      return;
    }
    setBusy(true);
    setError(null);
    if (target.kind === 'cwd') {
      const res = await window.overcli.invoke('git:commitAll', { cwd: target.cwd, message });
      setBusy(false);
      if (res.ok) {
        setSuccessSubject(res.subject);
        setMessageEdited(false);
        setMessage('');
        await refreshGitStatus(conversationId);
      } else {
        setError(res.error);
      }
      return;
    }
    const res = await window.overcli.invoke('git:workspaceCommitAll', {
      projects: target.projects,
      message,
    });
    setBusy(false);
    if (res.ok) {
      const names = res.committed.map((c) => c.name).join(', ');
      const summary = res.committed.length === 1
        ? `${res.subject} (${names})`
        : `${res.subject} — ${res.committed.length} repos: ${names}`;
      setSuccessSubject(summary);
      setMessageEdited(false);
      setMessage('');
      if (res.skipped.length > 0) {
        setError(
          `Skipped: ${res.skipped.map((s) => `${s.name} (${s.reason})`).join('; ')}`,
        );
      }
      await refreshGitStatus(conversationId);
    } else {
      setError(res.error);
    }
  };

  const diffstatTitle = hasChanges
    ? `Commit · ${changes.length} file${changes.length === 1 ? '' : 's'} · +${insertions} −${deletions}`
    : 'Working tree clean';

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen((o) => !o)}
        title={diffstatTitle}
        className={
          'h-7 px-1.5 flex items-center gap-1.5 rounded text-ink-muted hover:bg-card-strong hover:text-ink ' +
          (open ? 'bg-accent/20 text-ink' : '')
        }
      >
        <CommitIcon />
        {hasChanges && (
          <span
            key={flashKey}
            className={
              'flex items-center gap-1 text-[10px] font-mono leading-none ' +
              (flashKey > 0 ? 'git-stats-flash' : '')
            }
          >
            <span className="diff-add-ink">+{insertions}</span>
            <span className="diff-remove-ink">−{deletions}</span>
          </span>
        )}
      </button>
      {open && (
        <div className="absolute right-0 top-full mt-1 w-[340px] bg-surface-elevated border border-card-strong rounded-lg shadow-xl z-50 p-3 text-xs flex flex-col gap-2">
          <div className="flex items-center justify-between">
            <div className="text-[10px] uppercase tracking-wider text-ink-faint">Commit</div>
            {currentBranch && (
              <div className="text-[10px] font-mono text-ink-faint truncate max-w-[180px]" title={currentBranch}>
                ⎇ {currentBranch}
              </div>
            )}
          </div>

          {successSubject ? (
            <div className="text-[11px] text-emerald-400">
              Committed: <span className="font-mono">{successSubject}</span>
            </div>
          ) : !hasChanges ? (
            <div className="text-[11px] text-ink-muted">Working tree clean — nothing to commit.</div>
          ) : (
            <>
              <div className="rounded border border-card bg-card px-2 py-1.5 text-[10px] font-mono text-ink-muted max-h-[96px] overflow-y-auto">
                {changes.slice(0, 30).map((c) => (
                  <div key={c.path} className="truncate" title={c.path}>
                    <span className="text-ink-faint mr-1.5">{c.status.trim() || '??'}</span>
                    {c.path}
                  </div>
                ))}
                {changes.length > 30 && (
                  <div className="text-ink-faint">… {changes.length - 30} more</div>
                )}
              </div>
              <textarea
                value={message}
                onChange={(e) => {
                  setMessage(e.target.value);
                  setMessageEdited(true);
                }}
                onKeyDown={(e) => {
                  if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
                    e.preventDefault();
                    if (!busy && message.trim()) void onCommit();
                  }
                }}
                placeholder={`Commit message (${shortcutLabel()} to commit)`}
                rows={3}
                className="field px-2 py-1.5 text-[11px] leading-5 resize-none"
                autoFocus
              />
              <div className="text-[10px] text-ink-faint">
                Runs <span className="font-mono">git add -A</span> then{' '}
                <span className="font-mono">git commit</span>. Push separately from the Diff sheet.
              </div>
            </>
          )}

          {error && <div className="text-[11px] text-red-400 whitespace-pre-wrap">{error}</div>}

          <div className="flex items-center gap-2 pt-1">
            <button
              onClick={() => setOpen(false)}
              className="text-[11px] px-2 py-1 rounded text-ink-muted hover:text-ink"
            >
              Close
            </button>
            <div className="flex-1" />
            {hasChanges && !successSubject && (
              <button
                onClick={onCommit}
                disabled={busy || !message.trim()}
                className={
                  'text-xs px-3 py-1.5 rounded border flex items-center gap-2 ' +
                  (busy || !message.trim()
                    ? 'bg-card text-ink-faint border-card cursor-not-allowed'
                    : 'bg-accent/20 text-ink border-accent/40 hover:bg-accent/30')
                }
              >
                <span>{busy ? 'Committing…' : 'Commit'}</span>
                {!busy && (
                  <span className="text-xs text-ink-muted">{shortcutLabel()}</span>
                )}
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

/// OS-aware label for the commit submit shortcut. Mac gets the native
/// ⌘ glyph + the word "Return" (the ⏎ / ↵ Unicode chars render
/// inconsistently in most mono/sans stacks and look visually wrong at
/// small sizes). Other platforms get the fully spelled form.
export function shortcutLabel(): string {
  const isMac = typeof navigator !== 'undefined' && /Mac|iPod|iPhone|iPad/.test(navigator.platform);
  return isMac ? '⌘ Return' : 'Ctrl + Enter';
}

/// Simple draft: one file → "Update <basename>". Files all under one
/// directory → "Update <dir>". Otherwise a file count. Intentionally
/// dumb — anything smarter would need to read the diff, which is more
/// work than drafting-from-scratch is worth.
export function draftCommitMessage(changes: Array<{ path: string }>): string {
  if (changes.length === 0) return '';
  if (changes.length === 1) {
    const name = changes[0].path.split('/').pop() || changes[0].path;
    return `Update ${name}`;
  }
  const dirs = new Set(
    changes.map((c) => {
      const parts = c.path.split('/');
      return parts.length > 1 ? parts[0] : '.';
    }),
  );
  if (dirs.size === 1) {
    const only = Array.from(dirs)[0];
    return only === '.' ? `Update ${changes.length} files` : `Update ${only}`;
  }
  return `Update ${changes.length} files`;
}

function CommitIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
      <circle cx="8" cy="8" r="3" stroke="currentColor" strokeWidth="1.3" />
      <line x1="1.5" y1="8" x2="5" y2="8" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
      <line x1="11" y1="8" x2="14.5" y2="8" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
    </svg>
  );
}
