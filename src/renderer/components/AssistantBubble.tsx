import { useState } from 'react';
import { AssistantEventInfo, ToolResultBlock } from '@shared/types';
import { backendColor, backendFromModel, shortModel } from '../theme';
import { Markdown } from './Markdown';
import { useStore } from '../store';
import { ToolUseCard } from './ToolUseCard';

/// Tool names that must stay visible when tool activity is hidden,
/// because they block the conversation on user input.
const INTERACTIVE_TOOLS = new Set(['AskUserQuestion', 'ExitPlanMode']);

/// Tool names whose cards stay visible even when tool activity is hidden
/// — edits and writes are meaningful output, and TodoWrite is live state
/// the user is tracking against, not tool noise. Keep in sync with
/// PERSISTENT_TOOLS in ChatView.tsx.
const PERSISTENT_TOOLS = new Set(['Edit', 'MultiEdit', 'Write', 'TodoWrite']);

export function AssistantBubble({
  info,
  toolResultIndex,
}: {
  info: AssistantEventInfo;
  toolResultIndex?: Map<string, ToolResultBlock>;
}) {
  const openFile = useStore((s) => s.openFile);
  const showToolActivity = useStore((s) => s.showToolActivity);
  const [copied, setCopied] = useState(false);
  const backend = backendFromModel(info.model);
  const tint = backendColor(backend);

  const visibleToolUses = showToolActivity
    ? info.toolUses
    : info.toolUses.filter(
        (u) => INTERACTIVE_TOOLS.has(u.name) || PERSISTENT_TOOLS.has(u.name),
      );

  const hasContent = info.text.length > 0;
  const hasThinking = info.thinking.some((t) => t.trim().length > 0);
  const hasTools = visibleToolUses.length > 0;
  if (!hasContent && !hasThinking && !hasTools && !info.hasOpaqueReasoning) return null;

  return (
    <div className="flex flex-col gap-1.5">
      {info.thinking.map((think, i) => (
        <ThinkingBlock key={i} text={think} label={backend === 'codex' ? 'codex thinking' : 'thinking'} />
      ))}
      {info.hasOpaqueReasoning && !hasThinking && <OpaqueReasoningPill tint={tint} />}
      {hasContent && (
        <div
          className="relative rounded-xl overflow-hidden"
          style={{
            background: `color-mix(in srgb, ${tint} 5%, transparent)`,
            border: `1px solid color-mix(in srgb, ${tint} 18%, transparent)`,
          }}
        >
          <div
            className="absolute left-0 top-0 bottom-0 w-[2px]"
            style={{ background: tint + 'cc' }}
          />
          <div className="px-4 py-2.5 pl-[14px]">
            {info.model && (
              <div className="text-[10px] font-medium mb-1" style={{ color: tint }}>
                {shortModel(info.model)}
              </div>
            )}
            <Markdown source={info.text} onOpenPath={(p) => handleOpenPath(p, openFile)} />
          </div>
          <button
            onClick={() => {
              navigator.clipboard.writeText(info.text);
              setCopied(true);
              setTimeout(() => setCopied(false), 1200);
            }}
            className="absolute top-1.5 right-2.5 text-[10px] text-ink-faint hover:text-ink"
          >
            {copied ? 'copied' : 'copy'}
          </button>
        </div>
      )}
      {/* Tool-use cards render INSIDE the assistant bubble so they're
          visually attached to the turn that produced them. Without this
          block Edit/Write/Bash tool calls showed no UI at all — the
          tool_use data was in `info.toolUses` but we weren't rendering
          it, which is why inline diffs were missing. */}
      {hasTools &&
        visibleToolUses.map((use) => (
          <ToolUseCard key={use.id} use={use} result={toolResultIndex?.get(use.id)} />
        ))}
    </div>
  );
}

function handleOpenPath(path: string, openFile: (p: string, highlight?: any) => void) {
  // path may have `:NN` or `:NN-MM` suffix; parse off and pass as highlight.
  const m = path.match(/^(.+?):(\d+)(?:[-:](\d+))?$/);
  if (m) {
    const start = parseInt(m[2], 10);
    const end = m[3] ? parseInt(m[3], 10) : start;
    openFile(m[1], { startLine: start, endLine: end, requestId: crypto.randomUUID() });
  } else {
    openFile(path);
  }
}

function ThinkingBlock({ text, label }: { text: string; label: string }) {
  const [expanded, setExpanded] = useState(false);
  const preview = text.trim().split('\n').slice(0, 2).join(' ').slice(0, 200);
  return (
    <div className="rounded-lg text-xs text-ink-faint italic pl-3 pr-3 py-2 relative overflow-hidden bg-card">
      <div className="absolute left-0 top-0 bottom-0 w-[2px] bg-ink-faint/30" />
      <button
        onClick={() => setExpanded((e) => !e)}
        className="flex items-center gap-1.5 text-ink-faint hover:text-ink-muted uppercase text-[9px] tracking-wider mb-1"
      >
        <span>{expanded ? '▾' : '▸'}</span>
        <span>{label}</span>
      </button>
      <div className="whitespace-pre-wrap">{expanded ? text : preview}</div>
    </div>
  );
}

function OpaqueReasoningPill({ tint }: { tint: string }) {
  return (
    <div
      className="text-[10px] uppercase tracking-wider inline-block px-2 py-1 rounded"
      style={{
        background: tint + '22',
        color: tint,
        width: 'fit-content',
      }}
    >
      reasoning · hidden
    </div>
  );
}
