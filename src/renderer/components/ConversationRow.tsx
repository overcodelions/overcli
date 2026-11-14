// One conversation in the sidebar, wherever the sidebar happens to be
// arranged that way.
//
// In its own file for the same reason SidebarMarker is: both layouts render
// it — the Projects tree from Sidebar.tsx and the Stream from
// SidebarStream.tsx — and having the stream import it from Sidebar would form
// a cycle. Sharing the component rather than reimplementing it is also what
// keeps the archive affordance, the agent glyph and the running marker
// identical in both layouts instead of drifting apart.

import { useState, type ReactNode } from 'react';

import type { Conversation } from '@shared/types';
import { useStore } from '../store';
import { useRunnerCompletedAt, useRunnerIsRunning } from '../runnersStore';
import { backendColor } from '../theme';
import { isAgentConversation } from './sidebarItems';
import { SidebarMarker } from './SidebarMarker';

export function ConversationRow({
  conv,
  selected,
  onClick,
  tail,
}: {
  conv: Conversation;
  selected: boolean;
  onClick: () => void;
  /// What the row says about itself on the right — a momentum meter or a
  /// timestamp in the Stream layout, nothing in the tree, where position
  /// under a project already carries that meaning.
  ///
  /// Hidden on hover so it never fights the archive button for the same few
  /// pixels: at rest the row reports, on hover it offers an action.
  tail?: ReactNode;
}) {
  const bgColor = backendColor(conv.primaryBackend);
  const isRunning = useRunnerIsRunning(conv.id);
  const completedAt = useRunnerCompletedAt(conv.id);
  const completed = !isRunning && !!completedAt;
  const openSheet = useStore((s) => s.openSheet);
  const isAgent = isAgentConversation(conv);
  const renameConversation = useStore((s) => s.renameConversation);
  const resetConversationName = useStore((s) => s.resetConversationName);
  const autoNaming = useStore((s) => s.settings.autoNameConversations !== false);
  const [renameValue, setRenameValue] = useState<string | null>(null);

  // Enter or blur commits, Escape backs out. A typed name is yours and
  // sticks; clearing the field hands naming back to the conversation (the
  // same "empty clears the custom title" rule flow runs use).
  const commitRename = () => {
    const next = (renameValue ?? '').trim();
    setRenameValue(null);
    if (next) {
      if (next !== conv.name) void renameConversation(conv.id, next);
    } else if (autoNaming && conv.nameSource !== 'auto') {
      void resetConversationName(conv.id);
    }
  };

  const onClose = (e: React.MouseEvent) => {
    e.stopPropagation();
    openSheet({ type: 'archiveConversation', convId: conv.id });
  };

  return (
    <div
      data-flip={conv.id}
      className={
        'sidebar-row group w-full rounded text-xs truncate flex items-center gap-1.5 pr-1 ' +
        (selected
          ? 'sidebar-row-selected text-ink'
          : 'text-ink-muted hover:bg-card-strong hover:text-ink hover:border-card')
      }
      title={
        conv.nameSource === 'auto' && conv.previousName
          ? `${conv.name}\nNamed from the conversation — was “${conv.previousName}”`
          : conv.name
      }
    >
      {renameValue !== null ? (
        <input
          autoFocus
          value={renameValue}
          onChange={(e) => setRenameValue(e.target.value)}
          onFocus={(e) => e.currentTarget.select()}
          onBlur={commitRename}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === 'Enter') {
              e.preventDefault();
              commitRename();
            } else if (e.key === 'Escape') {
              e.preventDefault();
              setRenameValue(null);
            }
          }}
          placeholder={autoNaming ? 'Leave empty to name it from the chat' : conv.name}
          aria-label="Conversation name"
          className="flex-1 min-w-0 mx-1 my-0.5 rounded border border-accent bg-transparent px-1.5 py-0.5 text-xs text-ink outline-none"
        />
      ) : (
        <>
          <button
            onClick={onClick}
            onDoubleClick={() => setRenameValue(conv.name)}
            className="flex items-center gap-1.5 flex-1 min-w-0 text-left px-2 py-1"
          >
            <SidebarMarker color={bgColor} active={isRunning} completed={completed} />
            {isAgent && <span className="text-[10px] text-ink-faint">⎇</span>}
            {/* Keyed on the name so a fresh auto-title replays the fade once.
            Only a title from the last few seconds animates, so launching the
            app or scrolling a row back into view doesn't. */}
            <span
              key={conv.name}
              className={
                'truncate flex-1 ' +
                (selected ? 'font-medium ' : '') +
                (conv.nameSource === 'auto' && conv.autoNamedAt && Date.now() - conv.autoNamedAt < 8000
                  ? 'conversation-renamed'
                  : '')
              }
            >
              {conv.name}
            </span>
            {tail && <span className="flex-shrink-0 group-hover:hidden">{tail}</span>}
          </button>
          <button
            onClick={(e) => {
              e.stopPropagation();
              setRenameValue(conv.name);
            }}
            className={
              'w-4 h-4 items-center justify-center text-[10px] text-ink-faint hover:text-ink rounded transition-opacity ' +
              (selected ? 'flex opacity-70 hover:opacity-100' : 'hidden group-hover:flex')
            }
            title="Rename (double-click the name works too)"
            aria-label="Rename conversation"
          >
            ✎
          </button>
          <button
            onClick={onClose}
            className={
              'w-4 h-4 items-center justify-center text-[11px] text-ink-faint hover:text-red-400 rounded transition-opacity ' +
              (selected ? 'flex opacity-70 hover:opacity-100' : 'hidden group-hover:flex')
            }
            title={isAgent ? 'Archive or delete agent…' : 'Archive or delete conversation…'}
          >
            ×
          </button>
        </>
      )}
    </div>
  );
}
