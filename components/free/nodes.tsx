'use client'

import {
  Handle, Position, NodeProps, useReactFlow, NodeResizer,
  BaseEdge, EdgeLabelRenderer, getBezierPath, type EdgeProps,
} from '@xyflow/react'
import { useState, useEffect, useRef, useCallback, useMemo } from 'react'
import { Plus, X, ExternalLink, ChevronDown, Maximize2, Lock, LockOpen, Check, Clock, EyeOff, Repeat, FileText, Download, Folder, ArrowLeft, Link2, Unlink, FileType, BarChart2, Presentation } from 'lucide-react'
import { updateBoardContent, ensureMirrorPortal, updateTextFile, createSubTab, getPdfUrl, getPresignedReadUrl } from '@/app/actions'
import { useRouter } from 'next/navigation'
import StockPortal from './StockPortal'
import SlidesPortal from './SlidesPortal'
import GoogleCalendarPortal from './GoogleCalendarPortal'
import GoogleSheetsPortal from './GoogleSheetsPortal'
import GoogleDocsPortal from './GoogleDocsPortal'
import ClaudeChat from '@/components/claude/ClaudeChat'
import { ClaudeMark } from '@/components/claude/ClaudeMark'
import { recurLabel } from '@/lib/recur'
import { downloadTextFile, PORTAL_ITEM_MIME } from '@/lib/files'
import { activeDocBody, withActiveBody } from '@/lib/doctabs'

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

// Edge you can grab and pull to bend, with a hover delete button
export function DeletableEdge({ id, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, markerEnd, style, data }: EdgeProps) {
  const { screenToFlowPosition } = useReactFlow()
  const [hover, setHover] = useState(false)
  const [drag, setDrag] = useState<{ x: number; y: number } | null>(null)
  const onDelete = data?.onDelete as ((id: string) => void) | undefined
  const onReshape = data?.onReshape as ((id: string, offset: { cx: number; cy: number }) => void) | undefined
  const onColor = data?.onColor as ((id: string, color: string) => void) | undefined
  const deletable = (data?.deletable as boolean) ?? true
  const colorInputRef = useRef<HTMLInputElement>(null)

  const strokeColor = (data?.color as string | undefined) ?? (style?.stroke as string | undefined) ?? '#3b82f6'
  const effectiveStyle = { ...style, stroke: strokeColor }

  const mx = (sourceX + targetX) / 2
  const my = (sourceY + targetY) / 2
  const saved = { x: (data?.cx as number) ?? 0, y: (data?.cy as number) ?? 0 }
  const off = drag ?? saved
  const bent = off.x !== 0 || off.y !== 0

  // control point so the curve passes through (mx+off, my+off)
  const cpx = mx + 2 * off.x
  const cpy = my + 2 * off.y
  // straight (with no bend) keeps a small natural bezier; with bend, quadratic through the grab point
  const straight = getBezierPath({ sourceX, sourceY, sourcePosition, targetX, targetY, targetPosition })[0]
  const edgePath = bent ? `M ${sourceX},${sourceY} Q ${cpx},${cpy} ${targetX},${targetY}` : straight
  const handleX = mx + off.x
  const handleY = my + off.y

  function onPointerDown(e: React.PointerEvent<SVGPathElement>) {
    if (!deletable) return
    e.stopPropagation()
    ;(e.currentTarget as Element).setPointerCapture?.(e.pointerId)
    const f = screenToFlowPosition({ x: e.clientX, y: e.clientY })
    setDrag({ x: f.x - mx, y: f.y - my })
  }
  function onPointerMove(e: React.PointerEvent<SVGPathElement>) {
    if (!drag) return
    e.stopPropagation()
    const f = screenToFlowPosition({ x: e.clientX, y: e.clientY })
    setDrag({ x: f.x - mx, y: f.y - my })
  }
  function onPointerUp(e: React.PointerEvent<SVGPathElement>) {
    if (!drag) return
    e.stopPropagation()
    ;(e.currentTarget as Element).releasePointerCapture?.(e.pointerId)
    onReshape?.(id, { cx: drag.x, cy: drag.y })
    setDrag(null)
  }

  return (
    <>
      <BaseEdge id={id} path={edgePath} markerEnd={markerEnd} style={effectiveStyle} />
      {/* wide invisible hit area: hover to reveal controls, drag to bend the link */}
      <path
        d={edgePath}
        fill="none"
        stroke="transparent"
        strokeWidth={18}
        style={{ pointerEvents: 'stroke', cursor: deletable ? 'grab' : 'default' }}
        onMouseEnter={() => setHover(true)}
        onMouseLeave={() => setHover(false)}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
      />
      {deletable && (hover || drag) && (
        <EdgeLabelRenderer>
          <div
            className="nodrag nopan"
            style={{ position: 'absolute', transform: `translate(-50%, -50%) translate(${handleX}px, ${handleY}px)`, pointerEvents: 'all' }}
            onMouseEnter={() => setHover(true)}
            onMouseLeave={() => setHover(false)}
          >
            <div className="flex items-center gap-1">
              <span className="w-2.5 h-2.5 rounded-full border-2 border-white shadow" style={{ background: strokeColor }} title="Drag the link to bend it" />
              {onColor && (
                <>
                  <button
                    onClick={() => colorInputRef.current?.click()}
                    title="Change link colour"
                    className="w-4 h-4 rounded-full border-2 border-white shadow cursor-pointer"
                    style={{ background: strokeColor }}
                  />
                  <input
                    ref={colorInputRef}
                    type="color"
                    className="sr-only"
                    value={strokeColor.startsWith('#') ? strokeColor : '#3b82f6'}
                    onChange={e => onColor(id, e.target.value)}
                  />
                </>
              )}
              <button
                onClick={() => onDelete?.(id)}
                title="Remove link"
                className="bg-white rounded-full p-0.5 shadow border border-red-200 text-red-500 hover:bg-red-50"
              >
                <X size={11} />
              </button>
              {bent && (
                <button
                  onClick={() => onReshape?.(id, { cx: 0, cy: 0 })}
                  title="Straighten link"
                  className="bg-white rounded-full px-1 shadow border border-gray-200 text-gray-500 hover:bg-gray-50 text-[9px]"
                >
                  ⟲
                </button>
              )}
            </div>
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
  const [done, setDone] = useState(!!(data.done as boolean))
  const { updateNodeData } = useReactFlow()
  const scale = (data.scale as number) ?? 1
  const onHold = data.onHold as ((id: string) => void) | undefined
  const onRename = data.onRename as ((id: string, title: string) => void) | undefined
  const onToggleDone = data.onToggleDone as ((id: string, done: boolean) => void) | undefined

  function commitTitle() {
    updateNodeData(id, { ...data, title })
    setEditing(false)
    onRename?.(id, title)
  }

  function handleToggleDone(e: React.MouseEvent) {
    e.stopPropagation()
    const next = !done
    setDone(next)
    updateNodeData(id, { ...data, done: next })
    onToggleDone?.(id, next)
  }

  return (
    <div style={{ transform: `scale(${scale})`, transformOrigin: 'top left' }} onMouseDown={() => onHold?.(id)}>
      <div className="bg-white rounded-lg shadow border border-gray-200 w-44 group select-none">
        <SideHandles />
        <div className="p-2 flex items-start gap-1.5">
          <button
            className={`nodrag mt-0.5 shrink-0 w-3.5 h-3.5 rounded border flex items-center justify-center transition-colors ${done ? 'bg-blue-500 border-blue-500' : 'border-gray-300 hover:border-blue-400'}`}
            onPointerDown={e => e.stopPropagation()}
            onClick={handleToggleDone}
          >
            {done && <Check size={9} className="text-white" />}
          </button>
          {editing ? (
            <textarea
              autoFocus rows={2} value={title}
              onChange={e => setTitle(e.target.value)}
              onBlur={commitTitle}
              onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); commitTitle() } }}
              className="nodrag w-full text-sm resize-none focus:outline-none"
            />
          ) : (
            <div className="flex-1 min-w-0">
              <p className={`text-sm cursor-pointer ${done ? 'line-through text-gray-400' : 'text-gray-800'}`} onDoubleClick={() => setEditing(true)}>{data.title as string}</p>
              {data.recur != null && (
                <span className="mt-0.5 inline-flex items-center gap-0.5 text-[9px] font-medium text-indigo-500">
                  <Repeat size={8} /> {recurLabel(data.recur as number)}
                </span>
              )}
            </div>
          )}
        </div>
        <div className="absolute top-1 right-1 opacity-0 group-hover:opacity-100 flex gap-0.5">
          <button
            className="p-0.5 rounded hover:bg-gray-100 text-gray-400 hover:text-gray-600"
            onPointerDown={e => e.stopPropagation()}
            onClick={e => { e.stopPropagation(); (data.onHide as (id: string) => void)?.(id) }}
            title="Hide (unhide from dashboard)"
          >
            <EyeOff size={11} />
          </button>
          <button
            className="p-0.5 rounded hover:bg-red-100 text-gray-400 hover:text-red-500"
            onClick={() => (data.onDelete as (id: string) => void)(id)}
          >
            <X size={11} />
          </button>
        </div>
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
      <button
        className="absolute top-0 right-5 opacity-0 group-hover:opacity-100 bg-white rounded-full p-0.5 shadow text-gray-400 hover:text-gray-600 z-10"
        title="Hide (unhide from dashboard)"
        onClick={e => { e.stopPropagation(); (data.onHide as (id: string) => void)?.(id) }}
      >
        <EyeOff size={11} />
      </button>
    </div>
  )
}

// ── Sticky Note Node ─────────────────────────────────────────────────────────

const NOTE_COLORS = [
  { label: 'Yellow', value: 'rgba(254,240,64,0.95)' },
  { label: 'Pink',   value: 'rgba(255,182,193,0.95)' },
  { label: 'Blue',   value: 'rgba(147,197,253,0.95)' },
  { label: 'Green',  value: 'rgba(134,239,172,0.95)' },
  { label: 'Purple', value: 'rgba(196,181,253,0.95)' },
  { label: 'Orange', value: 'rgba(253,186,116,0.95)' },
  { label: 'White',  value: 'rgba(255,255,255,0.95)' },
  { label: 'None',   value: 'transparent' },
]

export function TextNode({ id, data, selected }: NodeProps) {
  const { updateNodeData } = useReactFlow()
  const [text, setText] = useState((data.text as string) || '')
  const [showColorPicker, setShowColorPicker] = useState(false)
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  const color = (data.color as string) || '#1f2937'
  const fontSize = (data.fontSize as number) || 12
  const bgColor = (data.bgColor as string) || 'rgba(254,240,64,0.95)'
  const onSave = data.onSave as SaveFn | undefined

  // Auto-focus when freshly placed on the board
  useEffect(() => {
    if (data.autoEdit) {
      const t = setTimeout(() => textareaRef.current?.focus(), 30)
      return () => clearTimeout(t)
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  function save(t: string) {
    updateNodeData(id, { ...data, text: t, autoEdit: false })
    onSave?.(id, { text: t, color, fontSize, bgColor })
  }

  function setNoteColor(value: string) {
    setShowColorPicker(false)
    updateNodeData(id, { ...data, bgColor: value })
    onSave?.(id, { text, color, fontSize, bgColor: value })
  }

  const hasBg = bgColor !== 'transparent'

  return (
    <div
      className="relative group w-full h-full flex flex-col"
      style={{
        backgroundColor: bgColor,
        borderRadius: 4,
        boxShadow: '2px 3px 10px rgba(0,0,0,0.20)',
      }}
    >
      <NodeResizer
        minWidth={120}
        minHeight={80}
        isVisible={!!selected}
        lineClassName="!border-blue-400"
        handleClassName="!bg-white !border-2 !border-blue-400 !w-2.5 !h-2.5 !rounded-sm"
        onResizeEnd={(_, p) => onSave?.(id, { text, color, fontSize, bgColor }, p.width, p.height)}
      />
      <SideHandles color="!bg-yellow-400" />

      {/* Header strip — drag handle + action buttons */}
      <div
        className="shrink-0 h-5 flex items-center justify-end px-1 gap-0.5 cursor-grab"
        style={{ backgroundColor: hasBg ? 'rgba(0,0,0,0.07)' : 'rgba(0,0,0,0.04)' }}
      >
        <button
          className="opacity-0 group-hover:opacity-100 p-0.5 rounded text-gray-500 hover:text-gray-700"
          title="Note colour"
          onClick={e => { e.stopPropagation(); setShowColorPicker(v => !v) }}
        >
          <div className="w-3 h-3 rounded-full border border-gray-400/60" style={{ backgroundColor: hasBg ? bgColor : '#f3f4f6' }} />
        </button>
        <button
          className="opacity-0 group-hover:opacity-100 p-0.5 rounded text-gray-400 hover:text-gray-600"
          title="Hide (unhide from dashboard)"
          onClick={e => { e.stopPropagation(); (data.onHide as (id: string) => void)?.(id) }}
        >
          <EyeOff size={10} />
        </button>
        <button
          className="opacity-0 group-hover:opacity-100 p-0.5 rounded text-gray-400 hover:text-red-500"
          onClick={() => (data.onDelete as (id: string) => void)(id)}
        >
          <X size={10} />
        </button>
      </div>

      {/* Note body — textarea fills the rest */}
      <textarea
        ref={textareaRef}
        value={text}
        onChange={e => setText(e.target.value)}
        onBlur={() => save(text)}
        placeholder="Type…"
        className="nodrag flex-1 bg-transparent resize-none focus:outline-none px-2 pb-2 leading-snug"
        style={{ color, fontSize }}
      />

      {/* Colour picker popup */}
      {showColorPicker && (
        <div
          className="nodrag absolute top-5 right-0 z-50 bg-white rounded-xl shadow-xl border border-gray-200 p-2 flex flex-wrap gap-1.5"
          style={{ minWidth: 148 }}
          onPointerDown={e => e.stopPropagation()}
        >
          {NOTE_COLORS.map(p => (
            <button
              key={p.value}
              title={p.label}
              onClick={e => { e.stopPropagation(); setNoteColor(p.value) }}
              className="w-6 h-6 rounded-full border-2 border-gray-300 hover:border-gray-600 shrink-0"
              style={{ backgroundColor: p.value === 'transparent' ? '#f3f4f6' : p.value }}
            />
          ))}
        </div>
      )}
    </div>
  )
}

// ── Text-file Node (a draggable file block on the canvas) ─────────────────────

export function TextFileNode({ id, data }: NodeProps) {
  const { updateNodeData } = useReactFlow()
  const [editing, setEditing] = useState(false)
  const [name, setName] = useState((data.name as string) || 'Untitled.txt')
  const [content, setContent] = useState((data.content as string) || '')
  const [fetchingContent, setFetchingContent] = useState(false)
  const onSave = data.onSave as SaveFn | undefined
  const expired = data.deadline ? new Date(data.deadline as string) < new Date() : false
  const isR2 = !!(data.storagePath as string | undefined)

  async function openEditor() {
    if (isR2 && !content) {
      setFetchingContent(true)
      try {
        const r = await getPresignedReadUrl(data.storagePath as string)
        if (r.ok && r.url) {
          const res = await fetch(r.url)
          if (res.ok) setContent(await res.text())
        }
      } catch {}
      setFetchingContent(false)
    }
    setEditing(true)
  }

  function commit() {
    const next: Record<string, unknown> = { name }
    if (!isR2) next.content = content
    if (data.hidden) next.hidden = true
    if (typeof data.opacity === 'number') next.opacity = data.opacity
    updateNodeData(id, { ...data, name, ...(isR2 ? {} : { content }) })
    setEditing(false)
    if (isR2) {
      updateTextFile(id.replace(/^el-/, ''), name, content, '').catch(() => {})
    } else {
      onSave?.(id, next)
    }
  }

  return (
    <div className="relative group">
      <SideHandles color="!bg-indigo-400" />
      {editing ? (
        <div className="nodrag bg-white rounded-lg shadow-lg border border-indigo-300 w-64 p-2" onPointerDown={e => e.stopPropagation()}>
          <input
            value={name}
            onChange={e => setName(e.target.value)}
            className="w-full text-xs font-medium text-gray-700 border-b border-gray-200 pb-1 mb-1 focus:outline-none"
            placeholder="filename.txt"
          />
          <textarea
            autoFocus
            value={content}
            onChange={e => setContent(e.target.value)}
            onKeyDown={e => { if (e.key === 'Escape') commit() }}
            rows={8}
            className="w-full text-xs text-gray-800 font-mono resize-none focus:outline-none"
            placeholder="File contents…"
          />
          <div className="flex justify-between items-center pt-1">
            <button
              onClick={() => downloadTextFile(name || 'file.txt', content)}
              className="flex items-center gap-1 text-[11px] text-gray-500 hover:text-indigo-600"
              title="Download"
            >
              <Download size={12} /> Download
            </button>
            <button onClick={commit} className="text-xs bg-indigo-500 hover:bg-indigo-600 text-white px-2 py-0.5 rounded">Done</button>
          </div>
        </div>
      ) : (
        <div
          className="bg-white rounded-lg shadow border border-gray-200 w-44 select-none cursor-pointer overflow-hidden"
          onDoubleClick={openEditor}
          title="Double-click to open"
        >
          <div className="flex items-center gap-1.5 px-2 py-1.5 bg-indigo-50 border-b border-indigo-100">
            {fetchingContent
              ? <span className="text-[10px] text-indigo-400 animate-pulse">Loading…</span>
              : <><FileText size={13} className="text-indigo-500 shrink-0" /><span className="text-[11px] font-medium text-gray-700 truncate">{name}</span></>}
          </div>
          <p className="px-2 py-1.5 text-[10px] text-gray-500 font-mono whitespace-pre-wrap line-clamp-4 break-words min-h-[2.5rem]">
            {isR2
              ? <span className="italic text-gray-300">cloud file</span>
              : (content || <span className="italic text-gray-300">empty</span>)}
          </p>
        </div>
      )}
      <button
        className="absolute -top-2 -right-2 opacity-0 group-hover:opacity-100 bg-white rounded-full p-0.5 shadow text-gray-400 hover:text-red-500 z-10"
        onClick={() => (data.onDelete as (id: string) => void)(id)}
      >
        <X size={11} />
      </button>
      <button
        className="absolute -top-2 right-3 opacity-0 group-hover:opacity-100 bg-white rounded-full p-0.5 shadow text-gray-400 hover:text-gray-600 z-10"
        title="Hide (unhide from dashboard)"
        onClick={e => { e.stopPropagation(); (data.onHide as (id: string) => void)?.(id) }}
      >
        <EyeOff size={11} />
      </button>
      <button
        className="absolute -top-2 -left-2 opacity-0 group-hover:opacity-100 bg-white rounded-full p-0.5 shadow z-10"
        style={{ color: expired ? '#ef4444' : '#9ca3af' }}
        title={data.deadline ? `Expires ${new Date(data.deadline as string).toLocaleDateString()}` : 'Set expiry'}
        onClick={e => { e.stopPropagation(); (data.onSetExpiry as (id: string) => void)?.(id) }}
      >
        <Clock size={11} />
      </button>
    </div>
  )
}

// ── PDF Node (a file block that opens the stored PDF in a new tab) ────────────

export function PdfNode({ id, data }: NodeProps) {
  const name = (data.name as string) || 'Document.pdf'
  const storagePath = data.storagePath as string | undefined
  const pageCount = data.pageCount as number | undefined
  const expired = data.deadline ? new Date(data.deadline as string) < new Date() : false
  const [opening, setOpening] = useState(false)

  async function open() {
    if (!storagePath || opening) return
    setOpening(true)
    // Open a blank tab synchronously (before the await) so popup blockers allow it,
    // then point it at the freshly-signed URL.
    const w = window.open('', '_blank')
    try {
      const res = await getPdfUrl(storagePath)
      if (res.ok && res.url && w) w.location.href = res.url
      else if (w) w.close()
    } catch {
      if (w) w.close()
    } finally {
      setOpening(false)
    }
  }

  return (
    <div className="relative group">
      <SideHandles color="!bg-red-400" />
      <div
        className="nodrag bg-white rounded-lg shadow border border-gray-200 w-44 select-none cursor-pointer overflow-hidden hover:border-red-300 transition-colors"
        onDoubleClick={open}
        title="Double-click to open the PDF in a new tab"
      >
        <div className="flex items-center gap-1.5 px-2 py-1.5 bg-red-50 border-b border-red-100">
          <FileType size={13} className="text-red-500 shrink-0" />
          <span className="text-[11px] font-medium text-gray-700 truncate">{name}</span>
        </div>
        <div className="px-2 py-2 flex items-center justify-between">
          <span className="text-[10px] text-gray-400">{pageCount ? `${pageCount} page${pageCount === 1 ? '' : 's'}` : 'PDF'}</span>
          <button
            onClick={e => { e.stopPropagation(); open() }}
            disabled={opening || !storagePath}
            className="flex items-center gap-1 text-[10px] text-red-500 hover:text-red-700 disabled:opacity-40"
          >
            <ExternalLink size={11} /> {opening ? 'Opening…' : 'Open'}
          </button>
        </div>
      </div>
      <button
        className="absolute -top-2 -right-2 opacity-0 group-hover:opacity-100 bg-white rounded-full p-0.5 shadow text-gray-400 hover:text-red-500 z-10"
        onClick={() => (data.onDelete as (id: string) => void)(id)}
      >
        <X size={11} />
      </button>
      <button
        className="absolute -top-2 right-3 opacity-0 group-hover:opacity-100 bg-white rounded-full p-0.5 shadow text-gray-400 hover:text-gray-600 z-10"
        title="Hide (unhide from dashboard)"
        onClick={e => { e.stopPropagation(); (data.onHide as (id: string) => void)?.(id) }}
      >
        <EyeOff size={11} />
      </button>
      <button
        className="absolute -top-2 -left-2 opacity-0 group-hover:opacity-100 bg-white rounded-full p-0.5 shadow z-10"
        style={{ color: expired ? '#ef4444' : '#9ca3af' }}
        title={data.deadline ? `Expires ${new Date(data.deadline as string).toLocaleDateString()}` : 'Set expiry'}
        onClick={e => { e.stopPropagation(); (data.onSetExpiry as (id: string) => void)?.(id) }}
      >
        <Clock size={11} />
      </button>
    </div>
  )
}

// ── Folder-link Node (a live shortcut to a folder board on the canvas) ────────

export function FolderLinkNode({ id, data }: NodeProps) {
  const name = (data.name as string) || 'Folder'
  const targetBoardId = data.targetBoardId as string
  const onNavigate = data.onNavigate as ((boardId: string) => void) | undefined
  const onDecouple = data.onDecouple as ((nodeId: string) => void) | undefined

  return (
    <div className="relative group select-none">
      <SideHandles color="!bg-fuchsia-500" />
      <div
        onDoubleClick={() => targetBoardId && onNavigate?.(targetBoardId)}
        className="bg-white rounded-xl shadow-lg border-l-4 border-fuchsia-400 w-40 p-3 cursor-pointer hover:shadow-xl transition-shadow"
        title="Linked folder — double-click to open"
      >
        <div className="flex items-center gap-1.5">
          <span className="relative shrink-0">
            <Folder size={22} className="text-blue-400 fill-blue-100" />
            <Link2 size={10} className="absolute -bottom-1 -right-1 text-fuchsia-500 bg-white rounded-full" />
          </span>
          <span className="text-sm font-medium text-gray-700 truncate flex-1">{name}</span>
        </div>
        <p className="text-[9px] text-fuchsia-500 mt-1">Linked folder · live</p>
      </div>

      <div className="absolute -top-2 -right-2 opacity-0 group-hover:opacity-100 flex gap-0.5">
        <button
          className="bg-white rounded-full p-0.5 shadow text-gray-400 hover:text-fuchsia-600"
          title="Decouple — turn this into an independent copy"
          onClick={e => { e.stopPropagation(); onDecouple?.(id) }}
        >
          <Unlink size={11} />
        </button>
        <button
          className="bg-white rounded-full p-0.5 shadow text-gray-400 hover:text-gray-600"
          title="Hide (unhide from dashboard)"
          onClick={e => { e.stopPropagation(); (data.onHide as (id: string) => void)?.(id) }}
        >
          <EyeOff size={11} />
        </button>
        <button
          className="bg-white rounded-full p-0.5 shadow text-gray-400 hover:text-red-500"
          title="Remove link (keeps the original folder)"
          onClick={e => { e.stopPropagation(); (data.onDelete as (id: string) => void)(id) }}
        >
          <X size={11} />
        </button>
      </div>
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
  const modeIcon = mode === 'classic' ? '🎨' : mode === 'text' ? '📝' : mode === 'folder' ? '📁' : mode === 'spreadsheet' ? '📊' : '🗂'

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

// ── Claude Node ──────────────────────────────────────────────────────────────
// A resizable chat that lives on the canvas. Claude here is scoped to the board
// it sits on (data.boardId) and everything reachable downward from it.

export function ClaudeNode({ id, data, selected }: NodeProps) {
  const boardId = data.boardId as string
  return (
    <div className="relative group w-full h-full">
      <NodeResizer
        minWidth={260}
        minHeight={260}
        isVisible={!!selected}
        lineClassName="!border-[#D97757]"
        handleClassName="!bg-white !border-2 !border-[#D97757] !w-2.5 !h-2.5 !rounded-sm"
      />
      <SideHandles color="!bg-[#D97757]" />
      <div className="claude-node-glow w-full h-full rounded-xl overflow-hidden ring-1 ring-[#D97757]/40 bg-[#30302E] flex flex-col">
        {/* Drag handle / title bar (dragging here moves the node) */}
        <div className="h-8 bg-[#262624] flex items-center justify-between px-2.5 text-[#F0EEE6] shrink-0">
          <span className="flex items-center gap-1.5 text-xs font-medium"><ClaudeMark size={14} animate /> Claude</span>
          <button
            className="nodrag p-0.5 rounded hover:bg-white/15 text-[#F0EEE6]/70 hover:text-[#F0EEE6]"
            title="Remove Claude"
            onClick={e => { e.stopPropagation(); (data.onDelete as (id: string) => void)(id) }}
          >
            <X size={12} />
          </button>
        </div>
        {boardId
          ? <ClaudeChat boardId={boardId} nodeId={id} />
          : <p className="text-white/40 text-xs p-4">No board context.</p>}
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
  edges: { id: string; source: string; target: string }[]
}

function MiniUnit({ el }: { el: PortalContent['elements'][number] }) {
  const d = el.data || {}
  if (el.type === 'shape') {
    const shape = d.shape as string
    const cls = shape === 'circle' ? 'rounded-full' : shape === 'diamond' ? 'rotate-45' : 'rounded-lg'
    const w = el.width ?? 120, h = el.height ?? 80
    const label = (d.label as string) || ''
    const fontSize = Math.max(9, Math.min(64, Math.round(Math.min(w, h) * 0.22)))
    return (
      <div style={{ position: 'absolute', left: el.x, top: el.y, width: w, height: h }}>
        <div className={`w-full h-full flex items-center justify-center shadow ${cls}`} style={{ backgroundColor: (d.fill as string) || '#93c5fd' }}>
          {label && <span className={`text-white font-medium text-center px-1 break-words ${shape === 'diamond' ? '-rotate-45' : ''}`} style={{ fontSize }}>{label}</span>}
        </div>
      </div>
    )
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

function PortalEdges({ content }: { content: PortalContent }) {
  // center point (flow coords) of a node referenced by an edge endpoint id
  const center = (nodeId: string): { x: number; y: number } | null => {
    if (nodeId.startsWith('list-')) {
      const l = content.lists.find(x => `list-${x.id}` === nodeId)
      return l ? { x: l.x + 104, y: l.y + 30 } : null
    }
    if (nodeId.startsWith('card-')) {
      const c = content.cards.find(x => `card-${x.id}` === nodeId)
      return c ? { x: c.x + 88, y: c.y + 25 } : null
    }
    if (nodeId.startsWith('el-')) {
      const e = content.elements.find(x => `el-${x.id}` === nodeId)
      return e ? { x: e.x + (e.width ?? 140) / 2, y: e.y + (e.height ?? 100) / 2 } : null
    }
    return null
  }
  const manual = content.edges.map(e => ({ a: center(e.source), b: center(e.target), key: e.id, color: '#3b82f6', dash: undefined as string | undefined }))
  const auto = content.cards.map(c => ({ a: center(`list-${c.list_id}`), b: center(`card-${c.id}`), key: `auto-${c.id}`, color: '#94a3b8', dash: '4 3' }))
  const lines = [...auto, ...manual].filter(l => l.a && l.b)
  return (
    <svg style={{ position: 'absolute', left: 0, top: 0, width: 1, height: 1, overflow: 'visible', pointerEvents: 'none' }}>
      {lines.map(l => (
        <line key={l.key} x1={l.a!.x} y1={l.a!.y} x2={l.b!.x} y2={l.b!.y} stroke={l.color} strokeWidth={2} strokeDasharray={l.dash} vectorEffect="non-scaling-stroke" />
      ))}
    </svg>
  )
}

type FolderContent = {
  folders: { id: string; name: string; color: string; mode: string }[]
  files: { id: string; name: string; content: string; storagePath?: string }[]
}
const MODE_EMOJI: Record<string, string> = { classic: '🎨', trello: '🗂', text: '📝', folder: '📁' }

export function PortalNode({ id, data, selected }: NodeProps) {
  const targetBoardId = (data.targetBoardId as string | null) ?? null
  const targetBoardName = (data.targetBoardName as string | null) ?? null
  const home = (data.home as string | null) ?? null
  const locked = (data.locked as boolean) ?? false
  const fitted = (data.fitted as boolean) ?? false
  const onSave = data.onSave as SaveFn | undefined
  const onOpenFully = data.onOpenFully as ((boardId: string) => void) | undefined
  const onHold = data.onHold as ((id: string) => void) | undefined

  const { updateNodeData } = useReactFlow()
  const router = useRouter()

  // Viewer mode — when set, the portal embeds a built-in viewer instead of a board tab
  const viewerKind   = (data.viewerKind   as string | undefined)                          ?? null
  const viewerConfig = (data.viewerConfig as { ticker?: string; interval?: string } | undefined) ?? {}

  const [choosing, setChoosing] = useState(false)
  const [accessToken, setAccessToken] = useState<string | null>(null)
  const [boards, setBoards] = useState<{ id: string; name: string; color: string; parent_id: string | null }[]>([])
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [content, setContent] = useState<PortalContent | null>(null)
  const [folderContent, setFolderContent] = useState<FolderContent | null>(null)
  const [viewMode, setViewMode] = useState<string>('classic')
  const [viewName, setViewName] = useState<string>('')
  const [viewColor, setViewColor] = useState<string>('#0079bf')
  const [text, setText] = useState('')
  // Internal navigation: a stack of board ids browsed into (base target excluded),
  // plus an optionally-open text file. The "out" button pops these.
  const [stack, setStack] = useState<string[]>([])
  const [openFile, setOpenFile] = useState<{ id: string; name: string; content: string; storagePath?: string } | null>(null)
  const [pan, setPan] = useState({ x: (data.vx as number) ?? 20, y: (data.vy as number) ?? 20 })
  const [zoom, setZoom] = useState((data.zoom as number) ?? 0.4)
  const panRef = useRef<{ sx: number; sy: number; vx: number; vy: number } | null>(null)
  const fittedRef = useRef<string | null>(null)
  const textTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const fileTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const contentElRef = useRef<HTMLDivElement>(null)
  const rawContentRef = useRef<string>('') // raw boards.content for the viewed text board

  const viewId = stack.length ? stack[stack.length - 1] : targetBoardId
  const isBase = viewId === targetBoardId
  const isText = viewMode === 'text'
  const isFolder = viewMode === 'folder'
  const isPannable = !isText && !isFolder
  const canGoBack = !!openFile || stack.length > 0

  function navInto(boardId: string) { setOpenFile(null); setStack(prev => [...prev, boardId]) }
  function navOut() { if (openFile) { setOpenFile(null); return } setStack(prev => prev.slice(0, -1)) }

  function persist(patch: Record<string, unknown>) {
    // Always carry forward viewer fields and the Claude context blob so they
    // aren't lost on unrelated persists (pan/zoom/resize).
    const next = {
      targetBoardId, home,
      ...(targetBoardName ? { targetBoardName } : {}),
      vx: pan.x, vy: pan.y, zoom,
      width: data.width, height: data.height,
      locked: data.locked,
      fitted: data.fitted,
      ...(viewerKind   ? { viewerKind }   : {}),
      ...(Object.keys(viewerConfig).length ? { viewerConfig } : {}),
      ...(data.viewer_context != null ? { viewer_context: data.viewer_context } : {}),
      ...patch,
    }
    updateNodeData(id, next)
    onSave?.(id, next, data.width as number | undefined, data.height as number | undefined)
  }

  // Reset internal navigation whenever the base target changes.
  useEffect(() => { setStack([]); setOpenFile(null) }, [targetBoardId])

  useEffect(() => {
    import('@/lib/supabase/client').then(({ createClient }) => {
      createClient().auth.getSession().then(({ data: { session } }) => {
        setAccessToken(session?.access_token ?? null)
      })
    })
  }, [])

  useEffect(() => {
    let cancel = false
    import('@/lib/supabase/client').then(({ createClient }) => {
      createClient().from('boards').select('id,name,color,parent_id').order('tab_position', { ascending: true }).then(({ data: b }) => { if (!cancel) setBoards(b ?? []) })
    })
    return () => { cancel = true }
  }, [])

  // Load whatever board is currently being viewed (base target or navigated-into).
  useEffect(() => {
    if (!viewId) { setContent(null); setFolderContent(null); return }
    let cancel = false
    import('@/lib/supabase/client').then(async ({ createClient }) => {
      const s = createClient()
      const { data: bd } = await s.from('boards').select('mode,content,name,color').eq('id', viewId).single()
      if (cancel) return
      const mode = (bd?.mode as string) ?? 'classic'
      setViewMode(mode); setViewName((bd?.name as string) ?? ''); setViewColor((bd?.color as string) ?? '#0079bf')
      rawContentRef.current = (bd?.content as string) ?? ''
      setText(activeDocBody(bd?.content as string))

      if (mode === 'text') { setContent(null); setFolderContent(null); return }

      if (mode === 'folder') {
        const [{ data: subs }, { data: els }] = await Promise.all([
          s.from('boards').select('id,name,color,mode').eq('parent_id', viewId).order('tab_position', { ascending: true }),
          s.from('board_elements').select('id,data').eq('board_id', viewId).eq('type', 'textfile').order('created_at', { ascending: true }),
        ])
        if (cancel) return
        setFolderContent({
          folders: subs ?? [],
          files: (els ?? []).map(e => ({
            id: e.id,
            name: ((e.data as Record<string, unknown>)?.name as string) ?? 'Untitled',
            content: ((e.data as Record<string, unknown>)?.content as string) ?? '',
            storagePath: (e.data as Record<string, unknown>)?.storagePath as string | undefined,
          })),
        })
        setContent(null)
        return
      }

      // classic / trello → pannable mini canvas
      const [{ data: lists }, { data: elements }, { data: edges }] = await Promise.all([
        s.from('lists').select('id,name,x,y').eq('board_id', viewId),
        s.from('board_elements').select('id,type,x,y,width,height,data').eq('board_id', viewId),
        s.from('board_edges').select('id,source,target').eq('board_id', viewId),
      ])
      const listIds = (lists ?? []).map(l => l.id)
      const cardsRes = listIds.length ? await s.from('cards').select('id,list_id,title,x,y').in('list_id', listIds) : { data: [] }
      if (cancel) return
      const c: PortalContent = { lists: lists ?? [], cards: cardsRes.data ?? [], elements: elements ?? [], edges: edges ?? [] }
      setContent(c); setFolderContent(null)
      // Auto-fit once per viewed board. The base view respects a saved/locked view.
      const shouldFit = isBase ? (!locked && !fitted && fittedRef.current !== viewId) : fittedRef.current !== viewId
      if (shouldFit) {
        fittedRef.current = viewId
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
          if (isBase) persist({ vx: nx, vy: ny, zoom: fit, fitted: true })
        }
      }
    })
    return () => { cancel = true }
  }, [viewId]) // eslint-disable-line react-hooks/exhaustive-deps

  const target = boards.find(b => b.id === targetBoardId)

  // Scroll inside a pannable portal view: plain scroll = pan, Ctrl/Meta+scroll = zoom.
  // Both prevent the event from reaching the main canvas.
  useEffect(() => {
    const el = contentElRef.current
    if (!el || !isPannable || locked) return
    function onWheel(e: WheelEvent) {
      e.preventDefault(); e.stopPropagation()
      if (e.ctrlKey || e.metaKey) {
        setZoom(z => Math.max(0.05, Math.min(3, z * (e.deltaY > 0 ? 0.9 : 1.1))))
      } else {
        setPan(p => ({ x: p.x - e.deltaX, y: p.y - e.deltaY }))
      }
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [viewId, isPannable, locked])

  function onContentPointerDown(e: React.PointerEvent) {
    if (!isPannable || locked) return
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
    if (isBase) persist({ vx: pan.x, vy: pan.y, zoom })
  }

  function onTextChange(value: string) {
    setText(value)
    if (!viewId) return
    // Write back into the active doc-tab body so multi-page docs aren't clobbered.
    const merged = withActiveBody(rawContentRef.current, value)
    rawContentRef.current = merged
    if (textTimer.current) clearTimeout(textTimer.current)
    textTimer.current = setTimeout(() => { updateBoardContent(viewId, merged).catch(() => {}) }, 600)
  }

  function onFileChange(value: string) {
    if (!openFile || !viewId) return
    const { id: fid, name } = openFile
    setOpenFile({ id: fid, name, content: value })
    if (fileTimer.current) clearTimeout(fileTimer.current)
    fileTimer.current = setTimeout(() => { updateTextFile(fid, name, value, viewId).catch(() => {}) }, 600)
  }

  function toggleLock() {
    persist({ locked: !locked, vx: pan.x, vy: pan.y, zoom, fitted: true })
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
        {/* Open file viewer (inside a folder) */}
        {targetBoardId && openFile && (
          <textarea
            value={openFile.content}
            onChange={e => onFileChange(e.target.value)}
            onPointerDown={e => e.stopPropagation()}
            placeholder="Empty file"
            className="nodrag nowheel absolute inset-0 pt-7 px-3 pb-3 w-full h-full resize-none focus:outline-none bg-white text-gray-800 text-[13px] font-mono leading-5"
          />
        )}

        {/* Text board — satellite editor */}
        {viewId && !openFile && isText && (
          <iframe
            src={`https://text.syncedsys.com/board/${viewId}?embed=true${accessToken ? `&token=${accessToken}` : ''}`}
            className="nodrag nowheel absolute left-0 right-0 bottom-0 border-0"
            style={{ top: 24 }}
            title={viewName || 'Text editor'}
          />
        )}

        {/* Folder explorer — browse freely */}
        {targetBoardId && !openFile && isFolder && (
          <div className="nodrag nowheel absolute inset-0 pt-7 overflow-auto bg-gray-50" onPointerDown={e => e.stopPropagation()}>
            {folderContent && folderContent.folders.length === 0 && folderContent.files.length === 0 ? (
              <p className="text-center text-gray-400 text-xs mt-6">Empty folder</p>
            ) : (
              <div className="grid gap-1 p-2" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(60px, 1fr))' }}>
                {folderContent?.folders.map(f => (
                  <button
                    key={f.id}
                    draggable
                    onDragStart={e => { e.dataTransfer.setData(PORTAL_ITEM_MIME, JSON.stringify({ kind: 'folder', boardId: f.id, name: f.name })); e.dataTransfer.effectAllowed = 'copy' }}
                    onClick={e => { e.stopPropagation(); navInto(f.id) }}
                    className="flex flex-col items-center gap-0.5 p-1.5 rounded hover:bg-blue-100"
                    title={`${f.name} — drag onto the canvas to copy`}
                  >
                    <span className="relative">
                      <Folder size={30} className="text-blue-400 fill-blue-100" />
                      {f.mode !== 'folder' && <span className="absolute -bottom-1 -right-1 text-[9px]">{MODE_EMOJI[f.mode] ?? ''}</span>}
                    </span>
                    <span className="text-[9px] text-gray-700 text-center leading-tight line-clamp-2 break-words">{f.name}</span>
                  </button>
                ))}
                {folderContent?.files.map(file => (
                  <button
                    key={file.id}
                    draggable
                    onDragStart={e => { e.dataTransfer.setData(PORTAL_ITEM_MIME, JSON.stringify({ kind: 'file', name: file.name, content: file.content, storagePath: file.storagePath })); e.dataTransfer.effectAllowed = 'copy' }}
                    onClick={async e => {
                      e.stopPropagation()
                      if (file.storagePath && !file.content) {
                        try {
                          const r = await getPresignedReadUrl(file.storagePath)
                          const text = r.ok && r.url ? await (await fetch(r.url)).text() : ''
                          setOpenFile({ ...file, content: text })
                        } catch { setOpenFile(file) }
                      } else {
                        setOpenFile(file)
                      }
                    }}
                    className="flex flex-col items-center gap-0.5 p-1.5 rounded hover:bg-indigo-100"
                    title={`${file.name} — drag onto the canvas to copy`}
                  >
                    <FileText size={28} className="text-indigo-400" />
                    <span className="text-[9px] text-gray-700 text-center leading-tight line-clamp-2 break-words">{file.name}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
        )}

        {/* Classic / Trello mini-canvas */}
        {targetBoardId && !openFile && isPannable && (
          <div
            ref={contentElRef}
            className={`nodrag nowheel absolute inset-0 ${locked ? 'cursor-default' : 'cursor-grab active:cursor-grabbing'}`}
            style={{ backgroundColor: viewColor }}
            onPointerDown={onContentPointerDown}
            onPointerMove={onContentPointerMove}
            onPointerUp={onContentPointerUp}
          >
            <div style={{ position: 'absolute', transformOrigin: '0 0', transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})` }}>
              {content && <PortalEdges content={content} />}
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

        {/* ── Stock Viewer portal ────────────────────────────────────────── */}
        {viewerKind === 'stocks' && (
          <StockPortal
            config={viewerConfig}
            onPersistConfig={cfg => persist({ viewerKind: 'stocks', viewerConfig: cfg })}
            onUpdateContext={ctx => persist({ viewer_context: ctx })}
          />
        )}
        {viewerKind === 'slides' && (
          <SlidesPortal
            config={viewerConfig as { presentationId?: string }}
            onPersistConfig={cfg => persist({ viewerKind: 'slides', viewerConfig: cfg })}
            onUpdateContext={ctx => persist({ viewer_context: ctx })}
          />
        )}
        {viewerKind === 'google-calendar' && (
          <GoogleCalendarPortal
            config={viewerConfig as { view?: 'month' | 'week' | 'day' }}
            onPersistConfig={cfg => persist({ viewerKind: 'google-calendar', viewerConfig: cfg })}
            onUpdateContext={ctx => persist({ viewer_context: ctx })}
          />
        )}
        {viewerKind === 'google-sheets' && (
          <GoogleSheetsPortal
            config={viewerConfig as { spreadsheetId?: string; activeSheet?: string }}
            onPersistConfig={cfg => persist({ viewerKind: 'google-sheets', viewerConfig: cfg })}
            onUpdateContext={ctx => persist({ viewer_context: ctx })}
          />
        )}
        {viewerKind === 'google-docs' && (
          <GoogleDocsPortal
            config={viewerConfig as { documentId?: string }}
            onPersistConfig={cfg => persist({ viewerKind: 'google-docs', viewerConfig: cfg })}
            onUpdateContext={ctx => persist({ viewer_context: ctx })}
          />
        )}

        {/* Empty state — shown when nothing is chosen yet */}
        {(!targetBoardId && !viewerKind) && (
          <div className="absolute inset-0 flex items-center justify-center border-2 border-dashed border-fuchsia-400/60">
            <button
              onClick={e => { e.stopPropagation(); setChoosing(v => !v) }}
              className="nodrag bg-fuchsia-500 hover:bg-fuchsia-600 text-white text-xs px-3 py-1.5 rounded-lg shadow"
            >
              Choose…
            </button>
          </div>
        )}

        {/* top bar: drag handle to move the portal + actions */}
        <div className="absolute top-0 left-0 right-0 h-6 bg-black/40 flex items-center justify-between px-1.5 text-white/80 text-[10px]">
          <div className="flex items-center gap-1 min-w-0">
            {canGoBack && (
              <button
                className="nodrag p-0.5 rounded hover:bg-white/20 shrink-0"
                title="Out / back"
                onClick={e => { e.stopPropagation(); navOut() }}
              >
                <ArrowLeft size={11} />
              </button>
            )}
            <span className="truncate">
              {viewerKind === 'stocks'
                ? (viewerConfig.ticker ? `📈 ${viewerConfig.ticker}` : '📈 Stock Viewer')
                : viewerKind === 'slides'
                ? '🎨 Slides'
                : viewerKind === 'google-calendar'
                ? '📅 Google Calendar'
                : viewerKind === 'google-sheets'
                ? '📊 Google Sheets'
                : viewerKind === 'google-docs'
                ? '📄 Google Docs'
                : openFile
                  ? openFile.name
                  : (canGoBack ? (viewName || 'Folder') : (target ? `↪ ${target.name}` : 'Portal'))}
            </span>
          </div>
          <div className="flex items-center gap-0.5 shrink-0">
            {/* Lock — only for board portals */}
            {targetBoardId && isBase && !openFile && isPannable && (
              <button
                className={`nodrag p-0.5 rounded hover:bg-white/20 ${locked ? 'text-fuchsia-300' : ''}`}
                title={locked ? 'Unlock view (allow pan/zoom)' : 'Lock to this view'}
                onClick={e => { e.stopPropagation(); toggleLock() }}
              >
                {locked ? <Lock size={11} /> : <LockOpen size={11} />}
              </button>
            )}
            {/* Chevron: switch tab/viewer — shown for board portals and viewer portals */}
            {((targetBoardId && isBase && !locked) || viewerKind != null) && (
              <button className="nodrag p-0.5 rounded hover:bg-white/20" title="Change content" onClick={e => { e.stopPropagation(); setChoosing(v => !v) }}><ChevronDown size={11} /></button>
            )}
            {/* Maximize — board portal opens the tab; viewer portal navigates to /stocks */}
            {viewId && !openFile
              ? <button className="nodrag p-0.5 rounded hover:bg-white/20" title="Open this tab fully" onClick={e => { e.stopPropagation(); onOpenFully?.(viewId) }}><Maximize2 size={11} /></button>
              : viewerKind === 'stocks'
                ? <button className="nodrag p-0.5 rounded hover:bg-white/20" title="Open Stock Viewer" onClick={e => { e.stopPropagation(); router.push('/stocks') }}><Maximize2 size={11} /></button>
                : null
            }
            <button className="nodrag p-0.5 rounded hover:bg-red-500/50" title="Remove portal" onClick={e => { e.stopPropagation(); (data.onDelete as (id: string) => void)(id) }}><X size={11} /></button>
          </div>
        </div>

      </div>

      {/* Tab chooser — rendered OUTSIDE overflow-hidden so it is never clipped.
          onWheel stops scroll from zooming the main canvas while the list is open. */}
      {choosing && (() => {
        async function pickBoard(boardId: string) {
          setChoosing(false)
          fittedRef.current = null
          const bName = boards.find(b => b.id === boardId)?.name ?? null
          persist({ targetBoardId: boardId, targetBoardName: bName, viewerKind: null, viewerConfig: null, viewer_context: null })
          if (home) {
            const { createClient } = await import('@/lib/supabase/client')
            const { data: bd } = await createClient().from('boards').select('mode').eq('id', boardId).single()
            if (((bd?.mode as string) ?? 'classic') === 'classic') ensureMirrorPortal(boardId, home).catch(() => {})
          }
        }

        function pickViewer(kind: string) {
          setChoosing(false)
          // Clear any board target when switching to a viewer
          persist({ viewerKind: kind, viewerConfig: {}, targetBoardId: null })
        }

        const topBoards = boards.filter(b => !b.parent_id)
        const childrenOf = (pid: string) => boards.filter(b => b.parent_id === pid)

        return (
          <div
            className="nodrag nowheel absolute top-6 right-0 z-50 bg-white rounded-lg shadow-xl border border-gray-200 w-52 max-h-72 overflow-y-auto"
            onWheel={e => { e.stopPropagation(); e.nativeEvent.stopImmediatePropagation() }}
            onClick={e => e.stopPropagation()}
          >
            {/* ── Viewers section ─────────────────────────────────────────── */}
            <div className="px-3 pt-2 pb-1">
              <p className="text-[9px] font-semibold text-gray-400 uppercase tracking-wider mb-1">Viewers</p>
              <button
                onClick={e => { e.stopPropagation(); pickViewer('stocks') }}
                className={`w-full flex items-center gap-2 px-2 py-1.5 text-xs rounded-md text-left transition-colors ${
                  viewerKind === 'stocks'
                    ? 'bg-green-50 text-green-700'
                    : 'text-gray-700 hover:bg-green-50 hover:text-green-700'
                }`}
              >
                <BarChart2 size={12} className="text-green-500 shrink-0" />
                <span>Stock Viewer</span>
                {viewerKind === 'stocks' && <span className="ml-auto text-[9px] text-green-500">active</span>}
              </button>
              <button
                onClick={e => { e.stopPropagation(); pickViewer('slides') }}
                className={`w-full flex items-center gap-2 px-2 py-1.5 text-xs rounded-md text-left transition-colors ${
                  viewerKind === 'slides'
                    ? 'bg-indigo-50 text-indigo-700'
                    : 'text-gray-700 hover:bg-indigo-50 hover:text-indigo-700'
                }`}
              >
                <Presentation size={12} className="text-indigo-500 shrink-0" />
                <span>Slides Viewer</span>
                {viewerKind === 'slides' && <span className="ml-auto text-[9px] text-indigo-500">active</span>}
              </button>

              <p className="text-[9px] font-semibold text-gray-400 uppercase tracking-wider mb-1 mt-2">Google Workspace</p>
              <button
                onClick={e => { e.stopPropagation(); pickViewer('google-calendar') }}
                className={`w-full flex items-center gap-2 px-2 py-1.5 text-xs rounded-md text-left transition-colors ${
                  viewerKind === 'google-calendar'
                    ? 'bg-blue-50 text-blue-700'
                    : 'text-gray-700 hover:bg-blue-50 hover:text-blue-700'
                }`}
              >
                <span className="inline-flex h-3.5 w-3.5 items-center justify-center rounded-[3px] bg-gradient-to-br from-blue-500 via-red-500 to-yellow-500 text-white text-[7px] font-bold shrink-0">G</span>
                <span>Google Calendar</span>
                {viewerKind === 'google-calendar' && <span className="ml-auto text-[9px] text-blue-500">active</span>}
              </button>
              <button
                onClick={e => { e.stopPropagation(); pickViewer('google-sheets') }}
                className={`w-full flex items-center gap-2 px-2 py-1.5 text-xs rounded-md text-left transition-colors ${
                  viewerKind === 'google-sheets'
                    ? 'bg-green-50 text-green-700'
                    : 'text-gray-700 hover:bg-green-50 hover:text-green-700'
                }`}
              >
                <span className="inline-flex h-3.5 w-3.5 items-center justify-center rounded-[3px] bg-gradient-to-br from-green-500 to-emerald-600 text-white text-[7px] font-bold shrink-0">S</span>
                <span>Google Sheets</span>
                {viewerKind === 'google-sheets' && <span className="ml-auto text-[9px] text-green-500">active</span>}
              </button>
              <button
                onClick={e => { e.stopPropagation(); pickViewer('google-docs') }}
                className={`w-full flex items-center gap-2 px-2 py-1.5 text-xs rounded-md text-left transition-colors ${
                  viewerKind === 'google-docs'
                    ? 'bg-blue-50 text-blue-700'
                    : 'text-gray-700 hover:bg-blue-50 hover:text-blue-700'
                }`}
              >
                <span className="inline-flex h-3.5 w-3.5 items-center justify-center rounded-[3px] bg-gradient-to-br from-blue-500 to-blue-700 text-white text-[7px] font-bold shrink-0">D</span>
                <span>Google Docs</span>
                {viewerKind === 'google-docs' && <span className="ml-auto text-[9px] text-blue-500">active</span>}
              </button>
            </div>

            <div className="border-t border-gray-100 mx-0 my-1" />

            {/* ── Tabs section ────────────────────────────────────────────── */}
            <div className="px-3 pb-1 pt-0.5">
              <p className="text-[9px] font-semibold text-gray-400 uppercase tracking-wider mb-1">Tabs</p>
            </div>
            {boards.length === 0 && <p className="px-3 pb-2 text-xs text-gray-400">Loading…</p>}
            {topBoards.map(b => {
              const children = childrenOf(b.id)
              const isHome = b.id === home
              // home is always expanded so its children are visible
              const isExp = isHome || expanded.has(b.id)
              return (
                <div key={b.id}>
                  <div className="flex items-center">
                    <button
                      onClick={isHome ? undefined : async e => { e.stopPropagation(); await pickBoard(b.id) }}
                      className={`flex-1 flex items-center gap-2 px-3 py-1.5 text-xs text-left min-w-0 ${
                        isHome ? 'text-gray-400 cursor-default' : 'text-gray-700 hover:bg-gray-100'
                      }`}
                    >
                      <span className={`w-2 h-2 rounded-full shrink-0 ${isHome ? 'opacity-40' : ''}`} style={{ backgroundColor: b.color }} />
                      <span className="truncate">{b.name}</span>
                      {isHome && <span className="ml-auto text-[9px] text-gray-400 shrink-0">here</span>}
                    </button>
                    {children.length > 0 && !isHome && (
                      <button
                        onClick={e => { e.stopPropagation(); setExpanded(prev => { const n = new Set(prev); if (isExp) n.delete(b.id); else n.add(b.id); return n }) }}
                        className="px-2 py-1.5 text-gray-400 hover:text-gray-600 shrink-0"
                        title={isExp ? 'Collapse sub-tabs' : 'Show sub-tabs'}
                      >
                        <ChevronDown size={10} className={`transition-transform ${isExp ? 'rotate-180' : ''}`} />
                      </button>
                    )}
                  </div>
                  {isExp && children.map(c => {
                    const isChildHome = c.id === home
                    return (
                      <button
                        key={c.id}
                        onClick={isChildHome ? undefined : async e => { e.stopPropagation(); await pickBoard(c.id) }}
                        className={`w-full flex items-center gap-2 pl-6 pr-3 py-1.5 text-xs text-left ${
                          isChildHome ? 'text-gray-400 cursor-default' : 'text-gray-600 hover:bg-gray-100'
                        }`}
                      >
                        <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${isChildHome ? 'opacity-40' : ''}`} style={{ backgroundColor: c.color }} />
                        <span className="truncate">{c.name}</span>
                        {isChildHome && <span className="ml-auto text-[9px] text-gray-400 shrink-0">here</span>}
                      </button>
                    )
                  })}
                </div>
              )
            })}
            {home && (
              <button
                onClick={async e => {
                  e.stopPropagation()
                  setChoosing(false)
                  const homeBoard = boards.find(b => b.id === home)
                  const sub = await createSubTab(home, 'New tab', homeBoard?.color ?? '#0079bf', 'classic')
                  fittedRef.current = null
                  persist({ targetBoardId: sub.id, viewerKind: null, viewerConfig: null, viewer_context: null })
                }}
                className="w-full flex items-center gap-1.5 px-3 py-2 text-xs text-blue-600 hover:bg-blue-50 text-left border-t border-gray-100 mt-0.5"
              >
                <Plus size={10} /> New sub-tab here
              </button>
            )}
          </div>
        )
      })()}
    </div>
  )
}
