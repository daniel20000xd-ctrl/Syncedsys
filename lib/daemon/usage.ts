import { createAdminClient } from '@/lib/supabase/admin'
import { daemonEnv } from './env'
import { startOfLocalDay } from './time'

// Prices are read from daemon_model_prices (maintained by hand in the console — see
// app/daemonActions.ts, the only writer). A model with no row there prices as unknown,
// never a guessed rate and never a silent zero: a silent zero would quietly disable the
// daily cost cap.

type PriceRow = { input: number; output: number; cachedInput: number | null }

// Invalidated immediately by invalidatePriceCache() (called from the console save
// action) in whichever server instance handled the save, plus a short TTL as a backstop
// for other instances — same caveat as the model-routing cache in models.ts.
let priceCache: Map<string, PriceRow> | null = null
let priceCacheAt = 0
const PRICE_CACHE_TTL_MS = 30_000

export function invalidatePriceCache(): void {
  priceCache = null
}

async function loadPrices(): Promise<Map<string, PriceRow>> {
  const { data, error } = await createAdminClient()
    .from('daemon_model_prices')
    .select('model, input_per_mtok, output_per_mtok, cached_input_per_mtok')
  if (error) throw new Error(`price table read failed: ${error.message}`)
  const map = new Map<string, PriceRow>()
  for (const r of data ?? []) {
    map.set(r.model, {
      input: Number(r.input_per_mtok),
      output: Number(r.output_per_mtok),
      cachedInput: r.cached_input_per_mtok === null ? null : Number(r.cached_input_per_mtok),
    })
  }
  return map
}

async function priceFor(model: string): Promise<PriceRow | null> {
  if (!priceCache || Date.now() - priceCacheAt > PRICE_CACHE_TTL_MS) {
    priceCache = await loadPrices()
    priceCacheAt = Date.now()
  }
  return priceCache.get(model) ?? null
}

// 'n/a' is the model warning/backstop rows use (recordWarning below) — those are never
// real spend, and are priced at 0 without a lookup. Any other unpriced model returns
// null: "unknown", not "free".
export async function costUsd(model: string, inputTokens: number, outputTokens: number): Promise<number | null> {
  if (model === 'n/a') return 0
  const p = await priceFor(model)
  if (!p) return null
  return (inputTokens * p.input + outputTokens * p.output) / 1_000_000
}

export type UsageRow = {
  userId: string | null
  callType: string
  model: string
  inputTokens: number
  outputTokens: number
  error?: string | null
  attempt: number
  systemPromptVersion?: number | null
  callPromptVersion?: number | null
  dryRun?: boolean
}

export async function recordUsage(row: UsageRow): Promise<string | null> {
  const cost = await costUsd(row.model, row.inputTokens, row.outputTokens)
  const priceMissing = cost === null
  if (priceMissing) console.error(`[daemon] no price row for model '${row.model}'; cost_usd recorded as null`)
  const error = row.error
    ? (priceMissing ? `${row.error}; no price row for model '${row.model}'` : row.error)
    : (priceMissing ? `no price row for model '${row.model}'` : null)

  const { data, error: dbError } = await createAdminClient()
    .from('daemon_usage')
    .insert({
      user_id: row.userId,
      call_type: row.callType,
      model: row.model,
      input_tokens: row.inputTokens,
      output_tokens: row.outputTokens,
      cost_usd: cost,
      error,
      attempt: row.attempt,
      system_prompt_version: row.systemPromptVersion ?? null,
      call_prompt_version: row.callPromptVersion ?? null,
      dry_run: row.dryRun ?? false,
    })
    .select('id')
    .single()
  if (dbError) {
    console.error('[daemon] usage insert failed:', dbError.message)
    return null
  }
  return data.id as string
}

// A zero-cost ledger row whose `error` carries a warning (model 'n/a'), so drift and
// dropped model output are visible next to real call failures.
export async function recordWarning(userId: string, callType: string, message: string): Promise<void> {
  const { error } = await createAdminClient().from('daemon_usage').insert({
    user_id: userId, call_type: callType, model: 'n/a', cost_usd: 0, error: message,
  })
  if (error) console.error('[daemon] warning insert failed:', error.message, message)
}

export async function annotateUsage(id: string | null, note: string): Promise<void> {
  if (!id) return
  await createAdminClient().from('daemon_usage').update({ note }).eq('id', id)
}

// unknownCount: real (non-warning) calls today whose cost couldn't be priced. Their
// dollar cost is not zero, it's unknown — kept separate from totalUsd rather than folded
// into it as 0, so isOverBudget() below can treat "unknown" as its own case.
export async function todaysSpendUsd(): Promise<{ totalUsd: number; unknownCount: number }> {
  const { data, error } = await createAdminClient()
    .from('daemon_usage')
    .select('cost_usd, model')
    .gte('created_at', startOfLocalDay().toISOString())
  if (error) throw new Error(`usage read failed: ${error.message}`)
  let totalUsd = 0
  let unknownCount = 0
  for (const r of data ?? []) {
    if (r.cost_usd === null) unknownCount++
    else totalUsd += Number(r.cost_usd)
  }
  return { totalUsd, unknownCount }
}

// Fails closed: no cap configured, the ledger can't be read, or today has any call with
// unknown cost, all count as over budget — an unpriced call is unknown spend, not zero
// spend, and under-counting a safety bound is worse than pausing early. The console
// overview surfaces unknown-cost rows prominently so this doesn't look like a silent hang.
export async function isOverBudget(): Promise<boolean> {
  const cap = daemonEnv.dailyCostCapUsd()
  if (cap === null) return true
  try {
    const { totalUsd, unknownCount } = await todaysSpendUsd()
    if (unknownCount > 0) return true
    return totalUsd >= cap
  } catch (e) {
    console.error('[daemon]', e)
    return true
  }
}
