import { afterEach, describe, expect, it } from 'vitest';
import { modelProvider, providerModelId, resolveClaudeModel, setProviderModels } from './providerModels';

describe('provider model ids', () => {
  afterEach(() => setProviderModels(() => undefined));

  it('reads the provider from the environment Claude Code reads', () => {
    expect(modelProvider({})).toBe('anthropic');
    expect(modelProvider({ CLAUDE_CODE_USE_BEDROCK: '1' })).toBe('bedrock');
    expect(modelProvider({ CLAUDE_CODE_USE_VERTEX: 'true' })).toBe('vertex');
  });

  it('leaves ids alone on the Anthropic API and Vertex', () => {
    expect(providerModelId('claude-opus-5-5', 'anthropic', { 'claude-opus-5-5': 'x' })).toBe('claude-opus-5-5');
    expect(providerModelId('claude-opus-5-5', 'vertex')).toBe('claude-opus-5-5');
  });

  it('puts anthropic. in front on Bedrock', () => {
    expect(providerModelId('claude-sonnet-5-5', 'bedrock')).toBe('anthropic.claude-sonnet-5-5');
  });

  it('uses the org map: an exact id, then a pattern for the rest', () => {
    const map = { 'claude-opus-5-5': 'acme-opus-profile', '*': 'us.anthropic.{id}' };
    expect(providerModelId('claude-opus-5-5', 'bedrock', map)).toBe(map['claude-opus-5-5']);
    expect(providerModelId('claude-haiku-5-5', 'bedrock', map)).toBe('us.anthropic.claude-haiku-5-5');
    expect(providerModelId('claude-haiku-5-5', 'bedrock', { '*': 'global.anthropic.' })).toBe('global.anthropic.claude-haiku-5-5');
    expect(providerModelId('claude-haiku-5-5', 'vertex', { 'claude-haiku-5-5': 'claude-haiku-5-5@20261001' })).toBe('claude-haiku-5-5@20261001');
  });

  it('leaves the provider\'s own ids and the CLI\'s aliases alone', () => {
    expect(providerModelId('us.anthropic.claude-opus-5-5', 'bedrock', { '*': 'eu.anthropic.{id}' })).toBe('us.anthropic.claude-opus-5-5');
    expect(providerModelId('opus', 'bedrock')).toBe('opus');
    expect(providerModelId('sonnet[1m]', 'bedrock')).toBe('sonnet[1m]');
  });

  it('resolves with the org map the host set', () => {
    setProviderModels(() => ({ '*': 'eu.anthropic.{id}' }));
    expect(resolveClaudeModel('claude-opus-5-5', { CLAUDE_CODE_USE_BEDROCK: '1' })).toBe('eu.anthropic.claude-opus-5-5');
    expect(resolveClaudeModel('claude-opus-5-5', {})).toBe('claude-opus-5-5');
  });
});
