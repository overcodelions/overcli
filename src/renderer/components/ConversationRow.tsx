// One conversation in the sidebar, wherever the sidebar happens to be
// arranged that way.
//
// In its own file for the same reason SidebarMarker is: both layouts render
// it — the Projects tree from Sidebar.tsx and the Stream from
// SidebarStream.tsx — and having the stream import it from Sidebar would form
// a cycle. Sharing the component rather than reimplementing it is also what
// keeps the archive affordance, the agent glyph and the running marker
// identical in both layouts instead of drifting apart.

import type { ReactNode } from 'react';

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

  const onClose = (e: React.MouseEvent) => {
    e.stopPropagation();
    openSheet({ type: 'archiveConversation', convId: conv.id });
  };

  return (
    <div
      className={
        'sidebar-row group w-full rounded text-xs truncate flex items-center gap-1.5 pr-1 ' +
        (selected
          ? 'sidebar-row-selected text-ink'
          : 'text-ink-muted hover:bg-card-strong hover:text-ink hover:border-card')
      }
      title={conv.name}
    >
      <button onClick={onClick} className="flex items-center gap-1.5 flex-1 min-w-0 text-left px-2 py-1">
        <SidebarMarker color={bgColor} active={isRunning} completed={completed} />
        {isAgent && <span className="text-[10px] text-ink-faint">⎇</span>}
        <span className={'truncate flex-1 ' + (selected ? 'font-medium' : '')}>{conv.name}</span>
        {tail && (
          <span className="flex-shrink-0 transition-opacity group-hover:opacity-0">{tail}</span>
        )}
      </button>
      <button
        onClick={onClose}
        className={
          'w-4 h-4 flex items-center justify-center text-[11px] text-ink-faint hover:text-red-400 rounded transition-opacity ' +
          (selected ? 'opacity-70 hover:opacity-100' : 'opacity-0 group-hover:opacity-100')
        }
        title={isAgent ? 'Archive or delete agent…' : 'Archive or delete conversation…'}
      >
        ×
      </button>
    </div>
  );
}
