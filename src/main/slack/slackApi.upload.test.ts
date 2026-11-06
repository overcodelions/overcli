import { describe, expect, it } from 'vitest';
import { isMissingScope, postMessage, uploadFile } from './slackApi';

describe('a call the app lacks the permission for', () => {
  it('is told apart however Slack’s error is worded', () => {
    expect(isMissingScope('missing_scope')).toBe(true);
    expect(isMissingScope('Slack chat.postMessage: missing_scope')).toBe(true);
    expect(isMissingScope('Slack chat.postMessage: channel_not_found')).toBe(false);
  });

  it('matches what a real failed post returns', async () => {
    const fetchImpl = async () => new Response(JSON.stringify({ ok: false, error: 'missing_scope' }));
    const res = await postMessage('xoxb-test', { channel: 'C0ACME', text: 'x', username: 'Ada' }, fetchImpl as never);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(isMissingScope(res.error)).toBe(true);
  });
});

function fakeSlack(share: (body: Record<string, unknown>) => Record<string, unknown>) {
  const shares: Array<Record<string, unknown>> = [];
  const fetchImpl = async (url: string, init?: { body?: unknown }) => {
    if (url.includes('files.getUploadURLExternal')) return new Response(JSON.stringify({ ok: true, upload_url: 'https://files.slack.example/up', file_id: 'F1' }));
    if (url.includes('files.completeUploadExternal')) {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      shares.push(body);
      return new Response(JSON.stringify(share(body)));
    }
    return new Response('ok');
  };
  return { shares, fetchImpl: fetchImpl as never };
}

const file = { channel: 'C0ACME', threadTs: '100.1', filename: 'report.md', bytes: Buffer.from('# Report') };
const as = { name: 'Pricing', iconUrl: 'https://acme.example/pricing.png' };

describe('sharing a file', () => {
  it('goes up under the name and picture it was given', async () => {
    const slack = fakeSlack(() => ({ ok: true }));
    expect(await uploadFile('xoxb-test', { ...file, as }, slack.fetchImpl)).toEqual({ ok: true, data: { fileId: 'F1' } });
    expect(slack.shares).toHaveLength(1);
    expect(slack.shares[0]).toMatchObject({ channel_id: 'C0ACME', thread_ts: '100.1', username: 'Pricing' });
    expect(slack.shares[0].icon_url).toContain('acme.example/pricing.png');
  });

  it('goes up as the app when it was given no one', async () => {
    const slack = fakeSlack(() => ({ ok: true }));
    await uploadFile('xoxb-test', file, slack.fetchImpl);
    expect(slack.shares[0]).not.toHaveProperty('username');
    expect(slack.shares[0]).not.toHaveProperty('icon_url');
  });

  it('still arrives, as the app, when the app can’t post under other names', async () => {
    const slack = fakeSlack((b) => (b.username ? { ok: false, error: 'missing_scope' } : { ok: true }));
    expect(await uploadFile('xoxb-test', { ...file, as }, slack.fetchImpl)).toEqual({ ok: true, data: { fileId: 'F1' } });
    expect(slack.shares).toHaveLength(2);
    expect(slack.shares[1]).not.toHaveProperty('username');
  });

  it('says so when sharing fails for any other reason, without trying again', async () => {
    const slack = fakeSlack(() => ({ ok: false, error: 'channel_not_found' }));
    expect(await uploadFile('xoxb-test', { ...file, as }, slack.fetchImpl)).toMatchObject({ ok: false, error: expect.stringContaining('channel_not_found') });
    expect(slack.shares).toHaveLength(1);
  });
});
