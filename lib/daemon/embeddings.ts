import { createAdminClient } from '@/lib/supabase/admin'
import { isOverBudget, recordUsage } from './usage'

// Gemini embeddings for the vector half of search. Dormant unless DAEMON_EMBEDDING_MODEL
// is set AND supabase/daemon_v5_vector.sql has been applied; everything that calls this
// degrades to FTS-only otherwise.

const ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/models'
// Must match vector(768) in daemon_v5_vector.sql.
export const SQL_EMBEDDING_DIM = 768
const BATCH = 100
const MAX_CHARS = 12_000
const TIMEOUT_MS = 20_000

let unavailableReason: string | null = null

export function embeddingConfig(): { model: string; dim: number } | null {
  const model = process.env.DAEMON_EMBEDDING_MODEL?.trim()
  if (!model || unavailableReason) return null
  const dim = Number.parseInt(process.env.DAEMON_EMBEDDING_DIM ?? String(SQL_EMBEDDING_DIM), 10)
  if (dim !== SQL_EMBEDDING_DIM) {
    markVectorUnavailable(`DAEMON_EMBEDDING_DIM=${dim} does not match vector(${SQL_EMBEDDING_DIM}) in the database`)
    return null
  }
  return { model, dim }
}

// Once per process: a missing table/function or bad config switches the vector path off
// instead of failing every call.
export function markVectorUnavailable(reason: string): void {
  if (!unavailableReason) console.warn(`[daemon/embeddings] vector search disabled: ${reason}`)
  unavailableReason = reason
}

export const vectorStatus = () => ({ configured: !!process.env.DAEMON_EMBEDDING_MODEL?.trim(), disabledReason: unavailableReason })

// gemini-embedding-2 takes retrieval instructions as text prefixes; stored documents are
// already formatted as "title: … | text: …" by the daemon_embedding_sources view.
const asQuery = (text: string) => `task: search result | query: ${text}`

export async function embedTexts(texts: string[], role: 'query' | 'document', userId: string | null): Promise<number[][]> {
  const cfg = embeddingConfig()
  const apiKey = process.env.GEMINI_API_KEY
  if (!cfg || !apiKey) throw new Error('embeddings not configured')
  if (await isOverBudget()) throw new Error('daily cost cap reached')

  const out: number[][] = []
  for (let i = 0; i < texts.length; i += BATCH) {
    const chunk = texts.slice(i, i + BATCH).map(t => (role === 'query' ? asQuery(t) : t).slice(0, MAX_CHARS))
    const res = await fetch(`${ENDPOINT}/${encodeURIComponent(cfg.model)}:batchEmbedContents`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-goog-api-key': apiKey },
      signal: AbortSignal.timeout(TIMEOUT_MS),
      body: JSON.stringify({
        requests: chunk.map(text => ({
          model: `models/${cfg.model}`,
          content: { parts: [{ text }] },
          outputDimensionality: cfg.dim,
        })),
      }),
    })
    const body = (await res.json().catch(() => ({}))) as { embeddings?: { values?: number[] }[]; error?: { message?: string } }
    // The embeddings API returns no token counts; estimate ~4 chars per token for the ledger.
    const estTokens = Math.ceil(chunk.reduce((s, t) => s + t.length, 0) / 4)
    if (!res.ok || !body.embeddings || body.embeddings.length !== chunk.length) {
      const error = `embedding HTTP ${res.status}: ${body.error?.message ?? 'bad response'}`
      await recordUsage({ userId, callType: 'embedding', model: cfg.model, inputTokens: estTokens, outputTokens: 0, attempt: 1, error })
      throw new Error(error)
    }
    await recordUsage({ userId, callType: 'embedding', model: cfg.model, inputTokens: estTokens, outputTokens: 0, attempt: 1 })
    for (const e of body.embeddings) {
      if (!e.values || e.values.length !== cfg.dim) throw new Error(`embedding has ${e.values?.length ?? 0} dims, expected ${cfg.dim}`)
      out.push(e.values)
    }
  }
  return out
}

export const toPgVector = (v: number[]) => `[${v.join(',')}]`

// Embeds rows that have no embedding yet (or whose text changed). Called at the end of
// every write path and swept by the scheduler, so writes stay a single batched request
// rather than one embedding call per row. Never throws.
export async function embedPending(limit = 64): Promise<number> {
  if (!embeddingConfig()) return 0
  const admin = createAdminClient()
  try {
    const { data, error } = await admin.rpc('daemon_unembedded', { p_limit: limit })
    if (error) {
      if (/does not exist|could not find|PGRST202/i.test(`${error.code} ${error.message}`)) markVectorUnavailable('daemon_v5_vector.sql not applied')
      else console.error('[daemon/embeddings] pending read failed:', error.message)
      return 0
    }
    const rows = (data ?? []) as { source_kind: string; source_id: string; user_id: string | null; body: string; content_hash: string }[]
    if (!rows.length) return 0
    const vectors = await embedTexts(rows.map(r => r.body), 'document', rows[0].user_id)
    let stored = 0
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i]
      const { error: storeErr } = await admin.rpc('daemon_store_embedding', {
        p_user_id: r.user_id, p_kind: r.source_kind, p_id: r.source_id, p_model: embeddingConfig()?.model ?? 'unknown',
        p_hash: r.content_hash, p_embedding: toPgVector(vectors[i]),
      })
      if (storeErr) console.error('[daemon/embeddings] store failed:', storeErr.message)
      else stored++
    }
    return stored
  } catch (e) {
    console.error('[daemon/embeddings] embedPending failed:', (e as Error).message)
    return 0
  }
}
