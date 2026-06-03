import { useEffect, useState } from 'react';
import { ToolResultBlock, ToolUseBlock, UUID } from '@shared/types';
import { useStore } from '../store';
import { useInsideSubagentDrawer, useOpenFile } from '../openFile';
import { useRunnerEvents, useSubagentEvents, useTaskProgress } from '../runnersStore';
import { Diff } from './DiffView';

/// Generic card for a single tool_use block. Specialized renderings (file
/// edits, bash commands, reads) branch by `use.name`. The optional
/// `result` is the tool's return value — specialized cards use it to
/// inline a ✓/✗ badge instead of showing the result as a separate row.
///
/// `compact` collapses the card to a single header row — used by the
/// transient "now doing" slot, which is hard-clipped to ~3rem so all
/// cards in that slot share a stable footprint.
export function ToolUseCard({
  use,
  result,
  compact = false,
  conversationId,
}: {
  use: ToolUseBlock;
  result?: ToolResultBlock;
  compact?: boolean;
  /// The conversation this card is rendered inside. Needed for
  /// AskUserQuestion — submitting the answer has to go to THIS chat,
  /// not whatever happens to be selected in the global sidebar. The
  /// previous behavior used `selectedConversationId` and silently
  /// dropped answers into the wrong conversation when the user had
  /// switched away (e.g. between a flow run pane and a regular chat).
  conversationId?: UUID;
}) {
  const openFile = useOpenFile();
  const insideDrawer = useInsideSubagentDrawer();
  const args = parseInput(use.inputJSON);

  if (use.name === 'Edit') {
    return <FileEditCard use={use} args={args} result={result} onOpen={(p) => openFile(p)} />;
  }
  if (use.name === 'MultiEdit') {
    return <MultiEditCard args={args} result={result} onOpen={(p) => openFile(p)} />;
  }
  if (use.name === 'Write') {
    return <FileWriteCard use={use} args={args} result={result} onOpen={(p) => openFile(p)} />;
  }
  if (use.name === 'Read') {
    return <FileReadCard use={use} args={args} result={result} onOpen={(p) => openFile(p)} />;
  }
  if (use.name === 'Bash') {
    // The drawer is narrow; collapse Bash to its one-line header so the
    // subagent transcript stays scannable. Main-conversation cards keep
    // the full command + expandable output behavior.
    return <BashCard args={args} result={result} compact={compact || insideDrawer} />;
  }
  if (use.name === 'TodoWrite') {
    return <TodoWriteCard args={args} />;
  }
  if (use.name === 'AskUserQuestion') {
    return <AskUserQuestionCard use={use} args={args} conversationId={conversationId} />;
  }
  if (use.name === 'ExitPlanMode') {
    return <ExitPlanModeCard args={args} conversationId={conversationId} />;
  }
  if (use.name === 'Workflow') {
    return <WorkflowCard use={use} args={args} result={result} conversationId={conversationId} />;
  }
  if (use.name === 'Task' || use.name === 'Agent') {
    return <SubagentCard use={use} args={args} result={result} conversationId={conversationId} />;
  }
  return <GenericToolCard use={use} />;
}

/// Inline card for a Task/Agent tool call. The subagent's own stream
/// (assistant text, nested tool uses, tool results) is captured in a
/// per-parent bucket on the renderer's runner state; we show a compact
/// summary here and route the user to the SubagentDrawer for the full
/// transcript. Live event-count badge gives a "agent is doing
/// something" pulse without flooding the main conversation.
function SubagentCard({
  use,
  args,
  result,
  conversationId: conversationIdProp,
}: {
  use: ToolUseBlock;
  args: Record<string, any>;
  result?: ToolResultBlock;
  /// The conversation this card is rendered inside. Required when the
  /// card is rendered outside a sidebar-selected conversation (e.g.
  /// inside a flow step's transcript) — without it the events lookup
  /// silently falls back to `selectedConversationId`, which is null in
  /// flows mode, so the card stays stuck on "starting…" and the drawer
  /// opens against the wrong runner.
  conversationId?: UUID;
}) {
  const selectedConversationId = useStore((s) => s.selectedConversationId);
  const conversationId = conversationIdProp ?? selectedConversationId;
  const openSubagentDrawer = useStore((s) => s.openSubagentDrawer);
  const events = useSubagentEvents(conversationId, use.id);
  const subtype: string = typeof args.subagent_type === 'string' ? args.subagent_type : '';
  const description: string = typeof args.description === 'string' ? args.description : '';
  const summary = summarizeSubagentEvents(events);
  const isDone = !!result;
  // Re-render once a second while the agent is running so the elapsed
  // counter ticks up. No-op when the agent has finished.
  const now = useNow(!isDone && events.length > 0, 1000);
  const elapsedMs =
    summary.startedAt > 0
      ? (isDone ? summary.endedAt || now : now) - summary.startedAt
      : 0;
  return (
    <button
      onClick={() => openSubagentDrawer(use.id, conversationId ?? undefined)}
      className="w-full text-left rounded-lg border border-indigo-500/35 bg-indigo-500/10 dark:bg-indigo-500/[0.10] text-xs hover:bg-indigo-500/20 transition-colors"
    >
      <div className="flex flex-col gap-0.5 px-3 py-1.5">
        <div className="flex items-center gap-2">
          <span className="text-indigo-400 text-[10px] uppercase tracking-wide font-medium">
            Agent
          </span>
          {subtype && (
            <span className="text-ink text-[11px] font-medium">{subtype}</span>
          )}
          {description && (
            <span className="text-ink-faint text-[10px] truncate flex-1">
              {description}
            </span>
          )}
          <span className="ml-auto text-[10px] text-indigo-300 flex items-center gap-1.5">
            <span>{isDone ? '✓' : events.length > 0 ? '●' : '…'}</span>
            {events.length > 0 ? (
              <>
                <span>{summary.toolUseCount} tool{summary.toolUseCount === 1 ? '' : 's'}</span>
                {summary.totalTokens > 0 && (
                  <span className="text-ink-faint">· {formatTokens(summary.totalTokens)} tok</span>
                )}
                {elapsedMs > 0 && (
                  <span className="text-ink-faint">· {formatElapsed(elapsedMs)}</span>
                )}
              </>
            ) : (
              <span>starting…</span>
            )}
          </span>
          <span className="text-[10px] text-ink-faint">open ▸</span>
        </div>
        {/* Currently doing — the most recent tool call, summarized.
            Mirrors Claude CLI's "Searching for 4 patterns..." line. */}
        {summary.currentActivity && (
          <div className="text-[10px] text-ink-faint truncate pl-[3.25rem]">
            <span className="text-indigo-300/70">{summary.currentActivity.name}</span>
            {summary.currentActivity.detail && (
              <span> · {summary.currentActivity.detail}</span>
            )}
          </div>
        )}
      </div>
    </button>
  );
}

/// Inline card for a `Workflow` tool call. Unlike a subagent, a workflow
/// runs as a detached background task: the tool_result lands almost
/// immediately ("launched in background") and the real progress arrives
/// out-of-band as `taskProgress` events, bucketed by this tool_use id.
/// We render the live phase/agent breakdown so the card resolves to a
/// real result instead of sitting on the launch message forever.
function WorkflowCard({
  use,
  args,
  result,
  conversationId: conversationIdProp,
}: {
  use: ToolUseBlock;
  args: Record<string, any>;
  result?: ToolResultBlock;
  conversationId?: UUID;
}) {
  const selectedConversationId = useStore((s) => s.selectedConversationId);
  const conversationId = conversationIdProp ?? selectedConversationId;
  const progress = useTaskProgress(conversationId, use.id);
  const [expanded, setExpanded] = useState(true);

  // Name comes from the workflow's own meta once progress lands; before
  // that, fall back to the tool input (the SDK sends `name` for saved
  // workflows, otherwise the script is inline under `script`).
  const name =
    progress?.workflowName ||
    (typeof args.name === 'string' ? args.name : '') ||
    'workflow';
  const description = progress?.description || '';
  const agents = progress?.agents ?? [];
  const isDone = progress?.phase === 'completed';
  const isError =
    !!result?.isError || (progress?.status ? /fail|error/i.test(progress.status) : false);
  // Progress arrives out-of-band and is NOT persisted to the on-disk
  // transcript, so a reloaded conversation has the tool_result (the
  // "launched in background" ack) but no progress. Distinguish that
  // historical case from a genuinely just-launched run (no result yet) so
  // we don't imply a finished workflow is still running. During a live
  // run task_started lands before the tool_result, so neither fallback
  // shows once progress exists.
  const historical = !progress && !!result;

  const doneCount = agents.filter((a) => a.state === 'done').length;
  const statusIcon = isError
    ? '✗'
    : isDone
      ? '✓'
      : agents.length > 0
        ? '●'
        : historical
          ? '▸'
          : '…';

  return (
    <div className="rounded-lg border border-violet-500/35 bg-violet-500/10 dark:bg-violet-500/[0.10] text-xs">
      <button
        onClick={() => setExpanded((e) => !e)}
        className="w-full text-left px-3 py-1.5 flex items-center gap-2"
      >
        <span className="text-violet-400 text-[10px] uppercase tracking-wide font-medium">
          Workflow
        </span>
        <span className="text-ink text-[11px] font-medium truncate">{name}</span>
        <span className="ml-auto flex items-center gap-1.5 text-[10px] text-violet-300">
          <span>{statusIcon}</span>
          {agents.length > 0 && (
            <span>
              {doneCount}/{agents.length} agent{agents.length === 1 ? '' : 's'}
            </span>
          )}
          {progress?.totalTokens ? (
            <span className="text-ink-faint">· {formatTokens(progress.totalTokens)} tok</span>
          ) : null}
          {isDone && progress?.durationMs ? (
            <span className="text-ink-faint">· {formatElapsed(progress.durationMs)}</span>
          ) : null}
        </span>
        <span className="text-[10px] text-ink-faint">{expanded ? '▾' : '▸'}</span>
      </button>
      {expanded && (
        <div className="px-3 pb-2 flex flex-col gap-1.5">
          {description && (
            <div className="text-[10px] text-ink-faint">{description}</div>
          )}
          {agents.length === 0 &&
            (historical ? (
              // Reloaded from history — progress wasn't persisted. The
              // final results live in the assistant message below; point
              // there instead of faking live activity.
              <div className="text-[10px] text-ink-faint italic">
                Ran in background — results in the reply below.
              </div>
            ) : (
              <div className="text-[10px] text-ink-faint italic">Starting in background…</div>
            ))}
          {agents.map((a) => (
            <div key={a.index} className="flex items-start gap-2">
              <span className="mt-0.5 text-[10px] text-violet-300/80 w-3 flex-shrink-0">
                {a.state === 'done' ? '✓' : a.state === 'error' ? '✗' : a.state === 'start' ? '●' : '○'}
              </span>
              <div className="flex flex-col min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="text-ink text-[11px] font-medium truncate">{a.label}</span>
                  {a.phaseTitle && (
                    <span className="text-[9px] uppercase tracking-wide text-ink-faint">
                      {a.phaseTitle}
                    </span>
                  )}
                  {a.tokens ? (
                    <span className="ml-auto text-[9px] text-ink-faint">
                      {formatTokens(a.tokens)} tok
                    </span>
                  ) : null}
                </div>
                {/* Once done, the agent's answer; while running, the live
                    tool activity; before either, the prompt preview. */}
                <div className="text-[10px] text-ink-faint truncate">
                  {a.resultPreview
                    ? a.resultPreview
                    : a.lastToolName
                      ? `${a.lastToolName}${a.lastToolSummary ? ` · ${trimDetail(a.lastToolSummary)}` : ''}`
                      : a.promptPreview
                        ? trimDetail(a.promptPreview)
                        : a.state}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/// Drives an interval re-render only while needed. Pass `active=false`
/// (e.g. when the agent has completed) to halt the timer and stop
/// scheduling unnecessary React work.
function useNow(active: boolean, periodMs: number): number {
  const [tick, setTick] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const id = setInterval(() => setTick(Date.now()), periodMs);
    return () => clearInterval(id);
  }, [active, periodMs]);
  return tick;
}

interface SubagentSummary {
  toolUseCount: number;
  totalTokens: number;
  /// Most recent tool call, summarized as one short line ("Bash: …",
  /// "Read /path/to/file", "Grep \"pattern\""). Renders under the
  /// agent name to mirror Claude CLI's live activity preview.
  currentActivity: { name: string; detail: string } | null;
  /// Earliest event timestamp seen for this subagent (ms). Drives the
  /// elapsed-time counter on the inline card.
  startedAt: number;
  /// Latest event timestamp. The card uses this as the "ended" time
  /// once the parent Task tool_result has landed; while running the
  /// card swaps to `Date.now()` instead so the counter keeps ticking.
  endedAt: number;
}

/// Walk a subagent's event bucket and aggregate progress / counters.
/// Cache tokens are excluded from the headline total since they're not
/// what a user means by "tokens used" — input + output matches Claude
/// CLI's number. Tool-use counting dedupes by event id so a partial
/// snapshot + final assistant don't double-count.
function summarizeSubagentEvents(
  events: { id: string; timestamp: number; kind: { type: string; info?: any; results?: any[] } }[],
): SubagentSummary {
  const lastById = new Map<string, any>();
  let startedAt = 0;
  let endedAt = 0;
  for (const e of events) {
    if (startedAt === 0 || e.timestamp < startedAt) startedAt = e.timestamp;
    if (e.timestamp > endedAt) endedAt = e.timestamp;
    if (e.kind.type !== 'assistant') continue;
    lastById.set(e.id, e.kind.info);
  }
  let toolUseCount = 0;
  let totalTokens = 0;
  let latestUse: { name: string; inputJSON: string } | null = null;
  // Iterate in event arrival order so the last toolUse we see is the
  // newest. `lastById.values()` preserves insertion order (Map spec).
  for (const info of lastById.values()) {
    const uses = Array.isArray(info?.toolUses) ? info.toolUses : [];
    toolUseCount += uses.length;
    if (uses.length > 0) {
      const u = uses[uses.length - 1];
      latestUse = { name: u.name, inputJSON: u.inputJSON };
    }
    if (info?.usage) {
      totalTokens += (info.usage.inputTokens ?? 0) + (info.usage.outputTokens ?? 0);
    }
  }
  return {
    toolUseCount,
    totalTokens,
    currentActivity: latestUse ? toolActivityLine(latestUse) : null,
    startedAt,
    endedAt,
  };
}

/// Produce the "currently doing" one-liner from a tool call. Each tool
/// gets a hand-picked detail field (file_path for Read, command for
/// Bash, pattern for Grep, …). Unknown tools fall back to truncating
/// the raw input JSON so the line is never blank.
function toolActivityLine(use: { name: string; inputJSON: string }): { name: string; detail: string } {
  let input: any = {};
  try {
    input = JSON.parse(use.inputJSON);
  } catch {
    // ignore — incomplete partial JSON during streaming
  }
  switch (use.name) {
    case 'Bash':
      return { name: 'Bash', detail: trimDetail(input.description || input.command || '') };
    case 'Read':
      return { name: 'Read', detail: trimDetail(input.file_path || '') };
    case 'Write':
      return { name: 'Write', detail: trimDetail(input.file_path || '') };
    case 'Edit':
    case 'MultiEdit':
      return { name: use.name, detail: trimDetail(input.file_path || '') };
    case 'Grep':
      return { name: 'Grep', detail: input.pattern ? `"${trimDetail(input.pattern)}"` : '' };
    case 'Glob':
      return { name: 'Glob', detail: trimDetail(input.pattern || '') };
    case 'WebFetch':
      return { name: 'WebFetch', detail: trimDetail(input.url || '') };
    case 'WebSearch':
      return { name: 'WebSearch', detail: input.query ? `"${trimDetail(input.query)}"` : '' };
    case 'TodoWrite':
      return { name: 'TodoWrite', detail: `${Array.isArray(input.todos) ? input.todos.length : 0} items` };
    case 'Task':
    case 'Agent':
      return { name: 'Agent', detail: trimDetail(input.subagent_type || input.description || '') };
    default:
      return { name: use.name, detail: trimDetail(use.inputJSON.replace(/^\{|\}$/g, '')) };
  }
}

function trimDetail(s: string): string {
  const trimmed = s.replace(/\s+/g, ' ').trim();
  return trimmed.length > 60 ? trimmed.slice(0, 57) + '…' : trimmed;
}

function formatElapsed(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const totalSec = Math.floor(ms / 1000);
  if (totalSec < 60) return `${totalSec}s`;
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  if (min < 60) return `${min}m ${sec}s`;
  const hr = Math.floor(min / 60);
  return `${hr}h ${min % 60}m`;
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 10_000) return `${Math.round(n / 1000)}k`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return `${n}`;
}

function StatusBadge({ result }: { result?: ToolResultBlock }) {
  if (!result) return null;
  return result.isError ? (
    <span className="text-[10px] text-red-400 ml-auto">✗ failed</span>
  ) : (
    <span className="text-[10px] text-green-400/80 ml-auto">✓</span>
  );
}

function GenericToolCard({ use }: { use: ToolUseBlock }) {
  const [expanded, setExpanded] = useState(false);
  const preview = use.inputJSON.slice(0, 120);
  return (
    <div className="rounded-lg border border-card bg-card text-xs">
      <button
        onClick={() => setExpanded((e) => !e)}
        className="w-full flex items-center gap-2 px-3 py-1.5 text-left text-ink-muted hover:bg-card"
      >
        <span className="text-ink-faint">{expanded ? '▾' : '▸'}</span>
        <span className="font-medium">{use.name}</span>
        {!expanded && <span className="truncate text-ink-faint">{preview}</span>}
      </button>
      {expanded && (
        <pre className="px-3 pb-2 text-[11px] text-ink-muted overflow-x-auto select-text">{use.inputJSON}</pre>
      )}
    </div>
  );
}

function FileEditCard({ use, args, result, onOpen }: { use: ToolUseBlock; args: Record<string, any>; result?: ToolResultBlock; onOpen: (p: string) => void }) {
  const path = use.filePath ?? args.file_path ?? args.path ?? '';
  // Different backends key the before/after text differently — claude
  // uses `old_string`/`new_string`, codex's `apply_patch` function often
  // sends `old_str`/`new_str`, older payloads carry `old_text`/`new_text`.
  const oldS =
    use.oldString ?? args.old_string ?? args.old_str ?? args.old_text ?? '';
  const newS =
    use.newString ?? args.new_string ?? args.new_str ?? args.new_text ?? '';
  // Edit cards get a visible border so the diff pane reads as its own
  // surface — tool cards without diffs rely on bg-card only.
  return (
    <div className="rounded-lg border border-card bg-card text-xs overflow-hidden">
      <div className="flex items-center gap-2 px-3 py-1.5">
        <span className="text-amber-400 text-[10px] uppercase tracking-wide font-medium">Edit</span>
        <code
          className="text-ink cursor-pointer hover:underline select-text"
          onClick={() => path && onOpen(path)}
        >
          {path || '(no path)'}
        </code>
        <StatusBadge result={result} />
      </div>
      {oldS || newS ? (
        <DiffBlock oldS={oldS} newS={newS} />
      ) : (
        <div className="px-3 py-2 text-[10px] text-ink-faint italic">
          (edit details still streaming…)
        </div>
      )}
    </div>
  );
}

/// MultiEdit: same file, multiple separate edits. Render each hunk with
/// its own inline diff so you can see what changed across the patch.
function MultiEditCard({ args, result, onOpen }: { args: Record<string, any>; result?: ToolResultBlock; onOpen: (p: string) => void }) {
  const path = typeof args.file_path === 'string' ? args.file_path : '';
  const edits: Array<{ old_string?: string; new_string?: string }> = Array.isArray(args.edits)
    ? args.edits
    : [];
  return (
    <div className="rounded-lg border border-card bg-card text-xs overflow-hidden">
      <div className="flex items-center gap-2 px-3 py-1.5">
        <span className="text-amber-400 text-[10px] uppercase tracking-wide font-medium">MultiEdit</span>
        <code
          className="text-ink cursor-pointer hover:underline select-text"
          onClick={() => path && onOpen(path)}
        >
          {path || '(no path)'}
        </code>
        <span className="text-[10px] text-ink-faint">{edits.length} edit{edits.length === 1 ? '' : 's'}</span>
        <StatusBadge result={result} />
      </div>
      {edits.length === 0 ? (
        <div className="px-3 py-2 text-[10px] text-ink-faint italic">(edit details still streaming…)</div>
      ) : (
        edits.map((e, i) => (
          <div key={i} className="border-t border-card first:border-t-0">
            <div className="px-3 py-1 text-[10px] text-ink-faint bg-card">Edit {i + 1}</div>
            <DiffBlock oldS={e.old_string ?? ''} newS={e.new_string ?? ''} />
          </div>
        ))
      )}
    </div>
  );
}

/// AskUserQuestion — claude asks the user to pick one or more options
/// from each question. We submit the picked answers back as the next
/// user turn so claude's context includes the selection.
function AskUserQuestionCard({
  use,
  args,
  conversationId,
}: {
  use: ToolUseBlock;
  args: Record<string, any>;
  /// Target conversation for the answer. MUST be the conversation the
  /// card is rendered inside. Falling back to `selectedConversationId`
  /// was the source of a cross-conversation leak: if the user opened a
  /// flow run while a different conversation was selected in the
  /// sidebar, hitting Submit sent the answer to that other conversation
  /// instead of the flow's chat.
  conversationId?: UUID;
}) {
  const [selections, setSelections] = useState<Record<number, Set<number>>>({});
  const [other, setOther] = useState('');
  const [submitted, setSubmitted] = useState(false);
  const questions: Array<{ header?: string; question?: string; multiple?: boolean; options?: Array<{ label: string; description?: string }> }> =
    Array.isArray(args.questions) ? args.questions : [];
  const send = useStore((s) => s.send);
  const selectedConvId = useStore((s) => s.selectedConversationId);
  // Prefer the prop (the conversation we're actually rendered in); fall
  // back to the global selection only when nobody supplied one (legacy
  // call sites we haven't updated yet).
  const convId = conversationId ?? selectedConvId;

  const toggle = (q: number, o: number, multiple: boolean) => {
    setSelections((cur) => {
      const existing = new Set(cur[q] ?? []);
      if (multiple) {
        if (existing.has(o)) existing.delete(o);
        else existing.add(o);
      } else {
        existing.clear();
        existing.add(o);
      }
      return { ...cur, [q]: existing };
    });
  };

  const otherTrimmed = other.trim();
  const hasOther = otherTrimmed.length > 0;
  const canSubmit =
    hasOther ||
    (questions.length > 0 && questions.every((_, i) => (selections[i]?.size ?? 0) > 0));

  const submit = () => {
    if (!canSubmit || !convId) return;
    if (hasOther) {
      void send(convId, otherTrimmed);
      setSubmitted(true);
      return;
    }
    const lines: string[] = [];
    for (let i = 0; i < questions.length; i++) {
      const q = questions[i];
      const picks = Array.from(selections[i] ?? [])
        .sort((a, b) => a - b)
        .map((idx) => q.options?.[idx]?.label ?? '')
        .filter(Boolean);
      if (picks.length === 0) continue;
      lines.push(`- ${q.header ?? q.question ?? 'Q'}: ${picks.join(', ')}`);
    }
    const header = questions.length > 1 ? 'Answers:' : 'Answer:';
    void send(convId, [header, ...lines].join('\n'));
    setSubmitted(true);
  };

  return (
    <div className="rounded-lg border border-blue-500/35 bg-blue-500/15 dark:bg-blue-500/[0.12] text-xs">
      <div className="px-3 py-1.5 border-b border-blue-500/30 text-[10px] uppercase tracking-wide text-blue-800 dark:text-blue-200 font-semibold">
        Assistant is asking
      </div>
      <div className="px-3 py-2 flex flex-col gap-3">
        {questions.length === 0 ? (
          // The tool_use input never parsed into a `questions` array
          // (incomplete partial JSON, an empty payload from the model,
          // or — currently — the SDK transport not surfacing the
          // consolidated assistant message). The old "(still streaming…)"
          // wording lied once the turn ended; just route the user at
          // the free-text reply that's always rendered below.
          <div className="text-[10px] text-ink-faint italic">
            No options provided — type your reply below.
          </div>
        ) : (
          questions.map((q, qi) => {
            const multiple = !!q.multiple;
            return (
              <div key={qi} className="flex flex-col gap-1.5">
                <div className="text-ink">{q.header ?? q.question}</div>
                {q.question && q.question !== q.header && (
                  <div className="text-[10px] text-ink-muted">{q.question}</div>
                )}
                <div className="flex flex-col gap-1">
                  {(q.options ?? []).map((opt, oi) => {
                    const picked = selections[qi]?.has(oi) ?? false;
                    return (
                      <button
                        key={oi}
                        disabled={submitted}
                        onClick={() => toggle(qi, oi, multiple)}
                        className={
                          'text-left px-2.5 py-1.5 rounded border flex items-start gap-2 ' +
                          (picked
                            ? 'border-blue-500 bg-blue-500/25'
                            : 'border-transparent bg-blue-500/5 hover:bg-blue-500/15') +
                          (submitted ? ' opacity-50 cursor-not-allowed' : '')
                        }
                      >
                        <div
                          className={
                            'mt-0.5 w-3 h-3 flex-shrink-0 ' +
                            (multiple ? 'rounded-[3px]' : 'rounded-full') +
                            ' border ' +
                            (picked ? 'border-blue-500 bg-blue-500' : 'border-blue-500/50')
                          }
                        />
                        <div className="flex-1">
                          <div className="text-ink">{opt.label}</div>
                          {opt.description && (
                            <div className="text-[10px] text-ink-muted">{opt.description}</div>
                          )}
                        </div>
                      </button>
                    );
                  })}
                </div>
              </div>
            );
          })
        )}
        <div className="flex flex-col gap-1 pt-1 border-t border-blue-500/20">
          <div className="text-[10px] text-ink-muted">Or type your own response</div>
          <textarea
            value={other}
            disabled={submitted}
            onChange={(e) => setOther(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                submit();
              }
            }}
            placeholder="Reply in your own words…"
            rows={2}
            className="w-full resize-y bg-blue-500/5 border border-blue-500/20 rounded px-2 py-1.5 text-xs text-ink placeholder:text-ink-faint focus:outline-none focus:border-blue-500/60 disabled:opacity-50"
          />
        </div>
      </div>
      <div className="flex justify-end gap-2 px-3 py-2 border-t border-blue-500/30">
        {submitted ? (
          <span className="text-[10px] text-blue-300">Answer sent</span>
        ) : (
          <button
            onClick={submit}
            disabled={!canSubmit}
            className="text-xs px-3 py-1 rounded bg-accent text-white hover:bg-accent-600 disabled:opacity-40"
          >
            {hasOther ? 'Send reply' : 'Submit'}
          </button>
        )}
      </div>
    </div>
  );
}

/// ExitPlanMode — claude proposed a plan and wants user approval.
///
/// In plan mode the broker (CLI or SDK transport) gates ExitPlanMode like
/// any other tool: it emits a permissionRequest and *blocks* Claude until
/// we resolve it. Approve resolves `allow` (Claude leaves plan mode and
/// implements in the same turn); Deny resolves `deny` (it stays in plan
/// mode and revises). We must resolve that real request — auto-allowing it
/// at the broker used to let the model barrel straight into coding while
/// this card's buttons sat unclicked.
///
/// Modes that don't route ExitPlanMode through the broker (bypassPermissions
/// never wires the prompt tool) leave no pending request; there the model
/// has already proceeded, so we fall back to a follow-up message.
function ExitPlanModeCard({
  args,
  conversationId: conversationIdProp,
}: {
  args: Record<string, any>;
  conversationId?: UUID;
}) {
  const plan = typeof args.plan === 'string' ? args.plan : '';
  const send = useStore((s) => s.send);
  const respondPermission = useStore((s) => s.respondPermission);
  const setPermissionMode = useStore((s) => s.setPermissionMode);
  const selectedConversationId = useStore((s) => s.selectedConversationId);
  const convId = conversationIdProp ?? selectedConversationId;
  const events = useRunnerEvents(convId);

  // The matching pending gate, if any. Only one plan is ever in flight per
  // conversation, so the most recent ExitPlanMode request is ours.
  const planReq = (() => {
    if (!events) return undefined;
    for (let i = events.length - 1; i >= 0; i--) {
      const k = events[i].kind;
      if (k.type === 'permissionRequest' && k.info.toolName === 'ExitPlanMode') return k.info;
    }
    return undefined;
  })();

  const [localDecided, setLocalDecided] = useState<'approved' | 'denied' | null>(null);
  const decided: 'approved' | 'denied' | null =
    planReq?.decided === 'allow'
      ? 'approved'
      : planReq?.decided === 'deny'
        ? 'denied'
        : localDecided;

  const respond = (approved: boolean) => {
    if (!convId) return;
    setLocalDecided(approved ? 'approved' : 'denied');
    // Approve drops out of plan mode so subsequent turns execute;
    // setPermissionMode is synchronous in the store, so this commits.
    if (approved) void setPermissionMode(convId, 'default');
    if (planReq && !planReq.decided) {
      // Resolve the real gate Claude is blocked on.
      void respondPermission(convId, planReq.requestId, approved);
      return;
    }
    // No pending gate (e.g. bypassPermissions): the model already left plan
    // mode, so route the decision as the next user turn.
    void send(
      convId,
      approved
        ? 'Approved — go ahead with the plan.'
        : 'Denied — let\'s keep iterating on the plan first.',
    );
  };

  return (
    <div className="rounded-lg border border-emerald-500/35 bg-emerald-500/12 dark:bg-emerald-500/[0.10] text-xs">
      <div className="px-3 py-1.5 border-b border-emerald-500/30 text-[10px] uppercase tracking-wide text-emerald-800 dark:text-emerald-200 font-semibold">
        Plan — approval needed
      </div>
      <div className="px-3 py-2">
        <pre className="whitespace-pre-wrap font-sans select-text text-ink">{plan || '(plan streaming…)'}</pre>
      </div>
      <div className="flex justify-end gap-2 px-3 py-2 border-t border-emerald-500/30">
        {decided ? (
          <span
            className={
              'text-[10px] ' +
              (decided === 'approved' ? 'text-emerald-300' : 'text-red-300')
            }
          >
            {decided === 'approved' ? '✓ Approved' : '✗ Denied'}
          </span>
        ) : (
          <>
            <button
              onClick={() => respond(false)}
              className="text-xs px-3 py-1 rounded text-ink-muted hover:text-ink hover:bg-card"
            >
              Deny
            </button>
            <button
              onClick={() => respond(true)}
              className="text-xs px-3 py-1 rounded bg-emerald-500/25 text-emerald-100 hover:bg-emerald-500/40"
            >
              Approve
            </button>
          </>
        )}
      </div>
    </div>
  );
}

function FileWriteCard({ use, args, result, onOpen }: { use: ToolUseBlock; args: Record<string, any>; result?: ToolResultBlock; onOpen: (p: string) => void }) {
  const path = use.filePath ?? args.file_path ?? '';
  const content = typeof args.content === 'string' ? args.content : '';
  const [expanded, setExpanded] = useState(false);
  return (
    <div className="rounded-lg text-xs bg-card text-ink-muted px-3 py-1.5">
      <div className="flex items-center gap-2">
        <span className="text-green-400 text-[10px] uppercase tracking-wide font-medium">Write</span>
        <code
          className="text-ink cursor-pointer hover:underline truncate"
          onClick={() => path && onOpen(path)}
        >
          {path}
        </code>
        <span className="text-ink-faint text-[10px]">{content.split('\n').length} lines</span>
        <StatusBadge result={result} />
        <button
          onClick={() => setExpanded((e) => !e)}
          className="ml-2 text-[10px] text-ink-faint hover:text-ink"
        >
          {expanded ? 'collapse' : 'expand'}
        </button>
      </div>
      {expanded && (
        <pre className="mt-1 text-[11px] font-mono whitespace-pre-wrap overflow-x-auto select-text">
          {content}
        </pre>
      )}
    </div>
  );
}

function FileReadCard({ use, args, result, onOpen }: { use: ToolUseBlock; args: Record<string, any>; result?: ToolResultBlock; onOpen: (p: string) => void }) {
  const path = use.filePath ?? args.file_path ?? '';
  return (
    <div className="rounded-lg text-xs bg-card text-ink-muted px-3 py-1.5">
      <div className="flex items-center gap-2">
        <span className="text-blue-400 text-[10px] uppercase tracking-wide font-medium">Read</span>
        <code
          className="text-ink cursor-pointer hover:underline flex-1 truncate"
          onClick={() => path && onOpen(path)}
        >
          {path}
        </code>
        <StatusBadge result={result} />
      </div>
    </div>
  );
}

function BashCard({
  args,
  result,
  compact = false,
}: {
  args: Record<string, any>;
  result?: ToolResultBlock;
  compact?: boolean;
}) {
  const cmd = typeof args.command === 'string' ? args.command : '';
  const [showOutput, setShowOutput] = useState(false);
  const hasOutput = !!result?.content && result.content.trim().length > 0;
  const isError = !!result?.isError;
  // Compact: collapse to a single header row for the transient "now
  // doing" slot, which clips at 3rem. Header shows description (or the
  // command itself as a fallback) so the slot still tells the user what
  // bash is running without spilling onto a clipped second row.
  if (compact) {
    return (
      <div className="rounded-lg bg-card text-xs overflow-hidden">
        <div className="flex items-center gap-2 px-3 py-1.5">
          <span className="text-purple-400 text-[10px] uppercase tracking-wide font-medium">Bash</span>
          <span className="text-ink-faint truncate text-[10px] flex-1 min-w-0">
            {args.description || cmd}
          </span>
          <StatusBadge result={result} />
        </div>
      </div>
    );
  }
  return (
    <div className="rounded-lg bg-card text-xs overflow-hidden">
      <div className="flex items-center gap-2 px-3 py-1.5">
        <span className="text-purple-400 text-[10px] uppercase tracking-wide font-medium">Bash</span>
        {args.description && <span className="text-ink-faint truncate text-[10px]">{args.description}</span>}
        <StatusBadge result={result} />
        {hasOutput && (
          <button
            onClick={() => setShowOutput((s) => !s)}
            className="text-[10px] text-ink-faint hover:text-ink ml-1"
          >
            {showOutput ? 'hide output' : 'show output'}
          </button>
        )}
      </div>
      {/* Command: mono with a terminal-style $ prefix, no hard separator
       * between command and output — instead the output sits as an
       * indented nested panel so the card reads as one continuous
       * surface with a slightly inset transcript below. */}
      <div className="px-3 pb-2 flex gap-2 text-[11px] font-mono text-ink-muted overflow-x-auto">
        <span className="text-ink-faint select-none">$</span>
        <span className="whitespace-pre-wrap break-all select-text flex-1">{cmd}</span>
      </div>
      {hasOutput && showOutput && (
        <div className="mx-2 mb-2">
          <pre
            className={
              'rounded-md px-3 py-2 text-[11px] font-mono whitespace-pre-wrap overflow-x-auto select-text ' +
              (isError
                ? 'bg-red-500/[0.08] text-red-300'
                : 'bg-black/20 dark:bg-black/30 text-ink-muted')
            }
          >
            {result!.content}
          </pre>
        </div>
      )}
    </div>
  );
}

function TodoWriteCard({ args }: { args: Record<string, any> }) {
  const todos: any[] = Array.isArray(args.todos) ? args.todos : [];
  return (
    <div className="rounded-lg border border-card bg-card text-xs px-3 py-2">
      <div className="text-[10px] uppercase tracking-wide font-medium text-amber-400 mb-1">Todos</div>
      <div className="flex flex-col gap-1">
        {todos.map((t, i) => (
          <div key={i} className="flex items-start gap-2 text-ink-muted">
            <span className="mt-0.5 text-ink-faint">{statusIcon(t.status)}</span>
            <span className={t.status === 'completed' ? 'line-through text-ink-faint' : ''}>
              {t.activeForm ?? t.content ?? ''}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

function statusIcon(status: string | undefined): string {
  switch (status) {
    case 'completed':
      return '✓';
    case 'in_progress':
      return '●';
    case 'pending':
    default:
      return '○';
  }
}

function DiffBlock({ oldS, newS }: { oldS: string; newS: string }) {
  return (
    <div className="overflow-x-auto">
      <Diff oldText={oldS} newText={newS} />
    </div>
  );
}

function parseInput(raw: string): Record<string, any> {
  try {
    const parsed = JSON.parse(raw);
    return typeof parsed === 'object' && parsed ? parsed : {};
  } catch {
    return {};
  }
}
