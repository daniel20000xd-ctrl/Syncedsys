import { createAdminClient } from '@/lib/supabase/admin'
import { daemonEnv } from './env'
import { recordWarning } from './usage'
import { sendFailureAlert } from './alert'
import type { CallType } from './gemini'

// Per-call-type model routing, read from daemon_model_config. Writes happen only in
// app/daemonActions.ts, after an admin check; nothing here writes the table — the
// daemon's own runtime has no path to picking its own model.

export type ModelKind = CallType | 'embedding'
export type ModelConfig = { model: string; maxOutputTokens: number | null }
export type ResolvedModel = ModelConfig & { source: 'db' | 'env' | 'none' }

export class ModelMissingError extends Error {}

type Row = { call_type: ModelKind; model: string; max_output_tokens: number | null }

// Cache invalidated immediately by invalidateModelCache() (called from the console save
// action) in whichever server instance handled the save, plus a short TTL as a backstop
// for other instances — see the v6 report for the cross-instance caveat.
let cache: Map<ModelKind, ModelConfig> | null = null
let cacheAt = 0
const CACHE_TTL_MS = 30_000

export function invalidateModelCache(): void {
  cache = null
}

// 'relation does not exist' (daemon_v6.sql not applied yet) is treated as "no rows" —
// every call type falls back to env with a warning — rather than crashing the call.
const isMissingTable = (err: { code?: string; message?: string }) =>
  /does not exist|could not find|PGRST205/i.test(`${err.code} ${err.message}`)

async function loadAll(): Promise<Map<ModelKind, ModelConfig>> {
  const { data, error } = await createAdminClient().from('daemon_model_config').select('call_type, model, max_output_tokens')
  if (error) {
    if (isMissingTable(error)) return new Map()
    throw new Error(`model config read failed: ${error.message}`)
  }
  const map = new Map<ModelKind, ModelConfig>()
  for (const r of (data ?? []) as Row[]) map.set(r.call_type, { model: r.model, maxOutputTokens: r.max_output_tokens })
  return map
}

async function configRow(kind: ModelKind): Promise<ModelConfig | null> {
  if (!cache || Date.now() - cacheAt > CACHE_TTL_MS) {
    cache = await loadAll()
    cacheAt = Date.now()
  }
  return cache.get(kind) ?? null
}

const envModelFor = (kind: ModelKind): string | undefined =>
  (kind === 'embedding' ? process.env.DAEMON_EMBEDDING_MODEL : daemonEnv.model())?.trim() || undefined

async function resolve(kind: ModelKind): Promise<ResolvedModel> {
  const row = await configRow(kind)
  if (row?.model.trim()) return { ...row, source: 'db' }
  const env = envModelFor(kind)
  if (env) return { model: env, maxOutputTokens: null, source: 'env' }
  return { model: '', maxOutputTokens: null, source: 'none' }
}

// Read-only status check for the console: which model would be used and where it came
// from. Never writes a warning — safe to call on every page render.
export async function peekModelFor(kind: ModelKind): Promise<ResolvedModel> {
  return resolve(kind)
}

// Used by real call paths. DB row → env fallback (logs a warning, since routing has
// drifted from what the console shows) → abort with the failure alert. Never guesses.
export async function getModelFor(kind: ModelKind, userId: string): Promise<ModelConfig> {
  const resolved = await resolve(kind)
  if (resolved.source === 'db') return resolved
  if (resolved.source === 'env') {
    await recordWarning(userId, kind, `no daemon_model_config row for '${kind}'; used env fallback '${resolved.model}'`)
    return resolved
  }
  const message = `no model configured for '${kind}' (no daemon_model_config row and no env fallback)`
  await sendFailureAlert('daemon model missing', message)
  throw new ModelMissingError(message)
}
