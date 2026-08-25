import { useStore } from './store';
import { isMac } from './platform';
import { findContainerPath } from './conversationLookup';
import { resolveNewConversationTarget } from './newConversationTarget';
import { navigateBack, navigateForward } from './navHistory';

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
  return findContainerPath(state, convId);
}

/// Start a chat in the place the user is plainly in, and ask when there is no
/// such place. Shared by ⌘N and the sidebar's compose button so the two can
/// never land in different projects from the same standing state.
export function startNewConversationHere(): void {
  const state = useStore.getState();
  const target = resolveNewConversationTarget(state);
  if (!target) {
    // Places scope, not All: the question on screen is "which project", and a
    // palette opening on yesterday's chats makes the user retype the answer.
    state.openSheet({ type: 'quickSwitcher', scope: 'places' });
    return;
  }
  if (target.kind === 'workspace') state.startNewConversationInWorkspace(target.id);
  else state.startNewConversation(target.id);
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
  // Back/forward through the views you've visited. `mod` covers both Cmd
  // and Ctrl, so the arrow bindings are Ctrl+←/→ as well as ⌘←/→.
  //
  // The arrows yield inside text fields, where ⌘←/Ctrl+← already means
  // "jump to the start of the line" — the composer is where the cursor
  // almost always is, and stealing that would break typing. Browsers make
  // the same trade. The bracket bindings exist precisely to cover that
  // case: they mean nothing to a text field, so they work everywhere.
  {
    id: 'nav.back',
    keys: [{ key: 'ArrowLeft', mod: true }],
    label: 'Back to the previous view (or ⌘[ / Ctrl+[ while typing)',
    group: 'Navigation',
    skipInInput: true,
    run: () => navigateBack(),
  },
  {
    id: 'nav.forward',
    keys: [{ key: 'ArrowRight', mod: true }],
    label: 'Forward to the next view (or ⌘] / Ctrl+] while typing)',
    group: 'Navigation',
    skipInInput: true,
    run: () => navigateForward(),
  },
  {
    id: 'nav.backAlt',
    keys: [{ key: '[', mod: true }],
    label: 'Back to the previous view',
    group: 'Navigation',
    skipInInput: false,
    hidden: true,
    run: () => navigateBack(),
  },
  {
    id: 'nav.forwardAlt',
    keys: [{ key: ']', mod: true }],
    label: 'Forward to the next view',
    group: 'Navigation',
    skipInInput: false,
    hidden: true,
    run: () => navigateForward(),
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
    label: 'New conversation in the current project or workspace',
    group: 'Conversation',
    run: () => startNewConversationHere(),
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
    id: 'editor.goToDefinition',
    keys: [{ key: 'Click', mod: true }],
    label: 'Go to definition of the symbol under the cursor',
    group: 'Editor',
    displayOnly: true,
    run: () => {},
  },
  {
    id: 'editor.nextTab',
    keys: [{ key: 'ArrowRight', mod: true, alt: true }],
    label: 'Next / previous file tab (⌥⌘←)',
    group: 'Editor',
    displayOnly: true,
    run: () => {},
  },
  {
    id: 'editor.selectTab',
    keys: [{ key: '1', mod: true }],
    label: 'Jump to file tab 1-9',
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
