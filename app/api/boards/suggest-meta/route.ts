import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { loadApiKey, suggestBoardMeta } from '@/app/api/mcp/route'
import { isClaudeEnabled } from '@/lib/mcp'

export const dynamic = 'force-dynamic'

export async function POST(req: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })

  const { name, mode } = await req.json()
  if (!name || !mode) return NextResponse.json({ error: 'name and mode required' }, { status: 400 })

  if (!await isClaudeEnabled(supabase, user.id)) return NextResponse.json({ error: 'no_key' }, { status: 400 })

  const apiKey = await loadApiKey(supabase, user.id)
  if (!apiKey) return NextResponse.json({ error: 'no_key' }, { status: 400 })

  const suggestion = await suggestBoardMeta(name, mode, apiKey)
  return NextResponse.json({ suggestion })
}
