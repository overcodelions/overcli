import { describe, expect, it } from 'vitest';
import { postMessage } from './slackApi';

describe('posting under a worker’s picture', () => {
  it('sends Slack a drawn picture on the dark tile', async () => {
    const sent: string[] = [];
    const fetchImpl = (async (_url: string, init?: RequestInit) => {
      sent.push(String(init?.body));
      return new Response(JSON.stringify({ ok: true, channel: 'C0ACME', ts: '1.2' }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }) as never;
    const res = await postMessage('xoxb-acme', { channel: 'C0ACME', text: 'hi', username: 'Robin', iconUrl: 'https://api.dicebear.com/9.x/adventurer/png?seed=abc&size=256' }, fetchImpl);
    expect(res.ok).toBe(true);
    const body = JSON.parse(sent[0]) as { icon_url: string };
    expect(new URL(body.icon_url).searchParams.get('backgroundColor')).toBe('1f2430');
  });
});
