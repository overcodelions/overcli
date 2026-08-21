import { useRef, useState } from 'react';
import { AssistantEventInfo, ToolResultBlock, ToolUseBlock, UUID } from '@shared/types';
import { backendColor, backendFromModel, shortModel } from '../theme';
import { Markdown } from './Markdown';
import { useStore } from '../store';
import { openPathWithHighlight, useOpenFile } from '../openFile';
import { ToolUseCard } from './ToolUseCard';

/// Tool names that must stay visible when tool activity is hidden,
/// because they block the conversation on user input.
const INTERACTIVE_TOOLS = new Set(['AskUserQuestion', 'ExitPlanMode']);

/// Tool names whose cards stay visible even when tool activity is hidden
/// — edits and writes are meaningful output, TodoWrite is live state the
/// user is tracking against, and Task/Agent dispatches are the inline
/// SubagentCard, which is the user's only handle to open the drawer and
/// see what the subagent is doing. Keep in sync with PERSISTENT_TOOLS
/// in ChatView.tsx.
const PERSISTENT_TOOLS = new Set(['Edit', 'MultiEdit', 'Write', 'TodoWrite', 'Task', 'Agent']);

export function AssistantBubble({
  info,
  toolResultIndex,
  endorsed,
  endorsementTint,
  forceShowTools,
  conversationId,
}: {
  info: AssistantEventInfo;
  toolResultIndex?: Map<string, ToolResultBlock>;
  /// When true, render a small check next to the CLI label inside the
  /// bubble. Used by the rebound renderer to mark the verdict bubble
  /// of a completed reviewer round.
  endorsed?: boolean;
  endorsementTint?: string;
  /// Bypass the global `showToolActivity` toggle and render every
  /// tool_use card. Used by SubagentDrawer — the whole point of
  /// opening that drawer is to inspect the agent's tool calls, so
  /// hiding them based on the chat-level toggle would be useless.
  forceShowTools?: boolean;
  /// Conversation this bubble is rendered inside — threaded through to
  /// ToolUseCard so AskUserQuestion answers go to the right chat.
  conversationId?: UUID;
}) {
  const openFile = useOpenFile();
  const showToolActivityGlobal = useStore((s) => s.showToolActivity);
  const showToolActivity = forceShowTools || showToolActivityGlobal;
  const [copied, setCopied] = useState<'plain' | 'raw' | null>(null);
  const renderedRef = useRef<HTMLDivElement>(null);
  const backend = backendFromModel(info.model);
  const tint = backendColor(backend);
  // Local models put their whole working narrative in the reasoning channel
  // and frequently leave `text` empty, so on Ollama the thinking block IS
  // the visible output rather than an aside. Cloud backends keep the quiet
  // collapsed default — there the answer carries the story.
  const showReasoningInline = backend === 'ollama';

  // Claude occasionally emits the same AskUserQuestion call twice in one
  // assistant turn (model glitch), which renders as two identical question
  // cards stacked on top of each other. Collapse identical AskUserQuestion
  // tool_uses by their input payload so the user sees one card.
  const dedupedToolUses = dedupeAskUserQuestion(info.toolUses);
  const visibleToolUses = showToolActivity
    ? dedupedToolUses
    : dedupedToolUses.filter(
        (u) => INTERACTIVE_TOOLS.has(u.name) || PERSISTENT_TOOLS.has(u.name),
      );

  // Hide the machine-readable <watch_report> block the flow watcher emits for
  // the runtime to parse — the human-facing status already shows in the watch
  // banner + log, so the transcript only needs the surrounding prose. ("copy
  // raw" below still copies the full untouched text.)
  const displayText = stripWatchReport(info.text);
  const hasContent = displayText.length > 0;
  const hasThinking = info.thinking.some((t) => t.trim().length > 0);
  const hasTools = visibleToolUses.length > 0;
  if (!hasContent && !hasThinking && !hasTools && !info.hasOpaqueReasoning) return null;

  return (
    <div className="flex flex-col gap-1.5">
      {info.thinking.map((think, i) => (
        <ThinkingBlock
          key={i}
          text={think}
          label={backend === 'codex' ? 'codex thinking' : 'thinking'}
          live={showReasoningInline && info.isPartial}
          tailPreview={showReasoningInline}
        />
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
          <div className="px-4 py-2.5 pl-[14px]" ref={renderedRef}>
            {(info.model || endorsed) && (
              <div
                className="text-[10px] font-medium mb-1 flex items-center gap-1"
                style={{ color: tint }}
              >
                {info.model && <span>{shortModel(info.model)}</span>}
                {endorsed && (
                  <svg
                    width="11"
                    height="11"
                    viewBox="0 0 16 16"
                    fill="none"
                    aria-label="verdict"
                    style={{ color: endorsementTint ?? tint }}
                  >
                    <path
                      d="M3.5 8.5L6.5 11.5L12.5 4.5"
                      stroke="currentColor"
                      strokeWidth="2"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                  </svg>
                )}
              </div>
            )}
            <Markdown source={displayText} onOpenPath={(p) => openPathWithHighlight(p, openFile)} />
          </div>
          <div className="absolute top-1.5 right-2.5 flex items-center gap-2">
            <button
              onClick={() => {
                const plain = renderedRef.current?.innerText ?? info.text;
                navigator.clipboard.writeText(plain);
                setCopied('plain');
                setTimeout(() => setCopied(null), 1200);
              }}
              className="text-[10px] text-ink-faint hover:text-ink"
            >
              {copied === 'plain' ? 'copied' : 'copy'}
            </button>
            <button
              onClick={() => {
                navigator.clipboard.writeText(info.text);
                setCopied('raw');
                setTimeout(() => setCopied(null), 1200);
              }}
              className="text-[10px] text-ink-faint hover:text-ink"
            >
              {copied === 'raw' ? 'copied' : 'copy raw'}
            </button>
          </div>
        </div>
      )}
      {/* Tool-use cards render INSIDE the assistant bubble so they're
          visually attached to the turn that produced them. Without this
          block Edit/Write/Bash tool calls showed no UI at all — the
          tool_use data was in `info.toolUses` but we weren't rendering
          it, which is why inline diffs were missing. */}
      {hasTools &&
        visibleToolUses.map((use) => (
          <ToolUseCard
            key={use.id}
            use={use}
            result={toolResultIndex?.get(use.id)}
            conversationId={conversationId}
          />
        ))}
    </div>
  );
}

function dedupeAskUserQuestion(toolUses: ToolUseBlock[]): ToolUseBlock[] {
  const seen = new Set<string>();
  const out: ToolUseBlock[] = [];
  for (const u of toolUses) {
    if (u.name === 'AskUserQuestion') {
      const key = askUserQuestionKey(u.inputJSON);
      if (seen.has(key)) continue;
      seen.add(key);
    }
    out.push(u);
  }
  return out;
}

// Lenient content key: collapse cards that ask the same thing even when
// the raw inputJSON differs (whitespace, key order, partial-stream
// fragments, model rephrasing the prompt). Only the bits that affect
// what the user picks count toward identity — question headers and the
// set of option labels.
function askUserQuestionKey(inputJSON: string): string {
  let parsed: any;
  try {
    parsed = JSON.parse(inputJSON);
  } catch {
    return inputJSON;
  }
  const questions = Array.isArray(parsed?.questions) ? parsed.questions : [];
  const norm = (s: unknown) => (typeof s === 'string' ? s.trim().toLowerCase() : '');
  const parts: string[] = [];
  for (const q of questions) {
    const head = norm(q?.header) || norm(q?.question);
    const opts = Array.isArray(q?.options)
      ? q.options.map((o: any) => norm(o?.label)).filter(Boolean).sort().join('|')
      : '';
    parts.push(`${head}::${opts}`);
  }
  return parts.join('§');
}

/// Replace the flow watcher's machine-readable `<watch_report>…</watch_report>`
/// block with its human `note`, rendered as a blockquote — the per-tick
/// takeaway. So the transcript shows "what this tick actually did" instead of
/// raw JSON (or, before, nothing — which left only terse mid-process
/// narration). The structured fields are still parsed by the runtime; here we
/// only surface the summary. A partial block mid-stream is dropped so nothing
/// flashes in. No-op for any text without the tag, so it's safe on all bubbles.
function stripWatchReport(text: string): string {
  const replaceWithNote = (_m: string, inner: string): string => {
    const note = extractWatchNote(inner);
    return note ? `\n\n> ${note}\n` : '';
  };
  return text
    .replace(/```[a-z]*\s*<watch_report>([\s\S]*?)<\/watch_report>\s*```/gi, replaceWithNote)
    .replace(/<watch_report>([\s\S]*?)<\/watch_report>/gi, replaceWithNote)
    .replace(/<watch_report>[\s\S]*$/i, '') // partial block still streaming
    .trim();
}

/// Pull the `note` string out of a (possibly partial) watch_report body without
/// a full JSON parse — tolerant of the model's formatting quirks.
function extractWatchNote(inner: string): string | null {
  const m = /"note"\s*:\s*"((?:[^"\\]|\\.)*)"/i.exec(inner);
  if (!m) return null;
  try {
    return JSON.parse(`"${m[1]}"`).trim() || null;
  } catch {
    return m[1].trim() || null;
  }
}

function ThinkingBlock({
  text,
  label,
  live,
  tailPreview,
}: {
  text: string;
  label: string;
  /// Streaming right now. Auto-expands so the reasoning is visible as it
  /// arrives, then collapses on its own once the round settles. Only set
  /// for Ollama — see the note on `showReasoningInline`.
  live?: boolean;
  /// Show the LAST line under a collapsed header. Only set for Ollama.
  tailPreview?: boolean;
}) {
  // Header-only when collapsed — no preview text. Earlier we showed
  // the first 2 lines as a preview, which on long conversations made
  // thinking blocks dominate the chat visually. Now the collapsed
  // state is a single muted line ("▸ thinking · 4 lines"); transparency
  // is one click away when you want it.
  //
  // Ollama is the exception, because its content channel is usually EMPTY:
  // the model reasons, calls a tool, and writes no prose at all. A
  // header-only row there isn't a tidy summary of a visible answer, it's
  // the entire record of a step — a five-minute run rendering as a stack of
  // bare "▸ THINKING" strips with nothing to read. So local runs get a live
  // auto-expand plus a one-line tail preview, while the cloud backends keep
  // the quiet collapsed default.
  const [override, setOverride] = useState<boolean | null>(null);
  // `live` drives the default, but an explicit click always wins and sticks
  // — otherwise the block would fight the user by re-collapsing mid-stream.
  const expanded = override ?? !!live;
  const lines = text.trim().split('\n').filter((l) => l.trim().length > 0);
  const lineCount = lines.length;
  // The tail, not the head: models state their conclusion last ("Let me list
  // the directory to see what's actually in src/main"), so the final line is
  // what makes a collapsed stack skimmable as a narrative.
  const tail = lines.length > 0 ? lines[lines.length - 1] : '';
  return (
    <div className="rounded-lg text-xs text-ink-faint italic pl-3 pr-3 py-1.5 relative overflow-hidden bg-card">
      <div className="absolute left-0 top-0 bottom-0 w-[2px] bg-ink-faint/30" />
      <button
        onClick={() => setOverride(!expanded)}
        className="flex items-center gap-1.5 text-ink-faint hover:text-ink-muted uppercase text-[9px] tracking-wider"
      >
        <span>{expanded ? '▾' : '▸'}</span>
        <span>
          {label}
          {lineCount > 1 ? ` · ${lineCount} lines` : ''}
        </span>
      </button>
      {expanded && <div className="whitespace-pre-wrap mt-1">{text}</div>}
      {!expanded && tailPreview && tail && (
        <div className="mt-0.5 truncate opacity-70" title={tail}>
          {tail}
        </div>
      )}
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
