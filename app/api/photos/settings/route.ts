import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'

export const dynamic = 'force-dynamic'

export async function GET() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const admin = createAdminClient()
  const { data } = await admin
    .from('photo_library_settings')
    .select('pause_deletion')
    .eq('user_id', user.id)
    .maybeSingle()

  return NextResponse.json({ pause_deletion: data?.pause_deletion ?? false })
}

export async function PATCH(req: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  let body: { pause_deletion?: boolean }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  if (typeof body.pause_deletion !== 'boolean') {
    return NextResponse.json({ error: 'pause_deletion (boolean) required' }, { status: 400 })
  }

  const admin = createAdminClient()
  const { error } = await admin
    .from('photo_library_settings')
    .upsert({ user_id: user.id, pause_deletion: body.pause_deletion, updated_at: new Date().toISOString() })
    .eq('user_id', user.id)

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  return NextResponse.json({ pause_deletion: body.pause_deletion })
}
