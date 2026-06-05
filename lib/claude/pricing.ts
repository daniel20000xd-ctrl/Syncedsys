// Anthropic list prices (USD per 1,000,000 tokens) used to compute what an in-app
// Claude request costs when it runs on the PLATFORM key (the owner's credits).
// These are list prices as of 2026-01 — confirm against
// console.anthropic.com/settings/billing before invoicing real users.
// The owner markup is applied separately in costUsd (see CLAUDE_MARKUP).

export type ModelPricing = {
  input: number // per 1M input tokens (uncached)
  output: number // per 1M output tokens
  cacheWrite: number // per 1M cache-creation (write) tokens
  cacheRead: number // per 1M cache-read (hit) tokens
}

export const PRICING: Record<string, ModelPricing> = {
  // Claude Sonnet 4.5 — the in-app sidebar assistant
  'claude-sonnet-4-5-20250929': { input: 3, output: 15, cacheWrite: 3.75, cacheRead: 0.3 },
  // Claude Haiku 4.5 — lightweight board-meta / relevance calls
  'claude-haiku-4-5-20251001': { input: 1, output: 5, cacheWrite: 1.25, cacheRead: 0.1 },
}

export type UsageTokens = {
  input_tokens: number
  output_tokens: number
  cache_read_input_tokens?: number | null
  cache_creation_input_tokens?: number | null
}

// Multiplier applied to the raw Anthropic cost so the owner can resell platform
// credits at a margin. Default 1.0 (cost pass-through). Set CLAUDE_MARKUP=1.2 for +20%.
// Read at call time so changing the env var doesn't require a cold start.
export function markupMultiplier(): number {
  const m = Number(process.env.CLAUDE_MARKUP ?? '1')
  return Number.isFinite(m) && m > 0 ? m : 1
}

// Marked-up USD cost for one request's token usage on a given model. The Anthropic
// API reports input_tokens excluding cached reads, so the four buckets are summed
// independently. Unknown models cost 0 (the usage row is still logged for review).
export function costUsd(model: string, u: UsageTokens): number {
  const p = PRICING[model]
  if (!p) return 0
  const raw =
    (u.input_tokens / 1e6) * p.input +
    (u.output_tokens / 1e6) * p.output +
    ((u.cache_read_input_tokens ?? 0) / 1e6) * p.cacheRead +
    ((u.cache_creation_input_tokens ?? 0) / 1e6) * p.cacheWrite
  return raw * markupMultiplier()
}
