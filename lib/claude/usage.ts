import { rawCostUsd, type UsageTokens } from '@/lib/claude/pricing'
import type { KeySource } from '@/lib/claude/key'
import { createAdminClient } from '@/lib/supabase/admin'

type RecordArgs = {
  userId: string
  model: string
  keySource: KeySource
  usage: UsageTokens
  turns?: number
  boardId?: string | null
  errored?: boolean
}

// Append one row to the claude_usage ledger. The ledger is the billing source of
// truth, so it is written ONLY through the service-role client (RLS makes it
// read-only for end users — a billed user must not be able to fabricate, edit, or
// delete their own usage rows). user_id is the server-derived owner, never client
// input. Best-effort: every failure is swallowed so metering can never break a
// chat response or a tool call (same contract as logAction / snapshotBefore).
export async function recordClaudeUsage(args: RecordArgs): Promise<void> {
  const { userId, model, keySource, usage, turns = 1, boardId = null, errored = false } = args
  const input = usage.input_tokens ?? 0
  const output = usage.output_tokens ?? 0
  const cacheRead = usage.cache_read_input_tokens ?? 0
  const cacheWrite = usage.cache_creation_input_tokens ?? 0

  // Nothing to record (e.g. the request died before the first turn returned usage).
  if (input === 0 && output === 0 && cacheRead === 0 && cacheWrite === 0) return

  const billable = keySource === 'platform'
  // Store RAW Anthropic cost (no markup) rounded to the ledger column's scale
  // (numeric(12,6)). Markup is applied only to billable overage at invoice time.
  const cost = billable ? Number(rawCostUsd(model, usage).toFixed(6)) : 0

  try {
    const admin = createAdminClient()
    await admin.from('claude_usage').insert({
      user_id: userId,
      model,
      key_source: keySource,
      billable,
      input_tokens: input,
      output_tokens: output,
      cache_read_tokens: cacheRead,
      cache_creation_tokens: cacheWrite,
      cost_usd: cost,
      turns,
      board_id: boardId,
      errored,
    })
  } catch {
    // Metering failures are non-fatal.
  }
}
