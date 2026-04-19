import { useState } from 'react';
import { ToolResultBlock, ToolUseBlock } from '@shared/types';
import { Markdown } from './Markdown';
import { useStore } from '../store';

export function ToolResultCard({ results, toolUseIndex }: { results: ToolResultBlock[]; toolUseIndex: Map<string, ToolUseBlock> }) {
  return (
    <div className="flex flex-col gap-1.5">
      {results.map((r) => (
        <SingleResult key={r.id} result={r} source={toolUseIndex.get(r.id)} />
      ))}
    </div>
  );
}

/// Subagent-style tools whose result is a free-form markdown report meant
/// to be READ, not a raw tool byproduct. Rendered through the Markdown
/// component so lists / headings / code fences actually format, and kept
/// visible even when tool activity is hidden (see ChatView.filterRendered).
export const AGENT_TOOLS = new Set(['Agent', 'Task']);

function SingleResult({ result, source }: { result: ToolResultBlock; source?: ToolUseBlock }) {
  const openFile = useStore((s) => s.openFile);
  const isAgent = !!source && AGENT_TOOLS.has(source.name);
  // Agent reports are the point of the call — show them by default.
  // Read/Edit/MultiEdit/Write/Bash results are bulky tool byproducts —
  // hide entirely until the user expands. Everything else gets a 3-line
  // peek so the outcome is visible at a glance.
  const [expanded, setExpanded] = useState(isAgent);
  const content = result.content;
  const hideByDefault =
    source?.name === 'Read' ||
    source?.name === 'Edit' ||
    source?.name === 'MultiEdit' ||
    source?.name === 'Write' ||
    source?.name === 'Bash';
  const preview = hideByDefault || isAgent
    ? ''
    : content.split('\n').slice(0, 3).join('\n').slice(0, 240);
  const expandable = hideByDefault || isAgent
    ? content.length > 0
    : content.length > preview.length;
  const showBody = hideByDefault || isAgent ? expanded : true;
  return (
    <div
      className={
        'rounded-lg text-xs px-3 py-1.5 ' +
        (result.isError
          ? 'border border-red-500/30 bg-red-500/5 text-red-300'
          : 'bg-card text-ink-muted')
      }
    >
      <div className="flex items-center gap-2">
        <span className={'text-[10px] uppercase tracking-wide font-medium ' + (result.isError ? 'text-red-400' : 'text-green-400')}>
          {result.isError ? 'Error' : 'Result'}
        </span>
        {source?.name && <span className="text-[10px] text-ink-faint">{source.name}</span>}
        {expandable && (
          <button
            onClick={() => setExpanded((e) => !e)}
            className="ml-auto text-[10px] text-ink-faint hover:text-ink"
          >
            {expanded ? 'collapse' : 'expand'}
          </button>
        )}
      </div>
      {showBody && (
        isAgent ? (
          <div className="mt-1 text-ink">
            <Markdown source={content} onOpenPath={(p) => handleOpenPath(p, openFile)} />
          </div>
        ) : (
          <pre className="mt-1 text-[11px] font-mono whitespace-pre-wrap overflow-x-auto select-text">
            {expanded ? content : preview}
          </pre>
        )
      )}
    </div>
  );
}

function handleOpenPath(
  path: string,
  openFile: (p: string, highlight?: { startLine: number; endLine: number; requestId: string }) => void,
) {
  const m = path.match(/^(.+?):(\d+)(?:[-:](\d+))?$/);
  if (m) {
    const start = parseInt(m[2], 10);
    const end = m[3] ? parseInt(m[3], 10) : start;
    openFile(m[1], { startLine: start, endLine: end, requestId: crypto.randomUUID() });
  } else {
    openFile(path);
  }
}
