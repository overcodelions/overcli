import { describe, expect, it } from 'vitest';
import { classifyModelError, modelIdTestArgs, readModelIdTest, testModelIds, type ModelIdRunner } from './modelIdTest';

const result = (fields: Record<string, unknown>) => JSON.stringify({ type: 'result', subtype: 'success', ...fields });

describe('model id test', () => {
  it('asks the CLI for one cheap answer: no tools, MCP servers or settings', () => {
    const args = modelIdTestArgs('us.anthropic.claude-opus-5-5');
    expect(args).toEqual(expect.arrayContaining(['-p', '--model', 'us.anthropic.claude-opus-5-5', '--strict-mcp-config', '--no-session-persistence']));
    expect(args[args.indexOf('--tools') + 1]).toBe('');
    expect(args[args.indexOf('--setting-sources') + 1]).toBe('');
    expect(args[args.indexOf('--output-format') + 1]).toBe('json');
  });

  it('reads a good answer', () => {
    const r = readModelIdTest('m', 'bedrock', { stdout: `noise\n${result({ is_error: false, result: 'ok', duration_ms: 812 })}\n`, stderr: '', timedOut: false, ms: 900 });
    expect(r).toEqual({ model: 'm', ok: true, verdict: 'ok', message: 'Works.', ms: 812 });
  });

  it.each([
    ['needs-profile', 'API Error: 400 Invocation of model ID anthropic.claude-opus-5-5 with on-demand throughput isn’t supported. Retry your request with the ID or ARN of an inference profile that contains this model.', 400],
    ['credentials', 'Could not load credentials from any providers', undefined],
    ['credentials', 'API Error: 403 The security token included in the request is expired', 403],
    ['not-enabled', 'API Error: 403 You don’t have access to the model with the specified model ID.', 403],
    ['denied', 'API Error: 403 User: arn:aws:sts::ACCOUNT:assumed-role/AcmeReadOnly/pat is not authorized to perform: bedrock:InvokeModel on resource: arn:aws:bedrock:us-east-1:ACCOUNT:inference-profile/us.anthropic.claude-haiku-5-5 because no identity-based policy allows the bedrock:InvokeModel action', 403],
    ['unknown-id', 'API Error: 400 The provided model identifier is invalid.', 400],
    ['unknown-id', "There's an issue with the selected model (us.anthropic.claude-nope). It may not exist or you may not have access to it.", 404],
    ['denied', 'Forbidden', 403],
    ['error', 'API Error: 529 Overloaded', 529],
  ] as const)('calls it %s: %s', (verdict, text, status) => {
    expect(classifyModelError(text, 'bedrock', status).verdict).toBe(verdict);
  });

  it('names the provider’s own fix', () => {
    expect(classifyModelError('Could not load credentials', 'bedrock').message).toMatch(/AWS_BEARER_TOKEN_BEDROCK/);
    expect(classifyModelError('Could not load the default credentials', 'vertex').message).toMatch(/service account/);
  });

  it('keeps the provider’s words, cut short, for a failure', () => {
    const r = readModelIdTest('m', 'bedrock', { stdout: result({ is_error: true, api_error_status: 400, result: `The provided model identifier is invalid. ${'x'.repeat(600)}` }), stderr: '', timedOut: false, ms: 300 });
    expect(r).toMatchObject({ ok: false, verdict: 'unknown-id' });
    expect(r.detail!.length).toBeLessThanOrEqual(401);
  });

  it('reads a crash with no result line from stderr', () => {
    const r = readModelIdTest('m', 'bedrock', { stdout: '', stderr: 'Error: Could not load credentials from any providers', timedOut: false, ms: 50 });
    expect(r.verdict).toBe('credentials');
  });

  it('says so when it took too long', () => {
    expect(readModelIdTest('m', 'bedrock', { stdout: '', stderr: '', timedOut: true, ms: 60_000 }).verdict).toBe('timeout');
  });

  it('runs each id once, a few at a time, and refuses odd ones without running', async () => {
    let live = 0;
    let most = 0;
    const seen: string[] = [];
    const run: ModelIdRunner = async (_bin, args) => {
      live++;
      most = Math.max(most, live);
      seen.push(args[args.indexOf('--model') + 1]);
      await new Promise((r) => setTimeout(r, 10));
      live--;
      return { stdout: result({ is_error: false, result: 'ok' }), stderr: '', timedOut: false };
    };
    const ids = ['a1', 'a2', 'a3', 'a4', 'a5', 'a1', 'bad id; rm -rf /'];
    const out = await testModelIds(ids, { bin: '/usr/bin/claude', env: {}, provider: 'bedrock', run, concurrency: 2 });
    expect(out.map((r) => r.model)).toEqual(['a1', 'a2', 'a3', 'a4', 'a5', 'bad id; rm -rf /']);
    expect(out.slice(0, 5).every((r) => r.ok)).toBe(true);
    expect(out[5]).toMatchObject({ ok: false, verdict: 'unknown-id' });
    expect(seen.sort()).toEqual(['a1', 'a2', 'a3', 'a4', 'a5']);
    expect(most).toBe(2);
  });

  it('says the CLI is missing rather than running nothing', async () => {
    const [r] = await testModelIds(['us.anthropic.claude-opus-5-5'], { bin: null, env: {}, provider: 'bedrock' });
    expect(r.verdict).toBe('no-cli');
  });
});
