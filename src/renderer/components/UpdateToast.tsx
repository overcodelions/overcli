import { useEffect, useState } from 'react';

// Global, conversation-agnostic toast for the auto-updater. Subscribes to the
// `update:*` main-process events (see src/main/updater.ts) independently of the
// store's ingestMainEvent so update UI never tangles with conversation state.
//
// Lifecycle: download progresses quietly in a corner; once the update is
// downloaded we surface a "Restart to update" prompt. Install is deferred to
// quit anyway, so dismissing just hides the toast — the update still applies
// next time the app is quit.
type UpdateState =
  | { phase: 'idle' }
  | { phase: 'downloading'; percent: number }
  | { phase: 'ready'; version: string };

export function UpdateToast() {
  const [state, setState] = useState<UpdateState>({ phase: 'idle' });
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    const unsub = window.overcli.onMainEvent((e) => {
      if (e.type === 'update:available') {
        setDismissed(false);
        setState({ phase: 'downloading', percent: 0 });
      } else if (e.type === 'update:progress') {
        setState({ phase: 'downloading', percent: e.payload.percent });
      } else if (e.type === 'update:downloaded') {
        setDismissed(false);
        setState({ phase: 'ready', version: e.payload.version });
      }
    });
    return () => unsub();
  }, []);

  if (state.phase === 'idle' || dismissed) return null;

  return (
    <div className="fixed bottom-4 right-4 z-[60] max-w-[320px] bg-surface-elevated border border-card-strong rounded-lg shadow-xl px-4 py-3 text-xs flex flex-col gap-2">
      {state.phase === 'downloading' ? (
        <>
          <div className="flex items-center justify-between gap-3">
            <span className="text-ink-faint">Downloading update…</span>
            <span className="text-ink tabular-nums">{state.percent}%</span>
          </div>
          <div className="h-1 rounded-full bg-card overflow-hidden">
            <div
              className="h-full bg-accent transition-[width] duration-300"
              style={{ width: `${state.percent}%` }}
            />
          </div>
        </>
      ) : (
        <>
          <div className="text-ink">
            Update <span className="font-medium">{state.version}</span> is ready.
          </div>
          <div className="flex items-center gap-2">
            <button
              className="text-xs px-3 py-1 rounded-md bg-accent/15 text-accent border border-accent/30 hover:bg-accent/25"
              onClick={() => void window.overcli.invoke('update:quitAndInstall')}
            >
              Restart to update
            </button>
            <button
              className="text-xs px-2 py-1 rounded-md text-ink-faint hover:text-ink"
              onClick={() => setDismissed(true)}
            >
              Later
            </button>
          </div>
        </>
      )}
    </div>
  );
}
