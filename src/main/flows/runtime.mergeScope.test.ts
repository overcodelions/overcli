import { describe, expect, it } from 'vitest';
import { remoteRepoKeys, scopeMergePlaces } from './runtime';

const place = (name: string, projectPath: string, remote?: string) => ({ name, worktreePath: `/wt/${name}`, projectPath, ...(remote ? { remote } : {}) });

describe('remoteRepoKeys', () => {
  it('names the repo from an https or ssh origin', () => {
    expect(remoteRepoKeys('https://github.com/acme/App.git')).toEqual(['app', 'acme/app']);
    expect(remoteRepoKeys('git@bitbucket.org:acme/storefront.git')).toEqual(['storefront', 'acme/storefront']);
    expect(remoteRepoKeys(undefined)).toEqual([]);
  });
});

describe('scopeMergePlaces', () => {
  it('merges everywhere when the run names no pull request repos', () => {
    const places = [place('app', '/repos/app')];
    expect(scopeMergePlaces(places, undefined)).toEqual({ scoped: places, unmatched: false });
  });

  it('matches on the connected name or the clone folder', () => {
    const places = [place('app', '/repos/app'), place('api', '/repos/api')];
    expect(scopeMergePlaces(places, ['API']).scoped.map((p) => p.name)).toEqual(['api']);
  });

  it('matches a repo connected under a custom name by its origin', () => {
    const places = [
      place('shop-web', '/repos/shop-web', 'https://github.com/acme/storefront.git'),
      place('shop-api', '/repos/shop-api', 'git@github.com:acme/storefront-api.git'),
    ];
    expect(scopeMergePlaces(places, ['storefront'])).toEqual({ scoped: [places[0]], unmatched: false });
    expect(scopeMergePlaces(places, ['acme/storefront-api']).scoped).toEqual([places[1]]);
  });

  it('falls back to every place, and says so, when nothing matches', () => {
    const places = [place('shop-web', '/repos/shop-web')];
    expect(scopeMergePlaces(places, ['storefront'])).toEqual({ scoped: places, unmatched: true });
  });
});
