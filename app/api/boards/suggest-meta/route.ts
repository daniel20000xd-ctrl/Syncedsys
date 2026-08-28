import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { suggestBoardMeta } from '@/lib/claude/suggestBoardMeta'
import { tryResolveAnthropicKey } from '@/lib/claude/key'
import { recordClaudeUsage } from '@/lib/claude/usage'
import { claudeGate } from '@/lib/claude/gate'

export const dynamic = 'force-dynamic'

export async function POST(req: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })

  const { name, mode } = await req.json()
  if (!name || !mode) return NextResponse.json({ error: 'name and mode required' }, { status: 400 })

  const resolved = await tryResolveAnthropicKey(supabase, user.id)
  if (!resolved) return NextResponse.json({ error: 'no_key' }, { status: 400 })

  const gate = await claudeGate(supabase, user.id, resolved.keySource)
  if (!gate.ok) return NextResponse.json({ error: gate.error }, { status: gate.error === 'claude_disabled' ? 503 : 402 })

  const { suggestion, usage } = await suggestBoardMeta(name, mode, resolved.apiKey)
  await recordClaudeUsage({ userId: user.id, model: 'claude-haiku-4-5-20251001', keySource: resolved.keySource, usage })
  return NextResponse.json({ suggestion })
}
