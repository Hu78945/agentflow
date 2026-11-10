/** USD per million tokens. Source: Anthropic public pricing (2026-11). */
interface Price {
  input: number;
  output: number;
  /** Long-prompt tier: applies when the prompt exceeds `threshold` tokens. */
  longPrompt?: { threshold: number; input: number; output: number };
}

const PRICES: Record<string, Price> = {
  'claude-haiku-5-5': { input: 0.1, output: 0.5, longPrompt: { threshold: 100_000, input: 0.5, output: 2.5 } },
  'claude-sonnet-5-5': { input: 2, output: 10 },
  'claude-opus-5-5': { input: 4, output: 20 },
};

// Prompt-cache multipliers relative to the base input price (5-minute TTL writes).
const CACHE_READ = 0.1;
const CACHE_WRITE = 1.25;

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

/** Cost of one Messages API call in USD, rounded to 1e-8. Throws for unknown models so cost is never silently 0. */
export function costUsd(model: string, u: Usage): number {
  const price = PRICES[model];
  if (!price) throw new Error(`No pricing for model "${model}"`);
  const promptTokens = u.inputTokens + u.cacheReadTokens + u.cacheWriteTokens;
  const tier = price.longPrompt && promptTokens > price.longPrompt.threshold ? price.longPrompt : price;
  const micro =
    u.inputTokens * tier.input +
    u.cacheReadTokens * tier.input * CACHE_READ +
    u.cacheWriteTokens * tier.input * CACHE_WRITE +
    u.outputTokens * tier.output;
  return Math.round(micro * 100) / 1e8; // micro-dollars -> dollars, 8 decimal places
}

export function isPricedModel(model: string): boolean {
  return model in PRICES;
}
