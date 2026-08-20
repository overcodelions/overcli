import { describe, expect, it } from 'vitest';

import { DESK_PIN_SLACK, pinnedToBottom, shouldFollowLive } from './deskFollow';

describe('pinnedToBottom', () => {
  it('counts the exact bottom, and a line above it, as pinned', () => {
    expect(pinnedToBottom({ scrollHeight: 1000, scrollTop: 600, clientHeight: 400 })).toBe(true);
    expect(
      pinnedToBottom({ scrollHeight: 1000, scrollTop: 600 - (DESK_PIN_SLACK - 1), clientHeight: 400 }),
    ).toBe(true);
  });

  it('does not count a reader who has scrolled up', () => {
    expect(pinnedToBottom({ scrollHeight: 1000, scrollTop: 200, clientHeight: 400 })).toBe(false);
  });

  it('counts a transcript shorter than its box as pinned', () => {
    expect(pinnedToBottom({ scrollHeight: 300, scrollTop: 0, clientHeight: 400 })).toBe(true);
  });
});

describe('shouldFollowLive', () => {
  it('always follows a turn that has just started', () => {
    expect(shouldFollowLive({ live: true, wasLive: false, pinned: false })).toBe(true);
  });

  it('follows a running turn only while the reader is at the bottom', () => {
    expect(shouldFollowLive({ live: true, wasLive: true, pinned: true })).toBe(true);
    expect(shouldFollowLive({ live: true, wasLive: true, pinned: false })).toBe(false);
  });

  it('does nothing when no turn is in flight', () => {
    expect(shouldFollowLive({ live: false, wasLive: true, pinned: true })).toBe(false);
    expect(shouldFollowLive({ live: false, wasLive: false, pinned: true })).toBe(false);
  });
});
