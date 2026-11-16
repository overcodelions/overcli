// What a Settings save sends: only what changed, in the shapes the server's
// update takes, with the access choices turned into audience fields.

import { describe, expect, it } from 'vitest';
import { patchOf } from './OrgWorkerSettings';

type Form = Parameters<typeof patchOf>[0];

const base: Form = {
  name: 'Ada', tagline: 'Explains the acme code', avatarUrl: '', job: 'Explain the acme code.', manager: 'U0ACMEPAT', reportsTo: '',
  ask: 'org', audience: {}, start: 'manager', startAudience: {}, approve: 'manager', approvers: {}, trust: 'trusted',
  when: 'asked', time: '09:00', every: '60', budget: '50', role: '', tools: ['jira'], scopes: { jira: 'full' }, writesCode: 'flows', flow: '',
  answersAtOnce: '1', homeChannels: [], desktopHandOff: false, continueOpenPrs: false, prAuthors: '', prCommentAuthors: '', skipCheckpoints: false, alwaysAllow: ['explore/post'],
};
const edit = (over: Partial<Form>) => patchOf({ ...base, ...over }, base);

describe('patchOf', () => {
  it('sends nothing when nothing changed', () => {
    expect(patchOf(base, base)).toEqual({ patch: {} });
  });

  it('turns the access choices into audiences, and back', () => {
    expect(edit({ ask: 'picked', audience: { people: ['U0ACMEJO'], groups: ['team:design'] } }).patch).toEqual({ audience: { people: ['U0ACMEJO'], groups: ['team:design'] } });
    expect(edit({ ask: 'private' }).patch).toEqual({ audience: null, visibility: 'private' });
    expect(edit({ start: 'anyone' }).patch).toEqual({ anyoneMayStart: true, startAudience: null });
    expect(edit({ start: 'picked', startAudience: { people: ['U0ACMEJO'] } }).patch).toEqual({ anyoneMayStart: false, startAudience: { people: ['U0ACMEJO'] } });
    expect(edit({ approve: 'picked', approvers: { groups: ['team:design'] } }).patch).toEqual({ approvers: { groups: ['team:design'] } });
  });

  it('refuses a picked audience with nobody in it, and a schedule or budget that makes no sense', () => {
    expect(edit({ ask: 'picked' }).error).toContain('Pick at least one');
    expect(edit({ when: 'every', every: '10' }).error).toContain('30 or more');
    expect(edit({ budget: 'lots' }).error).toContain('above zero');
  });

  it('sends schedules, tools, scopes and the rest in the server’s shapes', () => {
    expect(edit({ when: 'daily', time: '08:30' }).patch).toEqual({ cadence: { kind: 'daily', time: '08:30' } });
    expect(edit({ when: 'every', every: '90' }).patch).toEqual({ cadence: { kind: 'interval', everyMinutes: 90 } });
    expect(edit({ tools: [] }).patch).toEqual({ mcpServers: [] });
    expect(edit({ scopes: { jira: 'read' } }).patch).toEqual({ toolScopes: { jira: { mode: 'read' } } });
    expect(edit({ writesCode: 'no', homeChannels: ['C0ACME1'], prAuthors: 'jo, sam', alwaysAllow: [], role: 'Code explorer' }).patch).toEqual({
      writesCode: false, slackHomeChannels: ['C0ACME1'], prAuthors: ['jo', 'sam'], alwaysAllow: [], role: 'Code explorer',
    });
    expect(edit({ trust: 'probation' })).toEqual({ patch: {}, trust: 'probation' });
    expect(edit({ desktopHandOff: true }).patch).toEqual({ desktopHandOff: true });
  });
});
