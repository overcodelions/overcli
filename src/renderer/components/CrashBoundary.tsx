// The last line of defence for a render error.
//
// Without it React unmounts the whole tree and the window goes blank, with the
// only trace in DevTools — which nobody has open when it happens. This keeps
// the error on screen, writes it to the session log so it can be found
// afterwards, and offers a way back without restarting the app.

import { Component, type ErrorInfo, type ReactNode } from 'react';

interface State {
  error: Error | null;
}

export class CrashBoundary extends Component<{ children: ReactNode }, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    const message = [
      error.stack ?? `${error.name}: ${error.message}`,
      info.componentStack ? `Component stack:${info.componentStack}` : '',
    ]
      .filter(Boolean)
      .join('\n');
    void window.overcli
      .invoke('diagnostics:log', { level: 'error', scope: 'renderer.crash', message })
      .catch(() => {});
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <div className="flex h-screen w-screen flex-col items-center justify-center gap-4 bg-surface p-8 text-ink">
        <div className="text-sm font-semibold">Something on this screen broke.</div>
        <pre className="max-h-[50vh] max-w-3xl overflow-auto whitespace-pre-wrap rounded-md border border-card bg-surface-elevated p-3 font-mono text-[11px] text-ink-muted">
          {error.stack ?? `${error.name}: ${error.message}`}
        </pre>
        <div className="text-[11px] text-ink-faint">The details are in the session log under renderer.crash.</div>
        <div className="flex gap-2">
          <button
            type="button"
            className="rounded-md bg-accent px-3 py-1.5 text-xs text-white hover:opacity-90"
            onClick={() => this.setState({ error: null })}
          >
            Try again
          </button>
          <button
            type="button"
            className="rounded-md border border-card px-3 py-1.5 text-xs text-ink hover:bg-surface-elevated"
            onClick={() => window.location.reload()}
          >
            Reload window
          </button>
        </div>
      </div>
    );
  }
}
