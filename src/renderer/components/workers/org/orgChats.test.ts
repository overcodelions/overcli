// Org chats go to an "overgo" place of their own: made once, then reused,
// never someone's project.

import { beforeEach, describe, expect, it, vi } from 'vitest';

const st = {
  projects: [] as Array<{ id: string; name: string; path: string; everyday?: boolean }>,
  createEverydayProject: vi.fn(async () => {
    st.projects.push({ id: 'og', name: 'overgo', path: '/Users/pat/Overcli/overgo', everyday: true });
    return { ok: true, path: '/Users/pat/Overcli/overgo', historyOn: true };
  }),
  newConversation: vi.fn(async () => ({ id: 'c1' })),
  setChrome: vi.fn(async () => {}),
  renameConversation: vi.fn(async () => {}),
  setDraft: vi.fn(),
  selectConversation: vi.fn(),
};
vi.mock('../../../store', () => ({ useStore: { getState: () => st } }));

import { openOrgChat } from './orgChats';

beforeEach(() => {
  st.projects = [{ id: 'proj', name: 'rc-ho', path: '/Users/pat/rc-ho', everyday: true }];
  for (const f of Object.values(st)) if (typeof f === 'function' && 'mockClear' in f) (f as ReturnType<typeof vi.fn>).mockClear();
});

describe('openOrgChat', () => {
  it('makes the overgo place the first time, then reuses it, never another everyday folder', async () => {
    expect(await openOrgChat('Improve Pip', 'Help me improve Pip')).toEqual({ ok: true, conversationId: 'c1' });
    expect(st.createEverydayProject).toHaveBeenCalledTimes(1);
    expect(st.newConversation).toHaveBeenCalledWith('og');
    expect(st.renameConversation).toHaveBeenCalledWith('c1', 'Improve Pip');
    expect(st.setDraft).toHaveBeenCalledWith('c1', 'Help me improve Pip');
    await openOrgChat('Robin: check the portal', 'task', { chrome: true });
    expect(st.createEverydayProject).toHaveBeenCalledTimes(1);
    expect(st.newConversation).toHaveBeenLastCalledWith('og');
    expect(st.setChrome).toHaveBeenCalledWith('c1', true);
  });
});
