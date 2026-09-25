import { describe, expect, it } from 'vitest';
import type { Project, Workspace } from '@shared/types';
import {
  agoLabel,
  arrangePlaces,
  filterPlaces,
  movePinned,
  placeId,
  placeName,
  QUIET,
  togglePinned,
  type PlaceRef,
} from './places';

const NOW = 1_800_000_000_000;
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

function project(id: string, path = `/code/${id}`): Project {
  return { id, name: id, path, conversations: [] };
}

function workspace(id: string, projectIds: string[]): Workspace {
  return { id, name: id, projectIds, rootPath: `/ws/${id}`, conversations: [], createdAt: 0 };
}

const ids = (refs: PlaceRef[]) => refs.map(placeId);

describe('arrangePlaces', () => {
  const projects = [project('ledger'), project('billing'), project('old'), project('member')];
  const workspaces = [workspace('platform', ['member'])];
  const touched: Record<string, number> = {
    ledger: NOW - 2 * HOUR,
    billing: NOW - 5 * HOUR,
    old: NOW - 20 * DAY,
    member: NOW - HOUR,
    platform: NOW - 10 * DAY,
  };
  const base = {
    projects,
    workspaces,
    pinned: [] as string[],
    activityAt: (ref: PlaceRef) => touched[placeId(ref)] ?? 0,
    status: () => QUIET,
    now: NOW,
  };

  it('splits recent places from quiet ones, newest first', () => {
    const out = arrangePlaces(base);
    expect(ids(out.active)).toEqual(['ledger', 'billing']);
    expect(ids(out.more)).toEqual(['platform', 'old']);
  });

  it('shows a workspace member under its workspace, not again at the top', () => {
    const out = arrangePlaces(base);
    expect([...ids(out.active), ...ids(out.more)]).not.toContain('member');
  });

  it('keeps pinned places on top in the pinned order, and out of the other bands', () => {
    const out = arrangePlaces({ ...base, pinned: ['old', 'member', 'gone'] });
    expect(ids(out.pinned)).toEqual(['old', 'member']);
    expect(ids(out.more)).not.toContain('old');
  });

  it('never folds a place that is running or waiting on you, however old', () => {
    const out = arrangePlaces({
      ...base,
      status: (ref) => (placeId(ref) === 'platform' ? { running: 0, needsYou: 2 } : QUIET),
    });
    expect(ids(out.active)).toContain('platform');
    expect(ids(out.more)).toEqual(['old']);
  });

  it('keeps the place you are in out of the fold', () => {
    const out = arrangePlaces({ ...base, keepOut: (ref) => placeId(ref) === 'old' });
    expect(ids(out.active)).toContain('old');
  });
});

describe('filterPlaces', () => {
  const projects = [
    project('ledger-svc'),
    project('billing-svc'),
    project('notes', '/docs/svc-notes'),
    project('overcli'),
  ];
  const workspaces = [workspace('platform', ['ledger-svc'])];
  const touched: Record<string, number> = { 'ledger-svc': 3, 'billing-svc': 5, notes: 9, overcli: 1, platform: 0 };
  const input = {
    query: 'svc',
    sort: 'recent' as const,
    filter: 'all' as const,
    kind: (ref: PlaceRef) => (ref.kind === 'workspace' ? ('workspace' as const) : ('repo' as const)),
    activityAt: (ref: PlaceRef) => touched[placeId(ref)],
    status: () => QUIET,
    weight: (ref: PlaceRef) => placeName(ref).length,
  };

  it('matches names and paths, name-prefix first, then most recent', () => {
    expect(ids(filterPlaces(projects, workspaces, input))).toEqual(['notes', 'billing-svc', 'ledger-svc']);
  });

  it('sorts A–Z and by weight', () => {
    expect(ids(filterPlaces(projects, workspaces, { ...input, sort: 'az' }))).toEqual([
      'billing-svc',
      'ledger-svc',
      'notes',
    ]);
    expect(ids(filterPlaces(projects, workspaces, { ...input, query: '', sort: 'busiest' }))[0]).toBe('billing-svc');
  });

  it('narrows by kind', () => {
    expect(ids(filterPlaces(projects, workspaces, { ...input, query: '', filter: 'workspaces' }))).toEqual([
      'platform',
    ]);
  });

  it('narrows to places with something going on', () => {
    const status = (ref: PlaceRef) => (placeId(ref) === 'overcli' ? { running: 1, needsYou: 0 } : QUIET);
    expect(ids(filterPlaces(projects, workspaces, { ...input, query: '', filter: 'running', status }))).toEqual([
      'overcli',
    ]);
  });
});

describe('pinning', () => {
  it('toggles without disturbing the rest of the order', () => {
    expect(togglePinned(['a', 'b'], 'c')).toEqual(['a', 'b', 'c']);
    expect(togglePinned(['a', 'b', 'c'], 'b')).toEqual(['a', 'c']);
  });

  it('moves one slot and stops at the ends', () => {
    expect(movePinned(['a', 'b', 'c'], 'c', -1)).toEqual(['a', 'c', 'b']);
    expect(movePinned(['a', 'b'], 'a', -1)).toEqual(['a', 'b']);
  });
});

describe('agoLabel', () => {
  it('reads short', () => {
    expect(agoLabel(NOW - 30_000, NOW)).toBe('now');
    expect(agoLabel(NOW - 2 * HOUR, NOW)).toBe('2h');
    expect(agoLabel(NOW - 3 * DAY, NOW)).toBe('3d');
    expect(agoLabel(NOW - 21 * DAY, NOW)).toBe('3w');
    expect(agoLabel(0, NOW)).toBe('');
  });
});
