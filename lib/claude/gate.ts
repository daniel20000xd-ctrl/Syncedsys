import type { SupabaseClient } from '@supabase/supabase-js'
import type { KeySource } from '@/lib/claude/key'
import { currentPeriodStartIso } from '@/lib/claude/pricing'
import { getAccountLimits } from '@/lib/limits'

export type GateResult =
  | { ok: true }
  | { ok: false; error: 'claude_disabled' | 'free_tier_exhausted'; spentUsd?: number; freeUsd?: number | null }

// Decide whether a platform-key Claude request may proceed. Own-key requests are
// never gated (no kill switch, no cap — the user pays Anthropic directly). For
// platform-key requests:
//   1. the global kill switch (env hard-override OR the app_config toggle) blocks all;
//   2. otherwise, unless the user opted into pay-per-use, they're capped at the free
//      allowance for the current billing period.
// Reads through the caller's (user-scoped) client; everything it touches is the
// user's own data or the world-readable app_config flag.
export async function claudeGate(
  supabase: SupabaseClient,
  userId: string,
  keySource: KeySource,
  user?: { email?: string | null } | null,
): Promise<GateResult> {
  if (keySource !== 'platform') return { ok: true }

  // Kill switch — env override first (instant, deploy-level), then the DB toggle.
  if (process.env.CLAUDE_API_ENABLED === 'false') return { ok: false, error: 'claude_disabled' }
  const { data: cfg } = await supabase
    .from('app_config').select('enabled').eq('key', 'claude_api').maybeSingle()
  if (cfg && cfg.enabled === false) return { ok: false, error: 'claude_disabled' }

  // Opted-in users have no cap.
  const { data: secret } = await supabase
    .from('user_secrets').select('claude_pay_per_use').eq('user_id', userId).maybeSingle()
  if (secret?.claude_pay_per_use) return { ok: true }

  // Free tier: sum this period's raw platform spend against the allowance.
  // NOTE: this is a soft cap, checked before each request (a request's own cost
  // isn't known until it finishes). A user already under the allowance is allowed to
  // complete the current request, so spend can overshoot by ~one request's cost
  // (bounded for the sidebar by MAX_TURNS×max_tokens; the haiku paths are tiny), and
  // concurrent in-flight requests can each pass before any records spend (bounded by
  // the rate limit + the monthly reset + the kill switch). This only affects how much
  // of the OWNER's credit a user can consume — non-opted-in users are still never
  // charged (billableUsd returns 0 for them). Tighten with a reserve-then-reconcile
  // row or a per-user advisory lock if strict enforcement is ever needed.
  const { apiCreditUsd } = getAccountLimits(user)

  // Admin has null (unlimited) — skip the cap check entirely, but still query
  // spend so the gate returns it for any error path that needs it.
  const { data: rows } = await supabase
    .from('claude_usage')
    .select('cost_usd')
    .eq('user_id', userId)
    .eq('billable', true)
    .gte('created_at', currentPeriodStartIso())
  const spent = ((rows ?? []) as { cost_usd: number | string | null }[])
    .reduce((s, r) => s + Number(r.cost_usd ?? 0), 0)

  if (apiCreditUsd !== null && spent >= apiCreditUsd) {
    return { ok: false, error: 'free_tier_exhausted', spentUsd: spent, freeUsd: apiCreditUsd }
  }
  return { ok: true }
}
