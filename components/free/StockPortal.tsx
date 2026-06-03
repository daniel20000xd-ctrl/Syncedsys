'use client'

import { useState, useEffect, useRef, useCallback } from 'react'
import { Search, TrendingUp, TrendingDown, RefreshCw } from 'lucide-react'

// ── Full data type (mirrors StockResult in /api/stocks/route.ts) ──────────────

type Num = number | null
type Pct = number | null
type Interval = '1M' | '3M' | '6M' | '1Y'

interface OHLCVBar { time: string; open: number; high: number; low: number; close: number; volume: number }
interface IncomeRow  { date: string; totalRevenue: Num; grossProfit: Num; ebit: Num; netIncome: Num; ebitda: Num; totalOperatingExpenses: Num }
interface BalanceRow { date: string; totalAssets: Num; totalLiab: Num; equity: Num; cash: Num; shortDebt: Num; longDebt: Num }
interface CashRow    { date: string; operatingCF: Num; capex: Num; freeCF: Num; investingCF: Num; financingCF: Num }
interface EarningsRow { date: string; epsActual: Num; epsEstimate: Num; surprisePct: Num }
interface EstimateRow { period: string; endDate: string; epsEst: Num; revEst: Num; numAnalysts: Num }
interface RecRow      { period: string; strongBuy: number; buy: number; hold: number; sell: number; strongSell: number }
interface UpgradeRow  { date: string; firm: string; toGrade: string; fromGrade: string; action: string }
interface InsiderRow  { date: string; name: string; shares: Num; value: Num; description: string }

interface StockData {
  ticker: string; interval: string
  currentPrice: number; change: number; changePercent: number
  marketCap: Num; peRatio: Num; dividendYield: Pct; high52w: Num; low52w: Num; eps: Num
  forwardEps: Num; priceToBook: Num; enterpriseValue: Num; enterpriseToRevenue: Num
  enterpriseToEbitda: Num; beta: Num; shortRatio: Num; payoutRatio: Pct
  bookValue: Num; heldPercentInsiders: Pct; heldPercentInstitutions: Pct
  targetMeanPrice: Num; targetHighPrice: Num; targetLowPrice: Num; numberOfAnalysts: Num
  recommendationKey: string | null; recommendationMean: Num
  revenueGrowth: Pct; earningsGrowth: Pct; grossMargins: Pct; operatingMargins: Pct
  profitMargins: Pct; returnOnEquity: Pct; returnOnAssets: Pct
  debtToEquity: Num; currentRatio: Num; quickRatio: Num
  totalCash: Num; totalDebt: Num; freeCashflow: Num; operatingCashflow: Num
  totalRevenue: Num; grossProfits: Num; ebitda: Num
  description: string | null; sector: string | null; industry: string | null
  employees: Num; website: string | null; country: string | null
  nextEarningsDate: string | null
  ohlcv: OHLCVBar[]
  sma50: { time: string; value: number }[]
  sma200: { time: string; value: number }[]
  indicators: { rsi: Num; macd: Num; macdSignal: Num; macdHistogram: Num; bbUpper: Num; bbMiddle: Num; bbLower: Num; bbWidth: Num }
  incomeAnnual: IncomeRow[]; incomeQuarterly: IncomeRow[]
  balanceAnnual: BalanceRow[]; cashflowAnnual: CashRow[]
  earningsHistory: EarningsRow[]; earningsTrend: EstimateRow[]
  recommendationTrend: RecRow[]; upgradeDowngradeHistory: UpgradeRow[]
  insiderTransactions: InsiderRow[]
  news: Array<{ title: string; source: string; link: string; publishedAt: string; sentiment: 'positive' | 'negative' | 'neutral' | null }>
}

interface Props {
  config: { ticker?: string; interval?: string }
  onPersistConfig: (c: { ticker: string; interval: string }) => void
  onUpdateContext?: (ctx: string) => void
}

// ── Context builder — zero information loss ───────────────────────────────────

function fmtB(n: Num): string {
  if (n == null) return 'N/A'
  const abs = Math.abs(n)
  if (abs >= 1e12) return `$${(n / 1e12).toFixed(3)}T`
  if (abs >= 1e9)  return `$${(n / 1e9).toFixed(2)}B`
  if (abs >= 1e6)  return `$${(n / 1e6).toFixed(2)}M`
  if (abs >= 1e3)  return `$${(n / 1e3).toFixed(1)}K`
  return `$${n.toFixed(2)}`
}
function fmtPct(n: Pct, stored01 = true): string {
  if (n == null) return 'N/A'
  return `${(stored01 ? n * 100 : n).toFixed(2)}%`
}
function fmtN(n: Num, dp = 2): string { return n == null ? 'N/A' : n.toFixed(dp) }
function fmtVol(v: number): string {
  if (v >= 1e9) return `${(v / 1e9).toFixed(2)}B`
  if (v >= 1e6) return `${(v / 1e6).toFixed(2)}M`
  if (v >= 1e3) return `${(v / 1e3).toFixed(0)}K`
  return String(v)
}
function sign(n: number) { return n >= 0 ? `+${n}` : String(n) }

function buildViewerContext(d: StockData): string {
  const lines: string[] = []
  const h = (t: string) => { lines.push(''); lines.push(t); lines.push('─'.repeat(t.length)) }

  lines.push(`=== STOCK VIEWER: ${d.ticker} (${d.interval}) ===`)
  lines.push(`Updated: ${new Date().toUTCString()}`)

  // ── Price ──────────────────────────────────────────────────────────────────
  h('CURRENT PRICE')
  lines.push(`  ${d.ticker}  $${d.currentPrice.toFixed(2)}  (${sign(d.change)} / ${sign(d.changePercent)}%)`)
  if (d.sector)  lines.push(`  Sector: ${d.sector}  |  Industry: ${d.industry ?? 'N/A'}`)
  if (d.country) lines.push(`  Country: ${d.country}${d.employees ? `  |  Employees: ${d.employees.toLocaleString()}` : ''}`)
  if (d.website) lines.push(`  Website: ${d.website}`)

  // ── Company description ────────────────────────────────────────────────────
  if (d.description) {
    h('COMPANY OVERVIEW')
    // Wrap long description at ~100 chars
    const words = d.description.split(' ')
    let line = '  '
    for (const w of words) {
      if ((line + w).length > 100) { lines.push(line); line = '  ' + w + ' ' }
      else line += w + ' '
    }
    if (line.trim()) lines.push(line)
  }

  // ── Valuation / fundamentals ───────────────────────────────────────────────
  h('VALUATION & FUNDAMENTALS')
  lines.push(`  Market Cap:              ${fmtB(d.marketCap)}`)
  lines.push(`  Enterprise Value:        ${fmtB(d.enterpriseValue)}`)
  lines.push(`  Trailing P/E:            ${fmtN(d.peRatio, 1)}×`)
  lines.push(`  Forward P/E:             ${d.forwardEps && d.currentPrice ? fmtN(d.currentPrice / d.forwardEps, 1) + '×' : 'N/A'}`)
  lines.push(`  Price/Book:              ${fmtN(d.priceToBook, 2)}×`)
  lines.push(`  EV/Revenue:              ${fmtN(d.enterpriseToRevenue, 2)}×`)
  lines.push(`  EV/EBITDA:               ${fmtN(d.enterpriseToEbitda, 2)}×`)
  lines.push(`  Trailing EPS:            ${d.eps != null ? `$${d.eps}` : 'N/A'}`)
  lines.push(`  Forward EPS:             ${d.forwardEps != null ? `$${d.forwardEps}` : 'N/A'}`)
  lines.push(`  Book Value/Share:        ${d.bookValue != null ? `$${d.bookValue}` : 'N/A'}`)
  lines.push(`  Dividend Yield:          ${fmtPct(d.dividendYield)}`)
  lines.push(`  Payout Ratio:            ${fmtPct(d.payoutRatio)}`)
  lines.push(`  Beta:                    ${fmtN(d.beta, 2)}`)
  lines.push(`  Short Ratio:             ${fmtN(d.shortRatio, 1)}`)
  lines.push(`  52-Week High:            ${d.high52w != null ? `$${d.high52w.toFixed(2)}` : 'N/A'}`)
  lines.push(`  52-Week Low:             ${d.low52w  != null ? `$${d.low52w.toFixed(2)}`  : 'N/A'}`)
  if (d.nextEarningsDate) lines.push(`  Next Earnings Date:      ${d.nextEarningsDate}`)

  // ── Analyst / price targets ────────────────────────────────────────────────
  if (d.targetMeanPrice || d.recommendationKey) {
    h('ANALYST CONSENSUS')
    lines.push(`  Recommendation:          ${(d.recommendationKey ?? 'N/A').toUpperCase()}  (mean score ${fmtN(d.recommendationMean, 1)} / 5)`)
    lines.push(`  # of Analysts:           ${d.numberOfAnalysts ?? 'N/A'}`)
    lines.push(`  Target Price (mean):     ${d.targetMeanPrice != null ? `$${d.targetMeanPrice.toFixed(2)}` : 'N/A'}`)
    lines.push(`  Target Price (high):     ${d.targetHighPrice != null ? `$${d.targetHighPrice.toFixed(2)}` : 'N/A'}`)
    lines.push(`  Target Price (low):      ${d.targetLowPrice  != null ? `$${d.targetLowPrice.toFixed(2)}`  : 'N/A'}`)
    if (d.targetMeanPrice && d.currentPrice) {
      const upside = ((d.targetMeanPrice - d.currentPrice) / d.currentPrice * 100).toFixed(1)
      lines.push(`  Implied Upside (mean):   ${upside}%`)
    }
  }

  // ── Profitability / margins ────────────────────────────────────────────────
  h('PROFITABILITY & MARGINS')
  lines.push(`  Gross Margin:            ${fmtPct(d.grossMargins)}`)
  lines.push(`  Operating Margin:        ${fmtPct(d.operatingMargins)}`)
  lines.push(`  Profit Margin:           ${fmtPct(d.profitMargins)}`)
  lines.push(`  Return on Equity (ROE):  ${fmtPct(d.returnOnEquity)}`)
  lines.push(`  Return on Assets (ROA):  ${fmtPct(d.returnOnAssets)}`)
  lines.push(`  Revenue Growth (YoY):    ${fmtPct(d.revenueGrowth)}`)
  lines.push(`  Earnings Growth (YoY):   ${fmtPct(d.earningsGrowth)}`)

  // ── Financial health ───────────────────────────────────────────────────────
  h('FINANCIAL HEALTH')
  lines.push(`  Total Revenue:           ${fmtB(d.totalRevenue)}`)
  lines.push(`  Gross Profit:            ${fmtB(d.grossProfits)}`)
  lines.push(`  EBITDA:                  ${fmtB(d.ebitda)}`)
  lines.push(`  Total Cash:              ${fmtB(d.totalCash)}`)
  lines.push(`  Total Debt:              ${fmtB(d.totalDebt)}`)
  if (d.totalCash != null && d.totalDebt != null) lines.push(`  Net Cash / (Debt):       ${fmtB(d.totalCash - d.totalDebt)}`)
  lines.push(`  Free Cash Flow:          ${fmtB(d.freeCashflow)}`)
  lines.push(`  Operating Cash Flow:     ${fmtB(d.operatingCashflow)}`)
  lines.push(`  Debt/Equity:             ${fmtN(d.debtToEquity, 2)}`)
  lines.push(`  Current Ratio:           ${fmtN(d.currentRatio, 2)}`)
  lines.push(`  Quick Ratio:             ${fmtN(d.quickRatio, 2)}`)

  // ── Ownership ─────────────────────────────────────────────────────────────
  if (d.heldPercentInsiders != null || d.heldPercentInstitutions != null) {
    h('OWNERSHIP')
    lines.push(`  Insider Ownership:       ${fmtPct(d.heldPercentInsiders)}`)
    lines.push(`  Institutional Ownership: ${fmtPct(d.heldPercentInstitutions)}`)
  }

  // ── Technical indicators ───────────────────────────────────────────────────
  h('TECHNICAL INDICATORS')
  const ind = d.indicators
  if (ind.rsi != null) {
    const lbl = ind.rsi > 70 ? 'OVERBOUGHT' : ind.rsi < 30 ? 'OVERSOLD' : 'neutral'
    lines.push(`  RSI(14):             ${ind.rsi}  [${lbl}]`)
  }
  if (ind.macd != null) {
    lines.push(`  MACD(12/26/9):       ${sign(ind.macd)}`)
    lines.push(`  MACD Signal:         ${ind.macdSignal != null ? sign(ind.macdSignal) : 'N/A'}`)
    lines.push(`  MACD Histogram:      ${ind.macdHistogram != null ? sign(ind.macdHistogram) : 'N/A'}`)
  }
  if (ind.bbUpper != null) {
    lines.push(`  Bollinger Upper(20): $${ind.bbUpper.toFixed(2)}`)
    lines.push(`  Bollinger Mid:       ${ind.bbMiddle != null ? `$${ind.bbMiddle.toFixed(2)}` : 'N/A'}`)
    lines.push(`  Bollinger Lower:     ${ind.bbLower  != null ? `$${ind.bbLower.toFixed(2)}`  : 'N/A'}`)
    lines.push(`  BB Width:            ${ind.bbWidth  != null ? `${ind.bbWidth.toFixed(2)}%`  : 'N/A'}`)
  }
  if (d.sma50.length)  lines.push(`  SMA50 (latest):      $${d.sma50[d.sma50.length-1].value.toFixed(2)}`)
  if (d.sma200.length) lines.push(`  SMA200 (latest):     $${d.sma200[d.sma200.length-1].value.toFixed(2)}`)

  // ── Analyst recommendation trend ──────────────────────────────────────────
  if (d.recommendationTrend.length) {
    h('ANALYST RECOMMENDATION TREND')
    lines.push('  Period   StrongBuy  Buy  Hold  Sell  StrongSell')
    for (const r of d.recommendationTrend) {
      lines.push(`  ${r.period.padEnd(8)} ${String(r.strongBuy).padStart(9)} ${String(r.buy).padStart(4)} ${String(r.hold).padStart(5)} ${String(r.sell).padStart(5)} ${String(r.strongSell).padStart(10)}`)
    }
  }

  // ── Upgrades / downgrades ─────────────────────────────────────────────────
  if (d.upgradeDowngradeHistory.length) {
    h('RECENT ANALYST ACTIONS (last 15)')
    for (const u of d.upgradeDowngradeHistory) {
      const from = u.fromGrade ? ` from ${u.fromGrade}` : ''
      lines.push(`  ${u.date}  ${u.firm.padEnd(28)} ${u.action.padEnd(10)} → ${u.toGrade}${from}`)
    }
  }

  // ── Earnings history ──────────────────────────────────────────────────────
  if (d.earningsHistory.length) {
    h('EARNINGS HISTORY (EPS actual vs estimate)')
    lines.push('  Quarter      Actual   Estimate  Surprise')
    for (const e of d.earningsHistory) {
      const act  = e.epsActual   != null ? `$${e.epsActual.toFixed(2)}`   : 'N/A'
      const est  = e.epsEstimate != null ? `$${e.epsEstimate.toFixed(2)}` : 'N/A'
      const surp = e.surprisePct != null ? `${(e.surprisePct * 100).toFixed(1)}%` : 'N/A'
      lines.push(`  ${e.date.padEnd(12)} ${act.padStart(7)}  ${est.padStart(8)}  ${surp.padStart(8)}`)
    }
  }

  // ── Forward estimates ─────────────────────────────────────────────────────
  if (d.earningsTrend.length) {
    h('FORWARD EPS & REVENUE ESTIMATES')
    lines.push('  Period    End Date     EPS Est   Rev Est      Analysts')
    for (const t of d.earningsTrend) {
      const epsE = t.epsEst != null ? `$${t.epsEst.toFixed(2)}`      : 'N/A'
      const revE = t.revEst != null ? fmtB(t.revEst).replace('$','') : 'N/A'
      lines.push(`  ${t.period.padEnd(9)} ${t.endDate.padEnd(12)} ${epsE.padStart(8)}  ${revE.padStart(11)}  ${t.numAnalysts ?? 'N/A'}`)
    }
  }

  // ── Income statements ────────────────────────────────────────────────────
  if (d.incomeAnnual.length) {
    h('ANNUAL INCOME STATEMENTS')
    lines.push('  Fiscal Year   Revenue        Gross Profit    EBIT           Net Income     EBITDA')
    for (const s of d.incomeAnnual) {
      lines.push(`  ${s.date.padEnd(13)} ${fmtB(s.totalRevenue).padStart(14)} ${fmtB(s.grossProfit).padStart(15)} ${fmtB(s.ebit).padStart(14)} ${fmtB(s.netIncome).padStart(14)} ${fmtB(s.ebitda).padStart(9)}`)
    }
  }
  if (d.incomeQuarterly.length) {
    h('QUARTERLY INCOME STATEMENTS (last 4)')
    lines.push('  Quarter       Revenue        Gross Profit    Net Income')
    for (const s of d.incomeQuarterly) {
      lines.push(`  ${s.date.padEnd(13)} ${fmtB(s.totalRevenue).padStart(14)} ${fmtB(s.grossProfit).padStart(15)} ${fmtB(s.netIncome).padStart(14)}`)
    }
  }

  // ── Balance sheet ─────────────────────────────────────────────────────────
  if (d.balanceAnnual.length) {
    h('ANNUAL BALANCE SHEETS')
    lines.push('  Fiscal Year   Total Assets   Total Liab     Equity         Cash           Long-Term Debt')
    for (const s of d.balanceAnnual) {
      lines.push(`  ${s.date.padEnd(13)} ${fmtB(s.totalAssets).padStart(14)} ${fmtB(s.totalLiab).padStart(14)} ${fmtB(s.equity).padStart(14)} ${fmtB(s.cash).padStart(14)} ${fmtB(s.longDebt).padStart(14)}`)
    }
  }

  // ── Cash flow ─────────────────────────────────────────────────────────────
  if (d.cashflowAnnual.length) {
    h('ANNUAL CASH FLOW STATEMENTS')
    lines.push('  Fiscal Year   Operating CF   CapEx          Free CF        Investing CF   Financing CF')
    for (const s of d.cashflowAnnual) {
      lines.push(`  ${s.date.padEnd(13)} ${fmtB(s.operatingCF).padStart(14)} ${fmtB(s.capex).padStart(14)} ${fmtB(s.freeCF).padStart(14)} ${fmtB(s.investingCF).padStart(14)} ${fmtB(s.financingCF).padStart(14)}`)
    }
  }

  // ── Insider transactions ──────────────────────────────────────────────────
  if (d.insiderTransactions.length) {
    h('RECENT INSIDER TRANSACTIONS (last 15)')
    for (const t of d.insiderTransactions) {
      const shares = t.shares != null ? `${t.shares.toLocaleString()} shares` : ''
      const val    = t.value  != null ? ` (${fmtB(t.value)})` : ''
      lines.push(`  ${t.date}  ${t.name.padEnd(30)} ${shares}${val}`)
      if (t.description) lines.push(`            ${t.description}`)
    }
  }

  // ── Full OHLCV price history ──────────────────────────────────────────────
  h(`PRICE HISTORY — ${d.ohlcv.length} trading days (${d.ohlcv[0]?.time ?? ''} → ${d.ohlcv[d.ohlcv.length-1]?.time ?? ''})`)
  lines.push('  Date          Open       High       Low        Close      Volume')
  for (const b of d.ohlcv) {
    lines.push(`  ${b.time}  ${b.open.toFixed(2).padStart(9)}  ${b.high.toFixed(2).padStart(9)}  ${b.low.toFixed(2).padStart(9)}  ${b.close.toFixed(2).padStart(9)}  ${fmtVol(b.volume).padStart(8)}`)
  }

  // ── News ──────────────────────────────────────────────────────────────────
  if (d.news.length) {
    h(`NEWS (${d.news.length} latest)`)
    d.news.forEach((item, i) => {
      const sTag = item.sentiment === 'positive' ? '▲ POSITIVE' : item.sentiment === 'negative' ? '▼ NEGATIVE' : '● neutral'
      const pub  = (() => { try { return new Date(item.publishedAt).toUTCString() } catch { return item.publishedAt } })()
      lines.push(`  ${i+1}. [${sTag}] ${item.title}`)
      lines.push(`     ${item.source}  |  ${pub}`)
      lines.push(`     ${item.link}`)
    })
  }

  return lines.join('\n')
}

// ── Component ─────────────────────────────────────────────────────────────────

export default function StockPortal({ config, onPersistConfig, onUpdateContext }: Props) {
  const [tickerInput, setTickerInput]   = useState(config.ticker ?? '')
  const [activeTicker, setActiveTicker] = useState(config.ticker ?? '')
  const [interval, setIntervalState]    = useState<Interval>((config.interval as Interval) ?? '1Y')
  const [stockData, setStockData]       = useState<StockData | null>(null)
  const [loading, setLoading]           = useState(false)
  const [error, setError]               = useState<string | null>(null)

  const chartRef         = useRef<HTMLDivElement>(null)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const chartInstanceRef = useRef<any>(null)

  const fetchStock = useCallback(async (ticker: string, intv: Interval) => {
    if (!ticker) return
    setLoading(true); setError(null)
    try {
      const res  = await fetch(`/api/stocks?ticker=${encodeURIComponent(ticker)}&interval=${intv}`)
      const json = await res.json()
      if (!res.ok) { setError(json.error ?? 'Error'); setStockData(null) }
      else {
        const data = json as StockData
        setStockData(data)
        onUpdateContext?.(buildViewerContext(data))
      }
    } catch (e) { setError(e instanceof Error ? e.message : 'Error'); setStockData(null) }
    finally { setLoading(false) }
  }, [onUpdateContext])

  useEffect(() => {
    if (config.ticker) fetchStock(config.ticker, (config.interval as Interval) ?? '1Y')
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  function handleSearch(e?: React.FormEvent) {
    e?.preventDefault()
    const t = tickerInput.trim().toUpperCase()
    if (!t) return
    setActiveTicker(t)
    fetchStock(t, interval)
    onPersistConfig({ ticker: t, interval })
  }

  function handleInterval(intv: Interval) {
    setIntervalState(intv)
    if (activeTicker) { fetchStock(activeTicker, intv); onPersistConfig({ ticker: activeTicker, interval: intv }) }
  }

  // ── Chart ──────────────────────────────────────────────────────────────────
  useEffect(() => {
    if (!chartRef.current || !stockData) return
    const container = chartRef.current
    let destroyed = false

    if (chartInstanceRef.current) { chartInstanceRef.current.__ro?.disconnect(); chartInstanceRef.current.remove(); chartInstanceRef.current = null }

    import('lightweight-charts').then(({ createChart, ColorType }) => {
      if (destroyed || !container) return
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const chart: any = createChart(container, {
        layout: { background: { type: ColorType.Solid, color: '#0f1117' }, textColor: '#6B7280', fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif' },
        grid: { vertLines: { color: 'rgba(255,255,255,0.03)' }, horzLines: { color: 'rgba(255,255,255,0.03)' } },
        width: container.clientWidth, height: container.clientHeight || 180,
        rightPriceScale: { borderColor: 'rgba(255,255,255,0.06)' },
        timeScale: { borderColor: 'rgba(255,255,255,0.06)', visible: false },
        crosshair: { vertLine: { color: 'rgba(255,255,255,0.15)', labelBackgroundColor: '#1F2937' }, horzLine: { color: 'rgba(255,255,255,0.15)', labelBackgroundColor: '#1F2937' } },
      })
      chartInstanceRef.current = chart

      chart.addCandlestickSeries({ upColor: '#1D9E75', downColor: '#D85A30', borderUpColor: '#1D9E75', borderDownColor: '#D85A30', wickUpColor: '#1D9E75', wickDownColor: '#D85A30' }).setData(stockData!.ohlcv)
      chart.priceScale('volume').applyOptions({ scaleMargins: { top: 0.85, bottom: 0 }, visible: false })
      chart.addHistogramSeries({ priceFormat: { type: 'volume' }, priceScaleId: 'volume' })
        .setData(stockData!.ohlcv.map((b: OHLCVBar) => ({ time: b.time, value: b.volume, color: b.close >= b.open ? 'rgba(29,158,117,0.28)' : 'rgba(216,90,48,0.28)' })))
      if (stockData!.sma50.length)  chart.addLineSeries({ color: '#3B82F6', lineWidth: 1, priceLineVisible: false, lastValueVisible: false }).setData(stockData!.sma50)
      if (stockData!.sma200.length) chart.addLineSeries({ color: '#F59E0B', lineWidth: 1, priceLineVisible: false, lastValueVisible: false }).setData(stockData!.sma200)
      chart.timeScale().fitContent()

      const ro = new ResizeObserver(() => { if (!destroyed && container) chart.applyOptions({ width: container.clientWidth, height: container.clientHeight }) })
      ro.observe(container); chart.__ro = ro
    })

    return () => { destroyed = true; if (chartInstanceRef.current) { chartInstanceRef.current.__ro?.disconnect(); chartInstanceRef.current.remove(); chartInstanceRef.current = null } }
  }, [stockData])

  const isUp = (stockData?.changePercent ?? 0) >= 0
  const rsi  = stockData?.indicators.rsi
  const rsiCls = rsi != null ? (rsi > 70 ? 'text-red-400' : rsi < 30 ? 'text-green-400' : 'text-gray-500') : ''
  const macd = stockData?.indicators.macd

  return (
    <div className="nodrag nowheel absolute inset-0 pt-6 bg-[#0f1117] flex flex-col overflow-hidden" onPointerDown={e => e.stopPropagation()}>
      <form onSubmit={handleSearch} className="flex gap-1 px-1.5 pt-1 pb-0.5 shrink-0">
        <input value={tickerInput} onChange={e => setTickerInput(e.target.value.toUpperCase())} placeholder="AAPL, ERIC-B.ST…" className="nodrag flex-1 bg-white/10 text-white text-[11px] px-2 py-1 rounded font-mono placeholder:text-white/25 focus:outline-none focus:bg-white/15" onPointerDown={e => e.stopPropagation()} />
        <button type="submit" disabled={loading || !tickerInput.trim()} className="nodrag bg-white/10 hover:bg-white/20 text-white/60 px-2 py-1 rounded disabled:opacity-40 flex items-center">
          {loading ? <RefreshCw size={11} className="animate-spin" /> : <Search size={11} />}
        </button>
      </form>

      {error && <p className="px-2 py-0.5 text-[10px] text-red-400 shrink-0 truncate">{error}</p>}

      {stockData && (
        <>
          <div className="flex items-center gap-1.5 px-2 py-0.5 shrink-0 flex-wrap">
            <span className="text-white/50 text-[10px] font-mono">{stockData.ticker}</span>
            <span className="text-white text-sm font-bold tabular-nums">${stockData.currentPrice.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>
            <span className={`flex items-center gap-0.5 text-[10px] font-semibold ${isUp ? 'text-green-400' : 'text-red-400'}`}>
              {isUp ? <TrendingUp size={9} /> : <TrendingDown size={9} />}
              {isUp ? '+' : ''}{stockData.changePercent.toFixed(2)}%
            </span>
            {rsi  != null && <span className={`text-[9px] font-medium ml-auto ${rsiCls}`}>RSI {rsi}</span>}
            {macd != null && <span className={`text-[9px] font-medium ${macd >= 0 ? 'text-green-500' : 'text-red-400'}`}>MACD {macd >= 0 ? '+' : ''}{macd}</span>}
          </div>
          <div className="flex items-center gap-0.5 px-1.5 pb-0.5 shrink-0">
            {(['1M', '3M', '6M', '1Y'] as Interval[]).map(intv => (
              <button key={intv} onClick={() => handleInterval(intv)} className={`nodrag px-1.5 py-0.5 rounded text-[10px] font-medium transition-colors ${interval === intv ? 'bg-white/15 text-white' : 'text-gray-600 hover:text-gray-300 hover:bg-white/10'}`}>{intv}</button>
            ))}
            <div className="ml-auto flex items-center gap-2 pr-0.5">
              <span className="flex items-center gap-0.5 text-[9px] text-gray-600"><span className="w-2 h-px bg-[#3B82F6] inline-block" />50</span>
              <span className="flex items-center gap-0.5 text-[9px] text-gray-600"><span className="w-2 h-px bg-[#F59E0B] inline-block" />200</span>
            </div>
          </div>
        </>
      )}

      <div ref={chartRef} className="flex-1 min-h-0" />

      {!stockData && !loading && !error && (
        <div className="flex-1 flex items-center justify-center pb-2">
          <p className="text-white/20 text-[11px] text-center px-3 leading-5">Enter a ticker above<br /><span className="text-[9px] text-white/10">e.g. AAPL · TSLA · ERIC-B.ST</span></p>
        </div>
      )}
    </div>
  )
}
