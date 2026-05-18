// Right-side drawer that shows the full nested stream of a Task/Agent
// subagent — the data the new Claude Code visibility surface exposes via
// `parent_tool_use_id`. The inline SubagentCard in the conversation
// opens this drawer for its own use.id; switching tabs lets the user
// inspect parallel subagents in the same conversation without losing
// the main transcript.
//
// Events come from the per-conversation `subagentEvents` bucket the
// renderer's store populates from incoming StreamEvents tagged with
// `parentToolUseId`. We reuse AssistantBubble/ToolUseCard/ToolResultCard
// so subagent steps render with the same visual vocabulary as the main
// transcript — just inside a narrower pane.

import { useEffect, useMemo, useRef } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useStore } from '../store';
import { useRunner, useSubagentEvents, useSubagentKeys } from '../runnersStore';
import { InsideSubagentDrawer, OpenFileOverride } from '../openFile';
import { StreamEvent, ToolResultBlock, ToolUseBlock } from '@shared/types';
import { AssistantBubble } from './AssistantBubble';
import { ToolResultCard } from './ToolResultCard';
import { SystemNotice } from './SystemNotice';
import { Markdown } from './Markdown';

export function SubagentDrawer({ conversationId }: { conversationId: string }) {
  const activeId = useStore((s) => s.subagentDrawerParentId);
  const close = useStore((s) => s.closeSubagentDrawer);
  const openSubagent = useStore((s) => s.openSubagentDrawer);
  const openSideFile = useStore((s) => s.openSideFile);
  const dismissSubagent = useStore((s) => s.dismissSubagent);
  const allSubagentKeys = useSubagentKeys(conversationId);
  const runner = useRunner(conversationId);

  // Dismissed ids live in the renderer store keyed per-conversation so
  // they survive the drawer's mount/unmount cycle. Dismissing the last
  // tab unmounts the drawer; next time the user clicks any inline
  // SubagentCard it remounts here, and without persistence the just-
  // dismissed tabs would reappear. useShallow keeps the array stable
  // when nothing changed so we don't churn re-renders.
  const dismissedIds = useStore(
    useShallow((s) => s.dismissedSubagents[conversationId] ?? []),
  );
  const subagentKeys = useMemo(() => {
    if (dismissedIds.length === 0) return allSubagentKeys;
    const set = new Set(dismissedIds);
    return allSubagentKeys.filter((k) => !set.has(k));
  }, [allSubagentKeys, dismissedIds]);

  // Active subagent's own events. We always call the hook so its
  // subscription stays stable even when the drawer is technically
  // closed (activeId becomes null) — closing is handled by the parent
  // mount/unmount, not by short-circuiting here.
  const activeEvents = useSubagentEvents(conversationId, activeId);

  const dismissTab = (id: string) => {
    dismissSubagent(conversationId, id);
    if (id === activeId) {
      // Pick the next still-visible tab; close the drawer if none remain.
      const dismissedSet = new Set([...dismissedIds, id]);
      const remaining = allSubagentKeys.filter(
        (k) => k !== id && !dismissedSet.has(k),
      );
      if (remaining.length > 0) openSubagent(remaining[0]);
      else close();
    }
  };

  // Look up subagent display names from the main transcript's Task
  // tool_use blocks — `subagent_type` arg is the most informative label
  // ("Explore", "general-purpose", custom names). Falls back to the
  // truncated id when no parent block can be found (sidechain history
  // entries, for example).
  const labelsByParent = useMemo(
    () => indexSubagentLabels(runner?.events ?? []),
    [runner?.events],
  );

  // The agent's synthesized final report rides back to the parent on a
  // tool_result keyed by the same tool_use id as the Task call. Pull
  // it from the main runner events so we can render it as markdown at
  // the bottom of the drawer — that's the synthesized output the user
  // came here to read, and surfacing it inline saves a round-trip to
  // the main transcript.
  const finalReport = useMemo(
    () => (activeId ? findParentToolResult(runner?.events ?? [], activeId) : null),
    [runner?.events, activeId],
  );

  // Auto-follow new events while the user is parked near the bottom.
  // We track a "stick to bottom" flag that flips off the moment the
  // user scrolls up to read a card and back on when they scroll back
  // to the floor — same pattern as ChatView's virtuoso follower so the
  // drawer doesn't yank the viewport while someone is reading.
  const scrollRef = useRef<HTMLDivElement>(null);
  const stickRef = useRef(true);
  // Snap to bottom whenever the active tab changes — opening a tab
  // should land you at the latest event, not somewhere mid-scroll.
  useEffect(() => {
    stickRef.current = true;
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [activeId]);
  useEffect(() => {
    if (!stickRef.current) return;
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [activeEvents, finalReport]);
  const handleScroll = (e: React.UIEvent<HTMLDivElement>) => {
    const el = e.currentTarget;
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    // 32px slack — wheel scrolls overshoot slightly past the bottom
    // edge and we don't want that to flip stickiness off.
    stickRef.current = distanceFromBottom < 32;
  };

  if (!activeId) return null;

  return (
    <OpenFileOverride.Provider value={openSideFile}>
    <InsideSubagentDrawer.Provider value={true}>
    <div className="h-full w-full flex flex-col bg-surface border-l border-card overflow-hidden">
      <div className="flex items-center gap-2 px-3 py-1.5 border-b border-card text-xs flex-shrink-0">
        <span className="text-[10px] uppercase tracking-wide text-indigo-400 font-medium">
          Subagents
        </span>
        <span className="text-ink-faint text-[10px]">
          {subagentKeys.length}
        </span>
        <button
          onClick={close}
          className="ml-auto text-ink-faint hover:text-ink text-xs px-2"
          aria-label="Close drawer"
        >
          ✕
        </button>
      </div>
      {subagentKeys.length > 0 && (
        <div className="flex gap-1 px-2 py-1 border-b border-card overflow-x-auto flex-shrink-0">
          {subagentKeys.map((k) => {
            const label = labelsByParent.get(k);
            const short = label?.short ?? shortId(k);
            const tooltip = label?.full ?? short;
            return (
              <div
                key={k}
                className={
                  'flex items-center rounded whitespace-nowrap ' +
                  (k === activeId
                    ? 'bg-indigo-500/25 text-indigo-100'
                    : 'text-ink-faint hover:text-ink hover:bg-card')
                }
                title={tooltip}
              >
                <button
                  onClick={() => openSubagent(k)}
                  className="text-[10px] pl-2 pr-1 py-1"
                >
                  {short}
                </button>
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    dismissTab(k);
                  }}
                  className="text-[10px] px-1.5 py-1 opacity-60 hover:opacity-100"
                  aria-label={`Dismiss subagent ${short}`}
                  title="Dismiss this tab"
                >
                  ×
                </button>
              </div>
            );
          })}
        </div>
      )}
      <div
        ref={scrollRef}
        onScroll={handleScroll}
        className="flex-1 min-h-0 overflow-y-auto px-3 py-3 flex flex-col gap-2.5"
      >
        {activeEvents.length === 0 ? (
          <div className="text-[10px] text-ink-faint italic">
            (waiting for the agent to start…)
          </div>
        ) : (
          <>
            <SubagentTranscript events={activeEvents} />
            {finalReport && <FinalReport result={finalReport} openFile={openSideFile} />}
          </>
        )}
      </div>
    </div>
    </InsideSubagentDrawer.Provider>
    </OpenFileOverride.Provider>
  );
}

function FinalReport({
  result,
  openFile,
}: {
  result: ToolResultBlock;
  openFile: (p: string) => void;
}) {
  if (!result.content) return null;
  return (
    <div
      className={
        'rounded-lg text-xs px-3 py-2 ' +
        (result.isError
          ? 'border border-red-500/30 bg-red-500/5'
          : 'border border-indigo-500/30 bg-indigo-500/[0.06]')
      }
    >
      <div
        className={
          'text-[10px] uppercase tracking-wide font-medium mb-1.5 ' +
          (result.isError ? 'text-red-400' : 'text-indigo-400')
        }
      >
        {result.isError ? 'Agent error' : 'Final report'}
      </div>
      <div className="text-ink">
        <Markdown source={result.content} onOpenPath={(p) => openFile(p)} />
      </div>
    </div>
  );
}

function findParentToolResult(
  events: StreamEvent[],
  parentToolUseId: string,
): ToolResultBlock | null {
  // Scan backwards — the parent's tool_result lands once the subagent
  // finishes, so it's almost always near the tail of the transcript.
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (e.kind.type !== 'toolResult') continue;
    for (const r of e.kind.results) {
      if (r.id === parentToolUseId) return r;
    }
  }
  return null;
}

/// Tools whose tool_result is already folded into their tool_use card
/// (✓ badge, inline diff, expandable Bash output). Surfacing the
/// standalone Result row in the drawer doubles up that information
/// and crowds the scroll. Errors still fall through so a failure
/// isn't silently swallowed.
const RESULT_FOLDED_TOOLS = new Set([
  'Edit',
  'MultiEdit',
  'Write',
  'Read',
  'Bash',
  'Grep',
  'Glob',
]);

function SubagentTranscript({ events }: { events: StreamEvent[] }) {
  const toolResultIndex = useMemo(() => indexToolResults(events), [events]);
  const toolUseIndex = useMemo(() => indexToolUses(events), [events]);
  // Collapse partial → final assistant snapshots by id so we only paint
  // one bubble per assistant message in the subagent stream. The final
  // (non-partial) wins; if only a partial is present we render that.
  const collapsed = useMemo(() => collapseAssistants(events), [events]);
  const filtered = useMemo(() => {
    return collapsed.filter((e) => {
      if (e.kind.type !== 'toolResult') return true;
      // Drop redundant non-error results whose tool_use card already
      // shows the outcome. Errors and unknown-source results stay.
      return e.kind.results.some((r) => {
        if (r.isError) return true;
        const src = toolUseIndex.get(r.id);
        return !src || !RESULT_FOLDED_TOOLS.has(src.name);
      });
    });
  }, [collapsed, toolUseIndex]);
  return (
    <>
      {filtered.map((e) => (
        <SubagentEventRow
          key={e.id}
          event={e}
          toolResultIndex={toolResultIndex}
          toolUseIndex={toolUseIndex}
        />
      ))}
    </>
  );
}

function SubagentEventRow({
  event,
  toolResultIndex,
  toolUseIndex,
}: {
  event: StreamEvent;
  toolResultIndex: Map<string, ToolResultBlock>;
  toolUseIndex: Map<string, ToolUseBlock>;
}) {
  const kind = event.kind;
  if (kind.type === 'assistant') {
    return (
      <AssistantBubble
        info={kind.info}
        toolResultIndex={toolResultIndex}
        forceShowTools
      />
    );
  }
  if (kind.type === 'toolResult') {
    return <ToolResultCard results={kind.results} toolUseIndex={toolUseIndex} />;
  }
  if (kind.type === 'systemNotice') {
    return <SystemNotice text={kind.text} />;
  }
  return null;
}

function indexToolUses(events: StreamEvent[]): Map<string, ToolUseBlock> {
  const out = new Map<string, ToolUseBlock>();
  for (const e of events) {
    if (e.kind.type !== 'assistant') continue;
    for (const use of e.kind.info.toolUses) out.set(use.id, use);
  }
  return out;
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

function collapseAssistants(events: StreamEvent[]): StreamEvent[] {
  // Same id may appear as a partial snapshot and then again as the
  // final consolidated assistant event. Keep the last occurrence per
  // id (the final overrides the partial). Order is preserved by the
  // first appearance so the transcript doesn't reshuffle.
  const lastByid = new Map<string, StreamEvent>();
  for (const e of events) lastByid.set(e.id, e);
  const seen = new Set<string>();
  const out: StreamEvent[] = [];
  for (const e of events) {
    if (seen.has(e.id)) continue;
    seen.add(e.id);
    out.push(lastByid.get(e.id)!);
  }
  return out;
}

interface SubagentLabel {
  /// Short string for the tab (e.g. "Find Copilot files" or "Explore").
  /// Prefers the description because subtype repeats across parallel
  /// agents of the same kind — description is what distinguishes them.
  short: string;
  /// Full text for the tab's title attribute (tooltip on hover).
  /// "Explore · Find Copilot files in this repo".
  full: string;
}

function indexSubagentLabels(events: StreamEvent[]): Map<string, SubagentLabel> {
  // Walk the main transcript's tool_use blocks looking for subagent
  // dispatches (named either 'Task' or 'Agent' depending on which CLI
  // emitted the event). The Task input carries both `subagent_type`
  // ("Explore", "Plan") and `description` (model-supplied one-liner);
  // we keep both so the tab can show the more useful one without
  // losing the kind information.
  const out = new Map<string, SubagentLabel>();
  for (const e of events) {
    if (e.kind.type !== 'assistant') continue;
    for (const use of e.kind.info.toolUses) {
      if (use.name !== 'Task' && use.name !== 'Agent') continue;
      const label = extractSubagentLabel(use);
      if (label) out.set(use.id, label);
    }
  }
  return out;
}

function extractSubagentLabel(use: ToolUseBlock): SubagentLabel | null {
  try {
    const args = JSON.parse(use.inputJSON);
    const subtype = typeof args?.subagent_type === 'string' ? args.subagent_type : '';
    const description = typeof args?.description === 'string' ? args.description : '';
    if (!subtype && !description) return null;
    const short = (description || subtype).trim();
    const full = subtype && description ? `${subtype} · ${description}` : subtype || description;
    return { short: truncateLabel(short, 22), full };
  } catch {
    return null;
  }
}

function truncateLabel(s: string, max: number): string {
  const compact = s.replace(/\s+/g, ' ').trim();
  return compact.length > max ? compact.slice(0, max - 1) + '…' : compact;
}

function shortId(id: string): string {
  if (id === '__sidechain__') return 'sidechain';
  return id.length > 8 ? id.slice(-8) : id;
}
