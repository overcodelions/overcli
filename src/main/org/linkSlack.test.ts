import { describe, expect, it } from 'vitest';
import type { Worker } from '../../shared/flows/worker';
import { DEFAULT_ORG_POLICY, type OrgCaller } from '../../shared/org/policy';
import { AccessService } from './accessService';
import { OrgService } from './orgService';

const me: OrgCaller = { name: 'Me', admin: true };
const PAT = 'U0ACMEPAT';

function access(opts: { dm?: boolean } = {}) {
  let now = 1_000;
  const dms: Array<{ to: string; linkId: string; as: string }> = [];
  const linked: unknown[] = [];
  const svc = new AccessService({
    policy: () => DEFAULT_ORG_POLICY,
    store: {} as never,
    tokens: {
      create: () => ({ token: 'x' }),
      revokeFor: () => 0,
      revoke: () => false,
      list: () => [],
      link: (...args) => {
        linked.push(['tokens', ...args]);
        return 2;
      },
    },
    linkManagers: (...args) => {
      linked.push(['workers', ...args]);
      return 3;
    },
    updateOrg: () => {},
    slack: {
      dmInvite: async () => false,
      askAdmins: () => {},
      tellRequester: () => {},
      dmLinkSlack: async (to, linkId, as) => {
        dms.push({ to, linkId, as });
        return opts.dm !== false;
      },
    },
    now: () => now,
  });
  return { svc, dms, linked, later: (ms: number) => (now += ms) };
}

describe('linking a sign-in to Slack', () => {
  it('links only when the Slack person themselves presses the button, taking their Slack name', async () => {
    const { svc, dms, linked } = access();
    expect(await svc.linkSlackStart(me, PAT)).toEqual({ ok: true, sentTo: PAT });
    expect(dms).toEqual([{ to: PAT, linkId: dms[0].linkId, as: 'Me' }]);
    expect(svc.linkSlackConfirm('U0ACMESAM', dms[0].linkId, 'Sam').ok).toBe(false);
    expect(linked).toEqual([]);
    expect(svc.linkSlackConfirm(PAT, dms[0].linkId, 'Pat Acme')).toEqual({ ok: true, name: 'Pat Acme', was: 'Me', signIns: 2, workers: 3 });
    expect(linked).toEqual([
      ['tokens', 'Me', true, PAT, 'Pat Acme'],
      ['workers', 'Me', PAT, 'Pat Acme'],
    ]);
    // Once only.
    expect(svc.linkSlackConfirm(PAT, dms[0].linkId).ok).toBe(false);
  });

  it('refuses a linked sign-in, a bad id, a DM that did not go, and a request past its quarter hour', async () => {
    const { svc, dms, later } = access();
    expect((await svc.linkSlackStart({ ...me, slackUserId: PAT }, PAT)).ok).toBe(false);
    expect((await svc.linkSlackStart(me, 'pat')).ok).toBe(false);
    expect((await access({ dm: false }).svc.linkSlackStart(me, PAT)).ok).toBe(false);
    await svc.linkSlackStart(me, PAT);
    later(16 * 60_000);
    expect(svc.linkSlackConfirm(PAT, dms.at(-1)!.linkId).ok).toBe(false);
  });
});

describe('OrgService.linkManagers', () => {
  const worker = (id: string, manager: Worker['manager']) => ({ id, name: id, manager }) as unknown as Worker;

  it('gives the Slack id and name to workers managed by that name, and to ones saved under the bare id', () => {
    const roster = [
      worker('hugo', { name: 'Me' }),
      worker('lena', { name: PAT, slackUserId: PAT }),
      worker('nadia', { name: 'Sam', slackUserId: 'U0ACMESAM' }),
      worker('marta', { name: 'Me', slackUserId: 'U0ACMESAM' }),
    ];
    const saved: Worker[] = [];
    const svc = new OrgService({
      workers: { roster: () => roster, save: (w: Worker) => (saved.push(w), { ok: true, worker: w }) },
      policy: () => DEFAULT_ORG_POLICY,
    } as unknown as ConstructorParameters<typeof OrgService>[0]);
    expect(svc.linkManagers('Me', PAT, 'Pat Acme')).toBe(2);
    expect(saved.map((w) => [w.id, w.manager])).toEqual([
      ['hugo', { name: 'Pat Acme', slackUserId: PAT }],
      ['lena', { name: 'Pat Acme', slackUserId: PAT }],
    ]);
  });
});
