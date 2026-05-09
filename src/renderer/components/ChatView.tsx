import { memo, useEffect, useMemo, useRef, useState } from 'react';
import { Virtuoso, VirtuosoHandle } from 'react-virtuoso';
import { useStore } from '../store';
import { useRunner } from '../runnersStore';
import { backendColor, backendName } from '../theme';
import { Backend, Conversation, StreamEvent, ToolResultBlock, ToolUseBlock, UUID } from '@shared/types';
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
import { EasterEggBubble } from './EasterEggBubble';
import { ActivityStrip } from './ActivityStrip';
import { useConversation } from '../hooks';

export function ChatView({ conversationId }: { conversationId: UUID }) {
  const runner = useRunner(conversationId);
  const showToolActivity = useStore((s) => s.showToolActivity);
  const events = runner?.events ?? [];
  const isRunning = runner?.isRunning ?? false;
  const activityLabel = runner?.activityLabel ?? '';
  const error = runner?.errorMessage;
  const virtuosoRef = useRef<VirtuosoHandle>(null);
  const followingRef = useRef(true);
  // Timestamp of the last tail-content change. atBottomStateChange flipping
  // to false within ~250ms of a content change is virtuoso reporting that
  // the new content has pushed past the viewport bottom — that's not the
  // user scrolling away, so we ignore it and scroll to catch up. Outside
  // that window, a false signal is treated as a real user gesture.
  const lastTailChangeAtRef = useRef(0);

  const toolUseIndex = useMemo(() => indexToolUses(events), [events]);
  const toolResultIndex = useMemo(() => indexToolResults(events), [events]);
  const visibleEvents = useMemo(
    () => filterRendered(events, showToolActivity, toolUseIndex),
    [events, showToolActivity, toolUseIndex],
  );
  // Verdict + intermediate sets. The server marks exactly one event
  // per round as `reviewer.verdict: true` at turn/completed — that's
  // the verdict bubble (full chrome + check). Every *other* reviewer
  // assistant-text event is intermediate, which the renderer demotes
  // to a compact `ReviewerStepLine` (no bubble chrome). We don't gate
  // intermediate-ness on completion: while a round is in flight the
  // verdict flag isn't set yet, so all of the streaming "I'm checking
  // …" messages render compact immediately, and at turn/completed the
  // last text-bearing one snaps to a full bubble. Tool / thinking /
  // patch rows in the rebound block always render at full chrome —
  // they're work artifacts, not verdict candidates.
  const { verdictIds, intermediateIds } = useMemo(() => {
    const verdicts = new Set<string>();
    for (const e of visibleEvents) {
      if (e.reviewer?.verdict) verdicts.add(e.id);
    }
    const intermediates = new Set<string>();
    for (const e of visibleEvents) {
      if (
        e.reviewer &&
        e.kind.type === 'assistant' &&
        e.kind.info.text.trim().length > 0 &&
        !verdicts.has(e.id)
      ) {
        intermediates.add(e.id);
      }
    }
    return { verdictIds: verdicts, intermediateIds: intermediates };
  }, [visibleEvents]);
  const currentReveal = useLatestToolReveal(events, toolResultIndex, showToolActivity, conversationId);
  const pendingSubagents = useMemo(
    () => countPendingSubagents(events, toolResultIndex),
    [events, toolResultIndex],
  );

  // Streaming tail-follow: virtuoso's `followOutput` only fires when the
  // data array length changes, but during streaming the same event mutates
  // in place — its height grows, length doesn't change. We watch the tail
  // event's revision and imperatively scroll to the bottom when we're
  // still in follow mode. rAF defers the scroll until virtuoso has had a
  // chance to re-measure the grown row, otherwise scrollToIndex aligns to
  // a stale height.
  const tailEvent = visibleEvents[visibleEvents.length - 1];
  const tailRevision = tailEvent?.revision ?? 0;
  const tailId = tailEvent?.id ?? '';
  useEffect(() => {
    lastTailChangeAtRef.current = Date.now();
    if (!followingRef.current) return;
    const id = requestAnimationFrame(() => {
      if (!followingRef.current) return;
      virtuosoRef.current?.scrollToIndex({
        index: 'LAST',
        align: 'end',
        behavior: 'auto',
      });
    });
    return () => cancelAnimationFrame(id);
  }, [tailId, tailRevision, currentReveal?.id, isRunning]);

  // Land at the absolute bottom on conv switch. `initialTopMostItemIndex`
  // alone is unreliable here: virtuoso renders with estimated row heights
  // first and only re-measures after markdown / syntax highlighting paint,
  // which lands the user a few rows above the real bottom. Re-scroll across
  // a few timing windows so late measurements don't strand us.
  useEffect(() => {
    let cancelled = false;
    const scroll = () => {
      if (cancelled) return;
      virtuosoRef.current?.scrollToIndex({
        index: 'LAST',
        align: 'end',
        behavior: 'auto',
      });
    };
    const raf = requestAnimationFrame(scroll);
    const t1 = setTimeout(scroll, 100);
    const t2 = setTimeout(scroll, 300);
    return () => {
      cancelled = true;
      cancelAnimationFrame(raf);
      clearTimeout(t1);
      clearTimeout(t2);
    };
  }, [conversationId]);

  const handleAtBottomChange = (atBottom: boolean) => {
    if (atBottom) {
      followingRef.current = true;
      return;
    }
    // Within the post-content-change window, a "no longer at bottom"
    // signal means content grew past the viewport — not a user scroll.
    // Ignore so the rAF effect can catch up.
    if (Date.now() - lastTailChangeAtRef.current < 250) return;
    followingRef.current = false;
  };

  // Empty / loading states render outside virtuoso — virtuoso with zero
  // items renders nothing, and the intro card uses min-h-full layout that
  // a virtualized list can't provide.
  if (runner?.historyLoading) {
    return (
      <div className="flex-1 min-h-0 flex flex-col">
        <div className="flex-1 min-h-0 overflow-y-auto px-5 py-4">
          <div className="text-xs text-ink-faint">Loading history…</div>
        </div>
      </div>
    );
  }

  if (visibleEvents.length === 0 && !isRunning) {
    return (
      <div className="flex-1 min-h-0 flex flex-col">
        <div className="flex-1 min-h-0 overflow-y-auto px-5 py-4">
          <NewAgentIntro conversationId={conversationId} />
        </div>
      </div>
    );
  }

  const showActivityStrip =
    isRunning && (activityLabel || !showToolActivity || pendingSubagents > 0);
  const activityStripLabel = showActivityStrip
    ? withSubagentSuffix(
        // When tool activity is hidden, the user loses the visible signal
        // of which tool is running — so promote the latest in-flight tool
        // call to the strip. Falls back to whatever generic label the
        // runner set ("Thinking…", "Running tools…") when no tool is
        // currently pending.
        (!showToolActivity && latestPendingToolLabel(events, toolResultIndex)) ||
          activityLabel,
        pendingSubagents,
      )
    : '';

  return (
    <div className="flex-1 min-h-0 flex flex-col">
      <Virtuoso
        // Re-key on conversationId so virtuoso resets its scroll state
        // (and re-applies initialTopMostItemIndex) when you switch convs,
        // instead of trying to reconcile two unrelated event lists.
        key={conversationId}
        ref={virtuosoRef}
        data={visibleEvents}
        // 'auto' = follow the tail when the user is near bottom; pause
        // when they've scrolled up. Smooth scrolling makes streaming feel
        // jittery on long turns, so we use instant.
        followOutput="auto"
        atBottomStateChange={handleAtBottomChange}
        // Wider threshold so a single tall code block streaming in
        // doesn't pop the user out of follow mode. The post-content
        // grace window above is the primary defense; this is belt and
        // suspenders.
        atBottomThreshold={400}
        // Land at the *bottom* of the last event on conv switch.
        // Without `align: 'end'` virtuoso puts the *top* of the last
        // item at the top of the viewport — for a long final assistant
        // turn that shows the beginning of the message with the latest
        // content cut off below.
        initialTopMostItemIndex={{ index: 'LAST', align: 'end' }}
        // Pre-render a buffer so scrolling doesn't reveal blank space
        // mid-flick on heavy markdown rows.
        increaseViewportBy={{ top: 600, bottom: 600 }}
        // Key by event id — without this, virtuoso reuses index-based
        // slots and a row can show stale content after the list shifts
        // (visible as "two identical turns" when streaming).
        computeItemKey={(_index, event) => event.id}
        className="flex-1 min-h-0"
        itemContent={(index, event) => {
          // First event of a new rebound block gets a "Codex · collab ·
          // round 2" header so a reader scanning the chat can tell who's
          // talking. The verdict (set by the server at turn/completed)
          // gets a check rendered next to its CLI label inside the
          // bubble; other text bubbles in the same completed round
          // dim to intermediate styling. While the round is in flight
          // nothing is marked, so streaming bubbles render plain.
          const prev = index > 0 ? visibleEvents[index - 1] : undefined;
          const next = index < visibleEvents.length - 1 ? visibleEvents[index + 1] : undefined;
          // A reviewer block is a run of consecutive events sharing
          // the same backend + round. Round changes (collab round 2 →
          // round 3) start a new block — same visual grouping rules
          // showHeader uses below.
          const isFirstInBlock =
            !!event.reviewer &&
            (!prev?.reviewer ||
              prev.reviewer.backend !== event.reviewer.backend ||
              prev.reviewer.round !== event.reviewer.round);
          const isLastInBlock =
            !!event.reviewer &&
            (!next?.reviewer ||
              next.reviewer.backend !== event.reviewer.backend ||
              next.reviewer.round !== event.reviewer.round);
          const showHeader = isFirstInBlock;
          const isVerdict = verdictIds.has(event.id);
          const isIntermediate = intermediateIds.has(event.id);
          const reviewerTint = event.reviewer
            ? backendColor(event.reviewer.backend)
            : undefined;
          // Compact step-line rows tighten the wrapper's vertical
          // padding from the row default (py-1.5 = 6px each side) to
          // 0, so a stack of "I'm checking…" lines packs together
          // instead of breathing like full bubbles. ReviewerStepLine's
          // own internal py-0.5 supplies a 2px line gap.
          const rowPad = isIntermediate ? 'px-5 py-0' : 'px-5 py-1.5';
          // Reviewer-tagged events (codex collab/review path) get the
          // same indent + wash treatment as one-shot review cards in
          // ReviewCard.tsx. The wash sits on an INNER div so it
          // respects the row's `px-5` content padding (same right
          // edge as primary bubbles); putting it on the row wrapper
          // would extend it edge-to-edge. Boundary rows get rounded
          // corners + extra padding so the wash reads as one
          // contained card spanning the block.
          const reviewerInner = event.reviewer
            ? `ml-6 bg-white/[0.02] px-3${isFirstInBlock ? ' rounded-t-xl pt-3' : ''}${
                isLastInBlock ? ' rounded-b-xl pb-3' : ''
              }`
            : '';
          const inner = (
            <>
              {showHeader && event.reviewer && (
                <ReviewerHeader info={event.reviewer} />
              )}
              <EventRow
                event={event}
                conversationId={conversationId}
                toolUseIndex={toolUseIndex}
                toolResultIndex={toolResultIndex}
                endorsed={isVerdict && !!event.reviewer}
                endorsementTint={reviewerTint}
                reviewerCompact={isIntermediate}
                reviewerTint={reviewerTint}
              />
            </>
          );
          return (
            <div className={rowPad}>
              {event.reviewer ? <div className={reviewerInner}>{inner}</div> : inner}
            </div>
          );
        }}
        components={{
          Footer: () => (
            <div className="px-5 pb-10 pt-1.5 space-y-3">
              {currentReveal && (
                <div key={currentReveal.id} className="transient-slot">
                  <ToolUseCard
                    use={currentReveal}
                    result={toolResultIndex.get(currentReveal.id)}
                    compact
                  />
                </div>
              )}
              {showActivityStrip && <ActivityStrip label={activityStripLabel} />}
              {error && <SystemNotice text={error} />}
            </div>
          ),
        }}
      />
    </div>
  );
}

type EventRowProps = {
  event: StreamEvent;
  conversationId: UUID;
  toolUseIndex: Map<string, ToolUseBlock>;
  toolResultIndex: Map<string, ToolResultBlock>;
  /// True for the one assistant event per rebound round that the
  /// server marked as the verdict. Drives a small check rendered next
  /// to the CLI label inside the bubble.
  endorsed?: boolean;
  endorsementTint?: string;
  /// True for reviewer assistant-text events that aren't (yet) the
  /// verdict — render compact via ReviewerStepLine instead of a full
  /// AssistantBubble. Tool / thinking / patch rows in a rebound block
  /// stay full-chrome regardless of this flag.
  reviewerCompact?: boolean;
  reviewerTint?: string;
};

/// Only `assistant` and `toolResult` rows look up their props' indices
/// at render time; for every other row type the indices are unused and
/// their reference churn (a fresh Map is materialized on every chunk
/// during streaming) would needlessly invalidate React.memo. Custom
/// equality skips index comparison for index-independent rows so a long
/// conversation's old user / notice / permission / result rows stay
/// memoized through the stream.
const EventRow = memo(function EventRow({
  event,
  conversationId,
  toolUseIndex,
  toolResultIndex,
  endorsed,
  endorsementTint,
  reviewerCompact,
  reviewerTint,
}: EventRowProps) {
  switch (event.kind.type) {
    case 'localUser':
      return <UserBubble text={event.kind.text} attachments={event.kind.attachments} />;
    case 'assistant':
      if (reviewerCompact && reviewerTint) {
        return <ReviewerStepLine text={event.kind.info.text} tint={reviewerTint} />;
      }
      return (
        <AssistantBubble
          info={event.kind.info}
          toolResultIndex={toolResultIndex}
          endorsed={endorsed}
          endorsementTint={endorsementTint}
        />
      );
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
    case 'easterEgg':
      return <EasterEggBubble text={event.kind.text} from={event.kind.from} />;
    default:
      return null;
  }
}, areEventRowPropsEqual);

/// Returns true to skip the re-render. `event` is mutated immutably
/// (new ref per change) and conversationId is stable, so reference
/// equality on those is enough. The indices only matter for rows that
/// read them — index-independent rows can ignore index churn entirely.
function areEventRowPropsEqual(prev: EventRowProps, next: EventRowProps): boolean {
  if (prev.event !== next.event) return false;
  if (prev.conversationId !== next.conversationId) return false;
  if (prev.endorsed !== next.endorsed) return false;
  if (prev.endorsementTint !== next.endorsementTint) return false;
  if (prev.reviewerCompact !== next.reviewerCompact) return false;
  if (prev.reviewerTint !== next.reviewerTint) return false;
  const t = next.event.kind.type;
  if (t === 'assistant' || t === 'toolResult') {
    if (prev.toolUseIndex !== next.toolUseIndex) return false;
    if (prev.toolResultIndex !== next.toolResultIndex) return false;
  }
  return true;
}

function ReviewerStepLine({ text, tint }: { text: string; tint: string }) {
  // Compact "process step" rendering for non-verdict reviewer assistant
  // text. Strips bubble chrome (no bg, no border, no accent strip),
  // smaller dim type, tinted dot prefix — so a chain of mid-round
  // narration ("I'm checking…", "I found…") reads as work-shown
  // rather than as five equally-loud answers. The verdict (the last
  // text-bearing assistant event of the round) goes through the full
  // AssistantBubble instead.
  const trimmed = text.trim();
  if (!trimmed) return null;
  return (
    <div className="flex items-start gap-2 py-0.5 text-[11.5px] text-ink-muted leading-relaxed">
      <span
        className="mt-1.5 flex-shrink-0 w-1 h-1 rounded-full"
        style={{ background: tint }}
        aria-hidden
      />
      <div className="flex-1 min-w-0 whitespace-pre-wrap break-words select-text">
        {trimmed}
      </div>
    </div>
  );
}

function ReviewerHeader({
  info,
}: {
  info: { backend: Backend; round: number; mode: 'review' | 'collab' };
}) {
  const tint = backendColor(info.backend);
  const parts = [backendName(info.backend), info.mode === 'collab' ? 'collab' : 'review'];
  if (info.mode === 'collab') parts.push(`round ${info.round}`);
  return (
    <div
      className="text-[10px] uppercase tracking-wider font-medium pt-1 pb-1.5 flex items-center gap-1.5"
      style={{ color: tint }}
    >
      {/* "↩" prefix matches the one-shot reviewer cards (ReviewCard.tsx)
          so codex collab/review reads as the same kind of block. */}
      <span className="text-ink-faint">↩</span>
      <span>{parts.join(' · ')}</span>
    </div>
  );
}

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
// the transient flash slot: PERSISTENT_TOOLS and INTERACTIVE_TOOLS both
// render their full card in the assistant bubble regardless of the
// toggle, so flashing them would duplicate. Everything else flashes —
// suppressing unknown tools makes long turns (subagents, MCP calls,
// skills) feel like nothing is happening.
const FLASH_SKIP = new Set([
  'Edit',
  'MultiEdit',
  'Write',
  'TodoWrite',
  'AskUserQuestion',
  'ExitPlanMode',
]);

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
      // The latest-tool-reveal indicator follows the primary agent only.
      // Rebound (reviewer) tool calls render inline within the rebound
      // block; the conversation-level "Rebounding…" running indicator
      // covers the "reviewer is working" affordance at a higher level.
      if (ev.reviewer) continue;
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

    // Prevent noisy churn from repeated Bash tool_use blocks that run the
    // same command text (common on Windows wrappers). Keep the current
    // reveal card if the command signature hasn't changed.
    if (
      currentRef.current &&
      next &&
      toolRevealSignature(currentRef.current) === toolRevealSignature(next)
    ) {
      return;
    }

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
      const firstLine = String(args.command ?? '').split('\n')[0].trim();
      const cmd = simplifyShellCommandLabel(firstLine).slice(0, 50);
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
  return p.split(/[\\/]/).filter(Boolean).slice(-1)[0] ?? p;
}

function simplifyShellCommandLabel(cmd: string): string {
  const lower = cmd.toLowerCase();
  if (lower.includes('powershell.exe') || lower.includes('windowspowershell') || lower.includes('pwsh.exe')) {
    return 'PowerShell command';
  }
  return cmd;
}

function toolRevealSignature(use: ToolUseBlock): string {
  const args = safeParse(use.inputJSON);
  if (use.name === 'Bash') {
    const firstLine = String(args.command ?? '').split('\n')[0].trim();
    return `Bash:${simplifyShellCommandLabel(firstLine)}`;
  }
  return `${use.name}:${use.id}`;
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
