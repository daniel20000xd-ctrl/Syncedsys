'use client'

import { useState, useEffect, useRef, useCallback } from 'react'
import { createChart, ColorType } from 'lightweight-charts'
import type { IChartApi } from 'lightweight-charts'
import {
  Search, TrendingUp, TrendingDown, BarChart2,
  BookOpen, Newspaper, RefreshCw, ExternalLink,
} from 'lucide-react'

// ── Types ──────────────────────────────────────────────────────────────────────

type Interval = '1M' | '3M' | '6M' | '1Y'

interface OHLCVBar {
  time: string
  open: number
  high: number
  low: number
  close: number
  volume: number
}

type Num = number | null
type Pct = number | null

interface IncomeRow  { date: string; totalRevenue: Num; grossProfit: Num; ebit: Num; netIncome: Num; ebitda: Num; totalOperatingExpenses: Num }
interface BalanceRow { date: string; totalAssets: Num; totalLiab: Num; equity: Num; cash: Num; shortDebt: Num; longDebt: Num }
interface CashRow    { date: string; operatingCF: Num; capex: Num; freeCF: Num; investingCF: Num; financingCF: Num }
interface EarningsRow { date: string; epsActual: Num; epsEstimate: Num; surprisePct: Num }
interface EstimateRow { period: string; endDate: string; epsEst: Num; revEst: Num; numAnalysts: Num }
interface RecRow      { period: string; strongBuy: number; buy: number; hold: number; sell: number; strongSell: number }
interface UpgradeRow  { date: string; firm: string; toGrade: string; fromGrade: string; action: string }
interface InsiderRow  { date: string; name: string; shares: Num; value: Num; description: string }
interface AvanzaData {
  orderBookId: string; name: string | null; marketList: string | null; currency: string | null
  peRatio: Num; psRatio: Num; pbRatio: Num; evEbit: Num
  directYield: Num; beta: Num; volatility: Num
  returnOnEquity: Num; returnOnAssets: Num; returnOnCapitalEmployed: Num; equityRatio: Num
  grossMargin: Num; operatingMargin: Num; netMargin: Num
  marketCap: Num; eps: Num; equityPerShare: Num; operatingCashFlow: Num
  numberOfOwners: Num; shortSellingRatio: Num
  dividendAmount: Num; dividendExDate: string | null; dividendsPerYear: Num
  nextReportDate: string | null; nextReportType: string | null; previousReportDate: string | null
}

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
  avanza: AvanzaData | null
  news: Array<{ title: string; source: string; link: string; publishedAt: string; sentiment: 'positive' | 'negative' | 'neutral' | null }>
}

// ── Formatters ────────────────────────────────────────────────────────────────

function fmtCap(n: number | null): string {
  if (n == null) return '—'
  if (n >= 1e12) return `$${(n / 1e12).toFixed(2)}T`
  if (n >= 1e9)  return `$${(n / 1e9).toFixed(2)}B`
  if (n >= 1e6)  return `$${(n / 1e6).toFixed(2)}M`
  return `$${n.toLocaleString()}`
}

function fmtPrice(n: number): string {
  return n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

function fmtDate(iso: string): string {
  try { return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) }
  catch { return iso }
}
function fmtNum(n: Num, dp = 2, prefix = ''): string {
  return n == null ? '—' : `${prefix}${n.toFixed(dp)}`
}
function fmtPct(n: Pct, stored01 = true): string {
  return n == null ? '—' : `${(stored01 ? n * 100 : n).toFixed(1)}%`
}
function fmtB(n: Num): string {
  if (n == null) return '—'
  const a = Math.abs(n)
  if (a >= 1e12) return `$${(n / 1e12).toFixed(2)}T`
  if (a >= 1e9)  return `$${(n / 1e9).toFixed(2)}B`
  if (a >= 1e6)  return `$${(n / 1e6).toFixed(2)}M`
  if (a >= 1e3)  return `$${(n / 1e3).toFixed(1)}K`
  return `$${n.toFixed(2)}`
}

function SectionCard({ title, icon, children }: { title: string; icon: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="bg-white rounded-xl p-5 shadow-sm">
      <h2 className="font-semibold text-gray-800 mb-3 flex items-center gap-2 text-sm">{icon}{title}</h2>
      {children}
    </div>
  )
}
function Grid({ items }: { items: { label: string; value: string }[] }) {
  return (
    <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
      {items.map(({ label, value }) => (
        <div key={label} className="border border-gray-100 rounded-lg px-3 py-2.5">
          <p className="text-[10px] text-gray-400 mb-0.5">{label}</p>
          <p className="text-sm font-bold text-gray-800">{value}</p>
        </div>
      ))}
    </div>
  )
}
function TableSection({ cols, rows }: { cols: string[]; rows: (string | null)[][] }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-xs">
        <thead>
          <tr className="border-b border-gray-100">
            {cols.map(c => <th key={c} className="text-left text-gray-400 font-medium pb-1.5 pr-4 whitespace-nowrap">{c}</th>)}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr key={i} className="border-b border-gray-50 last:border-0">
              {row.map((cell, j) => (
                <td key={j} className="py-1.5 pr-4 text-gray-700 whitespace-nowrap font-mono tabular-nums">{cell ?? '—'}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

// ── Stat card ─────────────────────────────────────────────────────────────────

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="bg-gray-50 rounded-lg px-3 py-2.5">
      <p className="text-[10px] font-semibold text-gray-400 uppercase tracking-wider mb-0.5">{label}</p>
      <p className="text-sm font-bold text-gray-800">{value}</p>
    </div>
  )
}

// ── Main component ────────────────────────────────────────────────────────────

export default function StockViewer() {
  const [tickerInput, setTickerInput] = useState('')
  const [activeTicker, setActiveTicker] = useState('')
  const [interval, setIntervalState] = useState<Interval>('1Y')
  const [stockData, setStockData] = useState<StockData | null>(null)
  const [loading, setLoading]     = useState(false)
  const [error, setError]         = useState<string | null>(null)

  const chartContainerRef = useRef<HTMLDivElement>(null)
  const chartInstanceRef  = useRef<IChartApi | null>(null)

  // ── Fetch ──────────────────────────────────────────────────────────────────

  const fetchStock = useCallback(async (ticker: string, intv: Interval) => {
    if (!ticker) return
    setLoading(true)
    setError(null)
    try {
      const res  = await fetch(`/api/stocks?ticker=${encodeURIComponent(ticker)}&interval=${intv}`)
      const json = await res.json() as StockData & { error?: string }
      if (!res.ok) {
        setError(json.error ?? 'Failed to fetch stock data')
        setStockData(null)
      } else {
        setStockData(json)
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Network error')
      setStockData(null)
    } finally {
      setLoading(false)
    }
  }, [])

  function handleSearch(e?: React.FormEvent) {
    e?.preventDefault()
    const t = tickerInput.trim().toUpperCase()
    if (!t) return
    setActiveTicker(t)
    fetchStock(t, interval)
  }

  function handleInterval(intv: Interval) {
    setIntervalState(intv)
    if (activeTicker) fetchStock(activeTicker, intv)
  }

  // ── Chart ──────────────────────────────────────────────────────────────────

  useEffect(() => {
    if (!chartContainerRef.current || !stockData) return

    const container = chartContainerRef.current

    // Tear down previous instance
    chartInstanceRef.current?.remove()
    chartInstanceRef.current = null

    const chart = createChart(container, {
      layout: {
        background: { type: ColorType.Solid, color: '#0f1117' },
        textColor: '#9CA3AF',
        fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
      },
      grid: {
        vertLines: { color: 'rgba(255,255,255,0.04)' },
        horzLines: { color: 'rgba(255,255,255,0.04)' },
      },
      width:  container.clientWidth,
      height: container.clientHeight || 420,
      rightPriceScale: { borderColor: 'rgba(255,255,255,0.08)' },
      timeScale: {
        borderColor: 'rgba(255,255,255,0.08)',
        timeVisible: false,
      },
      crosshair: {
        vertLine: { color: 'rgba(255,255,255,0.18)', labelBackgroundColor: '#374151' },
        horzLine: { color: 'rgba(255,255,255,0.18)', labelBackgroundColor: '#374151' },
      },
    })

    chartInstanceRef.current = chart

    // Candlestick series
    const candleSeries = chart.addCandlestickSeries({
      upColor:        '#1D9E75',
      downColor:      '#D85A30',
      borderUpColor:  '#1D9E75',
      borderDownColor:'#D85A30',
      wickUpColor:    '#1D9E75',
      wickDownColor:  '#D85A30',
    })
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    candleSeries.setData(stockData.ohlcv as any)

    // Volume histogram — bottom 18% of chart
    chart.priceScale('volume').applyOptions({
      scaleMargins: { top: 0.82, bottom: 0 },
      visible: false,
    })
    const volSeries = chart.addHistogramSeries({
      priceFormat: { type: 'volume' },
      priceScaleId: 'volume',
    })
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    volSeries.setData(stockData.ohlcv.map((d) => ({
      time:  d.time,
      value: d.volume,
      color: d.close >= d.open ? 'rgba(29,158,117,0.35)' : 'rgba(216,90,48,0.35)',
    })) as any)

    // SMA50 — blue overlay
    if (stockData.sma50.length > 0) {
      const s50 = chart.addLineSeries({
        color: '#3B82F6', lineWidth: 1,
        priceLineVisible: false, lastValueVisible: false,
      })
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      s50.setData(stockData.sma50 as any)
    }

    // SMA200 — amber overlay
    if (stockData.sma200.length > 0) {
      const s200 = chart.addLineSeries({
        color: '#F59E0B', lineWidth: 1,
        priceLineVisible: false, lastValueVisible: false,
      })
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      s200.setData(stockData.sma200 as any)
    }

    chart.timeScale().fitContent()

    // Resize observer
    const ro = new ResizeObserver(() => {
      chart.applyOptions({ width: container.clientWidth })
    })
    ro.observe(container)

    return () => {
      ro.disconnect()
      chart.remove()
      chartInstanceRef.current = null
    }
  }, [stockData])

  // ── Derived ────────────────────────────────────────────────────────────────

  const isUp        = (stockData?.changePercent ?? 0) >= 0
  const { indicators, news } = stockData ?? { indicators: null, news: [] }

  // ── Render ─────────────────────────────────────────────────────────────────

  return (
    <div className="p-6 bg-gray-100 min-h-screen">
      <div className="max-w-5xl mx-auto space-y-4">

        {/* Page heading */}
        <div className="flex items-center gap-2 mb-1">
          <BarChart2 size={20} className="text-green-600" />
          <h1 className="text-xl font-bold text-gray-800">Stock Viewer</h1>
        </div>

        {/* Search bar */}
        <form onSubmit={handleSearch} className="bg-white rounded-xl p-4 shadow-sm flex gap-3 items-center">
          <div className="relative flex-1">
            <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400 pointer-events-none" />
            <input
              value={tickerInput}
              onChange={(e) => setTickerInput(e.target.value.toUpperCase())}
              placeholder="Ticker — e.g. AAPL, TSLA, MSFT, ERIC-B.ST, VOLV-B.ST"
              className="w-full pl-9 pr-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:border-blue-400 font-mono placeholder:font-sans"
            />
          </div>
          <button
            type="submit"
            disabled={loading || !tickerInput.trim()}
            className="bg-[#0079bf] hover:bg-[#026aa7] text-white text-sm px-5 py-2 rounded-lg disabled:opacity-50 flex items-center gap-1.5 shrink-0 transition-colors"
          >
            {loading
              ? <><RefreshCw size={13} className="animate-spin" /> Loading…</>
              : <><Search size={13} /> Search</>
            }
          </button>
        </form>

        {/* Error */}
        {error && (
          <div className="bg-red-50 border border-red-200 rounded-xl px-4 py-3 text-sm text-red-700">
            {error}
          </div>
        )}

        {/* ── Stock content ──────────────────────────────────────────────── */}
        {stockData && (
          <>

            {/* Stats bar */}
            <div className="bg-white rounded-xl p-5 shadow-sm">
              <div className="flex items-start justify-between flex-wrap gap-4 mb-4">
                <div>
                  <p className="text-sm font-semibold text-gray-400 font-mono mb-0.5">{stockData.ticker}</p>
                  <div className="flex items-baseline gap-3 flex-wrap">
                    <span className="text-3xl font-bold text-gray-900 font-mono tabular-nums">
                      ${fmtPrice(stockData.currentPrice)}
                    </span>
                    <span className={`flex items-center gap-1 text-base font-semibold ${isUp ? 'text-green-600' : 'text-red-500'}`}>
                      {isUp ? <TrendingUp size={16} /> : <TrendingDown size={16} />}
                      {isUp ? '+' : ''}{fmtPrice(Math.abs(stockData.change))}
                      &nbsp;({isUp ? '+' : ''}{stockData.changePercent.toFixed(2)}%)
                    </span>
                  </div>
                </div>
              </div>

              <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-6 gap-2">
                <Stat label="Market Cap"   value={fmtCap(stockData.marketCap)} />
                <Stat label="P/E Ratio"    value={stockData.peRatio      != null ? `${stockData.peRatio}×`             : '—'} />
                <Stat label="EPS"          value={stockData.eps          != null ? `$${stockData.eps}`                  : '—'} />
                <Stat label="52w High"     value={stockData.high52w      != null ? `$${fmtPrice(stockData.high52w)}`    : '—'} />
                <Stat label="52w Low"      value={stockData.low52w       != null ? `$${fmtPrice(stockData.low52w)}`     : '—'} />
                <Stat label="Div Yield"    value={stockData.dividendYield!= null ? `${stockData.dividendYield}%`        : '—'} />
              </div>
            </div>

            {/* Candlestick chart */}
            <div className="bg-[#0f1117] rounded-xl overflow-hidden shadow-sm">
              {/* Toolbar */}
              <div className="flex items-center justify-between px-4 pt-3.5 pb-3">
                {/* Interval buttons */}
                <div className="flex gap-1">
                  {(['1M', '3M', '6M', '1Y'] as Interval[]).map((intv) => (
                    <button
                      key={intv}
                      onClick={() => handleInterval(intv)}
                      className={`px-3 py-1 rounded text-xs font-semibold transition-colors ${
                        interval === intv
                          ? 'bg-white/15 text-white'
                          : 'text-gray-500 hover:text-gray-300 hover:bg-white/08'
                      }`}
                    >
                      {intv}
                    </button>
                  ))}
                </div>
                {/* Legend */}
                <div className="flex items-center gap-4 text-[11px] text-gray-500">
                  <span className="flex items-center gap-1.5">
                    <span className="w-3 h-[2px] bg-[#3B82F6] inline-block rounded" />
                    SMA 50
                  </span>
                  <span className="flex items-center gap-1.5">
                    <span className="w-3 h-[2px] bg-[#F59E0B] inline-block rounded" />
                    SMA 200
                  </span>
                </div>
              </div>

              {/* Chart canvas area */}
              <div ref={chartContainerRef} className="w-full h-[420px]" />
            </div>

            {/* Technical indicators */}
            {indicators && (
              <div className="bg-white rounded-xl p-5 shadow-sm">
                <h2 className="font-semibold text-gray-800 mb-3 flex items-center gap-2 text-sm">
                  <BarChart2 size={14} className="text-blue-500" />
                  Technical Indicators
                </h2>
                <div className="flex flex-wrap gap-3">

                  {/* RSI */}
                  {indicators.rsi != null && (() => {
                    const v = indicators.rsi
                    const cls = v > 70
                      ? 'bg-red-50 text-red-700 border-red-200'
                      : v < 30
                        ? 'bg-green-50 text-green-700 border-green-200'
                        : 'bg-gray-50 text-gray-700 border-gray-200'
                    const lbl = v > 70 ? 'Overbought' : v < 30 ? 'Oversold' : 'Neutral'
                    return (
                      <div className={`flex items-baseline gap-2 px-4 py-2.5 rounded-lg border text-sm ${cls}`}>
                        <span className="text-[11px] font-semibold opacity-60">RSI(14)</span>
                        <span className="text-lg font-bold tabular-nums">{v}</span>
                        <span className="text-[11px] opacity-60">· {lbl}</span>
                      </div>
                    )
                  })()}

                  {/* MACD */}
                  {indicators.macd != null && (() => {
                    const v = indicators.macd
                    const cls = v >= 0
                      ? 'bg-green-50 text-green-700 border-green-200'
                      : 'bg-red-50 text-red-700 border-red-200'
                    return (
                      <div className={`flex items-baseline gap-2 px-4 py-2.5 rounded-lg border text-sm ${cls}`}>
                        <span className="text-[11px] font-semibold opacity-60">MACD</span>
                        <span className="text-lg font-bold tabular-nums">{v >= 0 ? '+' : ''}{v}</span>
                        {indicators.macdHistogram != null && (
                          <span className="text-[11px] opacity-60">
                            Hist: {indicators.macdHistogram >= 0 ? '+' : ''}{indicators.macdHistogram}
                          </span>
                        )}
                      </div>
                    )
                  })()}

                  {/* Bollinger Band Width */}
                  {indicators.bbWidth != null && (
                    <div className="flex items-baseline gap-2 px-4 py-2.5 rounded-lg border border-gray-200 bg-gray-50 text-gray-700 text-sm">
                      <span className="text-[11px] font-semibold opacity-60">BB Width</span>
                      <span className="text-lg font-bold tabular-nums">{indicators.bbWidth.toFixed(2)}%</span>
                      {indicators.bbUpper != null && indicators.bbLower != null && (
                        <span className="text-[11px] opacity-60">
                          ${indicators.bbLower.toFixed(2)} – ${indicators.bbUpper.toFixed(2)}
                        </span>
                      )}
                    </div>
                  )}

                </div>
              </div>
            )}

            {/* Fundamentals */}
            <div className="bg-white rounded-xl p-5 shadow-sm">
              <h2 className="font-semibold text-gray-800 mb-3 flex items-center gap-2 text-sm">
                <BookOpen size={14} className="text-purple-500" />
                Fundamentals
              </h2>
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
                {[
                  { label: 'P/E Ratio',      value: stockData.peRatio       != null ? `${stockData.peRatio}×`          : 'N/A' },
                  { label: 'EPS',             value: stockData.eps           != null ? `$${stockData.eps}`              : 'N/A' },
                  { label: 'Market Cap',      value: fmtCap(stockData.marketCap) },
                  { label: 'Dividend Yield',  value: stockData.dividendYield != null ? `${stockData.dividendYield}%`   : 'N/A' },
                  { label: '52w High',        value: stockData.high52w       != null ? `$${fmtPrice(stockData.high52w)}`: 'N/A' },
                  { label: '52w Low',         value: stockData.low52w        != null ? `$${fmtPrice(stockData.low52w)}` : 'N/A' },
                ].map(({ label, value }) => (
                  <div key={label} className="border border-gray-100 rounded-lg px-4 py-3">
                    <p className="text-xs text-gray-400 mb-1">{label}</p>
                    <p className="text-sm font-bold text-gray-800">{value}</p>
                  </div>
                ))}
              </div>
            </div>

            {/* News feed */}
            {news.length > 0 && (
              <div className="bg-white rounded-xl p-5 shadow-sm">
                <h2 className="font-semibold text-gray-800 mb-3 flex items-center gap-2 text-sm">
                  <Newspaper size={14} className="text-amber-500" />
                  Latest News
                </h2>
                <div className="space-y-2">
                  {news.map((item, i) => (
                    <a
                      key={i}
                      href={item.link}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="flex items-start gap-3 p-3 rounded-lg border border-gray-100 hover:border-gray-200 hover:bg-gray-50 transition-colors group"
                    >
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-medium text-gray-800 group-hover:text-blue-600 leading-snug">
                          {item.title}
                        </p>
                        <p className="text-xs text-gray-400 mt-1">
                          {item.source} · {fmtDate(item.publishedAt)}
                        </p>
                      </div>
                      <div className="flex items-center gap-2 shrink-0">
                        <span className={`px-2 py-0.5 rounded-full text-[10px] font-semibold ${
                          item.sentiment === 'positive' ? 'bg-green-100 text-green-700'
                          : item.sentiment === 'negative' ? 'bg-red-100 text-red-700'
                          : 'bg-gray-100 text-gray-500'
                        }`}>
                          {item.sentiment === 'positive' ? '▲ Positive'
                            : item.sentiment === 'negative' ? '▼ Negative'
                            : '● Neutral'}
                        </span>
                        <ExternalLink size={12} className="text-gray-300 group-hover:text-blue-400" />
                      </div>
                    </a>
                  ))}
                </div>
              </div>
            )}

            {/* ── Company profile ──────────────────────────────────────── */}
            {(stockData.description || stockData.sector) && (
              <SectionCard title="Company Profile" icon={<BookOpen size={14} className="text-indigo-500" />}>
                <Grid items={[
                  { label: 'Sector',    value: stockData.sector   ?? '—' },
                  { label: 'Industry',  value: stockData.industry ?? '—' },
                  { label: 'Country',   value: stockData.country  ?? '—' },
                  { label: 'Employees', value: stockData.employees != null ? stockData.employees.toLocaleString() : '—' },
                  { label: 'Beta',      value: fmtNum(stockData.beta, 2) },
                  { label: 'Short Ratio', value: fmtNum(stockData.shortRatio, 1) },
                ]} />
                {stockData.description && (
                  <p className="mt-3 text-sm text-gray-600 leading-relaxed line-clamp-4">{stockData.description}</p>
                )}
                {stockData.website && (
                  <a href={stockData.website} target="_blank" rel="noreferrer" className="mt-1 text-xs text-blue-500 hover:underline">{stockData.website}</a>
                )}
              </SectionCard>
            )}

            {/* ── Nordic data (Avanza) ─────────────────────────────────── */}
            {stockData.avanza && (
              <SectionCard title="Nordic Data — Avanza (SEK)" icon={<BarChart2 size={14} className="text-yellow-500" />}>
                <p className="text-[11px] text-gray-400 mb-3">
                  Swedish broker data{stockData.avanza.marketList ? ` · ${stockData.avanza.marketList}` : ''} — fills gaps Yahoo Finance leaves for Swedish tickers.
                </p>
                <Grid items={[
                  { label: 'P/E Ratio',      value: fmtNum(stockData.avanza.peRatio, 2) },
                  { label: 'P/S Ratio',      value: fmtNum(stockData.avanza.psRatio, 2) },
                  { label: 'P/B Ratio',      value: fmtNum(stockData.avanza.pbRatio, 2) },
                  { label: 'EV/EBIT',        value: fmtNum(stockData.avanza.evEbit, 2) },
                  { label: 'Direct Yield',   value: fmtPct(stockData.avanza.directYield) },
                  { label: 'Beta',           value: fmtNum(stockData.avanza.beta, 2) },
                  { label: 'Volatility',     value: fmtPct(stockData.avanza.volatility) },
                  { label: 'ROE',            value: fmtPct(stockData.avanza.returnOnEquity) },
                  { label: 'ROA',            value: fmtPct(stockData.avanza.returnOnAssets) },
                  { label: 'ROCE',           value: fmtPct(stockData.avanza.returnOnCapitalEmployed) },
                  { label: 'Equity Ratio',   value: fmtPct(stockData.avanza.equityRatio) },
                  { label: 'Gross Margin',   value: fmtPct(stockData.avanza.grossMargin) },
                  { label: 'Operating Margin', value: fmtPct(stockData.avanza.operatingMargin) },
                  { label: 'Net Margin',     value: fmtPct(stockData.avanza.netMargin) },
                  { label: 'Market Cap',     value: stockData.avanza.marketCap != null ? `${(stockData.avanza.marketCap/1e9).toFixed(2)}B SEK` : '—' },
                  { label: 'EPS',            value: stockData.avanza.eps != null ? `${stockData.avanza.eps} SEK` : '—' },
                  { label: 'Equity/Share',   value: stockData.avanza.equityPerShare != null ? `${stockData.avanza.equityPerShare} SEK` : '—' },
                  { label: 'Owners',         value: stockData.avanza.numberOfOwners != null ? stockData.avanza.numberOfOwners.toLocaleString() : '—' },
                  { label: 'Short Ratio',    value: fmtPct(stockData.avanza.shortSellingRatio) },
                  { label: 'Dividend',       value: stockData.avanza.dividendAmount != null ? `${stockData.avanza.dividendAmount} SEK${stockData.avanza.dividendsPerYear ? ` ×${stockData.avanza.dividendsPerYear}` : ''}` : '—' },
                  { label: 'Next Report',    value: stockData.avanza.nextReportDate ?? '—' },
                ].filter(i => i.value !== '—')} />
              </SectionCard>
            )}

            {/* ── Extended valuation ───────────────────────────────────── */}
            <SectionCard title="Extended Valuation" icon={<BookOpen size={14} className="text-purple-500" />}>
              <Grid items={[
                { label: 'Forward P/E',   value: stockData.forwardEps && stockData.currentPrice ? `${(stockData.currentPrice / stockData.forwardEps).toFixed(1)}×` : '—' },
                { label: 'Price/Book',    value: fmtNum(stockData.priceToBook, 2, '') + (stockData.priceToBook != null ? '×' : '') },
                { label: 'EV/Revenue',    value: fmtNum(stockData.enterpriseToRevenue, 2, '') + (stockData.enterpriseToRevenue != null ? '×' : '') },
                { label: 'EV/EBITDA',     value: fmtNum(stockData.enterpriseToEbitda, 2, '') + (stockData.enterpriseToEbitda != null ? '×' : '') },
                { label: 'Forward EPS',   value: stockData.forwardEps != null ? `$${stockData.forwardEps}` : '—' },
                { label: 'Book Value',    value: stockData.bookValue  != null ? `$${stockData.bookValue}`  : '—' },
                { label: 'Payout Ratio',  value: fmtPct(stockData.payoutRatio) },
                { label: 'Insider Own.',  value: fmtPct(stockData.heldPercentInsiders) },
                { label: 'Inst. Own.',    value: fmtPct(stockData.heldPercentInstitutions) },
              ].filter(i => i.value !== '—')} />
            </SectionCard>

            {/* ── Margins & health ─────────────────────────────────────── */}
            <SectionCard title="Margins & Financial Health" icon={<BarChart2 size={14} className="text-blue-500" />}>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <p className="text-[10px] font-semibold text-gray-400 uppercase tracking-wider mb-2">Margins</p>
                  <Grid items={[
                    { label: 'Gross Margin',     value: fmtPct(stockData.grossMargins) },
                    { label: 'Operating Margin', value: fmtPct(stockData.operatingMargins) },
                    { label: 'Profit Margin',    value: fmtPct(stockData.profitMargins) },
                    { label: 'ROE',              value: fmtPct(stockData.returnOnEquity) },
                    { label: 'ROA',              value: fmtPct(stockData.returnOnAssets) },
                    { label: 'Revenue Growth',   value: fmtPct(stockData.revenueGrowth) },
                    { label: 'Earnings Growth',  value: fmtPct(stockData.earningsGrowth) },
                  ].filter(i => i.value !== '—')} />
                </div>
                <div>
                  <p className="text-[10px] font-semibold text-gray-400 uppercase tracking-wider mb-2">Balance</p>
                  <Grid items={[
                    { label: 'Total Revenue',    value: fmtB(stockData.totalRevenue) },
                    { label: 'Gross Profit',     value: fmtB(stockData.grossProfits) },
                    { label: 'EBITDA',           value: fmtB(stockData.ebitda) },
                    { label: 'Free Cash Flow',   value: fmtB(stockData.freeCashflow) },
                    { label: 'Total Cash',       value: fmtB(stockData.totalCash) },
                    { label: 'Total Debt',       value: fmtB(stockData.totalDebt) },
                    { label: 'Debt/Equity',      value: fmtNum(stockData.debtToEquity, 2) },
                    { label: 'Current Ratio',    value: fmtNum(stockData.currentRatio, 2) },
                  ].filter(i => i.value !== '—')} />
                </div>
              </div>
            </SectionCard>

            {/* ── Analyst consensus ────────────────────────────────────── */}
            {(stockData.targetMeanPrice || stockData.recommendationKey) && (
              <SectionCard title="Analyst Consensus" icon={<TrendingUp size={14} className="text-green-500" />}>
                <div className="flex flex-wrap gap-3 mb-3">
                  {stockData.recommendationKey && (
                    <div className="px-4 py-2 bg-blue-50 text-blue-700 rounded-lg text-sm font-bold uppercase">{stockData.recommendationKey}</div>
                  )}
                  {stockData.numberOfAnalysts != null && (
                    <div className="px-4 py-2 bg-gray-50 text-gray-600 rounded-lg text-sm">{stockData.numberOfAnalysts} analysts</div>
                  )}
                  {stockData.nextEarningsDate && (
                    <div className="px-4 py-2 bg-amber-50 text-amber-700 rounded-lg text-sm">Next earnings: {stockData.nextEarningsDate}</div>
                  )}
                </div>
                <Grid items={[
                  { label: 'Target (mean)', value: stockData.targetMeanPrice != null ? `$${stockData.targetMeanPrice.toFixed(2)}` : '—' },
                  { label: 'Target (high)', value: stockData.targetHighPrice != null ? `$${stockData.targetHighPrice.toFixed(2)}` : '—' },
                  { label: 'Target (low)',  value: stockData.targetLowPrice  != null ? `$${stockData.targetLowPrice.toFixed(2)}`  : '—' },
                  ...(stockData.targetMeanPrice && stockData.currentPrice ? [{
                    label: 'Upside (mean)',
                    value: `${((stockData.targetMeanPrice - stockData.currentPrice) / stockData.currentPrice * 100).toFixed(1)}%`,
                  }] : []),
                ].filter(i => i.value !== '—')} />

                {stockData.recommendationTrend.length > 0 && (
                  <div className="mt-3">
                    <p className="text-[10px] font-semibold text-gray-400 uppercase tracking-wider mb-2">Recommendation trend</p>
                    <TableSection
                      cols={['Period', 'Strong Buy', 'Buy', 'Hold', 'Sell', 'Strong Sell']}
                      rows={stockData.recommendationTrend.map(r => [r.period, String(r.strongBuy), String(r.buy), String(r.hold), String(r.sell), String(r.strongSell)])}
                    />
                  </div>
                )}

                {stockData.upgradeDowngradeHistory.length > 0 && (
                  <div className="mt-3">
                    <p className="text-[10px] font-semibold text-gray-400 uppercase tracking-wider mb-2">Recent analyst actions</p>
                    <TableSection
                      cols={['Date', 'Firm', 'Action', 'To', 'From']}
                      rows={stockData.upgradeDowngradeHistory.map(u => [u.date, u.firm, u.action, u.toGrade, u.fromGrade || '—'])}
                    />
                  </div>
                )}
              </SectionCard>
            )}

            {/* ── Earnings history & estimates ────────────────────────── */}
            {(stockData.earningsHistory.length > 0 || stockData.earningsTrend.length > 0) && (
              <SectionCard title="Earnings" icon={<BarChart2 size={14} className="text-orange-500" />}>
                {stockData.earningsHistory.length > 0 && (
                  <div className="mb-4">
                    <p className="text-[10px] font-semibold text-gray-400 uppercase tracking-wider mb-2">Historical EPS</p>
                    <TableSection
                      cols={['Quarter', 'Actual', 'Estimate', 'Surprise']}
                      rows={stockData.earningsHistory.map(e => [
                        e.date,
                        e.epsActual   != null ? `$${e.epsActual.toFixed(2)}`   : null,
                        e.epsEstimate != null ? `$${e.epsEstimate.toFixed(2)}` : null,
                        e.surprisePct != null ? `${(e.surprisePct * 100).toFixed(1)}%` : null,
                      ])}
                    />
                  </div>
                )}
                {stockData.earningsTrend.length > 0 && (
                  <div>
                    <p className="text-[10px] font-semibold text-gray-400 uppercase tracking-wider mb-2">Forward estimates</p>
                    <TableSection
                      cols={['Period', 'End Date', 'EPS Est.', 'Revenue Est.', 'Analysts']}
                      rows={stockData.earningsTrend.map(t => [
                        t.period, t.endDate,
                        t.epsEst != null ? `$${t.epsEst.toFixed(2)}` : null,
                        t.revEst != null ? fmtB(t.revEst) : null,
                        t.numAnalysts != null ? String(t.numAnalysts) : null,
                      ])}
                    />
                  </div>
                )}
              </SectionCard>
            )}

            {/* ── Annual income statements ─────────────────────────────── */}
            {stockData.incomeAnnual.length > 0 && (
              <SectionCard title="Annual Income Statements" icon={<BookOpen size={14} className="text-teal-500" />}>
                <TableSection
                  cols={['Fiscal Year', 'Revenue', 'Gross Profit', 'EBIT', 'Net Income', 'EBITDA']}
                  rows={stockData.incomeAnnual.map(s => [s.date, fmtB(s.totalRevenue), fmtB(s.grossProfit), fmtB(s.ebit), fmtB(s.netIncome), fmtB(s.ebitda)])}
                />
                {stockData.incomeQuarterly.length > 0 && (
                  <div className="mt-4">
                    <p className="text-[10px] font-semibold text-gray-400 uppercase tracking-wider mb-2">Quarterly (last 4)</p>
                    <TableSection
                      cols={['Quarter', 'Revenue', 'Gross Profit', 'Net Income']}
                      rows={stockData.incomeQuarterly.map(s => [s.date, fmtB(s.totalRevenue), fmtB(s.grossProfit), fmtB(s.netIncome)])}
                    />
                  </div>
                )}
              </SectionCard>
            )}

            {/* ── Balance sheet ─────────────────────────────────────────── */}
            {stockData.balanceAnnual.length > 0 && (
              <SectionCard title="Annual Balance Sheets" icon={<BookOpen size={14} className="text-violet-500" />}>
                <TableSection
                  cols={['Fiscal Year', 'Total Assets', 'Total Liab.', 'Equity', 'Cash', 'Long-Term Debt']}
                  rows={stockData.balanceAnnual.map(s => [s.date, fmtB(s.totalAssets), fmtB(s.totalLiab), fmtB(s.equity), fmtB(s.cash), fmtB(s.longDebt)])}
                />
              </SectionCard>
            )}

            {/* ── Cash flow ────────────────────────────────────────────── */}
            {stockData.cashflowAnnual.length > 0 && (
              <SectionCard title="Annual Cash Flow Statements" icon={<BarChart2 size={14} className="text-cyan-500" />}>
                <TableSection
                  cols={['Fiscal Year', 'Operating CF', 'CapEx', 'Free CF', 'Investing CF', 'Financing CF']}
                  rows={stockData.cashflowAnnual.map(s => [s.date, fmtB(s.operatingCF), fmtB(s.capex), fmtB(s.freeCF), fmtB(s.investingCF), fmtB(s.financingCF)])}
                />
              </SectionCard>
            )}

            {/* ── Insider transactions ──────────────────────────────────── */}
            {stockData.insiderTransactions.length > 0 && (
              <SectionCard title="Recent Insider Transactions" icon={<Newspaper size={14} className="text-rose-500" />}>
                <TableSection
                  cols={['Date', 'Insider', 'Shares', 'Value', 'Description']}
                  rows={stockData.insiderTransactions.map(t => [
                    t.date, t.name,
                    t.shares != null ? t.shares.toLocaleString() : null,
                    t.value  != null ? fmtB(t.value)             : null,
                    t.description || null,
                  ])}
                />
              </SectionCard>
            )}

          </>
        )}

        {/* Empty state */}
        {!stockData && !loading && !error && (
          <div className="bg-white rounded-xl p-12 shadow-sm flex flex-col items-center text-center">
            <BarChart2 size={48} className="text-gray-200 mb-4" />
            <p className="text-gray-500 font-medium">Search for any stock to view its data</p>
            <p className="text-gray-400 text-sm mt-1">
              US stocks: <code className="font-mono bg-gray-50 px-1 rounded">AAPL</code>,&nbsp;
              <code className="font-mono bg-gray-50 px-1 rounded">TSLA</code>,&nbsp;
              <code className="font-mono bg-gray-50 px-1 rounded">MSFT</code>
              &nbsp;·&nbsp;
              Swedish: <code className="font-mono bg-gray-50 px-1 rounded">ERIC-B.ST</code>,&nbsp;
              <code className="font-mono bg-gray-50 px-1 rounded">VOLV-B.ST</code>
            </p>
          </div>
        )}

      </div>
    </div>
  )
}
