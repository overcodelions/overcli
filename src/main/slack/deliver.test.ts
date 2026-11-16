import { describe, expect, it } from 'vitest';
import { deliverText, folderPicks, foldersInReply, MAX_TAGS, tagPeople, type DeliverIo } from './deliver';

const DIR = '/data/worker-files/w1/2026-11-06-errand-pricing-spec';
const FILES: Record<string, string> = { 'prfaq.md': 'P', 'spec.md': 'S', 'research.md': 'R', 'notes.bin': 'x', '.ledger.json': 'l' };

function io(over: Partial<DeliverIo> = {}) {
  const posts: string[] = [];
  const uploads: string[] = [];
  const api: DeliverIo = {
    post: async (_c, t) => void posts.push(t),
    upload: async (_c, _ts, n) => (uploads.push(n), true),
    readFile: () => null,
    workerFile: (_w, p) => (p.startsWith(`${DIR}/`) && FILES[p.slice(DIR.length + 1)] ? Buffer.from(FILES[p.slice(DIR.length + 1)]) : null),
    workerFolder: (_w, p) => (p === DIR ? Object.keys(FILES) : null),
    ...over,
  };
  return { api, posts, uploads };
}
const send = (x: ReturnType<typeof io>, text: string, hold = false) => deliverText(x.api, 'C1', '1.1', 'Hugo', text, 'answer.md', 'w1', { name: 'Hugo' }, hold);

describe('a folder a reply names', () => {
  it('sends what is in it, whatever a single document would do, and drops the path', async () => {
    const x = io();
    const held = await send(x, `Done.\n\nFiles are in ${DIR}/ (start with \`spec.md\`).`, true);
    expect(held).toEqual([]);
    expect(x.uploads).toEqual(['spec.md', 'prfaq.md', 'research.md']);
    expect(x.posts[0]).toContain('Files are attached');
    expect(x.posts[0]).not.toContain('/data/worker-files');
  });

  it('leaves a folder outside its files as text, and sends nothing', async () => {
    const x = io();
    await send(x, 'See /etc/secrets/ for more.');
    expect(x.uploads).toEqual([]);
    expect(x.posts[0]).toContain('/etc/secrets');
  });

  it('says when there is more than fits', async () => {
    const many = Object.fromEntries(Array.from({ length: 10 }, (_, n) => [`f${n}.md`, 'x']));
    const x = io({ workerFile: () => Buffer.from('x'), workerFolder: () => Object.keys(many) });
    await send(x, `All in ${DIR}/`);
    expect(x.uploads).toHaveLength(8);
    expect(x.posts.at(-1)).toContain('2 more files');
  });

  it('still holds one document it names, for the button', async () => {
    const x = io();
    const held = await send(x, `Full write-up: ${DIR}/spec.md`, true);
    expect(held.map((f) => f.name)).toEqual(['spec.md']);
    expect(x.uploads).toEqual([]);
  });

  it('finds folders, not files, in a reply', () => {
    expect(foldersInReply(`in ${DIR}/ and ${DIR}/spec.md and /a/b/../c/`)).toEqual([DIR]);
  });

  it('picks what the reply names first, and only what Slack can show', () => {
    expect(folderPicks(Object.keys(FILES), 'start with spec.md')).toEqual(['spec.md', 'prfaq.md', 'research.md']);
  });
});

describe('tagging people a reply names', () => {
  const people = [
    { name: 'Priya Shah', slackUserId: 'U0PRIYA', handle: 'pshah' },
    { name: 'Jane Doe', slackUserId: 'U0JANE' },
    { name: 'Sam Lee', slackUserId: 'U0SAM1' },
    { name: 'Sam Lee', slackUserId: 'U0SAM2' },
  ];

  it('turns @Full Name and @handle into Slack mentions, whatever the case', () => {
    expect(tagPeople('Over to @Priya Shah and @jane doe.', people)).toBe('Over to <@U0PRIYA> and <@U0JANE>.');
    expect(tagPeople('cc @pshah', people)).toBe('cc <@U0PRIYA>');
  });

  it('leaves names it can not be sure of, code and email addresses alone', () => {
    expect(tagPeople('Ask @Sam Lee', people)).toBe('Ask @Sam Lee');
    expect(tagPeople('Ask @Someone Else', people)).toBe('Ask @Someone Else');
    expect(tagPeople('Run `@Priya Shah` or write to priya@acme.example', people)).toBe('Run `@Priya Shah` or write to priya@acme.example');
    expect(tagPeople('Priya Shah should look', people)).toBe('Priya Shah should look');
    expect(tagPeople('@Priyax', people)).toBe('@Priyax');
  });

  it('tags a first name alone when only one person has it', () => {
    expect(tagPeople('Over to @Priya, she decides.', people)).toBe('Over to <@U0PRIYA>, she decides.');
    expect(tagPeople('@jane?', people)).toBe('<@U0JANE>?');
    // Two Sams: a guess either way.
    expect(tagPeople('Ask @Sam', people)).toBe('Ask @Sam');
    // A first name that is someone else's handle stays theirs.
    const clash = [...people, { name: 'Pat Kim', slackUserId: 'U0PAT', handle: 'jane' }];
    expect(tagPeople('@jane', clash)).toBe('<@U0PAT>');
  });

  it('tags at most a handful of people in one message', () => {
    const many = Array.from({ length: 8 }, (_, n) => ({ name: `Person${n}`, slackUserId: `U0P${n}` }));
    const out = tagPeople(many.map((p) => `@${p.name}`).join(' '), many);
    expect(out.match(/<@U0P\d>/g)).toHaveLength(MAX_TAGS);
  });

  it('tags in the posted reply when the reader knows the people', async () => {
    const x = io({ people: () => people });
    await send(x, '**Over to @Priya Shah.** She decides.');
    expect(x.posts[0]).toContain('<@U0PRIYA>');
  });
});
