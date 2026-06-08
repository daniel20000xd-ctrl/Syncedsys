import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { getR2Client, R2_BUCKET } from '@/lib/r2'
import { GetObjectCommand } from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'

export const dynamic = 'force-dynamic'

const SELECT = 'id, filename, r2_key, mime_type, size_bytes, created_at, expires_at, is_saved, project_tag, description, width, height'

export async function GET(req: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { searchParams } = new URL(req.url)
  const savedOnly = searchParams.get('saved') === 'true'
  const projectTagFilter = searchParams.get('project_tag')

  const admin = createAdminClient()
  let query = admin
    .from('workspace_photos')
    .select(SELECT)
    .eq('user_id', user.id)
    .order('created_at', { ascending: false })

  if (savedOnly) query = query.eq('is_saved', true)
  if (projectTagFilter) query = query.eq('project_tag', projectTagFilter)

  const { data, error } = await query
  if (error) return NextResponse.json({ error: 'Failed to fetch photos' }, { status: 500 })

  const r2 = getR2Client()
  const withUrls = await Promise.all(
    (data ?? []).map(async (photo, i) => {
      const signed_url = await getSignedUrl(
        r2,
        new GetObjectCommand({ Bucket: R2_BUCKET, Key: photo.r2_key }),
        { expiresIn: 3600 },
      ).catch(() => '')
      return { ...photo, number: i + 1, signed_url }
    }),
  )

  return NextResponse.json(withUrls)
}
