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

  const { data: expired, error } = await admin
    .from('workspace_photos')
    .select('id, r2_key')
    .lt('expires_at', now)
    .eq('is_saved', false)

  if (error) {
    console.error('[cron/cleanup-photos] query error:', error.message)
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  const rows = expired ?? []
  const r2 = getR2Client()

  let deleted = 0
  for (const row of rows) {
    await r2.send(new DeleteObjectCommand({ Bucket: R2_BUCKET, Key: row.r2_key })).catch(() => {})
    const { error: dbErr } = await admin.from('workspace_photos').delete().eq('id', row.id)
    if (!dbErr) deleted++
  }

  console.log('[cron/cleanup-photos]', new Date().toISOString(), { deleted, candidates: rows.length })
  return NextResponse.json({ deleted })
}
