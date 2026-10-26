// Model ids as the server's model provider names them.
//
// overcli's catalog speaks Anthropic's ids (`claude-opus-5-5`). Claude Code
// on Bedrock (`CLAUDE_CODE_USE_BEDROCK=1`) wants Bedrock's: `anthropic.`
// in front, and an inference profile (`us.`, `eu.`, `apac.`, `global.`)
// before that when the account calls models through one, as most do. On
// Vertex (`CLAUDE_CODE_USE_VERTEX=1`) current models go by the same id, so
// nothing changes there unless an admin says otherwise.
//
// Which inference profile an account uses isn't something the server can
// see, so the org's rules can name each id (`OrgPolicy.providerModels`), or
// give one pattern for all of them under `*`: `"*": "us.anthropic.{id}"`.
// The aliases Claude Code resolves itself (`opus`, `sonnet`, `haiku`, with
// `ANTHROPIC_DEFAULT_OPUS_MODEL` and the like) are left alone.

export type ModelProviderKind = 'anthropic' | 'bedrock' | 'vertex';

const on = (env: NodeJS.ProcessEnv, name: string) => /^(1|true|yes)$/i.test(env[name]?.trim() ?? '');

export function modelProvider(env: NodeJS.ProcessEnv = process.env): ModelProviderKind {
  if (on(env, 'CLAUDE_CODE_USE_BEDROCK')) return 'bedrock';
  if (on(env, 'CLAUDE_CODE_USE_VERTEX')) return 'vertex';
  return 'anthropic';
}

/// Already the provider's own: an ARN, an inference profile or `anthropic.`
/// id, or an alias the CLI resolves.
function providerShaped(model: string): boolean {
  return /^arn:/.test(model) || /(^|\.)anthropic\./.test(model) || /^(opus|sonnet|haiku|fable|default|opusplan)(\[1m\])?$/i.test(model);
}

/// `model` as the provider calls it. `overrides` is the org's map: an exact
/// id first, then `*` with `{id}` standing for the id.
export function providerModelId(model: string, provider: ModelProviderKind, overrides: Record<string, string> = {}): string {
  if (!model || provider === 'anthropic') return model;
  const exact = overrides[model];
  if (exact) return exact;
  if (providerShaped(model) || !/^claude-/.test(model)) return model;
  const pattern = overrides['*'];
  if (pattern) return pattern.includes('{id}') ? pattern.replace('{id}', model) : `${pattern}${model}`;
  return provider === 'bedrock' ? `anthropic.${model}` : model;
}

let overridesOf: () => Record<string, string> | undefined = () => undefined;

/// Where the org's map is read from: set by a host that has org rules.
export function setProviderModels(read: () => Record<string, string> | undefined): void {
  overridesOf = read;
}

/// `providerModelId` for the server this process runs as.
export function resolveClaudeModel(model: string, env: NodeJS.ProcessEnv = process.env): string {
  const provider = modelProvider(env);
  if (provider === 'anthropic') return model;
  let overrides: Record<string, string> | undefined;
  try {
    overrides = overridesOf();
  } catch {
    overrides = undefined;
  }
  return providerModelId(model, provider, overrides ?? {});
}
