// One-off: copy reflection entries that exist only in R2 (written before v5) into
// daemon_reflection_entries so they are searchable. R2 is read, never modified.
//
//   npx tsx --env-file=.env.local scripts/daemon-backfill-reflections.ts [--dry-run]
//
// Requires supabase/daemon_v5.sql. Idempotent: each block gets a backfill_key, and blocks
// dated on/after the first entry mirrored at runtime are skipped (those already exist).

import { createHash } from 'crypto'
import { createAdminClient } from '@/lib/supabase/admin'
import { getDaemonUserId } from '@/lib/daemon/state'
import { listFamilyFiles, readFamilyFile } from '@/lib/daemon/files'

async function main() {
  const dryRun = process.argv.includes('--dry-run')
  const userId = await getDaemonUserId()
  const admin = createAdminClient()

  const { data: firstRuntime, error: firstErr } = await admin.from('daemon_reflection_entries')
    .select('entry_date').eq('user_id', userId).is('backfill_key', null)
    .order('entry_date', { ascending: true }).limit(1).maybeSingle()
  if (firstErr) throw new Error(`read failed (is daemon_v5.sql applied?): ${firstErr.message}`)
  const cutoff: string | null = firstRuntime?.entry_date ?? null

  const files = await listFamilyFiles(userId, 'reflections')
  let seen = 0
  let skipped = 0
  const rows: { user_id: string; entry_date: string; source: 'backfill'; content: string; backfill_key: string; created_at: string }[] = []
  for (const f of files) {
    const parsed = await readFamilyFile(f.key)
    for (const b of parsed?.blocks ?? []) {
      seen++
      if (cutoff && b.date >= cutoff) {
        skipped++
        continue
      }
      rows.push({
        user_id: userId,
        entry_date: b.date,
        source: 'backfill',
        content: b.body,
        backfill_key: `${f.relative}:${b.date}:${createHash('sha1').update(b.body).digest('hex')}`,
        created_at: `${b.date}T04:00:00Z`,
      })
    }
  }

  console.log(`files: ${files.length}, blocks: ${seen}, skipped (already mirrored, on/after ${cutoff}): ${skipped}, to insert: ${rows.length}`)
  if (dryRun || !rows.length) return

  let inserted = 0
  for (let i = 0; i < rows.length; i += 200) {
    const { data, error } = await admin.from('daemon_reflection_entries')
      .upsert(rows.slice(i, i + 200), { onConflict: 'backfill_key', ignoreDuplicates: true })
      .select('id')
    if (error) throw new Error(`insert failed: ${error.message}`)
    inserted += data?.length ?? 0
  }
  console.log(`inserted: ${inserted} (the rest already existed)`)
}

main().catch(e => {
  console.error(e)
  process.exit(1)
})
