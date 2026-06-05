import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { googleFetch } from '@/lib/google/client'

// TEMPORARY verification endpoint — confirms the Google OAuth wiring works
// end-to-end by reading the connected account's profile through googleFetch.
// Safe to delete once the connection is confirmed.
export async function GET() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  try {
    const res = await googleFetch(user.id, 'https://www.googleapis.com/oauth2/v1/userinfo')
    if (!res.ok) {
      const detail = await res.text().catch(() => '')
      return NextResponse.json(
        { error: 'Google request failed', status: res.status, detail },
        { status: 502 },
      )
    }
    const info = (await res.json()) as { email?: string; name?: string }
    return NextResponse.json({ email: info.email ?? null, name: info.name ?? null })
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : 'Google auth failed' },
      { status: 500 },
    )
  }
}
