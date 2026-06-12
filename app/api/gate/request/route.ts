import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/admin'

export async function POST(req: NextRequest) {
  const secret = req.headers.get('x-gate-secret')
  if (!secret || secret !== process.env.GATE_SECRET) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }

  let body: { email?: unknown; attempt_type?: unknown }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ success: true })
  }

  const { email, attempt_type } = body
  if (
    typeof email !== 'string' ||
    !email ||
    typeof attempt_type !== 'string' ||
    !['login', 'signup'].includes(attempt_type)
  ) {
    return NextResponse.json({ success: true })
  }

  try {
    const admin = createAdminClient()
    await admin.from('gate_requests').insert({ email, attempt_type })
  } catch {
    // swallow — never expose DB state
  }

  return NextResponse.json({ success: true })
}
