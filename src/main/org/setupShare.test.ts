import { describe, expect, it } from 'vitest';
import { gatherSetup, keyValuesFor, repoUrlFromRemote } from './setupShare';

describe('a git remote as the server should clone it', () => {
  it('takes credentials out and turns ssh into https', () => {
    expect(repoUrlFromRemote('git@github.com:acme/app.git')).toBe('https://github.com/acme/app');
    expect(repoUrlFromRemote('ssh://git@bitbucket.org/acme/api.git')).toBe('https://bitbucket.org/acme/api');
    expect(repoUrlFromRemote('https://x-token-auth:sekret@bitbucket.org/acme/api.git')).toBe('https://bitbucket.org/acme/api');
    expect(repoUrlFromRemote('https://github.com/acme')).toBeNull();
    expect(repoUrlFromRemote('/Users/pat/repos/app')).toBeNull();
  });
});

describe("a desktop's setup", () => {
  const servers = {
    tracker: { command: 'npx', args: ['-y', '@acme/tracker-mcp'], env: { TRACKER_TOKEN: 'tk-secret', TRACKER_SITE: 'acme' } },
    notes: { url: 'https://notes.acme.test/mcp?key=abc', headers: { Authorization: 'Bearer hdr-secret' } },
  };

  it('lists tools by the names of their keys, never the values, and each project with its remote', async () => {
    const setup = await gatherSetup(servers, [{ id: 'p1', name: 'App', path: '/r/app' }, { id: 'p2', name: 'Scratch', path: '/r/scratch' }], async (dir) => (dir === '/r/app' ? 'git@github.com:acme/app.git' : null));
    expect(setup.tools.map((t) => [t.name, t.target, t.keys])).toEqual([
      ['notes', 'https://notes.acme.test/mcp', ['Authorization']],
      ['tracker', 'npx -y @acme/tracker-mcp', ['TRACKER_TOKEN', 'TRACKER_SITE']],
    ]);
    expect(JSON.stringify(setup)).not.toMatch(/secret|key=abc/);
    expect(setup.repos).toEqual([
      { projectId: 'p1', name: 'app', url: 'https://github.com/acme/app', localPath: '/r/app' },
      { projectId: 'p2', name: 'scratch', localPath: '/r/scratch' },
    ]);
  });

  it('reads key values only for the names the template lists', async () => {
    const setup = await gatherSetup({ tracker: { ...servers.tracker, env: { ...servers.tracker.env } } }, [], async () => null);
    const t = setup.tools[0];
    expect(keyValuesFor({ ...servers.tracker, env: { ...servers.tracker.env, OTHER: 'x' } }, t.template)).toEqual({ env: { TRACKER_TOKEN: 'tk-secret', TRACKER_SITE: 'acme' } });
  });
});
