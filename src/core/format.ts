import type { Usage } from './types.js';

export function fmtNumber(n: number): string {
  if (n < 1000) return `${n}`;
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`;
  return `${(n / 1_000_000).toFixed(2)}M`;
}

/**
 * Reference-only USD cost using public Anthropic API pricing. NOT a real bill
 * when the user is on a Pro/Max subscription. Numbers here are conservative
 * defaults — keep them updateable.
 */
const PRICES_PER_MTOK: Record<string, { in: number; out: number; cacheWrite: number; cacheRead: number }> = {
  // Claude Sonnet 4.x family
  'claude-sonnet-4': { in: 3, out: 15, cacheWrite: 3.75, cacheRead: 0.3 },
  // Opus 4.x family
  'claude-opus-4': { in: 15, out: 75, cacheWrite: 18.75, cacheRead: 1.5 },
  // Haiku 4.x family
  'claude-haiku-4': { in: 0.8, out: 4, cacheWrite: 1, cacheRead: 0.08 },
  // OpenAI o4-mini — default Codex CLI model; also used for "codex" key
  'openai-o4-mini': { in: 1.1, out: 4.4, cacheWrite: 0, cacheRead: 0.275 },
  // OpenAI o3
  'openai-o3': { in: 10, out: 40, cacheWrite: 0, cacheRead: 2.5 },
  // OpenAI o3-mini
  'openai-o3-mini': { in: 1.1, out: 4.4, cacheWrite: 0, cacheRead: 0.275 },
  // OpenAI GPT-4o
  'openai-gpt-4o': { in: 2.5, out: 10, cacheWrite: 0, cacheRead: 1.25 },
  // OpenAI GPT-4o mini
  'openai-gpt-4o-mini': { in: 0.15, out: 0.6, cacheWrite: 0, cacheRead: 0.075 },
};

function priceKey(model: string): keyof typeof PRICES_PER_MTOK | null {
  const m = model.toLowerCase();
  // Claude
  if (m.includes('opus')) return 'claude-opus-4';
  if (m.includes('haiku')) return 'claude-haiku-4';
  if (m.includes('sonnet')) return 'claude-sonnet-4';
  // OpenAI / Codex — "codex" key maps to o4-mini (Codex CLI default)
  if (m === 'codex' || m.includes('o4-mini')) return 'openai-o4-mini';
  if (m.includes('o3-mini')) return 'openai-o3-mini';
  if (m === 'o3' || m.endsWith('-o3')) return 'openai-o3';
  if (m.includes('gpt-4o-mini')) return 'openai-gpt-4o-mini';
  if (m.includes('gpt-4o')) return 'openai-gpt-4o';
  return null;
}

export function estimateCostUSD(model: string, u: Usage): number | null {
  const key = priceKey(model);
  if (!key) return null;
  const p = PRICES_PER_MTOK[key];
  const perTok = 1 / 1_000_000;
  return (
    u.input_tokens * p.in * perTok +
    u.output_tokens * p.out * perTok +
    u.cache_creation_input_tokens * p.cacheWrite * perTok +
    u.cache_read_input_tokens * p.cacheRead * perTok
  );
}

export type CostCategory = 'input' | 'output' | 'cacheWrite' | 'cacheRead';

export function categoryCostUSD(
  model: string,
  category: CostCategory,
  tokens: number,
): number | null {
  const key = priceKey(model);
  if (!key) return null;
  const p = PRICES_PER_MTOK[key];
  const rate =
    category === 'input'
      ? p.in
      : category === 'output'
        ? p.out
        : category === 'cacheWrite'
          ? p.cacheWrite
          : p.cacheRead;
  return (tokens * rate) / 1_000_000;
}

/**
 * Returns the context window size in tokens for a given model.
 * All current Claude models share a 200k window. Falls back to 200k for
 * unknown models so the bar is always renderable.
 */
export function contextWindowSize(_model: string): number {
  return 200_000;
}

export function fmtUSD(n: number): string {
  if (n < 0.01) return `$${n.toFixed(4)}`;
  if (n < 1) return `$${n.toFixed(3)}`;
  return `$${n.toFixed(2)}`;
}
