// What you can do with text you just selected in a service's output: copy it,
// ask about it, or hand it to a flow.
//
// It appears on mouse-up rather than on every selection change, so dragging
// across a stack trace is not chased by a bar, and it goes away on anything
// that says the selection is over — a click elsewhere, a scroll, Escape.

import { useEffect, useRef, useState, type RefObject } from 'react';
import { createPortal } from 'react-dom';

interface Picked {
  text: string;
  top: number;
  left: number;
  /// Drawn under the selection, because there was no room above it.
  below: boolean;
}

export function SelectionMenu({
  container,
  readText,
  onOpen,
  onAsk,
  flows,
  onRunFlow,
}: {
  container: RefObject<HTMLElement>;
  /// The text a range stands for. The pane decides: a log laid out in columns
  /// reads back from the DOM as run-together fields.
  readText: (range: Range, fallback: string) => string;
  onOpen?: () => void;
  onAsk: (text: string) => void;
  flows: readonly { id: string; name: string }[];
  onRunFlow: (flowId: string, text: string) => void;
}) {
  const [picked, setPicked] = useState<Picked | null>(null);
  const [choosing, setChoosing] = useState(false);
  const [copied, setCopied] = useState(false);
  const menu = useRef<HTMLDivElement>(null);
  const latest = useRef({ readText, onOpen });
  latest.current = { readText, onOpen };

  const close = () => {
    setPicked(null);
    setChoosing(false);
    setCopied(false);
  };

  useEffect(() => {
    const root = container.current;
    if (!root) return;
    const onUp = (e: MouseEvent) => {
      if (menu.current?.contains(e.target as Node)) return;
      // Once the browser has settled the selection the mouse-up finished.
      window.setTimeout(() => {
        const selection = window.getSelection();
        if (!selection || selection.isCollapsed || selection.rangeCount === 0) return;
        const range = selection.getRangeAt(0);
        if (!root.contains(range.commonAncestorContainer)) return;
        const text = latest.current.readText(range, selection.toString());
        if (!text.trim()) return;
        const rect = range.getBoundingClientRect();
        const below = rect.top < 60;
        setPicked({
          text,
          top: below ? rect.bottom + 6 : rect.top - 6,
          left: Math.min(Math.max(rect.left, 8), window.innerWidth - 280),
          below,
        });
        setChoosing(false);
        setCopied(false);
        latest.current.onOpen?.();
      }, 0);
    };
    const onDown = (e: MouseEvent) => {
      if (!menu.current?.contains(e.target as Node)) close();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close();
    };
    document.addEventListener('mouseup', onUp);
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    root.addEventListener('scroll', close);
    return () => {
      document.removeEventListener('mouseup', onUp);
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
      root.removeEventListener('scroll', close);
    };
  }, [container]);

  if (!picked) return null;

  const done = () => {
    close();
    window.getSelection()?.removeAllRanges();
  };

  const list = choosing && (
    <div className="max-h-[240px] w-[260px] overflow-y-auto border-card py-1">
      {flows.length === 0 ? (
        <div className="px-3 py-1.5 text-ink-faint">No flows yet</div>
      ) : (
        [...flows]
          .sort((a, b) => a.name.localeCompare(b.name))
          .map((flow) => (
            <button
              key={flow.id}
              className="block w-full truncate px-3 py-1.5 text-left text-ink-muted hover:bg-card-strong hover:text-ink"
              onClick={() => {
                onRunFlow(flow.id, picked.text);
                done();
              }}
            >
              {flow.name}
            </button>
          ))
      )}
    </div>
  );

  return createPortal(
    <div
      ref={menu}
      // Keeps the selection alive while a button is pressed.
      onMouseDown={(e) => e.preventDefault()}
      style={{
        position: 'fixed',
        top: picked.top,
        left: picked.left,
        transform: picked.below ? undefined : 'translateY(-100%)',
      }}
      className="z-50 flex flex-col rounded-md border border-card-strong bg-surface-elevated text-[11.5px] shadow-lg"
    >
      {!picked.below && list}
      <div className="flex items-center gap-0.5 p-1">
        <MenuButton
          onClick={() => {
            void navigator.clipboard.writeText(picked.text).then(() => {
              setCopied(true);
              window.setTimeout(done, 700);
            });
          }}
        >
          {copied ? 'Copied' : 'Copy'}
        </MenuButton>
        <MenuButton
          onClick={() => {
            onAsk(picked.text);
            done();
          }}
        >
          Ask AI
        </MenuButton>
        <MenuButton active={choosing} onClick={() => setChoosing((c) => !c)}>
          Run flow…
        </MenuButton>
      </div>
      {picked.below && list}
    </div>,
    document.body,
  );
}

function MenuButton({
  children,
  onClick,
  active,
}: {
  children: React.ReactNode;
  onClick: () => void;
  active?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      className={
        'rounded px-2 py-1 font-medium ' +
        (active ? 'bg-accent/15 text-accent' : 'text-ink-muted hover:bg-card-strong hover:text-ink')
      }
    >
      {children}
    </button>
  );
}
