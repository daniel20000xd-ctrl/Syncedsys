'use client'

import { useCallback, useRef, useState, useEffect } from 'react'
import {
  ReactFlow, Background, Controls, BackgroundVariant,
  useNodesState, useEdgesState, addEdge, ReactFlowProvider,
  useReactFlow, ConnectionMode, type Connection, type Node, type Edge,
  type NodeTypes, type EdgeTypes,
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import { useRouter } from 'next/navigation'
import { MousePointer2, Pencil, Square, Type, Hand, Frame, type LucideIcon } from 'lucide-react'
import type { Board, List, Card, BoardEdge, BoardElement } from '@/lib/types'
import {
  createList, createFreeCard, deleteEdge, deleteBoard,
  upsertElement, deleteElement, updateListPosition, updateCardPosition,
  updateElement, createSubTab, updateBoardFreePosition, deleteList, deleteCard, upsertEdge,
  updateBoard, updateCard, updateCardDone, updateEdgeShape,
} from '@/app/actions'
import { ListNode, CardNode, ShapeNode, ImageNode, DrawingNode, SubTabNode, TextNode, DeletableEdge, PortalNode } from './nodes'
import BoardPropertiesPanel from '../BoardPropertiesPanel'
import { unitsStore, type Unit } from '@/lib/unitsStore'

const nodeTypes: NodeTypes = {
  listNode: ListNode,
  cardNode: CardNode,
  shapeNode: ShapeNode,
  imageNode: ImageNode,
  drawingNode: DrawingNode,
  subTabNode: SubTabNode,
  textNode: TextNode,
  portalNode: PortalNode,
}

const edgeTypes: EdgeTypes = {
  deletable: DeletableEdge,
}

type Tool = 'select' | 'hand' | 'draw' | 'shape' | 'text' | 'portal'

const TOOL_ICONS: Record<Tool, LucideIcon> = {
  select: MousePointer2,
  hand: Hand,
  draw: Pencil,
  shape: Square,
  text: Type,
  portal: Frame,
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
  onRenameCard: (id: string, title: string) => void,
  onRenameSubTab: (boardId: string, name: string) => void,
  onOpenSubPanel: (boardId: string, rect: DOMRect) => void,
  onToggleDone: (id: string, done: boolean) => void,
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
      done: c.done,
      listId: c.list_id,
      onDelete: (nodeId: string) => onDeleteNode(nodeId, 'card'),
      onRename: onRenameCard,
      onToggleDone,
      onHold,
    },
  }))

  const elementNodes: Node[] = elements.map(el => {
    const type = el.type === 'shape' ? 'shapeNode' : el.type === 'image' ? 'imageNode' : el.type === 'text' ? 'textNode' : el.type === 'portal' ? 'portalNode' : 'drawingNode'
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
        ...(el.type === 'portal' ? { onOpenFully: onNavigate } : {}),
        // Text has its own font size; everything else (incl. shapes) scales on hold+scroll
        ...(el.type === 'text' ? {} : { onHold }),
      },
    }
    if (el.type === 'shape' || el.type === 'portal') base.style = { width: el.width ?? 120, height: el.height ?? 80 }
    const opacity = typeof el.data.opacity === 'number' ? (el.data.opacity as number) : 1
    base.style = { ...(base.style ?? {}), opacity }
    if (typeof el.data.z === 'number') base.zIndex = el.data.z as number
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
      onRename: onRenameSubTab,
      onOpenPanel: onOpenSubPanel,
      onHold,
    },
  }))

  return [...listNodes, ...cardNodes, ...elementNodes, ...subTabNodes]
}

function buildEdges(
  cards: Card[],
  boardEdges: BoardEdge[],
  onDeleteEdge: (id: string) => void,
  onReshapeEdge: (id: string, offset: { cx: number; cy: number }) => void,
  onColorEdge: (id: string, color: string) => void,
): Edge[] {
  const autoEdges: Edge[] = cards.map(c => ({
    id: `auto-${c.id}`,
    source: `list-${c.list_id}`,
    target: `card-${c.id}`,
    sourceHandle: 'bottom',
    targetHandle: 'top',
    type: 'deletable',
    data: { deletable: false },
    style: { stroke: 'rgba(255,255,255,0.7)', strokeWidth: 2 },
    animated: false,
  }))

  const manualEdges: Edge[] = boardEdges.map(e => {
    const color = (e.data?.color as string | undefined) ?? '#3b82f6'
    return {
      id: e.id,
      source: e.source,
      target: e.target,
      sourceHandle: e.source_handle ?? undefined,
      targetHandle: e.target_handle ?? undefined,
      type: 'deletable',
      data: {
        deletable: true,
        onDelete: onDeleteEdge,
        onReshape: onReshapeEdge,
        onColor: onColorEdge,
        cx: (e.data?.cx as number) ?? 0,
        cy: (e.data?.cy as number) ?? 0,
        color,
      },
      style: { stroke: color, strokeWidth: 2 },
      markerEnd: { type: 'arrowclosed' as const },
    }
  })

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
  const [subPanel, setSubPanel] = useState<{ boardId: string; rect: DOMRect } | null>(null)

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

  function renameCard(nodeId: string, title: string) {
    const rawId = nodeId.replace('card-', '')
    setCards(prev => prev.map(c => c.id === rawId ? { ...c, title } : c))
    updateCard(rawId, { title }, board.id).catch(err => console.error('Failed to rename card:', err))
  }

  function toggleCardDone(nodeId: string, done: boolean) {
    const rawId = nodeId.replace('card-', '')
    setCards(prev => prev.map(c => c.id === rawId ? { ...c, done } : c))
    updateCardDone(rawId, done, board.id).catch(err => console.error('Failed to toggle card done:', err))
  }

  function renameSubTab(boardId: string, name: string) {
    setSubBoards(prev => prev.map(b => b.id === boardId ? { ...b, name } : b))
    setNodesRef.current?.(prev => prev.map(n => n.id === `sub-${boardId}` ? { ...n, data: { ...n.data, name } } : n))
    updateBoard(boardId, { name }).catch(err => console.error('Failed to rename tab:', err))
  }

  function openSubPanel(boardId: string, rect: DOMRect) {
    setSubPanel(prev => prev?.boardId === boardId ? null : { boardId, rect })
  }

  const [nodes, setNodes, onNodesChange] = useNodesState(
    buildNodes(lists, cards, elements, subBoards, () => {}, handleDeleteNode, navigate, holdNode, saveElement, renameCard, renameSubTab, openSubPanel, toggleCardDone)
  )
  const removeEdgeRef = useRef<(id: string) => void>(() => {})
  const reshapeEdgeRef = useRef<(id: string, offset: { cx: number; cy: number }) => void>(() => {})
  const colorEdgeRef = useRef<(id: string, color: string) => void>(() => {})
  const [edges, setEdges, onEdgesChange] = useEdgesState(buildEdges(
    cards, initialEdges,
    (id) => removeEdgeRef.current(id),
    (id, off) => reshapeEdgeRef.current(id, off),
    (id, color) => colorEdgeRef.current(id, color),
  ))

  // Keep ref in sync so the wheel handler (in effect) can always call latest setNodes
  setNodesRef.current = setNodes

  const removeEdge = useCallback((id: string) => {
    setEdges(prev => prev.filter(e => e.id !== id))
    if (!id.startsWith('auto-')) deleteEdge(id).catch(() => {})
  }, [setEdges])
  removeEdgeRef.current = removeEdge

  const reshapeEdge = useCallback((id: string, offset: { cx: number; cy: number }) => {
    setEdges(prev => prev.map(e => e.id === id ? { ...e, data: { ...e.data, cx: offset.cx, cy: offset.cy } } : e))
    if (!id.startsWith('auto-')) {
      const cur = edgesRef.current.find(e => e.id === id)
      const curData = (cur?.data ?? {}) as Record<string, unknown>
      updateEdgeShape(id, { ...curData, cx: offset.cx, cy: offset.cy }).catch(() => {})
    }
  }, [setEdges])
  reshapeEdgeRef.current = reshapeEdge

  const colorEdge = useCallback((id: string, color: string) => {
    setEdges(prev => prev.map(e =>
      e.id === id ? { ...e, style: { ...e.style, stroke: color }, data: { ...e.data, color } } : e
    ))
    if (!id.startsWith('auto-')) {
      const cur = edgesRef.current.find(e => e.id === id)
      const curData = (cur?.data ?? {}) as Record<string, unknown>
      updateEdgeShape(id, { ...curData, color }).catch(() => {})
    }
  }, [setEdges])
  colorEdgeRef.current = colorEdge

  // Live refs for history capture / persistence callbacks
  const nodesRef = useRef(nodes)
  const edgesRef = useRef(edges)
  useEffect(() => { nodesRef.current = nodes }, [nodes])
  useEffect(() => { edgesRef.current = edges }, [edges])

  // ── Create a free-mode element (client-controlled id so undo can restore it) ──
  function addElement(
    type: 'shape' | 'drawing' | 'text' | 'image' | 'portal',
    x: number, y: number,
    data: Record<string, unknown>,
    w?: number, h?: number,
    extraNodeData?: Record<string, unknown>,
  ) {
    const id = crypto.randomUUID()
    const nodeId = `el-${id}`
    const nodeType = type === 'shape' ? 'shapeNode' : type === 'drawing' ? 'drawingNode' : type === 'text' ? 'textNode' : type === 'portal' ? 'portalNode' : 'imageNode'
    const node: Node = {
      id: nodeId, type: nodeType, position: { x, y },
      ...(type === 'shape' || type === 'portal' ? { style: { width: w, height: h } } : {}),
      data: {
        ...data,
        onDelete: (i: string) => handleDeleteNode(i, 'element'),
        onSave: saveElement,
        ...(type === 'text' ? {} : { onHold: holdNode }),
        ...extraNodeData,
      },
    }
    setNodes(prev => [...prev, node])
    setElements(prev => [...prev, { id, board_id: board.id, type, x, y, width: w ?? null, height: h ?? null, data, created_at: new Date().toISOString() } as BoardElement])
    upsertElement(id, board.id, type, x, y, data, w ?? null, h ?? null).catch(err => console.error('Failed to save element:', err))
    return nodeId
  }

  // Delete key on a marquee/multi-selection — persist every removed node
  const onNodesDelete = useCallback((deleted: Node[]) => {
    for (const node of deleted) {
      const kind = nodeKind(node.id)
      if (kind) handleDeleteNode(node.id, kind)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // ── Undo (Ctrl+Z) / Redo (Ctrl+X) ──
  type Snapshot = { nodes: Node[]; edges: Edge[] }
  const pastRef = useRef<Snapshot[]>([])
  const futureRef = useRef<Snapshot[]>([])
  const lastSnapRef = useRef<Snapshot | null>(null)
  const lastSigRef = useRef<string>('')
  const restoringRef = useRef(false)
  const HISTORY_LIMIT = 80

  const sigOf = (ns: Node[], es: Edge[]) =>
    JSON.stringify(
      {
        n: ns.map(n => ({ id: n.id, p: { x: Math.round(n.position.x), y: Math.round(n.position.y) }, s: n.style, d: n.data })),
        e: es.filter(e => !e.id.startsWith('auto-')).map(e => ({ id: e.id, s: e.source, t: e.target })),
      },
      (k, v) => (typeof v === 'function' ? undefined : v),
    )

  // Snapshot settled changes (debounced so a drag/draw becomes one undo step)
  useEffect(() => {
    if (restoringRef.current) return
    const sig = sigOf(nodes, edges)
    if (sig === lastSigRef.current) return
    const t = setTimeout(() => {
      if (lastSnapRef.current && lastSigRef.current !== '') {
        pastRef.current.push(lastSnapRef.current)
        if (pastRef.current.length > HISTORY_LIMIT) pastRef.current.shift()
        futureRef.current = []
      }
      lastSnapRef.current = { nodes: nodesRef.current, edges: edgesRef.current }
      lastSigRef.current = sig
    }, 350)
    return () => clearTimeout(t)
  }, [nodes, edges]) // eslint-disable-line react-hooks/exhaustive-deps

  function reconcileDb(s: Snapshot) {
    const elTypeOf = (t?: string) => t === 'shapeNode' ? 'shape' : t === 'drawingNode' ? 'drawing' : t === 'textNode' ? 'text' : t === 'portalNode' ? 'portal' : 'image'
    const clean = (d: Record<string, unknown>) => Object.fromEntries(Object.entries(d).filter(([, v]) => typeof v !== 'function'))
    const targetEls = s.nodes.filter(n => n.id.startsWith('el-'))
    const targetIds = new Set(targetEls.map(n => n.id.replace('el-', '')))
    // upsert everything in the target snapshot
    for (const n of targetEls) {
      const id = n.id.replace('el-', '')
      const type = elTypeOf(n.type) as 'shape' | 'drawing' | 'text' | 'image' | 'portal'
      const sized = type === 'shape' || type === 'portal'
      const w = sized ? (Number(n.style?.width) || (n.data.width as number) || null) : null
      const h = sized ? (Number(n.style?.height) || (n.data.height as number) || null) : null
      upsertElement(id, board.id, type, n.position.x, n.position.y, clean(n.data), w, h).catch(err => console.error('undo upsert failed:', err))
    }
    // delete elements that exist now but are gone in the target
    for (const el of elementsRef.current) {
      if (!targetIds.has(el.id)) deleteElement(el.id).catch(() => {})
    }
    setElements(targetEls.map(n => {
      const id = n.id.replace('el-', '')
      const existing = elementsRef.current.find(e => e.id === id)
      const type = elTypeOf(n.type) as BoardElement['type']
      const sized = type === 'shape' || type === 'portal'
      return {
        id, board_id: board.id, type, x: n.position.x, y: n.position.y,
        width: sized ? (Number(n.style?.width) || (n.data.width as number) || null) : (existing?.width ?? null),
        height: sized ? (Number(n.style?.height) || (n.data.height as number) || null) : (existing?.height ?? null),
        data: clean(n.data), created_at: existing?.created_at ?? new Date().toISOString(),
      } as BoardElement
    }))
    // restore positions of lists / cards / sub-tabs
    for (const n of s.nodes) {
      if (n.id.startsWith('list-')) updateListPosition(n.id.replace('list-', ''), n.position.x, n.position.y)
      else if (n.id.startsWith('card-')) updateCardPosition(n.id.replace('card-', ''), n.position.x, n.position.y)
      else if (n.id.startsWith('sub-')) updateBoardFreePosition(n.id.replace('sub-', ''), n.position.x, n.position.y)
    }
  }

  function applySnapshot(s: Snapshot) {
    restoringRef.current = true
    setNodes(s.nodes)
    setEdges(s.edges)
    lastSnapRef.current = s
    lastSigRef.current = sigOf(s.nodes, s.edges)
    reconcileDb(s)
    setTimeout(() => { restoringRef.current = false }, 0)
  }

  function undo() {
    const prev = pastRef.current.pop()
    if (!prev) return
    futureRef.current.push({ nodes: nodesRef.current, edges: edgesRef.current })
    applySnapshot(prev)
  }

  function redo() {
    const next = futureRef.current.pop()
    if (!next) return
    pastRef.current.push({ nodes: nodesRef.current, edges: edgesRef.current })
    applySnapshot(next)
  }

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

  // Hold a unit + scroll to resize it (capture phase so React Flow's pane
  // zoom listener never sees the event — otherwise it would zoom the canvas)
  useEffect(() => {
    const el = wrapperRef.current
    if (!el) return
    function handleWheel(e: WheelEvent) {
      if (!heldNodeRef.current) return // not holding a unit → let the canvas zoom
      e.preventDefault()
      e.stopPropagation()
      const factor = e.deltaY > 0 ? 0.9 : 1.1
      setNodesRef.current!(prev => prev.map(n => {
        if (n.id !== heldNodeRef.current) return n
        if (n.type === 'shapeNode' || n.type === 'portalNode') {
          // Resize the box itself; inner content scales with it
          const curW = Number(n.style?.width) || n.measured?.width || (n.data.width as number) || 120
          const curH = Number(n.style?.height) || n.measured?.height || (n.data.height as number) || 80
          const w = Math.max(30, Math.min(4000, curW * factor))
          const h = Math.max(20, Math.min(4000, curH * factor))
          return { ...n, style: { ...n.style, width: w, height: h }, data: { ...n.data, width: w, height: h } }
        }
        const curr = (n.data.scale as number) ?? 1
        return { ...n, data: { ...n.data, scale: Math.max(0.2, Math.min(5, curr * factor)) } }
      }))
    }
    el.addEventListener('wheel', handleWheel, { passive: false, capture: true })
    return () => el.removeEventListener('wheel', handleWheel, { capture: true } as EventListenerOptions)
  }, [])

  function handleWrapperMouseUp() {
    if (!heldNodeRef.current) return
    const heldId = heldNodeRef.current
    heldNodeRef.current = null
    if (!heldId.startsWith('el-')) return
    const rawId = heldId.replace('el-', '')
    const node = nodes.find(n => n.id === heldId)
    if (!node) return
    if (node.type === 'shapeNode' || node.type === 'portalNode') {
      // Persist the new size (shape text / portal content scale with it)
      const w = Number(node.style?.width) || node.measured?.width || (node.data.width as number) || 120
      const h = Number(node.style?.height) || node.measured?.height || (node.data.height as number) || 80
      saveElement(heldId, { ...node.data, width: w, height: h }, w, h)
    } else {
      const el = elementsRef.current.find(e => e.id === rawId)
      if (el) updateElement(rawId, { data: { ...el.data, scale: (node.data.scale as number) ?? 1 } })
    }
  }

  const onConnect = useCallback((connection: Connection) => {
    // Client-generated id so the edge id matches the DB row (delete/undo work)
    const id = crypto.randomUUID()
    const defaultColor = '#3b82f6'
    setEdges(eds => addEdge({
      ...connection, id,
      type: 'deletable',
      data: {
        deletable: true, cx: 0, cy: 0, color: defaultColor,
        onDelete: (eid: string) => removeEdgeRef.current(eid),
        onReshape: (eid: string, off: { cx: number; cy: number }) => reshapeEdgeRef.current(eid, off),
        onColor: (eid: string, color: string) => colorEdgeRef.current(eid, color),
      },
      style: { stroke: defaultColor, strokeWidth: 2 },
      markerEnd: { type: 'arrowclosed' as const },
    }, eds))
    upsertEdge(id, board.id, connection.source!, connection.target!, connection.sourceHandle ?? undefined, connection.targetHandle ?? undefined)
      .catch(err => console.error('Failed to save link:', err))
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
        data: { title: card.title, done: card.done, listId, onDelete: (id: string) => handleDeleteNode(id, 'card'), onRename: renameCard, onToggleDone: toggleCardDone, onHold: holdNode },
      },
    ])
    setEdges(prev => [...prev, {
      id: `auto-${card.id}`, source: `list-${listId}`, target: `card-${card.id}`,
      sourceHandle: 'bottom', targetHandle: 'top', type: 'deletable', data: { deletable: false },
      style: { stroke: 'rgba(255,255,255,0.7)', strokeWidth: 2 },
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
        data: { name: list.name, cardCount: 0, onAddCard: handleAddCard, onDelete: (id: string) => handleDeleteNode(id, 'list'), onHold: holdNode },
      }])
    }

    if (action === 'card') {
      // A card must belong to a list — create one automatically if there are none
      let targetList = lists[0]
      if (!targetList) {
        const list = await createList(board.id, 'List')
        targetList = { ...list, x: x - 30, y: y - 110 }
        setLists(prev => [...prev, targetList])
        setNodes(prev => [...prev, {
          id: `list-${list.id}`, type: 'listNode', position: { x: x - 30, y: y - 110 },
          data: { name: list.name, cardCount: 0, onAddCard: handleAddCard, onDelete: (id: string) => handleDeleteNode(id, 'list'), onHold: holdNode },
        }])
      }
      const listId = targetList.id
      const card = await createFreeCard(listId, 'New card', board.id, x, y)
      setCards(prev => [...prev, card])
      setNodes(prev => [...prev, {
        id: `card-${card.id}`, type: 'cardNode', position: { x, y },
        data: { title: card.title, done: card.done, listId, onDelete: (id: string) => handleDeleteNode(id, 'card'), onRename: renameCard, onToggleDone: toggleCardDone, onHold: holdNode },
      }])
      setEdges(prev => [...prev, {
        id: `auto-${card.id}`, source: `list-${listId}`, target: `card-${card.id}`,
        sourceHandle: 'bottom', targetHandle: 'top', type: 'deletable', data: { deletable: false },
        style: { stroke: 'rgba(255,255,255,0.7)', strokeWidth: 2 },
      }])
    }

    if (action === 'image') {
      const input = document.createElement('input')
      input.type = 'file'; input.accept = 'image/*'
      input.onchange = async e => {
        const file = (e.target as HTMLInputElement).files?.[0]
        if (!file) return
        const reader = new FileReader()
        reader.onload = ev => {
          const url = ev.target?.result as string
          addElement('image', x, y, { url, alt: file.name })
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
        data: { boardId: sub.id, name: sub.name, color: sub.color, mode: sub.mode, onNavigate: navigate, onDelete: (id: string) => handleDeleteNode(id, 'subtab'), onRename: renameSubTab, onOpenPanel: openSubPanel, onHold: holdNode },
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

  function onDrawPointerUp(e: React.PointerEvent<SVGSVGElement>) {
    if (tool !== 'draw' || !drawingRef.current) return
    try { e.currentTarget.releasePointerCapture(e.pointerId) } catch {}
    const pts = drawingRef.current.points
    drawingRef.current = null
    setCurrentPath('')
    if (pts.length < 2) return
    // Convert every point to FLOW coordinates so the stored stroke matches the
    // on-screen preview at any zoom (avoids the post-release size jump/offset).
    const flowPts = pts.map(p => overlayToFlow(p.x, p.y))
    const minX = Math.min(...flowPts.map(p => p.x))
    const minY = Math.min(...flowPts.map(p => p.y))
    const maxX = Math.max(...flowPts.map(p => p.x))
    const maxY = Math.max(...flowPts.map(p => p.y))
    const normalizedPath = flowPts.reduce((acc, p, i) =>
      i === 0 ? `M ${p.x - minX + 5} ${p.y - minY + 5}` : `${acc} L ${p.x - minX + 5} ${p.y - minY + 5}`, '')
    const data = { path: normalizedPath, color: drawColor, strokeWidth: 2, bbox: { width: maxX - minX, height: maxY - minY } }
    // -5 cancels the +5 inset so the stroke lands exactly where it was drawn
    addElement('drawing', minX - 5, minY - 5, data)
    // Stay in draw mode for further strokes; click Select to stop
  }

  // ── Shape: click to anchor, move to size (live preview), click again to commit ──
  function onShapePointerDown(e: React.PointerEvent<SVGSVGElement>) {
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
    addElement('shape', flowPos.x, flowPos.y, { shape: selectedShape, fill: shapeColorPicker, label: '', width: w, height: h }, w, h)
    // Stay in shape mode for further shapes; click Select to stop
  }

  // ── Portal: draw a rectangle (click, move, click) that views another tab ──
  function onPortalPointerDown(e: React.PointerEvent<SVGSVGElement>) {
    if (tool !== 'portal') return
    const pt = getOverlayPoint(e.clientX, e.clientY)
    if (!shapeAnchor) {
      setShapeAnchor(pt)
      setShapePreview({ x: pt.x, y: pt.y, w: 0, h: 0 })
      return
    }
    const x = Math.min(shapeAnchor.x, pt.x)
    const y = Math.min(shapeAnchor.y, pt.y)
    const w = Math.abs(pt.x - shapeAnchor.x) || 320
    const h = Math.abs(pt.y - shapeAnchor.y) || 220
    setShapeAnchor(null)
    setShapePreview(null)
    const flowPos = overlayToFlow(x, y)
    addElement('portal', flowPos.x, flowPos.y, { targetBoardId: null, home: board.id, vx: 20, vy: 20, zoom: 0.4, width: w, height: h }, w, h, { onOpenFully: navigate })
    setTool('select')
  }

  // ── Text: click to drop a text box where you want, then type ──
  function onTextPointerDown(e: React.PointerEvent<SVGSVGElement>) {
    if (tool !== 'text') return
    const op = getOverlayPoint(e.clientX, e.clientY)
    const flowPos = overlayToFlow(op.x, op.y)
    addElement('text', flowPos.x, flowPos.y, { text: '', color: '#1f2937', fontSize: 18 }, undefined, undefined, { autoEdit: true })
    setTool('select') // drop the overlay so you can immediately type
  }

  function onShapePointerMove(e: React.PointerEvent<SVGSVGElement>) {
    if ((tool !== 'shape' && tool !== 'portal') || !shapeAnchor) return
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
    if (tool !== 'shape' && tool !== 'portal') { setShapeAnchor(null); setShapePreview(null) }
    if (tool !== 'draw') { drawingRef.current = null; setCurrentPath('') }
  }, [tool])

  // Dismiss the context menu if the pointer leaves the window/tab or it loses focus
  useEffect(() => {
    if (!contextMenu) return
    const close = () => setContextMenu(null)
    const onVis = () => { if (document.hidden) close() }
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') close() }
    window.addEventListener('blur', close)
    document.addEventListener('mouseleave', close)
    document.addEventListener('visibilitychange', onVis)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('blur', close)
      document.removeEventListener('mouseleave', close)
      document.removeEventListener('visibilitychange', onVis)
      window.removeEventListener('keydown', onKey)
    }
  }, [contextMenu])

  // Keyboard: Ctrl+Z undo, Ctrl+X redo, H = hand tool — all ignored while typing
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const el = e.target as HTMLElement | null
      const typing = !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)
      if (typing) return
      const mod = e.ctrlKey || e.metaKey
      if (mod && (e.key === 'z' || e.key === 'Z')) { e.preventDefault(); undo(); return }
      if (mod && (e.key === 'x' || e.key === 'X')) { e.preventDefault(); redo(); return }
      if (!mod && !e.altKey && (e.key === 'h' || e.key === 'H')) {
        e.preventDefault()
        setTool(prev => (prev === 'hand' ? 'select' : 'hand'))
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // ── Units dashboard (left sidebar) integration ──
  const unitKind = (n: Node): Unit['kind'] => {
    if (n.id.startsWith('list-')) return 'list'
    if (n.id.startsWith('card-')) return 'card'
    if (n.id.startsWith('sub-')) return 'subtab'
    if (n.type === 'shapeNode') return 'shape'
    if (n.type === 'drawingNode') return 'drawing'
    if (n.type === 'textNode') return 'text'
    if (n.type === 'imageNode') return 'image'
    if (n.type === 'portalNode') return 'portal'
    return 'unknown'
  }
  const unitLabel = (n: Node, kind: Unit['kind']): string => {
    const d = n.data as Record<string, unknown>
    if (kind === 'list' || kind === 'subtab') return (d.name as string) || kind
    if (kind === 'card') return (d.title as string) || 'Card'
    if (kind === 'shape') return (d.label as string) || `${(d.shape as string) || 'Shape'}`
    if (kind === 'text') return (d.text as string) || 'Text'
    if (kind === 'image') return 'Image'
    if (kind === 'drawing') return 'Drawing'
    if (kind === 'portal') return 'Portal'
    return 'Unit'
  }

  // Publish the current units (top layer first) to the sidebar store
  useEffect(() => {
    const ordered = [...nodes].sort((a, b) => (b.zIndex ?? 0) - (a.zIndex ?? 0))
    const list: Unit[] = ordered.map(n => {
      const kind = unitKind(n)
      return {
        id: n.id,
        kind,
        label: unitLabel(n, kind),
        opacity: typeof n.style?.opacity === 'number' ? (n.style.opacity as number) : 1,
        selected: !!n.selected,
      }
    })
    unitsStore.publish(list)
  }, [nodes]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => () => unitsStore.clear(), [])

  // Handlers the sidebar can call back into
  useEffect(() => {
    unitsStore.setHandlers({
      select: (id) => {
        setNodes(prev => prev.map(n => ({ ...n, selected: n.id === id })))
      },
      reorder: (orderedTopFirst) => {
        // first in the list = highest layer
        const total = orderedTopFirst.length
        const zById = new Map(orderedTopFirst.map((id, i) => [id, total - i]))
        setNodes(prev => prev.map(n => zById.has(n.id) ? { ...n, zIndex: zById.get(n.id) } : n))
        for (const n of nodesRef.current) {
          const z = zById.get(n.id)
          if (z != null && n.id.startsWith('el-')) saveElement(n.id, { ...n.data, z }, n.data.width as number | undefined, n.data.height as number | undefined)
        }
      },
      setOpacity: (id, opacity) => {
        setNodes(prev => prev.map(n => n.id === id ? { ...n, style: { ...n.style, opacity } } : n))
        const n = nodesRef.current.find(x => x.id === id)
        if (n && id.startsWith('el-')) saveElement(id, { ...n.data, opacity }, n.data.width as number | undefined, n.data.height as number | undefined)
      },
    })
    return () => unitsStore.setHandlers(null)
  }, [setNodes, saveElement])

  // Overlay (draw/shape/text/portal) intercepts pointer input; hand & select do not
  const overlayActive = tool === 'draw' || tool === 'shape' || tool === 'text' || tool === 'portal'

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
    else if (tool === 'portal') onPortalPointerDown(e)
    else if (tool === 'text') onTextPointerDown(e)
  }

  function onOverlayPointerMove(e: React.PointerEvent<SVGSVGElement>) {
    if (panRef.current) {
      const { sx, sy, vx, vy } = panRef.current
      setViewport({ zoom: getViewport().zoom, x: vx + (e.clientX - sx), y: vy + (e.clientY - sy) })
      return
    }
    if (tool === 'draw') onDrawPointerMove(e)
    else if (tool === 'shape' || tool === 'portal') onShapePointerMove(e)
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
        edgeTypes={edgeTypes}
        connectionMode={ConnectionMode.Loose}
        elevateNodesOnSelect={false}
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
            tool === 'portal' ? (
              <rect
                x={shapePreview.x} y={shapePreview.y} width={shapePreview.w} height={shapePreview.h} rx={8}
                fill="#d946ef" fillOpacity={0.15} stroke="#d946ef" strokeWidth={2} strokeDasharray="6 4"
              />
            ) : selectedShape === 'circle' ? (
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
          {(['select', 'hand', 'draw', 'shape', 'text', 'portal'] as Tool[]).map(t => {
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

      {subPanel && (() => {
        const sb = subBoards.find(b => b.id === subPanel.boardId)
        if (!sb) return null
        return (
          <BoardPropertiesPanel
            board={sb}
            anchorRect={subPanel.rect}
            showAddSubTab={false}
            onClose={() => setSubPanel(null)}
            onUpdate={updated => {
              setSubBoards(prev => prev.map(b => b.id === updated.id ? updated : b))
              setNodes(prev => prev.map(n => n.id === `sub-${updated.id}`
                ? { ...n, data: { ...n.data, name: updated.name, color: updated.color, mode: updated.mode } }
                : n))
              setSubPanel(null)
            }}
            onRemove={() => handleDeleteNode(`sub-${sb.id}`, 'subtab')}
          />
        )
      })()}
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
