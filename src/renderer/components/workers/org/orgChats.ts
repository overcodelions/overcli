// Where chats about the org go: one place of their own, "overgo", made the
// first time it's needed (an everyday folder with history, like any other).
// Improving a worker with Claude and doing a task a worker handed this
// desktop both open there, so they never land in someone's project.

import { useStore } from '../../../store';

export const OVERGO_PLACE = 'overgo';

async function overgoProjectId(): Promise<string | { error: string }> {
  const st = useStore.getState();
  const found = st.projects.find((p) => p.everyday && p.name === OVERGO_PLACE);
  if (found) return found.id;
  const made = await st.createEverydayProject(OVERGO_PLACE, 'Chats about your org’s workers: improving them, and tasks they hand you.');
  if (!made.ok) return { error: made.error ?? 'Couldn’t make the overgo place.' };
  const now = useStore.getState().projects.find((p) => p.path === made.path);
  return now ? now.id : { error: 'Couldn’t find the overgo place after making it.' };
}

/// A new chat in the overgo place, named, with `draft` waiting in the box
/// (nothing is sent), and opened. Chrome on when the task needs a browser.
export async function openOrgChat(name: string, draft: string, opts: { chrome?: boolean } = {}): Promise<{ ok: true; conversationId: string } | { ok: false; error: string }> {
  const id = await overgoProjectId();
  if (typeof id !== 'string') return { ok: false, error: id.error };
  const st = useStore.getState();
  const conv = await st.newConversation(id);
  if (opts.chrome) await st.setChrome(conv.id, true);
  await st.renameConversation(conv.id, name);
  st.setDraft(conv.id, draft);
  st.selectConversation(conv.id);
  return { ok: true, conversationId: conv.id };
}
