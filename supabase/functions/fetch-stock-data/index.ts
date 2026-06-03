/**
 * Supabase Edge Function: fetch-stock-data
 *
 * Production alternative to the Next.js API route at /api/stocks.
 * Deploy with: supabase functions deploy fetch-stock-data
 *
 * Uses Deno's npm: imports — no separate package.json needed.
 */

// @ts-expect-error Deno npm import
import { createClient } from 'npm:@supabase/supabase-js@2'
// @ts-expect-error Deno npm import
import yahooFinance from 'npm:yahoo-finance2@2'
// @ts-expect-error Deno npm import
import { RSI, SMA, MACD, BollingerBands } from 'npm:technicalindicators@3'

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

function r2(n: number) { return Math.round(n * 100) / 100 }

function toIso(d: Date | number | string): string {
  if (d instanceof Date) return d.toISOString().slice(0, 10)
  if (typeof d === 'number') return new Date(d * 1000).toISOString().slice(0, 10)
  return String(d).slice(0, 10)
}

function getChartStart(interval: string, now: Date): Date {
  switch (interval) {
    case '1M': return new Date(now.getFullYear(), now.getMonth() - 1, now.getDate())
    case '3M': return new Date(now.getFullYear(), now.getMonth() - 3, now.getDate())
    case '6M': return new Date(now.getFullYear(), now.getMonth() - 6, now.getDate())
    default:   return new Date(now.getFullYear() - 1, now.getMonth(), now.getDate())
  }
}

const POSITIVE = /\b(rise[sd]?|gain[sed]?|beats?|rally|rallies?|surge[sd]?|upgrades?|soar[sed]?|jump[sed]?)\b/i
const NEGATIVE = /\b(fall[sn]?|fell|drop[sped]?|misses?|missed|slide[sd]?|plunge[sd]?|downgrade[sd]?|warn[sed]?|decline[sd]?)\b/i
function sentiment(title: string) {
  return POSITIVE.test(title) ? 'positive' : NEGATIVE.test(title) ? 'negative' : 'neutral'
}

// @ts-expect-error Deno global
Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })

  const hdrs = { ...CORS, 'Content-Type': 'application/json' }
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: hdrs })

  try {
    const authHeader = req.headers.get('Authorization')
    if (!authHeader) return json({ error: 'Unauthorized' }, 401)

    // Verify JWT via Supabase auth
    // @ts-expect-error Deno env
    const supabase = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_ANON_KEY')!, {
      global: { headers: { Authorization: authHeader } },
    })
    const { data: { user }, error: authErr } = await supabase.auth.getUser()
    if (authErr || !user) return json({ error: 'Unauthorized' }, 401)

    const body = await req.json()
    const ticker   = (String(body.ticker ?? '')).toUpperCase().trim()
    const interval = ['1M','3M','6M','1Y'].includes(body.interval) ? body.interval as string : '1Y'
    if (!ticker) return json({ error: 'ticker required' }, 400)

    // Admin client for cache ops (bypasses RLS)
    // @ts-expect-error Deno env
    const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)

    // Cache check
    const { data: cached } = await admin.from('stock_cache').select('data, fetched_at')
      .eq('ticker', ticker).eq('interval', interval).maybeSingle()
    if (cached?.fetched_at) {
      const age = Date.now() - new Date(cached.fetched_at).getTime()
      if (age < 6 * 60 * 60 * 1000) return json(cached.data)
    }

    const now = new Date()
    const fullStart  = new Date(now.getFullYear() - 3, now.getMonth(), now.getDate())
    const chartStart = getChartStart(interval, now)
    const csStr = chartStart.toISOString().slice(0, 10)

    const chartResult = await yahooFinance.chart(ticker, { period1: fullStart, period2: now, interval: '1d' })
    const rawQuotes = chartResult.quotes ?? []
    if (!rawQuotes.length) return json({ error: `No data for "${ticker}"` }, 404)

    const allQ      = rawQuotes.filter((q: Record<string,unknown>) => q.open != null && q.close != null)
    const allCloses = allQ.map((q: Record<string,unknown>) => q.close as number)
    const allDates  = allQ.map((q: Record<string,unknown>) => toIso(q.date as Date))
    const chartQ    = allQ.filter((q: Record<string,unknown>) => toIso(q.date as Date) >= csStr)

    const ohlcv = chartQ.map((q: Record<string,unknown>) => ({
      time: toIso(q.date as Date),
      open: r2(q.open as number), high: r2(q.high as number),
      low:  r2(q.low  as number), close:r2(q.close as number),
      volume: (q.volume as number | null) ?? 0,
    }))

    const sma50Raw  = SMA.calculate({ period: 50,  values: allCloses })
    const sma200Raw = SMA.calculate({ period: 200, values: allCloses })
    const sma50  = sma50Raw .map((v: number, i: number) => ({ time: allDates[allCloses.length - sma50Raw.length  + i], value: r2(v) })).filter((d: {time:string}) => d.time >= csStr)
    const sma200 = sma200Raw.map((v: number, i: number) => ({ time: allDates[allCloses.length - sma200Raw.length + i], value: r2(v) })).filter((d: {time:string}) => d.time >= csStr)

    const rsiRaw   = RSI.calculate({ period: 14, values: allCloses })
    const macdRaw  = MACD.calculate({ values: allCloses, fastPeriod: 12, slowPeriod: 26, signalPeriod: 9, SimpleMAOscillator: false, SimpleMASignal: false })
    const bbRaw    = BollingerBands.calculate({ period: 20, values: allCloses, stdDev: 2 })
    const lastMacd = macdRaw.at(-1) ?? null
    const lastBb   = bbRaw.at(-1)   ?? null

    let currentPrice = r2(allQ.at(-1)?.close ?? 0), prevClose = r2(allQ.at(-2)?.close ?? currentPrice)
    let marketCap = null, peRatio = null, dividendYield = null, eps = null
    let high52w = r2(Math.max(...allCloses.slice(-252))), low52w = r2(Math.min(...allCloses.slice(-252)))

    try {
      const s = await yahooFinance.quoteSummary(ticker, { modules: ['price','summaryDetail','defaultKeyStatistics'] })
      const p = s.price, sd = s.summaryDetail, ks = s.defaultKeyStatistics
      if (p?.regularMarketPrice)         currentPrice  = r2(p.regularMarketPrice)
      if (p?.regularMarketPreviousClose) prevClose     = r2(p.regularMarketPreviousClose)
      if (p?.marketCap)                  marketCap     = p.marketCap
      if (sd?.trailingPE)                peRatio       = Math.round(sd.trailingPE * 10) / 10
      if (sd?.dividendYield)             dividendYield = Math.round(sd.dividendYield * 10000) / 100
      if (ks?.trailingEps)               eps           = r2(ks.trailingEps)
      if (sd?.fiftyTwoWeekHigh ?? p?.fiftyTwoWeekHigh) high52w = r2(sd?.fiftyTwoWeekHigh ?? p?.fiftyTwoWeekHigh)
      if (sd?.fiftyTwoWeekLow  ?? p?.fiftyTwoWeekLow)  low52w  = r2(sd?.fiftyTwoWeekLow  ?? p?.fiftyTwoWeekLow)
    } catch { /* use fallbacks */ }

    const change = r2(currentPrice - prevClose)
    const changePercent = prevClose > 0 ? Math.round(change / prevClose * 10000) / 100 : 0

    const news: unknown[] = []
    try {
      const sr = await yahooFinance.search(ticker, { newsCount: 10 })
      for (const item of sr.news ?? []) {
        const title = item.title ?? ''
        const pub   = item.providerPublishTime
        news.push({
          title, source: item.publisher ?? 'Unknown', link: item.link ?? '#',
          publishedAt: pub instanceof Date ? pub.toISOString() : typeof pub === 'number' ? new Date(pub*1000).toISOString() : new Date().toISOString(),
          sentiment: sentiment(title),
        })
      }
    } catch { /* skip */ }

    const result = {
      ticker, interval, currentPrice, change, changePercent,
      marketCap, peRatio, dividendYield, high52w, low52w, eps,
      ohlcv, sma50, sma200,
      indicators: {
        rsi: rsiRaw.length ? Math.round(rsiRaw.at(-1) * 10) / 10 : null,
        macd:          lastMacd?.MACD      != null ? Math.round(lastMacd.MACD      * 10000) / 10000 : null,
        macdSignal:    lastMacd?.signal    != null ? Math.round(lastMacd.signal    * 10000) / 10000 : null,
        macdHistogram: lastMacd?.histogram != null ? Math.round(lastMacd.histogram * 10000) / 10000 : null,
        bbUpper:  lastBb?.upper  != null ? r2(lastBb.upper)  : null,
        bbMiddle: lastBb?.middle != null ? r2(lastBb.middle) : null,
        bbLower:  lastBb?.lower  != null ? r2(lastBb.lower)  : null,
        bbWidth:  lastBb?.upper != null && lastBb.lower != null && lastBb.middle > 0
          ? Math.round((lastBb.upper - lastBb.lower) / lastBb.middle * 10000) / 100 : null,
      },
      news,
    }

    await admin.from('stock_cache').upsert(
      { ticker, interval, data: result, fetched_at: new Date().toISOString() },
      { onConflict: 'ticker,interval' }
    )

    return json(result)

  } catch (err: unknown) {
    return json({ error: String(err) }, 500)
  }
})
