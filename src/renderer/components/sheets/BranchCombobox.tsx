import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

interface BranchComboboxProps {
  options: string[];
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  emptyText?: string;
  disabled?: boolean;
  className?: string;
}

interface PopoverPos {
  top: number;
  left: number;
  width: number;
}

export function BranchCombobox({
  options,
  value,
  onChange,
  placeholder,
  emptyText,
  disabled,
  className,
}: BranchComboboxProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [highlight, setHighlight] = useState(0);
  const [pos, setPos] = useState<PopoverPos | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const popoverRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const itemRefs = useRef<(HTMLDivElement | null)[]>([]);

  const filtered = useMemo(() => rankBranches(options, query), [options, query]);

  useEffect(() => {
    setHighlight(0);
  }, [query, options]);

  useLayoutEffect(() => {
    if (!open) return;
    const update = () => {
      const el = triggerRef.current;
      if (!el) return;
      const r = el.getBoundingClientRect();
      setPos({ top: r.bottom + 4, left: r.left, width: r.width });
    };
    update();
    window.addEventListener('resize', update);
    window.addEventListener('scroll', update, true);
    return () => {
      window.removeEventListener('resize', update);
      window.removeEventListener('scroll', update, true);
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      const t = e.target as Node;
      if (triggerRef.current?.contains(t)) return;
      if (popoverRef.current?.contains(t)) return;
      setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open]);

  useLayoutEffect(() => {
    if (!open) return;
    const node = itemRefs.current[highlight];
    if (node) node.scrollIntoView({ block: 'nearest' });
  }, [highlight, open, filtered.length]);

  const openWithFocus = () => {
    if (disabled) return;
    setQuery('');
    setOpen(true);
    requestAnimationFrame(() => inputRef.current?.focus());
  };

  const commit = (branch: string) => {
    onChange(branch);
    setOpen(false);
    setQuery('');
  };

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setHighlight((h) => Math.min(filtered.length - 1, h + 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setHighlight((h) => Math.max(0, h - 1));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const pick = filtered[highlight];
      if (pick) commit(pick);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      setOpen(false);
    } else if (e.key === 'Tab') {
      setOpen(false);
    }
  };

  const fieldClass = className ?? 'field px-3 py-1.5 text-sm';
  const showEmpty = options.length === 0;
  const display = showEmpty ? (placeholder ?? '') : value || (placeholder ?? 'Select branch…');

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        disabled={disabled || showEmpty}
        onClick={() => (open ? setOpen(false) : openWithFocus())}
        className={`${fieldClass} w-full text-left flex items-center justify-between gap-2 ${
          showEmpty || !value ? 'text-ink-faint' : ''
        }`}
      >
        <span className="truncate font-mono">{display}</span>
        <span className="text-ink-faint text-xs flex-shrink-0">▾</span>
      </button>
      {open && pos
        ? createPortal(
            <div
              ref={popoverRef}
              style={{
                position: 'fixed',
                top: pos.top,
                left: pos.left,
                width: pos.width,
                zIndex: 9999,
              }}
              className="rounded border border-card-strong bg-surface-elevated shadow-xl overflow-hidden"
            >
              <input
                ref={inputRef}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={onKey}
                placeholder="Search branches…"
                className="w-full bg-transparent px-3 py-2 border-b border-card text-sm outline-none"
              />
              <div className="max-h-[260px] overflow-y-auto py-1">
                {filtered.length === 0 ? (
                  <div className="px-3 py-2 text-xs text-ink-faint">
                    {emptyText ?? 'No matching branches.'}
                  </div>
                ) : (
                  filtered.map((branch, i) => {
                    const isHi = i === highlight;
                    const isSel = branch === value;
                    return (
                      <div
                        key={branch}
                        ref={(el) => {
                          itemRefs.current[i] = el;
                        }}
                        onMouseEnter={() => setHighlight(i)}
                        onMouseDown={(e) => {
                          e.preventDefault();
                          commit(branch);
                        }}
                        className={
                          'px-3 py-1.5 text-sm font-mono cursor-pointer flex items-center gap-2 ' +
                          (isHi ? 'bg-accent/20 text-ink' : 'text-ink-muted')
                        }
                      >
                        <span className="truncate flex-1">{branch}</span>
                        {isSel && <span className="text-[10px] text-ink-faint">current</span>}
                      </div>
                    );
                  })
                )}
              </div>
            </div>,
            document.body,
          )
        : null}
    </>
  );
}

function rankBranches(branches: string[], query: string): string[] {
  if (!query.trim()) return branches.slice(0, 200);
  const q = query.toLowerCase();
  const scored: Array<[string, number, number]> = [];
  branches.forEach((branch, idx) => {
    const name = branch.toLowerCase();
    let score = 0;
    if (name === q) score = 1000;
    else if (name.startsWith(q)) score = 500 - name.length;
    else if (name.includes(q)) score = 300 - name.length;
    else if (subsequenceMatch(name, q)) score = 100 - name.length;
    else return;
    scored.push([branch, score, idx]);
  });
  scored.sort((a, b) => b[1] - a[1] || a[2] - b[2]);
  return scored.slice(0, 200).map((x) => x[0]);
}

function subsequenceMatch(haystack: string, needle: string): boolean {
  let i = 0;
  for (let j = 0; j < haystack.length && i < needle.length; j++) {
    if (haystack[j] === needle[i]) i++;
  }
  return i === needle.length;
}
