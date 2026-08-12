// Unsaved file-editor buffers, keyed by the path the editor opened them
// under.
//
// Deliberately NOT in the zustand store. The editor writes on every
// keystroke, and fe67e25 was specifically about keeping keystroke-rate
// churn out of a store the whole app subscribes to. What the rest of the
// UI actually needs is the *dirty* flag, and that lives in uiSlice
// (`dirtyFiles`): it flips at most twice per editing session per file and
// is what the tab strip's modified dot reads.
//
// A buffer outlives its tab on purpose. Closing the editor pane keeps a
// dirty buffer so reopening the same file restores the unsaved work;
// closing a tab explicitly drops it (the tab strip confirms first).

/// Headroom over MAX_TABS_PER_SCOPE so switching scopes with unsaved work
/// on both sides can't evict either side's buffer.
export const MAX_BUFFERS = 32;

const buffers = new Map<string, string>();

/// Record the current text for `path`. Returns the paths evicted to stay
/// under the cap — the caller must clear their dirty flags, since their
/// unsaved text is gone and the editor would otherwise show disk content
/// under a modified dot.
export function stashBuffer(path: string, content: string): string[] {
  // Re-insert so Map iteration order stays oldest-write-first.
  buffers.delete(path);
  buffers.set(path, content);
  const evicted: string[] = [];
  while (buffers.size > MAX_BUFFERS) {
    const oldest = buffers.keys().next();
    if (oldest.done) break;
    buffers.delete(oldest.value);
    evicted.push(oldest.value);
  }
  return evicted;
}

export function readBuffer(path: string): string | undefined {
  return buffers.get(path);
}

export function dropBuffer(path: string): void {
  buffers.delete(path);
}

export function bufferCount(): number {
  return buffers.size;
}

/// Test seam — production code never wants to drop every buffer at once.
export function clearBuffers(): void {
  buffers.clear();
}
