import { type NextRequest } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { storeOAuthCode } from '@/lib/mcpOauth'

export const dynamic = 'force-dynamic'

// Minimal HTML for the approval page — avoids pulling in React/Next layouts.
function approvalPage(params: {
  codeChallenge: string
  redirectUri: string
  clientId: string
  state: string
  userEmail: string
}): string {
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;')
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Connect Claude — Syncedsys</title>
<style>
  *, *::before, *::after { box-sizing: border-box }
  body { font-family: system-ui, -apple-system, sans-serif; background: #f8fafc; color: #0f172a;
         display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0 }
  .card { background: white; border-radius: 16px; padding: 2.5rem; max-width: 420px; width: 100%;
          box-shadow: 0 4px 24px rgba(0,0,0,.08); text-align: center }
  .logo { font-size: 2rem; margin-bottom: 1rem }
  h1 { font-size: 1.25rem; font-weight: 600; margin: 0 0 .5rem }
  .sub { color: #64748b; font-size: .9rem; margin: 0 0 2rem }
  .account { background: #f1f5f9; border-radius: 8px; padding: .6rem 1rem;
             font-size: .85rem; color: #475569; margin-bottom: 2rem }
  .btns { display: flex; gap: .75rem; justify-content: center }
  button, a.deny { padding: .65rem 1.5rem; border-radius: 8px; font-size: .9rem;
                   font-weight: 500; cursor: pointer; text-decoration: none; display: inline-block }
  button { background: #2563eb; color: white; border: none }
  button:hover { background: #1d4ed8 }
  a.deny { background: none; border: 1px solid #e2e8f0; color: #475569 }
  a.deny:hover { background: #f1f5f9 }
</style>
</head>
<body>
<div class="card">
  <div class="logo">⚡</div>
  <h1>Connect Claude to Syncedsys</h1>
  <p class="sub">Claude wants to read and manage your boards.<br>This creates a personal access token.</p>
  <div class="account">Signed in as <strong>${esc(params.userEmail)}</strong></div>
  <div class="btns">
    <form method="POST">
      <input type="hidden" name="code_challenge" value="${esc(params.codeChallenge)}">
      <input type="hidden" name="redirect_uri"   value="${esc(params.redirectUri)}">
      <input type="hidden" name="client_id"      value="${esc(params.clientId)}">
      <input type="hidden" name="state"          value="${esc(params.state)}">
      <button type="submit">Allow</button>
    </form>
    <a class="deny" href="${esc(params.redirectUri)}?error=access_denied&amp;state=${esc(params.state)}">Deny</a>
  </div>
</div>
</body>
</html>`
}

function loginPrompt(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Sign in — Syncedsys</title>
<style>
  body { font-family: system-ui, sans-serif; background: #f8fafc; display: flex; align-items: center;
         justify-content: center; min-height: 100vh; margin: 0; color: #0f172a }
  .card { background: white; border-radius: 16px; padding: 2.5rem; max-width: 400px; width: 100%;
          box-shadow: 0 4px 24px rgba(0,0,0,.08); text-align: center }
  h1 { font-size: 1.2rem; margin: 0 0 .75rem }
  p { color: #64748b; font-size: .9rem; margin: 0 0 2rem }
  a { padding: .65rem 1.5rem; border-radius: 8px; background: #2563eb; color: white;
      text-decoration: none; font-size: .9rem; font-weight: 500 }
</style>
</head>
<body>
<div class="card">
  <h1>Sign in to Syncedsys</h1>
  <p>Please sign in first, then return here to connect Claude.</p>
  <a href="/login">Sign in</a>
</div>
</body>
</html>`
}

// GET — show the approval page (or login prompt if not authenticated).
export async function GET(req: NextRequest): Promise<Response> {
  const { searchParams } = req.nextUrl
  const codeChallenge     = searchParams.get('code_challenge') ?? ''
  const codeChallengeMethod = searchParams.get('code_challenge_method') ?? ''
  const redirectUri       = searchParams.get('redirect_uri') ?? ''
  const clientId          = searchParams.get('client_id') ?? 'claude'
  const state             = searchParams.get('state') ?? ''
  const responseType      = searchParams.get('response_type') ?? ''

  if (responseType !== 'code' || codeChallengeMethod !== 'S256' || !codeChallenge || !redirectUri) {
    return new Response('Invalid authorization request', { status: 400 })
  }

  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()

  if (!user) {
    return new Response(loginPrompt(), { headers: { 'Content-Type': 'text/html; charset=utf-8' } })
  }

  return new Response(approvalPage({
    codeChallenge,
    redirectUri,
    clientId,
    state,
    userEmail: user.email ?? user.id,
  }), { headers: { 'Content-Type': 'text/html; charset=utf-8' } })
}

// POST — user approved; create an auth code and redirect back to the client.
export async function POST(req: NextRequest): Promise<Response> {
  const form = await req.formData()
  const codeChallenge = (form.get('code_challenge') as string | null) ?? ''
  const redirectUri   = (form.get('redirect_uri')   as string | null) ?? ''
  const clientId      = (form.get('client_id')      as string | null) ?? 'claude'
  const state         = (form.get('state')          as string | null) ?? ''

  if (!codeChallenge || !redirectUri) {
    return new Response('Bad request', { status: 400 })
  }

  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) {
    return new Response(loginPrompt(), { headers: { 'Content-Type': 'text/html; charset=utf-8' } })
  }

  try {
    const code = await storeOAuthCode({ userId: user.id, codeChallenge, redirectUri, clientId })
    const dest = new URL(redirectUri)
    dest.searchParams.set('code', code)
    if (state) dest.searchParams.set('state', state)
    return Response.redirect(dest.toString(), 302)
  } catch (err) {
    const dest = new URL(redirectUri)
    dest.searchParams.set('error', 'server_error')
    if (state) dest.searchParams.set('state', state)
    console.error('OAuth authorize failed:', err)
    return Response.redirect(dest.toString(), 302)
  }
}
