import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'

export const dynamic = 'force-dynamic'

type IngestItem = {
  type: 'legal_case' | 'paper'
  title: string
  summary?: string | null
  tags?: string[]
  source_url?: string | null
  full_text?: string | null
  metadata?: Record<string, unknown>
  content_hash?: string | null
  verified?: boolean
}

export async function POST(req: NextRequest) {
  const admin = createAdminClient()

  // Accept either a browser session (cookie) or a static bearer token for scripts.
  const bearer = (req.headers.get('authorization') ?? '').replace(/^Bearer\s+/i, '').trim()
  const ingestKey = process.env.LIBRARY_INGEST_KEY

  let userId: string

  if (ingestKey && bearer === ingestKey) {
    // Script path: look up the admin user by email so inserts are scoped correctly.
    const adminEmail = process.env.ADMIN_EMAIL?.trim().toLowerCase()
    if (!adminEmail) return NextResponse.json({ error: 'ADMIN_EMAIL not configured' }, { status: 500 })
    const { data: { users } } = await admin.auth.admin.listUsers()
    const adminUser = users.find(u => u.email?.toLowerCase() === adminEmail)
    if (!adminUser) return NextResponse.json({ error: 'Admin user not found' }, { status: 500 })
    userId = adminUser.id
  } else {
    // Browser path: validate the session cookie as before.
    const supabase = await createClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    userId = user.id
  }

  let body: { items?: unknown }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  const items = body.items
  if (!Array.isArray(items)) {
    return NextResponse.json({ error: '`items` must be an array' }, { status: 400 })
  }

  let inserted = 0, updated = 0, skipped = 0
  const errors: string[] = []

  for (const raw of items) {
    const item = raw as IngestItem
    if (!item.type || !item.title) {
      errors.push(`Missing type or title: ${JSON.stringify(raw).slice(0, 80)}`)
      continue
    }

    try {
      const meta = (item.metadata ?? {}) as Record<string, unknown>
      const beteckning = typeof meta.beteckning === 'string' ? meta.beteckning : null
      const doi = typeof meta.doi === 'string' ? meta.doi : null

      // Find existing non-deleted row by the natural key.
      let existing: { id: string; content_hash: string | null; version: number } | null = null

      if (item.type === 'legal_case' && beteckning) {
        const { data: rows } = await admin
          .from('library_items')
          .select('id, content_hash, version')
          .eq('user_id', userId)
          .eq('type', 'legal_case')
          .eq('deleted', false)
          .filter('metadata->>beteckning', 'eq', beteckning)
          .limit(1)
        existing = rows?.[0] ?? null
      } else if (item.type === 'paper' && doi) {
        const { data: rows } = await admin
          .from('library_items')
          .select('id, content_hash, version')
          .eq('user_id', userId)
          .eq('type', 'paper')
          .eq('deleted', false)
          .filter('metadata->>doi', 'eq', doi)
          .limit(1)
        existing = rows?.[0] ?? null
      }

      if (existing) {
        if (item.content_hash && existing.content_hash === item.content_hash) {
          skipped++
          continue
        }
        await admin.from('library_items').update({
          title: item.title,
          summary: item.summary ?? null,
          tags: item.tags ?? [],
          source_url: item.source_url ?? null,
          full_text: item.full_text ?? null,
          metadata: meta,
          content_hash: item.content_hash ?? null,
          verified: item.verified ?? false,
          version: (existing.version ?? 1) + 1,
          updated_at: new Date().toISOString(),
        }).eq('id', existing.id)
        updated++
      } else {
        await admin.from('library_items').insert({
          user_id: userId,
          type: item.type,
          title: item.title,
          summary: item.summary ?? null,
          tags: item.tags ?? [],
          source_url: item.source_url ?? null,
          full_text: item.full_text ?? null,
          metadata: meta,
          content_hash: item.content_hash ?? null,
          verified: item.verified ?? false,
        })
        inserted++
      }
    } catch (err) {
      errors.push(`"${(raw as IngestItem).title ?? '?'}": ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  return NextResponse.json({ inserted, updated, skipped, errors })
}
