'use client'

import { useState, useEffect, useRef, useCallback } from 'react'
import { Search, TrendingUp, TrendingDown, RefreshCw } from 'lucide-react'

// ── Types ─────────────────────────────────────────────────────────────────────

type Interval = '1M' | '3M' | '6M' | '1Y'

interface OHLCVBar { time: string; open: number; high: number; low: number; close: number; volume: number }
interface StockData {
  ticker: string
  currentPrice: number
  change: number
  changePercent: number
  ohlcv: OHLCVBar[]
  sma50: { time: string; value: number }[]
  sma200: { time: string; value: number }[]
  indicators: {
    rsi: number | null
    macd: number | null
    macdHistogram: number | null
    bbWidth: number | null
  }
}

interface Props {
  config: { ticker?: string; interval?: string }
  onPersistConfig: (c: { ticker: string; interval: string }) => void
}

// ── Component ─────────────────────────────────────────────────────────────────

export default function StockPortal({ config, onPersistConfig }: Props) {
  const [tickerInput, setTickerInput]   = useState(config.ticker ?? '')
  const [activeTicker, setActiveTicker] = useState(config.ticker ?? '')
  const [interval, setIntervalState]    = useState<Interval>((config.interval as Interval) ?? '1Y')
  const [stockData, setStockData]       = useState<StockData | null>(null)
  const [loading, setLoading]           = useState(false)
  const [error, setError]               = useState<string | null>(null)

  const chartRef = useRef<HTMLDivElement>(null)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const chartInstanceRef = useRef<any>(null)

  // ── Fetch ──────────────────────────────────────────────────────────────────

  const fetchStock = useCallback(async (ticker: string, intv: Interval) => {
    if (!ticker) return
    setLoading(true); setError(null)
    try {
      const res = await fetch(`/api/stocks?ticker=${encodeURIComponent(ticker)}&interval=${intv}`)
      const json = await res.json()
      if (!res.ok) { setError(json.error ?? 'Error'); setStockData(null) }
      else setStockData(json as StockData)
    } catch (e) { setError(e instanceof Error ? e.message : 'Error'); setStockData(null) }
    finally { setLoading(false) }
  }, [])

  // Auto-load saved ticker on first mount
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
    if (activeTicker) {
      fetchStock(activeTicker, intv)
      onPersistConfig({ ticker: activeTicker, interval: intv })
    }
  }

  // ── Chart ──────────────────────────────────────────────────────────────────

  useEffect(() => {
    if (!chartRef.current || !stockData) return
    const container = chartRef.current
    let destroyed = false
    let ro: ResizeObserver | null = null

    // Tear down previous instance
    if (chartInstanceRef.current) {
      chartInstanceRef.current.__ro?.disconnect()
      chartInstanceRef.current.remove()
      chartInstanceRef.current = null
    }

    import('lightweight-charts').then(({ createChart, ColorType }) => {
      if (destroyed || !container) return

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const chart: any = createChart(container, {
        layout: {
          background: { type: ColorType.Solid, color: '#0f1117' },
          textColor: '#6B7280',
          fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
        },
        grid: {
          vertLines: { color: 'rgba(255,255,255,0.03)' },
          horzLines: { color: 'rgba(255,255,255,0.03)' },
        },
        width:  container.clientWidth,
        height: container.clientHeight || 180,
        rightPriceScale: { borderColor: 'rgba(255,255,255,0.06)' },
        timeScale: { borderColor: 'rgba(255,255,255,0.06)', visible: false },
        crosshair: {
          vertLine: { color: 'rgba(255,255,255,0.15)', labelBackgroundColor: '#1F2937' },
          horzLine: { color: 'rgba(255,255,255,0.15)', labelBackgroundColor: '#1F2937' },
        },
      })
      chartInstanceRef.current = chart

      // Candlesticks
      const candle = chart.addCandlestickSeries({
        upColor: '#1D9E75', downColor: '#D85A30',
        borderUpColor: '#1D9E75', borderDownColor: '#D85A30',
        wickUpColor: '#1D9E75', wickDownColor: '#D85A30',
      })
      candle.setData(stockData!.ohlcv)

      // Volume — bottom 15%
      chart.priceScale('volume').applyOptions({ scaleMargins: { top: 0.85, bottom: 0 }, visible: false })
      const vol = chart.addHistogramSeries({ priceFormat: { type: 'volume' }, priceScaleId: 'volume' })
      vol.setData(stockData!.ohlcv.map((d: OHLCVBar) => ({
        time: d.time, value: d.volume,
        color: d.close >= d.open ? 'rgba(29,158,117,0.28)' : 'rgba(216,90,48,0.28)',
      })))

      // SMA overlays
      if (stockData!.sma50.length > 0) {
        chart.addLineSeries({ color: '#3B82F6', lineWidth: 1, priceLineVisible: false, lastValueVisible: false })
          .setData(stockData!.sma50)
      }
      if (stockData!.sma200.length > 0) {
        chart.addLineSeries({ color: '#F59E0B', lineWidth: 1, priceLineVisible: false, lastValueVisible: false })
          .setData(stockData!.sma200)
      }

      chart.timeScale().fitContent()

      ro = new ResizeObserver(() => {
        if (!destroyed && container) {
          chart.applyOptions({ width: container.clientWidth, height: container.clientHeight })
        }
      })
      ro.observe(container)
      chart.__ro = ro
    })

    return () => {
      destroyed = true
      ro?.disconnect()
      if (chartInstanceRef.current) {
        chartInstanceRef.current.__ro?.disconnect()
        chartInstanceRef.current.remove()
        chartInstanceRef.current = null
      }
    }
  }, [stockData])

  // ── Derived ────────────────────────────────────────────────────────────────

  const isUp = (stockData?.changePercent ?? 0) >= 0
  const rsi  = stockData?.indicators.rsi
  const rsiCls = rsi != null
    ? rsi > 70 ? 'text-red-400' : rsi < 30 ? 'text-green-400' : 'text-gray-500'
    : ''
  const macd = stockData?.indicators.macd

  // ── Render ─────────────────────────────────────────────────────────────────

  return (
    <div
      className="nodrag nowheel absolute inset-0 pt-6 bg-[#0f1117] flex flex-col overflow-hidden"
      onPointerDown={e => e.stopPropagation()}
    >
      {/* Search row */}
      <form onSubmit={handleSearch} className="flex gap-1 px-1.5 pt-1 pb-0.5 shrink-0">
        <input
          value={tickerInput}
          onChange={e => setTickerInput(e.target.value.toUpperCase())}
          placeholder="AAPL, ERIC-B.ST…"
          className="nodrag flex-1 bg-white/10 text-white text-[11px] px-2 py-1 rounded font-mono placeholder:text-white/25 focus:outline-none focus:bg-white/15"
          onPointerDown={e => e.stopPropagation()}
        />
        <button
          type="submit"
          disabled={loading || !tickerInput.trim()}
          className="nodrag bg-white/10 hover:bg-white/20 text-white/60 text-[11px] px-2 py-1 rounded disabled:opacity-40 flex items-center"
        >
          {loading ? <RefreshCw size={11} className="animate-spin" /> : <Search size={11} />}
        </button>
      </form>

      {/* Error */}
      {error && (
        <p className="px-2 py-0.5 text-[10px] text-red-400 shrink-0 truncate">{error}</p>
      )}

      {/* Price + indicators row */}
      {stockData && (
        <>
          <div className="flex items-center gap-1.5 px-2 py-0.5 shrink-0 flex-wrap">
            <span className="text-white/50 text-[10px] font-mono">{stockData.ticker}</span>
            <span className="text-white text-sm font-bold tabular-nums">
              ${stockData.currentPrice.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
            </span>
            <span className={`flex items-center gap-0.5 text-[10px] font-semibold ${isUp ? 'text-green-400' : 'text-red-400'}`}>
              {isUp ? <TrendingUp size={9} /> : <TrendingDown size={9} />}
              {isUp ? '+' : ''}{stockData.changePercent.toFixed(2)}%
            </span>
            {rsi != null && (
              <span className={`text-[9px] font-medium ml-auto ${rsiCls}`}>RSI {rsi}</span>
            )}
            {macd != null && (
              <span className={`text-[9px] font-medium ${macd >= 0 ? 'text-green-500' : 'text-red-400'}`}>
                MACD {macd >= 0 ? '+' : ''}{macd}
              </span>
            )}
          </div>

          {/* Interval buttons */}
          <div className="flex gap-0.5 px-1.5 pb-0.5 shrink-0">
            {(['1M', '3M', '6M', '1Y'] as Interval[]).map(intv => (
              <button
                key={intv}
                onClick={() => handleInterval(intv)}
                className={`nodrag px-1.5 py-0.5 rounded text-[10px] font-medium transition-colors ${
                  interval === intv
                    ? 'bg-white/15 text-white'
                    : 'text-gray-600 hover:text-gray-300 hover:bg-white/10'
                }`}
              >
                {intv}
              </button>
            ))}
            {/* Legend */}
            <div className="ml-auto flex items-center gap-2 pr-0.5">
              <span className="flex items-center gap-0.5 text-[9px] text-gray-600">
                <span className="w-2 h-px bg-[#3B82F6] inline-block" />50
              </span>
              <span className="flex items-center gap-0.5 text-[9px] text-gray-600">
                <span className="w-2 h-px bg-[#F59E0B] inline-block" />200
              </span>
            </div>
          </div>
        </>
      )}

      {/* Chart — fills remaining space */}
      <div ref={chartRef} className="flex-1 min-h-0" />

      {/* Empty prompt */}
      {!stockData && !loading && !error && (
        <div className="flex-1 flex items-center justify-center pb-2">
          <p className="text-white/20 text-[11px] text-center px-3 leading-5">
            Enter a ticker above<br />
            <span className="text-[9px] text-white/10">e.g. AAPL · TSLA · ERIC-B.ST</span>
          </p>
        </div>
      )}
    </div>
  )
}
