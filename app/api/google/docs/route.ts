import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { getDocument, renderDocumentToHtml, documentWordCount } from '@/lib/google/docs'

// GET /api/google/docs?documentId= — returns the document rendered to HTML,
// plus its title and word count for the viewer chrome. Requires a session.
export async function GET(req: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { searchParams } = new URL(req.url)
  const documentId = searchParams.get('documentId')
  if (!documentId) return NextResponse.json({ error: 'documentId is required' }, { status: 400 })

  try {
    const doc = await getDocument(user.id, documentId)
    return NextResponse.json({
      title: doc.title ?? 'Untitled document',
      html: renderDocumentToHtml(doc),
      wordCount: documentWordCount(doc),
    })
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : 'Failed to load document' }, { status: 502 })
  }
}
