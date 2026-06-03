// ── Avanza (unofficial) data source for Nordic / Swedish stocks ────────────────
//
// Avanza is Sweden's largest retail broker. Their public website is backed by
// undocumented REST endpoints that return rich fundamentals in SEK — exactly the
// data Yahoo Finance is often missing for Swedish (.ST) tickers.
//
// THIS MODULE IS DELIBERATELY FAILURE-PROOF. It is an UNOFFICIAL source that may
// change shape or disappear without warning. Every code path:
//   • has a hard per-request timeout (AbortController)
//   • is wrapped so it NEVER throws — it returns `null` on any problem
//   • parses every field defensively with optional chaining
// A caller can therefore always do `const a = await fetchAvanzaData(t)` and treat
// `null` as "no extra data", with zero risk to the main response.

export interface AvanzaData {
  orderBookId: string
  name: string | null
  marketList: string | null
  currency: string | null
  // Valuation
  peRatio: number | null
  psRatio: number | null
  pbRatio: number | null
  evEbit: number | null
  // Yield / returns
  directYield: number | null            // stored as ratio 0-1 (e.g. 0.0238 = 2.38%)
  beta: number | null
  volatility: number | null
  returnOnEquity: number | null
  returnOnAssets: number | null
  returnOnCapitalEmployed: number | null
  equityRatio: number | null
  // Margins
  grossMargin: number | null
  operatingMargin: number | null
  netMargin: number | null
  // Per-share / size (SEK)
  marketCap: number | null
  eps: number | null
  equityPerShare: number | null
  operatingCashFlow: number | null
  // Ownership / activity
  numberOfOwners: number | null
  shortSellingRatio: number | null
  // Dividend
  dividendAmount: number | null
  dividendExDate: string | null
  dividendsPerYear: number | null
  // Reporting calendar
  nextReportDate: string | null
  nextReportType: string | null
  previousReportDate: string | null
}

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
const BASE = 'https://www.avanza.se'

// fetch with a hard timeout — resolves to null on timeout/abort/network error.
async function safeFetch(url: string, init: RequestInit, ms: number): Promise<Response | null> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), ms)
  try {
    const res = await fetch(url, { ...init, signal: ctrl.signal, cache: 'no-store' })
    return res.ok ? res : null
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function num(v: any): number | null {
  if (v == null) return null
  if (typeof v === 'number' && Number.isFinite(v)) return v
  if (typeof v === 'object' && typeof v.value === 'number') return v.value
  return null
}

// Yahoo ticker (e.g. "ERIC-B.ST") → Avanza search query + expected symbol ("ERIC B")
function normalize(ticker: string): { query: string; symbol: string } {
  const base = ticker.replace(/\.(ST|STO)$/i, '')   // drop the .ST suffix
  const symbol = base.replace(/-/g, ' ').toUpperCase().trim()
  return { query: symbol, symbol }
}

// Is this a Swedish-listed ticker that Avanza would have?
export function isSwedishTicker(ticker: string): boolean {
  return /\.ST$/i.test(ticker)
}

/**
 * Best-effort fetch of Avanza fundamentals for a Swedish ticker.
 * Returns null on ANY failure — never throws, never blocks the caller meaningfully.
 */
export async function fetchAvanzaData(ticker: string): Promise<AvanzaData | null> {
  try {
    if (!isSwedishTicker(ticker)) return null
    const { query, symbol } = normalize(ticker)

    // ── 1. Resolve the order-book id via filtered search ──────────────────────
    const searchRes = await safeFetch(
      `${BASE}/_api/search/filtered-search`,
      {
        method: 'POST',
        headers: { 'User-Agent': UA, 'Content-Type': 'application/json', 'Accept': 'application/json' },
        body: JSON.stringify({ query, pagination: { from: 0, size: 15 } }),
      },
      3500,
    )
    if (!searchRes) return null

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let searchJson: any
    try { searchJson = await searchRes.json() } catch { return null }

    const hits: unknown[] = Array.isArray(searchJson?.hits) ? searchJson.hits : []
    if (!hits.length) return null

    // Match a STOCK hit whose parenthesised ticker equals the expected symbol.
    // If none matches exactly, bail rather than risk returning the wrong company.
    let orderBookId: string | null = null
    let matchedName: string | null = null
    for (const h of hits) {
      const hit = h as Record<string, unknown>
      if (hit.type !== 'STOCK') continue
      const title = String(hit.title ?? '')
      const m = title.match(/\(([^)]+)\)\s*$/)
      const hitSymbol = m ? m[1].toUpperCase().trim() : ''
      if (hitSymbol === symbol && hit.orderBookId) {
        orderBookId = String(hit.orderBookId)
        matchedName = title.replace(/\s*\([^)]*\)\s*$/, '').trim() || null
        break
      }
    }
    if (!orderBookId) return null

    // ── 2. Fetch the market-guide payload ─────────────────────────────────────
    const guideRes = await safeFetch(
      `${BASE}/_api/market-guide/stock/${orderBookId}`,
      { headers: { 'User-Agent': UA, 'Accept': 'application/json' } },
      4000,
    )
    if (!guideRes) return null

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let g: any
    try { g = await guideRes.json() } catch { return null }

    const ki = g?.keyIndicators ?? {}
    const listing = g?.listing ?? {}
    const div = ki?.dividend ?? {}
    const nextReport = ki?.nextReport ?? {}
    const prevReport = ki?.previousReport ?? {}

    return {
      orderBookId,
      name:        (g?.name as string) ?? matchedName,
      marketList:  (listing?.marketListName as string) ?? null,
      currency:    (listing?.currency as string) ?? null,
      peRatio:     num(ki.priceEarningsRatio),
      psRatio:     num(ki.priceSalesRatio),
      pbRatio:     num(ki.priceBookRatio),
      evEbit:      num(ki.evEbitRatio),
      directYield: num(ki.directYield),
      beta:        num(ki.beta),
      volatility:  num(ki.volatility),
      returnOnEquity:          num(ki.returnOnEquity),
      returnOnAssets:          num(ki.returnOnTotalAssets),
      returnOnCapitalEmployed: num(ki.returnOnCapitalEmployed),
      equityRatio:             num(ki.equityRatio),
      grossMargin:     num(ki.grossMargin),
      operatingMargin: num(ki.operatingProfitMargin),
      netMargin:       num(ki.netMargin),
      marketCap:         num(ki.marketCapital),
      eps:               num(ki.earningsPerShare),
      equityPerShare:    num(ki.equityPerShare),
      operatingCashFlow: num(ki.operatingCashFlow),
      numberOfOwners:    num(ki.numberOfOwners),
      shortSellingRatio: num(ki.shortSellingRatio),
      dividendAmount:   num(div.amount),
      dividendExDate:   (div.exDate as string) ?? null,
      dividendsPerYear: num(ki.dividendsPerYear),
      nextReportDate:     (nextReport.date as string) ?? null,
      nextReportType:     (nextReport.reportType as string) ?? null,
      previousReportDate: (prevReport.date as string) ?? null,
    }
  } catch {
    // Absolutely never let an Avanza problem bubble up.
    return null
  }
}
