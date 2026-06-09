// Single authenticated entry point to the i.syncedsys research satellite.
// Every research_* MCP tool goes through this so the bearer secret and base URL
// live in exactly one place — never duplicated per tool. RESEARCH_API_SECRET must
// be byte-for-byte identical to MCP_SECRET in the syncedsys-i satellite, or every
// call returns 401.
//
// Unlike googleFetch (which returns the raw Response), this parses the JSON body
// and throws on a non-2xx, so each tool handler stays a one-liner wrapped in the
// route's `wrap()` helper — which turns a throw into an MCP error result.

type ResearchQuery = Record<string, string | number | boolean | undefined | null>

export async function researchFetch(
  path: string,
  opts: { method?: string; query?: ResearchQuery; body?: unknown } = {},
): Promise<unknown> {
  const base = process.env.RESEARCH_API_BASE_URL
  const secret = process.env.RESEARCH_API_SECRET
  if (!base) throw new Error('RESEARCH_API_BASE_URL is not configured')
  if (!secret) throw new Error('RESEARCH_API_SECRET is not configured')

  const url = new URL(path, base)
  if (opts.query) {
    for (const [key, value] of Object.entries(opts.query)) {
      if (value !== undefined && value !== null && value !== '') {
        url.searchParams.set(key, String(value))
      }
    }
  }

  const headers = new Headers({ Authorization: `Bearer ${secret}` })
  let serializedBody: string | undefined
  if (opts.body !== undefined) {
    headers.set('content-type', 'application/json')
    serializedBody = JSON.stringify(opts.body)
  }

  const res = await fetch(url, {
    method: opts.method ?? (opts.body !== undefined ? 'POST' : 'GET'),
    headers,
    body: serializedBody,
  })

  const raw = await res.text()
  let parsed: unknown = null
  if (raw) {
    try { parsed = JSON.parse(raw) } catch { parsed = raw }
  }

  if (!res.ok) {
    const detail =
      parsed && typeof parsed === 'object' && 'error' in parsed
        ? (parsed as { error: unknown }).error
        : parsed ?? res.statusText
    const message = typeof detail === 'string' ? detail : JSON.stringify(detail)
    throw new Error(`Research API ${res.status}: ${message}`)
  }

  return parsed
}
