import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useStore } from '../store';
import { Conversation, StreamEvent, ToolResultBlock, ToolUseBlock, UUID } from '@shared/types';
import { UserBubble } from './UserBubble';
import { AssistantBubble } from './AssistantBubble';
import { ToolUseCard } from './ToolUseCard';
import { ToolResultCard, AGENT_TOOLS } from './ToolResultCard';
import { PermissionCard } from './PermissionCard';
import { CodexApprovalCard } from './CodexApprovalCard';
import { UserInputRequestCard } from './UserInputRequestCard';
import { ReviewCard } from './ReviewCard';
import { PatchApplyCard } from './PatchApplyCard';
import { TurnCaption } from './TurnCaption';
import { SystemNotice } from './SystemNotice';
import { MetaReminder } from './MetaReminder';
import { ActivityStrip } from './ActivityStrip';
import { useConversation } from '../hooks';

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
  const currentReveal = useLatestToolReveal(events, toolResultIndex, showToolActivity, conversationId);
  const pendingSubagents = useMemo(
    () => countPendingSubagents(events, toolResultIndex),
    [events, toolResultIndex],
  );
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
  }, [conversationId, isRunning, tailEvent, events.length, runner?.events, currentReveal?.id]);

  return (
    <div className="flex-1 min-h-0 flex flex-col">
      <div
        ref={scrollRef}
        onScroll={updateBottomState}
        className="flex-1 min-h-0 overflow-y-auto px-5 py-4 space-y-3"
      >
        {visibleEvents.length === 0 && !runner?.historyLoading && !runner?.isRunning && (
          <NewAgentIntro conversationId={conversationId} />
        )}
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
        {currentReveal && (
          <div key={currentReveal.id} className="transient-slot">
            <ToolUseCard use={currentReveal} result={toolResultIndex.get(currentReveal.id)} />
          </div>
        )}
        {isRunning && (activityLabel || !showToolActivity || pendingSubagents > 0) && (
          <ActivityStrip
            label={withSubagentSuffix(
              // When tool activity is hidden, the user loses the visible
              // signal of which tool is running — so promote the latest
              // in-flight tool call to the strip. Falls back to whatever
              // generic label the runner set ("Thinking…", "Running
              // tools…") when no tool is currently pending.
              (!showToolActivity && latestPendingToolLabel(events, toolResultIndex)) ||
                activityLabel,
              pendingSubagents,
            )}
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
    case 'userInputRequest':
      return <UserInputRequestCard info={event.kind.info} conversationId={conversationId} />;
    case 'patchApply':
      return <PatchApplyCard info={event.kind.info} />;
    case 'reviewResult':
      return <ReviewCard info={event.kind.info} />;
    case 'systemNotice':
      return <SystemNotice text={event.kind.text} />;
    case 'metaReminder':
      return <MetaReminder text={event.kind.text} />;
    default:
      return null;
  }
});

function NewAgentIntro({ conversationId }: { conversationId: UUID }) {
  const conv = useConversation(conversationId);
  if (!conv) return null;
  const intro = introCopy(conv);
  return (
    <div className="flex flex-col items-center text-center justify-end min-h-full pb-6 gap-4">
      <AgentSparkIcon />
      <div className="max-w-[520px]">
        <div className="text-base font-semibold text-ink">{intro.heading}</div>
        {intro.sub && (
          <div className="text-sm text-ink-muted mt-1.5">{intro.sub}</div>
        )}
      </div>
      <IntroPills conv={conv} />
      <div className="flex flex-col items-center gap-1.5 mt-1">
        <div className="text-[11px] text-ink-faint">
          ⌘⏎ to send · @ to reference files
        </div>
        <IntroTether />
      </div>
    </div>
  );
}

function IntroTether() {
  return (
    <svg
      width="14"
      height="8"
      viewBox="0 0 14 8"
      fill="none"
      aria-hidden
      className="intro-tether text-ink-muted"
    >
      <path
        d="M1 1.5l6 5 6-5"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

interface IntroCopy {
  heading: string;
  sub?: string;
}

function introCopy(conv: Conversation): IntroCopy {
  const name = conv.name || 'this agent';
  if (conv.reviewAgent) {
    const target = stripOrigin(conv.reviewTargetBranch ?? 'the branch');
    if (conv.reviewAgentKind === 'docs') {
      return {
        heading: `Read-only checkout of ${target} — ready to draft docs.`,
        sub: 'Say "go" and I\'ll start writing, or ask anything about the changes first.',
      };
    }
    return {
      heading: `Read-only checkout of ${target} — standing by for the review.`,
      sub: 'Say "go" for a PR-style review, or point me at what to look at first.',
    };
  }
  if (conv.worktreePath && conv.branchName) {
    return {
      heading: `Fresh worktree on ${conv.branchName}.`,
      sub: `What should ${name} build?`,
    };
  }
  return {
    heading: 'New agent, fresh slate.',
    sub: `What’s on your mind for ${name}?`,
  };
}

function IntroPills({ conv }: { conv: Conversation }) {
  const pills: Array<{ icon: JSX.Element; label: string; title?: string }> = [];
  if (conv.reviewAgent) {
    pills.push({
      icon: <EyeIcon />,
      label: 'read-only',
      title: 'Detached HEAD — this agent won\'t commit or edit files.',
    });
  }
  if (conv.worktreePath) {
    pills.push({
      icon: <WorktreeIcon />,
      label: shortenPath(conv.worktreePath),
      title: conv.worktreePath,
    });
  }
  const branchLabel = conv.reviewAgent
    ? stripOrigin(conv.reviewTargetBranch ?? '')
    : conv.branchName ?? '';
  if (branchLabel) {
    pills.push({
      icon: <BranchIcon />,
      label: branchLabel,
      title: conv.reviewAgent ? 'Branch under review' : 'Working branch',
    });
  }
  if (conv.baseBranch) {
    pills.push({
      icon: <BaseIcon />,
      label: `from ${conv.baseBranch}`,
      title: 'Base branch',
    });
  }
  if (pills.length === 0) return null;
  return (
    <div className="flex flex-wrap justify-center gap-1.5 mt-1">
      {pills.map((p, i) => (
        <span
          key={i}
          title={p.title}
          className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-card border border-card-strong text-[11px] text-ink-muted"
        >
          {p.icon}
          <span className="font-mono truncate max-w-[220px]">{p.label}</span>
        </span>
      ))}
    </div>
  );
}

function AgentSparkIcon() {
  return (
    <svg
      width="28"
      height="28"
      viewBox="0 0 32 32"
      fill="none"
      className="text-accent"
      aria-hidden
    >
      <path
        d="M16 4l2.2 7.1 7.1 2.2-7.1 2.2L16 22.6l-2.2-7.1-7.1-2.2 7.1-2.2L16 4z"
        fill="currentColor"
        fillOpacity="0.18"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinejoin="round"
      />
      <circle cx="25" cy="25" r="2" fill="currentColor" fillOpacity="0.7" />
      <circle cx="7" cy="26" r="1.3" fill="currentColor" fillOpacity="0.5" />
    </svg>
  );
}

function WorktreeIcon() {
  return (
    <svg width="11" height="11" viewBox="0 0 16 16" fill="none" aria-hidden>
      <path
        d="M2 4.5A1 1 0 013 3.5h3l1 1.3h6A1 1 0 0114 5.8v6A1 1 0 0113 12.8H3A1 1 0 012 11.8V4.5z"
        stroke="currentColor"
        strokeWidth="1.1"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function BranchIcon() {
  return (
    <svg width="11" height="11" viewBox="0 0 16 16" fill="none" aria-hidden>
      <circle cx="5" cy="3.5" r="1.6" stroke="currentColor" strokeWidth="1.1" />
      <circle cx="5" cy="12.5" r="1.6" stroke="currentColor" strokeWidth="1.1" />
      <circle cx="11" cy="7" r="1.6" stroke="currentColor" strokeWidth="1.1" />
      <path
        d="M5 5.1v5.8M6.4 3.9c2.5.3 4.6 1.1 4.6 3.1"
        stroke="currentColor"
        strokeWidth="1.1"
        strokeLinecap="round"
      />
    </svg>
  );
}

function BaseIcon() {
  return (
    <svg width="11" height="11" viewBox="0 0 16 16" fill="none" aria-hidden>
      <path
        d="M4 3.5v9M4 12.5l-2-2M4 12.5l2-2M11 12.5v-9M11 3.5l-2 2M11 3.5l2 2"
        stroke="currentColor"
        strokeWidth="1.1"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function EyeIcon() {
  return (
    <svg width="11" height="11" viewBox="0 0 16 16" fill="none" aria-hidden>
      <path
        d="M1.5 8s2.4-4.5 6.5-4.5S14.5 8 14.5 8s-2.4 4.5-6.5 4.5S1.5 8 1.5 8z"
        stroke="currentColor"
        strokeWidth="1.1"
        strokeLinejoin="round"
      />
      <circle cx="8" cy="8" r="1.6" stroke="currentColor" strokeWidth="1.1" />
    </svg>
  );
}

function stripOrigin(branch: string): string {
  return branch.startsWith('origin/') ? branch.slice('origin/'.length) : branch;
}

function shortenPath(p: string): string {
  const home = p.replace(/^\/Users\/[^/]+\//, '~/');
  if (home.length <= 44) return home;
  const parts = home.split('/');
  if (parts.length <= 3) return home;
  return `${parts[0]}/…/${parts.slice(-2).join('/')}`;
}

// Tool names that represent user-blocking interactive prompts. These must
// stay visible even when tool activity is hidden — otherwise the
// conversation deadlocks silently on a question the user can't see.
const INTERACTIVE_TOOLS = new Set(['AskUserQuestion', 'ExitPlanMode']);

// Tool names whose cards stay *fully* visible even when tool activity is
// hidden — edits/writes are the meaningful output of a turn, not noise.
// TodoWrite stays visible too: the todo list is live state the user is
// tracking against, not a transient lookup.
// Keep in sync with the matching list in AssistantBubble.tsx.
export const PERSISTENT_TOOLS = new Set(['Edit', 'MultiEdit', 'Write', 'TodoWrite']);

// Tools handled elsewhere in the transcript and therefore skipped by
// the transient flash slot: PERSISTENT_TOOLS render their full card in
// the assistant bubble regardless of the toggle, so flashing them would
// duplicate. Everything else flashes — suppressing unknown tools makes
// long turns (subagents, MCP calls, skills) feel like nothing is
// happening.
const FLASH_SKIP = new Set(['Edit', 'MultiEdit', 'Write', 'TodoWrite']);

function shouldFlash(name: string): boolean {
  return !FLASH_SKIP.has(name);
}

// Floor on how long the slot keeps showing one tool before a newer one is
// allowed to replace it. Protects against bursts where 5 tools fire in
// under a second — you'd only ever see the last one, and the swaps would
// feel like flicker. Swaps are still gated by the 180ms fade animation.
const MIN_HOLD_MS = 400;

/// Watches the event stream for flash-worthy tool uses and returns the
/// single most recent one as a "now doing…" slot. New tools swap in place
/// (no stacking, no fade-out timers) so the transcript doesn't bounce.
/// The slot clears when the assistant emits visible text for this turn, or
/// when the user sends a new prompt. Disabled when tool activity is on
/// (the full card is already rendered in the chat).
///
/// Baseline ids are captured on mount for a given (conversation, toggle)
/// state so opening a conversation with history doesn't surface stale
/// tools from earlier turns.
const SUBAGENT_TOOLS = new Set(['Task', 'Agent']);

function useLatestToolReveal(
  events: StreamEvent[],
  toolResultIndex: Map<string, ToolResultBlock>,
  showToolActivity: boolean,
  conversationId: UUID,
): ToolUseBlock | null {
  const [current, setCurrent] = useState<ToolUseBlock | null>(null);
  const baselineIdsRef = useRef<Set<string>>(new Set());
  const hasInitializedRef = useRef(false);
  const currentRef = useRef<ToolUseBlock | null>(null);
  const currentStartedAtRef = useRef<number>(0);
  const desiredRef = useRef<ToolUseBlock | null>(null);
  const pendingTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (pendingTimerRef.current) {
      clearTimeout(pendingTimerRef.current);
      pendingTimerRef.current = null;
    }
    setCurrent(null);
    currentRef.current = null;
    currentStartedAtRef.current = 0;
    desiredRef.current = null;
    baselineIdsRef.current = new Set();
    hasInitializedRef.current = false;
  }, [conversationId, showToolActivity]);

  useEffect(() => {
    return () => {
      if (pendingTimerRef.current) clearTimeout(pendingTimerRef.current);
    };
  }, []);

  useEffect(() => {
    if (showToolActivity) return;
    if (!hasInitializedRef.current) {
      baselineIdsRef.current = new Set(events.map((e) => e.id));
      hasInitializedRef.current = true;
      return;
    }
    const baseline = baselineIdsRef.current;
    let latestFlash: ToolUseBlock | null = null;
    let pendingSubagent: ToolUseBlock | null = null;
    for (const ev of events) {
      if (baseline.has(ev.id)) continue;
      if (ev.kind.type === 'localUser') {
        latestFlash = null;
        pendingSubagent = null;
        continue;
      }
      if (ev.kind.type !== 'assistant') continue;
      for (const use of ev.kind.info.toolUses) {
        if (SUBAGENT_TOOLS.has(use.name) && !toolResultIndex.has(use.id)) {
          pendingSubagent = use;
        }
      }
      // Text from the assistant means it has "come back" with a response —
      // clear the slot so the bubble takes over. A later tool in the same
      // walk will override this if the turn is still running.
      if (ev.kind.info.text.trim()) latestFlash = null;
      for (const use of ev.kind.info.toolUses) {
        if (shouldFlash(use.name)) latestFlash = use;
      }
    }
    // A subagent/Task that hasn't completed wins over newer flash tools:
    // the Claude CLI stream goes silent while a subagent works, so we
    // keep the Task card pinned as the "it's still doing something"
    // indicator until its tool_result arrives.
    const next = pendingSubagent ?? latestFlash;
    desiredRef.current = next;

    if (currentRef.current?.id === next?.id) return;

    const commit = (value: ToolUseBlock | null) => {
      currentRef.current = value;
      currentStartedAtRef.current = Date.now();
      pendingTimerRef.current = null;
      setCurrent(value);
    };

    const age = Date.now() - currentStartedAtRef.current;
    if (currentRef.current && age < MIN_HOLD_MS) {
      if (pendingTimerRef.current) clearTimeout(pendingTimerRef.current);
      pendingTimerRef.current = setTimeout(() => commit(desiredRef.current), MIN_HOLD_MS - age);
      return;
    }

    if (pendingTimerRef.current) {
      clearTimeout(pendingTimerRef.current);
      pendingTimerRef.current = null;
    }
    commit(next);
  }, [events, toolResultIndex, showToolActivity]);

  return current;
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
  const keep = events.map((e) => {
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
        // Match AssistantBubble's own render-gate — an assistant event
        // with `thinking: [""]` or whitespace-only thinking passes a naive
        // length check but renders nothing, and that phantom peer kept
        // lonely `result` captions on screen.
        const hasRenderableThinking = info.thinking.some((x) => x.trim().length > 0);
        if (
          !info.text.trim() &&
          !hasRenderableThinking &&
          !info.hasOpaqueReasoning &&
          !hasAlwaysVisibleTool(info.toolUses)
        ) {
          return false;
        }
      }
    }
    return true;
  });

  // Hide the per-turn usage caption when its entire turn is hidden.
  // Counts anything produced by the assistant side of the turn
  // (assistant bubbles, tool results, permission prompts, notices, …) —
  // `localUser` is excluded since it belongs to the preceding turn from
  // the caption's perspective. Error results always stay visible so a
  // failure isn't silently dropped.
  if (!showToolActivity) {
    let turnStart = 0;
    for (let i = 0; i < events.length; i++) {
      const ev = events[i];
      if (ev.kind.type === 'localUser') {
        turnStart = i + 1;
        continue;
      }
      if (ev.kind.type !== 'result') continue;
      if (!keep[i] || ev.kind.info.isError) {
        turnStart = i + 1;
        continue;
      }
      let hasVisiblePeer = false;
      for (let j = turnStart; j < i; j++) {
        const t = events[j].kind.type;
        if (keep[j] && t !== 'localUser' && t !== 'metaReminder') {
          hasVisiblePeer = true;
          break;
        }
      }
      if (!hasVisiblePeer) keep[i] = false;
      turnStart = i + 1;
    }
  }

  return events.filter((_, i) => keep[i]);
}

/// Friendly short label for the most recently-started tool_use that
/// doesn't have a matching result yet. Rendered in the activity strip
/// when `showToolActivity` is off so the user still sees *something*
/// flicker by as each tool fires.
function countPendingSubagents(
  events: StreamEvent[],
  toolResultIndex: Map<string, ToolResultBlock>,
): number {
  let n = 0;
  for (const ev of events) {
    if (ev.kind.type !== 'assistant') continue;
    for (const use of ev.kind.info.toolUses) {
      if (SUBAGENT_TOOLS.has(use.name) && !toolResultIndex.has(use.id)) n += 1;
    }
  }
  return n;
}

function withSubagentSuffix(label: string, pending: number): string {
  if (pending <= 0) return label;
  const note = pending === 1 ? '1 subagent running' : `${pending} subagents running`;
  const base = label?.trim();
  return base ? `${base} · ${note}` : `${note}…`;
}

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
      // Subagents are surfaced separately (sticky card + count suffix),
      // so don't let a pending Task/Agent also claim the activity label.
      if (SUBAGENT_TOOLS.has(use.name)) continue;
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
