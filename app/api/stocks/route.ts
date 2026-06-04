import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'

const STOCKS_API = process.env.STOCKS_API_URL ?? 'https://stocks.syncedsys.com'

export async function GET(req: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { searchParams } = new URL(req.url)
  const upstream = `${STOCKS_API}/api/stocks?${searchParams.toString()}`

  // Forward the user's Supabase session cookies so the satellite can authenticate
  const cookieHeader = req.headers.get('cookie') ?? ''

  try {
    const res = await fetch(upstream, {
      headers: { 'Cookie': cookieHeader },
      cache: 'no-store',
    })
    const data = await res.json()
    return NextResponse.json(data, { status: res.status })
  } catch {
    return NextResponse.json({ error: 'Stock data service is temporarily unavailable' }, { status: 503 })
  }
}
