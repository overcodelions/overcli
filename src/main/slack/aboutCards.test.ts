import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_ORG_POLICY } from '../../shared/org/policy';
import type { OrgService } from '../org/orgService';
import { aboutTarget, askedAbout, looseName, processCard, teamCard, workerCard } from './aboutCards';
import { ABOUT_SHARE_ACTION, SlackCommands } from './slackCommands';

const json = (card: { blocks: unknown[] }) => JSON.stringify(card.blocks);

describe('what names a card', () => {
  it('reads it from a command, either way round', () => {
    expect(aboutTarget('lt about')).toBe('lt');
    expect(aboutTarget('Launch Team: about')).toBe('Launch Team');
    expect(aboutTarget('about Idea to launch')).toBe('Idea to launch');
    expect(aboutTarget('lt write a PRFAQ')).toBeNull();
  });

  it('reads it from a plain question', () => {
    expect(askedAbout('what is Launch Team?')).toBe('Launch Team');
    expect(askedAbout('What’s Ada')).toBe('Ada');
    expect(askedAbout('how does Idea to launch work?')).toBe('Idea to launch');
    expect(askedAbout('tell me about Ada')).toBe('Ada');
    expect(askedAbout('what does Ada do?')).toBe('Ada');
    expect(askedAbout('write a PRFAQ for offline mode')).toBeNull();
  });

  it('takes a name as people say it', () => {
    expect(looseName('the launch team')).toBe('launch');
    expect(looseName('Launch Team')).toBe('launch');
  });
});

describe('the cards', () => {
  it('shows a worker with its picture, never what it costs', () => {
    const card = workerCard({ name: 'Ada', tagline: 'Answers product questions', job: 'Reads the code.', manager: 'Pat', tools: ['acme tracker'], picture: 'https://acme.example/ada.png', recent: ['Answered a question'] });
    expect(json(card)).toContain('https://acme.example/ada.png');
    expect(json(card)).toContain('Manager: Pat');
    expect(json(card)).toContain('acme tracker');
    expect(json(card)).toContain('@overgo Ada');
    expect(json(card)).not.toContain('$');
  });

  it('shows a team’s people and how it works, following its checkpoints', () => {
    const members = [{ name: 'Lena', role: 'Writer', picture: 'https://acme.example/lena.png' }, { name: 'Omar', role: 'Challenger' }];
    const card = teamCard({ name: 'Launch Team', shortName: 'lt', members, asksFirst: true, reviews: true, latest: [{ title: 'Export brief', at: 0 }] });
    expect(json(card)).toContain('https://acme.example/lena.png');
    expect(json(card)).toContain('*Omar* · Challenger');
    expect(json(card)).toContain('Asks what it needs');
    expect(json(card)).toContain('You accept the result');
    expect(json(card)).toContain('Export brief');
    expect(json(card)).toContain('/team lt');
    const quick = json(teamCard({ name: 'T', members, asksFirst: false, reviews: false, latest: [] }));
    expect(quick).not.toContain('Asks what it needs');
    expect(quick).toContain('It delivers');
  });

  it('shows a process as a strip, then who does each stage where that’s known', () => {
    const card = processCard({
      name: 'Idea to launch',
      shortName: 'itl',
      owner: 'Pat',
      active: 2,
      canStart: true,
      stages: [
        { name: 'Product & brief', kind: 'team', who: 'Launch Team', lead: 'Sam', here: 2 },
        { name: 'Go or no-go', kind: 'people', here: 0 },
      ],
    });
    expect(json(card)).toContain('💡 Comes in  →  👥 *Product &amp; brief*  →  🙋 *Go or no-go*  →  🏁 Done');
    expect(json(card)).toContain('Launch Team · led by Sam · *2 here now*');
    expect(json(card)).toContain('/idea itl');
  });

  it('tells someone who can’t start a process who to ask, not how', () => {
    const card = json(processCard({ name: 'P', owner: 'Pat', active: 0, canStart: false, stages: [{ name: 'A', kind: 'team', here: 0 }] }));
    expect(card).toContain('Ask Pat');
    expect(card).not.toContain('/idea');
  });

  it('can’t be made to ping a channel by a name or purpose', () => {
    const card = json(teamCard({ name: '<!channel>', purpose: '<!here> everyone', members: [], asksFirst: false, reviews: false, latest: [] }));
    expect(card).not.toContain('<!channel>');
    expect(card).not.toContain('<!here>');
  });
});

describe('asking for a card in Slack', () => {
  const TEAM = 'T0ACME';
  const PAT = 'U0ACMEPAT';
  const about = { id: 'tm', name: 'Launch Team', shortName: 'lt', members: [], asksFirst: true, reviews: true, latest: [] };

  function setUp(post: { ok: boolean; error?: string } = { ok: true }) {
    const posts: Array<{ url: string; body: any }> = [];
    const fetchImpl = async (url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      posts.push({ url, body });
      return new Response(JSON.stringify(url.includes('chat.postMessage') ? { ...post, channel: body.channel, ts: '1.1' } : { ok: true }));
    };
    const briefTeam = vi.fn(() => ({ ok: false, error: 'no' }));
    const cmds = new SlackCommands({
      org: {
        teamAbout: (_c: unknown, name: string) => (['lt', 'tm', 'Launch Team'].includes(name) ? about : null),
        teams: () => [{ id: 'tm', name: 'Launch Team', shortName: 'lt', members: [] }],
        teamTasks: () => [],
        resolve: () => null,
        briefTeam,
      } as unknown as OrgService,
      policy: () => DEFAULT_ORG_POLICY,
      botToken: () => 'xoxb-test',
      teamId: () => TEAM,
      log: () => {},
      fetchImpl: fetchImpl as never,
    });
    const slash = (text: string) => cmds.onSlash({ command: '/team', text, user_id: PAT, user_name: 'pat', team_id: TEAM, response_url: 'https://hooks.slack.com/commands/T0ACME/1/abc' });
    return { cmds, posts, briefTeam, slash };
  }

  it('shows it only to the person asking, with a way to share it', async () => {
    const h = setUp();
    await h.slash('lt about');
    expect(h.posts).toHaveLength(1);
    expect(h.posts[0].body.response_type).toBe('ephemeral');
    expect(JSON.stringify(h.posts[0].body.blocks)).toContain(ABOUT_SHARE_ACTION);
    expect(h.briefTeam).not.toHaveBeenCalled();
  });

  it('leaves a task that only ends in the word as a task', async () => {
    const h = setUp();
    await h.slash('lt what is this about');
    expect(h.briefTeam).toHaveBeenCalled();
  });

  const press = { user: { id: PAT, name: 'pat' }, team: { id: TEAM }, actions: [{ action_id: ABOUT_SHARE_ACTION, value: 'team:tm' }], channel: { id: 'C0ACME' }, response_url: 'https://hooks.slack.com/actions/T0ACME/1/abc' };

  it('shares it into the channel the button was pressed in, saying who did', async () => {
    const h = setUp();
    expect(h.cmds.handlesAction(ABOUT_SHARE_ACTION)).toBe(true);
    await h.cmds.onAction(press);
    const shared = h.posts.find((p) => p.url.includes('chat.postMessage'))!;
    expect(shared.body.channel).toBe('C0ACME');
    expect(JSON.stringify(shared.body.blocks)).toContain('Shared by pat');
    expect(JSON.stringify(shared.body.blocks)).not.toContain(ABOUT_SHARE_ACTION);
  });

  it('says what to do when it isn’t in the channel', async () => {
    const h = setUp({ ok: false, error: 'not_in_channel' });
    await h.cmds.onAction(press);
    expect(h.posts.at(-1)!.body.text).toContain('/invite @overgo');
  });

  it('won’t share what the person pressing can’t see', async () => {
    const h = setUp();
    await h.cmds.onAction({ ...press, actions: [{ action_id: ABOUT_SHARE_ACTION, value: 'team:secret' }] });
    expect(h.posts.some((p) => p.url.includes('chat.postMessage'))).toBe(false);
  });

  it('has nothing to say about a name it doesn’t know', () => {
    const h = setUp();
    expect(h.cmds.aboutFor({ name: 'pat', slackUserId: PAT, admin: false }, 'no one')).toBeNull();
  });
});
