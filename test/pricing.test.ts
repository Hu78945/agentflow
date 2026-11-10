import { describe, expect, it } from 'vitest';
import { costUsd } from '../src/llm/pricing';
import { embed, EMBEDDING_DIM } from '../src/memory/embed';

const usage = (inputTokens: number, outputTokens: number, cacheReadTokens = 0, cacheWriteTokens = 0) => ({
  inputTokens,
  outputTokens,
  cacheReadTokens,
  cacheWriteTokens,
});

describe('costUsd', () => {
  it('prices input and output per million tokens', () => {
    expect(costUsd('claude-sonnet-5-5', usage(1_000_000, 0))).toBe(2);
    expect(costUsd('claude-sonnet-5-5', usage(0, 1_000_000))).toBe(10);
    expect(costUsd('claude-opus-5-5', usage(1200, 350))).toBe(0.0118); // 1200*4e-6 + 350*20e-6
  });

  it('bills cache reads at 0.1x and cache writes at 1.25x of input', () => {
    expect(costUsd('claude-sonnet-5-5', usage(0, 0, 1_000_000, 0))).toBe(0.2);
    expect(costUsd('claude-sonnet-5-5', usage(0, 0, 0, 1_000_000))).toBe(2.5);
  });

  it('switches Haiku 5.5 to the long-prompt tier above 100K prompt tokens, counting cached tokens', () => {
    expect(costUsd('claude-haiku-5-5', usage(100_000, 1000))).toBe(0.0105); // exactly 100K: base tier
    // 60K*0.50 + 40,001 cache-read*0.50*0.1 + 1K*2.50 micro-dollars
    expect(costUsd('claude-haiku-5-5', usage(60_000, 1000, 40_001))).toBe(0.03450005);
  });

  it('refuses to price unknown models instead of reporting $0', () => {
    expect(() => costUsd('gpt-whatever', usage(1, 1))).toThrow(/No pricing/);
  });
});

describe('embed', () => {
  it('is deterministic, unit-length and order-insensitive', () => {
    const a = embed('Postgres stores the vectors');
    expect(a).toHaveLength(EMBEDDING_DIM);
    expect(Math.hypot(...a)).toBeCloseTo(1, 10);
    expect(embed('the vectors Postgres STORES')).toEqual(a);
    expect(embed('')).toEqual(new Array(EMBEDDING_DIM).fill(0));
  });
});
