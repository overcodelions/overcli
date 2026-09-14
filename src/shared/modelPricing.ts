// Anthropic API list prices, used to weight usage rather than to bill anyone.
// Subscription limits aren't published per token, but they track API cost far
// better than raw token counts do: a cache read is a tenth the price of fresh
// input, so a long conversation's millions of cache reads look enormous in a
// token tally while costing less than one burst of Opus output.

export interface ModelPrice {
  /// USD per million input tokens.
  input: number;
  /// USD per million output tokens.
  output: number;
}

/// First prefix match wins, so older, pricier ids sit above the family
/// catch-alls (`claude-opus-4-1` before `claude-opus`).
const PRICES: Array<[string, ModelPrice]> = [
  ['claude-fable', { input: 10, output: 50 }],
  ['claude-mythos', { input: 10, output: 50 }],
  ['claude-opus-4-1', { input: 15, output: 75 }],
  ['claude-opus-4-2', { input: 15, output: 75 }],
  ['claude-3-opus', { input: 15, output: 75 }],
  ['claude-opus', { input: 5, output: 25 }],
  ['claude-sonnet-5', { input: 2, output: 10 }],
  ['claude-sonnet', { input: 3, output: 15 }],
  ['claude-3-5-sonnet', { input: 3, output: 15 }],
  ['claude-3-7-sonnet', { input: 3, output: 15 }],
  ['claude-haiku', { input: 1, output: 5 }],
  ['claude-3-5-haiku', { input: 0.8, output: 4 }],
  ['claude-3-haiku', { input: 0.25, output: 1.25 }],
];

/// Unknown ids price as Sonnet — the middle of the range, so a new model
/// neither vanishes from the chart nor dominates it before this table catches up.
const FALLBACK: ModelPrice = { input: 3, output: 15 };

export function claudeModelPrice(model: string): ModelPrice {
  for (const [prefix, price] of PRICES) {
    if (model.startsWith(prefix)) return price;
  }
  return FALLBACK;
}

export interface TokenMix {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite5m: number;
  cacheWrite1h: number;
}

export interface CostBreakdown {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  total: number;
}

/// Cache reads bill at 0.1× input, 5-minute cache writes at 1.25×, 1-hour
/// writes at 2×.
export function estimateCost(model: string, mix: TokenMix): CostBreakdown {
  const p = claudeModelPrice(model);
  const input = (mix.input * p.input) / 1e6;
  const output = (mix.output * p.output) / 1e6;
  const cacheRead = (mix.cacheRead * p.input * 0.1) / 1e6;
  const cacheWrite = (mix.cacheWrite5m * p.input * 1.25 + mix.cacheWrite1h * p.input * 2) / 1e6;
  return { input, output, cacheRead, cacheWrite, total: input + output + cacheRead + cacheWrite };
}
