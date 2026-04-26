import { useEffect, useMemo, useRef, useState } from 'react';
import type { Conversation, UUID } from '@shared/types';
import { useStore } from '../../store';
import { useRunnersStore } from '../../runnersStore';

interface PaletteItem {
  conv: Conversation;
  ownerName: string;
  ownerKind: 'project' | 'workspace';
}

export function QuickSwitcherSheet() {
  const projects = useStore((s) => s.projects);
  const workspaces = useStore((s) => s.workspaces);
  // Subscribe to a stable running-IDs string (not the whole runners
  // object) so token-by-token runner updates don't re-render the
  // launcher while the user is typing.
  const runningKey = useRunnersStore((s) => {
    const ids: string[] = [];
    for (const id in s.runners) if (s.runners[id]?.isRunning) ids.push(id);
    ids.sort();
    return ids.join(',');
  });
  const runningIds = useMemo(
    () => new Set(runningKey ? runningKey.split(',') : []),
    [runningKey],
  );
  const lastSelectedAt = useStore((s) => s.lastSelectedAt);
  const selectedConversationId = useStore((s) => s.selectedConversationId);
  const selectConversation = useStore((s) => s.selectConversation);
  const openSheet = useStore((s) => s.openSheet);
  const renameConversation = useStore((s) => s.renameConversation);
  const setConversationHidden = useStore((s) => s.setConversationHidden);

  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState(0);
  const [renamingId, setRenamingId] = useState<UUID | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const searchRef = useRef<HTMLInputElement>(null);

  const items: PaletteItem[] = useMemo(() => {
    const out: PaletteItem[] = [];
    for (const p of projects) {
      for (const c of p.conversations) {
        if (c.hidden) continue;
        out.push({ conv: c, ownerName: p.name, ownerKind: 'project' });
      }
    }
    for (const w of workspaces) {
      for (const c of w.conversations ?? []) {
        if (c.hidden) continue;
        out.push({ conv: c, ownerName: w.name, ownerKind: 'workspace' });
      }
    }
    // Running first, then everything else; recency breaks ties on each side.
    out.sort((a, b) => {
      const ar = runningIds.has(a.conv.id) ? 1 : 0;
      const br = runningIds.has(b.conv.id) ? 1 : 0;
      if (ar !== br) return br - ar;
      return recency(b.conv, lastSelectedAt) - recency(a.conv, lastSelectedAt);
    });
    return out;
  }, [projects, workspaces, lastSelectedAt, runningIds]);

  const filtered = useMemo(() => rankPalette(items, query), [items, query]);

  // Preselect the top item (running first, then most recent). If the
  // user is already on that top item, fall through to index 1 so ↵
  // still goes somewhere useful.
  useEffect(() => {
    if (!query && selectedConversationId && filtered[0]?.conv.id === selectedConversationId && filtered.length > 1) {
      setSelected(1);
      return;
    }
    setSelected(0);
  }, [query, selectedConversationId, filtered]);

  const commit = (id: UUID) => {
    selectConversation(id);
    openSheet(null);
  };

  const startRename = (item: PaletteItem) => {
    setRenamingId(item.conv.id);
    setRenameValue(item.conv.name);
  };

  const commitRename = async () => {
    if (!renamingId) return;
    const name = renameValue.trim();
    if (name) await renameConversation(renamingId, name);
    setRenamingId(null);
    setRenameValue('');
    searchRef.current?.focus();
  };

  const cancelRename = () => {
    setRenamingId(null);
    setRenameValue('');
    searchRef.current?.focus();
  };

  const archiveSelected = async (item: PaletteItem) => {
    await setConversationHidden(item.conv.id, true);
  };

  const deleteSelected = (item: PaletteItem) => {
    openSheet({ type: 'archiveConversation', convId: item.conv.id });
  };

  const onSearchKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (renamingId) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setSelected((s) => Math.min(filtered.length - 1, s + 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setSelected((s) => Math.max(0, s - 1));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const pick = filtered[selected];
      if (pick) commit(pick.conv.id);
    } else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'r') {
      e.preventDefault();
      const pick = filtered[selected];
      if (pick) startRename(pick);
    } else if ((e.metaKey || e.ctrlKey) && e.key === 'Backspace') {
      e.preventDefault();
      const pick = filtered[selected];
      if (!pick) return;
      if (e.shiftKey) deleteSelected(pick);
      else void archiveSelected(pick);
    }
  };

  return (
    <div className="flex flex-col max-h-[70vh]">
      <input
        ref={searchRef}
        autoFocus
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={onSearchKey}
        placeholder="Jump to conversation…"
        className="bg-transparent px-5 py-3 border-b border-card text-sm outline-none"
      />
      <div className="overflow-y-auto min-h-[240px]">
        {filtered.length === 0 ? (
          <div className="px-5 py-3 text-xs text-ink-faint">No matching conversations.</div>
        ) : (
          filtered.map((item, i) => {
            const running = runningIds.has(item.conv.id);
            const isSelected = i === selected;
            const isRenaming = renamingId === item.conv.id;
            return (
              <div
                key={item.conv.id}
                onMouseEnter={() => setSelected(i)}
                className={
                  'group flex items-center gap-2 px-5 py-2 cursor-pointer ' +
                  (isSelected ? 'bg-accent/20 text-ink' : 'text-ink-muted hover:bg-card-strong')
                }
                onClick={() => {
                  if (!isRenaming) commit(item.conv.id);
                }}
              >
                <div className="flex-1 min-w-0">
                  {isRenaming ? (
                    <input
                      autoFocus
                      value={renameValue}
                      onChange={(e) => setRenameValue(e.target.value)}
                      onClick={(e) => e.stopPropagation()}
                      onKeyDown={(e) => {
                        e.stopPropagation();
                        if (e.key === 'Enter') {
                          e.preventDefault();
                          void commitRename();
                        } else if (e.key === 'Escape') {
                          e.preventDefault();
                          cancelRename();
                        }
                      }}
                      className="w-full bg-transparent border border-accent rounded px-1 py-0.5 text-sm outline-none"
                    />
                  ) : (
                    <div className="text-sm truncate flex items-center gap-2">
                      {running && (
                        <span className="h-2 w-2 rounded-full bg-emerald-400 shadow-[0_0_4px_rgba(74,222,128,0.7)] flex-shrink-0" />
                      )}
                      <span className="truncate">{item.conv.name}</span>
                    </div>
                  )}
                  <div className="text-[10px] text-ink-faint truncate">
                    {item.ownerKind === 'workspace' ? '· workspace · ' : ''}
                    {item.ownerName}
                  </div>
                </div>
                {!isRenaming && (
                  <div className="hidden group-hover:flex items-center gap-1 text-[10px] text-ink-faint">
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        startRename(item);
                      }}
                      className="px-1.5 py-0.5 rounded hover:bg-card-strong"
                    >
                      Rename
                    </button>
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        void archiveSelected(item);
                      }}
                      className="px-1.5 py-0.5 rounded hover:bg-card-strong"
                    >
                      Archive
                    </button>
                  </div>
                )}
              </div>
            );
          })
        )}
      </div>
      <div className="border-t border-card px-5 py-2 flex gap-3 text-[10px] text-ink-faint">
        <span><kbd className="font-mono">↵</kbd> open</span>
        <span><kbd className="font-mono">⌘R</kbd> rename</span>
        <span><kbd className="font-mono">⌘⌫</kbd> archive</span>
        <span><kbd className="font-mono">⌘⇧⌫</kbd> delete</span>
      </div>
    </div>
  );
}

function recency(conv: Conversation, mru: Record<UUID, number>): number {
  return mru[conv.id] ?? conv.lastActiveAt ?? conv.createdAt ?? 0;
}

function rankPalette(items: PaletteItem[], query: string): PaletteItem[] {
  if (!query.trim()) return items.slice(0, 60);
  const q = query.toLowerCase();
  const scored: Array<[PaletteItem, number]> = [];
  for (const item of items) {
    const name = item.conv.name.toLowerCase();
    const owner = item.ownerName.toLowerCase();
    let score = 0;
    if (name === q) score = 1000;
    else if (name.startsWith(q)) score = 500 - name.length;
    else if (name.includes(q)) score = 300 - name.length;
    else if (owner.includes(q)) score = 100 - owner.length;
    else continue;
    scored.push([item, score]);
  }
  scored.sort((a, b) => b[1] - a[1]);
  return scored.slice(0, 60).map((x) => x[0]);
}
