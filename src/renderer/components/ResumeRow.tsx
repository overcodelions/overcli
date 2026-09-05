// "Resume" — the conversations in this project, offered back on the start
// page so landing here (from Cmd-K, or the sidebar's "+") doesn't mean
// abandoning what you were already doing.
//
// Two states of the same section. At rest it's one line of chips beside
// the composer, costing ~34px and leaving the flow grid where it is. "N
// more" expands it in place to the same 960px breakout the flow panel
// uses when you pick a flow — same gesture, same width, so it doesn't
// read as a new mechanism. With the sidebar hidden it starts expanded,
// because then nothing else on screen gets you back into a conversation.

import { useEffect, useMemo, useState } from 'react';

import type { Conversation } from '@shared/types';
import { useStore } from '../store';
import { useRunningMap } from '../runnersStore';
import { backendColor, shortModel } from '../theme';
import { SidebarMarker } from './SidebarMarker';
import { stamp } from './SidebarStream';
import { isAgentConversation } from './sidebarItems';
import {
  RESUME_GRID_LIMIT,
  RESUME_ROW_LIMIT,
  resumeItems,
  type ResumeItem,
} from './resumeItems';

export function ResumeRow({ conversations }: { conversations: readonly Conversation[] }) {
  const running = useRunningMap();
  const sidebarVisible = useStore((s) => s.sidebarVisible);
  const selectConversation = useStore((s) => s.selectConversation);
  const openSheet = useStore((s) => s.openSheet);

  // `null` follows the sidebar; a click takes it over. Toggling the sidebar
  // clears the override rather than remembering it — folding the grid while
  // the sidebar is hidden is a fine thing to want once, but it must not be
  // the state you come back to with no other way into a conversation.
  const [override, setOverride] = useState<boolean | null>(null);
  useEffect(() => setOverride(null), [sidebarVisible]);
  const expanded = override ?? !sidebarVisible;

  // `useRunningMap` is referentially stable across the event flood, so this
  // only re-sorts when a conversation actually starts, stops, or is touched.
  const items = useMemo(
    () => resumeItems(conversations, running, Date.now()),
    [conversations, running],
  );
  if (items.length === 0) return null;

  const openAll = () => openSheet({ type: 'quickSwitcher', scope: 'chats' });

  if (!expanded) {
    const shown = items.slice(0, RESUME_ROW_LIMIT);
    const rest = items.length - shown.length;
    return (
      <div className="mt-4 flex items-center gap-2.5">
        <span className="text-[10px] uppercase tracking-[0.18em] text-ink-faint flex-shrink-0">
          Resume
        </span>
        <div className="flex items-center gap-1.5 min-w-0 overflow-hidden">
          {shown.map((item) => (
            <ResumeChip key={item.conv.id} item={item} onOpen={selectConversation} />
          ))}
        </div>
        <button
          onClick={() => setOverride(true)}
          className="flex-shrink-0 flex items-center gap-1 rounded-full border border-dashed border-card-strong px-2.5 py-1 text-[10.5px] text-ink-faint hover:text-ink hover:border-card-strong"
        >
          {rest > 0 ? `${rest} more` : 'More'}
          <Chevron down />
        </button>
      </div>
    );
  }

  return (
    <div className="relative left-1/2 -translate-x-1/2 w-[min(60rem,92vw)] mt-5">
      <div className="flex items-baseline gap-3 mb-2">
        <span className="text-[10px] uppercase tracking-[0.22em] text-ink-faint">Resume</span>
        <button onClick={openAll} className="ml-auto text-[10.5px] text-ink-faint hover:text-ink">
          All {items.length} →
        </button>
        <button
          onClick={() => setOverride(false)}
          className="flex items-center gap-1 rounded-full border border-dashed border-card-strong px-2.5 py-1 text-[10.5px] text-ink-faint hover:text-ink"
        >
          Less
          <Chevron />
        </button>
      </div>
      <div className="grid grid-cols-3 gap-2.5">
        {items.slice(0, RESUME_GRID_LIMIT).map((item) => (
          <ResumeCard key={item.conv.id} item={item} onOpen={selectConversation} />
        ))}
      </div>
    </div>
  );
}

function ResumeChip({ item, onOpen }: { item: ResumeItem; onOpen: (id: string) => void }) {
  const { conv, state, at } = item;
  return (
    <button
      onClick={() => onOpen(conv.id)}
      title={conv.name}
      className="flex items-center gap-1.5 max-w-[190px] rounded-full border border-card bg-card/40 px-2.5 py-1 text-[11px] text-ink-muted hover:text-ink hover:border-card-strong transition-colors"
    >
      <SidebarMarker
        color={backendColor(conv.primaryBackend)}
        active={state === 'running'}
        completed={state === 'finished'}
      />
      <span className="truncate">{conv.name}</span>
      {/* A running chip's age would read "1m" forever — the pulsing marker
          already says what's true of it. */}
      {state !== 'running' && (
        <span className="flex-shrink-0 text-[10px] tabular-nums text-ink-faint">{stamp(at)}</span>
      )}
    </button>
  );
}

function ResumeCard({ item, onOpen }: { item: ResumeItem; onOpen: (id: string) => void }) {
  const { conv, state, at } = item;
  return (
    <button
      onClick={() => onOpen(conv.id)}
      title={conv.name}
      className="text-left rounded-xl border border-card bg-card/30 px-3 py-2.5 transition-all duration-150 hover:bg-card/60 hover:border-accent/40"
    >
      <div className="flex items-center gap-2 min-w-0">
        <SidebarMarker
          color={backendColor(conv.primaryBackend)}
          active={state === 'running'}
          completed={state === 'finished'}
        />
        {isAgentConversation(conv) && <span className="text-[10px] text-ink-faint">⎇</span>}
        <span className="flex-1 min-w-0 truncate text-[12.5px] font-semibold text-ink leading-tight">
          {conv.name}
        </span>
        {state !== 'running' && (
          <span className="flex-shrink-0 text-[10px] tabular-nums text-ink-faint">{stamp(at)}</span>
        )}
      </div>
      <div className="mt-1 truncate text-[10.5px] text-ink-faint">{cardNote(item)}</div>
    </button>
  );
}

/// One quiet line under the name. Never a snippet — the transcript isn't
/// loaded for a conversation you haven't opened, and a card that has to
/// read one to render would make this section cost a file read per row.
function cardNote({ conv, state }: ResumeItem): string {
  if (state === 'running') return 'Working…';
  if (state === 'finished') return 'Finished — not opened yet';
  if (conv.branchName) return conv.branchName;
  return shortModel(conv.currentModel) || `${conv.turnCount} turns`;
}

function Chevron({ down = false }: { down?: boolean }) {
  return (
    <svg
      width="9"
      height="9"
      viewBox="0 0 12 12"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={down ? 'M2.5 4.5L6 8l3.5-3.5' : 'M2.5 7.5L6 4l3.5 3.5'} />
    </svg>
  );
}
