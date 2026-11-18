import { Readable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';

import { BedrockProxy, bedrockPath } from './bedrockProxy';

describe('bedrockPath', () => {
  it('lets model calls through, encoded the way the SDK signs them', () => {
    expect(bedrockPath('/model/us.anthropic.claude-sonnet-4-5-v1:0/invoke-with-response-stream')).toBe('/model/us.anthropic.claude-sonnet-4-5-v1%3A0/invoke-with-response-stream');
    expect(bedrockPath('/model/us.anthropic.claude-sonnet-4-5-v1%3A0/invoke')).toBe('/model/us.anthropic.claude-sonnet-4-5-v1%3A0/invoke');
    const profile = encodeURIComponent(`arn:aws:bedrock:us-east-1:${'1'.repeat(12)}:application-inference-profile/abc`);
    expect(bedrockPath(`/model/${profile}/converse`)).toBe(`/model/${profile}/converse`);
  });

  it('refuses everything else', () => {
    for (const p of ['/', '/model/x/delete', '/foundation-models', '/model/x/invoke?x=1', '/model/%E0/invoke', '/model/a/b/invoke', '/guardrail/x/apply']) expect(bedrockPath(p)).toBeNull();
  });
});

describe('BedrockProxy', () => {
  it('signs a model call with the server and streams the answer back', async () => {
    const sign = vi.fn(async (r: { headers: Record<string, string> }) => ({ ...r.headers, authorization: 'AWS4-HMAC-SHA256 signed' }));
    const send = vi.fn(async () => ({ status: 200, headers: { 'content-type': 'application/vnd.amazon.eventstream', 'set-cookie': 'nope' }, body: Readable.from([Buffer.from('chunk-1'), Buffer.from('chunk-2')]) }));
    const proxy = new BedrockProxy({ region: 'us-east-1', signer: { sign }, send, log: () => {} });
    await proxy.start();
    try {
      const { ANTHROPIC_BEDROCK_BASE_URL: base, CLAUDE_CODE_SKIP_BEDROCK_AUTH: skip } = proxy.env();
      expect(skip).toBe('1');
      const res = await fetch(`${base}/model/anthropic.claude-v1:0/invoke-with-response-stream`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer from-a-worker', 'x-amzn-bedrock-trace': 'ENABLED' }, body: '{"messages":[]}' });
      expect(res.status).toBe(200);
      expect(res.headers.get('set-cookie')).toBeNull();
      expect(await res.text()).toBe('chunk-1chunk-2');
      const signed = sign.mock.calls[0][0] as unknown as { hostname: string; path: string; headers: Record<string, string>; body: Buffer };
      expect(signed.hostname).toBe('bedrock-runtime.us-east-1.amazonaws.com');
      expect(signed.path).toBe('/model/anthropic.claude-v1%3A0/invoke-with-response-stream');
      expect(signed.headers).toMatchObject({ 'content-type': 'application/json', 'x-amzn-bedrock-trace': 'ENABLED' });
      expect(Object.keys(signed.headers).sort()).toEqual(['accept', 'content-type', 'x-amzn-bedrock-trace']);
      expect(signed.body.toString()).toBe('{"messages":[]}');
      const [url, headers] = send.mock.calls[0] as unknown as [URL, Record<string, string>];
      expect(url.href).toBe('https://bedrock-runtime.us-east-1.amazonaws.com/model/anthropic.claude-v1%3A0/invoke-with-response-stream');
      expect(headers.authorization).toBe('AWS4-HMAC-SHA256 signed');
    } finally {
      proxy.stop();
    }
  });

  it('forwards nothing but model calls', async () => {
    const sign = vi.fn();
    const proxy = new BedrockProxy({ region: 'us-east-1', signer: { sign }, send: vi.fn(), log: () => {} });
    await proxy.start();
    try {
      const base = proxy.env().ANTHROPIC_BEDROCK_BASE_URL;
      expect((await fetch(`${base}/model/x/invoke`)).status).toBe(403);
      expect((await fetch(`${base}/secrets`, { method: 'POST', body: '{}' })).status).toBe(403);
      expect(sign).not.toHaveBeenCalled();
    } finally {
      proxy.stop();
    }
  });
});
