// The terminal drawer along the bottom of the main pane.
//
// Closed by default and out of the way: it appears when asked for (⌘J, or
// the `>_` buttons in the file tree) and opens in the folder you were looking
// at. Shells keep running while it is put away, so hiding it is not quitting.
// "Pop out" moves a shell into its own overcli window (Shift for the system
// terminal instead); closing that window brings the shell back here.

import { useCallback, useRef } from 'react';
import {
  TERMINAL_HEIGHT_MIN,
  terminalTabLabel,
  useTerminalStore,
} from '../terminalStore';
import { TerminalView, terminalText } from './TerminalView';
import { useStore } from '../store';
import { outputPrompt } from '../askAboutOutput';
import { appendToDraft, terminalAskTarget } from '../terminalAsk';
import type { TerminalSession } from '@shared/types';
import { SHORTCUTS, formatShortcutDef, resolveHereRoot } from '../shortcuts';

export function TerminalDrawer() {
  const open = useTerminalStore((s) => s.open);
  const sessions = useTerminalStore((s) => s.sessions);
  const activeId = useTerminalStore((s) => s.activeId);
  const height = useTerminalStore((s) => s.height);
  const error = useTerminalStore((s) => s.error);
  const selected = useTerminalStore((s) => (s.activeId ? (s.hasSelection[s.activeId] ?? false) : false));
  const conversationOnScreen = useStore((s) => s.detailMode === 'conversation' && !!s.selectedConversationId);
  const panel = useRef<HTMLDivElement>(null);

  // Written straight onto the element during the drag and committed once on
  // release, like the side panels: a store write per pointer move would
  // re-render every tab's header for nothing.
  const startDrag = useCallback(
    (e: React.PointerEvent) => {
      const el = panel.current;
      if (!el) return;
      e.preventDefault();
      const startY = e.clientY;
      const startH = el.offsetHeight;
      const parent = el.parentElement;
      const max = Math.max(TERMINAL_HEIGHT_MIN, (parent?.clientHeight ?? 800) - 120);
      let h = startH;
      const move = (ev: PointerEvent) => {
        h = Math.max(TERMINAL_HEIGHT_MIN, Math.min(max, startH + (startY - ev.clientY)));
        el.style.height = `${h}px`;
      };
      const up = () => {
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', up);
        useTerminalStore.getState().setHeight(h);
      };
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
    },
    [],
  );

  if (!open && sessions.length === 0) return null;
  const active = sessions.find((t) => t.id === activeId) ?? null;

  return (
    <div
      ref={panel}
      data-terminal-drawer
      style={{ height }}
      className={'relative flex flex-shrink-0 flex-col border-t border-card-strong bg-surface ' + (open ? '' : 'hidden')}
    >
      <div
        onPointerDown={startDrag}
        className="absolute -top-1 left-0 right-0 z-10 h-2 cursor-row-resize"
        aria-hidden
      />
      <div className="flex flex-shrink-0 items-center gap-1 border-b border-card bg-surface-muted px-2 py-1">
        <div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto">
          {sessions.map((t) => (
            <div
              key={t.id}
              className={
                'group flex flex-shrink-0 items-center gap-1 rounded px-2 py-0.5 text-[11.5px] ' +
                (t.id === activeId ? 'bg-card-strong text-ink' : 'text-ink-muted hover:bg-card')
              }
            >
              <button
                className="flex items-center gap-1.5 font-mono"
                title={t.cwd}
                onClick={() => useTerminalStore.getState().select(t.id)}
              >
                <span
                  aria-hidden
                  className={'h-1.5 w-1.5 rounded-full ' + (t.exitCode === null ? 'bg-emerald-500' : 'bg-ink-faint')}
                />
                {terminalTabLabel(t)}
                <span className="text-ink-faint">{t.poppedOut ? '↗' : t.shell}</span>
              </button>
              <button
                className="rounded px-0.5 text-ink-faint opacity-0 hover:text-ink group-hover:opacity-100"
                title="Close this terminal"
                aria-label="Close this terminal"
                onClick={() => void useTerminalStore.getState().close(t.id)}
              >
                ×
              </button>
            </div>
          ))}
          <button
            className="flex-shrink-0 rounded px-1.5 text-[13px] text-ink-faint hover:bg-card hover:text-ink"
            title="New terminal here"
            aria-label="New terminal here"
            onClick={() => {
              const cwd = resolveHereRoot() ?? active?.cwd;
              if (cwd) void useTerminalStore.getState().openAt(cwd);
            }}
          >
            +
          </button>
        </div>
        {error && (
          <span className="truncate text-[11px] text-red-500" title={error}>
            {error}
          </span>
        )}
        {active && !active.poppedOut && (
          <button
            className="flex-shrink-0 rounded px-1.5 py-0.5 text-[11px] text-ink-faint hover:bg-card hover:text-accent"
            title={
              (selected ? 'Ask about the selected text' : 'Ask about the recent output') +
              (conversationOnScreen ? ' in this conversation' : ' in a new conversation')
            }
            onClick={() => askAboutTerminal(active)}
          >
            {selected ? 'Ask about selection' : 'Ask about output'}
          </button>
        )}
        {active && !active.poppedOut && (
          <button
            className="flex-shrink-0 rounded px-1.5 py-0.5 text-[11px] text-ink-faint hover:bg-card hover:text-ink"
            title="Open this terminal in its own window (⇧-click for the system terminal)"
            onClick={(e) => popOut(active, e.shiftKey)}
          >
            Pop out ↗
          </button>
        )}
        <button
          className="flex-shrink-0 rounded px-1.5 text-[12px] text-ink-faint hover:bg-card hover:text-ink"
          title="Hide the terminal — shells keep running"
          aria-label="Hide the terminal"
          onClick={() => useTerminalStore.getState().hide()}
        >
          ⌄
        </button>
      </div>
      <div className="relative min-h-0 flex-1">
        {sessions.length === 0 ? (
          <div className="flex h-full items-center justify-center text-[12px] text-ink-faint">
            Open a project to start a terminal in it.
          </div>
        ) : (
          sessions.map((t) =>
            // A popped-out shell is drawn by its own window; two live views
            // of one shell would fight over its size.
            t.poppedOut ? (
              t.id === activeId && (
                <div key={t.id} className="flex h-full flex-col items-center justify-center gap-2 text-[12px] text-ink-faint">
                  <span>This terminal is open in its own window.</span>
                  <div className="flex gap-2">
                    <button className="svc-btn" onClick={() => void window.overcli.invoke('terminal:popOut', { id: t.id })}>
                      Show window
                    </button>
                    <button className="svc-btn" onClick={() => void window.overcli.invoke('terminal:popIn', { id: t.id })}>
                      Bring back here
                    </button>
                  </div>
                </div>
              )
            ) : (
              <TerminalView key={t.id} session={t} active={open && t.id === activeId} />
            ),
          )
        )}
      </div>
    </div>
  );
}

/// The title bar's terminal button, beside Usage: the way in for anyone who
/// hasn't learned ⌘J. Lit while the drawer is up; while it's put away, a dot
/// says shells are still running behind it so hidden ones aren't forgotten.
export function TerminalToggle() {
  const open = useTerminalStore((s) => s.open);
  const running = useTerminalStore((s) => s.sessions.filter((t) => t.exitCode === null).length);
  const toggle = SHORTCUTS.find((d) => d.id === 'terminal.toggle');
  const keys = toggle ? ` (${formatShortcutDef(toggle)})` : '';
  const label = open
    ? 'Hide the terminal'
    : running > 0
      ? `Show the terminal — ${running} running`
      : 'Open a terminal here';
  return (
    <button
      data-terminal-toggle
      onClick={() => void useTerminalStore.getState().toggle(resolveHereRoot())}
      title={label + keys}
      aria-label={label}
      aria-pressed={open}
      className={
        'relative p-1 rounded ' +
        (open ? 'text-ink bg-card-strong' : 'text-ink-muted hover:text-ink hover:bg-card-strong')
      }
    >
      <svg width="16" height="16" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
        <rect x="2.5" y="4" width="15" height="12" rx="2" />
        <path d="m6 8 2.5 2L6 12M10.5 12.5H14" />
      </svg>
      {!open && running > 0 && (
        <span aria-hidden className="absolute right-0.5 top-0.5 h-1.5 w-1.5 rounded-full bg-emerald-500" />
      )}
    </button>
  );
}

/// Seeds a conversation with what the terminal shows — see terminalAsk.ts.
/// The conversation on screen gets it added to its draft; otherwise a new one
/// opens in the shell's project.
function askAboutTerminal(session: TerminalSession): void {
  const grabbed = terminalText(session.id);
  if (!grabbed || !grabbed.text.trim()) return;
  const store = useStore.getState();
  const target = terminalAskTarget({
    cwd: session.cwd,
    conversationId: store.detailMode === 'conversation' ? store.selectedConversationId : null,
    projects: store.projects,
  });
  if (!target) {
    useTerminalStore.setState({ error: 'This folder is not in a project, so there is no conversation to ask in.' });
    return;
  }
  const prompt = outputPrompt({
    name: `the terminal in ${terminalTabLabel(session)}`,
    text: grabbed.text,
  });
  if (target.kind === 'conversation') {
    store.setDraft(target.conversationId, appendToDraft(store.conversationDrafts[target.conversationId] ?? '', prompt));
  } else {
    // Seeded, not sent, like asking about a service's output.
    store.setDraft('__welcome__', prompt);
    store.startNewConversation(target.projectId);
  }
  // The composer, not xterm's own hidden textarea: the user's next move is
  // to say what they want to know.
  requestAnimationFrame(() => {
    const el = document.querySelector('textarea:not(.xterm-helper-textarea)');
    if (el instanceof HTMLTextAreaElement) {
      el.focus();
      el.setSelectionRange(el.value.length, el.value.length);
    }
  });
}

async function popOut(session: TerminalSession, system: boolean): Promise<void> {
  const res = system
    ? await window.overcli.invoke('terminal:openFolder', { path: session.cwd })
    : await window.overcli.invoke('terminal:popOut', { id: session.id });
  useTerminalStore.setState({ error: res.ok ? null : res.error });
}
