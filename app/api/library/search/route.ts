import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'

export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { searchParams } = req.nextUrl
  const q = searchParams.get('q')?.trim() || ''
  const type = searchParams.get('type') || ''
  const tagsRaw = searchParams.get('tags') || ''
  const sort = searchParams.get('sort') || 'date'
  const limit = Math.min(50, Math.max(1, parseInt(searchParams.get('limit') || '10', 10)))
  const offset = Math.max(0, parseInt(searchParams.get('offset') || '0', 10))

  // Build query — never return full_text (can be very large)
  let query = supabase
    .from('library_items')
    .select('id, type, title, summary, tags, source_url, metadata, updated_at, verified')
    .eq('user_id', user.id)
    .eq('deleted', false)

  if (type === 'legal_case' || type === 'paper') {
    query = query.eq('type', type)
  }

  if (tagsRaw) {
    const tags = tagsRaw.split(',').map(t => t.trim()).filter(Boolean)
    if (tags.length) query = query.contains('tags', tags)
  }

  if (q) {
    query = query.textSearch('tsv', q, { config: 'swedish', type: 'websearch' })
  }

  // Sort
  if (sort === 'alpha') {
    query = query.order('title', { ascending: true })
  } else if (sort === 'verified_last') {
    query = query.order('verified', { ascending: true }).order('updated_at', { ascending: false })
  } else {
    query = query.order('updated_at', { ascending: false })
  }

  query = query.range(offset, offset + limit - 1)

  const { data, error } = await query
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  return NextResponse.json(data ?? [], {
    headers: { 'Cache-Control': 'no-store' },
  })
}
