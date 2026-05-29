'use client'

import { Handle, Position, NodeProps, useReactFlow } from '@xyflow/react'
import { useState } from 'react'
import { Plus, X, ExternalLink } from 'lucide-react'
import { deleteElement } from '@/app/actions'

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
        <Handle type="target" position={Position.Top} className="!bg-blue-400 !w-3 !h-3" />
        <Handle type="target" position={Position.Left} className="!bg-blue-400 !w-3 !h-3" />
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
        <Handle type="source" position={Position.Bottom} className="!bg-blue-400 !w-3 !h-3" />
        <Handle type="source" position={Position.Right} className="!bg-blue-400 !w-3 !h-3" />
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
        <Handle type="target" position={Position.Top} className="!bg-blue-400 !w-3 !h-3" />
        <Handle type="target" position={Position.Left} className="!bg-blue-400 !w-3 !h-3" />
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
        <Handle type="source" position={Position.Bottom} className="!bg-blue-400 !w-3 !h-3" />
        <Handle type="source" position={Position.Right} className="!bg-blue-400 !w-3 !h-3" />
      </div>
    </div>
  )
}

// ── Shape Node ───────────────────────────────────────────────────────────────

export function ShapeNode({ id, data }: NodeProps) {
  const shape = data.shape as string
  const fill = (data.fill as string) || '#93c5fd'
  const [editing, setEditing] = useState(false)
  const [text, setText] = useState((data.label as string) || '')
  const { updateNodeData } = useReactFlow()
  const scale = (data.scale as number) ?? 1
  const onHold = data.onHold as ((id: string) => void) | undefined

  const shapeClass = shape === 'circle' ? 'rounded-full' : shape === 'diamond' ? 'rotate-45' : 'rounded-lg'

  return (
    <div style={{ transform: `scale(${scale})`, transformOrigin: 'top left' }} onMouseDown={() => onHold?.(id)}>
      <div className="relative group select-none" style={{ width: 120, height: 80 }}>
        <Handle type="target" position={Position.Top} className="!bg-gray-500 !w-3 !h-3" />
        <Handle type="target" position={Position.Left} className="!bg-gray-500 !w-3 !h-3" />
        <div className={`w-full h-full flex items-center justify-center shadow ${shapeClass}`} style={{ backgroundColor: fill }} onDoubleClick={() => setEditing(true)}>
          {editing ? (
            <input
              autoFocus value={text}
              onChange={e => setText(e.target.value)}
              onBlur={() => { updateNodeData(id, { ...data, label: text }); setEditing(false) }}
              onKeyDown={e => { if (e.key === 'Enter') { updateNodeData(id, { ...data, label: text }); setEditing(false) } }}
              className={`w-3/4 text-center text-xs bg-transparent border-b border-white focus:outline-none text-white font-medium ${shape === 'diamond' ? '-rotate-45' : ''}`}
            />
          ) : (
            <span className={`text-xs font-medium text-white text-center px-1 ${shape === 'diamond' ? '-rotate-45' : ''}`}>{text || '…'}</span>
          )}
        </div>
        <button
          className="absolute -top-2 -right-2 opacity-0 group-hover:opacity-100 bg-white rounded-full p-0.5 shadow text-gray-400 hover:text-red-500"
          onClick={() => (data.onDelete as (id: string) => void)(id)}
        >
          <X size={11} />
        </button>
        <Handle type="source" position={Position.Bottom} className="!bg-gray-500 !w-3 !h-3" />
        <Handle type="source" position={Position.Right} className="!bg-gray-500 !w-3 !h-3" />
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
        <Handle type="target" position={Position.Top} className="!bg-gray-500 !w-3 !h-3" />
        <Handle type="target" position={Position.Left} className="!bg-gray-500 !w-3 !h-3" />
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={data.url as string} alt={data.alt as string || 'image'} className="w-full object-cover max-h-48" draggable={false} />
        <button
          className="absolute top-1 right-1 opacity-0 group-hover:opacity-100 bg-white rounded-full p-0.5 shadow text-gray-400 hover:text-red-500"
          onClick={() => (data.onDelete as (id: string) => void)(id)}
        >
          <X size={11} />
        </button>
        <Handle type="source" position={Position.Bottom} className="!bg-gray-500 !w-3 !h-3" />
        <Handle type="source" position={Position.Right} className="!bg-gray-500 !w-3 !h-3" />
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
        <Handle type="target" position={Position.Top} className="!bg-blue-400 !w-3 !h-3" />
        <Handle type="target" position={Position.Left} className="!bg-blue-400 !w-3 !h-3" />

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

        <Handle type="source" position={Position.Bottom} className="!bg-blue-400 !w-3 !h-3" />
        <Handle type="source" position={Position.Right} className="!bg-blue-400 !w-3 !h-3" />
      </div>
    </div>
  )
}
