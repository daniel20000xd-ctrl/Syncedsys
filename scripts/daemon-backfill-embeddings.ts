// One-off: embed every existing daemon row that has no embedding yet (or whose text
// changed), in batches. Dev-run, not a route.
//
//   npx tsx --env-file=.env.local scripts/daemon-backfill-embeddings.ts [--max 5000] [--dry-run]
//
// Requires supabase/daemon_v5.sql + daemon_v5_vector.sql, and DAEMON_EMBEDDING_MODEL /
// DAEMON_EMBEDDING_DIM / GEMINI_API_KEY in the env. Spend is recorded in daemon_usage
// (call_type 'embedding') and stops at the daily cost cap like everything else.

import { createAdminClient } from '@/lib/supabase/admin'
import { embedPending, vectorStatus } from '@/lib/daemon/embeddings'

const BATCH = 100

async function countPending(): Promise<Record<string, number>> {
  const { data, error } = await createAdminClient().rpc('daemon_unembedded', { p_limit: 1_000_000 })
  if (error) throw new Error(`daemon_unembedded failed (is daemon_v5_vector.sql applied?): ${error.message}`)
  const counts: Record<string, number> = {}
  for (const r of (data ?? []) as { source_kind: string }[]) counts[r.source_kind] = (counts[r.source_kind] ?? 0) + 1
  return counts
}

async function main() {
  const maxArg = process.argv.indexOf('--max')
  const max = maxArg > -1 ? Number(process.argv[maxArg + 1]) : Infinity
  const status = await vectorStatus()
  if (!status.configured) {
    console.error('Vector search is not configured:', status)
    process.exit(1)
  }
  console.log('embedding model:', status.model)

  const before = await countPending()
  const total = Object.values(before).reduce((s, n) => s + n, 0)
  console.log('rows needing embeddings:', before, `total ${total}`)
  if (process.argv.includes('--dry-run') || !total) return

  let done = 0
  while (done < Math.min(total, max)) {
    const n = await embedPending(BATCH)
    if (!n) break
    done += n
    console.log(`embedded ${done}/${Math.min(total, max)}`)
  }

  const after = await countPending()
  console.log(`done: embedded ${done} rows; still pending:`, after)
  if (done < total && Object.values(after).some(Boolean)) {
    console.log('Stopped early (cost cap, API error or --max). Re-run to continue; it picks up where it left off.')
  }
}

main().catch(e => {
  console.error(e)
  process.exit(1)
})
