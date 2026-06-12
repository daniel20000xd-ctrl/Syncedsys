import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { isAdminEmail } from '@/lib/admin'

export async function POST(req: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!isAdminEmail(user?.email)) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  }

  let body: { id?: unknown; action?: unknown }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'bad request' }, { status: 400 })
  }

  const { id, action } = body
  if (
    typeof id !== 'string' ||
    !id ||
    typeof action !== 'string' ||
    !['approve', 'deny'].includes(action)
  ) {
    return NextResponse.json({ error: 'bad request' }, { status: 400 })
  }

  const admin = createAdminClient()

  if (action === 'approve') {
    const { data: gateReq } = await admin
      .from('gate_requests')
      .select('email')
      .eq('id', id)
      .single()

    if (!gateReq?.email) {
      return NextResponse.json({ error: 'not found' }, { status: 404 })
    }

    // Error from invite is intentionally ignored — user may already exist.
    // The row is still marked approved so the admin sees the decision.
    await admin.auth.admin.inviteUserByEmail(gateReq.email)
  }

  const { error } = await admin
    .from('gate_requests')
    .update({
      status: action === 'approve' ? 'approved' : 'denied',
      actioned_at: new Date().toISOString(),
    })
    .eq('id', id)
    .eq('status', 'pending')

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  return NextResponse.json({ success: true })
}
