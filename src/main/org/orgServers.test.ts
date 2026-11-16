import os from 'node:os';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppSettings } from '../../shared/types';
import { useTestHost } from '../testHost';

let settings: AppSettings = {} as AppSettings;
vi.mock('../store', () => ({
  Store: {
    load: () => ({ settings }),
    saveSettings: (next: AppSettings) => {
      settings = next;
    },
  },
}));

import {
  chatToolNames,
  defaultServerIdIn,
  forgetOrgServer,
  listOrgServers,
  newServerId,
  onOrgServersChanged,
  orgServerAccess,
  orgServersIn,
  orgTokenFor,
  rememberSignIn,
  saveOrgServers,
  updateOrgServer,
} from './orgServers';

const host = useTestHost(os.tmpdir());

beforeEach(() => {
  settings = {} as AppSettings;
  host.secrets.clear();
  delete process.env.OVERCLI_ORG_TOKEN;
});
afterEach(() => onOrgServersChanged(null));

describe('the list, from what was stored', () => {
  it('makes the one server of before into `primary`, keeping its chat switch and its keychain key', () => {
    settings = { orgServerUrl: 'https://overgo.acme.example/', orgInChats: true } as AppSettings;
    host.secrets.set('org-control-token', 'ocli_old');
    expect(orgServersIn(settings)).toEqual([{ id: 'primary', url: 'https://overgo.acme.example', inChats: true }]);
    expect(orgTokenFor('primary')).toBe('ocli_old');
    expect(orgServerAccess()).toMatchObject({ ok: true, url: 'https://overgo.acme.example', token: 'ocli_old' });
  });

  it('has nothing before any server, and asks to sign in', () => {
    expect(orgServersIn(settings)).toEqual([]);
    expect(orgServerAccess()).toMatchObject({ ok: false, signIn: true });
  });

  it('falls back to the first server when the default is unset or gone', () => {
    const list = [{ id: 'primary', url: 'https://a.example' }, { id: 'b-example', url: 'https://b.example' }];
    expect(defaultServerIdIn({ orgServers: list } as AppSettings)).toBe('primary');
    expect(defaultServerIdIn({ orgServers: list, orgDefaultServerId: 'b-example' } as AppSettings)).toBe('b-example');
    expect(defaultServerIdIn({ orgServers: list, orgDefaultServerId: 'gone' } as AppSettings)).toBe('primary');
  });
});

describe('ids and chat names', () => {
  it('names the first `primary` and the rest after their address, never twice', () => {
    expect(newServerId([], 'https://overgo.acme.example')).toBe('primary');
    const list = [{ id: 'primary', url: 'https://x' }, { id: 'overgo-acme-example', url: 'https://y' }];
    expect(newServerId(list, 'https://overgo.acme.example')).toBe('overgo-acme-example-2');
    expect(newServerId(list, 'http://localhost:7420')).toBe('localhost-7420');
  });

  it('calls a lone server `overgo`, and several `overgo-<org>`, unique', () => {
    expect([...chatToolNames([{ id: 'primary', url: 'https://a', name: 'Acme' }]).values()]).toEqual(['overgo']);
    const names = chatToolNames([
      { id: 'primary', url: 'https://a', name: 'Acme Platform' },
      { id: 'b', url: 'https://b', name: 'Acme Platform' },
      { id: 'c-host', url: 'https://c' },
    ]);
    expect([...names.values()]).toEqual(['overgo-acme-platform', 'overgo-acme-platform-2', 'overgo-c-host']);
  });
});

describe('signing in, out and removing', () => {
  it('adds a second server with its own token, and signs in to a known one in place', () => {
    const told: AppSettings[] = [];
    onOrgServersChanged((s) => told.push(s));
    expect(rememberSignIn('https://overgo.acme.example', 'ocli_one', { org: 'Acme', name: 'Pat' })).toMatchObject({ ok: true, entry: { id: 'primary' } });
    expect(rememberSignIn('http://localhost:7420', 'ocli_two', { org: 'Acme Labs' })).toMatchObject({ ok: true, entry: { id: 'localhost-7420' } });
    expect(rememberSignIn('https://overgo.acme.example/', 'ocli_three')).toMatchObject({ ok: true, entry: { id: 'primary', name: 'Acme', who: 'Pat' } });
    expect(listOrgServers().map((e) => e.id)).toEqual(['primary', 'localhost-7420']);
    expect(orgTokenFor('primary')).toBe('ocli_three');
    expect(orgTokenFor('localhost-7420')).toBe('ocli_two');
    expect(host.secrets.get('org-control-token:localhost-7420')).toBe('ocli_two');
    // The pieces that knew one server follow the default.
    expect(settings.orgServerUrl).toBe('https://overgo.acme.example');
    expect(told.length).toBe(3);
  });

  it('refuses an address that would send the token in the clear', () => {
    expect(rememberSignIn('http://overgo.acme.example', 'ocli_x')).toMatchObject({ ok: false });
    expect(listOrgServers()).toEqual([]);
  });

  it('signs out keeping the server (its chat switch off), and removes it with its token', () => {
    rememberSignIn('https://a.example', 'ocli_a', { org: 'A' });
    rememberSignIn('https://b.example', 'ocli_b', { org: 'B' });
    updateOrgServer('b-example', { inChats: true });
    saveOrgServers(listOrgServers(), 'b-example');
    expect(settings.orgServerUrl).toBe('https://b.example');
    forgetOrgServer('b-example');
    expect(listOrgServers().find((e) => e.id === 'b-example')).toMatchObject({ inChats: false });
    expect(orgServerAccess('b-example')).toMatchObject({ ok: false, signIn: true, error: expect.stringContaining('Sign in to B again') });
    forgetOrgServer('b-example', true);
    expect(listOrgServers().map((e) => e.id)).toEqual(['primary']);
    expect(settings.orgServerUrl).toBe('https://a.example');
    expect(orgServerAccess('b-example')).toMatchObject({ ok: false, error: expect.stringContaining('no longer on your list') });
  });

  it('uses $OVERCLI_ORG_TOKEN for the default server only', () => {
    rememberSignIn('https://a.example', 'ocli_a');
    rememberSignIn('https://b.example', 'ocli_b');
    process.env.OVERCLI_ORG_TOKEN = 'ocli_env';
    expect(orgTokenFor('primary')).toBe('ocli_env');
    expect(orgTokenFor('b-example')).toBe('ocli_b');
  });
});
