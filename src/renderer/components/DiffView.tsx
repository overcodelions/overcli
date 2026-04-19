import { useState } from 'react';
import { diffLines } from 'diff';

/// Generic per-line diff row type consumed by both the unified-diff
/// parser (for patches emitted by codex) and the before/after diff
/// synthesized from Edit tool params (old_string vs new_string).
interface DiffLine {
  kind: 'add' | 'remove' | 'context' | 'hunk' | 'file';
  /// The rendered text for this line (without the leading +/- sigil; we
  /// render that ourselves).
  text: string;
  /// 1-based line number in the old file at this position (undefined for
  /// added lines and hunk headers).
  oldLine?: number;
  /// 1-based line number in the new file at this position (undefined for
  /// removed lines and hunk headers).
  newLine?: number;
}

interface Hunk {
  header: string;
  lines: DiffLine[];
}

/// Single diff renderer shared across every backend. Supply *either*
/// `oldText` + `newText` (claude's Edit tool: we synthesize the diff
/// ourselves) or a pre-baked `unifiedDiff` string (codex's patch_apply).
/// Callers don't care which shape the backend emits — they just get the
/// same row styling, sigil column, and hunk headers.
export function Diff({
  oldText,
  newText,
  unifiedDiff,
  compact = false,
  emptyLabel = '(empty diff)',
}: {
  oldText?: string;
  newText?: string;
  unifiedDiff?: string;
  compact?: boolean;
  emptyLabel?: string;
}) {
  const baseClass = 'font-mono ' + (compact ? 'text-[10.5px]' : 'text-[11px]');

  if (typeof unifiedDiff === 'string') {
    const hunks = parseUnifiedDiff(unifiedDiff);
    if (hunks.length === 0) {
      return <div className="px-3 py-2 text-[10px] text-ink-faint italic">{emptyLabel}</div>;
    }
    return (
      <div className={baseClass}>
        {hunks.map((h, i) => (
          <HunkBlock key={i} hunk={h} />
        ))}
      </div>
    );
  }

  const lines = diffOldNew(oldText ?? '', newText ?? '');
  if (lines.length === 0) {
    return <div className="px-3 py-2 text-[10px] text-ink-faint italic">{emptyLabel}</div>;
  }
  return (
    <div className={baseClass}>
      {lines.map((line, i) => (
        <DiffRow key={i} line={line} />
      ))}
    </div>
  );
}


function HunkBlock({ hunk }: { hunk: Hunk }) {
  return (
    <div className="border-t border-card first:border-t-0">
      <div className="px-3 py-1 text-[10px] text-ink-faint bg-card">
        {hunk.header}
      </div>
      <div>
        {hunk.lines.map((line, i) => (
          <DiffRow key={i} line={line} />
        ))}
      </div>
    </div>
  );
}


function DiffRow({ line }: { line: DiffLine }) {
  if (line.kind === 'hunk') {
    return (
      <div className="px-3 py-0.5 text-ink-faint bg-card text-[10px]">{line.text}</div>
    );
  }
  if (line.kind === 'file') {
    return (
      <div className="px-3 py-1 text-ink-muted text-[10px]">{line.text}</div>
    );
  }
  const bg =
    line.kind === 'add'
      ? 'diff-add-row'
      : line.kind === 'remove'
      ? 'diff-remove-row'
      : '';
  const sigil =
    line.kind === 'add' ? '+' : line.kind === 'remove' ? '-' : ' ';
  const sigilColor =
    line.kind === 'add'
      ? 'diff-add-ink'
      : line.kind === 'remove'
      ? 'diff-remove-ink'
      : 'text-ink-faint';
  return (
    <div className={'flex whitespace-pre select-text ' + bg}>
      <span className="w-10 flex-shrink-0 text-right pr-1 text-ink-faint">
        {line.oldLine ?? ''}
      </span>
      <span className="w-10 flex-shrink-0 text-right pr-2 text-ink-faint">
        {line.newLine ?? ''}
      </span>
      <span className={'w-4 flex-shrink-0 pl-1 ' + sigilColor}>{sigil}</span>
      <span className="flex-1 pr-3">{line.text}</span>
    </div>
  );
}

// --- Parsers ---

/// Parse a unified-diff string into hunks. Handles standard `@@ -a,b
/// +c,d @@` hunk headers and drops file-header lines (---, +++). Each
/// line's `oldLine` / `newLine` is computed incrementally from the hunk
/// base.
function parseUnifiedDiff(diff: string): Hunk[] {
  const hunks: Hunk[] = [];
  let current: Hunk | null = null;
  let oldCursor = 0;
  let newCursor = 0;

  for (const raw of diff.split('\n')) {
    if (raw.startsWith('@@')) {
      if (current) hunks.push(current);
      // @@ -10,5 +10,7 @@ optional trailing context
      const m = raw.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/);
      if (!m) continue;
      oldCursor = parseInt(m[1], 10);
      newCursor = parseInt(m[3], 10);
      current = {
        header: raw,
        lines: [],
      };
      continue;
    }
    if (raw.startsWith('---') || raw.startsWith('+++') || raw.startsWith('diff ') || raw.startsWith('index ')) {
      // File header lines — surface as a subtle label only.
      if (raw.startsWith('+++') || raw.startsWith('---')) continue;
      if (!current) {
        hunks.push({
          header: '',
          lines: [{ kind: 'file', text: raw }],
        });
      } else {
        current.lines.push({ kind: 'file', text: raw });
      }
      continue;
    }
    if (!current) continue;
    const sigil = raw[0];
    const body = raw.slice(1);
    if (sigil === '+') {
      current.lines.push({ kind: 'add', text: body, newLine: newCursor });
      newCursor += 1;
    } else if (sigil === '-') {
      current.lines.push({ kind: 'remove', text: body, oldLine: oldCursor });
      oldCursor += 1;
    } else if (sigil === ' ' || sigil === undefined) {
      current.lines.push({
        kind: 'context',
        text: body,
        oldLine: oldCursor,
        newLine: newCursor,
      });
      oldCursor += 1;
      newCursor += 1;
    } else if (sigil === '\\') {
      // `\ No newline at end of file` marker — surface as context, no
      // line numbers, doesn't advance the cursor.
      current.lines.push({ kind: 'context', text: raw });
    }
  }
  if (current) hunks.push(current);
  return hunks;
}

function diffOldNew(oldText: string, newText: string): DiffLine[] {
  const parts = diffLines(oldText, newText);
  const out: DiffLine[] = [];
  let oldLine = 1;
  let newLine = 1;
  for (const p of parts) {
    const lines = p.value.split('\n');
    // diffLines returns parts whose .value ends with \n for complete lines;
    // splitting gives us a trailing empty string we want to skip.
    if (lines.length && lines[lines.length - 1] === '') lines.pop();
    for (const l of lines) {
      if (p.added) {
        out.push({ kind: 'add', text: l, newLine });
        newLine += 1;
      } else if (p.removed) {
        out.push({ kind: 'remove', text: l, oldLine });
        oldLine += 1;
      } else {
        out.push({ kind: 'context', text: l, oldLine, newLine });
        oldLine += 1;
        newLine += 1;
      }
    }
  }
  return out;
}

/// Small expandable wrapper that shows a 3-line preview of a diff and a
/// button to expand to full. Used for PatchApply when a single file's
/// hunk is huge and we don't want to unroll hundreds of lines by default.
export function CollapsibleDiffView({
  children,
  lineCount,
  defaultOpen = true,
}: {
  children: React.ReactNode;
  lineCount: number;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen || lineCount <= 40);
  return (
    <div>
      {open ? (
        children
      ) : (
        <button
          onClick={() => setOpen(true)}
          className="w-full text-[10px] text-ink-faint hover:text-ink py-1.5 hover:bg-card-strong text-center"
        >
          show diff ({lineCount} lines)
        </button>
      )}
      {open && lineCount > 40 && (
        <button
          onClick={() => setOpen(false)}
          className="w-full text-[10px] text-ink-faint hover:text-ink py-1 hover:bg-card-strong text-center"
        >
          collapse
        </button>
      )}
    </div>
  );
}
