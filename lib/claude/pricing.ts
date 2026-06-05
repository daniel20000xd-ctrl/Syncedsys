// Anthropic list prices (USD per 1,000,000 tokens) used to compute the RAW cost of
// a Claude request when it runs on the PLATFORM key (the owner's credits).
// These are list prices as of 2026-01 — confirm against
// console.anthropic.com/settings/billing before invoicing real users.
// Markup is applied separately, and only to usage ABOVE the free allowance.

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

// RAW Anthropic cost (no markup) for one request's token usage on a given model.
// input_tokens excludes cached reads, so the four buckets are summed independently.
// Unknown models cost 0 (the row is still logged for review).
export function rawCostUsd(model: string, u: UsageTokens): number {
  const p = PRICING[model]
  if (!p) return 0
  return (
    (u.input_tokens / 1e6) * p.input +
    (u.output_tokens / 1e6) * p.output +
    ((u.cache_read_input_tokens ?? 0) / 1e6) * p.cacheRead +
    ((u.cache_creation_input_tokens ?? 0) / 1e6) * p.cacheWrite
  )
}

// Multiplier applied to billable overage so the owner resells platform credits at a
// margin. Default 1.0 (cost pass-through). Set CLAUDE_MARKUP=1.2 for +20%.
export function markupMultiplier(): number {
  const m = Number(process.env.CLAUDE_MARKUP ?? '1')
  return Number.isFinite(m) && m > 0 ? m : 1
}

// Free platform-credit allowance per user per billing period (raw USD, no markup).
// Default $0.50; override with CLAUDE_FREE_ALLOWANCE_USD.
export function freeAllowanceUsd(): number {
  const v = Number(process.env.CLAUDE_FREE_ALLOWANCE_USD ?? '0.5')
  return Number.isFinite(v) && v >= 0 ? v : 0.5
}

// What a user owes for a period given their raw platform spend that period.
// The first freeAllowanceUsd() of raw cost is free; only the overage is billed, and
// only if they opted into pay-per-use. Non-opted-in users are capped at the free
// tier (gated before they can exceed it), so they always owe 0.
export function billableUsd(spentRawThisPeriod: number, payPerUse: boolean): number {
  if (!payPerUse) return 0
  const overage = Math.max(0, spentRawThisPeriod - freeAllowanceUsd())
  return overage * markupMultiplier()
}

// Start of the current billing period (calendar month, UTC) as an ISO string.
// The free allowance resets at this boundary.
export function currentPeriodStartIso(): string {
  const now = new Date()
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString()
}
