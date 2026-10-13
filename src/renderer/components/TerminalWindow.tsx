// A popped-out terminal: one shell in a window of its own.
//
// Loaded by the same renderer bundle with `?terminal=<id>` (see main.tsx), so
// it shares the drawer's xterm view and theme rather than being a second
// implementation. The shell itself never moved — it is the same PTY in main;
// closing this window hands it back to the drawer.

import { useEffect, useState } from 'react';
import type { TerminalSession } from '@shared/types';
import { useStore } from '../store';
import { useThemeEffect } from '../useThemeEffect';
import { terminalTabLabel } from '../terminalStore';
import { TerminalView } from './TerminalView';

export function TerminalWindow({ id }: { id: string }) {
  const [session, setSession] = useState<TerminalSession | null | undefined>(undefined);
  useThemeEffect();

  useEffect(() => {
    // Only the theme is wanted from settings; the rest of the app's state
    // stays in the main window.
    void window.overcli.invoke('store:load').then(({ settings }) => {
      useStore.setState((s) => ({ settings: { ...s.settings, theme: settings.theme } }));
    });
    void window.overcli.invoke('terminal:list').then((list) => {
      setSession(list.find((t) => t.id === id) ?? null);
    });
    return window.overcli.onMainEvent((e) => {
      if (e.type === 'terminalExit' && e.id === id) {
        setSession((s) => (s ? { ...s, exitCode: e.exitCode } : s));
      }
    });
  }, [id]);

  useEffect(() => {
    if (session) document.title = `${terminalTabLabel(session)} — ${session.shell}`;
  }, [session]);

  return (
    <div className="flex h-screen w-screen flex-col bg-surface">
      {/* The inset traffic lights sit over this strip, so it is the window's
          drag handle and keeps its text clear of them. */}
      <div className="draggable flex h-9 flex-shrink-0 items-center justify-between border-b border-card bg-surface-muted pl-20 pr-2">
        <div className="min-w-0 truncate font-mono text-[11.5px] text-ink-muted" title={session?.cwd}>
          {session ? (
            <>
              {terminalTabLabel(session)} <span className="text-ink-faint">{session.shell}</span>
            </>
          ) : null}
        </div>
        <button
          className="no-drag rounded px-1.5 py-0.5 text-[11px] text-ink-faint hover:bg-card hover:text-ink"
          title="Close this window and put the terminal back in the drawer"
          onClick={() => void window.overcli.invoke('terminal:popIn', { id })}
        >
          Back to drawer
        </button>
      </div>
      <div className="relative min-h-0 flex-1">
        {session ? (
          <TerminalView session={session} active />
        ) : session === null ? (
          <div className="flex h-full items-center justify-center text-[12px] text-ink-faint">
            This terminal has closed.
          </div>
        ) : null}
      </div>
    </div>
  );
}
