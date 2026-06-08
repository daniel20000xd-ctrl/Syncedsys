import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { isAdminEmail } from '@/lib/admin'
import { getR2Client, R2_BUCKET } from '@/lib/r2'
import { PutObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3'
import { randomUUID } from 'crypto'

export const runtime = 'nodejs'

const ALLOWED_MIME = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/heic'])
const MAX_SIZE = 20 * 1024 * 1024

function extForMime(mime: string): string {
  if (mime === 'image/jpeg') return 'jpg'
  if (mime === 'image/png') return 'png'
  if (mime === 'image/webp') return 'webp'
  return 'heic'
}

function extractDimensions(buf: Buffer, mime: string): { width: number; height: number } | null {
  try {
    if (mime === 'image/png' && buf.length >= 24) {
      return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) }
    }
    if (mime === 'image/jpeg') {
      let offset = 2
      while (offset + 4 < buf.length) {
        if (buf[offset] !== 0xff) break
        const marker = buf[offset + 1]
        if (marker >= 0xc0 && marker <= 0xc3) {
          return { height: buf.readUInt16BE(offset + 5), width: buf.readUInt16BE(offset + 7) }
        }
        const segLen = buf.readUInt16BE(offset + 2)
        offset += 2 + segLen
      }
    }
  } catch { /* non-fatal */ }
  return null
}

export async function POST(req: NextRequest) {
  const bearer = (req.headers.get('authorization') ?? '').replace(/^Bearer\s+/i, '').trim()
  const companionSecret = process.env.COMPANION_APP_SECRET

  let userId: string

  if (companionSecret && bearer === companionSecret) {
    const admin = createAdminClient()
    const adminEmail = process.env.ADMIN_EMAIL?.trim().toLowerCase()
    if (!adminEmail) return NextResponse.json({ error: 'ADMIN_EMAIL not configured' }, { status: 500 })
    const { data: { users } } = await admin.auth.admin.listUsers()
    const adminUser = users.find(u => u.email?.toLowerCase() === adminEmail)
    if (!adminUser) return NextResponse.json({ error: 'Admin user not found' }, { status: 500 })
    userId = adminUser.id
  } else {
    const supabase = await createClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    if (!isAdminEmail(user.email)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    userId = user.id
  }

  let formData: FormData
  try {
    formData = await req.formData()
  } catch {
    return NextResponse.json({ error: 'Invalid form data' }, { status: 400 })
  }

  const file = formData.get('file')
  if (!(file instanceof File)) return NextResponse.json({ error: 'file field required' }, { status: 400 })

  const mime = file.type || 'application/octet-stream'
  if (!ALLOWED_MIME.has(mime)) {
    return NextResponse.json({ error: 'Only jpeg, png, webp, and heic are allowed' }, { status: 400 })
  }
  if (file.size > MAX_SIZE) {
    return NextResponse.json({ error: 'File exceeds 20 MB limit' }, { status: 400 })
  }

  const projectTag = (formData.get('project_tag') as string | null)?.trim() || null
  const ext = extForMime(mime)
  const r2Key = `workspace-photos/${userId}/${randomUUID()}.${ext}`

  const buf = Buffer.from(await file.arrayBuffer())
  const dims = extractDimensions(buf, mime)

  await getR2Client().send(new PutObjectCommand({
    Bucket: R2_BUCKET, Key: r2Key, Body: buf, ContentType: mime,
  }))

  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString()
  const admin = createAdminClient()
  const { data, error } = await admin.from('workspace_photos').insert({
    user_id: userId,
    filename: file.name || `photo.${ext}`,
    r2_key: r2Key,
    mime_type: mime,
    size_bytes: file.size,
    expires_at: expiresAt,
    project_tag: projectTag,
    width: dims?.width ?? null,
    height: dims?.height ?? null,
  }).select('id, r2_key, expires_at').single()

  if (error) {
    await getR2Client().send(new DeleteObjectCommand({ Bucket: R2_BUCKET, Key: r2Key })).catch(() => {})
    return NextResponse.json({ error: 'Failed to save photo record' }, { status: 500 })
  }

  return NextResponse.json(data, { status: 201 })
}
