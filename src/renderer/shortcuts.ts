import { useStore } from './store';
import { isMac } from './platform';

export type ShortcutGroup = 'Navigation' | 'View' | 'Conversation' | 'App' | 'Editor';

export interface ShortcutKey {
  key: string;
  mod?: boolean;
  shift?: boolean;
  alt?: boolean;
}

export interface ShortcutDef {
  id: string;
  keys: ShortcutKey[];
  label: string;
  group: ShortcutGroup;
  skipInInput?: boolean;
  run: () => void;
  hidden?: boolean;
  // Documented in the help sheet but dispatched locally by the
  // owning component (e.g. file editor save needs local content).
  displayOnly?: boolean;
}

export function matches(e: KeyboardEvent, def: ShortcutDef): boolean {
  for (const k of def.keys) {
    const modPressed = e.metaKey || e.ctrlKey;
    if ((k.mod ?? false) !== modPressed) continue;
    if ((k.shift ?? false) !== e.shiftKey) continue;
    if ((k.alt ?? false) !== e.altKey) continue;
    if (e.key.toLowerCase() === k.key.toLowerCase()) return true;
  }
  return false;
}

export function formatShortcut(k: ShortcutKey): string {
  const mac = isMac();
  const parts: string[] = [];
  if (k.mod) parts.push(mac ? '⌘' : 'Ctrl');
  if (k.alt) parts.push(mac ? '⌥' : 'Alt');
  if (k.shift) parts.push(mac ? '⇧' : 'Shift');
  parts.push(displayKey(k.key, mac));
  return mac ? parts.join('') : parts.join('+');
}

export function formatShortcutDef(def: ShortcutDef): string {
  return formatShortcut(def.keys[0]!);
}

function displayKey(key: string, mac: boolean): string {
  switch (key) {
    case 'Backspace':
      return mac ? '⌫' : 'Backspace';
    case 'Enter':
      return mac ? '↵' : 'Enter';
    case 'Escape':
      return 'Esc';
    case 'ArrowUp':
      return '↑';
    case 'ArrowDown':
      return '↓';
    case 'ArrowLeft':
      return '←';
    case 'ArrowRight':
      return '→';
    case ' ':
      return 'Space';
  }
  return key.length === 1 ? key.toUpperCase() : key;
}

function resolveFileFinderRoot(): string | null {
  const state = useStore.getState();
  const convId = state.selectedConversationId;
  if (!convId) return null;
  for (const p of state.projects) {
    const c = p.conversations.find((x) => x.id === convId);
    if (c) return c.worktreePath ?? p.path;
  }
  for (const w of state.workspaces) {
    const c = (w.conversations ?? []).find((x) => x.id === convId);
    if (c) return c.worktreePath ?? w.rootPath;
  }
  return null;
}

// ⌘K belongs to the app shell (palette). If an in-app terminal is added
// later, give it a different binding rather than yielding ⌘K.
export const SHORTCUTS: ShortcutDef[] = [
  {
    id: 'palette.open',
    keys: [{ key: 'k', mod: true }],
    label: 'Open command palette',
    group: 'Navigation',
    run: () => useStore.getState().openSheet({ type: 'quickSwitcher' }),
  },
  {
    id: 'file.finder',
    keys: [{ key: 'p', mod: true }],
    label: 'Find file in project',
    group: 'Navigation',
    run: () => {
      const root = resolveFileFinderRoot();
      if (root) useStore.getState().openSheet({ type: 'fileFinder', rootPath: root });
    },
  },
  {
    id: 'sidebar.toggle',
    keys: [{ key: '\\', mod: true }],
    label: 'Toggle sidebar',
    group: 'View',
    run: () => useStore.getState().toggleSidebar(),
  },
  {
    id: 'conversation.new',
    keys: [{ key: 'n', mod: true }],
    label: 'New conversation in current project',
    group: 'Conversation',
    run: () => {
      const state = useStore.getState();
      const convId = state.selectedConversationId;
      let projectId: string | null = null;
      if (convId) {
        for (const p of state.projects) {
          if (p.conversations.some((c) => c.id === convId)) {
            projectId = p.id;
            break;
          }
        }
      }
      if (!projectId) projectId = state.projects[0]?.id ?? null;
      if (projectId) state.startNewConversation(projectId);
    },
  },
  {
    id: 'settings.open',
    keys: [{ key: ',', mod: true }],
    label: 'Open settings',
    group: 'App',
    run: () => useStore.getState().openSheet({ type: 'settings' }),
  },
  {
    id: 'shortcuts.help',
    keys: [
      { key: '?', shift: true },
      { key: '/', shift: true },
    ],
    label: 'Show keyboard shortcuts',
    group: 'App',
    skipInInput: true,
    run: () => useStore.getState().openSheet({ type: 'shortcutsHelp' }),
  },
  {
    id: 'sheet.close',
    keys: [{ key: 'Escape' }],
    label: 'Close sheet / overlay',
    group: 'App',
    skipInInput: false,
    run: () => {
      const state = useStore.getState();
      if (state.activeSheet) state.openSheet(null);
    },
  },
  {
    id: 'editor.save',
    keys: [{ key: 's', mod: true }],
    label: 'Save file',
    group: 'Editor',
    displayOnly: true,
    run: () => {},
  },
  {
    id: 'editor.saveAlt',
    keys: [{ key: 'Enter', mod: true }],
    label: 'Save file (alternate)',
    group: 'Editor',
    displayOnly: true,
    run: () => {},
  },
  {
    id: 'editor.toggleDiff',
    keys: [{ key: 'd', mod: true, shift: true }],
    label: 'Toggle Diff / File view',
    group: 'Editor',
    displayOnly: true,
    run: () => {},
  },
  {
    id: 'commit.submit',
    keys: [{ key: 'Enter', mod: true }],
    label: 'Commit (in commit dropdown)',
    group: 'Conversation',
    displayOnly: true,
    run: () => {},
  },
];
