import { describe, expect, it } from 'vitest';
import { MAX_SLACK_MESSAGE_BYTES, downloadFile, slackAttachments } from './slackApi';

describe('files shared in Slack', () => {
  const file = (name: string, over = {}) => ({ id: name, name, mimetype: 'application/pdf', url_private: `https://files.example/${name}`, size: 10, ...over });

  it('comes through whole, and says which did not', async () => {
    const got = await slackAttachments([file('gap.pdf'), file('huge.pdf', { size: 90_000_000 }), file('gone.pdf'), file('nolink.pdf', { url_private: undefined })], async (url) => (url.endsWith('gone.pdf') ? null : Buffer.from('x')));
    expect(got.attachments).toEqual([{ id: 'gap.pdf', mimeType: 'application/pdf', dataBase64: 'eA==', label: 'gap.pdf', size: 1 }]);
    expect(got.failed).toEqual(['huge.pdf', 'gone.pdf', 'nolink.pdf']);
  });

  it('takes only so many, and a download that throws is one that failed', async () => {
    const many = await slackAttachments(Array.from({ length: 12 }, (_, n) => file(`f${n}.pdf`)), async () => Buffer.from('x'));
    expect(many.attachments).toHaveLength(10);
    expect(many.failed).toEqual(['f10.pdf', 'f11.pdf']);
    expect((await slackAttachments([file('a.pdf')], async () => { throw new Error('no'); })).failed).toEqual(['a.pdf']);
  });

  it('caps what one message carries in all, and asks each download for no more than is left', async () => {
    const asked: number[] = [];
    const big = 20_000_000;
    const files = [file('a.pdf', { size: big }), file('b.pdf', { size: big }), file('c.pdf', { size: big }), file('d.pdf', { size: 1000 })];
    const got = await slackAttachments(files, async (_url, max) => { asked.push(max); return Buffer.alloc(Math.min(big, max)); });
    expect(got.attachments.map((a) => a.id)).toEqual(['a.pdf', 'b.pdf', 'd.pdf']);
    expect(got.failed).toEqual(['c.pdf']);
    expect(asked).toEqual([25_000_000, 25_000_000, MAX_SLACK_MESSAGE_BYTES - 2 * big]);
    expect(got.attachments.reduce((n, a) => n + (a.size ?? 0), 0)).toBeLessThanOrEqual(MAX_SLACK_MESSAGE_BYTES);
  });

  it('refuses a download that comes back bigger than it was allowed', async () => {
    const got = await slackAttachments([file('liar.pdf', { size: 10 })], async () => Buffer.alloc(30_000_000));
    expect(got.failed).toEqual(['liar.pdf']);
  });
});

describe('downloading a shared file', () => {
  const url = 'https://files.slack.com/files-pri/T1/f.pdf';
  const streamOf = (sizes: number[]) => new Response(new ReadableStream({
    start(c) { for (const n of sizes) c.enqueue(new Uint8Array(n)); c.close(); },
  }));

  it('reads it in pieces, whole when it fits', async () => {
    const res = await downloadFile('xoxb-test', url, 100, async () => streamOf([40, 40]));
    expect(res.ok && res.data.length).toBe(80);
  });

  it('stops reading once it passes the cap, without a size header to go on', async () => {
    let pulled = 0;
    const body = new ReadableStream({ pull(c) { pulled++; c.enqueue(new Uint8Array(60)); } });
    const res = await downloadFile('xoxb-test', url, 100, async () => new Response(body));
    expect(res).toEqual({ ok: false, error: 'That file is too large to pass on.' });
    expect(pulled).toBeLessThan(5);
  });

  it('refuses before reading when the size header is over the cap', async () => {
    const res = await downloadFile('xoxb-test', url, 100, async () => new Response('x'.repeat(10), { headers: { 'content-length': '500' } }));
    expect(res.ok).toBe(false);
  });
});
