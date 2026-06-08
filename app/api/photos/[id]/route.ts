import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { getR2Client, R2_BUCKET } from '@/lib/r2'
import { DeleteObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'

const SELECT = 'id, filename, r2_key, mime_type, size_bytes, created_at, expires_at, is_saved, project_tag, description, width, height'

async function resolveUser() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { ok: false as const, status: 401, error: 'Unauthorized' }
  return { ok: true as const, userId: user.id }
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await resolveUser()
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status })

  const { id } = await params

  let body: { is_saved?: boolean; project_tag?: string; description?: string }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  const patch: Record<string, unknown> = {}
  if (typeof body.is_saved === 'boolean') {
    patch.is_saved = body.is_saved
    patch.expires_at = body.is_saved ? null : new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString()
  }
  if (typeof body.project_tag === 'string') patch.project_tag = body.project_tag.trim() || null
  if (typeof body.description === 'string') patch.description = body.description.trim() || null

  if (Object.keys(patch).length === 0) {
    return NextResponse.json({ error: 'No valid fields to update' }, { status: 400 })
  }

  const admin = createAdminClient()
  const { data, error } = await admin
    .from('workspace_photos')
    .update(patch)
    .eq('id', id)
    .eq('user_id', auth.userId)
    .select(SELECT)
    .single()

  if (error || !data) return NextResponse.json({ error: 'Not found or update failed' }, { status: 404 })

  const signed_url = await getSignedUrl(
    getR2Client(),
    new GetObjectCommand({ Bucket: R2_BUCKET, Key: data.r2_key }),
    { expiresIn: 3600 },
  ).catch(() => '')

  return NextResponse.json({ ...data, signed_url })
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await resolveUser()
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status })

  const { id } = await params
  const admin = createAdminClient()

  const { data: photo } = await admin
    .from('workspace_photos')
    .select('r2_key')
    .eq('id', id)
    .eq('user_id', auth.userId)
    .single()

  if (!photo) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  await getR2Client().send(new DeleteObjectCommand({ Bucket: R2_BUCKET, Key: photo.r2_key })).catch(() => {})
  await admin.from('workspace_photos').delete().eq('id', id).eq('user_id', auth.userId)

  return new NextResponse(null, { status: 204 })
}
