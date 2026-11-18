import { afterEach, describe, expect, it } from 'vitest';

import { bedrockSigner } from './workerCloudSdk';

// The real signer, with keys from the environment: no network, no role.
describe('bedrockSigner', () => {
  const saved = { ...process.env };
  afterEach(() => {
    process.env = { ...saved };
  });

  it('signs a model call for Bedrock in the region', async () => {
    process.env.AWS_ACCESS_KEY_ID = 'AKIDEXAMPLE';
    process.env.AWS_SECRET_ACCESS_KEY = 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY';
    delete process.env.AWS_SESSION_TOKEN;
    delete process.env.AWS_PROFILE;
    const signer = await bedrockSigner('eu-west-2');
    const headers = await signer.sign({ method: 'POST', hostname: 'bedrock-runtime.eu-west-2.amazonaws.com', path: '/model/anthropic.claude-v1%3A0/invoke', headers: { 'content-type': 'application/json' }, body: Buffer.from('{}') });
    expect(headers.authorization).toMatch(/^AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE\/\d{8}\/eu-west-2\/bedrock\/aws4_request, SignedHeaders=content-type;host;x-amz-[\w;-]+, Signature=[0-9a-f]{64}$/);
    expect(headers.host).toBe('bedrock-runtime.eu-west-2.amazonaws.com');
    expect(headers['x-amz-date']).toMatch(/^\d{8}T\d{6}Z$/);
  });
});
