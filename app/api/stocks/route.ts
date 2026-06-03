import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { RSI, SMA, MACD, BollingerBands } from 'technicalindicators'

// ── Types ──────────────────────────────────────────────────────────────────────

interface OHLCVBar { time: string; open: number; high: number; low: number; close: number; volume: number }

interface StockResult {
  ticker: string; interval: string
  currentPrice: number; change: number; changePercent: number
  marketCap: number | null; peRatio: number | null
  dividendYield: number | null; high52w: number | null; low52w: number | null; eps: number | null
  ohlcv: OHLCVBar[]
  sma50: { time: string; value: number }[]
  sma200: { time: string; value: number }[]
  indicators: {
    rsi: number | null; macd: number | null; macdSignal: number | null
    macdHistogram: number | null; bbUpper: number | null; bbMiddle: number | null
    bbLower: number | null; bbWidth: number | null
  }
  news: Array<{ title: string; source: string; link: string; publishedAt: string; sentiment: 'positive' | 'negative' | 'neutral' }>
}

// ── Yahoo Finance REST helpers ─────────────────────────────────────────────────
// Calls the same endpoints yahoo-finance2 uses internally — no external package.

const YF1 = 'https://query1.finance.yahoo.com'
const YF2 = 'https://query2.finance.yahoo.com'

const YF_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Accept': 'application/json',
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function yfGet(url: string): Promise<any> {
  const res = await fetch(url, { headers: YF_HEADERS, cache: 'no-store' })
  if (!res.ok) throw new Error(`Yahoo Finance returned ${res.status} for ${url}`)
  return res.json()
}

function r2(n: number) { return Math.round(n * 100) / 100 }

function toIso(ts: number) {
  const d = new Date(ts * 1000)
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`
}

function getChartStart(interval: string, now: Date): string {
  let d: Date
  switch (interval) {
    case '1M': d = new Date(now.getFullYear(), now.getMonth() - 1, now.getDate()); break
    case '3M': d = new Date(now.getFullYear(), now.getMonth() - 3, now.getDate()); break
    case '6M': d = new Date(now.getFullYear(), now.getMonth() - 6, now.getDate()); break
    default:   d = new Date(now.getFullYear() - 1, now.getMonth(), now.getDate())
  }
  return d.toISOString().slice(0, 10)
}

const POSITIVE = /\b(rise[sd]?|gain[sed]?|beats?|rallies?|rally|surge[sd]?|upgrades?|positive|profit|record|soar[sed]?|jump[sed]?|climb[sed]?)\b/i
const NEGATIVE = /\b(fall[sn]?|fell|drop[sped]?|misses?|missed|slide[sd]?|plunge[sd]?|downgrade[sd]?|negative|loss|warn[sed]?|decline[sd]?|tumble[sd]?)\b/i
function sentiment(t: string): 'positive' | 'negative' | 'neutral' {
  return POSITIVE.test(t) ? 'positive' : NEGATIVE.test(t) ? 'negative' : 'neutral'
}

// ── Handler ───────────────────────────────────────────────────────────────────

export async function GET(req: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { searchParams } = new URL(req.url)
  const rawTicker = searchParams.get('ticker')
  const interval  = searchParams.get('interval') ?? '1Y'

  if (!rawTicker) return NextResponse.json({ error: 'ticker required' }, { status: 400 })
  if (!['1M', '3M', '6M', '1Y'].includes(interval)) return NextResponse.json({ error: 'invalid interval' }, { status: 400 })

  const ticker = rawTicker.toUpperCase().trim()
  const admin  = createAdminClient()

  // ── Cache (skip gracefully if table doesn't exist yet) ─────────────────────
  try {
    const { data: cached } = await admin
      .from('stock_cache').select('data, fetched_at')
      .eq('ticker', ticker).eq('interval', interval).maybeSingle()
    if (cached?.fetched_at) {
      const age = Date.now() - new Date(cached.fetched_at as string).getTime()
      if (age < 6 * 60 * 60 * 1000) return NextResponse.json(cached.data)
    }
  } catch { /* table not yet created */ }

  // ── Fetch from Yahoo Finance ───────────────────────────────────────────────
  try {
    // Always fetch 3 years so SMA200 has enough lookback
    const chartData = await yfGet(
      `${YF1}/v8/finance/chart/${encodeURIComponent(ticker)}?range=3y&interval=1d`
    )

    const result0 = chartData?.chart?.result?.[0]
    if (!result0 || chartData?.chart?.error) {
      return NextResponse.json({ error: `Ticker "${ticker}" not found or has no data.` }, { status: 404 })
    }

    // Extract raw arrays — Yahoo returns nulls for non-trading days
    const timestamps:  number[] = result0.timestamp ?? []
    const rawOpen:     (number | null)[] = result0.indicators?.quote?.[0]?.open   ?? []
    const rawHigh:     (number | null)[] = result0.indicators?.quote?.[0]?.high   ?? []
    const rawLow:      (number | null)[] = result0.indicators?.quote?.[0]?.low    ?? []
    const rawClose:    (number | null)[] = result0.indicators?.quote?.[0]?.close  ?? []
    const rawVolume:   (number | null)[] = result0.indicators?.quote?.[0]?.volume ?? []

    if (timestamps.length === 0) {
      return NextResponse.json({ error: `No price data found for "${ticker}".` }, { status: 404 })
    }

    // Build clean OHLCV array (drop rows with any null OHLC)
    type Bar = { ts: number; time: string; open: number; high: number; low: number; close: number; volume: number }
    const allBars: Bar[] = []
    for (let i = 0; i < timestamps.length; i++) {
      const o = rawOpen[i], h = rawHigh[i], l = rawLow[i], c = rawClose[i]
      if (o == null || h == null || l == null || c == null) continue
      allBars.push({ ts: timestamps[i], time: toIso(timestamps[i]), open: r2(o), high: r2(h), low: r2(l), close: r2(c), volume: rawVolume[i] ?? 0 })
    }

    if (allBars.length === 0) {
      return NextResponse.json({ error: `No usable price data for "${ticker}".` }, { status: 404 })
    }

    const allCloses = allBars.map(b => b.close)
    const allDates  = allBars.map(b => b.time)

    // Slice to requested interval for chart display
    const chartStartStr = getChartStart(interval, new Date())
    const chartBars = allBars.filter(b => b.time >= chartStartStr)
    const ohlcv: OHLCVBar[] = chartBars.map(({ time, open, high, low, close, volume }) => ({ time, open, high, low, close, volume }))

    // ── Technical indicators ──────────────────────────────────────────────────

    const sma50Raw  = SMA.calculate({ period: 50,  values: allCloses })
    const sma200Raw = SMA.calculate({ period: 200, values: allCloses })
    const sma50Off  = allCloses.length - sma50Raw.length
    const sma200Off = allCloses.length - sma200Raw.length
    const sma50  = sma50Raw .map((v, i) => ({ time: allDates[sma50Off  + i], value: r2(v) })).filter(d => d.time >= chartStartStr)
    const sma200 = sma200Raw.map((v, i) => ({ time: allDates[sma200Off + i], value: r2(v) })).filter(d => d.time >= chartStartStr)

    const rsiRaw  = RSI.calculate({ period: 14, values: allCloses })
    const macdRaw = MACD.calculate({ values: allCloses, fastPeriod: 12, slowPeriod: 26, signalPeriod: 9, SimpleMAOscillator: false, SimpleMASignal: false })
    const bbRaw   = BollingerBands.calculate({ period: 20, values: allCloses, stdDev: 2 })

    const lastMacd = macdRaw.length > 0 ? macdRaw[macdRaw.length - 1] : null
    const lastBb   = bbRaw.length > 0 ? bbRaw[bbRaw.length - 1] : null
    const currentRsi = rsiRaw.length > 0 ? Math.round(rsiRaw[rsiRaw.length - 1] * 10) / 10 : null

    // ── Price + meta from chart ────────────────────────────────────────────────
    const meta = result0.meta ?? {}
    let currentPrice = r2((meta.regularMarketPrice as number | undefined) ?? allBars[allBars.length - 1].close)
    let prevClose    = r2((meta.chartPreviousClose  as number | undefined) ?? (meta.previousClose as number | undefined) ?? (allBars.length > 1 ? allBars[allBars.length - 2].close : currentPrice))
    let marketCap:     number | null = null
    let peRatio:       number | null = null
    let dividendYield: number | null = null
    let eps:           number | null = null
    let high52w: number | null = r2(Math.max(...allCloses.slice(-252)))
    let low52w:  number | null = r2(Math.min(...allCloses.slice(-252)))

    // ── Fundamentals (quoteSummary) ────────────────────────────────────────────
    try {
      const summaryData = await yfGet(
        `${YF2}/v10/finance/quoteSummary/${encodeURIComponent(ticker)}?modules=price,summaryDetail,defaultKeyStatistics`
      )
      const s  = summaryData?.quoteSummary?.result?.[0] ?? {}
      const p  = s.price ?? {}
      const sd = s.summaryDetail ?? {}
      const ks = s.defaultKeyStatistics ?? {}

      // Yahoo returns raw values nested under a 'raw' key
      const raw = (obj: Record<string, unknown>, key: string): number | null => {
        const v = (obj[key] as { raw?: number } | number | undefined)
        if (v == null) return null
        return typeof v === 'number' ? v : (v as { raw?: number }).raw ?? null
      }

      currentPrice  = r2(raw(p, 'regularMarketPrice')         ?? currentPrice)
      prevClose     = r2(raw(p, 'regularMarketPreviousClose')  ?? prevClose)
      marketCap     = raw(p, 'marketCap')
      peRatio       = raw(sd, 'trailingPE') != null ? Math.round((raw(sd, 'trailingPE') as number) * 10) / 10 : null
      dividendYield = raw(sd, 'dividendYield') != null ? Math.round((raw(sd, 'dividendYield') as number) * 10000) / 100 : null
      eps           = raw(ks, 'trailingEps') != null ? r2(raw(ks, 'trailingEps') as number) : null
      const h = raw(sd, 'fiftyTwoWeekHigh') ?? raw(p, 'fiftyTwoWeekHigh')
      const l = raw(sd, 'fiftyTwoWeekLow')  ?? raw(p, 'fiftyTwoWeekLow')
      if (h != null) high52w = r2(h)
      if (l != null) low52w  = r2(l)
    } catch {
      // fundamentals optional — use chart-derived fallbacks
    }

    const change        = r2(currentPrice - prevClose)
    const changePercent = prevClose > 0 ? Math.round((change / prevClose) * 10000) / 100 : 0

    // ── News ──────────────────────────────────────────────────────────────────
    const newsItems: StockResult['news'] = []
    try {
      const searchData = await yfGet(
        `${YF1}/v1/finance/search?q=${encodeURIComponent(ticker)}&newsCount=10&enableFuzzyQuery=false&quotesCount=0`
      )
      for (const item of searchData?.news ?? []) {
        const title = (item.title as string | undefined) ?? ''
        newsItems.push({
          title,
          source:      (item.publisher         as string | undefined) ?? 'Unknown',
          link:        (item.link               as string | undefined) ?? '#',
          publishedAt: (item.providerPublishTime as number | undefined)
            ? new Date((item.providerPublishTime as number) * 1000).toISOString()
            : new Date().toISOString(),
          sentiment: sentiment(title),
        })
      }
    } catch { /* news optional */ }

    // ── Assemble ──────────────────────────────────────────────────────────────
    const stockResult: StockResult = {
      ticker, interval, currentPrice, change, changePercent,
      marketCap, peRatio, dividendYield, high52w, low52w, eps,
      ohlcv, sma50, sma200,
      indicators: {
        rsi:           currentRsi,
        macd:          lastMacd?.MACD      != null ? Math.round((lastMacd.MACD      as number) * 10000) / 10000 : null,
        macdSignal:    lastMacd?.signal    != null ? Math.round((lastMacd.signal    as number) * 10000) / 10000 : null,
        macdHistogram: lastMacd?.histogram != null ? Math.round((lastMacd.histogram as number) * 10000) / 10000 : null,
        bbUpper:  lastBb?.upper  != null ? r2(lastBb.upper)  : null,
        bbMiddle: lastBb?.middle != null ? r2(lastBb.middle) : null,
        bbLower:  lastBb?.lower  != null ? r2(lastBb.lower)  : null,
        bbWidth: lastBb?.upper != null && lastBb.lower != null && lastBb.middle && lastBb.middle > 0
          ? Math.round(((lastBb.upper - lastBb.lower) / lastBb.middle) * 10000) / 100
          : null,
      },
      news: newsItems,
    }

    // Cache (skip if table missing)
    try {
      await admin.from('stock_cache').upsert(
        { ticker, interval, data: stockResult, fetched_at: new Date().toISOString() },
        { onConflict: 'ticker,interval' }
      )
    } catch { /* cache table not yet created */ }

    return NextResponse.json(stockResult)

  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error('[/api/stocks] error:', msg)
    if (/404|not found|no data|no.*result/i.test(msg)) {
      return NextResponse.json({ error: `Ticker "${ticker}" not found or has no data.` }, { status: 404 })
    }
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
