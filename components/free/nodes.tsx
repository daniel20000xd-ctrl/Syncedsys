'use client'

import {
  Handle, Position, NodeProps, useReactFlow, NodeResizer,
  BaseEdge, EdgeLabelRenderer, getBezierPath, type EdgeProps,
} from '@xyflow/react'
import { useState, useEffect, useRef } from 'react'
import { Plus, X, ExternalLink, ChevronDown, Maximize2 } from 'lucide-react'
import { updateBoardContent, ensureMirrorPortal } from '@/app/actions'

type SaveFn = (id: string, dataObj: Record<string, unknown>, w?: number, h?: number) => void

// Handles on all four sides; in loose connection mode each can both start and
// receive a connection, so you can link from whichever side you grab.
function SideHandles({ color = '!bg-blue-400' }: { color?: string }) {
  const cls = `${color} !w-3 !h-3`
  return (
    <>
      <Handle id="top" type="source" position={Position.Top} className={cls} />
      <Handle id="right" type="source" position={Position.Right} className={cls} />
      <Handle id="bottom" type="source" position={Position.Bottom} className={cls} />
      <Handle id="left" type="source" position={Position.Left} className={cls} />
    </>
  )
}

// Edge with a delete button that appears when you hover the link
export function DeletableEdge({ id, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, markerEnd, style, data }: EdgeProps) {
  const [hover, setHover] = useState(false)
  const [edgePath, labelX, labelY] = getBezierPath({ sourceX, sourceY, sourcePosition, targetX, targetY, targetPosition })
  const onDelete = data?.onDelete as ((id: string) => void) | undefined
  const deletable = (data?.deletable as boolean) ?? true
  return (
    <>
      <BaseEdge id={id} path={edgePath} markerEnd={markerEnd} style={style} />
      {/* wide invisible hit area so hovering anywhere on the link counts */}
      <path
        d={edgePath}
        fill="none"
        stroke="transparent"
        strokeWidth={18}
        style={{ pointerEvents: 'stroke', cursor: deletable ? 'pointer' : 'default' }}
        onMouseEnter={() => setHover(true)}
        onMouseLeave={() => setHover(false)}
      />
      {deletable && hover && (
        <EdgeLabelRenderer>
          <div
            className="nodrag nopan"
            style={{ position: 'absolute', transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)`, pointerEvents: 'all' }}
            onMouseEnter={() => setHover(true)}
            onMouseLeave={() => setHover(false)}
          >
            <button
              onClick={() => onDelete?.(id)}
              title="Remove link"
              className="bg-white rounded-full p-0.5 shadow border border-red-200 text-red-500 hover:bg-red-50"
            >
              <X size={11} />
            </button>
          </div>
        </EdgeLabelRenderer>
      )}
    </>
  )
}

// ── List Node ────────────────────────────────────────────────────────────────

export function ListNode({ id, data }: NodeProps) {
  const { updateNodeData } = useReactFlow()
  const [editing, setEditing] = useState(false)
  const [name, setName] = useState(data.name as string)
  const scale = (data.scale as number) ?? 1
  const onHold = data.onHold as ((id: string) => void) | undefined

  return (
    <div style={{ transform: `scale(${scale})`, transformOrigin: 'top left' }} onMouseDown={() => onHold?.(id)}>
      <div className="bg-[#ebecf0] rounded-xl shadow-lg w-52 select-none">
        <SideHandles />
        <div className="px-3 py-2 border-b border-black/10 flex items-center gap-1">
          {editing ? (
            <input
              autoFocus
              value={name}
              onChange={e => setName(e.target.value)}
              onBlur={() => { updateNodeData(id, { ...data, name }); setEditing(false) }}
              onKeyDown={e => { if (e.key === 'Enter') { updateNodeData(id, { ...data, name }); setEditing(false) } }}
              className="flex-1 text-sm font-semibold bg-white border border-blue-400 rounded px-1 focus:outline-none"
            />
          ) : (
            <span className="flex-1 text-sm font-semibold text-gray-800 cursor-pointer hover:text-blue-600" onDoubleClick={() => setEditing(true)}>
              {data.name as string}
            </span>
          )}
          <button className="p-0.5 rounded hover:bg-black/10 text-gray-400" onClick={() => (data.onAddCard as (id: string) => void)(id)} title="Add card">
            <Plus size={13} />
          </button>
        </div>
        <div className="px-2 py-1.5 text-xs text-gray-400 italic">
          {(data.cardCount as number) === 0 ? 'No cards' : `${data.cardCount} card${(data.cardCount as number) !== 1 ? 's' : ''}`}
        </div>
      </div>
    </div>
  )
}

// ── Card Node ────────────────────────────────────────────────────────────────

export function CardNode({ id, data }: NodeProps) {
  const [editing, setEditing] = useState(false)
  const [title, setTitle] = useState(data.title as string)
  const { updateNodeData } = useReactFlow()
  const scale = (data.scale as number) ?? 1
  const onHold = data.onHold as ((id: string) => void) | undefined
  const onRename = data.onRename as ((id: string, title: string) => void) | undefined

  function commitTitle() {
    updateNodeData(id, { ...data, title })
    setEditing(false)
    onRename?.(id, title)
  }

  return (
    <div style={{ transform: `scale(${scale})`, transformOrigin: 'top left' }} onMouseDown={() => onHold?.(id)}>
      <div className="bg-white rounded-lg shadow border border-gray-200 w-44 group select-none">
        <SideHandles />
        <div className="p-2">
          {editing ? (
            <textarea
              autoFocus rows={2} value={title}
              onChange={e => setTitle(e.target.value)}
              onBlur={commitTitle}
              onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); commitTitle() } }}
              className="nodrag w-full text-sm resize-none focus:outline-none"
            />
          ) : (
            <p className="text-sm text-gray-800 cursor-pointer" onDoubleClick={() => setEditing(true)}>{data.title as string}</p>
          )}
        </div>
        <button
          className="absolute top-1 right-1 opacity-0 group-hover:opacity-100 p-0.5 rounded hover:bg-red-100 text-gray-400 hover:text-red-500"
          onClick={() => (data.onDelete as (id: string) => void)(id)}
        >
          <X size={11} />
        </button>
      </div>
    </div>
  )
}

// ── Shape Node ───────────────────────────────────────────────────────────────

export function ShapeNode({ id, data, selected }: NodeProps) {
  const shape = data.shape as string
  const fill = (data.fill as string) || '#93c5fd'
  const [editing, setEditing] = useState(false)
  const [text, setText] = useState((data.label as string) || '')
  const { updateNodeData } = useReactFlow()
  const onSave = data.onSave as SaveFn | undefined
  const onHold = data.onHold as ((id: string) => void) | undefined

  // Font size tracks the shape's actual rendered size (scroll-resize or drag-resize)
  const innerRef = useRef<HTMLDivElement>(null)
  const [fontSize, setFontSize] = useState(14)
  useEffect(() => {
    const el = innerRef.current
    if (!el) return
    const ro = new ResizeObserver(() => {
      const side = Math.min(el.clientWidth, el.clientHeight)
      setFontSize(Math.max(9, Math.min(64, Math.round(side * 0.22))))
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const shapeClass = shape === 'circle' ? 'rounded-full' : shape === 'diamond' ? 'rotate-45' : 'rounded-lg'

  function commit() {
    updateNodeData(id, { ...data, label: text })
    setEditing(false)
    onSave?.(id, { shape, fill, label: text })
  }

  return (
    <div className="relative group select-none w-full h-full" onMouseDown={() => onHold?.(id)}>
      {/* Drag the edges/corners to transform freely (shown when selected) */}
      <NodeResizer
        minWidth={40}
        minHeight={30}
        isVisible={!!selected}
        lineClassName="!border-blue-400"
        handleClassName="!bg-white !border-2 !border-blue-400 !w-2.5 !h-2.5 !rounded-sm"
        onResizeEnd={(_, p) => onSave?.(id, { shape, fill, label: text }, p.width, p.height)}
      />
      <SideHandles color="!bg-gray-500" />
      <div
        ref={innerRef}
        className={`w-full h-full flex items-center justify-center shadow ${shapeClass}`}
        style={{ backgroundColor: fill }}
        onClick={() => setEditing(true)}
        title="Click to edit text"
      >
        {editing ? (
          <textarea
            autoFocus
            value={text}
            onChange={e => setText(e.target.value)}
            onBlur={commit}
            onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); commit() } }}
            style={{ fontSize }}
            className={`nodrag w-4/5 h-3/5 resize-none text-center bg-white/20 rounded focus:outline-none text-white font-medium leading-tight ${shape === 'diamond' ? '-rotate-45' : ''}`}
          />
        ) : (
          <span style={{ fontSize }} className={`font-medium text-white text-center px-1 break-words leading-tight ${shape === 'diamond' ? '-rotate-45' : ''}`}>{text || '…'}</span>
        )}
      </div>
      <button
        className="absolute -top-2 -right-2 opacity-0 group-hover:opacity-100 bg-white rounded-full p-0.5 shadow text-gray-400 hover:text-red-500 z-10"
        onClick={() => (data.onDelete as (id: string) => void)(id)}
      >
        <X size={11} />
      </button>
    </div>
  )
}

// ── Text Node ────────────────────────────────────────────────────────────────

export function TextNode({ id, data }: NodeProps) {
  const { updateNodeData } = useReactFlow()
  const [editing, setEditing] = useState(!!data.autoEdit)
  const [text, setText] = useState((data.text as string) || '')
  const color = (data.color as string) || '#1f2937'
  const fontSize = (data.fontSize as number) || 18
  const onSave = data.onSave as SaveFn | undefined

  function commit() {
    updateNodeData(id, { ...data, text, autoEdit: false })
    setEditing(false)
    onSave?.(id, { text, color, fontSize })
  }

  return (
    <div className="relative group">
      <SideHandles color="!bg-gray-400" />
      {editing ? (
        <textarea
          autoFocus
          value={text}
          onChange={e => setText(e.target.value)}
          onBlur={commit}
          onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); commit() } }}
          placeholder="Type…"
          className="nodrag min-w-[120px] bg-white/90 rounded px-1.5 py-1 resize-none focus:outline-none shadow-sm"
          style={{ color, fontSize, fontWeight: 500 }}
          rows={2}
        />
      ) : (
        <div
          onClick={() => setEditing(true)}
          className="whitespace-pre-wrap px-1.5 py-1 cursor-text min-w-[40px]"
          style={{ color, fontSize, fontWeight: 500 }}
          title="Click to edit"
        >
          {text || 'Text'}
        </div>
      )}
      <button
        className="absolute -top-2 -right-2 opacity-0 group-hover:opacity-100 bg-white rounded-full p-0.5 shadow text-gray-400 hover:text-red-500 z-10"
        onClick={() => (data.onDelete as (id: string) => void)(id)}
      >
        <X size={11} />
      </button>
    </div>
  )
}

// ── Image Node ───────────────────────────────────────────────────────────────

export function ImageNode({ id, data }: NodeProps) {
  const scale = (data.scale as number) ?? 1
  const onHold = data.onHold as ((id: string) => void) | undefined

  return (
    <div style={{ transform: `scale(${scale})`, transformOrigin: 'top left' }} onMouseDown={() => onHold?.(id)}>
      <div className="relative group select-none rounded-lg overflow-hidden shadow-lg border border-gray-200" style={{ width: 200 }}>
        <SideHandles color="!bg-gray-500" />
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={data.url as string} alt={data.alt as string || 'image'} className="w-full object-cover max-h-48" draggable={false} />
        <button
          className="absolute top-1 right-1 opacity-0 group-hover:opacity-100 bg-white rounded-full p-0.5 shadow text-gray-400 hover:text-red-500"
          onClick={() => (data.onDelete as (id: string) => void)(id)}
        >
          <X size={11} />
        </button>
      </div>
    </div>
  )
}

// ── Drawing Node ─────────────────────────────────────────────────────────────

export function DrawingNode({ id, data }: NodeProps) {
  const pathData = data.path as string
  const color = (data.color as string) || '#1d4ed8'
  const strokeWidth = (data.strokeWidth as number) || 2
  const bbox = data.bbox as { width: number; height: number }
  const scale = (data.scale as number) ?? 1
  const onHold = data.onHold as ((id: string) => void) | undefined

  return (
    <div style={{ transform: `scale(${scale})`, transformOrigin: 'top left' }} onMouseDown={() => onHold?.(id)}>
      <div className="relative group select-none" style={{ width: bbox.width + 10, height: bbox.height + 10 }}>
        <svg width={bbox.width + 10} height={bbox.height + 10} className="overflow-visible" style={{ pointerEvents: 'none' }}>
          <path d={pathData} fill="none" stroke={color} strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round" />
        </svg>
        <button
          className="absolute top-0 right-0 opacity-0 group-hover:opacity-100 bg-white rounded-full p-0.5 shadow text-gray-400 hover:text-red-500"
          onClick={() => (data.onDelete as (id: string) => void)(id)}
        >
          <X size={11} />
        </button>
      </div>
    </div>
  )
}

// ── Sub-tab Node ─────────────────────────────────────────────────────────────

export function SubTabNode({ id, data }: NodeProps) {
  const name = data.name as string
  const color = (data.color as string) || '#0079bf'
  const mode = (data.mode as string) || 'classic'
  const boardId = data.boardId as string
  const onNavigate = data.onNavigate as (boardId: string) => void
  const onDelete = data.onDelete as (id: string) => void
  const onRename = data.onRename as ((boardId: string, name: string) => void) | undefined
  const onOpenPanel = data.onOpenPanel as ((boardId: string, rect: DOMRect) => void) | undefined
  const scale = (data.scale as number) ?? 1
  const onHold = data.onHold as ((id: string) => void) | undefined
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(name)
  const modeIcon = mode === 'classic' ? '🎨' : mode === 'text' ? '📝' : '🗂'

  function commitName() {
    setEditing(false)
    const next = draft.trim()
    if (next && next !== name) onRename?.(boardId, next)
  }

  return (
    <div style={{ transform: `scale(${scale})`, transformOrigin: 'top left' }} onMouseDown={() => onHold?.(id)}>
      <div className="relative group select-none bg-white rounded-xl shadow-lg border-l-4 w-44" style={{ borderLeftColor: color }}>
        <SideHandles />

        <div className="p-3">
          <div className="flex items-center gap-1 mb-2">
            <span className="text-sm">{modeIcon}</span>
            {editing ? (
              <input
                autoFocus
                value={draft}
                onChange={e => setDraft(e.target.value)}
                onBlur={commitName}
                onKeyDown={e => { if (e.key === 'Enter') commitName(); if (e.key === 'Escape') { setDraft(name); setEditing(false) } }}
                className="nodrag flex-1 min-w-0 text-xs font-semibold text-gray-800 border-b border-blue-400 focus:outline-none"
              />
            ) : (
              <span
                className="text-xs font-semibold text-gray-800 truncate flex-1 cursor-text"
                onDoubleClick={() => { setDraft(name); setEditing(true) }}
                title="Double-click to rename"
              >
                {name}
              </span>
            )}
            <button
              className="p-0.5 rounded hover:bg-gray-100 text-gray-400 hover:text-gray-700 shrink-0"
              title="Tab options"
              onClick={e => { e.stopPropagation(); onOpenPanel?.(boardId, (e.currentTarget as HTMLButtonElement).getBoundingClientRect()) }}
            >
              <ChevronDown size={12} />
            </button>
          </div>
          <button
            className="flex items-center gap-1 text-[11px] text-blue-600 hover:text-blue-800 font-medium"
            onClick={() => onNavigate(boardId)}
          >
            <ExternalLink size={10} /> Open
          </button>
        </div>

        <button
          className="absolute top-1.5 right-1.5 opacity-0 group-hover:opacity-100 p-0.5 rounded hover:bg-red-100 text-gray-300 hover:text-red-500"
          onClick={() => onDelete(id)}
        >
          <X size={11} />
        </button>
      </div>
    </div>
  )
}

// ── Portal Node ──────────────────────────────────────────────────────────────
// A resizable window that shows a live, read-only view of another tab (board).

type PortalContent = {
  lists: { id: string; name: string; x: number; y: number }[]
  cards: { id: string; list_id: string; title: string; x: number; y: number }[]
  elements: { id: string; type: string; x: number; y: number; width: number | null; height: number | null; data: Record<string, unknown> }[]
}

function MiniUnit({ el }: { el: PortalContent['elements'][number] }) {
  const d = el.data || {}
  if (el.type === 'shape') {
    const shape = d.shape as string
    const cls = shape === 'circle' ? 'rounded-full' : shape === 'diamond' ? 'rotate-45' : 'rounded-lg'
    return <div style={{ position: 'absolute', left: el.x, top: el.y, width: el.width ?? 120, height: el.height ?? 80, backgroundColor: (d.fill as string) || '#93c5fd' }} className={`shadow ${cls}`} />
  }
  if (el.type === 'text') {
    return <div style={{ position: 'absolute', left: el.x, top: el.y, color: (d.color as string) || '#1f2937', fontSize: (d.fontSize as number) || 18, fontWeight: 500 }} className="whitespace-pre-wrap">{(d.text as string) || 'Text'}</div>
  }
  if (el.type === 'image') {
    /* eslint-disable-next-line @next/next/no-img-element */
    return <img src={d.url as string} alt="" style={{ position: 'absolute', left: el.x, top: el.y, width: 200 }} className="rounded-lg shadow" draggable={false} />
  }
  if (el.type === 'drawing') {
    const bbox = (d.bbox as { width: number; height: number }) || { width: 50, height: 50 }
    return (
      <svg style={{ position: 'absolute', left: el.x, top: el.y, overflow: 'visible' }} width={bbox.width + 10} height={bbox.height + 10}>
        <path d={d.path as string} fill="none" stroke={(d.color as string) || '#1d4ed8'} strokeWidth={(d.strokeWidth as number) || 2} strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    )
  }
  return null
}

export function PortalNode({ id, data, selected }: NodeProps) {
  const targetBoardId = (data.targetBoardId as string | null) ?? null
  const home = (data.home as string | null) ?? null
  const onSave = data.onSave as SaveFn | undefined
  const onOpenFully = data.onOpenFully as ((boardId: string) => void) | undefined
  const onHold = data.onHold as ((id: string) => void) | undefined

  const { updateNodeData } = useReactFlow()
  const [choosing, setChoosing] = useState(false)
  const [boards, setBoards] = useState<{ id: string; name: string; color: string }[]>([])
  const [content, setContent] = useState<PortalContent | null>(null)
  const [targetMode, setTargetMode] = useState<string>('classic')
  const [text, setText] = useState('')
  const [pan, setPan] = useState({ x: (data.vx as number) ?? 20, y: (data.vy as number) ?? 20 })
  const [zoom, setZoom] = useState((data.zoom as number) ?? 0.4)
  const panRef = useRef<{ sx: number; sy: number; vx: number; vy: number } | null>(null)
  const fittedRef = useRef<string | null>(null)
  const textTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const contentElRef = useRef<HTMLDivElement>(null)

  function persist(patch: Record<string, unknown>) {
    const next = { targetBoardId, home, vx: pan.x, vy: pan.y, zoom, width: data.width, height: data.height, ...patch }
    updateNodeData(id, next)
    onSave?.(id, next, data.width as number | undefined, data.height as number | undefined)
  }

  useEffect(() => {
    let cancel = false
    import('@/lib/supabase/client').then(({ createClient }) => {
      createClient().from('boards').select('id,name,color').order('created_at').then(({ data: b }) => { if (!cancel) setBoards(b ?? []) })
    })
    return () => { cancel = true }
  }, [])

  useEffect(() => {
    if (!targetBoardId) { setContent(null); return }
    let cancel = false
    import('@/lib/supabase/client').then(async ({ createClient }) => {
      const s = createClient()
      const { data: bd } = await s.from('boards').select('mode,content').eq('id', targetBoardId).single()
      if (!cancel) { setTargetMode((bd?.mode as string) ?? 'classic'); setText((bd?.content as string) ?? '') }
      if ((bd?.mode as string) === 'text') { if (!cancel) setContent({ lists: [], cards: [], elements: [] }); return }
      const [{ data: lists }, { data: elements }] = await Promise.all([
        s.from('lists').select('id,name,x,y').eq('board_id', targetBoardId),
        s.from('board_elements').select('id,type,x,y,width,height,data').eq('board_id', targetBoardId),
      ])
      const listIds = (lists ?? []).map(l => l.id)
      const cardsRes = listIds.length ? await s.from('cards').select('id,list_id,title,x,y').in('list_id', listIds) : { data: [] }
      if (cancel) return
      const c: PortalContent = { lists: lists ?? [], cards: cardsRes.data ?? [], elements: elements ?? [] }
      setContent(c)
      // Auto-fit the view to the content the first time this target loads
      if (fittedRef.current !== targetBoardId) {
        fittedRef.current = targetBoardId
        const xs: number[] = [], ys: number[] = [], xe: number[] = [], ye: number[] = []
        c.lists.forEach(l => { xs.push(l.x); ys.push(l.y); xe.push(l.x + 208); ye.push(l.y + 60) })
        c.cards.forEach(cd => { xs.push(cd.x); ys.push(cd.y); xe.push(cd.x + 176); ye.push(cd.y + 50) })
        c.elements.forEach(el => { xs.push(el.x); ys.push(el.y); xe.push(el.x + (el.width ?? 140)); ye.push(el.y + (el.height ?? 100)) })
        if (xs.length) {
          const minX = Math.min(...xs), minY = Math.min(...ys), maxX = Math.max(...xe), maxY = Math.max(...ye)
          const pw = (data.width as number) || 320, ph = ((data.height as number) || 220) - 24
          const fit = Math.max(0.08, Math.min(1, Math.min(pw / (maxX - minX + 80), ph / (maxY - minY + 80))))
          const nx = (pw - (maxX - minX) * fit) / 2 - minX * fit
          const ny = (ph - (maxY - minY) * fit) / 2 - minY * fit + 24
          setZoom(fit); setPan({ x: nx, y: ny })
        }
      }
    })
    return () => { cancel = true }
  }, [targetBoardId]) // eslint-disable-line react-hooks/exhaustive-deps

  const target = boards.find(b => b.id === targetBoardId)
  const isText = targetMode === 'text'

  // Scroll to zoom inside a (non-text) portal without zooming the main board
  useEffect(() => {
    const el = contentElRef.current
    if (!el || isText) return
    function onWheel(e: WheelEvent) {
      e.preventDefault(); e.stopPropagation()
      setZoom(z => Math.max(0.05, Math.min(3, z * (e.deltaY > 0 ? 0.9 : 1.1))))
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [targetBoardId, isText])

  function onContentPointerDown(e: React.PointerEvent) {
    if (isText) return
    e.stopPropagation()
    ;(e.currentTarget as Element).setPointerCapture?.(e.pointerId)
    panRef.current = { sx: e.clientX, sy: e.clientY, vx: pan.x, vy: pan.y }
  }
  function onContentPointerMove(e: React.PointerEvent) {
    if (!panRef.current) return
    e.stopPropagation()
    setPan({ x: panRef.current.vx + (e.clientX - panRef.current.sx), y: panRef.current.vy + (e.clientY - panRef.current.sy) })
  }
  function onContentPointerUp(e: React.PointerEvent) {
    if (!panRef.current) return
    e.stopPropagation()
    panRef.current = null
    persist({ vx: pan.x, vy: pan.y, zoom })
  }

  function onTextChange(value: string) {
    setText(value)
    if (!targetBoardId) return
    if (textTimer.current) clearTimeout(textTimer.current)
    textTimer.current = setTimeout(() => { updateBoardContent(targetBoardId, value).catch(() => {}) }, 600)
  }

  return (
    <div className="relative group w-full h-full" onMouseDown={() => onHold?.(id)}>
      <NodeResizer
        minWidth={120}
        minHeight={90}
        isVisible={!!selected}
        lineClassName="!border-fuchsia-400"
        handleClassName="!bg-white !border-2 !border-fuchsia-400 !w-2.5 !h-2.5 !rounded-sm"
        onResizeEnd={(_, p) => persist({ width: p.width, height: p.height })}
      />
      <SideHandles color="!bg-fuchsia-500" />

      <div className="w-full h-full rounded-lg overflow-hidden shadow-lg ring-1 ring-fuchsia-400/40 bg-[#1d2125] relative">
        {targetBoardId && isText && (
          <textarea
            value={text}
            onChange={e => onTextChange(e.target.value)}
            onPointerDown={e => e.stopPropagation()}
            placeholder="Start writing…"
            className="nodrag nowheel absolute inset-0 pt-7 px-4 pb-3 w-full h-full resize-none focus:outline-none bg-white text-gray-800 text-sm leading-6"
            style={{ fontFamily: 'Georgia, serif' }}
          />
        )}

        {targetBoardId && !isText && (
          <div
            ref={contentElRef}
            className="nodrag nowheel absolute inset-0 cursor-grab active:cursor-grabbing"
            style={{ backgroundColor: target?.color ?? '#0079bf' }}
            onPointerDown={onContentPointerDown}
            onPointerMove={onContentPointerMove}
            onPointerUp={onContentPointerUp}
          >
            <div style={{ position: 'absolute', transformOrigin: '0 0', transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})` }}>
              {content?.lists.map(l => (
                <div key={l.id} style={{ position: 'absolute', left: l.x, top: l.y }} className="bg-[#ebecf0] rounded-xl shadow px-3 py-2 w-52 text-sm font-semibold text-gray-800">{l.name}</div>
              ))}
              {content?.cards.map(c => (
                <div key={c.id} style={{ position: 'absolute', left: c.x, top: c.y }} className="bg-white rounded-lg shadow border border-gray-200 w-44 p-2 text-sm text-gray-800">{c.title}</div>
              ))}
              {content?.elements.map(el => <MiniUnit key={el.id} el={el} />)}
            </div>
          </div>
        )}

        {(!targetBoardId) && (
          <div className="absolute inset-0 flex items-center justify-center border-2 border-dashed border-fuchsia-400/60">
            <button
              onClick={e => { e.stopPropagation(); setChoosing(v => !v) }}
              className="nodrag bg-fuchsia-500 hover:bg-fuchsia-600 text-white text-xs px-3 py-1.5 rounded-lg shadow"
            >
              Choose a tab…
            </button>
          </div>
        )}

        {/* top bar: drag handle to move the portal + actions */}
        <div className="absolute top-0 left-0 right-0 h-6 bg-black/40 flex items-center justify-between px-1.5 text-white/80 text-[10px]">
          <span className="truncate">{target ? `↪ ${target.name}` : 'Portal'}</span>
          <div className="flex items-center gap-0.5">
            {targetBoardId && (
              <button className="nodrag p-0.5 rounded hover:bg-white/20" title="Change tab" onClick={e => { e.stopPropagation(); setChoosing(v => !v) }}><ChevronDown size={11} /></button>
            )}
            {targetBoardId && (
              <button className="nodrag p-0.5 rounded hover:bg-white/20" title="Open this tab fully" onClick={e => { e.stopPropagation(); onOpenFully?.(targetBoardId) }}><Maximize2 size={11} /></button>
            )}
            <button className="nodrag p-0.5 rounded hover:bg-red-500/50" title="Remove portal" onClick={e => { e.stopPropagation(); (data.onDelete as (id: string) => void)(id) }}><X size={11} /></button>
          </div>
        </div>

        {choosing && (
          <div className="nodrag absolute top-7 right-1.5 z-10 bg-white rounded-lg shadow-xl border border-gray-200 py-1 w-40 max-h-44 overflow-y-auto">
            {boards.length === 0 && <p className="px-3 py-1.5 text-xs text-gray-400">Loading…</p>}
            {boards.filter(b => b.id !== home).map(b => (
              <button
                key={b.id}
                onClick={e => {
                  e.stopPropagation()
                  setChoosing(false)
                  fittedRef.current = null // re-fit to the new target
                  persist({ targetBoardId: b.id })
                  // Mirror a portal back on the target tab
                  if (home) ensureMirrorPortal(b.id, home).catch(() => {})
                }}
                className="w-full flex items-center gap-2 px-3 py-1.5 text-xs text-gray-700 hover:bg-gray-100 text-left"
              >
                <span className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: b.color }} />
                <span className="truncate">{b.name}</span>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
