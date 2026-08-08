// Settings → Conversations. Tidies up conversations you've stopped using.
//
// The counterpart to Settings → Storage, and deliberately separate from it.
// Storage reclaims disk; this deletes history. They looked similar enough to
// merge — both are "cleanup", both key off worktrees — but the trade is
// opposite: the conversations here are typically kilobytes each, so bundling
// them into a disk pane meant offering to destroy hundreds of chats in
// exchange for no measurable space.
//
// Archive is therefore the default action and delete is the opt-in. Archiving
// is reversible and already the app's idiom for "done with this for now"; it
// just doesn't reclaim the worktree.

import { useMemo, useState } from 'react';
import { useStore } from '../../store';
import { useAllRunners } from '../../runnersStore';
import {
  Conversation,
  UUID,
  DEFAULT_STALE_DAYS,
  STALE_DAY_CHOICES,
  conversationActiveAt,
  isStaleConversation,
} from '@shared/types';
import { Group, SheetActionButton } from './settingsChrome';

type Mode = 'archive' | 'delete';

interface Candidate {
  conv: Conversation;
  projectName: string;
  projectPath: string;
  /// Owns a worktree it would take with it. Adopted worktrees don't count —
  /// those belong to a flow run and survive the conversation.
  ownsWorktree: boolean;
  activeAt: number;
}

interface WorktreeState {
  exists: boolean;
  dirtyFiles: number;
  commitsAhead: number;
  isMergedIntoBase: boolean;
}

function formatAge(at: number): string {
  if (!at) return 'undated';
  const days = Math.floor((Date.now() - at) / (24 * 60 * 60 * 1000));
  if (days < 1) return 'today';
  if (days === 1) return 'yesterday';
  if (days < 30) return `${days}d`;
  const months = Math.floor(days / 30);
  return months === 1 ? '1mo' : `${months}mo`;
}

export function ConversationsPane() {
  const projects = useStore((s) => s.projects);
  const workspaces = useStore((s) => s.workspaces);
  const selectedConversationId = useStore((s) => s.selectedConversationId);
  const setConversationHidden = useStore((s) => s.setConversationHidden);
  const removeAgent = useStore((s) => s.removeAgent);
  const removeConversation = useStore((s) => s.removeConversation);
  const runners = useAllRunners();

  const [staleDays, setStaleDays] = useState<number>(DEFAULT_STALE_DAYS);
  const [mode, setMode] = useState<Mode>('archive');
  const [selected, setSelected] = useState<Set<UUID>>(new Set());
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [states, setStates] = useState<Record<UUID, WorktreeState>>({});
  const [checking, setChecking] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [working, setWorking] = useState(false);
  const [progress, setProgress] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<string | null>(null);

  /// Everything quiet enough to offer. Skips the conversation you're looking
  /// at and anything still streaming — the same rule ArchiveAllSheet uses, so
  /// the two can't disagree about what "inactive" means.
  const candidates = useMemo<Candidate[]>(() => {
    const now = Date.now();
    const out: Candidate[] = [];
    const consider = (conv: Conversation, projectName: string, projectPath: string) => {
      if (conv.id === selectedConversationId) return;
      if (runners[conv.id]?.isRunning) return;
      if (
        !isStaleConversation({
          lastActiveAt: conv.lastActiveAt,
          createdAt: conv.createdAt,
          archived: !!conv.hidden,
          staleDays,
          now,
        })
      )
        return;
      out.push({
        conv,
        projectName,
        projectPath,
        ownsWorktree: !!conv.worktreePath && !conv.adoptedWorktree,
        activeAt: conversationActiveAt(conv),
      });
    };
    for (const p of projects) {
      for (const c of p.conversations) consider(c, p.name, p.path);
    }
    for (const w of workspaces) {
      for (const c of w.conversations ?? []) consider(c, w.name, w.rootPath ?? '');
    }
    return out.sort((a, b) => a.activeAt - b.activeAt);
  }, [projects, workspaces, selectedConversationId, runners, staleDays]);

  // Archiving is reversible and touches nothing on disk, so it needs no
  // pre-flight. Deleting destroys worktrees, so the git check runs when the
  // user switches to that mode rather than on every threshold change.
  const checkWorktrees = async () => {
    const targets = candidates
      .filter((c) => c.ownsWorktree && c.projectPath)
      .map((c) => ({
        convId: c.conv.id,
        projectPath: c.projectPath,
        worktreePath: c.conv.worktreePath!,
        branchName: c.conv.branchName ?? null,
        baseBranch: c.conv.baseBranch ?? 'main',
      }));
    if (targets.length === 0) return;
    setChecking(true);
    setError(null);
    try {
      const res = await window.overcli.invoke('git:conversationWorktreeStates', { targets });
      const map: Record<UUID, WorktreeState> = {};
      for (const s of res) {
        map[s.convId] = {
          exists: s.exists,
          dirtyFiles: s.dirtyFiles,
          commitsAhead: s.commitsAhead,
          isMergedIntoBase: s.isMergedIntoBase,
        };
      }
      setStates(map);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setChecking(false);
    }
  };

  const hasWork = (c: Candidate): boolean => {
    const s = states[c.conv.id];
    if (!s || !s.exists) return false;
    return s.dirtyFiles > 0 || (s.commitsAhead > 0 && !s.isMergedIntoBase);
  };

  const groups = useMemo(() => {
    const byProject = new Map<string, Candidate[]>();
    for (const c of candidates) {
      const list = byProject.get(c.projectName);
      if (list) list.push(c);
      else byProject.set(c.projectName, [c]);
    }
    return [...byProject.entries()]
      .map(([projectName, list]) => ({ projectName, items: list }))
      .sort((a, b) => b.items.length - a.items.length);
  }, [candidates]);

  const selectedList = candidates.filter((c) => selected.has(c.conv.id));
  const selectedWithWork = selectedList.filter(hasWork);
  const selectedWithWorktree = selectedList.filter((c) => c.ownsWorktree);

  const toggle = (id: UUID) => {
    setConfirming(false);
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleMany = (ids: UUID[], on: boolean) => {
    setConfirming(false);
    setSelected((prev) => {
      const next = new Set(prev);
      for (const id of ids) {
        if (on) next.add(id);
        else next.delete(id);
      }
      return next;
    });
  };

  const selectSuggested = () => {
    // In delete mode, never pre-arm something holding work. In archive mode
    // everything is fair game — archiving destroys nothing.
    const ids = candidates
      .filter((c) => (mode === 'delete' ? !hasWork(c) : true))
      .map((c) => c.conv.id);
    setSelected(new Set(ids));
  };

  const run = async () => {
    setWorking(true);
    setError(null);
    const failures: string[] = [];
    let done = 0;
    try {
      for (const c of selectedList) {
        setProgress(`${done + 1} of ${selectedList.length}…`);
        if (mode === 'archive') {
          if (!c.conv.hidden) await setConversationHidden(c.conv.id, true);
          done++;
          continue;
        }
        // `removeAgent` handles both shapes: it removes the worktree when the
        // conversation owns one and falls through to a plain row delete when
        // it doesn't, so there's no branching needed here.
        const res = c.ownsWorktree
          ? await removeAgent(c.conv.id)
          : (await removeConversation(c.conv.id), { ok: true as const });
        if (res.ok) done++;
        else failures.push(`${c.conv.name}: ${res.error}`);
      }
      setResult(
        mode === 'archive'
          ? `Archived ${done} conversation${done === 1 ? '' : 's'}.`
          : `Deleted ${done} conversation${done === 1 ? '' : 's'}.`,
      );
      if (failures.length > 0) {
        setError(`${failures.length} could not be removed:\n` + failures.join('\n'));
      }
      setSelected(new Set());
      setConfirming(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setWorking(false);
      setProgress(null);
    }
  };

  const withWorktreeCount = candidates.filter((c) => c.ownsWorktree).length;

  return (
    <div className="space-y-5">
      <Group
        title="Inactive conversations"
        description="Conversations you haven't touched in a while. Archiving hides them and frees their backend session but keeps everything on disk. Deleting also removes the agent's worktree and branch."
      >
        <div className="flex items-center gap-3 flex-wrap">
          <label className="flex items-center gap-1.5 text-xs text-ink-muted">
            Inactive for
            <select
              value={staleDays}
              disabled={working}
              onChange={(e) => {
                setStaleDays(Number(e.target.value));
                setSelected(new Set());
                setConfirming(false);
              }}
              className="field px-1.5 py-0.5 text-xs"
            >
              {STALE_DAY_CHOICES.map((d) => (
                <option key={d} value={d}>
                  {d} days
                </option>
              ))}
            </select>
          </label>
          <div className="text-xs text-ink-muted">
            {candidates.length} conversation{candidates.length === 1 ? '' : 's'}
            {withWorktreeCount > 0 && ` · ${withWorktreeCount} with a worktree`}
          </div>
        </div>
        <div className="text-[11px] text-ink-faint">
          Archived conversations count at half that — archiving is already you
          saying you're done with one. The open conversation and anything still
          running are never listed.
        </div>
      </Group>

      {candidates.length > 0 && (
        <div className="flex items-center gap-2 flex-wrap">
          <div className="flex gap-0.5 p-0.5 rounded bg-card w-fit">
            {(['archive', 'delete'] as const).map((m) => (
              <button
                key={m}
                onClick={() => {
                  setMode(m);
                  setSelected(new Set());
                  setConfirming(false);
                  if (m === 'delete' && Object.keys(states).length === 0) void checkWorktrees();
                }}
                disabled={working}
                className={
                  'text-xs px-2.5 py-1 rounded disabled:opacity-40 ' +
                  (mode === m
                    ? m === 'delete'
                      ? 'bg-red-500/25 text-red-200'
                      : 'bg-accent/30 text-accent'
                    : 'text-ink-muted hover:text-ink')
                }
              >
                {m === 'archive' ? 'Archive' : 'Delete'}
              </button>
            ))}
          </div>
          <SheetActionButton
            label={`Select all ${candidates.length}`}
            onClick={selectSuggested}
            disabled={working || checking}
          />
          {selected.size > 0 && (
            <SheetActionButton
              label="Clear"
              onClick={() => setSelected(new Set())}
              disabled={working}
            />
          )}
          {checking && <span className="text-[11px] text-ink-faint">Checking worktrees…</span>}
        </div>
      )}

      {mode === 'delete' && !checking && withWorktreeCount > 0 && (
        <div className="text-[11px] text-amber-300 bg-amber-500/10 border border-amber-500/30 rounded px-3 py-2">
          Deleting removes each agent's worktree and branch as well as the
          conversation. Rows holding uncommitted or unmerged work are marked and
          left out of “Select all”.
        </div>
      )}

      {result && (
        <div className="text-xs text-green-300 bg-green-500/10 border border-green-500/30 rounded px-3 py-2">
          {result}
        </div>
      )}
      {error && (
        <div className="text-xs text-red-300 bg-red-500/10 border border-red-500/30 rounded px-3 py-2 whitespace-pre-wrap max-h-40 overflow-y-auto">
          {error}
        </div>
      )}

      {candidates.length === 0 && (
        <div className="text-xs text-ink-faint">
          Nothing has been idle that long. Try a shorter threshold.
        </div>
      )}

      {selectedList.length > 0 && (
        <div
          className={
            'sticky top-0 z-10 -mx-1 px-3 py-2 rounded-lg border backdrop-blur ' +
            (mode === 'delete'
              ? 'border-red-500/40 bg-red-500/20'
              : 'border-accent/40 bg-surface-muted/95')
          }
        >
          <div className="flex items-center gap-3 flex-wrap">
            <div className="text-xs mr-auto">
              <span className="text-ink font-medium">{selectedList.length} selected</span>
              {mode === 'delete' && selectedWithWorktree.length > 0 && (
                <span className="text-ink-muted">
                  {' '}
                  · {selectedWithWorktree.length} worktree
                  {selectedWithWorktree.length === 1 ? '' : 's'} removed too
                </span>
              )}
            </div>
            {confirming ? (
              <>
                <SheetActionButton
                  label="Back"
                  onClick={() => setConfirming(false)}
                  disabled={working}
                />
                <button
                  onClick={() => void run()}
                  disabled={working}
                  className={
                    'px-3 py-1 rounded text-xs border disabled:opacity-40 ' +
                    (mode === 'delete'
                      ? 'bg-red-500/30 border-red-500/60 text-red-200 hover:bg-red-500/40'
                      : 'bg-accent/30 border-accent/60 text-accent hover:bg-accent/40')
                  }
                >
                  {working
                    ? (progress ?? 'Working…')
                    : mode === 'delete'
                      ? 'Delete them'
                      : 'Archive them'}
                </button>
              </>
            ) : (
              <SheetActionButton
                label={`${mode === 'delete' ? 'Delete' : 'Archive'} ${selectedList.length}…`}
                onClick={() => setConfirming(true)}
                disabled={working}
              />
            )}
          </div>
          {mode === 'delete' && selectedWithWork.length > 0 && (
            <div className="text-[11px] text-red-300 mt-1">
              {selectedWithWork.length} hold uncommitted or unmerged work that will be
              destroyed.
            </div>
          )}
        </div>
      )}

      <div className="flex flex-col gap-1">
        {groups.map((g) => {
          const ids = g.items.map((c) => c.conv.id);
          const selectedCount = ids.filter((id) => selected.has(id)).length;
          const allOn = selectedCount === ids.length;
          const expanded = open.has(g.projectName);
          return (
            <div key={g.projectName} className="rounded border border-card bg-card">
              <div className="flex items-center gap-2 px-2 py-1.5">
                <input
                  type="checkbox"
                  checked={allOn}
                  ref={(el) => {
                    if (el) el.indeterminate = selectedCount > 0 && !allOn;
                  }}
                  onChange={() => toggleMany(ids, !allOn)}
                  disabled={working}
                  className="accent-current"
                />
                <button
                  onClick={() =>
                    setOpen((prev) => {
                      const next = new Set(prev);
                      if (next.has(g.projectName)) next.delete(g.projectName);
                      else next.add(g.projectName);
                      return next;
                    })
                  }
                  className="flex items-center gap-1.5 min-w-0 flex-1 text-left"
                >
                  <span className="text-ink-faint text-[10px] w-2">
                    {expanded ? '▾' : '▸'}
                  </span>
                  <span className="text-xs text-ink truncate">{g.projectName}</span>
                  <span className="text-[11px] text-ink-faint">{g.items.length}</span>
                  {selectedCount > 0 && !allOn && (
                    <span className="text-[10px] text-accent">{selectedCount} selected</span>
                  )}
                </button>
              </div>
              {expanded && (
                <div className="border-t border-card divide-y divide-card/60">
                  {g.items.map((c) => (
                    <CandidateRow
                      key={c.conv.id}
                      candidate={c}
                      state={states[c.conv.id]}
                      mode={mode}
                      checked={selected.has(c.conv.id)}
                      onToggle={() => toggle(c.conv.id)}
                      disabled={working}
                    />
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function CandidateRow({
  candidate,
  state,
  mode,
  checked,
  onToggle,
  disabled,
}: {
  candidate: Candidate;
  state: WorktreeState | undefined;
  mode: Mode;
  checked: boolean;
  onToggle: () => void;
  disabled: boolean;
}) {
  const dirty = state && state.exists && state.dirtyFiles > 0;
  const unmerged =
    state && state.exists && state.commitsAhead > 0 && !state.isMergedIntoBase;
  const danger = mode === 'delete' && (dirty || unmerged);
  return (
    <label
      className={
        'flex items-center gap-2.5 px-2 py-1.5 cursor-pointer select-none ' +
        (checked ? (danger ? 'bg-red-500/10' : 'bg-accent/5') : 'hover:bg-card-strong') +
        (disabled ? ' opacity-50 cursor-not-allowed' : '')
      }
      title={candidate.conv.worktreePath ?? candidate.conv.name}
    >
      <input
        type="checkbox"
        checked={checked}
        onChange={onToggle}
        disabled={disabled}
        className="accent-current flex-shrink-0"
      />
      <span className="text-[11px] text-ink truncate flex-1 min-w-0">
        {candidate.conv.name}
      </span>
      {candidate.conv.hidden && <Tag tone="neutral">archived</Tag>}
      {mode === 'delete' && candidate.ownsWorktree && (
        <>
          {dirty && <Tag tone="amber">{state!.dirtyFiles} dirty</Tag>}
          {unmerged && <Tag tone="amber">{state!.commitsAhead} unmerged</Tag>}
          {state && !state.exists && <Tag tone="neutral">worktree gone</Tag>}
        </>
      )}
      <span className="text-[10px] text-ink-faint flex-shrink-0 w-12 text-right">
        {formatAge(candidate.activeAt)}
      </span>
    </label>
  );
}

function Tag({ children, tone }: { children: React.ReactNode; tone: 'amber' | 'neutral' }) {
  const cls =
    tone === 'amber'
      ? 'bg-amber-500/15 text-amber-300 border-amber-500/30'
      : 'bg-accent/5 text-ink-muted border-accent/30';
  return (
    <span
      className={
        'rounded-full border px-2 py-0.5 text-[10px] font-medium flex-shrink-0 ' + cls
      }
    >
      {children}
    </span>
  );
}
