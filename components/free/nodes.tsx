'use client'

import {
  Handle, Position, NodeProps, useReactFlow, NodeResizer,
  BaseEdge, EdgeLabelRenderer, getBezierPath, type EdgeProps,
} from '@xyflow/react'
import { useState, useEffect, useRef } from 'react'
import { Plus, X, ExternalLink } from 'lucide-react'

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

  return (
    <div style={{ transform: `scale(${scale})`, transformOrigin: 'top left' }} onMouseDown={() => onHold?.(id)}>
      <div className="bg-white rounded-lg shadow border border-gray-200 w-44 group select-none">
        <SideHandles />
        <div className="p-2">
          {editing ? (
            <textarea
              autoFocus rows={2} value={title}
              onChange={e => setTitle(e.target.value)}
              onBlur={() => { updateNodeData(id, { ...data, title }); setEditing(false) }}
              onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); updateNodeData(id, { ...data, title }); setEditing(false) } }}
              className="w-full text-sm resize-none focus:outline-none"
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
  const scale = (data.scale as number) ?? 1
  const onHold = data.onHold as ((id: string) => void) | undefined
  const modeIcon = mode === 'classic' ? '🎨' : mode === 'text' ? '📝' : '🗂'

  return (
    <div style={{ transform: `scale(${scale})`, transformOrigin: 'top left' }} onMouseDown={() => onHold?.(id)}>
      <div className="relative group select-none bg-white rounded-xl shadow-lg border-l-4 w-44" style={{ borderLeftColor: color }}>
        <SideHandles />

        <div className="p-3">
          <div className="flex items-center gap-1.5 mb-2">
            <span className="text-sm">{modeIcon}</span>
            <span className="text-xs font-semibold text-gray-800 truncate flex-1">{name}</span>
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
