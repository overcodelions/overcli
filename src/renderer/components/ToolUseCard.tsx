import { useState } from 'react';
import { ToolResultBlock, ToolUseBlock } from '@shared/types';
import { useStore } from '../store';
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
}: {
  use: ToolUseBlock;
  result?: ToolResultBlock;
  compact?: boolean;
}) {
  const openFile = useStore((s) => s.openFile);
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
    return <BashCard args={args} result={result} compact={compact} />;
  }
  if (use.name === 'TodoWrite') {
    return <TodoWriteCard args={args} />;
  }
  if (use.name === 'AskUserQuestion') {
    return <AskUserQuestionCard use={use} args={args} />;
  }
  if (use.name === 'ExitPlanMode') {
    return <ExitPlanModeCard use={use} args={args} />;
  }
  return <GenericToolCard use={use} />;
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
function AskUserQuestionCard({ use, args }: { use: ToolUseBlock; args: Record<string, any> }) {
  const [selections, setSelections] = useState<Record<number, Set<number>>>({});
  const [submitted, setSubmitted] = useState(false);
  const questions: Array<{ header?: string; question?: string; multiple?: boolean; options?: Array<{ label: string; description?: string }> }> =
    Array.isArray(args.questions) ? args.questions : [];
  const send = useStore((s) => s.send);
  const convId = useStore((s) => s.selectedConversationId);

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

  const canSubmit = questions.length > 0 && questions.every((_, i) => (selections[i]?.size ?? 0) > 0);

  const submit = () => {
    if (!canSubmit || !convId) return;
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
          <div className="text-[10px] text-ink-faint italic">(question still streaming…)</div>
        ) : (
          questions.map((q, qi) => {
            const multiple = !!q.multiple;
            return (
              <div key={qi} className="flex flex-col gap-1.5">
                <div className="text-ink">{q.header ?? q.question}</div>
                {q.question && q.question !== q.header && (
                  <div className="text-[10px] text-ink-faint">{q.question}</div>
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
                            <div className="text-[10px] text-ink-faint">{opt.description}</div>
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
      </div>
      <div className="flex justify-end gap-2 px-3 py-2 border-t border-blue-500/30">
        {submitted ? (
          <span className="text-[10px] text-blue-300">Answer sent</span>
        ) : (
          <button
            onClick={submit}
            disabled={!canSubmit}
            className="text-xs px-3 py-1 rounded bg-blue-500/25 text-blue-100 hover:bg-blue-500/40 disabled:opacity-40"
          >
            Submit
          </button>
        )}
      </div>
    </div>
  );
}

/// ExitPlanMode — claude proposed a plan and wants user approval. We
/// submit "Approved, proceed" or "Denied, keep discussing" as the next
/// user turn; claude will take it from there.
function ExitPlanModeCard({ use, args }: { use: ToolUseBlock; args: Record<string, any> }) {
  const plan = typeof args.plan === 'string' ? args.plan : '';
  const [decided, setDecided] = useState<'approved' | 'denied' | null>(null);
  const send = useStore((s) => s.send);
  const convId = useStore((s) => s.selectedConversationId);

  const respond = (approved: boolean) => {
    if (!convId) return;
    setDecided(approved ? 'approved' : 'denied');
    const msg = approved
      ? 'Approved — go ahead with the plan.'
      : 'Denied — let\'s keep iterating on the plan first.';
    void send(convId, msg);
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
