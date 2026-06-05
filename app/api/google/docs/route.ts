import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import {
  getDocument,
  renderDocumentToHtml,
  documentWordCount,
  appendText,
  insertText,
  replaceAllText,
} from '@/lib/google/docs'

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

// POST /api/google/docs — edit the document. Body: { documentId, action, ... }.
// action 'append' { text } | 'replace' { find, replace, matchCase? } |
// 'insert' { index, text }. Requires the `documents` (write) scope.
export async function POST(req: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  let body: {
    documentId?: string
    action?: string
    text?: string
    find?: string
    replace?: string
    matchCase?: boolean
    index?: number
  }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const { documentId, action } = body
  if (!documentId) return NextResponse.json({ error: 'documentId is required' }, { status: 400 })

  try {
    switch (action) {
      case 'append':
        await appendText(user.id, documentId, String(body.text ?? ''))
        return NextResponse.json({ ok: true })
      case 'insert':
        await insertText(user.id, documentId, Number(body.index ?? 1), String(body.text ?? ''))
        return NextResponse.json({ ok: true })
      case 'replace': {
        const n = await replaceAllText(
          user.id,
          documentId,
          String(body.find ?? ''),
          String(body.replace ?? ''),
          Boolean(body.matchCase),
        )
        return NextResponse.json({ ok: true, occurrencesChanged: n })
      }
      default:
        return NextResponse.json({ error: `Unknown action: ${action}` }, { status: 400 })
    }
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : 'Edit failed' }, { status: 502 })
  }
}
