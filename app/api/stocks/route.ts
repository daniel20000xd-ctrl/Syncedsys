import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { RSI, SMA, MACD, BollingerBands } from 'technicalindicators'
import { fetchAvanzaData, isSwedishTicker, type AvanzaData } from '@/lib/avanza'

// ── Types ──────────────────────────────────────────────────────────────────────

interface OHLCVBar { time: string; open: number; high: number; low: number; close: number; volume: number }

type Pct = number | null   // ratio stored as 0-1, e.g. 0.23 = 23%
type Num = number | null

interface IncomeRow  { date: string; totalRevenue: Num; grossProfit: Num; ebit: Num; netIncome: Num; ebitda: Num; totalOperatingExpenses: Num }
interface BalanceRow { date: string; totalAssets: Num; totalLiab: Num; equity: Num; cash: Num; shortDebt: Num; longDebt: Num }
interface CashRow    { date: string; operatingCF: Num; capex: Num; freeCF: Num; investingCF: Num; financingCF: Num }
interface EarningsRow { date: string; epsActual: Num; epsEstimate: Num; surprisePct: Num }
interface EstimateRow { period: string; endDate: string; epsEst: Num; revEst: Num; numAnalysts: Num }
interface RecRow      { period: string; strongBuy: number; buy: number; hold: number; sell: number; strongSell: number }
interface UpgradeRow  { date: string; firm: string; toGrade: string; fromGrade: string; action: string }
interface InsiderRow  { date: string; name: string; shares: Num; value: Num; description: string }

interface StockResult {
  ticker: string; interval: string
  currentPrice: number; change: number; changePercent: number
  // ── Price module ──
  marketCap: Num; peRatio: Num; dividendYield: Pct; high52w: Num; low52w: Num; eps: Num
  // ── Key stats ──
  forwardEps: Num; priceToBook: Num; enterpriseValue: Num; enterpriseToRevenue: Num
  enterpriseToEbitda: Num; beta: Num; shortRatio: Num; payoutRatio: Pct
  bookValue: Num; heldPercentInsiders: Pct; heldPercentInstitutions: Pct
  // ── Financial data / margins / analyst targets ──
  targetMeanPrice: Num; targetHighPrice: Num; targetLowPrice: Num; numberOfAnalysts: Num
  recommendationKey: string | null; recommendationMean: Num
  revenueGrowth: Pct; earningsGrowth: Pct; grossMargins: Pct; operatingMargins: Pct
  profitMargins: Pct; returnOnEquity: Pct; returnOnAssets: Pct
  debtToEquity: Num; currentRatio: Num; quickRatio: Num
  totalCash: Num; totalDebt: Num; freeCashflow: Num; operatingCashflow: Num
  totalRevenue: Num; grossProfits: Num; ebitda: Num
  // ── Company profile ──
  description: string | null; sector: string | null; industry: string | null
  employees: Num; website: string | null; country: string | null
  // ── Next earnings ──
  nextEarningsDate: string | null
  // ── Financial statements ──
  incomeAnnual: IncomeRow[]; incomeQuarterly: IncomeRow[]
  balanceAnnual: BalanceRow[]; cashflowAnnual: CashRow[]
  // ── Earnings & estimates ──
  earningsHistory: EarningsRow[]; earningsTrend: EstimateRow[]
  // ── Analyst ──
  recommendationTrend: RecRow[]; upgradeDowngradeHistory: UpgradeRow[]
  // ── Chart / TA ──
  ohlcv: OHLCVBar[]
  sma50: { time: string; value: number }[]
  sma200: { time: string; value: number }[]
  indicators: {
    rsi: Num; macd: Num; macdSignal: Num; macdHistogram: Num
    bbUpper: Num; bbMiddle: Num; bbLower: Num; bbWidth: Num
  }
  // ── Insider transactions ──
  insiderTransactions: InsiderRow[]
  // ── News ──
  news: Array<{ title: string; source: string; link: string; publishedAt: string; sentiment: 'positive' | 'negative' | 'neutral' }>
  // ── Nordic supplement (Avanza, Swedish tickers only; null if unavailable) ──
  avanza: AvanzaData | null
}

// ── Yahoo Finance helpers ─────────────────────────────────────────────────────

const YF1 = 'https://query1.finance.yahoo.com'
const YF2 = 'https://query2.finance.yahoo.com'

const YF_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Accept': 'application/json',
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function yfGet(url: string): Promise<any> {
  const res = await fetch(url, { headers: YF_HEADERS, cache: 'no-store' })
  if (!res.ok) throw new Error(`Yahoo Finance ${res.status}: ${url}`)
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

// Extract a raw numeric value from Yahoo Finance's {raw, fmt} pattern
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function raw(obj: any, key: string): number | null {
  const v = obj?.[key]
  if (v == null) return null
  if (typeof v === 'number') return v
  if (typeof v === 'object' && v.raw != null) return typeof v.raw === 'number' ? v.raw : null
  return null
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function fmtDate(obj: any): string {
  if (!obj) return ''
  if (typeof obj === 'string') return obj
  if (obj.fmt) return obj.fmt as string
  if (obj.raw) return toIso(obj.raw as number)
  return ''
}

const POSITIVE = /\b(rise[sd]?|gain[sed]?|beats?|rallies?|rally|surge[sd]?|upgrades?|positive|profit|record|soar[sed]?|jump[sed]?|climb[sed]?)\b/i
const NEGATIVE = /\b(fall[sn]?|fell|drop[sped]?|misses?|missed|slide[sd]?|plunge[sd]?|downgrade[sd]?|negative|loss|warn[sed]?|decline[sd]?|tumble[sd]?)\b/i
function sentiment(t: string): 'positive' | 'negative' | 'neutral' {
  return POSITIVE.test(t) ? 'positive' : NEGATIVE.test(t) ? 'negative' : 'neutral'
}

// ── Route handler ─────────────────────────────────────────────────────────────

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

  // ── Cache ─────────────────────────────────────────────────────────────────
  try {
    const { data: cached } = await admin
      .from('stock_cache').select('data, fetched_at')
      .eq('ticker', ticker).eq('interval', interval).maybeSingle()
    if (cached?.fetched_at) {
      const age = Date.now() - new Date(cached.fetched_at as string).getTime()
      if (age < 6 * 60 * 60 * 1000) return NextResponse.json(cached.data)
    }
  } catch { /* table not yet created */ }

  try {
    // ── 1. OHLCV chart (always fetch 3y for accurate SMA200) ──────────────────
    const chartData = await yfGet(`${YF1}/v8/finance/chart/${encodeURIComponent(ticker)}?range=3y&interval=1d`)
    const r0 = chartData?.chart?.result?.[0]
    if (!r0 || chartData?.chart?.error) {
      return NextResponse.json({ error: `Ticker "${ticker}" not found or has no data.` }, { status: 404 })
    }

    const timestamps: number[]        = r0.timestamp ?? []
    const rawOpen:  (number|null)[]   = r0.indicators?.quote?.[0]?.open   ?? []
    const rawHigh:  (number|null)[]   = r0.indicators?.quote?.[0]?.high   ?? []
    const rawLow:   (number|null)[]   = r0.indicators?.quote?.[0]?.low    ?? []
    const rawClose: (number|null)[]   = r0.indicators?.quote?.[0]?.close  ?? []
    const rawVol:   (number|null)[]   = r0.indicators?.quote?.[0]?.volume ?? []

    if (!timestamps.length) return NextResponse.json({ error: `No price data for "${ticker}".` }, { status: 404 })

    type Bar = { time: string; open: number; high: number; low: number; close: number; volume: number }
    const allBars: Bar[] = []
    for (let i = 0; i < timestamps.length; i++) {
      const o = rawOpen[i], h = rawHigh[i], l = rawLow[i], c = rawClose[i]
      if (o == null || h == null || l == null || c == null) continue
      allBars.push({ time: toIso(timestamps[i]), open: r2(o), high: r2(h), low: r2(l), close: r2(c), volume: rawVol[i] ?? 0 })
    }
    if (!allBars.length) return NextResponse.json({ error: `No usable OHLCV data for "${ticker}".` }, { status: 404 })

    const allCloses = allBars.map(b => b.close)
    const allDates  = allBars.map(b => b.time)
    const chartStartStr = getChartStart(interval, new Date())
    const ohlcv = allBars.filter(b => b.time >= chartStartStr)

    // ── 2. Technical indicators ───────────────────────────────────────────────
    const sma50Raw  = SMA.calculate({ period: 50,  values: allCloses })
    const sma200Raw = SMA.calculate({ period: 200, values: allCloses })
    const sma50off  = allCloses.length - sma50Raw.length
    const sma200off = allCloses.length - sma200Raw.length
    const sma50  = sma50Raw .map((v,i) => ({ time: allDates[sma50off+i],  value: r2(v) })).filter(d => d.time >= chartStartStr)
    const sma200 = sma200Raw.map((v,i) => ({ time: allDates[sma200off+i], value: r2(v) })).filter(d => d.time >= chartStartStr)

    const rsiRaw  = RSI.calculate({ period: 14, values: allCloses })
    const macdRaw = MACD.calculate({ values: allCloses, fastPeriod: 12, slowPeriod: 26, signalPeriod: 9, SimpleMAOscillator: false, SimpleMASignal: false })
    const bbRaw   = BollingerBands.calculate({ period: 20, values: allCloses, stdDev: 2 })
    const lm = macdRaw.length ? macdRaw[macdRaw.length - 1] : null
    const lb = bbRaw.length   ? bbRaw[bbRaw.length - 1]     : null

    // ── 3. Fundamentals — two parallel quoteSummary calls ─────────────────────
    const meta = r0.meta ?? {}
    let currentPrice = r2((meta.regularMarketPrice as number|undefined) ?? allBars[allBars.length-1].close)
    let prevClose    = r2((meta.chartPreviousClose  as number|undefined) ?? (meta.previousClose as number|undefined) ?? (allBars.length > 1 ? allBars[allBars.length-2].close : currentPrice))

    // Nulled-out defaults for all optional fields
    let marketCap:Num=null, peRatio:Num=null, dividendYield:Pct=null, high52w:Num=null, low52w:Num=null, eps:Num=null
    let forwardEps:Num=null, priceToBook:Num=null, enterpriseValue:Num=null, enterpriseToRevenue:Num=null
    let enterpriseToEbitda:Num=null, beta:Num=null, shortRatio:Num=null, payoutRatio:Pct=null
    let bookValue:Num=null, heldPercentInsiders:Pct=null, heldPercentInstitutions:Pct=null
    let targetMeanPrice:Num=null, targetHighPrice:Num=null, targetLowPrice:Num=null, numberOfAnalysts:Num=null
    let recommendationKey:string|null=null, recommendationMean:Num=null
    let revenueGrowth:Pct=null, earningsGrowth:Pct=null, grossMargins:Pct=null, operatingMargins:Pct=null
    let profitMargins:Pct=null, returnOnEquity:Pct=null, returnOnAssets:Pct=null
    let debtToEquity:Num=null, currentRatio:Num=null, quickRatio:Num=null
    let totalCash:Num=null, totalDebt:Num=null, freeCashflow:Num=null, operatingCashflow:Num=null
    let totalRevenue:Num=null, grossProfits:Num=null, ebitda:Num=null
    let description:string|null=null, sector:string|null=null, industry:string|null=null
    let employees:Num=null, website:string|null=null, country:string|null=null
    let nextEarningsDate:string|null=null

    const incomeAnnual:    IncomeRow[] = []
    const incomeQuarterly: IncomeRow[] = []
    const balanceAnnual:   BalanceRow[] = []
    const cashflowAnnual:  CashRow[]   = []
    const earningsHistory: EarningsRow[]  = []
    const earningsTrend:   EstimateRow[]  = []
    const recommendationTrend: RecRow[]   = []
    const upgradeDowngradeHistory: UpgradeRow[] = []
    const insiderTransactions:     InsiderRow[]  = []

    // Run both quoteSummary batches in parallel; failures are soft
    const [s1, s2] = await Promise.allSettled([
      yfGet(`${YF2}/v10/finance/quoteSummary/${encodeURIComponent(ticker)}?modules=price,summaryDetail,defaultKeyStatistics,financialData,assetProfile,calendarEvents,majorHoldersBreakdown`),
      yfGet(`${YF2}/v10/finance/quoteSummary/${encodeURIComponent(ticker)}?modules=incomeStatementHistory,incomeStatementHistoryQuarterly,balanceSheetHistory,cashflowStatementHistory,earningsHistory,earningsTrend,recommendationTrend,upgradeDowngradeHistory,insiderTransactions`),
    ])

    // ── Parse batch 1 ────────────────────────────────────────────────────────
    if (s1.status === 'fulfilled') {
      const s = s1.value?.quoteSummary?.result?.[0] ?? {}
      const p  = s.price               ?? {}
      const sd = s.summaryDetail        ?? {}
      const ks = s.defaultKeyStatistics ?? {}
      const fd = s.financialData        ?? {}
      const ap = s.assetProfile         ?? {}
      const ce = s.calendarEvents       ?? {}
      const mh = s.majorHoldersBreakdown ?? {}

      currentPrice  = r2(raw(p,  'regularMarketPrice')         ?? currentPrice)
      prevClose     = r2(raw(p,  'regularMarketPreviousClose')  ?? prevClose)
      marketCap     =    raw(p,  'marketCap')
      peRatio       = raw(sd, 'trailingPE')    != null ? Math.round(raw(sd,'trailingPE')!    * 10) / 10 : null
      dividendYield = raw(sd, 'dividendYield') != null ? raw(sd,'dividendYield')                        : null
      const h = raw(sd,'fiftyTwoWeekHigh') ?? raw(p,'fiftyTwoWeekHigh'); if (h) high52w = r2(h)
      const l = raw(sd,'fiftyTwoWeekLow')  ?? raw(p,'fiftyTwoWeekLow');  if (l) low52w  = r2(l)
      if (!high52w) high52w = r2(Math.max(...allCloses.slice(-252)))
      if (!low52w)  low52w  = r2(Math.min(...allCloses.slice(-252)))

      eps                  = raw(ks, 'trailingEps')        != null ? r2(raw(ks,'trailingEps')!)                   : null
      forwardEps           = raw(ks, 'forwardEps')         != null ? r2(raw(ks,'forwardEps')!)                    : null
      priceToBook          = raw(ks, 'priceToBook')        != null ? Math.round(raw(ks,'priceToBook')! * 100)/100  : null
      enterpriseValue      = raw(ks, 'enterpriseValue')
      enterpriseToRevenue  = raw(ks, 'enterpriseToRevenue') != null ? Math.round(raw(ks,'enterpriseToRevenue')!*100)/100 : null
      enterpriseToEbitda   = raw(ks, 'enterpriseToEbitda')  != null ? Math.round(raw(ks,'enterpriseToEbitda')!*100)/100  : null
      beta                 = raw(ks, 'beta')                != null ? Math.round(raw(ks,'beta')! * 100) / 100 : null
      shortRatio           = raw(ks, 'shortRatio')
      payoutRatio          = raw(ks, 'payoutRatio')
      bookValue            = raw(ks, 'bookValue')           != null ? r2(raw(ks,'bookValue')!) : null
      heldPercentInsiders  = raw(ks, 'heldPercentInsiders')      ?? raw(mh, 'insidersPercentHeld')
      heldPercentInstitutions = raw(ks,'heldPercentInstitutions') ?? raw(mh, 'institutionsPercentHeld')

      targetMeanPrice  = raw(fd,'targetMeanPrice')  != null ? r2(raw(fd,'targetMeanPrice')!)  : null
      targetHighPrice  = raw(fd,'targetHighPrice')  != null ? r2(raw(fd,'targetHighPrice')!)  : null
      targetLowPrice   = raw(fd,'targetLowPrice')   != null ? r2(raw(fd,'targetLowPrice')!)   : null
      numberOfAnalysts = raw(fd,'numberOfAnalystOpinions')
      recommendationKey  = (fd.recommendationKey   as string|undefined) ?? null
      recommendationMean = raw(fd,'recommendationMean')
      revenueGrowth      = raw(fd,'revenueGrowth')
      earningsGrowth     = raw(fd,'earningsGrowth')
      grossMargins       = raw(fd,'grossMargins')
      operatingMargins   = raw(fd,'operatingMargins')
      profitMargins      = raw(fd,'profitMargins')
      returnOnEquity     = raw(fd,'returnOnEquity')
      returnOnAssets     = raw(fd,'returnOnAssets')
      debtToEquity       = raw(fd,'debtToEquity')
      currentRatio       = raw(fd,'currentRatio')     != null ? Math.round(raw(fd,'currentRatio')! * 100)/100 : null
      quickRatio         = raw(fd,'quickRatio')       != null ? Math.round(raw(fd,'quickRatio')!   * 100)/100 : null
      totalCash          = raw(fd,'totalCash')
      totalDebt          = raw(fd,'totalDebt')
      freeCashflow       = raw(fd,'freeCashflow')
      operatingCashflow  = raw(fd,'operatingCashflow')
      totalRevenue       = raw(fd,'totalRevenue')
      grossProfits       = raw(fd,'grossProfits')
      ebitda             = raw(fd,'ebitda')

      description = (ap.longBusinessSummary as string|undefined) ?? null
      sector      = (ap.sector              as string|undefined) ?? null
      industry    = (ap.industry            as string|undefined) ?? null
      employees   = (ap.fullTimeEmployees   as number|undefined) ?? null
      website     = (ap.website             as string|undefined) ?? null
      country     = (ap.country             as string|undefined) ?? null

      const earningsDates = (ce.earnings as {earningsDate?: {raw?:number}[]}|undefined)?.earningsDate
      if (earningsDates?.length) nextEarningsDate = toIso(earningsDates[0].raw as number)
    }

    // ── Parse batch 2 ─────────────────────────────────────────────────────────
    if (s2.status === 'fulfilled') {
      const s = s2.value?.quoteSummary?.result?.[0] ?? {}

      // Income statements
      for (const stmt of (s.incomeStatementHistory?.incomeStatementHistory ?? [])) {
        incomeAnnual.push({ date: fmtDate(stmt.endDate), totalRevenue: raw(stmt,'totalRevenue'), grossProfit: raw(stmt,'grossProfit'), ebit: raw(stmt,'ebit'), netIncome: raw(stmt,'netIncome'), ebitda: raw(stmt,'ebitda'), totalOperatingExpenses: raw(stmt,'totalOperatingExpenses') })
      }
      for (const stmt of (s.incomeStatementHistoryQuarterly?.incomeStatementHistory ?? [])) {
        incomeQuarterly.push({ date: fmtDate(stmt.endDate), totalRevenue: raw(stmt,'totalRevenue'), grossProfit: raw(stmt,'grossProfit'), ebit: raw(stmt,'ebit'), netIncome: raw(stmt,'netIncome'), ebitda: raw(stmt,'ebitda'), totalOperatingExpenses: raw(stmt,'totalOperatingExpenses') })
      }

      // Balance sheets
      for (const stmt of (s.balanceSheetHistory?.balanceSheetStatements ?? [])) {
        balanceAnnual.push({ date: fmtDate(stmt.endDate), totalAssets: raw(stmt,'totalAssets'), totalLiab: raw(stmt,'totalLiab'), equity: raw(stmt,'totalStockholderEquity'), cash: raw(stmt,'cash'), shortDebt: raw(stmt,'shortLongTermDebt'), longDebt: raw(stmt,'longTermDebt') })
      }

      // Cash flows
      for (const stmt of (s.cashflowStatementHistory?.cashflowStatements ?? [])) {
        const opCF = raw(stmt,'totalCashFromOperatingActivities')
        const capex = raw(stmt,'capitalExpenditures')
        cashflowAnnual.push({ date: fmtDate(stmt.endDate), operatingCF: opCF, capex, freeCF: opCF != null && capex != null ? r2(opCF + capex) : null, investingCF: raw(stmt,'totalCashFromInvestingActivities'), financingCF: raw(stmt,'totalCashFromFinancingActivities') })
      }

      // Earnings history (EPS beats/misses)
      for (const e of (s.earningsHistory?.history ?? [])) {
        earningsHistory.push({ date: fmtDate(e.quarter ?? e.period), epsActual: raw(e,'epsActual'), epsEstimate: raw(e,'epsEstimate'), surprisePct: raw(e,'surprisePercent') })
      }

      // Forward estimates
      for (const t of (s.earningsTrend?.trend ?? [])) {
        earningsTrend.push({ period: (t.period as string) ?? '', endDate: (t.endDate as string) ?? '', epsEst: raw(t.earningsEstimate ?? {},'avg'), revEst: raw(t.revenueEstimate ?? {},'avg'), numAnalysts: raw(t.earningsEstimate ?? {},'numberOfAnalysts') })
      }

      // Analyst consensus
      for (const r of (s.recommendationTrend?.trend ?? [])) {
        recommendationTrend.push({ period: r.period as string, strongBuy: (r.strongBuy as number) ?? 0, buy: (r.buy as number) ?? 0, hold: (r.hold as number) ?? 0, sell: (r.sell as number) ?? 0, strongSell: (r.strongSell as number) ?? 0 })
      }

      // Upgrades/downgrades (last 15)
      for (const u of ((s.upgradeDowngradeHistory?.history ?? []) as unknown[]).slice(0, 15)) {
        const uu = u as Record<string,unknown>
        upgradeDowngradeHistory.push({ date: uu.epochGradeDate ? toIso(uu.epochGradeDate as number) : '', firm: (uu.firm as string) ?? '', toGrade: (uu.toGrade as string) ?? '', fromGrade: (uu.fromGrade as string) ?? '', action: (uu.action as string) ?? '' })
      }

      // Insider transactions (last 15)
      for (const tx of ((s.insiderTransactions?.transactions ?? []) as unknown[]).slice(0, 15)) {
        const t = tx as Record<string,unknown>
        insiderTransactions.push({ date: fmtDate(t.startDate), name: (t.filerName as string) ?? '', shares: raw(t as Record<string,unknown>,'shares'), value: raw(t as Record<string,unknown>,'value'), description: (t.transactionText as string) ?? '' })
      }
    }

    // ── News ──────────────────────────────────────────────────────────────────
    const news: StockResult['news'] = []
    try {
      const searchData = await yfGet(`${YF1}/v1/finance/search?q=${encodeURIComponent(ticker)}&newsCount=10&enableFuzzyQuery=false&quotesCount=0`)
      for (const item of (searchData?.news ?? []) as Record<string,unknown>[]) {
        const title = (item.title as string) ?? ''
        news.push({ title, source: (item.publisher as string) ?? 'Unknown', link: (item.link as string) ?? '#', publishedAt: item.providerPublishTime ? new Date((item.providerPublishTime as number) * 1000).toISOString() : new Date().toISOString(), sentiment: sentiment(title) })
      }
    } catch { /* news optional */ }

    // ── Assemble ──────────────────────────────────────────────────────────────
    const change        = r2(currentPrice - prevClose)
    const changePercent = prevClose > 0 ? Math.round((change / prevClose) * 10000) / 100 : 0

    // ── Nordic supplement (Avanza) — Swedish tickers only ──────────────────────
    // fetchAvanzaData never throws and self-times-out; on any problem it returns
    // null and we simply ship the Yahoo-only result, exactly as before.
    let avanza: AvanzaData | null = null
    if (isSwedishTicker(ticker)) {
      avanza = await fetchAvanzaData(ticker)
    }

    // Fill ONLY the gaps Yahoo left null. Yahoo values always win where present,
    // so existing behaviour is unchanged for tickers Yahoo covers fully.
    if (avanza) {
      if (peRatio       == null && avanza.peRatio        != null) peRatio       = Math.round(avanza.peRatio * 10) / 10
      if (dividendYield == null && avanza.directYield    != null) dividendYield = avanza.directYield
      if (marketCap     == null && avanza.marketCap      != null) marketCap     = avanza.marketCap
      if (eps           == null && avanza.eps            != null) eps           = avanza.eps
      if (bookValue     == null && avanza.equityPerShare != null) bookValue     = avanza.equityPerShare
      if (priceToBook   == null && avanza.pbRatio        != null) priceToBook   = avanza.pbRatio
      if (beta          == null && avanza.beta           != null) beta          = avanza.beta
      if (returnOnEquity   == null && avanza.returnOnEquity != null) returnOnEquity = avanza.returnOnEquity
      if (returnOnAssets   == null && avanza.returnOnAssets != null) returnOnAssets = avanza.returnOnAssets
      if (grossMargins     == null && avanza.grossMargin    != null) grossMargins     = avanza.grossMargin
      if (operatingMargins == null && avanza.operatingMargin!= null) operatingMargins = avanza.operatingMargin
      if (profitMargins    == null && avanza.netMargin      != null) profitMargins    = avanza.netMargin
      if (operatingCashflow== null && avanza.operatingCashFlow != null) operatingCashflow = avanza.operatingCashFlow
      if (nextEarningsDate == null && avanza.nextReportDate != null) nextEarningsDate = avanza.nextReportDate
      if (shortRatio       == null && avanza.shortSellingRatio != null) shortRatio = avanza.shortSellingRatio
    }

    const result: StockResult = {
      ticker, interval, currentPrice, change, changePercent,
      marketCap, peRatio, dividendYield, high52w, low52w, eps,
      forwardEps, priceToBook, enterpriseValue, enterpriseToRevenue, enterpriseToEbitda,
      beta, shortRatio, payoutRatio, bookValue, heldPercentInsiders, heldPercentInstitutions,
      targetMeanPrice, targetHighPrice, targetLowPrice, numberOfAnalysts,
      recommendationKey, recommendationMean,
      revenueGrowth, earningsGrowth, grossMargins, operatingMargins, profitMargins,
      returnOnEquity, returnOnAssets, debtToEquity, currentRatio, quickRatio,
      totalCash, totalDebt, freeCashflow, operatingCashflow, totalRevenue, grossProfits, ebitda,
      description, sector, industry, employees, website, country,
      nextEarningsDate,
      avanza,
      ohlcv, sma50, sma200,
      indicators: {
        rsi:           rsiRaw.length ? Math.round(rsiRaw[rsiRaw.length-1] * 10) / 10 : null,
        macd:          lm?.MACD      != null ? Math.round((lm.MACD      as number) * 10000) / 10000 : null,
        macdSignal:    lm?.signal    != null ? Math.round((lm.signal    as number) * 10000) / 10000 : null,
        macdHistogram: lm?.histogram != null ? Math.round((lm.histogram as number) * 10000) / 10000 : null,
        bbUpper:  lb?.upper  != null ? r2(lb.upper)  : null,
        bbMiddle: lb?.middle != null ? r2(lb.middle) : null,
        bbLower:  lb?.lower  != null ? r2(lb.lower)  : null,
        bbWidth:  lb?.upper != null && lb.lower != null && lb.middle && lb.middle > 0 ? Math.round(((lb.upper - lb.lower) / lb.middle) * 10000) / 100 : null,
      },
      incomeAnnual, incomeQuarterly, balanceAnnual, cashflowAnnual,
      earningsHistory, earningsTrend, recommendationTrend, upgradeDowngradeHistory,
      insiderTransactions, news,
    }

    // Cache
    try {
      await admin.from('stock_cache').upsert({ ticker, interval, data: result, fetched_at: new Date().toISOString() }, { onConflict: 'ticker,interval' })
    } catch { /* cache table not yet created */ }

    return NextResponse.json(result)

  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error('[/api/stocks]', msg)
    if (/404|not found|no data|no.*result/i.test(msg)) return NextResponse.json({ error: `Ticker "${ticker}" not found.` }, { status: 404 })
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
