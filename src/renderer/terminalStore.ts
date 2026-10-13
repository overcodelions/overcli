// The terminal drawer: which shells are open, which one is showing, and
// whether the drawer is up at all.
//
// Main owns the shells (see main/ptyManager.ts); this is the list of tabs
// over them. Bytes never pass through here — each view subscribes to its own
// terminal's output directly, so a busy shell re-renders one xterm canvas
// rather than every component that reads this store.

import { create } from 'zustand';
import type { Backend, TerminalSession } from '@shared/types';

/// Drawer height bounds, in px. The floor keeps a prompt and a line of
/// output visible; the ceiling leaves the pane above something to show.
export const TERMINAL_HEIGHT_MIN = 120;
export const TERMINAL_HEIGHT_DEFAULT = 280;
const HEIGHT_KEY = 'overcli.terminal.height';

interface TerminalState {
  open: boolean;
  sessions: TerminalSession[];
  activeId: string | null;
  height: number;
  error: string | null;
  /// Which shells have text selected, so "Ask" can say what it will send.
  hasSelection: Record<string, boolean>;
  setHasSelection(id: string, value: boolean): void;
  /// Opens the drawer, starting a shell in `cwd` when there is none yet.
  show(cwd: string | null): Promise<void>;
  hide(): void;
  toggle(cwd: string | null): Promise<void>;
  /// Always a new shell, in `cwd`, shown at once.
  openAt(cwd: string): Promise<void>;
  /// A new shell with a conversation's CLI resumed in it.
  openConversation(args: { cwd: string; backend: Backend; sessionId?: string; model?: string }): Promise<void>;
  select(id: string): void;
  close(id: string): Promise<void>;
  setHeight(height: number): void;
  /// Picks the drawer's shells back up after a renderer reload, and starts
  /// listening for shells that exit. Returns the unsubscribe.
  init(): () => void;
}

export const useTerminalStore = create<TerminalState>((set, get) => ({
  open: false,
  sessions: [],
  activeId: null,
  height: readHeight(),
  error: null,
  hasSelection: {},

  setHasSelection(id, value) {
    if ((get().hasSelection[id] ?? false) === value) return;
    set((s) => ({ hasSelection: { ...s.hasSelection, [id]: value } }));
  },

  async show(cwd) {
    set({ open: true });
    if (get().sessions.length === 0 && cwd) await get().openAt(cwd);
  },

  hide() {
    set({ open: false });
  },

  async toggle(cwd) {
    if (get().open) get().hide();
    else await get().show(cwd);
  },

  async openAt(cwd) {
    set({ open: true, error: null });
    // The view refits to its real size the moment it mounts; this is only
    // what the shell sees for its first prompt.
    const res = await window.overcli.invoke('terminal:create', { cwd, cols: 100, rows: 24 });
    if (!res.ok) {
      set({ error: res.error });
      return;
    }
    set((s) => ({ sessions: [...s.sessions, res.session], activeId: res.session.id }));
  },

  async openConversation(args) {
    set({ open: true, error: null });
    const res = await window.overcli.invoke('terminal:createForConversation', { ...args, cols: 100, rows: 24 });
    if (!res.ok) {
      set({ error: res.error });
      return;
    }
    set((s) => ({ sessions: [...s.sessions, res.session], activeId: res.session.id }));
  },

  select(id) {
    set({ activeId: id });
  },

  async close(id) {
    await window.overcli.invoke('terminal:close', { id });
    set((s) => {
      const index = s.sessions.findIndex((t) => t.id === id);
      const sessions = s.sessions.filter((t) => t.id !== id);
      const activeId =
        s.activeId === id ? (sessions[Math.min(index, sessions.length - 1)]?.id ?? null) : s.activeId;
      // Closing the last shell puts the drawer away with it; an empty drawer
      // has nothing to say.
      return { sessions, activeId, open: sessions.length > 0 ? s.open : false };
    });
  },

  setHeight(height) {
    set({ height });
    try {
      localStorage.setItem(HEIGHT_KEY, String(Math.round(height)));
    } catch {
      // A height that resets next launch is fine.
    }
  },

  init() {
    void window.overcli.invoke('terminal:list').then((sessions) => {
      if (sessions.length === 0) return;
      set((s) => {
        const known = new Set(s.sessions.map((t) => t.id));
        const merged = [...s.sessions, ...sessions.filter((t) => !known.has(t.id))];
        return { sessions: merged, activeId: s.activeId ?? merged[merged.length - 1]?.id ?? null };
      });
    });
    return window.overcli.onMainEvent((e) => {
      if (e.type === 'terminalOpened') {
        set((s) => ({
          open: true,
          error: null,
          sessions: s.sessions.some((t) => t.id === e.session.id) ? s.sessions : [...s.sessions, e.session],
          activeId: e.session.id,
        }));
        return;
      }
      if (e.type === 'terminalPoppedOut') {
        set((s) => ({
          sessions: s.sessions.map((t) => (t.id === e.id ? { ...t, poppedOut: e.out } : t)),
        }));
        return;
      }
      if (e.type !== 'terminalExit') return;
      set((s) => ({
        sessions: s.sessions.map((t) => (t.id === e.id ? { ...t, exitCode: e.exitCode } : t)),
      }));
    });
  },
}));

/// A tab's label: the folder the shell started in.
export function terminalTabLabel(session: TerminalSession): string {
  const parts = session.cwd.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? session.cwd;
}

function readHeight(): number {
  try {
    const n = Number(localStorage.getItem(HEIGHT_KEY));
    if (Number.isFinite(n) && n >= TERMINAL_HEIGHT_MIN) return n;
  } catch {
    // Storage blocked: the default it is.
  }
  return TERMINAL_HEIGHT_DEFAULT;
}
