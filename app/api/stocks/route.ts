import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import yf from 'yahoo-finance2'
// Cast to a simple interface — the real types require matching module-list literals
// which TypeScript can't easily infer through the generic overloads.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const yahooFinance = yf as any as {
  chart: (ticker: string, opts: Record<string, unknown>) => Promise<{ quotes: Array<Record<string, unknown>> }>
  quoteSummary: (ticker: string, opts: Record<string, unknown>) => Promise<Record<string, Record<string, unknown>>>
  search: (ticker: string, opts: Record<string, unknown>) => Promise<{ news?: Array<Record<string, unknown>> }>
}
import { RSI, SMA, MACD, BollingerBands } from 'technicalindicators'

// ── Types ──────────────────────────────────────────────────────────────────────

interface OHLCVBar {
  time: string
  open: number
  high: number
  low: number
  close: number
  volume: number
}

interface StockResult {
  ticker: string
  interval: string
  currentPrice: number
  change: number
  changePercent: number
  marketCap: number | null
  peRatio: number | null
  dividendYield: number | null
  high52w: number | null
  low52w: number | null
  eps: number | null
  ohlcv: OHLCVBar[]
  sma50: { time: string; value: number }[]
  sma200: { time: string; value: number }[]
  indicators: {
    rsi: number | null
    macd: number | null
    macdSignal: number | null
    macdHistogram: number | null
    bbUpper: number | null
    bbMiddle: number | null
    bbLower: number | null
    bbWidth: number | null
  }
  news: Array<{
    title: string
    source: string
    link: string
    publishedAt: string
    sentiment: 'positive' | 'negative' | 'neutral'
  }>
}

// ── Helpers ────────────────────────────────────────────────────────────────────

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

const POSITIVE = /\b(rise[sd]?|gain[sed]?|beats?|rallies?|rally|surge[sd]?|upgrades?|positive|profit|record|soar[sed]?|jump[sed]?|climb[sed]?)\b/i
const NEGATIVE = /\b(fall[sn]?|fell|drop[sped]?|misses?|missed|slide[sd]?|plunge[sd]?|downgrade[sd]?|negative|loss|warn[sed]?|decline[sd]?|tumble[sd]?)\b/i

function sentiment(title: string): 'positive' | 'negative' | 'neutral' {
  if (POSITIVE.test(title)) return 'positive'
  if (NEGATIVE.test(title)) return 'negative'
  return 'neutral'
}

// ── Handler ───────────────────────────────────────────────────────────────────

export async function GET(req: NextRequest) {
  // Auth
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { searchParams } = new URL(req.url)
  const rawTicker = searchParams.get('ticker')
  const interval   = searchParams.get('interval') ?? '1Y'

  if (!rawTicker) return NextResponse.json({ error: 'ticker required' }, { status: 400 })
  if (!['1M', '3M', '6M', '1Y'].includes(interval)) {
    return NextResponse.json({ error: 'invalid interval' }, { status: 400 })
  }

  const ticker = rawTicker.toUpperCase().trim()
  const admin  = createAdminClient()

  // ── Cache check ─────────────────────────────────────────────────────────────
  const { data: cached } = await admin
    .from('stock_cache')
    .select('data, fetched_at')
    .eq('ticker', ticker)
    .eq('interval', interval)
    .maybeSingle()

  if (cached?.fetched_at) {
    const ageMs = Date.now() - new Date(cached.fetched_at as string).getTime()
    if (ageMs < 6 * 60 * 60 * 1000) {
      return NextResponse.json(cached.data)
    }
  }

  // ── Fetch fresh data ─────────────────────────────────────────────────────────
  try {
    const now = new Date()
    // Always fetch 3 years so SMA200 has enough history
    const fullStart  = new Date(now.getFullYear() - 3, now.getMonth(), now.getDate())
    const chartStart = getChartStart(interval, now)
    const chartStartStr = chartStart.toISOString().slice(0, 10)

    // Historical OHLCV ──────────────────────────────────────────────────────────
    const chartResult = await yahooFinance.chart(ticker, {
      period1: fullStart,
      period2: now,
      interval: '1d',
    } as Parameters<typeof yahooFinance.chart>[1])

    const rawQuotes = chartResult.quotes ?? []
    if (rawQuotes.length === 0) {
      return NextResponse.json({ error: `No data found for "${ticker}". Check the ticker symbol.` }, { status: 404 })
    }

    // Filter out bars with any null OHLC
    const allQuotes = rawQuotes.filter(
      (q) => q.open != null && q.high != null && q.low != null && q.close != null
    )

    const allCloses = allQuotes.map((q) => q.close as number)
    const allDates  = allQuotes.map((q) => toIso(q.date as Date))

    // Chart-range OHLCV
    const chartQuotes = allQuotes.filter((q) => toIso(q.date as Date) >= chartStartStr)
    const ohlcv: OHLCVBar[] = chartQuotes.map((q) => ({
      time:   toIso(q.date as Date),
      open:   r2(q.open  as number),
      high:   r2(q.high  as number),
      low:    r2(q.low   as number),
      close:  r2(q.close as number),
      volume: (q.volume as number | null) ?? 0,
    }))

    // Technical indicators ──────────────────────────────────────────────────────

    // SMA50 (aligned to allDates, then filtered to chart range)
    const sma50Raw    = SMA.calculate({ period: 50, values: allCloses })
    const sma50Off    = allCloses.length - sma50Raw.length
    const sma50       = sma50Raw
      .map((v, i) => ({ time: allDates[sma50Off + i], value: r2(v) }))
      .filter((d) => d.time >= chartStartStr)

    // SMA200
    const sma200Raw   = SMA.calculate({ period: 200, values: allCloses })
    const sma200Off   = allCloses.length - sma200Raw.length
    const sma200      = sma200Raw
      .map((v, i) => ({ time: allDates[sma200Off + i], value: r2(v) }))
      .filter((d) => d.time >= chartStartStr)

    // RSI(14)
    const rsiRaw      = RSI.calculate({ period: 14, values: allCloses })
    const currentRsi  = rsiRaw.length > 0
      ? Math.round(rsiRaw[rsiRaw.length - 1] * 10) / 10
      : null

    // MACD(12,26,9)
    const macdRaw = MACD.calculate({
      values: allCloses,
      fastPeriod: 12, slowPeriod: 26, signalPeriod: 9,
      SimpleMAOscillator: false, SimpleMASignal: false,
    })
    const lastMacd = macdRaw.length > 0 ? macdRaw[macdRaw.length - 1] : null

    // Bollinger Bands(20,2)
    const bbRaw   = BollingerBands.calculate({ period: 20, values: allCloses, stdDev: 2 })
    const lastBb  = bbRaw.length > 0 ? bbRaw[bbRaw.length - 1] : null

    // Fundamentals ─────────────────────────────────────────────────────────────
    const lastClose  = allQuotes[allQuotes.length - 1].close as number
    const prevClose2 = allQuotes.length > 1 ? (allQuotes[allQuotes.length - 2].close as number) : lastClose

    let currentPrice = r2(lastClose)
    let prevClose    = r2(prevClose2)
    let marketCap:     number | null = null
    let peRatio:       number | null = null
    let dividendYield: number | null = null
    let eps:           number | null = null
    let high52w: number | null = r2(Math.max(...allCloses.slice(-252)))
    let low52w:  number | null = r2(Math.min(...allCloses.slice(-252)))

    try {
      const summary = await yahooFinance.quoteSummary(ticker, {
        modules: ['price', 'summaryDetail', 'defaultKeyStatistics'],
      } as Parameters<typeof yahooFinance.quoteSummary>[1])

      const p  = summary.price
      const sd = summary.summaryDetail
      const ks = summary.defaultKeyStatistics

      if (p?.regularMarketPrice        != null) currentPrice  = r2(p.regularMarketPrice as number)
      if (p?.regularMarketPreviousClose!= null) prevClose     = r2(p.regularMarketPreviousClose as number)
      if (p?.marketCap                 != null) marketCap     = p.marketCap as number
      if (sd?.trailingPE               != null) peRatio       = Math.round((sd.trailingPE as number) * 10) / 10
      else if (ks?.forwardPE           != null) peRatio       = Math.round((ks.forwardPE as number) * 10) / 10
      if (sd?.dividendYield            != null) dividendYield = Math.round((sd.dividendYield as number) * 10000) / 100
      if (ks?.trailingEps              != null) eps           = r2(ks.trailingEps as number)
      const h = (sd?.fiftyTwoWeekHigh ?? p?.fiftyTwoWeekHigh) as number | null | undefined
      const l = (sd?.fiftyTwoWeekLow  ?? p?.fiftyTwoWeekLow)  as number | null | undefined
      if (h != null) high52w = r2(h)
      if (l != null) low52w  = r2(l)
    } catch {
      // Use chart-derived fallbacks already set above
    }

    const change        = r2(currentPrice - prevClose)
    const changePercent = prevClose > 0 ? Math.round((change / prevClose) * 10000) / 100 : 0

    // News ─────────────────────────────────────────────────────────────────────
    const newsItems: StockResult['news'] = []
    try {
      const searchResult = await yahooFinance.search(ticker, { newsCount: 10 } as Parameters<typeof yahooFinance.search>[1])
      for (const item of searchResult.news ?? []) {
        const title = (item as { title?: string }).title ?? ''
        const pub   = (item as { providerPublishTime?: Date | number }).providerPublishTime
        newsItems.push({
          title,
          source:      (item as { publisher?: string }).publisher ?? 'Unknown',
          link:        (item as { link?: string }).link ?? '#',
          publishedAt: pub instanceof Date
            ? pub.toISOString()
            : typeof pub === 'number'
              ? new Date(pub * 1000).toISOString()
              : new Date().toISOString(),
          sentiment: sentiment(title),
        })
      }
    } catch {
      // News optional — skip silently
    }

    // Assemble result ──────────────────────────────────────────────────────────
    const result: StockResult = {
      ticker, interval,
      currentPrice, change, changePercent,
      marketCap, peRatio, dividendYield, high52w, low52w, eps,
      ohlcv, sma50, sma200,
      indicators: {
        rsi:           currentRsi,
        macd:          lastMacd?.MACD    != null ? Math.round((lastMacd.MACD    as number) * 10000) / 10000 : null,
        macdSignal:    lastMacd?.signal  != null ? Math.round((lastMacd.signal  as number) * 10000) / 10000 : null,
        macdHistogram: lastMacd?.histogram != null ? Math.round((lastMacd.histogram as number) * 10000) / 10000 : null,
        bbUpper:       lastBb?.upper  != null ? r2(lastBb.upper)  : null,
        bbMiddle:      lastBb?.middle != null ? r2(lastBb.middle) : null,
        bbLower:       lastBb?.lower  != null ? r2(lastBb.lower)  : null,
        bbWidth: (lastBb?.upper != null && lastBb?.lower != null && lastBb.middle && lastBb.middle > 0)
          ? Math.round(((lastBb.upper - lastBb.lower) / lastBb.middle) * 10000) / 100
          : null,
      },
      news: newsItems,
    }

    // Cache result
    await admin.from('stock_cache').upsert(
      { ticker, interval, data: result, fetched_at: new Date().toISOString() },
      { onConflict: 'ticker,interval' }
    )

    return NextResponse.json(result)

  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error('[/api/stocks] error:', msg)
    if (/not found|no data|no fundamentals|invalid symbol/i.test(msg)) {
      return NextResponse.json({ error: `Ticker "${ticker}" not found or has no data.` }, { status: 404 })
    }
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
