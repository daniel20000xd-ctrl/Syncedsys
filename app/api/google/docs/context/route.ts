import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { formatDocsContext } from '@/lib/google/docs'

// GET /api/google/docs/context?documentId= — plain-text summary for Claude.
export async function GET(req: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { searchParams } = new URL(req.url)
  const documentId = searchParams.get('documentId')
  if (!documentId) return NextResponse.json({ error: 'documentId is required' }, { status: 400 })

  try {
    const text = await formatDocsContext(user.id, documentId)
    return new NextResponse(text, {
      headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' },
    })
  } catch (e) {
    return new NextResponse(e instanceof Error ? e.message : 'Context failed', { status: 502 })
  }
}
