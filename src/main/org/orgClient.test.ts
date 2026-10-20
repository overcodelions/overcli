import { describe, expect, it } from 'vitest';
import { dialable, normalizeOrgUrl, processPublishPayload, unreachable } from './orgClient';
import type { ProcessDef } from '../../shared/org/process';

describe('normalizeOrgUrl', () => {
  it('keeps https and trims to the origin', () => {
    expect(normalizeOrgUrl('https://overcli.acme.example:7420/console')).toEqual({ ok: true, url: 'https://overcli.acme.example:7420' });
  });
  it('allows plain http only to this machine', () => {
    expect(normalizeOrgUrl('http://127.0.0.1:7420')).toEqual({ ok: true, url: 'http://127.0.0.1:7420' });
    expect(normalizeOrgUrl('http://overcli.acme.example').ok).toBe(false);
    expect(normalizeOrgUrl('not a url').ok).toBe(false);
  });
});

describe('dialable', () => {
  it('connects to IPv4 for localhost, where overcli serve listens', () => {
    expect(dialable('http://localhost:7420')).toBe('http://127.0.0.1:7420');
    expect(dialable('https://overcli.acme.example:7420')).toBe('https://overcli.acme.example:7420');
  });
});

describe('unreachable', () => {
  it('says what to do when nothing answers', () => {
    const refused = Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } });
    expect(unreachable('http://localhost:7420', refused)).toContain('Is overcli serve running there?');
    expect(unreachable('http://localhost:7420', new TypeError('fetch failed'))).toBe('Could not reach the org server at http://localhost:7420.');
  });
});

describe('processPublishPayload', () => {
  const def: Pick<ProcessDef, 'id' | 'name' | 'purpose' | 'owner' | 'stages'> = {
    id: 'local-launch',
    name: 'Idea to launch',
    purpose: 'Acme ideas, shipped',
    owner: { name: 'You' },
    stages: [
      { id: 'proto', name: 'Prototype', kind: 'team', teamId: 'team-1', ask: 'A clickable prototype.' },
      { id: 'ok', name: 'Validate', kind: 'people', approvers: [{ name: 'You' }, { name: 'Ada', slackUserId: 'U0ADA' }] },
    ],
  };
  const teams = [{ id: 'team-1', name: 'Prototype crew' }];

  it('names team stages by their local team, and says who "You" is', () => {
    const res = processPublishPayload(def, teams, { name: 'Lee', slackUserId: 'U0LEE' });
    expect(res).toEqual({
      ok: true,
      payload: {
        localId: 'local-launch',
        name: 'Idea to launch',
        purpose: 'Acme ideas, shipped',
        owner: { name: 'Lee', slackUserId: 'U0LEE' },
        stages: [
          { id: 'proto', name: 'Prototype', kind: 'team', ask: 'A clickable prototype.', localTeamId: 'team-1', teamName: 'Prototype crew' },
          { id: 'ok', name: 'Validate', kind: 'people', approvers: [{ name: 'Lee', slackUserId: 'U0LEE' }, { name: 'Ada', slackUserId: 'U0ADA' }] },
        ],
      },
    });
  });

  it('leaves the owner to the server when the org has no name for "You"', () => {
    const res = processPublishPayload(def, teams);
    expect(res.ok).toBe(true);
    expect(res.ok ? res.payload.owner : 'refused').toBeUndefined();
    expect(res.ok ? res.payload.stages[1].approvers : []).toEqual([{ name: 'Ada', slackUserId: 'U0ADA' }]);
  });

  it('refuses a gone team or a decision nobody on the org can make', () => {
    expect(processPublishPayload(def, [])).toMatchObject({ ok: false, error: expect.stringContaining('Prototype') });
    const onlyYou = { ...def, stages: [{ id: 'ok', name: 'Validate', kind: 'people' as const, approvers: [{ name: 'You' }] }] };
    expect(processPublishPayload(onlyYou, teams)).toMatchObject({ ok: false, error: expect.stringContaining('Validate') });
  });
});
