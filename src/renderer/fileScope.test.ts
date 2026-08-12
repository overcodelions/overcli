import { describe, expect, it } from 'vitest';
import { fileScopeKeyFor } from './fileScope';

const base = {
  detailMode: 'conversation',
  selectedConversationId: null,
  explorerRootPath: null,
  activeRunId: null,
};

describe('fileScopeKeyFor', () => {
  it('scopes to the selected conversation', () => {
    expect(fileScopeKeyFor({ ...base, selectedConversationId: 'c1' })).toBe('conv:c1');
  });

  it('scopes to the active flow run in the flows view', () => {
    expect(
      fileScopeKeyFor({ ...base, detailMode: 'flows', activeRunId: 'r1' }),
    ).toBe('flow:r1');
  });

  it('keeps flow runs off the conversation scope even with a conversation selected', () => {
    // The flows view routinely leaves a conversation selected under the
    // hood; its files must not land in that conversation's tab list.
    expect(
      fileScopeKeyFor({
        ...base,
        detailMode: 'flows',
        activeRunId: 'r1',
        selectedConversationId: 'c1',
      }),
    ).toBe('flow:r1');
  });

  it('gives the explorer its own scope, even inside a conversation', () => {
    // ExplorerPane replaces the editor pane wholesale in both mount sites,
    // so its tabs are what the user sees.
    expect(
      fileScopeKeyFor({ ...base, selectedConversationId: 'c1', explorerRootPath: '/repo' }),
    ).toBe('explorer:/repo');
  });

  it('has no scope on the welcome pane or a run-less flows view', () => {
    expect(fileScopeKeyFor(base)).toBeNull();
    expect(fileScopeKeyFor({ ...base, detailMode: 'flows' })).toBeNull();
  });
});
