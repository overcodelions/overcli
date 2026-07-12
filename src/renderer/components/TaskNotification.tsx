import { useState } from 'react';
import { Markdown } from './Markdown';
import { useStore } from '../store';

/// A background Task/Agent reporting back. Collapsed to its summary line by
/// default: these results run to thousands of words, and rendering one inline
/// at full width is what made them read like a message the user had typed.
export function TaskNotification({ summary, body }: { summary: string; body: string }) {
  const [open, setOpen] = useState(false);
  const openFile = useStore((s) => s.openFile);
  return (
    <div className="flex justify-center">
      <div
        className="max-w-[85%] w-full rounded-md border text-[11px] select-text"
        style={{
          background: 'rgba(148, 163, 184, 0.06)',
          borderColor: 'rgba(148, 163, 184, 0.18)',
          color: 'rgb(148 163 184)',
        }}
      >
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="flex w-full items-center gap-1.5 px-3 py-1.5 text-left"
          title="Reported by a background agent, not typed by you"
        >
          <span className="opacity-70">⛬ agent</span>
          <span className="flex-1 truncate italic">{summary}</span>
          <span className="opacity-60">{open ? '▾' : '▸'}</span>
        </button>
        {open && (
          <div className="border-t px-3 py-2" style={{ borderColor: 'rgba(148, 163, 184, 0.18)' }}>
            <Markdown source={body} onOpenPath={(p) => openFile(p)} />
          </div>
        )}
      </div>
    </div>
  );
}
