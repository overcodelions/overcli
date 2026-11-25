import { describe, expect, it } from 'vitest';
import {
  MAX_CONVERSATION_TABS,
  closeTab,
  closeTabsToRight,
  cycleTab,
  moveTab,
  openTab,
  pruneTabs,
} from './conversationTabs';

describe('openTab', () => {
  it('lands next to the tab you were on', () => {
    expect(openTab(['a', 'b', 'c'], 'x', 'a')).toEqual(['a', 'x', 'b', 'c']);
  });

  it('goes to the end with nothing open', () => {
    expect(openTab(['a', 'b'], 'x', null)).toEqual(['a', 'b', 'x']);
  });

  it('leaves an open tab where it is', () => {
    const tabs = ['a', 'b', 'c'];
    expect(openTab(tabs, 'c', 'a')).toBe(tabs);
  });

  it('drops the oldest tab past the cap, never the new one or the one you came from', () => {
    const full = Array.from({ length: MAX_CONVERSATION_TABS }, (_, i) => `t${i}`);
    const next = openTab(full, 'x', 't0');
    expect(next).toHaveLength(MAX_CONVERSATION_TABS);
    expect(next).toContain('x');
    expect(next).toContain('t0');
    expect(next).not.toContain('t1');
  });
});

describe('closeTab', () => {
  it('hands over to the right-hand neighbour', () => {
    expect(closeTab(['a', 'b', 'c'], 'b', 'b')).toEqual({ tabs: ['a', 'c'], selected: 'c' });
  });

  it('hands over to the left at the end of the strip', () => {
    expect(closeTab(['a', 'b', 'c'], 'c', 'c')).toEqual({ tabs: ['a', 'b'], selected: 'b' });
  });

  it('keeps the selection when closing a tab in the background', () => {
    expect(closeTab(['a', 'b', 'c'], 'a', 'c')).toEqual({ tabs: ['b', 'c'], selected: 'c' });
  });

  it('selects nothing after the last tab', () => {
    expect(closeTab(['a'], 'a', 'a')).toEqual({ tabs: [], selected: null });
  });
});

describe('moveTab', () => {
  it('moves before the target', () => {
    expect(moveTab(['a', 'b', 'c'], 'c', 'a')).toEqual(['c', 'a', 'b']);
  });

  it('moves to the end with no target', () => {
    expect(moveTab(['a', 'b', 'c'], 'a', null)).toEqual(['b', 'c', 'a']);
  });
});

describe('cycleTab', () => {
  it('wraps both ways', () => {
    expect(cycleTab(['a', 'b', 'c'], 'c', 1)).toBe('a');
    expect(cycleTab(['a', 'b', 'c'], 'a', -1)).toBe('c');
  });

  it('starts at an end when the current conversation is not a tab', () => {
    expect(cycleTab(['a', 'b'], null, 1)).toBe('a');
    expect(cycleTab(['a', 'b'], 'z', -1)).toBe('b');
  });
});

describe('pruneTabs', () => {
  it('drops missing conversations, junk and duplicates', () => {
    const exists = (id: string) => id !== 'gone';
    expect(pruneTabs(['a', 'gone', 'a', 3, '', 'b'], exists)).toEqual(['a', 'b']);
  });
});

describe('closeTabsToRight', () => {
  it('keeps the tab and everything before it', () => {
    expect(closeTabsToRight(['a', 'b', 'c', 'd'], 'b', 'a')).toEqual({ tabs: ['a', 'b'], selected: 'a' });
  });

  it('moves to the tab itself when the one on screen was closed', () => {
    expect(closeTabsToRight(['a', 'b', 'c', 'd'], 'b', 'd')).toEqual({ tabs: ['a', 'b'], selected: 'b' });
  });

  it('does nothing for the last tab', () => {
    const tabs = ['a', 'b'];
    expect(closeTabsToRight(tabs, 'b', 'b').tabs).toBe(tabs);
  });
});
