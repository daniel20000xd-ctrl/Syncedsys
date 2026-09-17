import { createAdminClient } from '@/lib/supabase/admin'
import { getDaemonUserId } from './state'
import { embeddingConfig, embedTexts, markVectorUnavailable, toPgVector } from './embeddings'

// Hybrid recall over every daemon corpus in Postgres (never R2): full-text search always,
// vector similarity when embeddings are configured, merged into one 0–1 score with a
// mild recency decay and a threshold. Tuning knobs are the constants below.

// Must match the config baked into the generated fts columns in daemon_v5.sql.
export const FTS_CONFIG = 'english'

export const WEIGHT_FTS = 0.5
export const WEIGHT_VECTOR = 0.5

// FTS: a row's score blends term coverage (distinct query terms it contains, saturating
// at COVERAGE_SATURATION terms) with ts_rank_cd squashed to 0–1 as r/(r+RANK_HALF).
export const COVERAGE_SATURATION = 5
export const FTS_COVERAGE_WEIGHT = 0.7
export const RANK_HALF = 0.1
// Vector: cosine similarity below SIMILARITY_FLOOR counts as no signal; SIMILARITY_FLOOR
// .. SIMILARITY_CEIL maps linearly to 0..1.
export const SIMILARITY_FLOOR = 0.5
export const SIMILARITY_CEIL = 0.85

// Recency: score × (DECAY_FLOOR + (1 − DECAY_FLOOR) · e^(−age_days / DECAY_TAU_DAYS)).
// A week-old hit keeps ~97%, a six-month-old one never drops below 70%.
export const DECAY_FLOOR = 0.7
export const DECAY_TAU_DAYS = 45

export const DEFAULT_MIN_SCORE = 0.3
export const DEFAULT_LIMIT = 8

// Mode A (automatic, every input call): stricter and fewer, older than the conversation.
export const PREFETCH_MIN_SCORE = 0.5
export const PREFETCH_LIMIT = 4
export const PREFETCH_MIN_AGE_HOURS = 12

export const SEARCH_KINDS = ['archive', 'active', 'day_entry', 'message', 'thread', 'reflection'] as const
export type SearchKind = (typeof SEARCH_KINDS)[number]
// Active items are already in every input call's context in full.
export const PREFETCH_KINDS: readonly SearchKind[] = ['archive', 'day_entry', 'message', 'thread', 'reflection']

// Mode B (the model asked): a few more, at the default threshold.
export const MODEL_SEARCH_LIMIT = 6
// Reflection's archive pass.
export const REFLECTION_ARCHIVE_LIMIT = 30

export type SearchHit = {
  kind: SearchKind
  id: string
  title: string
  excerpt: string
  created_at: string
  score: number
  why_matched: string
  signals: { fts: number | null; vector: number | null; decay: number; matched_terms: string[] }
}

export type SearchOptions = {
  userId?: string
  limit?: number
  minScore?: number
  kinds?: readonly SearchKind[]
  maxAgeDays?: number
  // Skip rows newer than this — the current conversation is already in context.
  minAgeHours?: number
  // Skip this thread and its own messages/day entries.
  excludeThreadId?: string | null
  excludeIds?: string[]
}

const clamp01 = (n: number) => Math.max(0, Math.min(1, n))
const round = (n: number) => Math.round(n * 1000) / 1000

export function ftsScore(rank: number, matched: number, total: number): number {
  if (!total || !matched) return 0
  // One stray shared word in a multi-word query is not a match.
  if (total >= 2 && matched < 2) return 0
  const coverage = Math.min(matched, COVERAGE_SATURATION) / Math.min(total, COVERAGE_SATURATION)
  return clamp01(FTS_COVERAGE_WEIGHT * coverage + (1 - FTS_COVERAGE_WEIGHT) * (rank / (rank + RANK_HALF)))
}

export function vectorScore(similarity: number): number {
  return clamp01((similarity - SIMILARITY_FLOOR) / (SIMILARITY_CEIL - SIMILARITY_FLOOR))
}

export function recencyDecay(createdAt: string, now = Date.now()): number {
  const ageDays = Math.max(0, (now - Date.parse(createdAt)) / 86_400_000)
  return DECAY_FLOOR + (1 - DECAY_FLOOR) * Math.exp(-ageDays / DECAY_TAU_DAYS)
}

// Weighted merge over the signals this search actually ran, so FTS-only mode still
// produces a full 0–1 range.
export function mergeScores(fts: number | null, vector: number | null, vectorActive: boolean): number {
  if (!vectorActive) return fts ?? 0
  return (WEIGHT_FTS * (fts ?? 0) + WEIGHT_VECTOR * (vector ?? 0)) / (WEIGHT_FTS + WEIGHT_VECTOR)
}

type Candidate = {
  kind: SearchKind; id: string; title: string; excerpt: string; created_at: string
  fts: number | null; vector: number | null; terms: string[]; threadId?: string | null
}

type FtsRow = { kind: SearchKind; id: string; title: string; excerpt: string; created_at: string; rank: number; matched: number; total: number; matched_terms: string[] }

async function ftsCandidates(userId: string, query: string, opts: SearchOptions, pool: number): Promise<Candidate[]> {
  const now = Date.now()
  const { data, error } = await createAdminClient().rpc('daemon_search_fts', {
    p_user_id: userId,
    p_query: query,
    p_config: FTS_CONFIG,
    p_kinds: [...(opts.kinds ?? SEARCH_KINDS)],
    p_since: opts.maxAgeDays ? new Date(now - opts.maxAgeDays * 86_400_000).toISOString() : null,
    p_before: opts.minAgeHours ? new Date(now - opts.minAgeHours * 3_600_000).toISOString() : null,
    p_exclude_thread: opts.excludeThreadId ?? null,
    p_limit: pool,
  })
  if (error) throw new Error(`fts search failed: ${error.message}`)
  return ((data ?? []) as FtsRow[]).map(r => ({
    kind: r.kind, id: r.id, title: r.title, excerpt: r.excerpt, created_at: r.created_at,
    fts: ftsScore(Number(r.rank), r.matched, r.total), vector: null, terms: r.matched_terms ?? [],
  }))
}

const EXCERPT_CHARS = 240
const excerptOf = (text: string | null | undefined) => {
  const flat = (text ?? '').replace(/\s+/g, ' ').trim()
  return flat.length <= EXCERPT_CHARS ? flat : `${flat.slice(0, EXCERPT_CHARS)}…`
}

// Title, verbatim excerpt, date and thread for vector-only hits.
async function resolveRows(ids: { kind: SearchKind; id: string }[]): Promise<Map<string, Omit<Candidate, 'fts' | 'vector' | 'terms'>>> {
  const admin = createAdminClient()
  const out = new Map<string, Omit<Candidate, 'fts' | 'vector' | 'terms'>>()
  const byKind = (k: SearchKind) => ids.filter(i => i.kind === k).map(i => i.id)
  const put = (kind: SearchKind, id: string, title: string, text: string | null, created_at: string, threadId: string | null = null) =>
    out.set(`${kind}:${id}`, { kind, id, title, excerpt: excerptOf(text), created_at, threadId })

  const tasks: PromiseLike<void>[] = []
  if (byKind('archive').length) tasks.push(admin.from('daemon_archive').select('id, title, content, outcome, archived_at').in('id', byKind('archive'))
    .then(({ data }) => { for (const r of data ?? []) put('archive', r.id, r.title, r.content || r.outcome, r.archived_at) }))
  if (byKind('active').length) tasks.push(admin.from('daemon_active').select('id, title, content, created_at').in('id', byKind('active'))
    .then(({ data }) => { for (const r of data ?? []) put('active', r.id, r.title, r.content || r.title, r.created_at) }))
  if (byKind('day_entry').length) tasks.push(admin.from('daemon_day_entries').select('id, entry_date, call_type, content, created_at, thread_id').in('id', byKind('day_entry'))
    .then(({ data }) => { for (const r of data ?? []) put('day_entry', r.id, `day log ${r.entry_date} (${r.call_type})`, r.content, r.created_at, r.thread_id) }))
  if (byKind('message').length) tasks.push(admin.from('daemon_interaction_log').select('id, direction, call_type, content, created_at, thread_id').in('id', byKind('message'))
    .then(({ data }) => { for (const r of data ?? []) if (r.call_type !== 'system') put('message', r.id, r.direction === 'in' ? 'you said' : 'daemon said', r.content, r.created_at, r.thread_id) }))
  if (byKind('thread').length) tasks.push(admin.from('daemon_threads').select('id, topic, question, opened_at').in('id', byKind('thread'))
    .then(({ data }) => { for (const r of data ?? []) put('thread', r.id, r.topic || '(thread)', r.question || r.topic, r.opened_at, r.id) }))
  if (byKind('reflection').length) tasks.push(admin.from('daemon_reflection_entries').select('id, entry_date, content, created_at').in('id', byKind('reflection'))
    .then(({ data }) => { for (const r of data ?? []) put('reflection', r.id, `reflection ${r.entry_date ?? r.created_at.slice(0, 10)}`, r.content, r.created_at) }))
  await Promise.all(tasks)
  return out
}

async function vectorCandidates(userId: string, embedding: number[], opts: SearchOptions, pool: number): Promise<Candidate[]> {
  const { data, error } = await createAdminClient().rpc('daemon_search_vector', {
    p_user_id: userId, p_embedding: toPgVector(embedding), p_kinds: [...(opts.kinds ?? SEARCH_KINDS)], p_limit: pool,
  })
  if (error) {
    if (/does not exist|could not find|PGRST202/i.test(`${error.code} ${error.message}`)) markVectorUnavailable('daemon_v5_vector.sql not applied')
    else console.error('[daemon/search] vector search failed:', error.message)
    return []
  }
  const rows = (data ?? []) as { source_kind: SearchKind; source_id: string; similarity: number }[]
  const resolved = await resolveRows(rows.map(r => ({ kind: r.source_kind, id: r.source_id })))
  const now = Date.now()
  return rows.flatMap(r => {
    const base = resolved.get(`${r.source_kind}:${r.source_id}`)
    if (!base) return []
    const age = now - Date.parse(base.created_at)
    if (opts.maxAgeDays && age > opts.maxAgeDays * 86_400_000) return []
    if (opts.minAgeHours && age < opts.minAgeHours * 3_600_000) return []
    if (opts.excludeThreadId && base.threadId === opts.excludeThreadId) return []
    return [{ ...base, fts: null, vector: vectorScore(Number(r.similarity)), terms: [] }]
  })
}

// FTS hits outside the vector top-k still get their real similarity.
async function fillSimilarity(candidates: Candidate[][], embedding: number[]): Promise<void> {
  const missing = candidates.flat().filter(c => c.vector === null)
  if (!missing.length) return
  const { data, error } = await createAdminClient().rpc('daemon_vector_similarity', {
    p_embedding: toPgVector(embedding), p_ids: [...new Set(missing.map(c => c.id))],
  })
  if (error) {
    console.error('[daemon/search] similarity lookup failed:', error.message)
    return
  }
  const sims = new Map(((data ?? []) as { source_kind: string; source_id: string; similarity: number }[])
    .map(r => [`${r.source_kind}:${r.source_id}`, vectorScore(Number(r.similarity))]))
  for (const c of missing) {
    const v = sims.get(`${c.kind}:${c.id}`)
    if (v !== undefined) c.vector = v
  }
}

function rank(cands: Candidate[][], opts: SearchOptions, vectorActive: boolean): SearchHit[] {
  const merged = new Map<string, Candidate>()
  for (const list of cands) {
    for (const c of list) {
      const key = `${c.kind}:${c.id}`
      const prev = merged.get(key)
      if (!prev) {
        merged.set(key, { ...c })
        continue
      }
      // Prefer the FTS excerpt: it is centred on the matched words.
      if (c.terms.length && !prev.terms.length) prev.excerpt = c.excerpt
      if (c.fts !== null) prev.fts = Math.max(prev.fts ?? 0, c.fts)
      if (c.vector !== null) prev.vector = Math.max(prev.vector ?? 0, c.vector)
      prev.terms = [...new Set([...prev.terms, ...c.terms])]
    }
  }
  const exclude = new Set(opts.excludeIds ?? [])
  const minScore = opts.minScore ?? DEFAULT_MIN_SCORE
  return [...merged.values()]
    .filter(c => !exclude.has(c.id))
    .map(c => {
      const decay = recencyDecay(c.created_at)
      const score = round(mergeScores(c.fts, c.vector, vectorActive) * decay)
      const parts = [
        c.fts ? `fts ${round(c.fts)}${c.terms.length ? ` (${c.terms.join(', ')})` : ''}` : null,
        c.vector ? `vector ${round(c.vector)}` : null,
      ].filter(Boolean)
      return {
        kind: c.kind, id: c.id, title: c.title, excerpt: c.excerpt, created_at: c.created_at, score,
        why_matched: `${c.fts && c.vector ? 'both' : c.vector ? 'vector' : 'fts'}: ${parts.join(' + ')}`,
        signals: { fts: c.fts === null ? null : round(c.fts), vector: c.vector === null ? null : round(c.vector), decay: round(decay), matched_terms: c.terms },
      }
    })
    .filter(h => h.score >= minScore)
    .sort((a, b) => b.score - a.score)
    .slice(0, opts.limit ?? DEFAULT_LIMIT)
}

// Several queries at once (one batched embedding request); a row matched by more than one
// query keeps its best signals.
export async function searchMemoryMany(queries: string[], opts: SearchOptions = {}): Promise<{ hits: SearchHit[]; signals: 'fts' | 'fts+vector' }> {
  const qs = [...new Set(queries.map(q => q.trim()).filter(Boolean))]
  if (!qs.length) return { hits: [], signals: 'fts' }
  const userId = opts.userId ?? await getDaemonUserId()
  const pool = Math.max((opts.limit ?? DEFAULT_LIMIT) * 5, 20)

  const embedCfg = await embeddingConfig(userId)
  let embeddings: number[][] | null = null
  if (embedCfg) {
    try {
      embeddings = await embedTexts(qs, 'query', userId)
    } catch (e) {
      console.error('[daemon/search] query embedding failed, FTS only:', (e as Error).message)
    }
  }

  const lists = await Promise.all(qs.map(async (q, i) => {
    const [fts, vec] = await Promise.all([
      ftsCandidates(userId, q, opts, pool),
      embeddings ? vectorCandidates(userId, embeddings[i], opts, pool) : Promise.resolve([]),
    ])
    if (embeddings) await fillSimilarity([fts], embeddings[i])
    return [...fts, ...vec]
  }))
  const vectorActive = !!embeddings
  return { hits: rank(lists, opts, vectorActive), signals: vectorActive ? 'fts+vector' : 'fts' }
}

export async function searchMemory(query: string, opts: SearchOptions = {}): Promise<SearchHit[]> {
  return (await searchMemoryMany([query], opts)).hits
}

// Logged for the console's recall-quality metrics. Never throws.
export async function recordRecall(userId: string, e: {
  mode: 'prefetch' | 'search' | 'reflection'; threadId?: string | null; query: string; signals: string; hits: SearchHit[]
}): Promise<void> {
  const { error } = await createAdminClient().from('daemon_recall_events').insert({
    user_id: userId, mode: e.mode, thread_id: e.threadId ?? null, query: e.query.slice(0, 4000), signals: e.signals,
    hits: e.hits.map(h => ({ kind: h.kind, id: h.id, score: h.score, why_matched: h.why_matched })),
  })
  if (error) console.error('[daemon/search] recall event insert failed:', error.message)
}

// The stub format every model call sees: kind, date, title, verbatim excerpt, id.
export function renderHits(hits: SearchHit[]): string {
  return hits.map(h =>
    `- [${h.kind}] ${h.created_at.slice(0, 10)} — ${h.title} (id ${h.id}, score ${h.score})\n  "${h.excerpt.replace(/\s+/g, ' ').trim()}"`,
  ).join('\n')
}
