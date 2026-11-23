// The tab strip above the chat: the conversations and flow runs you're
// working on now.
//
// Each tab says whether its conversation is working, waiting on you or has
// finished something you haven't looked at, so the strip answers "what
// needs me" without opening anything. Click to switch, middle-click or ×
// to close, drag to reorder, right-click to open beside the current chat
// or in a window of its own. Hidden until there are two tabs: one tab is
// just the chat you're in.

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { UUID } from '@shared/types';
import { useStore } from '../store';
import { useRunner } from '../runnersStore';
import { useConversation } from '../hooks';
import { backendColor } from '../theme';
import { SidebarMarker } from './SidebarMarker';
import { FlowMonogram } from './flows/FlowMonogram';
import { useFlowsStore } from '../flowsStore';
import { parseTabKey, runTabKey } from '../conversationTabs';
import { flowRunTitle } from '@shared/flows/schema';

export function ConversationTabStrip() {
  const tabs = useStore((s) => s.conversationTabs);
  // The tab on screen: the open run while in Flows, else the conversation.
  const selectedConversation = useStore((s) => s.selectedConversationId);
  const inFlows = useStore((s) => s.detailMode === 'flows');
  const activeRunId = useFlowsStore((s) => s.activeRunId);
  const selected = inFlows ? (activeRunId ? runTabKey(activeRunId) : null) : selectedConversation;
  const split = useStore((s) => s.splitConversationId);
  const [dragging, setDragging] = useState<string | null>(null);
  const stripRef = useRef<HTMLDivElement>(null);
  // What is cut off at each end, so the strip can say so: faded edges, the
  // scroll buttons, and how many the overflow list holds that you can't see.
  const [edges, setEdges] = useState({ left: false, right: false, hidden: 0 });
  const [listOpen, setListOpen] = useState(false);

  const measure = useCallback(() => {
    const el = stripRef.current;
    if (!el) return;
    const left = el.scrollLeft > 1;
    const right = el.scrollLeft + el.clientWidth < el.scrollWidth - 1;
    const box = el.getBoundingClientRect();
    let hidden = 0;
    for (const tab of el.querySelectorAll<HTMLElement>('[data-tab]')) {
      const r = tab.getBoundingClientRect();
      if (r.left < box.left - 1 || r.right > box.right + 1) hidden += 1;
    }
    setEdges((prev) =>
      prev.left === left && prev.right === right && prev.hidden === hidden ? prev : { left, right, hidden },
    );
  }, []);

  useEffect(() => {
    const el = stripRef.current;
    if (!el) return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [measure, tabs.length >= 2]);

  // Keep the tab on screen in view when the strip scrolls.
  useLayoutEffect(() => {
    if (selected) {
      const el = stripRef.current?.querySelector<HTMLElement>(`[data-tab="${CSS.escape(selected)}"]`);
      el?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    }
    measure();
  }, [selected, tabs, measure]);

  const scrollBy = (dir: 1 | -1) => {
    const el = stripRef.current;
    if (el) el.scrollBy({ left: dir * el.clientWidth * 0.7, behavior: 'smooth' });
  };

  if (tabs.length < 2) return null;
  const overflowing = edges.left || edges.right;
  return (
    <div className="relative flex h-8 flex-shrink-0 items-stretch border-b border-card bg-surface-muted">
      {overflowing && (
        <StripButton label="Scroll tabs left" disabled={!edges.left} onClick={() => scrollBy(-1)}>
          ‹
        </StripButton>
      )}
      <div className="relative flex min-w-0 flex-1">
        <div
          ref={stripRef}
          role="tablist"
          aria-label="Open conversations"
          className="flex min-w-0 flex-1 items-stretch overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
          onScroll={measure}
          // A mouse wheel only scrolls vertically; turn that into sideways
          // movement here, where there is nothing to scroll up or down.
          onWheel={(e) => {
            if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) e.currentTarget.scrollLeft += e.deltaY;
          }}
          onDragOver={(e) => {
            if (dragging) e.preventDefault();
          }}
          onDrop={(e) => {
            // Dropped past the last tab: move to the end.
            if (!dragging || e.target !== e.currentTarget) return;
            useStore.getState().moveConversationTab(dragging, null);
            setDragging(null);
          }}
        >
          {tabs.map((id) => (
            <ConversationTab
              key={id}
              id={id}
              active={id === selected}
              beside={id === split}
              dragging={dragging}
              onDragStart={() => setDragging(id)}
              onDragEnd={() => setDragging(null)}
            />
          ))}
        </div>
        {/* Faded edges: there is more this way. */}
        {edges.left && (
          <div className="pointer-events-none absolute inset-y-0 left-0 w-8 bg-gradient-to-r from-surface-muted to-transparent" />
        )}
        {edges.right && (
          <div className="pointer-events-none absolute inset-y-0 right-0 w-8 bg-gradient-to-l from-surface-muted to-transparent" />
        )}
      </div>
      {overflowing && (
        <StripButton label="Scroll tabs right" disabled={!edges.right} onClick={() => scrollBy(1)}>
          ›
        </StripButton>
      )}
      {overflowing && (
        <div className="relative flex border-l border-card">
          <button
            onClick={() => setListOpen((o) => !o)}
            aria-label={`All open conversations (${tabs.length})`}
            title={`All open conversations (${tabs.length})`}
            className={
              'flex items-center gap-1 px-2 text-[11px] hover:bg-card-strong hover:text-ink ' +
              (listOpen ? 'bg-card-strong text-ink' : 'text-ink-muted')
            }
          >
            {edges.hidden > 0 ? `${edges.hidden} more` : tabs.length}
            <span className="text-[9px]">▾</span>
          </button>
          {listOpen && <TabList tabs={tabs} selected={selected} onClose={() => setListOpen(false)} />}
        </div>
      )}
    </div>
  );
}

function StripButton({
  label,
  disabled,
  onClick,
  children,
}: {
  label: string;
  disabled: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      title={label}
      className="flex w-6 flex-shrink-0 items-center justify-center text-sm text-ink-muted hover:bg-card-strong hover:text-ink disabled:opacity-30 disabled:hover:bg-transparent"
    >
      {children}
    </button>
  );
}

/// Every open tab in one list — the way to reach the ones scrolled off.
function TabList({ tabs, selected, onClose }: { tabs: string[]; selected: string | null; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.parentElement?.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [onClose]);
  return (
    <div
      ref={ref}
      role="menu"
      className="absolute right-0 top-full z-50 mt-1 max-h-[60vh] w-[280px] overflow-y-auto rounded-lg border border-card-strong bg-surface-elevated py-1 text-xs shadow-xl"
    >
      {tabs.map((id) => (
        <TabListRow
          key={id}
          id={id}
          active={id === selected}
          onPick={() => {
            onClose();
            useStore.getState().activateTab(id);
          }}
        />
      ))}
    </div>
  );
}

function TabListRow({ id, active, onPick }: { id: string; active: boolean; onPick: () => void }) {
  const info = useTabInfo(id);
  if (info.missing && info.kind === 'conversation') return null;
  return (
    <div className="group flex items-center pr-1 hover:bg-card-strong">
      <button
        role="menuitem"
        onClick={onPick}
        className={
          'flex min-w-0 flex-1 items-center gap-1.5 px-3 py-1.5 text-left ' +
          (active ? 'font-medium text-ink' : 'text-ink-muted group-hover:text-ink')
        }
      >
        {info.marker}
        <span className="truncate">{info.name}</span>
      </button>
      <button
        onClick={() => useStore.getState().closeConversationTab(id)}
        aria-label={`Close ${info.name}`}
        className="flex h-4 w-4 flex-shrink-0 items-center justify-center rounded text-[11px] text-ink-faint opacity-0 hover:text-ink group-hover:opacity-70"
      >
        ×
      </button>
    </div>
  );
}

/// What a tab shows, for either kind of tab: its name, the marker, and
/// whether it's working, waiting on you or done.
interface TabInfo {
  kind: 'conversation' | 'run';
  /// The thing the tab names is gone (or, for a run, not loaded yet).
  missing: boolean;
  name: string;
  marker: React.ReactNode;
  status: string | null;
}

function useTabInfo(key: string): TabInfo {
  const tab = parseTabKey(key);
  const convId = tab.kind === 'conversation' ? tab.id : null;
  const conv = useConversation(convId);
  const runner = useRunner(convId);
  const run = useFlowsStore((s) => (tab.kind === 'run' ? s.runs[tab.id] : undefined));

  if (tab.kind === 'run') {
    if (!run) return { kind: 'run', missing: true, name: 'Flow run', marker: null, status: null };
    const state = run.state.kind;
    const live = state === 'running' || state === 'watching';
    const waiting = state === 'paused';
    return {
      kind: 'run',
      missing: false,
      name: flowRunTitle(run),
      marker: waiting ? <WaitingDot /> : <FlowMonogram name={run.flowSnapshot.name} size="xs" live={live} />,
      status: waiting ? 'paused, waiting on you' : live ? 'running' : state === 'done' ? 'finished' : null,
    };
  }
  if (!conv) return { kind: 'conversation', missing: true, name: '', marker: null, status: null };
  const isRunning = runner?.isRunning ?? false;
  const completed = !isRunning && !!runner?.completedAt;
  const waiting = isRunning && awaitingYou(runner?.events);
  return {
    kind: 'conversation',
    missing: false,
    name: conv.name,
    marker: waiting ? (
      <WaitingDot />
    ) : (
      <SidebarMarker color={backendColor(conv.primaryBackend)} active={isRunning} completed={completed} />
    ),
    status: waiting ? 'waiting on you' : isRunning ? 'working' : completed ? 'finished' : null,
  };
}

function WaitingDot() {
  return (
    <span className="flex h-4 w-4 flex-shrink-0 items-center justify-center" aria-label="Waiting on you">
      <span className="h-2 w-2 rounded-full bg-amber-500" />
    </span>
  );
}

function ConversationTab({
  id,
  active,
  beside,
  dragging,
  onDragStart,
  onDragEnd,
}: {
  id: string;
  active: boolean;
  beside: boolean;
  dragging: string | null;
  onDragStart: () => void;
  onDragEnd: () => void;
}) {
  const info = useTabInfo(id);
  const poppedOut = useStore((s) => s.poppedOutConversationIds.includes(id));
  const [menuAt, setMenuAt] = useState<{ x: number; y: number } | null>(null);
  const [dropHere, setDropHere] = useState(false);
  // A deleted conversation leaves the strip via the store; this only covers
  // the moment in between. A run that hasn't loaded still shows, as a
  // placeholder you can close.
  if (info.missing && info.kind === 'conversation') return null;

  const close = () => useStore.getState().closeConversationTab(id);
  const closeItems = [
    { label: 'Close tab', run: close },
    { label: 'Close other tabs', run: () => useStore.getState().closeOtherConversationTabs(id) },
  ];

  return (
    <div
      data-tab={id}
      role="tab"
      aria-selected={active}
      draggable
      onDragStart={(e) => {
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', info.name);
        onDragStart();
      }}
      onDragEnd={onDragEnd}
      onDragOver={(e) => {
        if (!dragging || dragging === id) return;
        e.preventDefault();
        setDropHere(true);
      }}
      onDragLeave={() => setDropHere(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDropHere(false);
        if (dragging && dragging !== id) useStore.getState().moveConversationTab(dragging, id);
      }}
      onClick={() => useStore.getState().activateTab(id)}
      onAuxClick={(e) => {
        if (e.button === 1) {
          e.preventDefault();
          close();
        }
      }}
      onContextMenu={(e) => {
        e.preventDefault();
        setMenuAt({ x: e.clientX, y: e.clientY });
      }}
      title={`${info.kind === 'run' ? 'Flow run: ' : ''}${info.name}${info.status ? ` — ${info.status}` : ''}${beside ? ' · open beside' : ''}${poppedOut ? ' · in its own window' : ''}`}
      className={
        'group relative flex min-w-[120px] max-w-[220px] flex-shrink-0 cursor-default select-none items-center gap-1.5 border-r border-card pl-2.5 pr-1 text-xs ' +
        (active
          ? 'bg-surface text-ink'
          : beside
            ? 'bg-surface/60 text-ink'
            : 'text-ink-muted hover:bg-card-strong/60 hover:text-ink') +
        (dropHere ? ' border-l-2 border-l-accent' : '')
      }
    >
      {active && <span className="absolute inset-x-0 top-0 h-[2px] bg-accent" aria-hidden />}
      {info.marker}
      <span className={'flex-1 truncate ' + (active ? 'font-medium' : '') + (info.missing ? ' italic text-ink-faint' : '')}>
        {info.name}
      </span>
      {poppedOut && (
        <span className="flex-shrink-0 text-[10px] text-ink-faint" aria-label="In its own window">
          ↗
        </span>
      )}
      {beside && !poppedOut && (
        <span className="flex-shrink-0 text-[10px] text-ink-faint" aria-label="Open beside">
          ◫
        </span>
      )}
      <button
        onClick={(e) => {
          e.stopPropagation();
          close();
        }}
        aria-label={`Close ${info.name}`}
        title="Close tab (middle-click works too)"
        className={
          'flex h-4 w-4 flex-shrink-0 items-center justify-center rounded text-[11px] text-ink-faint hover:bg-card-strong hover:text-ink ' +
          (active ? 'opacity-70' : 'opacity-0 group-hover:opacity-70')
        }
      >
        ×
      </button>
      {menuAt &&
        (info.kind === 'conversation' ? (
          <ConversationContextMenu id={id} at={menuAt} onClose={() => setMenuAt(null)} extra={closeItems} />
        ) : (
          <MenuAt
            at={menuAt}
            onClose={() => setMenuAt(null)}
            items={[...(active ? [] : [{ label: 'Open', run: () => useStore.getState().activateTab(id) }]), ...closeItems]}
          />
        ))}
    </div>
  );
}

/// A turn that has stopped to ask: a permission prompt, an approval or a
/// question as the newest thing in the transcript while it's still running.
function awaitingYou(events: readonly { kind: { type: string } }[] | undefined): boolean {
  const last = events?.[events.length - 1];
  if (!last) return false;
  const t = last.kind.type;
  return t === 'permissionRequest' || t === 'codexApproval' || t === 'userInputRequest';
}

/// A right-click menu at the pointer: portalled (the tab strip scrolls and
/// sidebar rows animate with transforms, either of which would clip or
/// shift a fixed menu) and kept inside the window.
function MenuAt({
  at,
  onClose,
  items,
}: {
  at: { x: number; y: number };
  onClose: () => void;
  items: (ConversationMenuItem | 'sep')[];
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState(at);
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [onClose]);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    setPos({
      x: Math.min(at.x, window.innerWidth - r.width - 8),
      y: Math.min(at.y, window.innerHeight - r.height - 8),
    });
  }, [at]);
  return createPortal(
    <div
      ref={ref}
      role="menu"
      style={{ left: pos.x, top: pos.y }}
      onClick={(e) => e.stopPropagation()}
      className="fixed z-50 min-w-[200px] rounded-lg border border-card-strong bg-surface-elevated py-1 text-xs shadow-xl"
    >
      {items.map((item, i) =>
        item === 'sep' ? (
          <div key={`sep-${i}`} className="my-1 border-t border-card" />
        ) : (
          <button
            key={item.label}
            role="menuitem"
            onClick={() => {
              onClose();
              item.run();
            }}
            className="w-full px-3 py-1.5 text-left text-ink-muted hover:bg-card-strong hover:text-ink"
          >
            {item.label}
          </button>
        ),
      )}
    </div>,
    document.body,
  );
}

export interface ConversationMenuItem {
  label: string;
  run: () => void;
}

/// Right-click actions for a conversation, shared by the tab strip and the
/// sidebar: open it, open it beside the current one, or in its own window.
export function ConversationContextMenu({
  id,
  at,
  onClose,
  extra = [],
}: {
  id: UUID;
  at: { x: number; y: number };
  onClose: () => void;
  extra?: ConversationMenuItem[];
}) {
  const selected = useStore((s) => s.selectedConversationId);
  const split = useStore((s) => s.splitConversationId);
  const poppedOut = useStore((s) => s.poppedOutConversationIds.includes(id));

  const store = useStore.getState();
  const items: (ConversationMenuItem | 'sep')[] = [];
  if (id !== selected) items.push({ label: 'Open', run: () => store.selectConversation(id) });
  if (poppedOut) {
    items.push({ label: 'Show its window', run: () => void store.popOutConversation(id) });
    items.push({ label: 'Put back in the main window', run: () => store.popInConversation(id) });
  } else {
    if (id !== selected && id !== split) {
      items.push({ label: 'Open to the side', run: () => store.openConversationToSide(id) });
    }
    if (id === split) items.push({ label: 'Close the side view', run: () => store.closeSplit() });
    items.push({ label: 'Open in new window', run: () => void store.popOutConversation(id) });
  }
  if (extra.length) items.push('sep', ...extra);
  return <MenuAt at={at} onClose={onClose} items={items} />;
}
