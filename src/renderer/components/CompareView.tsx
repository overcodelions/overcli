import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { diffLines } from 'diff';

/// A run of lines that either match on both sides (`equal`) or differ
/// (`change`, where `aLines`/`bLines` are that side's version — either may
/// be empty for a pure insertion or deletion).
type Block =
  | { kind: 'equal'; lines: string[] }
  | { kind: 'change'; aLines: string[]; bLines: string[] };

/// A working snapshot of both sides' text — the unit we push onto the
/// undo/redo stacks.
interface Pair {
  a: string;
  b: string;
}

/// Two-file comparison picked from the file tree (⌥-click a file, then
/// ⌥-click a second). Reads both via the same `fs:readFile` IPC the editor
/// uses, diffs them line-by-line, and lets the user move any changed block
/// onto the other side (← stages it into the left file, → into the right).
///
/// Moves are staged in memory — nothing touches disk until Save (⌘S).
/// Undo/redo (⌘Z / ⌘⇧Z) walk the move history, and closing with unsaved
/// moves prompts before discarding. Purely local; no git involved.
export function CompareView({
  pathA,
  pathB,
  rootPath,
  onClose,
  onDirtyChange,
}: {
  pathA: string;
  pathB: string;
  rootPath: string;
  onClose: () => void;
  /// Reports whether there are unsaved moves so the parent can guard
  /// navigation away from the comparison.
  onDirtyChange?: (dirty: boolean) => void;
}) {
  const [base, setBase] = useState<{ resolvedA: string; resolvedB: string } | null>(null);
  // `saved` tracks the last-persisted content so we can compute dirtiness
  // and only write the side(s) that actually changed. `work` is the live,
  // possibly-unsaved content shown in the diff.
  const [saved, setSaved] = useState<Pair | null>(null);
  const [work, setWork] = useState<Pair | null>(null);
  const [undoStack, setUndoStack] = useState<Pair[]>([]);
  const [redoStack, setRedoStack] = useState<Pair[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    setWork(null);
    setSaved(null);
    setBase(null);
    setUndoStack([]);
    setRedoStack([]);
    Promise.all([
      window.overcli.invoke('fs:readFile', { path: pathA, rootPath }),
      window.overcli.invoke('fs:readFile', { path: pathB, rootPath }),
    ])
      .then(([a, b]) => {
        if (cancelled) return;
        if (!a.ok) return setError(`${basename(pathA)}: ${a.error}`);
        if (!b.ok) return setError(`${basename(pathB)}: ${b.error}`);
        setBase({ resolvedA: a.resolvedPath, resolvedB: b.resolvedPath });
        setSaved({ a: a.content, b: b.content });
        setWork({ a: a.content, b: b.content });
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [pathA, pathB, rootPath]);

  const blocks = useMemo(() => (work ? buildBlocks(work.a, work.b) : []), [work]);
  const dirty = !!work && !!saved && (work.a !== saved.a || work.b !== saved.b);
  const identical = !!work && work.a === work.b;

  // Stage a change block by copying one side's version onto the other.
  // `target` is which file receives it: 'a' (left, ← ) or 'b' (right, → ).
  const applyBlock = useCallback(
    (index: number, target: 'a' | 'b') => {
      if (!work || blocks[index]?.kind !== 'change') return;
      // Preserve the target file's trailing-newline convention — join('\n')
      // alone would drop a final newline the file originally had.
      const origSide = target === 'a' ? work.a : work.b;
      let content = rebuild(blocks, target, index);
      if (origSide.endsWith('\n') && !content.endsWith('\n')) content += '\n';
      const nextWork: Pair =
        target === 'a' ? { a: content, b: work.b } : { a: work.a, b: content };
      setUndoStack((us) => [...us, work]);
      setRedoStack([]);
      setWork(nextWork);
    },
    [work, blocks],
  );

  const undo = useCallback(() => {
    if (!work || !undoStack.length) return;
    const prev = undoStack[undoStack.length - 1];
    setRedoStack((rs) => [...rs, work]);
    setUndoStack((us) => us.slice(0, -1));
    setWork(prev);
  }, [work, undoStack]);

  const redo = useCallback(() => {
    if (!work || !redoStack.length) return;
    const next = redoStack[redoStack.length - 1];
    setUndoStack((us) => [...us, work]);
    setRedoStack((rs) => rs.slice(0, -1));
    setWork(next);
  }, [work, redoStack]);

  const save = useCallback(async () => {
    if (!base || !work || !saved || saving || !dirty) return;
    const writes: { path: string; content: string }[] = [];
    if (work.a !== saved.a) writes.push({ path: base.resolvedA, content: work.a });
    if (work.b !== saved.b) writes.push({ path: base.resolvedB, content: work.b });
    setSaving(true);
    setError(null);
    try {
      for (const w of writes) {
        const res = await window.overcli.invoke('fs:writeFile', w);
        if (!res.ok) {
          setError(`${basename(w.path)}: ${res.error}`);
          return;
        }
      }
      setSaved({ a: work.a, b: work.b });
    } finally {
      setSaving(false);
    }
  }, [base, work, saved, saving, dirty]);

  const requestClose = useCallback(() => {
    if (dirty && !window.confirm('Discard unsaved changes to these files?')) return;
    onClose();
  }, [dirty, onClose]);

  // Surface dirtiness to the parent, and clear it on unmount so a later
  // comparison doesn't inherit a stale "dirty" guard.
  useEffect(() => {
    onDirtyChange?.(dirty);
  }, [dirty, onDirtyChange]);
  useEffect(() => () => onDirtyChange?.(false), [onDirtyChange]);

  // Keyboard: ⌘/Ctrl+S saves, ⌘/Ctrl+Z undoes, ⌘/Ctrl+⇧Z redoes. Latest
  // handlers live in a ref so the listener is registered once.
  const handlers = useRef({ save, undo, redo });
  handlers.current = { save, undo, redo };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey)) return;
      const k = e.key.toLowerCase();
      if (k === 's') {
        e.preventDefault();
        void handlers.current.save();
      } else if (k === 'z' && !e.shiftKey) {
        e.preventDefault();
        handlers.current.undo();
      } else if ((k === 'z' && e.shiftKey) || k === 'y') {
        e.preventDefault();
        handlers.current.redo();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  return (
    <div className="flex flex-col h-full min-h-0">
      <div className="flex items-center gap-2 px-3 py-1.5 text-[11px] border-b border-card bg-surface-muted">
        <span className="text-ink-muted shrink-0">Compare</span>
        <span className="font-mono text-red-400 truncate" title={pathA}>
          ◀ {basename(pathA)}
        </span>
        <span className="text-ink-faint shrink-0">vs</span>
        <span className="font-mono text-green-400 truncate" title={pathB}>
          {basename(pathB)} ▶
        </span>
        {dirty && (
          <span className="shrink-0 h-1.5 w-1.5 rounded-full bg-amber-300" title="Unsaved changes" />
        )}
        <div className="ml-auto flex items-center gap-1 shrink-0">
          <button
            type="button"
            onClick={undo}
            disabled={!undoStack.length || saving}
            title="Undo (⌘Z)"
            aria-label="Undo"
            className="flex h-5 w-5 items-center justify-center rounded text-ink-faint hover:text-ink hover:bg-card disabled:opacity-30"
          >
            ↺
          </button>
          <button
            type="button"
            onClick={redo}
            disabled={!redoStack.length || saving}
            title="Redo (⌘⇧Z)"
            aria-label="Redo"
            className="flex h-5 w-5 items-center justify-center rounded text-ink-faint hover:text-ink hover:bg-card disabled:opacity-30"
          >
            ↻
          </button>
          <button
            type="button"
            onClick={() => void save()}
            disabled={!dirty || saving}
            title="Save (⌘S)"
            className="px-2 h-5 rounded bg-accent/30 text-ink hover:bg-accent/50 disabled:opacity-30 disabled:hover:bg-accent/30"
          >
            {saving ? 'Saving…' : 'Save'}
          </button>
          <button
            type="button"
            onClick={requestClose}
            title="Close comparison"
            aria-label="Close comparison"
            className="flex h-5 w-5 items-center justify-center rounded text-ink-faint hover:text-ink hover:bg-card"
          >
            ×
          </button>
        </div>
      </div>

      <div className="flex-1 overflow-auto min-h-0">
        {loading ? (
          <div className="text-xs text-ink-faint px-3 py-2">Loading…</div>
        ) : error ? (
          <div className="text-xs text-amber-300/80 px-3 py-2">{error}</div>
        ) : identical ? (
          <div className="text-xs text-ink-faint px-3 py-2">Files are identical.</div>
        ) : (
          <BlockDiff blocks={blocks} onApply={applyBlock} nameA={basename(pathA)} nameB={basename(pathB)} />
        )}
      </div>

      {!loading && !error && (
        <div className="px-3 py-1.5 text-[10px] text-ink-faint border-t border-card bg-surface-muted flex items-center gap-3 flex-wrap">
          <span>Hover a change to move it:</span>
          <span><span className="text-ink-muted">←</span> into left ({basename(pathA)})</span>
          <span><span className="text-ink-muted">→</span> into right ({basename(pathB)})</span>
          <span className="ml-auto">⌘S save · ⌘Z undo</span>
        </div>
      )}
    </div>
  );
}

/// Renders the block list with line numbers and, on each changed block, a
/// pair of hover controls to stage that block onto the other side.
function BlockDiff({
  blocks,
  onApply,
  nameA,
  nameB,
}: {
  blocks: Block[];
  onApply: (index: number, target: 'a' | 'b') => void;
  nameA: string;
  nameB: string;
}) {
  let aLine = 1;
  let bLine = 1;
  return (
    <div className="font-mono text-[11px]">
      {blocks.map((block, i) => {
        if (block.kind === 'equal') {
          const rows = block.lines.map((text, j) => (
            <Row key={j} a={aLine + j} b={bLine + j} sigil=" " text={text} />
          ));
          aLine += block.lines.length;
          bLine += block.lines.length;
          return <div key={i}>{rows}</div>;
        }
        const removed = block.aLines.map((text, j) => (
          <Row key={'a' + j} a={aLine + j} sigil="-" text={text} tone="remove" />
        ));
        const added = block.bLines.map((text, j) => (
          <Row key={'b' + j} b={bLine + j} sigil="+" text={text} tone="add" />
        ));
        aLine += block.aLines.length;
        bLine += block.bLines.length;
        return (
          <div key={i} className="relative group">
            {removed}
            {added}
            <div className="absolute right-2 top-0.5 flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
              <button
                type="button"
                onClick={() => onApply(i, 'a')}
                title={`Move right → left: stage this block into ${nameA}`}
                className="px-1.5 h-5 rounded bg-card-strong text-ink-muted hover:text-ink hover:bg-accent/30 text-[11px]"
              >
                ←
              </button>
              <button
                type="button"
                onClick={() => onApply(i, 'b')}
                title={`Move left → right: stage this block into ${nameB}`}
                className="px-1.5 h-5 rounded bg-card-strong text-ink-muted hover:text-ink hover:bg-accent/30 text-[11px]"
              >
                →
              </button>
            </div>
          </div>
        );
      })}
    </div>
  );
}

function Row({
  a,
  b,
  sigil,
  text,
  tone,
}: {
  a?: number;
  b?: number;
  sigil: string;
  text: string;
  tone?: 'add' | 'remove';
}) {
  const bg = tone === 'add' ? 'diff-add-row' : tone === 'remove' ? 'diff-remove-row' : '';
  const sigilColor =
    tone === 'add' ? 'diff-add-ink' : tone === 'remove' ? 'diff-remove-ink' : 'text-ink-faint';
  return (
    <div className={'flex whitespace-pre select-text ' + bg}>
      <span className="w-10 flex-shrink-0 text-right pr-1 text-ink-faint">{a ?? ''}</span>
      <span className="w-10 flex-shrink-0 text-right pr-2 text-ink-faint">{b ?? ''}</span>
      <span className={'w-4 flex-shrink-0 pl-1 ' + sigilColor}>{sigil}</span>
      <span className="flex-1 pr-16">{text}</span>
    </div>
  );
}

/// Group the line-level diff into equal / change blocks. Consecutive
/// removed and/or added parts coalesce into one change block so a
/// modification (remove immediately followed by add) is a single unit the
/// user can move as a whole.
function buildBlocks(a: string, b: string): Block[] {
  const parts = diffLines(a, b);
  const blocks: Block[] = [];
  let pending: { aLines: string[]; bLines: string[] } | null = null;
  const flush = () => {
    if (pending) {
      blocks.push({ kind: 'change', aLines: pending.aLines, bLines: pending.bLines });
      pending = null;
    }
  };
  for (const p of parts) {
    const lines = splitLines(p.value);
    if (!p.added && !p.removed) {
      flush();
      if (lines.length) blocks.push({ kind: 'equal', lines });
    } else {
      if (!pending) pending = { aLines: [], bLines: [] };
      if (p.removed) pending.aLines.push(...lines);
      else pending.bLines.push(...lines);
    }
  }
  flush();
  return blocks;
}

/// Reconstruct one `side`'s full file text from the block list. `equal`
/// blocks contribute their shared lines; `change` blocks contribute the
/// side's own lines — except the block at `overrideIndex`, which takes the
/// *other* side's lines (that's the move being staged).
function rebuild(blocks: Block[], side: 'a' | 'b', overrideIndex: number): string {
  const out: string[] = [];
  blocks.forEach((block, i) => {
    if (block.kind === 'equal') {
      out.push(...block.lines);
    } else if (i === overrideIndex) {
      out.push(...(side === 'a' ? block.bLines : block.aLines));
    } else {
      out.push(...(side === 'a' ? block.aLines : block.bLines));
    }
  });
  return out.join('\n');
}

/// Split a diff part's value into lines, dropping the trailing empty
/// element that a value ending in "\n" produces.
function splitLines(value: string): string[] {
  const lines = value.split('\n');
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

function basename(p: string): string {
  return p.split(/[/\\]/).pop() ?? p;
}
