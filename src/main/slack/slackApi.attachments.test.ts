import { describe, expect, it } from 'vitest';
import { slackAttachments } from './slackApi';

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
});
