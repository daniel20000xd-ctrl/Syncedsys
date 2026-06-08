import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { getR2Client, R2_BUCKET } from '@/lib/r2'
import { DeleteObjectCommand } from '@aws-sdk/client-s3'

export async function GET(req: NextRequest) {
  const auth = req.headers.get('authorization')
  if (auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }

  const admin = createAdminClient()
  const now = new Date().toISOString()

  // Find expired, unsaved candidates
  const { data: expired, error } = await admin
    .from('workspace_photos')
    .select('id, r2_key, user_id')
    .lt('expires_at', now)
    .eq('is_saved', false)

  if (error) {
    console.error('[cron/cleanup-photos] query error:', error.message)
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  const rows = expired ?? []
  if (rows.length === 0) {
    console.log('[cron/cleanup-photos]', new Date().toISOString(), { deleted: 0, candidates: 0 })
    return NextResponse.json({ deleted: 0 })
  }

  // Collect distinct user_ids and check which have pause_deletion enabled
  const userIds = [...new Set(rows.map(r => r.user_id))]
  const { data: pausedRows } = await admin
    .from('photo_library_settings')
    .select('user_id')
    .in('user_id', userIds)
    .eq('pause_deletion', true)

  const pausedUsers = new Set((pausedRows ?? []).map(r => r.user_id))

  const eligible = rows.filter(r => !pausedUsers.has(r.user_id))
  const r2 = getR2Client()

  let deleted = 0
  for (const row of eligible) {
    await r2.send(new DeleteObjectCommand({ Bucket: R2_BUCKET, Key: row.r2_key })).catch(() => {})
    const { error: dbErr } = await admin.from('workspace_photos').delete().eq('id', row.id)
    if (!dbErr) deleted++
  }

  console.log('[cron/cleanup-photos]', new Date().toISOString(), {
    candidates: rows.length,
    paused: rows.length - eligible.length,
    deleted,
  })
  return NextResponse.json({ deleted, paused: rows.length - eligible.length })
}
