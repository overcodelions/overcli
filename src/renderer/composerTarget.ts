// Which composer a question asked from somewhere else should land in.
//
// Several composers can be mounted at once (a conversation, a flow step's
// side chat, the start page), and each keeps its draft under its own key.
// Asking about a line in the file pane means "the one I'm talking to", which
// is the one most recently focused — or, failing that, most recently shown.

import { useStore } from './store';

interface Entry {
  key: string;
  focus: () => void;
}

const stack: Entry[] = [];

/// Called by a composer on mount. Returns the matching unregister.
export function registerComposer(key: string, focus: () => void): () => void {
  const entry = { key, focus };
  stack.push(entry);
  return () => {
    const i = stack.indexOf(entry);
    if (i >= 0) stack.splice(i, 1);
  };
}

/// Called on focus: the composer the user last typed into wins.
export function raiseComposer(key: string): void {
  const i = stack.findIndex((e) => e.key === key);
  if (i < 0 || i === stack.length - 1) return;
  stack.push(...stack.splice(i, 1));
}

/// Appends `text` to the active composer's draft and focuses it, caret at
/// the end so the question is typed straight after the quote. Seeded, not
/// sent. False when no composer is on screen.
export function seedActiveComposer(text: string): boolean {
  const target = stack[stack.length - 1];
  if (!target) return false;
  const { conversationDrafts, setDraft } = useStore.getState();
  const current = (conversationDrafts[target.key] ?? '').replace(/\s+$/, '');
  setDraft(target.key, current ? `${current}\n\n${text}` : text);
  requestAnimationFrame(target.focus);
  return true;
}

/// The quote a selection is asked about with: where it is, then the lines.
export function quoteForQuestion(args: {
  path: string;
  text: string;
  /// 1-based, inclusive. Absent for a diff, whose hunk headers say where.
  lines?: { from: number; to: number };
  language: string;
}): string {
  const where = args.lines
    ? args.lines.from === args.lines.to
      ? ` line ${args.lines.from}`
      : ` lines ${args.lines.from}–${args.lines.to}`
    : '';
  const fence = args.text.includes('```') ? '````' : '```';
  return `In \`${args.path}\`${where}:\n\n${fence}${args.language}\n${args.text.replace(/\n+$/, '')}\n${fence}\n\n`;
}
