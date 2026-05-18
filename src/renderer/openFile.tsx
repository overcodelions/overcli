// `openFile` is normally a store action that opens the editor pane to
// the right of the conversation (inline with the chat). When a file
// path is clicked from inside the SubagentDrawer, we want the editor
// to land in a different slot — to the right of the drawer — so the
// user keeps both the subagent's transcript and the conversation
// visible while exploring the file the agent touched.
//
// Components that open files (ToolUseCard, ToolResultCard,
// AssistantBubble, Markdown via ToolResultCard) read `useOpenFile()`
// instead of pulling `s.openFile` directly. Inside the drawer we
// supply an override through `OpenFileOverride.Provider` that points
// at the side-pane action; everywhere else `useOpenFile` falls back
// to the inline store action and behaves exactly like before.

import { createContext, useContext } from 'react';
import { useStore, type OpenFileHighlight } from './store';
import type { FileViewMode } from './filePreview';

export type OpenFileFn = (
  path: string,
  highlight?: OpenFileHighlight,
  mode?: FileViewMode,
) => void;

export const OpenFileOverride = createContext<OpenFileFn | null>(null);

export function useOpenFile(): OpenFileFn {
  const override = useContext(OpenFileOverride);
  const storeOpen = useStore((s) => s.openFile);
  return override ?? storeOpen;
}

/// Marks the descendant tree as rendering inside the SubagentDrawer.
/// Tool cards read this to render their compact one-line variants —
/// the drawer is narrow and we want the transcript dense, while the
/// main conversation pane keeps the roomier defaults.
export const InsideSubagentDrawer = createContext<boolean>(false);

export function useInsideSubagentDrawer(): boolean {
  return useContext(InsideSubagentDrawer);
}
