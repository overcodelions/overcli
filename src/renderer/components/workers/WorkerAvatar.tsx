// A worker's face.
//
// The roster used to identify workers by an 8px dot. A dot is a status light,
// and these are meant to read as people you hired — you promote them, they keep
// journals, they get fired. So every worker gets the same mark a person gets in
// any address book: initials, in a colour that is theirs and nobody else's.
//
// Three facts ride on one shape, and none of them costs a word:
//   - WHO — the initials, and the identity colour from `workerPalette`, so the
//     same worker is the same colour on the calendar, in the roster and on its
//     own page.
//   - STANDING — the ring. Probation is a dashed outline (on approval, nothing
//     runs unattended), trusted is a solid ring, autonomous is a doubled one.
//     A ladder, drawn as one.
//   - LIVENESS — a pulse while the worker is mid-turn, and a flattened, faded
//     face when it is paused. An employee on leave should look like one.

import { useMemo } from 'react';

import { useWorkersStore } from '../../workersStore';
import type { Worker, WorkerTrustLevel } from '@shared/flows/worker';
import { TRUST_LABEL } from './WorkerRowParts';
import { workerColorFor, workerColorMap } from './workerPalette';

export type AvatarSize = 'xs' | 'sm' | 'lg';

const SIZE: Record<AvatarSize, { box: string; text: string; ring: number }> = {
  xs: { box: 'h-[18px] w-[18px]', text: 'text-[8px]', ring: 1 },
  sm: { box: 'h-6 w-6', text: 'text-[10px]', ring: 1.5 },
  lg: { box: 'h-12 w-12', text: 'text-base', ring: 2 },
};

/// The colour map, built once from the whole roster rather than passed down
/// through every caller — `workerColorMap` assigns by hire order, so it needs
/// everyone to be able to answer for anyone.
export function useWorkerColors(): Record<string, string> {
  const workers = useWorkersStore((s) => s.workers);
  return useMemo(() => workerColorMap(Object.values(workers)), [workers]);
}

export function workerInitials(name: string): string {
  const parts = name.split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

export function WorkerAvatar({
  worker,
  size = 'xs',
  live = false,
}: {
  worker: Pick<Worker, 'id' | 'name' | 'trust' | 'enabled'>;
  size?: AvatarSize;
  live?: boolean;
}) {
  const colors = useWorkerColors();
  const tint = workerColorFor(colors, worker.id);
  const dim = SIZE[size];
  const paused = !worker.enabled;

  return (
    <span
      className={`relative flex ${dim.box} shrink-0 items-center justify-center`}
      title={`${worker.name} · ${TRUST_LABEL[worker.trust].text}${paused ? ' · paused' : ''}`}
    >
      {live && (
        <span
          aria-hidden
          className="absolute inset-0 animate-ping rounded-full"
          style={{ background: `color-mix(in srgb, ${tint} 45%, transparent)` }}
        />
      )}
      <span
        className={`relative flex ${dim.box} items-center justify-center rounded-full font-semibold ${dim.text}`}
        style={{
          // A paused worker is drawn hollow: the face is still theirs, but it
          // is not filled in, the way a chair is still someone's chair.
          background: paused
            ? 'transparent'
            : `color-mix(in srgb, ${tint} 22%, var(--c-card-bg))`,
          color: paused ? `color-mix(in srgb, ${tint} 55%, var(--c-ink-faint))` : tint,
          ...ringStyle(worker.trust, tint, dim.ring, paused),
        }}
      >
        {workerInitials(worker.name)}
      </span>
    </span>
  );
}

/// Standing as a ring. Ordinal, and legible without colour: dashed → solid →
/// doubled is a ladder you can see at 18px, where a third shade of the same
/// hue would not be.
function ringStyle(
  trust: WorkerTrustLevel,
  tint: string,
  width: number,
  paused: boolean,
): React.CSSProperties {
  const strength = paused ? 40 : 80;
  const color = `color-mix(in srgb, ${tint} ${strength}%, transparent)`;
  if (trust === 'probation') {
    return { border: `${width}px dashed ${color}` };
  }
  if (trust === 'trusted') {
    return { border: `${width}px solid ${color}` };
  }
  // Autonomous: a second ring, drawn with a shadow so it costs no layout.
  return {
    border: `${width}px solid ${color}`,
    boxShadow: `0 0 0 ${width}px color-mix(in srgb, ${tint} ${strength / 3}%, transparent)`,
  };
}
