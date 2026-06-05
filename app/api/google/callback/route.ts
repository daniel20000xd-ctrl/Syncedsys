import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { exchangeCodeForTokens, decodeState } from '@/lib/google/auth'

// Handles the OAuth redirect from Google. On success the tokens are stored
// encrypted and the user lands back on the connected-apps settings page; any
// failure redirects there with ?error=google_auth_failed.
export async function GET(request: Request) {
  const { searchParams, origin } = new URL(request.url)
  const code = searchParams.get('code')
  const state = searchParams.get('state')
  const oauthError = searchParams.get('error')

  const success = `${origin}/settings/connected-apps`
  const failure = `${origin}/settings/connected-apps?error=google_auth_failed`

  if (oauthError || !code) {
    return NextResponse.redirect(failure)
  }

  try {
    // The redirect carries the initiating user's session cookies; verify the
    // state's userId matches the signed-in user before storing anything (CSRF).
    const decoded = state ? decodeState(state) : null
    const supabase = await createClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user || !decoded || decoded.userId !== user.id) {
      return NextResponse.redirect(failure)
    }

    await exchangeCodeForTokens(code)
    return NextResponse.redirect(success)
  } catch {
    return NextResponse.redirect(failure)
  }
}
