import { createAdminClient } from '@/lib/supabase/admin'
import { daemonEnv } from './env'
import { startOfLocalDay } from './time'

// USD per 1M tokens (standard paid tier, prompts ≤200k), from ai.google.dev pricing
// as of 2026-09. Thinking tokens bill as output. The 3.6–3.8 Flash promo rates end
// 2026-12-31 (doubling to 1.50/7.50) — update this table then.
const PRICING: { prefix: string; input: number; output: number }[] = [
  { prefix: 'gemini-3.8-flash', input: 0.75, output: 3.75 },
  { prefix: 'gemini-3.7-flash', input: 0.75, output: 3.75 },
  { prefix: 'gemini-3.6-flash', input: 0.75, output: 3.75 },
  { prefix: 'gemini-3.5-flash-lite', input: 0.30, output: 2.50 },
  { prefix: 'gemini-3.5-flash', input: 1.50, output: 9.00 },
  { prefix: 'gemini-3.1-flash-lite', input: 0.25, output: 1.50 },
  { prefix: 'gemini-3.1-pro', input: 2.00, output: 12.00 },
  { prefix: 'gemini-2.5-flash-lite', input: 0.10, output: 0.40 },
  { prefix: 'gemini-2.5-flash', input: 0.30, output: 2.50 },
  { prefix: 'gemini-2.5-pro', input: 1.25, output: 10.00 },
]
// Unknown model → price it like Pro so the cost cap errs toward stopping early.
const FALLBACK = { input: 2.00, output: 12.00 }

export function costUsd(model: string, inputTokens: number, outputTokens: number): number {
  const m = model.replace(/^models\//, '')
  const p = PRICING.find(x => m.startsWith(x.prefix)) ?? FALLBACK
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
}

export async function recordUsage(row: UsageRow): Promise<string | null> {
  const { data, error } = await createAdminClient()
    .from('daemon_usage')
    .insert({
      user_id: row.userId,
      call_type: row.callType,
      model: row.model,
      input_tokens: row.inputTokens,
      output_tokens: row.outputTokens,
      cost_usd: costUsd(row.model, row.inputTokens, row.outputTokens),
      error: row.error ?? null,
      attempt: row.attempt,
    })
    .select('id')
    .single()
  if (error) {
    console.error('[daemon] usage insert failed:', error.message)
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

export async function todaysSpendUsd(): Promise<number> {
  const { data, error } = await createAdminClient()
    .from('daemon_usage')
    .select('cost_usd')
    .gte('created_at', startOfLocalDay().toISOString())
  if (error) throw new Error(`usage read failed: ${error.message}`)
  return (data ?? []).reduce((sum, r) => sum + Number(r.cost_usd ?? 0), 0)
}

// Fails closed: no cap configured, or the ledger can't be read, counts as over budget.
export async function isOverBudget(): Promise<boolean> {
  const cap = daemonEnv.dailyCostCapUsd()
  if (cap === null) return true
  try {
    return (await todaysSpendUsd()) >= cap
  } catch (e) {
    console.error('[daemon]', e)
    return true
  }
}
