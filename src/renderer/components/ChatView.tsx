import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useStore } from '../store';
import { StreamEvent, ToolResultBlock, ToolUseBlock, UUID } from '@shared/types';
import { UserBubble } from './UserBubble';
import { AssistantBubble } from './AssistantBubble';
import { ToolUseCard } from './ToolUseCard';
import { ToolResultCard, AGENT_TOOLS } from './ToolResultCard';
import { PermissionCard } from './PermissionCard';
import { CodexApprovalCard } from './CodexApprovalCard';
import { ReviewCard } from './ReviewCard';
import { PatchApplyCard } from './PatchApplyCard';
import { TurnCaption } from './TurnCaption';
import { SystemNotice } from './SystemNotice';
import { ActivityStrip } from './ActivityStrip';

export function ChatView({ conversationId }: { conversationId: UUID }) {
  const runner = useStore((s) => s.runners[conversationId]);
  const showToolActivity = useStore((s) => s.showToolActivity);
  const events = runner?.events ?? [];
  const isRunning = runner?.isRunning ?? false;
  const activityLabel = runner?.activityLabel ?? '';
  const error = runner?.errorMessage;
  const scrollRef = useRef<HTMLDivElement>(null);
  const wasAtBottomRef = useRef(true);
  const forceFollowRef = useRef(false);
  const prevConversationIdRef = useRef<UUID | null>(null);
  const prevTailRef = useRef<{ id: string; revision: number; type: StreamEvent['kind']['type'] } | null>(null);

  const toolUseIndex = useMemo(() => indexToolUses(events), [events]);
  const toolResultIndex = useMemo(() => indexToolResults(events), [events]);
  const visibleEvents = useMemo(
    () => filterRendered(events, showToolActivity, toolUseIndex),
    [events, showToolActivity, toolUseIndex],
  );
  const reveals = useTransientToolReveals(events, showToolActivity, conversationId);
  const tailEvent = visibleEvents[visibleEvents.length - 1] ?? null;

  const updateBottomState = () => {
    const el = scrollRef.current;
    if (!el) return;
    const slack = 64;
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < slack;
    wasAtBottomRef.current = nearBottom;
    if (!nearBottom) forceFollowRef.current = false;
  };

  // Before every re-render, capture whether we're near the bottom. After
  // paint, if we were, snap back to bottom. Keeps the view following the
  // streaming tail without yanking readers who scrolled up.
  useLayoutEffect(() => {
    updateBottomState();
  });

  useEffect(() => {
    if (prevConversationIdRef.current !== conversationId) {
      prevConversationIdRef.current = conversationId;
      forceFollowRef.current = true;
    }

    const prevTail = prevTailRef.current;
    const nextTail = tailEvent
      ? {
          id: tailEvent.id,
          revision: tailEvent.revision,
          type: tailEvent.kind.type,
        }
      : null;

    const appendedVisibleRow = !!nextTail && (!prevTail || prevTail.id !== nextTail.id);
    if (appendedVisibleRow) {
      forceFollowRef.current = true;
    }

    if ((wasAtBottomRef.current || forceFollowRef.current) && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }

    if (!isRunning) {
      forceFollowRef.current = false;
    }

    prevTailRef.current = nextTail;
  }, [conversationId, isRunning, tailEvent, events.length, runner?.events, reveals.length]);

  return (
    <div className="flex-1 min-h-0 flex flex-col">
      <div
        ref={scrollRef}
        onScroll={updateBottomState}
        className="flex-1 min-h-0 overflow-y-auto px-5 py-4 space-y-3"
      >
        {visibleEvents.length === 0 && !runner?.historyLoading && <EmptyHint />}
        {runner?.historyLoading && <div className="text-xs text-ink-faint">Loading history…</div>}
        {visibleEvents.map((event) => (
          <EventRow
            key={event.id}
            event={event}
            conversationId={conversationId}
            toolUseIndex={toolUseIndex}
            toolResultIndex={toolResultIndex}
          />
        ))}
        {reveals.length > 0 && (
          <div className="flex flex-col gap-1.5">
            {reveals.map((r) => (
              <div key={r.id} className="transient-reveal">
                <ToolUseCard use={r.use} result={toolResultIndex.get(r.id)} />
              </div>
            ))}
          </div>
        )}
        {isRunning && (activityLabel || !showToolActivity) && (
          <ActivityStrip
            label={
              // When tool activity is hidden, the user loses the visible
              // signal of which tool is running — so promote the latest
              // in-flight tool call to the strip. Falls back to whatever
              // generic label the runner set ("Thinking…", "Running
              // tools…") when no tool is currently pending.
              (!showToolActivity && latestPendingToolLabel(events, toolResultIndex)) ||
              activityLabel
            }
          />
        )}
        {error && <SystemNotice text={error} />}
        <div style={{ height: 40 }} />
      </div>
    </div>
  );
}

const EventRow = memo(function EventRow({
  event,
  conversationId,
  toolUseIndex,
  toolResultIndex,
}: {
  event: StreamEvent;
  conversationId: UUID;
  toolUseIndex: Map<string, ToolUseBlock>;
  toolResultIndex: Map<string, ToolResultBlock>;
}) {
  switch (event.kind.type) {
    case 'localUser':
      return <UserBubble text={event.kind.text} attachments={event.kind.attachments} />;
    case 'assistant':
      return <AssistantBubble info={event.kind.info} toolResultIndex={toolResultIndex} />;
    case 'toolResult':
      return <ToolResultCard results={event.kind.results} toolUseIndex={toolUseIndex} />;
    case 'result':
      return <TurnCaption info={event.kind.info} />;
    case 'permissionRequest':
      return <PermissionCard info={event.kind.info} conversationId={conversationId} />;
    case 'codexApproval':
      return <CodexApprovalCard info={event.kind.info} conversationId={conversationId} />;
    case 'patchApply':
      return <PatchApplyCard info={event.kind.info} />;
    case 'reviewResult':
      return <ReviewCard info={event.kind.info} />;
    case 'systemNotice':
      return <SystemNotice text={event.kind.text} />;
    default:
      return null;
  }
});

function EmptyHint() {
  return (
    <div className="text-center text-ink-muted py-12">
      <div className="text-sm">Type a message below to start.</div>
      <div className="text-xs text-ink-faint mt-1">
        Your message is sent to the active agent in this project directory. ⌘⏎ to send.
      </div>
    </div>
  );
}

// Tool names that represent user-blocking interactive prompts. These must
// stay visible even when tool activity is hidden — otherwise the
// conversation deadlocks silently on a question the user can't see.
const INTERACTIVE_TOOLS = new Set(['AskUserQuestion', 'ExitPlanMode']);

// Tool names whose cards stay *fully* visible even when tool activity is
// hidden — edits/writes are the meaningful output of a turn, not noise.
// Keep in sync with the matching list in AssistantBubble.tsx.
export const PERSISTENT_TOOLS = new Set(['Edit', 'MultiEdit', 'Write']);

// Tool names that get a transient flash card while tool activity is
// hidden. These are quick lookups (Read/Grep/Glob/web search) or
// commands (Bash) — suppressing them entirely makes long turns feel
// like nothing is happening, so we surface each one for a moment
// then let it fade out.
const FLASH_TOOLS = new Set([
  'Bash',
  'Read',
  'Grep',
  'Glob',
  'WebFetch',
  'WebSearch',
]);

// Keep in sync with the `transient-reveal` keyframe duration in styles.css.
const REVEAL_MS = 4200;

interface RevealEntry {
  id: string;
  use: ToolUseBlock;
  startedAt: number;
}

/// Watches the event stream for new tool_use blocks of interest and keeps
/// them in a short-lived list. Each entry fades out via CSS and unmounts
/// when its timer expires. Disabled entirely when tool activity is
/// visible (the full card is already in the chat).
///
/// On first run for a given (conversation, toggle) state we mark all
/// existing tool uses as already-processed so opening a conversation
/// with history doesn't flash a backlog of old edits. Only tool uses
/// that arrive *after* that initial pass get flashed.
function useTransientToolReveals(
  events: StreamEvent[],
  showToolActivity: boolean,
  conversationId: UUID,
): RevealEntry[] {
  const [reveals, setReveals] = useState<RevealEntry[]>([]);
  const processedIdsRef = useRef<Set<string>>(new Set());
  const hasInitializedRef = useRef(false);

  useEffect(() => {
    setReveals([]);
    processedIdsRef.current = new Set();
    hasInitializedRef.current = false;
  }, [conversationId, showToolActivity]);

  useEffect(() => {
    if (showToolActivity) return;
    const processed = processedIdsRef.current;
    const firstRun = !hasInitializedRef.current;
    hasInitializedRef.current = true;
    const additions: RevealEntry[] = [];
    for (const ev of events) {
      if (ev.kind.type !== 'assistant') continue;
      for (const use of ev.kind.info.toolUses) {
        if (processed.has(use.id)) continue;
        processed.add(use.id);
        if (firstRun) continue;
        if (!FLASH_TOOLS.has(use.name)) continue;
        additions.push({ id: use.id, use, startedAt: Date.now() });
      }
    }
    if (additions.length) {
      setReveals((prev) => [...prev, ...additions]);
    }
  }, [events, showToolActivity]);

  useEffect(() => {
    if (reveals.length === 0) return;
    const now = Date.now();
    const nextDeadline = Math.min(...reveals.map((r) => r.startedAt + REVEAL_MS - now));
    const wait = Math.max(50, nextDeadline + 30);
    const t = setTimeout(() => {
      const at = Date.now();
      setReveals((prev) => prev.filter((r) => at - r.startedAt < REVEAL_MS));
    }, wait);
    return () => clearTimeout(t);
  }, [reveals]);

  return reveals;
}

// Tool names whose `Result` card is just "I did it" — the tool_use card
// already captured the intent (path, diff, todo list), so the result row
// only clutters the chat. For these we fold the success into the tool_use
// card as a small ✓ and hide the standalone result row. Errors are
// always still rendered separately so they don't get lost.
const CONFIRMATION_TOOLS = new Set([
  'Read',
  'Edit',
  'MultiEdit',
  'Write',
  'TodoWrite',
  'AskUserQuestion',
  'ExitPlanMode',
  // Bash keeps its output but renders it as an expandable section on the
  // same card, so the standalone result row is redundant noise.
  'Bash',
]);

function hasAlwaysVisibleTool(uses: Array<{ name: string }>): boolean {
  return uses.some((u) => INTERACTIVE_TOOLS.has(u.name) || PERSISTENT_TOOLS.has(u.name));
}

function filterRendered(
  events: StreamEvent[],
  showToolActivity: boolean,
  toolUseIndex: Map<string, ToolUseBlock>,
): StreamEvent[] {
  return events.filter((e) => {
    const t = e.kind.type;
    if (
      t === 'rateLimit' ||
      t === 'stderr' ||
      t === 'parseError' ||
      t === 'streamDelta' ||
      t === 'other' ||
      t === 'systemInit'
    )
      return false;
    // Drop standalone `Result` rows whose source tool folds the result
    // into its own card. Errors still pass through — the folded success
    // badge isn't enough signal when something went wrong.
    if (t === 'toolResult') {
      const results = e.kind.results;
      const allFolded = results.every((r) => {
        if (r.isError) return false;
        const src = toolUseIndex.get(r.id);
        return src && CONFIRMATION_TOOLS.has(src.name);
      });
      if (allFolded) return false;
    }
    if (!showToolActivity) {
      if (t === 'toolResult') {
        // Subagent reports are narrative content, not tool noise — keep
        // them so the useful part of an Agent/Task call still surfaces
        // when the user has hidden routine tool activity.
        const anyAgent = e.kind.results.some((r) => {
          const src = toolUseIndex.get(r.id);
          return !!src && AGENT_TOOLS.has(src.name);
        });
        if (!anyAgent) return false;
      }
      if (t === 'assistant') {
        const info = e.kind.info;
        if (
          !info.text.trim() &&
          info.thinking.length === 0 &&
          !info.hasOpaqueReasoning &&
          !hasAlwaysVisibleTool(info.toolUses)
        ) {
          return false;
        }
      }
    }
    return true;
  });
}

/// Friendly short label for the most recently-started tool_use that
/// doesn't have a matching result yet. Rendered in the activity strip
/// when `showToolActivity` is off so the user still sees *something*
/// flicker by as each tool fires.
function latestPendingToolLabel(
  events: StreamEvent[],
  toolResultIndex: Map<string, ToolResultBlock>,
): string | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const ev = events[i];
    if (ev.kind.type !== 'assistant') continue;
    const uses = ev.kind.info.toolUses;
    for (let j = uses.length - 1; j >= 0; j--) {
      const use = uses[j];
      if (toolResultIndex.has(use.id)) continue;
      return shortToolLabel(use);
    }
  }
  return null;
}

function shortToolLabel(use: ToolUseBlock): string {
  const args = safeParse(use.inputJSON);
  const file = use.filePath ?? args.file_path ?? args.path;
  const base = file ? basename(String(file)) : '';
  switch (use.name) {
    case 'Read':
      return base ? `Reading ${base}…` : 'Reading…';
    case 'Edit':
    case 'MultiEdit':
      return base ? `Editing ${base}…` : 'Editing…';
    case 'Write':
      return base ? `Writing ${base}…` : 'Writing…';
    case 'Bash': {
      const cmd = String(args.command ?? '').split('\n')[0].trim().slice(0, 50);
      return cmd ? `Running ${cmd}…` : 'Running command…';
    }
    case 'Grep': {
      const pat = String(args.pattern ?? '').slice(0, 40);
      return pat ? `Searching ${pat}…` : 'Searching…';
    }
    case 'Glob':
      return args.pattern ? `Listing ${String(args.pattern).slice(0, 40)}…` : 'Listing files…';
    case 'WebFetch':
      return args.url ? `Fetching ${String(args.url).slice(0, 50)}…` : 'Fetching…';
    case 'WebSearch':
      return args.query ? `Searching web ${String(args.query).slice(0, 40)}…` : 'Searching web…';
    case 'TodoWrite':
      return 'Updating todos…';
    case 'Agent':
    case 'Task': {
      const desc = String(args.description ?? '').slice(0, 50);
      return desc ? `Agent: ${desc}…` : 'Running subagent…';
    }
    default:
      return `${use.name}…`;
  }
}

function safeParse(json: string): Record<string, any> {
  try {
    const v = JSON.parse(json);
    return v && typeof v === 'object' ? v : {};
  } catch {
    return {};
  }
}

function basename(p: string): string {
  const i = p.lastIndexOf('/');
  return i >= 0 ? p.slice(i + 1) : p;
}

function indexToolUses(events: StreamEvent[]): Map<string, ToolUseBlock> {
  const idx = new Map<string, ToolUseBlock>();
  for (const e of events) {
    if (e.kind.type === 'assistant') {
      for (const u of e.kind.info.toolUses) idx.set(u.id, u);
    }
  }
  return idx;
}

function indexToolResults(events: StreamEvent[]): Map<string, ToolResultBlock> {
  const idx = new Map<string, ToolResultBlock>();
  for (const e of events) {
    if (e.kind.type === 'toolResult') {
      for (const r of e.kind.results) idx.set(r.id, r);
    }
  }
  return idx;
}
