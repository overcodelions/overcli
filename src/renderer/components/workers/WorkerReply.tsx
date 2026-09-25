// A worker's side of a desk turn, drawn like the Chat window's assistant
// bubble. Its own module because the desk and the Today reader both draw
// worker replies, and they must look the same.

import { useRef } from 'react';

import { CopyActions } from '../CopyActions';
import { Markdown } from '../Markdown';
import { useOpenWorkerPath } from './workerFilesContext';
import { relativeTime } from './workerDeskSelectors';
import { useWorkerColors } from './WorkerAvatar';
import { workerColorFor } from './workerPalette';
import type { Worker } from '@shared/flows/worker';

/// The worker's own colour — the one its avatar, sidebar row and day-chart
/// bars already wear — so a reply reads as that worker's at a glance. The rail
/// mixes it the way AssistantBubble mixes a model's colour.
export function useWorkerTint(workerId: string): string {
  return workerColorFor(useWorkerColors(), workerId);
}

/// The assistant side of a turn, shaped like AssistantBubble.
export function WorkerReply({
  worker,
  tint: tintProp,
  at,
  reply,
  footer,
}: {
  worker: Worker;
  /// Defaults to the worker's own colour.
  tint?: string;
  at: number;
  reply: string;
  footer?: React.ReactNode;
}) {
  const openWorkerPath = useOpenWorkerPath();
  const ownTint = useWorkerTint(worker.id);
  const tint = tintProp ?? ownTint;
  // What a worker says is the same kind of thing an assistant bubble says —
  // an itinerary you want to paste into a mail, a summary you want to keep —
  // so it carries the same copy pair, over the same rendered prose.
  const renderedRef = useRef<HTMLDivElement>(null);
  return (
    <div
      className="group relative overflow-hidden rounded-xl"
      style={{
        background: `color-mix(in srgb, ${tint} 5%, transparent)`,
        border: `1px solid color-mix(in srgb, ${tint} 18%, transparent)`,
      }}
    >
      <div
        className="absolute bottom-0 left-0 top-0 w-[2px]"
        style={{ background: tint + "cc" }}
      />
      <div className="px-4 py-2.5 pl-[14px]">
        <div
          className="mb-1 flex items-center gap-2 text-[10px] font-medium"
          style={{ color: tint }}
        >
          <span>{worker.name}</span>
          <span className="text-ink-faint">{relativeTime(at)}</span>
        </div>
        <div ref={renderedRef}>
          {reply ? (
            <Markdown source={reply} onOpenPath={openWorkerPath} />
          ) : (
            <div className="text-xs text-ink-faint">No reply recorded.</div>
          )}
        </div>
        {footer}
      </div>
      {reply && (
        <CopyActions
          className="absolute right-1.5 top-1.5"
          getPlain={() => renderedRef.current?.innerText ?? reply}
          raw={reply}
        />
      )}
    </div>
  );
}

