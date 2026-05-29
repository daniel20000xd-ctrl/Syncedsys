'use client'

import { useCallback, useRef, useState, useEffect } from 'react'
import {
  ReactFlow, Background, Controls, BackgroundVariant,
  useNodesState, useEdgesState, addEdge, ReactFlowProvider,
  useReactFlow, type Connection, type Node, type Edge,
  type NodeTypes,
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import { useRouter } from 'next/navigation'
import { MousePointer2, Pencil, Square, Type, Hand, type LucideIcon } from 'lucide-react'
import type { Board, List, Card, BoardEdge, BoardElement } from '@/lib/types'
import {
  createList, createFreeCard, createEdge, deleteEdge, deleteBoard,
  createElement, deleteElement, updateListPosition, updateCardPosition,
  updateElement, createSubTab, updateBoardFreePosition, deleteList, deleteCard,
} from '@/app/actions'
import { ListNode, CardNode, ShapeNode, ImageNode, DrawingNode, SubTabNode, TextNode } from './nodes'

const nodeTypes: NodeTypes = {
  listNode: ListNode,
  cardNode: CardNode,
  shapeNode: ShapeNode,
  imageNode: ImageNode,
  drawingNode: DrawingNode,
  subTabNode: SubTabNode,
  textNode: TextNode,
}

type Tool = 'select' | 'hand' | 'draw' | 'shape' | 'text'

const TOOL_ICONS: Record<Tool, LucideIcon> = {
  select: MousePointer2,
  hand: Hand,
  draw: Pencil,
  shape: Square,
  text: Type,
}
type ShapeType = 'rect' | 'circle' | 'diamond'

const SHAPE_COLORS = ['#93c5fd','#6ee7b7','#fca5a5','#fcd34d','#c4b5fd','#f9a8d4']

function buildNodes(
  lists: List[], cards: Card[], elements: BoardElement[], subBoards: Board[],
  onAddCard: (listId: string) => void,
  onDeleteNode: (id: string, type: string) => void,
  onNavigate: (boardId: string) => void,
  onHold: (id: string) => void,
  onSave: (id: string, dataObj: Record<string, unknown>, w?: number, h?: number) => void,
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

  const elementNodes: Node[] = elements.map(el => {
    const type = el.type === 'shape' ? 'shapeNode' : el.type === 'image' ? 'imageNode' : el.type === 'text' ? 'textNode' : 'drawingNode'
    const base: Node = {
      id: `el-${el.id}`,
      type,
      position: { x: el.x, y: el.y },
      data: {
        ...el.data,
        width: el.width ?? undefined,
        height: el.height ?? undefined,
        onDelete: (nodeId: string) => onDeleteNode(nodeId, 'element'),
        onSave,
        // Shapes/text manage their own scaling/sizing, so no hold-to-scale on them
        ...(el.type === 'shape' || el.type === 'text' ? {} : { onHold }),
      },
    }
    if (el.type === 'shape') base.style = { width: el.width ?? 120, height: el.height ?? 80 }
    return base
  })

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
  const { screenToFlowPosition, getViewport, setViewport } = useReactFlow()
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

  // Shape click-move-click state (overlay-relative coords)
  const [shapeAnchor, setShapeAnchor] = useState<{ x: number; y: number } | null>(null)
  const [shapePreview, setShapePreview] = useState<{ x: number; y: number; w: number; h: number } | null>(null)

  // Scale on hold+scroll
  const heldNodeRef = useRef<string | null>(null)
  const wrapperRef = useRef<HTMLDivElement>(null)
  const setNodesRef = useRef<typeof setNodes | null>(null)

  // Middle-mouse panning while a tool overlay is active
  const panRef = useRef<{ sx: number; sy: number; vx: number; vy: number } | null>(null)

  // Latest elements for persistence callbacks
  const elementsRef = useRef(elements)
  useEffect(() => { elementsRef.current = elements }, [elements])

  const saveElement = useCallback((nodeId: string, dataObj: Record<string, unknown>, w?: number, h?: number) => {
    const rawId = nodeId.replace('el-', '')
    const clean = Object.fromEntries(Object.entries(dataObj).filter(([, v]) => typeof v !== 'function'))
    setElements(prev => prev.map(e => e.id === rawId
      ? { ...e, data: clean, ...(w != null ? { width: w } : {}), ...(h != null ? { height: h } : {}) }
      : e))
    updateElement(rawId, { data: clean, ...(w != null ? { width: w } : {}), ...(h != null ? { height: h } : {}) })
      .catch(err => console.error('Failed to persist element:', err))
  }, [])

  const navigate = useCallback((bid: string) => router.push(`/board/${bid}`), [router])

  function handleDeleteNode(nodeId: string, type: string) {
    const removeNodes = (pred: (n: Node) => boolean) => setNodesRef.current?.(prev => prev.filter(pred))
    if (type === 'list') {
      const rawId = nodeId.replace('list-', '')
      setLists(prev => prev.filter(l => l.id !== rawId))
      setCards(prev => prev.filter(c => c.list_id !== rawId))
      // remove the list node and any of its card nodes
      removeNodes(n => n.id !== `list-${rawId}` && !(n.type === 'cardNode' && (n.data as { listId?: string }).listId === rawId))
      deleteList(rawId, board.id)
    } else if (type === 'card') {
      const rawId = nodeId.replace('card-', '')
      setCards(prev => prev.filter(c => c.id !== rawId))
      removeNodes(n => n.id !== `card-${rawId}`)
      deleteCard(rawId, board.id)
    } else if (type === 'element') {
      const rawId = nodeId.replace('el-', '')
      setElements(prev => prev.filter(e => e.id !== rawId))
      removeNodes(n => n.id !== nodeId)
      deleteElement(rawId)
    } else if (type === 'subtab') {
      const rawId = nodeId.replace('sub-', '')
      setSubBoards(prev => prev.filter(sb => sb.id !== rawId))
      removeNodes(n => n.id !== `sub-${rawId}`)
      deleteBoard(rawId)
    }
  }

  // Map a node id to the type used by handleDeleteNode
  function nodeKind(id: string): string | null {
    if (id.startsWith('list-')) return 'list'
    if (id.startsWith('card-')) return 'card'
    if (id.startsWith('el-')) return 'element'
    if (id.startsWith('sub-')) return 'subtab'
    return null
  }

  const holdNode = useCallback((id: string) => { heldNodeRef.current = id }, [])

  const [nodes, setNodes, onNodesChange] = useNodesState(
    buildNodes(lists, cards, elements, subBoards, () => {}, handleDeleteNode, navigate, holdNode, saveElement)
  )
  const [edges, setEdges, onEdgesChange] = useEdgesState(buildEdges(cards, initialEdges))

  // Keep ref in sync so the wheel handler (in effect) can always call latest setNodes
  setNodesRef.current = setNodes

  // Delete key on a marquee/multi-selection — persist every removed node
  const onNodesDelete = useCallback((deleted: Node[]) => {
    for (const node of deleted) {
      const kind = nodeKind(node.id)
      if (kind) handleDeleteNode(node.id, kind)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Recolor every selected shape/drawing/text via a toolbar swatch
  const COLORABLE = new Set(['shapeNode', 'drawingNode', 'textNode'])
  const selectedColorable = nodes.filter(n => n.selected && COLORABLE.has(n.type ?? ''))

  function recolorSelected(color: string) {
    const targets = selectedColorable
    if (targets.length === 0) return
    setNodes(prev => prev.map(n => {
      if (!n.selected || !COLORABLE.has(n.type ?? '')) return n
      const key = n.type === 'shapeNode' ? 'fill' : 'color'
      return { ...n, data: { ...n.data, [key]: color } }
    }))
    for (const n of targets) {
      const key = n.type === 'shapeNode' ? 'fill' : 'color'
      const newData = { ...n.data, [key]: color }
      if (n.type === 'shapeNode') saveElement(n.id, newData, n.data.width as number, n.data.height as number)
      else saveElement(n.id, newData)
    }
  }

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

  // Overlay-relative point from any pointer/mouse event
  function getOverlayPoint(clientX: number, clientY: number) {
    const rect = svgOverlayRef.current!.getBoundingClientRect()
    return { x: clientX - rect.left, y: clientY - rect.top }
  }
  // Convert an overlay-relative point to a flow-canvas position
  function overlayToFlow(ox: number, oy: number) {
    const rect = svgOverlayRef.current!.getBoundingClientRect()
    return screenToFlowPosition({ x: ox + rect.left, y: oy + rect.top })
  }

  // ── Draw: press & hold, freehand follows, release ends the stroke ──
  function onDrawPointerDown(e: React.PointerEvent<SVGSVGElement>) {
    if (tool !== 'draw') return
    e.currentTarget.setPointerCapture(e.pointerId)
    const pt = getOverlayPoint(e.clientX, e.clientY)
    drawingRef.current = { points: [pt] }
    setCurrentPath(`M ${pt.x} ${pt.y}`)
  }

  function onDrawPointerMove(e: React.PointerEvent<SVGSVGElement>) {
    if (tool !== 'draw' || !drawingRef.current) return
    const pt = getOverlayPoint(e.clientX, e.clientY)
    drawingRef.current.points.push(pt)
    const pts = drawingRef.current.points
    setCurrentPath(pts.reduce((acc, p, i) => i === 0 ? `M ${p.x} ${p.y}` : `${acc} L ${p.x} ${p.y}`, ''))
  }

  async function onDrawPointerUp(e: React.PointerEvent<SVGSVGElement>) {
    if (tool !== 'draw' || !drawingRef.current) return
    try { e.currentTarget.releasePointerCapture(e.pointerId) } catch {}
    const pts = drawingRef.current.points
    drawingRef.current = null
    setCurrentPath('')
    if (pts.length < 2) return
    const minX = Math.min(...pts.map(p => p.x))
    const minY = Math.min(...pts.map(p => p.y))
    const maxX = Math.max(...pts.map(p => p.x))
    const maxY = Math.max(...pts.map(p => p.y))
    const normalizedPath = pts.reduce((acc, p, i) =>
      i === 0 ? `M ${p.x - minX + 5} ${p.y - minY + 5}` : `${acc} L ${p.x - minX + 5} ${p.y - minY + 5}`, '')
    const flowPos = overlayToFlow(minX, minY)
    const data = { path: normalizedPath, color: drawColor, strokeWidth: 2, bbox: { width: maxX - minX, height: maxY - minY } }
    // Render immediately, then persist — node stays even if the DB write fails
    const tempId = `el-tmp-${crypto.randomUUID()}`
    setNodes(prev => [...prev, {
      id: tempId, type: 'drawingNode', position: { x: flowPos.x, y: flowPos.y },
      data: { ...data, onDelete: (id: string) => handleDeleteNode(id, 'element') },
    }])
    try {
      const el = await createElement(board.id, 'drawing', flowPos.x, flowPos.y, data)
      setElements(prev => [...prev, el])
      setNodes(prev => prev.map(n => n.id === tempId ? { ...n, id: `el-${el.id}` } : n))
    } catch (err) {
      console.error('Failed to save drawing (board_elements table may be missing):', err)
    }
    // Stay in draw mode for further strokes; click Select to stop
  }

  // ── Shape: click to anchor, move to size (live preview), click again to commit ──
  async function onShapePointerDown(e: React.PointerEvent<SVGSVGElement>) {
    if (tool !== 'shape') return
    const pt = getOverlayPoint(e.clientX, e.clientY)
    if (!shapeAnchor) {
      setShapeAnchor(pt)
      setShapePreview({ x: pt.x, y: pt.y, w: 0, h: 0 })
      return
    }
    // Second click — commit
    const x = Math.min(shapeAnchor.x, pt.x)
    const y = Math.min(shapeAnchor.y, pt.y)
    const w = Math.abs(pt.x - shapeAnchor.x) || 120
    const h = Math.abs(pt.y - shapeAnchor.y) || 80
    setShapeAnchor(null)
    setShapePreview(null)
    const flowPos = overlayToFlow(x, y)
    const data = { shape: selectedShape, fill: shapeColorPicker, label: '', width: w, height: h }
    // Render immediately, then persist — node stays even if the DB write fails
    const tempId = `el-tmp-${crypto.randomUUID()}`
    setNodes(prev => [...prev, {
      id: tempId, type: 'shapeNode', position: { x: flowPos.x, y: flowPos.y }, style: { width: w, height: h },
      data: { ...data, onDelete: (id: string) => handleDeleteNode(id, 'element'), onSave: saveElement },
    }])
    try {
      const el = await createElement(board.id, 'shape', flowPos.x, flowPos.y, data, w, h)
      setElements(prev => [...prev, el])
      setNodes(prev => prev.map(n => n.id === tempId ? { ...n, id: `el-${el.id}` } : n))
    } catch (err) {
      console.error('Failed to save shape (board_elements table may be missing):', err)
    }
    // Stay in shape mode for further shapes; click Select to stop
  }

  // ── Text: click to drop a text box where you want, then type ──
  async function onTextPointerDown(e: React.PointerEvent<SVGSVGElement>) {
    if (tool !== 'text') return
    const op = getOverlayPoint(e.clientX, e.clientY)
    const flowPos = overlayToFlow(op.x, op.y)
    const data = { text: '', color: '#1f2937', fontSize: 18 }
    const tempId = `el-tmp-${crypto.randomUUID()}`
    setNodes(prev => [...prev, {
      id: tempId, type: 'textNode', position: { x: flowPos.x, y: flowPos.y },
      data: { ...data, autoEdit: true, onDelete: (id: string) => handleDeleteNode(id, 'element'), onSave: saveElement },
    }])
    setTool('select') // drop the overlay so you can immediately type
    try {
      const el = await createElement(board.id, 'text', flowPos.x, flowPos.y, data)
      setElements(prev => [...prev, el])
      setNodes(prev => prev.map(n => n.id === tempId ? { ...n, id: `el-${el.id}` } : n))
    } catch (err) {
      console.error('Failed to save text (board_elements table may be missing):', err)
    }
  }

  function onShapePointerMove(e: React.PointerEvent<SVGSVGElement>) {
    if (tool !== 'shape' || !shapeAnchor) return
    const pt = getOverlayPoint(e.clientX, e.clientY)
    setShapePreview({
      x: Math.min(shapeAnchor.x, pt.x),
      y: Math.min(shapeAnchor.y, pt.y),
      w: Math.abs(pt.x - shapeAnchor.x),
      h: Math.abs(pt.y - shapeAnchor.y),
    })
  }

  // Reset any in-progress shape/stroke when leaving the relevant tool
  useEffect(() => {
    if (tool !== 'shape') { setShapeAnchor(null); setShapePreview(null) }
    if (tool !== 'draw') { drawingRef.current = null; setCurrentPath('') }
  }, [tool])

  // 'h' toggles the hand (pan) tool — ignored while typing in a field
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const el = e.target as HTMLElement | null
      const typing = !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)
      if (typing || e.metaKey || e.ctrlKey || e.altKey) return
      if (e.key === 'h' || e.key === 'H') {
        e.preventDefault()
        setTool(prev => (prev === 'hand' ? 'select' : 'hand'))
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  // Overlay (draw/shape/text) intercepts pointer input; hand & select do not
  const overlayActive = tool === 'draw' || tool === 'shape' || tool === 'text'

  // ── Navigation that works regardless of the active tool ──
  function onOverlayWheel(e: React.WheelEvent<SVGSVGElement>) {
    if (heldNodeRef.current) return // node scaling handled by the window wheel listener
    e.preventDefault()
    const vp = getViewport()
    const factor = e.deltaY > 0 ? 0.9 : 1.1
    const newZoom = Math.max(0.05, Math.min(4, vp.zoom * factor))
    const f = screenToFlowPosition({ x: e.clientX, y: e.clientY })
    setViewport({ zoom: newZoom, x: vp.x + f.x * (vp.zoom - newZoom), y: vp.y + f.y * (vp.zoom - newZoom) })
  }

  function onOverlayPointerDown(e: React.PointerEvent<SVGSVGElement>) {
    if (e.button === 1 || e.button === 2) {
      // Middle/right mouse → pan
      e.preventDefault()
      try { e.currentTarget.setPointerCapture(e.pointerId) } catch {}
      const vp = getViewport()
      panRef.current = { sx: e.clientX, sy: e.clientY, vx: vp.x, vy: vp.y }
      return
    }
    if (e.button !== 0) return
    if (tool === 'draw') onDrawPointerDown(e)
    else if (tool === 'shape') onShapePointerDown(e)
    else if (tool === 'text') onTextPointerDown(e)
  }

  function onOverlayPointerMove(e: React.PointerEvent<SVGSVGElement>) {
    if (panRef.current) {
      const { sx, sy, vx, vy } = panRef.current
      setViewport({ zoom: getViewport().zoom, x: vx + (e.clientX - sx), y: vy + (e.clientY - sy) })
      return
    }
    if (tool === 'draw') onDrawPointerMove(e)
    else if (tool === 'shape') onShapePointerMove(e)
  }

  function onOverlayPointerUp(e: React.PointerEvent<SVGSVGElement>) {
    if (panRef.current) {
      panRef.current = null
      try { e.currentTarget.releasePointerCapture(e.pointerId) } catch {}
      return
    }
    if (tool === 'draw') onDrawPointerUp(e)
  }

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
        onNodesDelete={onNodesDelete}
        onNodeDragStop={onNodeDragStop}
        nodeTypes={nodeTypes}
        fitView
        minZoom={0.05}
        maxZoom={4}
        deleteKeyCode="Delete"
        nodesDraggable={tool === 'select'}
        selectionOnDrag={tool === 'select'}
        panOnDrag={tool === 'hand' ? true : tool === 'select' ? [1, 2] : false}
        zoomOnScroll
        zoomOnPinch
        onPaneClick={e => {
          if (tool !== 'select') return
          // If a menu is already open, this click just closes it — don't reopen elsewhere
          if (contextMenu) { setContextMenu(null); return }
          const flowPos = screenToFlowPosition({ x: e.clientX, y: e.clientY })
          setContextMenu({ x: e.clientX, y: e.clientY, flowX: flowPos.x, flowY: flowPos.y })
        }}
        proOptions={{ hideAttribution: true }}
      >
        <Background variant={BackgroundVariant.Dots} color="rgba(255,255,255,0.2)" gap={24} size={1.5} />
        <Controls />
      </ReactFlow>

      {overlayActive && (
        <svg
          ref={svgOverlayRef}
          className="absolute inset-0 w-full h-full"
          style={{ cursor: tool === 'text' ? 'text' : 'crosshair', zIndex: 10, pointerEvents: 'all', touchAction: 'none' }}
          onPointerDown={onOverlayPointerDown}
          onPointerMove={onOverlayPointerMove}
          onPointerUp={onOverlayPointerUp}
          onWheel={onOverlayWheel}
          onContextMenu={e => e.preventDefault()}
        >
          {currentPath && <path d={currentPath} fill="none" stroke={drawColor} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />}
          {shapePreview && (
            selectedShape === 'circle' ? (
              <ellipse
                cx={shapePreview.x + shapePreview.w / 2} cy={shapePreview.y + shapePreview.h / 2}
                rx={shapePreview.w / 2} ry={shapePreview.h / 2}
                fill={shapeColorPicker} fillOpacity={0.5} stroke={shapeColorPicker} strokeWidth={2} strokeDasharray="4 3"
              />
            ) : selectedShape === 'diamond' ? (
              <polygon
                points={`${shapePreview.x + shapePreview.w / 2},${shapePreview.y} ${shapePreview.x + shapePreview.w},${shapePreview.y + shapePreview.h / 2} ${shapePreview.x + shapePreview.w / 2},${shapePreview.y + shapePreview.h} ${shapePreview.x},${shapePreview.y + shapePreview.h / 2}`}
                fill={shapeColorPicker} fillOpacity={0.5} stroke={shapeColorPicker} strokeWidth={2} strokeDasharray="4 3"
              />
            ) : (
              <rect
                x={shapePreview.x} y={shapePreview.y} width={shapePreview.w} height={shapePreview.h} rx={6}
                fill={shapeColorPicker} fillOpacity={0.5} stroke={shapeColorPicker} strokeWidth={2} strokeDasharray="4 3"
              />
            )
          )}
        </svg>
      )}

      {/* Toolbar — rendered above the drawing overlay (z-20 > overlay z-10) so it stays clickable while drawing */}
      <div className="absolute top-3 right-3 z-20 bg-white rounded-xl shadow-lg p-2 flex flex-col gap-1.5">
        <div className="flex flex-col gap-1.5">
          {(['select', 'hand', 'draw', 'shape', 'text'] as Tool[]).map(t => {
            const Icon = TOOL_ICONS[t]
            return (
              <button
                key={t}
                onClick={() => setTool(t)}
                title={t === 'hand' ? 'Hand — pan (H)' : t.charAt(0).toUpperCase() + t.slice(1)}
                className={`p-2 rounded-lg transition-colors ${tool === t ? 'bg-blue-500 text-white' : 'text-gray-600 hover:bg-gray-100'}`}
              >
                <Icon size={16} />
              </button>
            )
          })}
        </div>
        {tool === 'text' && (
          <p className="text-[9px] text-gray-400 text-center w-16 leading-tight mt-1 pt-1 border-t border-gray-100">Click to place text</p>
        )}
        {tool === 'select' && selectedColorable.length > 0 && (
          <div className="flex flex-col items-center gap-1 mt-1 pt-1 border-t border-gray-100">
            <p className="text-[8px] text-gray-400 text-center leading-tight">Recolor {selectedColorable.length} selected</p>
            {SHAPE_COLORS.map(c => (
              <button key={c} onClick={() => recolorSelected(c)} className="w-5 h-5 rounded border-2 border-transparent hover:border-gray-800" style={{ backgroundColor: c }} />
            ))}
          </div>
        )}
        {tool === 'select' && selectedColorable.length === 0 && (
          <p className="text-[8px] text-gray-300 text-center w-16 leading-tight mt-1 pt-1 border-t border-gray-100">Drag = select box · H = hand</p>
        )}
        {tool !== 'select' && (
          <p className="text-[8px] text-gray-300 text-center w-16 leading-tight">Scroll = zoom · middle-drag = pan</p>
        )}
        {tool === 'draw' && (
          <div className="flex flex-col items-center gap-1 mt-1 pt-1 border-t border-gray-100">
            {SHAPE_COLORS.map(c => (
              <button key={c} onClick={() => setDrawColor(c)} className={`w-5 h-5 rounded-full border-2 ${drawColor === c ? 'border-gray-800' : 'border-transparent'}`} style={{ backgroundColor: c }} />
            ))}
          </div>
        )}
        {tool === 'shape' && (
          <div className="flex flex-col gap-1 mt-1 pt-1 border-t border-gray-100">
            {(['rect', 'circle', 'diamond'] as ShapeType[]).map(s => (
              <button key={s} onClick={() => setSelectedShape(s)} className={`text-[10px] px-2 py-1 rounded border ${selectedShape === s ? 'bg-blue-100 border-blue-400' : 'border-gray-200 text-gray-600'}`}>{s}</button>
            ))}
            <div className="flex flex-col items-center gap-1 mt-1">
              {SHAPE_COLORS.map(c => (
                <button key={c} onClick={() => setShapeColorPicker(c)} className={`w-5 h-5 rounded border-2 ${shapeColorPicker === c ? 'border-gray-800' : 'border-transparent'}`} style={{ backgroundColor: c }} />
              ))}
            </div>
            <p className="text-[9px] text-gray-400 text-center w-16 leading-tight">Click, move, click to size</p>
          </div>
        )}
      </div>

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
