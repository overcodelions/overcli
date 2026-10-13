import { useEffect } from 'react';
import { SHORTCUTS, matches } from './shortcuts';

export function useShortcuts(): void {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const inInput = isEditableTarget(e.target);
      // Ctrl chords typed into a shell are the shell's: Ctrl+K kills a line,
      // Ctrl+P walks history, Ctrl+N, Ctrl+D... `mod` matches Ctrl as well
      // as ⌘, so without this the app would eat them. ⌘ still reaches the
      // app, and Ctrl+J still puts the terminal away.
      const shellKey = e.ctrlKey && !e.metaKey && isInTerminal(e.target);
      for (const def of SHORTCUTS) {
        if (def.displayOnly) continue;
        if (shellKey && def.id !== 'terminal.toggle') continue;
        const skip = def.skipInInput ?? !defHasMod(def);
        if (skip && inInput) continue;
        if (!matches(e, def)) continue;
        e.preventDefault();
        def.run();
        return;
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
}

function defHasMod(def: { keys: Array<{ mod?: boolean }> }): boolean {
  return def.keys.some((k) => k.mod);
}

function isEditableTarget(t: EventTarget | null): boolean {
  if (!(t instanceof HTMLElement)) return false;
  const tag = t.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA') return true;
  return t.isContentEditable;
}

function isInTerminal(t: EventTarget | null): boolean {
  return t instanceof HTMLElement && !!t.closest('[data-terminal]');
}
