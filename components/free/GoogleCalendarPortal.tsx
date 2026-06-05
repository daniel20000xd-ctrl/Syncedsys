'use client'

import * as React from 'react'
import { useState, useEffect, useRef, useCallback } from 'react'
import { Plus, X, Loader2 } from 'lucide-react'
import { getGoogleConnectionStatus } from '@/app/actions'

// A fully interactive Google Calendar embedded in a portal frame. Talks to the
// local /api/google/calendar routes (browser cookie session). Month / week / day
// views, every calendar in its own Google colour, click-to-create, click-to-edit,
// and drag-to-move in the timed views. Mutations are optimistic, then confirmed
// by re-fetching from the API.

type ViewMode = 'month' | 'week' | 'day'

type CalMeta = {
  id: string
  summary: string
  primary: boolean
  backgroundColor: string
  foregroundColor: string
}

type CalEvent = {
  id: string
  calendarId: string
  calendarName: string
  color: string
  title: string
  description: string
  start: string // ISO datetime, or YYYY-MM-DD when allDay
  end: string
  allDay: boolean
}

type EditorDraft = {
  id?: string
  calendarId: string
  title: string
  description: string
  start: string // datetime-local value, or YYYY-MM-DD when allDay
  end: string
  allDay: boolean
}

interface Props {
  config: { view?: ViewMode }
  onPersistConfig: (c: { view: ViewMode }) => void
  onUpdateContext?: (ctx: string) => void
}

const HOUR_H = 44 // px per hour in the timed grid
const DAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

const pad = (n: number) => String(n).padStart(2, '0')
const startOfDay = (d: Date) => { const x = new Date(d); x.setHours(0, 0, 0, 0); return x }
const addDays = (d: Date, n: number) => { const x = new Date(d); x.setDate(x.getDate() + n); return x }
const startOfWeek = (d: Date) => { const x = startOfDay(d); x.setDate(x.getDate() - x.getDay()); return x }
const startOfMonth = (d: Date) => { const x = startOfDay(d); x.setDate(1); return x }
const isSameDay = (a: Date, b: Date) =>
  a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate()
const ymd = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
const toLocalInput = (d: Date) => `${ymd(d)}T${pad(d.getHours())}:${pad(d.getMinutes())}`
const snap15 = (m: number) => Math.round(m / 15) * 15

function rangeFor(view: ViewMode, anchor: Date): { start: Date; end: Date } {
  if (view === 'day') { const s = startOfDay(anchor); return { start: s, end: addDays(s, 1) } }
  if (view === 'week') { const s = startOfWeek(anchor); return { start: s, end: addDays(s, 7) } }
  const s = startOfWeek(startOfMonth(anchor))
  return { start: s, end: addDays(s, 42) }
}

function minutesOfDay(iso: string): number {
  const d = new Date(iso)
  return d.getHours() * 60 + d.getMinutes()
}

export default function GoogleCalendarPortal({ config, onPersistConfig, onUpdateContext }: Props) {
  const [connected, setConnected] = useState<boolean | null>(null)
  const [view, setView] = useState<ViewMode>(config.view ?? 'week')
  const [anchor, setAnchor] = useState<Date>(() => new Date())
  const [calendars, setCalendars] = useState<CalMeta[]>([])
  const [events, setEvents] = useState<CalEvent[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [editor, setEditor] = useState<{ mode: 'create' | 'edit'; ev: EditorDraft } | null>(null)

  const onContextRef = useRef(onUpdateContext)
  useEffect(() => { onContextRef.current = onUpdateContext }, [onUpdateContext])

  const gridRef = useRef<HTMLDivElement>(null)

  // ── Connection check ────────────────────────────────────────────────────────
  useEffect(() => {
    let cancel = false
    getGoogleConnectionStatus()
      .then(s => { if (!cancel) setConnected(s.connected) })
      .catch(() => { if (!cancel) setConnected(false) })
    return () => { cancel = true }
  }, [])

  // ── Data fetch ──────────────────────────────────────────────────────────────
  const fetchEvents = useCallback(async () => {
    setLoading(true)
    try {
      const { start, end } = rangeFor(view, anchor)
      const res = await fetch(
        `/api/google/calendar?start=${encodeURIComponent(start.toISOString())}&end=${encodeURIComponent(end.toISOString())}`,
        { cache: 'no-store' },
      )
      if (!res.ok) throw new Error(`Failed to load events (${res.status})`)
      const data = (await res.json()) as { calendars: CalMeta[]; events: CalEvent[] }
      setCalendars(data.calendars ?? [])
      setEvents(data.events ?? [])
      setError(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load calendar')
    } finally {
      setLoading(false)
    }
  }, [view, anchor])

  useEffect(() => { if (connected) fetchEvents() }, [connected, fetchEvents])

  // Push a plain-text summary up to the portal so Claude can read the calendar.
  useEffect(() => {
    if (!connected) return
    fetch('/api/google/calendar/context', { cache: 'no-store' })
      .then(r => (r.ok ? r.text() : null))
      .then(t => { if (t) onContextRef.current?.(t) })
      .catch(() => {})
  }, [connected])

  function changeView(v: ViewMode) {
    setView(v)
    onPersistConfig({ view: v })
  }

  function shift(dir: -1 | 1) {
    setAnchor(prev => {
      if (view === 'month') { const x = new Date(prev); x.setMonth(x.getMonth() + dir); return x }
      return addDays(prev, dir * (view === 'week' ? 7 : 1))
    })
  }

  // ── Editor open/close ───────────────────────────────────────────────────────
  function openCreate(at: Date, allDay: boolean) {
    const cal = calendars.find(c => c.primary) ?? calendars[0]
    const end = new Date(at.getTime() + 60 * 60000)
    setEditor({
      mode: 'create',
      ev: {
        calendarId: cal?.id ?? 'primary',
        title: '', description: '', allDay,
        start: allDay ? ymd(at) : toLocalInput(at),
        end: allDay ? ymd(addDays(at, 1)) : toLocalInput(end),
      },
    })
  }

  function openEdit(ev: CalEvent) {
    const s = new Date(ev.start)
    const e = new Date(ev.end)
    setEditor({
      mode: 'edit',
      ev: {
        id: ev.id,
        calendarId: ev.calendarId,
        title: ev.title === '(no title)' ? '' : ev.title,
        description: ev.description,
        allDay: ev.allDay,
        start: ev.allDay ? ev.start || ymd(s) : toLocalInput(s),
        end: ev.allDay ? ev.end || ymd(e) : toLocalInput(e),
      },
    })
  }

  function toEventInput(d: EditorDraft) {
    if (d.allDay) {
      let end = d.end
      if (end <= d.start) end = ymd(addDays(new Date(`${d.start}T00:00`), 1))
      return { title: d.title, description: d.description, allDay: true, start: d.start, end }
    }
    return {
      title: d.title,
      description: d.description,
      allDay: false,
      start: new Date(d.start).toISOString(),
      end: new Date(d.end).toISOString(),
    }
  }

  // ── Mutations (optimistic, then confirm via refetch) ────────────────────────
  async function saveEditor() {
    if (!editor) return
    const d = editor.ev
    const input = toEventInput(d)
    setEditor(null)

    if (editor.mode === 'create') {
      const tempId = `tmp-${Date.now()}`
      const cal = calendars.find(c => c.id === d.calendarId)
      setEvents(prev => [...prev, {
        id: tempId, calendarId: d.calendarId, calendarName: cal?.summary ?? '',
        color: cal?.backgroundColor ?? '#4285f4', title: d.title || '(no title)',
        description: d.description, start: input.start, end: input.end, allDay: d.allDay,
      }])
      try {
        const res = await fetch('/api/google/calendar', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ calendarId: d.calendarId, event: input }),
        })
        if (!res.ok) throw new Error()
        await fetchEvents()
      } catch {
        setEvents(prev => prev.filter(e => e.id !== tempId))
        setError('Could not create event')
      }
    } else {
      const id = d.id!
      const snapshot = events
      setEvents(prev => prev.map(e =>
        e.id === id ? { ...e, title: d.title || '(no title)', description: d.description, start: input.start, end: input.end, allDay: d.allDay } : e,
      ))
      try {
        const res = await fetch('/api/google/calendar', {
          method: 'PATCH', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ calendarId: d.calendarId, eventId: id, changes: input }),
        })
        if (!res.ok) throw new Error()
        await fetchEvents()
      } catch {
        setEvents(snapshot)
        setError('Could not update event')
      }
    }
  }

  async function removeEvent(ev: CalEvent) {
    setEditor(null)
    const snapshot = events
    setEvents(prev => prev.filter(e => e.id !== ev.id))
    try {
      const res = await fetch('/api/google/calendar', {
        method: 'DELETE', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ calendarId: ev.calendarId, eventId: ev.id }),
      })
      if (!res.ok) throw new Error()
    } catch {
      setEvents(snapshot)
      setError('Could not delete event')
    }
  }

  async function moveEvent(ev: CalEvent, newStart: Date) {
    const durationMs = Math.max(15 * 60000, new Date(ev.end).getTime() - new Date(ev.start).getTime())
    const newEnd = new Date(newStart.getTime() + durationMs)
    const snapshot = events
    setEvents(prev => prev.map(e =>
      e.id === ev.id ? { ...e, start: newStart.toISOString(), end: newEnd.toISOString() } : e,
    ))
    try {
      const res = await fetch('/api/google/calendar', {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          calendarId: ev.calendarId, eventId: ev.id,
          changes: { start: newStart.toISOString(), end: newEnd.toISOString(), allDay: false },
        }),
      })
      if (!res.ok) throw new Error()
      await fetchEvents()
    } catch {
      setEvents(snapshot)
      setError('Could not move event')
    }
  }

  // ── Not connected / loading gates ───────────────────────────────────────────
  if (connected === null) {
    return (
      <Shell>
        <div className="flex items-center justify-center h-full">
          <Loader2 size={16} className="animate-spin text-white/30" />
        </div>
      </Shell>
    )
  }

  if (!connected) {
    return (
      <Shell>
        <div className="flex flex-col items-center justify-center h-full gap-3 px-6 text-center">
          <span className="inline-flex h-9 w-9 items-center justify-center rounded-full bg-gradient-to-br from-blue-500 via-red-500 to-yellow-500 text-white text-sm font-bold">G</span>
          <p className="text-white/60 text-xs">Connect your Google account to see your calendar.</p>
          <a
            href="/settings/connected-apps"
            className="px-3 py-1.5 rounded-lg bg-white/10 hover:bg-white/20 text-white text-xs font-medium transition-colors"
          >
            Connect Google Account
          </a>
        </div>
      </Shell>
    )
  }

  // ── Header ──────────────────────────────────────────────────────────────────
  const title =
    view === 'month'
      ? anchor.toLocaleString(undefined, { month: 'long', year: 'numeric' })
      : view === 'week'
        ? `${startOfWeek(anchor).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} – ${addDays(startOfWeek(anchor), 6).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}`
        : anchor.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' })

  return (
    <Shell>
      <div className="flex flex-col h-full">
        {/* Toolbar */}
        <div className="flex items-center gap-1.5 px-2 py-1.5 border-b border-white/10 shrink-0">
          <div className="flex items-center rounded-md overflow-hidden border border-white/10">
            {(['month', 'week', 'day'] as ViewMode[]).map(v => (
              <button
                key={v}
                onClick={() => changeView(v)}
                className={`px-2 py-0.5 text-[11px] capitalize transition-colors ${view === v ? 'bg-white/15 text-white' : 'text-white/50 hover:text-white/80'}`}
              >
                {v}
              </button>
            ))}
          </div>
          <button onClick={() => shift(-1)} className="px-1.5 py-0.5 rounded text-white/60 hover:bg-white/10 text-sm leading-none" title="Previous">‹</button>
          <button onClick={() => setAnchor(new Date())} className="px-1.5 py-0.5 rounded text-[11px] text-white/60 hover:bg-white/10" title="Today">Today</button>
          <button onClick={() => shift(1)} className="px-1.5 py-0.5 rounded text-white/60 hover:bg-white/10 text-sm leading-none" title="Next">›</button>
          <span className="text-xs text-white/80 font-medium truncate flex-1 min-w-0">{title}</span>
          {loading && <Loader2 size={12} className="animate-spin text-white/30 shrink-0" />}
          <button
            onClick={() => openCreate(new Date(new Date().setMinutes(0, 0, 0)), false)}
            className="flex items-center gap-1 px-1.5 py-0.5 rounded text-[11px] bg-white/5 hover:bg-white/15 text-white/70 hover:text-white transition-colors shrink-0"
            title="New event"
          >
            <Plus size={11} /> New
          </button>
        </div>

        {/* Calendar legend */}
        {calendars.length > 0 && (
          <div className="flex items-center gap-2 px-2 py-1 border-b border-white/10 overflow-x-auto shrink-0">
            {calendars.map(c => (
              <span key={c.id} className="flex items-center gap-1 text-[10px] text-white/50 whitespace-nowrap">
                <span className="w-2 h-2 rounded-sm shrink-0" style={{ backgroundColor: c.backgroundColor }} />
                {c.summary}
              </span>
            ))}
          </div>
        )}

        {error && (
          <div className="px-2 py-1 text-[11px] text-red-400/80 bg-red-500/10 shrink-0">{error}</div>
        )}

        {/* Body */}
        <div className="flex-1 min-h-0">
          {view === 'month'
            ? <MonthView anchor={anchor} events={events} onCreate={openCreate} onOpen={openEdit} />
            : <TimeGridView
                gridRef={gridRef}
                cols={view === 'week' ? Array.from({ length: 7 }, (_, i) => addDays(startOfWeek(anchor), i)) : [startOfDay(anchor)]}
                events={events}
                onCreate={openCreate}
                onOpen={openEdit}
                onMove={moveEvent}
              />}
        </div>
      </div>

      {editor && (
        <EventEditor
          draft={editor.ev}
          mode={editor.mode}
          calendars={calendars}
          onChange={ev => setEditor(prev => (prev ? { ...prev, ev } : prev))}
          onSave={saveEditor}
          onCancel={() => setEditor(null)}
          onDelete={editor.mode === 'edit' && editor.ev.id
            ? () => {
                const target = events.find(e => e.id === editor.ev.id)
                if (target) removeEvent(target)
              }
            : undefined}
        />
      )}
    </Shell>
  )
}

// ── Portal frame ──────────────────────────────────────────────────────────────
function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div
      className="nodrag nowheel absolute inset-0 pt-6 bg-[#0f1117] overflow-hidden text-white"
      onPointerDown={e => e.stopPropagation()}
    >
      {children}
    </div>
  )
}

// ── Month view ────────────────────────────────────────────────────────────────
function MonthView({
  anchor, events, onCreate, onOpen,
}: {
  anchor: Date
  events: CalEvent[]
  onCreate: (at: Date, allDay: boolean) => void
  onOpen: (ev: CalEvent) => void
}) {
  const gridStart = startOfWeek(startOfMonth(anchor))
  const days = Array.from({ length: 42 }, (_, i) => addDays(gridStart, i))
  const month = anchor.getMonth()
  const today = new Date()

  function eventsOn(day: Date): CalEvent[] {
    return events
      .filter(ev => {
        if (ev.allDay) {
          const s = new Date(`${ev.start}T00:00`)
          const e = new Date(`${ev.end}T00:00`)
          return day >= startOfDay(s) && day < startOfDay(e)
        }
        return isSameDay(new Date(ev.start), day)
      })
      .sort((a, b) => new Date(a.start).getTime() - new Date(b.start).getTime())
  }

  return (
    <div className="h-full overflow-y-auto">
      <div className="grid grid-cols-7 sticky top-0 bg-[#0f1117] z-10">
        {DAY_LABELS.map(d => (
          <div key={d} className="text-center text-[10px] text-white/40 py-1 border-b border-white/10">{d}</div>
        ))}
      </div>
      <div className="grid grid-cols-7 auto-rows-fr" style={{ minHeight: 'calc(100% - 20px)' }}>
        {days.map((day, i) => {
          const inMonth = day.getMonth() === month
          const isToday = isSameDay(day, today)
          const dayEvents = eventsOn(day)
          return (
            <div
              key={i}
              onClick={() => onCreate(new Date(startOfDay(day).getTime() + 9 * 60 * 60000), false)}
              className={`min-h-[58px] border-b border-r border-white/5 p-1 cursor-pointer hover:bg-white/[0.03] ${inMonth ? '' : 'opacity-40'}`}
            >
              <div className={`text-[10px] mb-0.5 ${isToday ? 'text-blue-400 font-bold' : 'text-white/50'}`}>{day.getDate()}</div>
              <div className="flex flex-col gap-0.5">
                {dayEvents.slice(0, 3).map(ev => (
                  <button
                    key={ev.id}
                    onClick={e => { e.stopPropagation(); onOpen(ev) }}
                    className="flex items-center gap-1 px-1 py-0.5 rounded text-[9px] text-white/90 truncate text-left"
                    style={{ backgroundColor: ev.color }}
                    title={ev.title}
                  >
                    <span className="truncate">{ev.allDay ? '' : new Date(ev.start).toLocaleTimeString(undefined, { hour: 'numeric' })} {ev.title}</span>
                  </button>
                ))}
                {dayEvents.length > 3 && <span className="text-[9px] text-white/40 pl-1">+{dayEvents.length - 3} more</span>}
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}

// ── Week / Day time grid ──────────────────────────────────────────────────────
function TimeGridView({
  gridRef, cols, events, onCreate, onOpen, onMove,
}: {
  gridRef: React.RefObject<HTMLDivElement | null>
  cols: Date[]
  events: CalEvent[]
  onCreate: (at: Date, allDay: boolean) => void
  onOpen: (ev: CalEvent) => void
  onMove: (ev: CalEvent, newStart: Date) => void
}) {
  const [drag, setDrag] = useState<null | { ev: CalEvent; grabMin: number; durationMin: number; preview: { col: number; startMin: number } | null }>(null)
  const dragRef = useRef(drag)
  useEffect(() => { dragRef.current = drag }, [drag])
  const movedRef = useRef(false)
  const today = new Date()

  function pointTo(clientX: number, clientY: number): { col: number; minutes: number } | null {
    const el = gridRef.current
    if (!el) return null
    const rect = el.getBoundingClientRect()
    const colW = rect.width / cols.length
    const col = Math.max(0, Math.min(cols.length - 1, Math.floor((clientX - rect.left) / colW)))
    const y = clientY - rect.top + el.scrollTop
    const minutes = Math.max(0, Math.min(24 * 60 - 15, snap15((y / HOUR_H) * 60)))
    return { col, minutes }
  }

  useEffect(() => {
    if (!drag) return
    function onMoveP(e: PointerEvent) {
      const pt = pointTo(e.clientX, e.clientY)
      if (!pt) return
      movedRef.current = true
      const cur = dragRef.current
      if (!cur) return
      const startMin = Math.max(0, Math.min(24 * 60 - cur.durationMin, snap15(pt.minutes - cur.grabMin)))
      setDrag({ ...cur, preview: { col: pt.col, startMin } })
    }
    function onUpP() {
      const cur = dragRef.current
      setDrag(null)
      if (!cur) return
      if (!movedRef.current || !cur.preview) { onOpen(cur.ev); return }
      const day = cols[cur.preview.col]
      const newStart = new Date(startOfDay(day).getTime() + cur.preview.startMin * 60000)
      onMove(cur.ev, newStart)
    }
    window.addEventListener('pointermove', onMoveP)
    window.addEventListener('pointerup', onUpP, { once: true })
    return () => {
      window.removeEventListener('pointermove', onMoveP)
      window.removeEventListener('pointerup', onUpP)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [drag?.ev.id])

  function startDrag(e: React.PointerEvent, ev: CalEvent) {
    e.stopPropagation()
    const startMin = minutesOfDay(ev.start)
    let endMin = minutesOfDay(ev.end)
    if (endMin <= startMin) endMin = startMin + 30
    const pt = pointTo(e.clientX, e.clientY)
    movedRef.current = false
    setDrag({ ev, grabMin: pt ? pt.minutes - startMin : 0, durationMin: endMin - startMin, preview: null })
  }

  const allDayEvents = (day: Date) => events.filter(ev => {
    if (!ev.allDay) return false
    const s = new Date(`${ev.start}T00:00`)
    const e = new Date(`${ev.end}T00:00`)
    return day >= startOfDay(s) && day < startOfDay(e)
  })
  const timedEvents = (day: Date) => events.filter(ev => !ev.allDay && isSameDay(new Date(ev.start), day))

  return (
    <div className="flex flex-col h-full">
      {/* Day headers + all-day row */}
      <div className="flex border-b border-white/10 shrink-0">
        <div className="w-10 shrink-0" />
        {cols.map((day, i) => (
          <div key={i} className="flex-1 min-w-0 border-l border-white/5">
            <div className={`text-center py-0.5 text-[10px] ${isSameDay(day, today) ? 'text-blue-400 font-semibold' : 'text-white/50'}`}>
              {DAY_LABELS[day.getDay()]} {day.getDate()}
            </div>
            <div className="flex flex-col gap-0.5 px-0.5 pb-0.5 min-h-[16px]">
              {allDayEvents(day).map(ev => (
                <button
                  key={ev.id}
                  onClick={() => onOpen(ev)}
                  className="px-1 py-0.5 rounded text-[9px] text-white/90 truncate text-left"
                  style={{ backgroundColor: ev.color }}
                  title={ev.title}
                >
                  {ev.title}
                </button>
              ))}
            </div>
          </div>
        ))}
      </div>

      {/* Scrollable time grid */}
      <div ref={gridRef} className="flex-1 overflow-y-auto relative">
        <div className="flex" style={{ height: HOUR_H * 24 }}>
          {/* Hour gutter */}
          <div className="w-10 shrink-0 relative">
            {Array.from({ length: 24 }, (_, h) => (
              <div key={h} className="absolute right-1 text-[9px] text-white/30 -translate-y-1/2" style={{ top: h * HOUR_H }}>
                {h === 0 ? '' : `${h % 12 === 0 ? 12 : h % 12}${h < 12 ? 'a' : 'p'}`}
              </div>
            ))}
          </div>

          {/* Day columns */}
          {cols.map((day, ci) => (
            <div
              key={ci}
              className="flex-1 min-w-0 relative border-l border-white/5"
              onClick={e => {
                if (movedRef.current) return
                const el = gridRef.current
                if (!el) return
                const rect = el.getBoundingClientRect()
                const y = e.clientY - rect.top + el.scrollTop
                const minutes = Math.max(0, Math.min(23 * 60 + 30, Math.floor((y / HOUR_H) * 2) * 30))
                onCreate(new Date(startOfDay(day).getTime() + minutes * 60000), false)
              }}
            >
              {Array.from({ length: 24 }, (_, h) => (
                <div key={h} className="absolute left-0 right-0 border-t border-white/5" style={{ top: h * HOUR_H }} />
              ))}

              {timedEvents(day).map(ev => {
                const startMin = minutesOfDay(ev.start)
                let endMin = minutesOfDay(ev.end)
                if (endMin <= startMin) endMin = startMin + 30
                const isDragging = drag?.ev.id === ev.id && drag.preview
                const top = isDragging && drag.preview ? (drag.preview.startMin / 60) * HOUR_H : (startMin / 60) * HOUR_H
                const height = Math.max(16, ((endMin - startMin) / 60) * HOUR_H)
                const hidden = isDragging && drag.preview && drag.preview.col !== ci
                if (hidden) return null
                return (
                  <div
                    key={ev.id}
                    onPointerDown={e => startDrag(e, ev)}
                    className={`absolute left-0.5 right-0.5 rounded px-1 py-0.5 overflow-hidden cursor-grab active:cursor-grabbing ${isDragging ? 'opacity-80 ring-1 ring-white/60 z-20' : ''}`}
                    style={{ top, height, backgroundColor: ev.color }}
                    title={ev.title}
                  >
                    <p className="text-[9px] font-medium text-white/95 leading-tight truncate">{ev.title}</p>
                    {height > 28 && (
                      <p className="text-[8px] text-white/70 leading-tight">
                        {new Date(ev.start).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}
                      </p>
                    )}
                  </div>
                )
              })}
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

// ── Event editor overlay ──────────────────────────────────────────────────────
function EventEditor({
  draft, mode, calendars, onChange, onSave, onCancel, onDelete,
}: {
  draft: EditorDraft
  mode: 'create' | 'edit'
  calendars: CalMeta[]
  onChange: (d: EditorDraft) => void
  onSave: () => void
  onCancel: () => void
  onDelete?: () => void
}) {
  function set<K extends keyof EditorDraft>(key: K, value: EditorDraft[K]) {
    onChange({ ...draft, [key]: value })
  }

  function toggleAllDay(next: boolean) {
    if (next) {
      onChange({ ...draft, allDay: true, start: draft.start.slice(0, 10), end: draft.end.slice(0, 10) })
    } else {
      const s = `${draft.start.slice(0, 10)}T09:00`
      const e = `${draft.start.slice(0, 10)}T10:00`
      onChange({ ...draft, allDay: false, start: s, end: e })
    }
  }

  return (
    <div className="nodrag absolute inset-0 z-40 flex items-center justify-center bg-black/50 p-3" onPointerDown={e => e.stopPropagation()}>
      <div className="w-full max-w-[280px] bg-[#1b1e26] rounded-xl shadow-2xl border border-white/10 p-3 flex flex-col gap-2">
        <div className="flex items-center justify-between">
          <span className="text-xs font-semibold text-white/80">{mode === 'create' ? 'New event' : 'Edit event'}</span>
          <button onClick={onCancel} className="p-0.5 rounded hover:bg-white/10 text-white/50 hover:text-white"><X size={13} /></button>
        </div>

        <input
          autoFocus
          value={draft.title}
          onChange={e => set('title', e.target.value)}
          placeholder="Title"
          className="w-full bg-white/5 rounded px-2 py-1 text-xs text-white placeholder-white/30 focus:outline-none focus:ring-1 focus:ring-white/30"
        />

        {calendars.length > 0 && (
          <select
            value={draft.calendarId}
            onChange={e => set('calendarId', e.target.value)}
            className="w-full bg-white/5 rounded px-2 py-1 text-xs text-white focus:outline-none"
            disabled={mode === 'edit'}
          >
            {calendars.map(c => <option key={c.id} value={c.id} className="bg-[#1b1e26]">{c.summary}</option>)}
          </select>
        )}

        <label className="flex items-center gap-1.5 text-[11px] text-white/60">
          <input type="checkbox" checked={draft.allDay} onChange={e => toggleAllDay(e.target.checked)} />
          All day
        </label>

        <div className="flex flex-col gap-1">
          <label className="text-[10px] text-white/40">Start</label>
          <input
            type={draft.allDay ? 'date' : 'datetime-local'}
            value={draft.start}
            onChange={e => set('start', e.target.value)}
            className="w-full bg-white/5 rounded px-2 py-1 text-xs text-white focus:outline-none [color-scheme:dark]"
          />
          <label className="text-[10px] text-white/40">End</label>
          <input
            type={draft.allDay ? 'date' : 'datetime-local'}
            value={draft.end}
            onChange={e => set('end', e.target.value)}
            className="w-full bg-white/5 rounded px-2 py-1 text-xs text-white focus:outline-none [color-scheme:dark]"
          />
        </div>

        <textarea
          value={draft.description}
          onChange={e => set('description', e.target.value)}
          placeholder="Description"
          rows={2}
          className="w-full bg-white/5 rounded px-2 py-1 text-xs text-white placeholder-white/30 resize-none focus:outline-none"
        />

        <div className="flex items-center justify-between pt-1">
          {onDelete
            ? <button onClick={onDelete} className="text-[11px] text-red-400 hover:text-red-300">Delete</button>
            : <span />}
          <div className="flex items-center gap-2">
            <button onClick={onCancel} className="text-[11px] text-white/50 hover:text-white/80">Cancel</button>
            <button onClick={onSave} className="px-2.5 py-1 rounded bg-blue-600 hover:bg-blue-500 text-white text-[11px] font-medium">Save</button>
          </div>
        </div>
      </div>
    </div>
  )
}
