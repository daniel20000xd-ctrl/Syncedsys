import { getAccessToken, forceRefreshAccessToken } from '@/lib/google/auth'

// fetch wrapper that authenticates as the given user's connected Google account.
// Injects a valid access token automatically and, on a 401 (token revoked or
// rejected despite our expiry math), refreshes once and retries. Shared by all
// Google integrations so none of them re-implement token handling.
export async function googleFetch(
  userId: string,
  url: string,
  options: RequestInit = {},
): Promise<Response> {
  const token = await getAccessToken(userId)
  let res = await authedFetch(url, options, token)

  if (res.status === 401) {
    let refreshed: string
    try {
      refreshed = await forceRefreshAccessToken(userId)
    } catch (e) {
      throw new Error(
        `Google authentication failed and the token could not be refreshed: ${
          e instanceof Error ? e.message : 'unknown error'
        }`,
      )
    }
    res = await authedFetch(url, options, refreshed)
  }

  return res
}

function authedFetch(url: string, options: RequestInit, token: string): Promise<Response> {
  const headers = new Headers(options.headers)
  headers.set('Authorization', `Bearer ${token}`)
  return fetch(url, { ...options, headers })
}
