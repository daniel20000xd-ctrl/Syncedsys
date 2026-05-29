'use client'

import { useCallback, useRef, useState, useEffect } from 'react'
import {
  ReactFlow, Background, Controls, BackgroundVariant,
  useNodesState, useEdgesState, addEdge, ReactFlowProvider,
  useReactFlow, type Connection, type Node, type Edge,
  type NodeTypes, Panel,
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import { useRouter } from 'next/navigation'
import { MousePointer2, Pencil, Square, type LucideIcon } from 'lucide-react'
import type { Board, List, Card, BoardEdge, BoardElement } from '@/lib/types'
import {
  createList, createFreeCard, createEdge, deleteEdge, deleteBoard,
  createElement, deleteElement, updateListPosition, updateCardPosition,
  updateElement, createSubTab, updateBoardFreePosition,
} from '@/app/actions'
import { ListNode, CardNode, ShapeNode, ImageNode, DrawingNode, SubTabNode } from './nodes'

const nodeTypes: NodeTypes = {
  listNode: ListNode,
  cardNode: CardNode,
  shapeNode: ShapeNode,
  imageNode: ImageNode,
  drawingNode: DrawingNode,
  subTabNode: SubTabNode,
}

type Tool = 'select' | 'draw' | 'shape'

const TOOL_ICONS: Record<Tool, LucideIcon> = {
  select: MousePointer2,
  draw: Pencil,
  shape: Square,
}
type ShapeType = 'rect' | 'circle' | 'diamond'

const SHAPE_COLORS = ['#93c5fd','#6ee7b7','#fca5a5','#fcd34d','#c4b5fd','#f9a8d4']

function buildNodes(
  lists: List[], cards: Card[], elements: BoardElement[], subBoards: Board[],
  onAddCard: (listId: string) => void,
  onDeleteNode: (id: string, type: string) => void,
  onNavigate: (boardId: string) => void,
  onHold: (id: string) => void,
): Node[] {
  const listNodes: Node[] = lists.map((l, i) => ({
    id: `list-${l.id}`,
    type: 'listNode',
    position: { x: l.x || i * 240, y: l.y || 100 },
    data: {
      name: l.name,
      cardCount: cards.filter(c => c.list_id === l.id).length,
      onAddCard: (nodeId: string) => onAddCard(nodeId.replace('list-', '')),
      onDelete: (nodeId: string) => onDeleteNode(nodeId, 'list'),
      onHold,
    },
  }))

  const cardNodes: Node[] = cards.map(c => ({
    id: `card-${c.id}`,
    type: 'cardNode',
    position: { x: c.x || 0, y: c.y || 0 },
    data: {
      title: c.title,
      listId: c.list_id,
      onDelete: (nodeId: string) => onDeleteNode(nodeId, 'card'),
      onHold,
    },
  }))

  const elementNodes: Node[] = elements.map(el => ({
    id: `el-${el.id}`,
    type: el.type === 'shape' ? 'shapeNode' : el.type === 'image' ? 'imageNode' : 'drawingNode',
    position: { x: el.x, y: el.y },
    data: {
      ...el.data,
      onDelete: (nodeId: string) => onDeleteNode(nodeId, 'element'),
      onHold,
    },
  }))

  const subTabNodes: Node[] = subBoards.map((sb, i) => ({
    id: `sub-${sb.id}`,
    type: 'subTabNode',
    position: { x: sb.free_x || 500 + i * 200, y: sb.free_y || 400 },
    data: {
      boardId: sb.id,
      name: sb.name,
      color: sb.color,
      mode: sb.mode,
      onNavigate,
      onDelete: (nodeId: string) => onDeleteNode(nodeId, 'subtab'),
      onHold,
    },
  }))

  return [...listNodes, ...cardNodes, ...elementNodes, ...subTabNodes]
}

function buildEdges(cards: Card[], boardEdges: BoardEdge[]): Edge[] {
  const autoEdges: Edge[] = cards.map(c => ({
    id: `auto-${c.id}`,
    source: `list-${c.list_id}`,
    target: `card-${c.id}`,
    style: { stroke: '#94a3b8', strokeWidth: 1.5, strokeDasharray: '4 2' },
    animated: false,
  }))

  const manualEdges: Edge[] = boardEdges.map(e => ({
    id: e.id,
    source: e.source,
    target: e.target,
    sourceHandle: e.source_handle ?? undefined,
    targetHandle: e.target_handle ?? undefined,
    style: { stroke: '#3b82f6', strokeWidth: 2 },
    markerEnd: { type: 'arrowclosed' as const },
  }))

  return [...autoEdges, ...manualEdges]
}

interface Props {
  board: Board
  initialLists: List[]
  initialCards: Card[]
  initialEdges: BoardEdge[]
  initialElements: BoardElement[]
  initialSubBoards?: Board[]
}

function FlowCanvas({ board, initialLists, initialCards, initialEdges, initialElements, initialSubBoards = [] }: Props) {
  const router = useRouter()
  const { screenToFlowPosition } = useReactFlow()
  const [lists, setLists] = useState(initialLists)
  const [cards, setCards] = useState(initialCards)
  const [elements, setElements] = useState(initialElements)
  const [subBoards, setSubBoards] = useState(initialSubBoards)
  const [tool, setTool] = useState<Tool>('select')
  const [selectedShape, setSelectedShape] = useState<ShapeType>('rect')
  const [drawColor, setDrawColor] = useState('#1d4ed8')
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; flowX: number; flowY: number } | null>(null)
  const [shapeColorPicker, setShapeColorPicker] = useState<string>(SHAPE_COLORS[0])

  // Drawing state
  const drawingRef = useRef<{ points: { x: number; y: number }[] } | null>(null)
  const svgOverlayRef = useRef<SVGSVGElement>(null)
  const [currentPath, setCurrentPath] = useState<string>('')

  // Scale on hold+scroll
  const heldNodeRef = useRef<string | null>(null)
  const wrapperRef = useRef<HTMLDivElement>(null)
  const setNodesRef = useRef<typeof setNodes | null>(null)

  const navigate = useCallback((bid: string) => router.push(`/board/${bid}`), [router])

  function handleDeleteNode(nodeId: string, type: string) {
    if (type === 'list') {
      const rawId = nodeId.replace('list-', '')
      setLists(prev => prev.filter(l => l.id !== rawId))
      setCards(prev => prev.filter(c => c.list_id !== rawId))
    } else if (type === 'card') {
      const rawId = nodeId.replace('card-', '')
      setCards(prev => prev.filter(c => c.id !== rawId))
    } else if (type === 'element') {
      const rawId = nodeId.replace('el-', '')
      setElements(prev => prev.filter(e => e.id !== rawId))
      deleteElement(rawId)
    } else if (type === 'subtab') {
      const rawId = nodeId.replace('sub-', '')
      setSubBoards(prev => prev.filter(sb => sb.id !== rawId))
      deleteBoard(rawId)
    }
  }

  const holdNode = useCallback((id: string) => { heldNodeRef.current = id }, [])

  const [nodes, setNodes, onNodesChange] = useNodesState(
    buildNodes(lists, cards, elements, subBoards, () => {}, handleDeleteNode, navigate, holdNode)
  )
  const [edges, setEdges, onEdgesChange] = useEdgesState(buildEdges(cards, initialEdges))

  // Keep ref in sync so the wheel handler (in effect) can always call latest setNodes
  setNodesRef.current = setNodes

  // Hold + scroll to scale
  useEffect(() => {
    const el = wrapperRef.current
    if (!el) return
    function handleWheel(e: WheelEvent) {
      if (!heldNodeRef.current) return
      e.preventDefault()
      e.stopPropagation()
      const factor = e.deltaY > 0 ? 0.9 : 1.1
      setNodesRef.current!(prev => prev.map(n => {
        if (n.id !== heldNodeRef.current) return n
        const curr = (n.data.scale as number) ?? 1
        return { ...n, data: { ...n.data, scale: Math.max(0.2, Math.min(5, curr * factor)) } }
      }))
    }
    el.addEventListener('wheel', handleWheel, { passive: false })
    return () => el.removeEventListener('wheel', handleWheel)
  }, [])

  function handleWrapperMouseUp() {
    if (!heldNodeRef.current) return
    const heldId = heldNodeRef.current
    heldNodeRef.current = null
    // Persist scale for element nodes
    if (heldId.startsWith('el-')) {
      const rawId = heldId.replace('el-', '')
      const node = nodes.find(n => n.id === heldId)
      const el = elements.find(e => e.id === rawId)
      if (node && el) {
        const scale = (node.data.scale as number) ?? 1
        updateElement(rawId, { data: { ...el.data, scale } })
      }
    }
  }

  const onConnect = useCallback(async (connection: Connection) => {
    setEdges(eds => addEdge({ ...connection, style: { stroke: '#3b82f6', strokeWidth: 2 }, markerEnd: { type: 'arrowclosed' as const } }, eds))
    await createEdge(board.id, connection.source!, connection.target!, connection.sourceHandle ?? undefined, connection.targetHandle ?? undefined)
  }, [board.id, setEdges])

  const onEdgesDelete = useCallback(async (deleted: Edge[]) => {
    for (const e of deleted) {
      if (!e.id.startsWith('auto-')) await deleteEdge(e.id)
    }
  }, [])

  const onNodeDragStop = useCallback((_: unknown, node: Node) => {
    const { x, y } = node.position
    if (node.id.startsWith('list-')) updateListPosition(node.id.replace('list-', ''), x, y)
    else if (node.id.startsWith('card-')) updateCardPosition(node.id.replace('card-', ''), x, y)
    else if (node.id.startsWith('el-')) updateElement(node.id.replace('el-', ''), { x, y })
    else if (node.id.startsWith('sub-')) updateBoardFreePosition(node.id.replace('sub-', ''), x, y)
  }, [])

  async function handleAddCard(listId: string) {
    const list = lists.find(l => l.id === listId)
    if (!list) return
    const x = (list.x || 0) + 220
    const y = (list.y || 100) + cards.filter(c => c.list_id === listId).length * 80
    const card = await createFreeCard(listId, 'New card', board.id, x, y)
    setCards(prev => [...prev, card])
    setNodes(prev => [
      ...prev.map(n => n.id === `list-${listId}` ? { ...n, data: { ...n.data, cardCount: (n.data.cardCount as number) + 1 } } : n),
      {
        id: `card-${card.id}`, type: 'cardNode',
        position: { x, y },
        data: { title: card.title, listId, onDelete: (id: string) => handleDeleteNode(id, 'card') },
      },
    ])
    setEdges(prev => [...prev, {
      id: `auto-${card.id}`, source: `list-${listId}`, target: `card-${card.id}`,
      style: { stroke: '#94a3b8', strokeWidth: 1.5, strokeDasharray: '4 2' },
    }])
  }

  async function handleContextAction(action: string) {
    if (!contextMenu) return
    const { flowX: x, flowY: y } = contextMenu
    setContextMenu(null)

    if (action === 'list') {
      const list = await createList(board.id, 'New list')
      const newList = { ...list, x, y }
      setLists(prev => [...prev, newList])
      setNodes(prev => [...prev, {
        id: `list-${list.id}`, type: 'listNode', position: { x, y },
        data: { name: list.name, cardCount: 0, onAddCard: handleAddCard, onDelete: (id: string) => handleDeleteNode(id, 'list') },
      }])
    }

    if (action === 'card') {
      const firstList = lists[0]
      if (!firstList) return
      const card = await createFreeCard(firstList.id, 'New card', board.id, x, y)
      setCards(prev => [...prev, card])
      setNodes(prev => [...prev, {
        id: `card-${card.id}`, type: 'cardNode', position: { x, y },
        data: { title: card.title, listId: firstList.id, onDelete: (id: string) => handleDeleteNode(id, 'card') },
      }])
    }

    if (action === 'image') {
      const input = document.createElement('input')
      input.type = 'file'; input.accept = 'image/*'
      input.onchange = async e => {
        const file = (e.target as HTMLInputElement).files?.[0]
        if (!file) return
        const reader = new FileReader()
        reader.onload = async ev => {
          const url = ev.target?.result as string
          const el = await createElement(board.id, 'image', x, y, { url, alt: file.name })
          setElements(prev => [...prev, el])
          setNodes(prev => [...prev, {
            id: `el-${el.id}`, type: 'imageNode', position: { x, y },
            data: { url, alt: file.name, onDelete: (id: string) => handleDeleteNode(id, 'element') },
          }])
        }
        reader.readAsDataURL(file)
      }
      input.click()
    }

    if (action === 'subtab') {
      const count = subBoards.length
      const sub = await createSubTab(board.id, `Tab ${count + 1}`, board.color)
      await updateBoardFreePosition(sub.id, x, y)
      const newSub = { ...sub, free_x: x, free_y: y }
      setSubBoards(prev => [...prev, newSub])
      setNodes(prev => [...prev, {
        id: `sub-${sub.id}`, type: 'subTabNode', position: { x, y },
        data: { boardId: sub.id, name: sub.name, color: sub.color, mode: sub.mode, onNavigate: navigate, onDelete: (id: string) => handleDeleteNode(id, 'subtab') },
      }])
    }

    if (action === 'draw') setTool('draw')
    if (action === 'shape') setTool('shape')
  }

  // Drawing handlers
  function getOverlayPoint(e: React.MouseEvent<SVGSVGElement>) {
    const rect = e.currentTarget.getBoundingClientRect()
    return { x: e.clientX - rect.left, y: e.clientY - rect.top }
  }

  function onDrawStart(e: React.MouseEvent<SVGSVGElement>) {
    if (tool !== 'draw') return
    const pt = getOverlayPoint(e)
    drawingRef.current = { points: [pt] }
    setCurrentPath(`M ${pt.x} ${pt.y}`)
  }

  function onDrawMove(e: React.MouseEvent<SVGSVGElement>) {
    if (tool !== 'draw' || !drawingRef.current) return
    const pt = getOverlayPoint(e)
    drawingRef.current.points.push(pt)
    const pts = drawingRef.current.points
    setCurrentPath(pts.reduce((acc, p, i) => i === 0 ? `M ${p.x} ${p.y}` : `${acc} L ${p.x} ${p.y}`, ''))
  }

  async function onDrawEnd(e: React.MouseEvent<SVGSVGElement>) {
    if (tool !== 'draw' || !drawingRef.current) return
    const pts = drawingRef.current.points
    if (pts.length < 2) { drawingRef.current = null; setCurrentPath(''); return }
    const minX = Math.min(...pts.map(p => p.x))
    const minY = Math.min(...pts.map(p => p.y))
    const maxX = Math.max(...pts.map(p => p.x))
    const maxY = Math.max(...pts.map(p => p.y))
    const normalizedPath = pts.reduce((acc, p, i) =>
      i === 0 ? `M ${p.x - minX + 5} ${p.y - minY + 5}` : `${acc} L ${p.x - minX + 5} ${p.y - minY + 5}`, '')
    const flowPos = screenToFlowPosition({ x: minX, y: minY })
    const el = await createElement(board.id, 'drawing', flowPos.x, flowPos.y, {
      path: normalizedPath, color: drawColor, strokeWidth: 2,
      bbox: { width: maxX - minX, height: maxY - minY },
    })
    setElements(prev => [...prev, el])
    setNodes(prev => [...prev, {
      id: `el-${el.id}`, type: 'drawingNode', position: { x: flowPos.x, y: flowPos.y },
      data: { path: normalizedPath, color: drawColor, strokeWidth: 2, bbox: { width: maxX - minX, height: maxY - minY }, onDelete: (id: string) => handleDeleteNode(id, 'element') },
    }])
    drawingRef.current = null; setCurrentPath(''); setTool('select')
  }

  const shapeDragRef = useRef<{ x: number; y: number } | null>(null)

  function onShapeStart(e: React.MouseEvent<SVGSVGElement>) {
    if (tool !== 'shape') return
    shapeDragRef.current = getOverlayPoint(e)
  }

  async function onShapeEnd(e: React.MouseEvent<SVGSVGElement>) {
    if (tool !== 'shape' || !shapeDragRef.current) return
    const pt = getOverlayPoint(e)
    const { x: startX, y: startY } = shapeDragRef.current
    const w = Math.abs(pt.x - startX) || 100
    const h = Math.abs(pt.y - startY) || 80
    const x = Math.min(startX, pt.x)
    const y = Math.min(startY, pt.y)
    const flowPos = screenToFlowPosition({ x, y })
    const el = await createElement(board.id, 'shape', flowPos.x, flowPos.y, { shape: selectedShape, fill: shapeColorPicker, label: '' }, w, h)
    setElements(prev => [...prev, el])
    setNodes(prev => [...prev, {
      id: `el-${el.id}`, type: 'shapeNode', position: { x: flowPos.x, y: flowPos.y },
      data: { shape: selectedShape, fill: shapeColorPicker, label: '', onDelete: (id: string) => handleDeleteNode(id, 'element') },
    }])
    shapeDragRef.current = null; setTool('select')
  }

  const isDrawingMode = tool === 'draw' || tool === 'shape'

  return (
    <div
      ref={wrapperRef}
      className="relative flex-1 h-full"
      style={{ backgroundColor: board.color }}
      onMouseUp={handleWrapperMouseUp}
    >
      <ReactFlow
        nodes={nodes}
        edges={edges}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onConnect={onConnect}
        onEdgesDelete={onEdgesDelete}
        onNodeDragStop={onNodeDragStop}
        nodeTypes={nodeTypes}
        fitView
        minZoom={0.05}
        maxZoom={4}
        deleteKeyCode="Delete"
        nodesDraggable={!isDrawingMode}
        panOnDrag={!isDrawingMode}
        zoomOnScroll={!isDrawingMode}
        onPaneClick={e => {
          if (isDrawingMode) return
          const flowPos = screenToFlowPosition({ x: e.clientX, y: e.clientY })
          setContextMenu({ x: e.clientX, y: e.clientY, flowX: flowPos.x, flowY: flowPos.y })
        }}
        proOptions={{ hideAttribution: true }}
      >
        <Background variant={BackgroundVariant.Dots} color="rgba(255,255,255,0.2)" gap={24} size={1.5} />
        <Controls />

        <Panel position="top-right">
          <div className="bg-white rounded-xl shadow-lg p-2 flex flex-col gap-1.5">
            <div className="flex gap-1.5">
              {(['select', 'draw', 'shape'] as Tool[]).map(t => {
                const Icon = TOOL_ICONS[t]
                return (
                  <button
                    key={t}
                    onClick={() => setTool(t)}
                    title={t.charAt(0).toUpperCase() + t.slice(1)}
                    className={`p-2 rounded-lg transition-colors ${tool === t ? 'bg-blue-500 text-white' : 'text-gray-600 hover:bg-gray-100'}`}
                  >
                    <Icon size={16} />
                  </button>
                )
              })}
            </div>
            {tool === 'draw' && (
              <div className="flex gap-1 flex-wrap mt-1 px-1">
                {SHAPE_COLORS.map(c => (
                  <button key={c} onClick={() => setDrawColor(c)} className={`w-5 h-5 rounded-full border-2 ${drawColor === c ? 'border-gray-800' : 'border-transparent'}`} style={{ backgroundColor: c }} />
                ))}
              </div>
            )}
            {tool === 'shape' && (
              <>
                <div className="flex gap-1 mt-1 px-1">
                  {(['rect', 'circle', 'diamond'] as ShapeType[]).map(s => (
                    <button key={s} onClick={() => setSelectedShape(s)} className={`text-[10px] px-2 py-1 rounded border ${selectedShape === s ? 'bg-blue-100 border-blue-400' : 'border-gray-200 text-gray-600'}`}>{s}</button>
                  ))}
                </div>
                <div className="flex gap-1 flex-wrap px-1">
                  {SHAPE_COLORS.map(c => (
                    <button key={c} onClick={() => setShapeColorPicker(c)} className={`w-5 h-5 rounded border-2 ${shapeColorPicker === c ? 'border-gray-800' : 'border-transparent'}`} style={{ backgroundColor: c }} />
                  ))}
                </div>
                <p className="text-[10px] text-gray-400 px-1">Drag to place</p>
              </>
            )}
            <p className="text-[10px] text-gray-300 px-1 mt-1 border-t border-gray-100 pt-1">Hold node + scroll to scale</p>
          </div>
        </Panel>
      </ReactFlow>

      {isDrawingMode && (
        <svg
          ref={svgOverlayRef}
          className="absolute inset-0 w-full h-full"
          style={{ cursor: 'crosshair', zIndex: 10, pointerEvents: 'all' }}
          onMouseDown={tool === 'draw' ? onDrawStart : onShapeStart}
          onMouseMove={tool === 'draw' ? onDrawMove : undefined}
          onMouseUp={tool === 'draw' ? onDrawEnd : onShapeEnd}
        >
          {currentPath && <path d={currentPath} fill="none" stroke={drawColor} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />}
        </svg>
      )}

      {contextMenu && (
        <div
          className="fixed bg-white rounded-xl shadow-xl border border-gray-200 py-1.5 z-50 w-52"
          style={{ top: contextMenu.y, left: contextMenu.x }}
          onMouseLeave={() => setContextMenu(null)}
        >
          {[
            { action: 'list', label: '＋ Create list' },
            { action: 'card', label: '＋ Create card' },
            { action: 'subtab', label: '🗂 Add sub-tab' },
            { action: 'image', label: '🖼 Insert image' },
            { action: 'draw', label: '✏️ Draw' },
            { action: 'shape', label: '⬛ Draw a shape' },
          ].map(({ action, label }) => (
            <button key={action} onClick={() => handleContextAction(action)}
              className="w-full text-left px-4 py-2 text-sm text-gray-700 hover:bg-gray-100 transition-colors">
              {label}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

export default function FreeBoardView(props: Props) {
  return (
    <ReactFlowProvider>
      <FlowCanvas {...props} />
    </ReactFlowProvider>
  )
}
