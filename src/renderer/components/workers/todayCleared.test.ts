import { beforeEach, describe, expect, it } from 'vitest';
import { clearStateOf, useTodayCleared } from './todayCleared';

describe('clearStateOf', () => {
  it('is unread until cleared, cleared after, and back once something newer happens', () => {
    expect(clearStateOf({}, 'a', 100)).toBe('unread');
    expect(clearStateOf({ a: 200 }, 'a', 100)).toBe('cleared');
    expect(clearStateOf({ a: 200 }, 'a', 300)).toBe('back');
  });
});

describe('useTodayCleared', () => {
  beforeEach(() => useTodayCleared.setState({ cleared: {} }));

  it('clears and brings back', () => {
    useTodayCleared.getState().clear('a', 50);
    expect(useTodayCleared.getState().cleared).toEqual({ a: 50 });
    useTodayCleared.getState().restore('a');
    expect(useTodayCleared.getState().cleared).toEqual({});
  });
});
