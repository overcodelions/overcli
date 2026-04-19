import { useEffect, useState } from 'react';

/// Pulsing "thinking…" strip shown under the last message while the
/// runner is actively producing output. The verb rotates every 2.5s
/// through a small pool so a long "Thinking…" state doesn't feel
/// frozen — matches the Swift build's rotating activity text.
const VERBS = [
  'Thinking',
  'Pondering',
  'Reasoning',
  'Reading',
  'Considering',
  'Working',
  'Composing',
  'Digging in',
];

export function ActivityStrip({ label }: { label: string }) {
  // If the runner gave us a specific activity label (e.g. "Running
  // tools…") show that verbatim. Otherwise rotate through the pool —
  // the rotation is visual only, it doesn't reflect actual state.
  const useRotation =
    !label || label.toLowerCase().startsWith('thinking');
  const verb = useRotatingVerb(useRotation);
  const display = useRotation ? `${verb}…` : label;
  return (
    <div className="flex items-center gap-2 text-xs text-ink-muted py-1">
      <div className="flex gap-1">
        <Dot delay="0ms" />
        <Dot delay="180ms" />
        <Dot delay="360ms" />
      </div>
      <span className="transition-opacity duration-300">{display}</span>
    </div>
  );
}

function useRotatingVerb(enabled: boolean): string {
  const [idx, setIdx] = useState(0);
  useEffect(() => {
    if (!enabled) return;
    const t = setInterval(() => {
      setIdx((i) => (i + 1) % VERBS.length);
    }, 2500);
    return () => clearInterval(t);
  }, [enabled]);
  return VERBS[idx];
}

function Dot({ delay }: { delay: string }) {
  return (
    <span
      className="w-1.5 h-1.5 rounded-full bg-accent animate-pulse"
      style={{ animationDelay: delay, animationDuration: '1s' }}
    />
  );
}
