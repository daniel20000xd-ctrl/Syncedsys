'use client'

import { useCallback, useRef, useState, useEffect } from 'react'
import {
  ReactFlow, Background, BackgroundVariant,
  useNodesState, useEdgesState, addEdge, ReactFlowProvider,
  useReactFlow, ConnectionMode, type Connection, type Node, type Edge,
  type NodeTypes, type EdgeTypes, type NodeChange,
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import { useRouter } from 'next/navigation'
import { MousePointer2, Pencil, Square, Type, Hand, Frame, Clock, Sparkles, Plus, Minus, Maximize2, Lock, Maximize, Eye, EyeOff, Trash2, type LucideIcon } from 'lucide-react'
import type { Board, List, Card, BoardEdge, BoardElement } from '@/lib/types'
import {
  createList, createFreeCard, deleteEdge, deleteBoard,
  upsertElement, deleteElement, updateListPosition, updateCardPosition,
  updateElement, createSubTab, updateBoardFreePosition, deleteList, deleteCard, upsertEdge,
  updateBoard, updateCard, updateCardDone, updateEdgeShape, setListHidden, setCardHidden, moveElementToBoard, importFolderTree, copyBoardInto,
  loadBoardForFloat, getPresignedReadUrl,
} from '@/app/actions'
import { ListNode, CardNode, ShapeNode, ImageNode, DrawingNode, SubTabNode, TextNode, TextFileNode, FolderLinkNode, DeletableEdge, PortalNode, ClaudeNode, PdfNode } from './nodes'
import { ClaudeMark } from '@/components/claude/ClaudeMark'
import { uploadPdf, extractPdfText, renderPdfThumbnail } from '@/lib/pdf'
import BoardPropertiesPanel from '../BoardPropertiesPanel'
import { unitsStore, type Unit } from '@/lib/unitsStore'
import { collectEntries, readDroppedEntries, PORTAL_ITEM_MIME, FLOAT_BOARD_MIME } from '@/lib/files'
import { claudeDropRegistry } from '@/lib/claudeDropRegistry'
import { STORAGE_URL } from '@/lib/storageUrl'

const nodeTypes: NodeTypes = {
  listNode: ListNode,
  cardNode: CardNode,
  shapeNode: ShapeNode,
  imageNode: ImageNode,
  drawingNode: DrawingNode,
  subTabNode: SubTabNode,
  textNode: TextNode,
  textFileNode: TextFileNode,
  folderLinkNode: FolderLinkNode,
  portalNode: PortalNode,
  claudeNode: ClaudeNode,
  pdfNode: PdfNode,
}

const edgeTypes: EdgeTypes = {
  deletable: DeletableEdge,
}

type Tool = 'select' | 'hand' | 'draw' | 'shape' | 'text' | 'portal' | 'claude'

const TOOL_ICONS: Record<Tool, LucideIcon> = {
  select: MousePointer2,
  hand: Hand,
  draw: Pencil,
  shape: Square,
  text: Type,
  portal: Frame,
  claude: Sparkles,
}
type ShapeType = 'rect' | 'circle' | 'arrow'

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
  onSetExpiry: (nodeId: string) => void,
  onHide: (nodeId: string) => void,
  onDecouple: (nodeId: string) => void,
): Node[] {
  const listNodes: Node[] = lists.map((l, i) => ({
    id: `list-${l.id}`,
    type: 'listNode',
    hidden: l.hidden,
    position: { x: l.x ?? (i * 240), y: l.y ?? 100 },
    zIndex: 0,
    data: {
      name: l.name,
      hidden: l.hidden,
      cardCount: cards.filter(c => c.list_id === l.id).length,
      onAddCard: (nodeId: string) => onAddCard(nodeId.replace('list-', '')),
      onDelete: (nodeId: string) => onDeleteNode(nodeId, 'list'),
      onHide,
      onHold,
    },
  }))

  const cardNodes: Node[] = cards.map(c => ({
    id: `card-${c.id}`,
    type: 'cardNode',
    hidden: c.hidden,
    position: { x: c.x ?? 0, y: c.y ?? 0 },
    zIndex: 0,
    data: {
      title: c.title,
      done: c.done,
      hidden: c.hidden,
      recur: c.recur_interval_minutes,
      listId: c.list_id,
      onDelete: (nodeId: string) => onDeleteNode(nodeId, 'card'),
      onRename: onRenameCard,
      onToggleDone,
      onHide,
      onHold,
    },
  }))

  const elementNodes: Node[] = elements.map(el => {
    const type = el.type === 'shape' ? 'shapeNode' : el.type === 'image' ? 'imageNode' : el.type === 'text' ? 'textNode' : el.type === 'textfile' ? 'textFileNode' : el.type === 'pdf' ? 'pdfNode' : el.type === 'folderlink' ? 'folderLinkNode' : el.type === 'portal' ? 'portalNode' : el.type === 'claude' ? 'claudeNode' : 'drawingNode'
    const base: Node = {
      id: `el-${el.id}`,
      type,
      hidden: !!(el.data.hidden),
      position: { x: el.x, y: el.y },
      data: {
        ...el.data,
        width: el.width ?? undefined,
        height: el.height ?? undefined,
        deadline: el.deadline ?? null,
        onDelete: (nodeId: string) => onDeleteNode(nodeId, 'element'),
        onSave,
        onSetExpiry: (nodeId: string) => onSetExpiry(nodeId),
        onHide: (nodeId: string) => onHide(nodeId),
        ...(el.type === 'portal' ? { onOpenFully: onNavigate } : {}),
        ...(el.type === 'folderlink' ? { onNavigate, onDecouple } : {}),
        // Text/files/links manage their own interaction; everything else scales on hold+scroll
        ...(el.type === 'text' || el.type === 'textfile' || el.type === 'pdf' || el.type === 'folderlink' ? {} : { onHold }),
      },
    }
    if (el.type === 'shape' || el.type === 'portal') base.style = { width: el.width ?? 120, height: el.height ?? 80 }
    if (el.type === 'claude') base.style = { width: el.width ?? 340, height: el.height ?? 420 }
    if (el.type === 'text') base.style = { width: el.width ?? 180, height: el.height ?? 140 }
    const opacity = typeof el.data.opacity === 'number' ? (el.data.opacity as number) : 1
    base.style = { ...(base.style ?? {}), opacity }
    base.zIndex = typeof el.data.z === 'number' ? el.data.z as number : 0
    return base
  })

  const subTabNodes: Node[] = subBoards.map((sb, i) => ({
    id: `sub-${sb.id}`,
    type: 'subTabNode',
    position: { x: sb.free_x ?? (500 + i * 200), y: sb.free_y ?? 400 },
    zIndex: 0,
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

// ── Alignment-guide + grouping helpers (pure, module-level) ───────────────────

// Fallback dimensions when a node hasn't been measured yet.
const DEFAULT_W: Record<string, number> = { listNode: 208, cardNode: 176, shapeNode: 120, portalNode: 320, claudeNode: 340, subTabNode: 176, textNode: 180, textFileNode: 176, pdfNode: 176, folderLinkNode: 160, imageNode: 200, drawingNode: 80 }
const DEFAULT_H: Record<string, number> = { listNode: 60, cardNode: 50, shapeNode: 80, portalNode: 220, claudeNode: 420, subTabNode: 96, textNode: 140, textFileNode: 90, pdfNode: 70, folderLinkNode: 80, imageNode: 150, drawingNode: 80 }

function getNodeWH(n: Node): [number, number] {
  const sw = typeof n.style?.width === 'number' ? (n.style.width as number) : undefined
  const sh = typeof n.style?.height === 'number' ? (n.style.height as number) : undefined
  const w = n.measured?.width ?? sw ?? DEFAULT_W[n.type ?? ''] ?? 120
  const h = n.measured?.height ?? sh ?? DEFAULT_H[n.type ?? ''] ?? 60
  return [w, h]
}

const GUIDE_SNAP = 5 // flow-space px within which the dragged node snaps to an alignment

// Compute the closest alignment for a dragged node against every other node.
// Returns the snapped X/Y (if within threshold) and the guide-line coords to draw.
function computeGuides(
  draggedId: string,
  pos: { x: number; y: number },
  all: Node[],
  exclude?: Set<string>,
): { snapX?: number; snapY?: number; vLine: number | null; hLine: number | null } {
  const dn = all.find(n => n.id === draggedId)
  if (!dn) return { vLine: null, hLine: null }
  const [dw, dh] = getNodeWH(dn)
  const aL = pos.x, aR = pos.x + dw, aCx = pos.x + dw / 2
  const aT = pos.y, aB = pos.y + dh, aCy = pos.y + dh / 2
  let snapX: number | undefined, snapY: number | undefined
  let vLine: number | null = null, hLine: number | null = null
  let bestX = GUIDE_SNAP, bestY = GUIDE_SNAP
  for (const o of all) {
    if (o.id === draggedId || o.hidden) continue
    if (exclude?.has(o.id)) continue
    const [ow, oh] = getNodeWH(o)
    const bL = o.position.x, bR = o.position.x + ow, bCx = o.position.x + ow / 2
    const bT = o.position.y, bB = o.position.y + oh, bCy = o.position.y + oh / 2
    // [draggedAnchor, otherAnchor, candidate-x-so-anchors-align]
    const xs: Array<[number, number, number]> = [
      [aL, bL, bL], [aR, bR, bR - dw], [aCx, bCx, bCx - dw / 2],
      [aL, bR, bR], [aR, bL, bL - dw],
      [aCx, bL, bL - dw / 2], [aCx, bR, bR - dw / 2],
      [aL, bCx, bCx], [aR, bCx, bCx - dw],
    ]
    for (const [av, bv, cand] of xs) {
      const d = Math.abs(av - bv)
      if (d < bestX) { bestX = d; snapX = cand; vLine = bv }
    }
    const ys: Array<[number, number, number]> = [
      [aT, bT, bT], [aB, bB, bB - dh], [aCy, bCy, bCy - dh / 2],
      [aT, bB, bB], [aB, bT, bT - dh],
      [aCy, bT, bT - dh / 2], [aCy, bB, bB - dh / 2],
      [aT, bCy, bCy], [aB, bCy, bCy - dh],
    ]
    for (const [av, bv, cand] of ys) {
      const d = Math.abs(av - bv)
      if (d < bestY) { bestY = d; snapY = cand; hLine = bv }
    }
  }
  return { snapX, snapY, vLine, hLine }
}

// All nodes contained (directly or transitively) by `rootId` via data.parentId.
function descendantsOf(rootId: string, all: Node[]): Set<string> {
  const childrenByParent = new Map<string, string[]>()
  for (const n of all) {
    const p = (n.data as { parentId?: string }).parentId
    if (p) { const a = childrenByParent.get(p) ?? []; a.push(n.id); childrenByParent.set(p, a) }
  }
  const out = new Set<string>()
  const stack = [rootId]
  while (stack.length) {
    const cur = stack.pop() as string
    for (const c of childrenByParent.get(cur) ?? []) {
      if (!out.has(c)) { out.add(c); stack.push(c) }
    }
  }
  return out
}

interface Props {
  board: Board
  initialLists: List[]
  initialCards: Card[]
  initialEdges: BoardEdge[]
  initialElements: BoardElement[]
  initialSubBoards?: Board[]
  onClose?: () => void
  initialInset?: { top: number; right: number; bottom: number; left: number }
}

function FlowCanvas({ board, initialLists, initialCards, initialEdges, initialElements, initialSubBoards = [], onClose, initialInset }: Props) {
  const router = useRouter()
  const { screenToFlowPosition, getViewport, setViewport, getIntersectingNodes, zoomIn, zoomOut, fitView } = useReactFlow()
  const [lists, setLists] = useState(initialLists)
  const [cards, setCards] = useState(initialCards)
  const [elements, setElements] = useState(initialElements)
  const [subBoards, setSubBoards] = useState(initialSubBoards)
  const [tool, setTool] = useState<Tool>('select')
  const [selectedShape, setSelectedShape] = useState<ShapeType>('rect')
  const [drawColor, setDrawColor] = useState('#1d4ed8')
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; flowX: number; flowY: number } | null>(null)
  const [selContextMenu, setSelContextMenu] = useState<{ x: number; y: number; count: number } | null>(null)
  const [shapeColorPicker, setShapeColorPicker] = useState<string>(SHAPE_COLORS[0])
  const [subPanel, setSubPanel] = useState<{ boardId: string; rect: DOMRect } | null>(null)
  const [expiryPanel, setExpiryPanel] = useState<string | null>(null) // nodeId of element being given a deadline
  // Position where the user asked to add a sub-tab — shown while the mode picker is open
  const [subtabPickPos, setSubtabPickPos] = useState<{ x: number; y: number } | null>(null)

  // Alignment guides shown while dragging (flow coords). helperRef avoids re-render churn.
  const [helperLines, setHelperLines] = useState<{ v: number | null; h: number | null }>({ v: null, h: null })
  const helperRef = useRef<{ v: number | null; h: number | null }>({ v: null, h: null })
  // Grouping: the shape currently highlighted as a drop container under the dragged node.
  const [groupHoverId, setGroupHoverId] = useState<string | null>(null)
  const groupHoverRef = useRef<string | null>(null)
  // Live drag tracking so a container's descendants move along with it.
  const groupDragRef = useRef<{ id: string; lastX: number; lastY: number; descIds: Set<string> } | null>(null)
  // Snapshot of a container + its descendants captured at the start of a
  // NodeResizer (corner-handle) resize, so children scale without drift.
  const resizeSnapshotRef = useRef<{
    id: string; ox: number; oy: number; ow: number; oh: number
    kids: Array<{ id: string; x: number; y: number; isBox: boolean; w: number; h: number; scale: number }>
  } | null>(null)

  // Drawing state
  const drawingRef = useRef<{ points: { x: number; y: number }[] } | null>(null)
  const svgOverlayRef = useRef<SVGSVGElement>(null)
  const [currentPath, setCurrentPath] = useState<string>('')

  // Shape click-move-click state (overlay-relative coords)
  // shapeAnchor is a ref so reads in pointer handlers are always synchronous —
  // on dense boards a state update wouldn't commit before the next handler fires.
  const shapeAnchorRef = useRef<{ x: number; y: number } | null>(null)
  const [shapePreview, setShapePreview] = useState<{ x: number; y: number; w: number; h: number } | null>(null)

  // Scale on hold+scroll
  const heldNodeRef = useRef<string | null>(null)
  const wrapperRef = useRef<HTMLDivElement>(null)
  const setNodesRef = useRef<typeof setNodes | null>(null)

  // Middle-mouse panning while a tool overlay is active
  const panRef = useRef<{ sx: number; sy: number; vx: number; vy: number } | null>(null)

  const [allowMarqueeSelection, setAllowMarqueeSelection] = useState(false)

  // Board inset: independent per-edge spacing — free-shape corner drag.
  const defaultInset = initialInset ?? { top: 48, right: 48, bottom: 48, left: 48 }
  const [boardInset, setBoardInset] = useState(defaultInset)
  const boardInsetRef = useRef(defaultInset)
  const [isLocked, setIsLocked] = useState(false)
  const [isFullscreen, setIsFullscreen] = useState(false)
  const cornerDragRef = useRef<{ corner: 'tl' | 'tr' | 'bl' | 'br' } | null>(null)

  // Tracks whether the user is currently dragging a connection so the
  // proximity handler and CSS can treat handles differently.
  const isConnectingRef = useRef(false)

  // Latest elements for persistence callbacks
  const elementsRef = useRef(elements)
  useEffect(() => { elementsRef.current = elements }, [elements])
  useEffect(() => { boardInsetRef.current = boardInset }, [boardInset])

  // Debounced router.refresh() after any drag/save so the 30 s RSC cache is
  // busted before the user navigates away and back.
  const refreshTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const scheduleRefresh = useCallback(() => {
    if (refreshTimer.current) clearTimeout(refreshTimer.current)
    refreshTimer.current = setTimeout(() => router.refresh(), 250)
  }, [router])

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

  function openExpiryPanel(nodeId: string) {
    setExpiryPanel(nodeId)
  }

  // Turn a linked folder into an independent copy (a real child board).
  async function decoupleFolderLink(nodeId: string) {
    const elId = nodeId.replace('el-', '')
    const el = elements.find(e => e.id === elId)
    if (!el) return
    const targetBoardId = el.data.targetBoardId as string
    const x = el.x, y = el.y
    try {
      const top = await copyBoardInto(targetBoardId, board.id, x, y)
      setElements(prev => prev.filter(e => e.id !== elId))
      setSubBoards(prev => [...prev, { ...top, free_x: x, free_y: y } as Board])
      setNodes(prev => prev.filter(n => n.id !== nodeId).concat({
        id: `sub-${top.id}`, type: 'subTabNode', position: { x, y },
        data: { boardId: top.id, name: top.name, color: top.color, mode: top.mode, onNavigate: navigate, onDelete: (id: string) => handleDeleteNode(id, 'subtab'), onRename: renameSubTab, onOpenPanel: openSubPanel, onHold: holdNode },
      }))
      deleteElement(elId).catch(err => console.error('Failed to remove link after decouple:', err))
    } catch (err) {
      console.error('Failed to decouple folder link:', err)
    }
  }

  function hideUnit(nodeId: string, hidden: boolean) {
    setNodes(prev => prev.map(n =>
      n.id === nodeId ? { ...n, hidden, data: { ...n.data, hidden } } : n
    ))
    try {
      const key = `hiddenmap-${board.id}`
      const stored = localStorage.getItem(key)
      const map: Record<string, boolean> = stored ? JSON.parse(stored) : {}
      if (hidden) { map[nodeId] = true } else { delete map[nodeId] }
      localStorage.setItem(key, JSON.stringify(map))
    } catch {}
    const rawId = nodeId.replace(/^(el-|list-|card-)/, '')
    if (nodeId.startsWith('el-')) {
      const el = elements.find(e => e.id === rawId)
      if (el) {
        const newData = { ...el.data, hidden }
        updateElement(el.id, { data: newData }).catch(err => console.error('hide element failed:', err))
        setElements(prev => prev.map(e => e.id === rawId ? { ...e, data: newData } : e))
      }
    } else if (nodeId.startsWith('list-')) {
      setListHidden(rawId, hidden, board.id).catch(err => console.error('hide list failed:', err))
      setLists(prev => prev.map(l => l.id === rawId ? { ...l, hidden } : l))
    } else if (nodeId.startsWith('card-')) {
      setCardHidden(rawId, hidden, board.id).catch(err => console.error('hide card failed:', err))
      setCards(prev => prev.map(c => c.id === rawId ? { ...c, hidden } : c))
    }
    // Bust the router cache so navigating away and back sees the correct hidden
    // state even within the 30 s stale window.
    router.refresh()
  }

  function renameSubTab(boardId: string, name: string) {
    setSubBoards(prev => prev.map(b => b.id === boardId ? { ...b, name } : b))
    setNodesRef.current?.(prev => prev.map(n => n.id === `sub-${boardId}` ? { ...n, data: { ...n.data, name } } : n))
    updateBoard(boardId, { name }).catch(err => console.error('Failed to rename tab:', err))
  }

  function openSubPanel(boardId: string, rect: DOMRect) {
    setSubPanel(prev => prev?.boardId === boardId ? null : { boardId, rect })
  }

  const [nodes, setNodes, onNodesChangeRaw] = useNodesState(
    buildNodes(lists, cards, elements, subBoards, () => {}, handleDeleteNode, navigate, holdNode, saveElement, renameCard, renameSubTab, openSubPanel, toggleCardDone, openExpiryPanel, (id) => hideUnit(id, true), (id) => decoupleFolderLink(id))
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

  // ── Alignment guides + grouping ─────────────────────────────────────────────

  // Persist the child→parent grouping map to localStorage. Works for every node
  // type with no schema change (mirrors how z-order is persisted via zmap).
  const persistGroupMap = useCallback(() => {
    try {
      const map: Record<string, string> = {}
      for (const n of nodesRef.current) {
        const p = (n.data as { parentId?: string }).parentId
        if (p) map[n.id] = p
      }
      localStorage.setItem(`groupmap-${board.id}`, JSON.stringify(map))
    } catch {}
  }, [board.id])

  // Persist a node's position only (after a group move).
  const persistPos = useCallback((n: Node) => {
    const { x, y } = n.position
    if (n.id.startsWith('list-')) updateListPosition(n.id.replace('list-', ''), x, y)
    else if (n.id.startsWith('card-')) updateCardPosition(n.id.replace('card-', ''), x, y)
    else if (n.id.startsWith('sub-')) updateBoardFreePosition(n.id.replace('sub-', ''), x, y)
    else if (n.id.startsWith('el-')) updateElement(n.id.replace('el-', ''), { x, y })
  }, [])

  // Persist a node's position + size/scale (after a group resize). Element children
  // persist fully; lists/cards/sub-tabs persist position (their scale is view-only).
  const persistNodeFull = useCallback((n: Node) => {
    if (n.id.startsWith('el-')) {
      const sized = n.type === 'shapeNode' || n.type === 'portalNode' || n.type === 'claudeNode'
      const w = sized ? (Number(n.style?.width) || (n.data.width as number) || undefined) : undefined
      const h = sized ? (Number(n.style?.height) || (n.data.height as number) || undefined) : undefined
      saveElement(n.id, n.data, w, h)
    }
    persistPos(n)
  }, [persistPos, saveElement])

  // Wrapped onNodesChange: snaps a single dragged node to alignment guides, surfaces
  // the active guide lines, scales a container's children during a corner-handle
  // resize, then defers to React Flow's default handler.
  const onNodesChange = useCallback((changes: NodeChange[]) => {
    let v: number | null = null
    let h: number | null = null
    if (changes.length === 1) {
      const ch = changes[0] as { id?: string; type?: string; dragging?: boolean; position?: { x: number; y: number } }
      if (ch.type === 'position' && ch.dragging && ch.position && ch.id) {
        const g = computeGuides(ch.id, ch.position, nodesRef.current, groupDragRef.current?.descIds)
        if (g.snapX != null) { ch.position.x = g.snapX; v = g.vLine }
        if (g.snapY != null) { ch.position.y = g.snapY; h = g.hLine }
      }
    }
    if (helperRef.current.v !== v || helperRef.current.h !== h) {
      helperRef.current = { v, h }
      setHelperLines({ v, h })
    }

    onNodesChangeRaw(changes)

    // ── NodeResizer (corner-handle) group scaling ──────────────────────────────
    // NodeResizer reports resizes as `dimensions` changes (resizing:true) plus a
    // `position` change when the top/left handle moves the origin. We capture a
    // start snapshot on the first frame and map every descendant from it so the
    // group scales/repositions without drift.
    const dim = changes.find(c => c.type === 'dimensions') as
      { id?: string; type?: string; dimensions?: { width: number; height: number }; resizing?: boolean } | undefined

    if (dim?.resizing && dim.dimensions && dim.id) {
      const id = dim.id
      const container = nodesRef.current.find(n => n.id === id)
      if (container && container.type === 'shapeNode') {
        if (!resizeSnapshotRef.current || resizeSnapshotRef.current.id !== id) {
          const descSet = descendantsOf(id, nodesRef.current)
          if (descSet.size > 0) {
            const [ow, oh] = getNodeWH(container)
            const kids = [...descSet].map(kid => {
              const n = nodesRef.current.find(x => x.id === kid)!
              const [w, kh] = getNodeWH(n)
              const isBox = n.type === 'shapeNode' || n.type === 'portalNode' || n.type === 'claudeNode'
              return { id: kid, x: n.position.x, y: n.position.y, isBox, w, h: kh, scale: (n.data.scale as number) ?? 1 }
            })
            resizeSnapshotRef.current = { id, ox: container.position.x, oy: container.position.y, ow, oh, kids }
          }
        }
        const snap = resizeSnapshotRef.current
        if (snap && snap.id === id && snap.kids.length > 0) {
          const sx = snap.ow ? dim.dimensions.width / snap.ow : 1
          const sy = snap.oh ? dim.dimensions.height / snap.oh : 1
          const sAvg = Math.sqrt(Math.max(0.0001, sx * sy))
          const posChange = changes.find(c => c.type === 'position' && (c as { id?: string }).id === id) as { position?: { x: number; y: number } } | undefined
          const nx = posChange?.position?.x ?? snap.ox
          const ny = posChange?.position?.y ?? snap.oy
          setNodes(prev => prev.map(n => {
            const kid = snap.kids.find(k => k.id === n.id)
            if (!kid) return n
            const px = nx + (kid.x - snap.ox) * sx
            const py = ny + (kid.y - snap.oy) * sy
            if (kid.isBox) {
              const w = Math.max(20, kid.w * sx), hh = Math.max(20, kid.h * sy)
              return { ...n, position: { x: px, y: py }, style: { ...n.style, width: w, height: hh }, data: { ...n.data, width: w, height: hh } }
            }
            return { ...n, position: { x: px, y: py }, data: { ...n.data, scale: Math.max(0.1, Math.min(8, kid.scale * sAvg)) } }
          }))
        }
      }
    } else if (resizeSnapshotRef.current && (!dim || dim.resizing === false)) {
      // Resize ended → persist every descendant that scaled, then clear.
      const snap = resizeSnapshotRef.current
      resizeSnapshotRef.current = null
      for (const kid of snap.kids) {
        const n = nodesRef.current.find(x => x.id === kid.id)
        if (n) persistNodeFull(n)
      }
      scheduleRefresh()
    }
  }, [onNodesChangeRaw, setNodes, persistNodeFull, scheduleRefresh])

  // Capture descendants of the node about to be dragged so we can move them with it.
  const onNodeDragStart = useCallback((_e: unknown, node: Node) => {
    groupDragRef.current = { id: node.id, lastX: node.position.x, lastY: node.position.y, descIds: descendantsOf(node.id, nodesRef.current) }
  }, [])

  // While dragging a container, translate descendants by the same delta; also
  // highlight the shape the node would drop into.
  const onNodeDrag = useCallback((_e: unknown, node: Node) => {
    const g = groupDragRef.current
    if (g && g.id === node.id && g.descIds.size > 0) {
      const dx = node.position.x - g.lastX
      const dy = node.position.y - g.lastY
      if (dx !== 0 || dy !== 0) {
        g.lastX = node.position.x; g.lastY = node.position.y
        setNodes(prev => prev.map(n => (g.descIds.has(n.id) && !n.selected)
          ? { ...n, position: { x: n.position.x + dx, y: n.position.y + dy } }
          : n))
      }
    }
    let hover: string | null = null
    let bestArea = Infinity
    for (const c of getIntersectingNodes(node)) {
      if (c.type !== 'shapeNode' || c.id === node.id || g?.descIds.has(c.id)) continue
      const [w, h] = getNodeWH(c)
      const area = w * h
      if (area < bestArea) { bestArea = area; hover = c.id }
    }
    if (groupHoverRef.current !== hover) { groupHoverRef.current = hover; setGroupHoverId(hover) }
  }, [setNodes, getIntersectingNodes])

  // ── Create a free-mode element (client-controlled id so undo can restore it) ──
  function addElement(
    type: 'shape' | 'drawing' | 'text' | 'image' | 'portal' | 'textfile' | 'folderlink' | 'claude' | 'pdf',
    x: number, y: number,
    data: Record<string, unknown>,
    w?: number, h?: number,
    extraNodeData?: Record<string, unknown>,
  ) {
    const id = crypto.randomUUID()
    const nodeId = `el-${id}`
    const nodeType = type === 'shape' ? 'shapeNode' : type === 'drawing' ? 'drawingNode' : type === 'text' ? 'textNode' : type === 'textfile' ? 'textFileNode' : type === 'pdf' ? 'pdfNode' : type === 'folderlink' ? 'folderLinkNode' : type === 'portal' ? 'portalNode' : type === 'claude' ? 'claudeNode' : 'imageNode'
    const node: Node = {
      id: nodeId, type: nodeType, position: { x, y },
      ...(type === 'shape' || type === 'portal' || type === 'claude' || type === 'text' ? { style: { width: w, height: h } } : {}),
      data: {
        ...data,
        onDelete: (i: string) => handleDeleteNode(i, 'element'),
        onSave: saveElement,
        onHide: (i: string) => hideUnit(i, true),
        onSetExpiry: (i: string) => openExpiryPanel(i),
        ...(type === 'text' || type === 'textfile' || type === 'pdf' || type === 'folderlink' ? {} : { onHold: holdNode }),
        ...extraNodeData,
      },
    }
    setNodes(prev => [...prev, node])
    setElements(prev => [...prev, { id, board_id: board.id, type, x, y, width: w ?? null, height: h ?? null, data, created_at: new Date().toISOString() } as BoardElement])
    upsertElement(id, board.id, type, x, y, data, w ?? null, h ?? null).catch(err => console.error('Failed to save element:', err))
    return nodeId
  }

  // ── Drag & drop OS text files onto the canvas ──
  const [fileDragOver, setFileDragOver] = useState(false)
  const dragCountRef = useRef(0)
  // Which node (claude or subtab) the drag is magnetically hovering over
  const [dropTarget, setDropTarget] = useState<{ nodeId: string; type: 'claude' | 'subtab' } | null>(null)
  const MAGNETIC_RADIUS = 120 // flow-space units

  // Use a counter so entering child elements doesn't flicker the overlay off.
  // The counter is also reset by a global 'dragend' listener so an abandoned drag
  // (pointer released outside the window) never leaves the overlay stuck.
  useEffect(() => {
    const reset = () => { dragCountRef.current = 0; setFileDragOver(false); setDropTarget(null) }
    window.addEventListener('dragend', reset)
    document.addEventListener('dragleave', (e: DragEvent) => { if (!e.relatedTarget) reset() })
    return () => {
      window.removeEventListener('dragend', reset)
    }
  }, [])

  function onCanvasDragEnter(e: React.DragEvent) {
    const types = Array.from(e.dataTransfer.types)
    if (!types.includes('Files') && !types.includes(PORTAL_ITEM_MIME)) return
    dragCountRef.current++
    if (types.includes('Files')) setFileDragOver(true)
  }

  function onCanvasDragOver(e: React.DragEvent) {
    const types = Array.from(e.dataTransfer.types)
    const isFiles = types.includes('Files')
    const isPortalItem = types.includes(PORTAL_ITEM_MIME)
    if (!isFiles && !isPortalItem) return
    e.preventDefault()
    e.dataTransfer.dropEffect = 'copy'

    // Magnetic targeting — activate when cursor is within node bounds (+ MAGNETIC_RADIUS outside edges)
    const flowPos = screenToFlowPosition({ x: e.clientX, y: e.clientY })
    let closest: { nodeId: string; type: 'claude' | 'subtab'; dist: number } | null = null
    for (const n of nodesRef.current) {
      if (n.type !== 'claudeNode' && n.type !== 'subTabNode') continue
      const w = n.measured?.width ?? (n.type === 'claudeNode' ? 340 : 150)
      const h = n.measured?.height ?? (n.type === 'claudeNode' ? 420 : 60)
      const inBounds =
        flowPos.x >= n.position.x - MAGNETIC_RADIUS &&
        flowPos.x <= n.position.x + w + MAGNETIC_RADIUS &&
        flowPos.y >= n.position.y - MAGNETIC_RADIUS &&
        flowPos.y <= n.position.y + h + MAGNETIC_RADIUS
      if (!inBounds) continue
      const cx = n.position.x + w / 2
      const cy = n.position.y + h / 2
      const dist = Math.hypot(flowPos.x - cx, flowPos.y - cy)
      if (!closest || dist < closest.dist) {
        closest = { nodeId: n.id, type: n.type === 'claudeNode' ? 'claude' : 'subtab', dist }
      }
    }
    setDropTarget(closest ? { nodeId: closest.nodeId, type: closest.type } : null)
  }

  async function uploadTextToR2(name: string, content: string): Promise<Record<string, unknown> | null> {
    try {
      const blob = new Blob([content], { type: 'text/plain' })
      const file = new File([blob], name, { type: 'text/plain' })
      const form = new FormData()
      form.append('file', file); form.append('app', 'hub')
      form.append('subpath', `textfiles/${crypto.randomUUID()}-${name}`)
      const res = await fetch(`${STORAGE_URL}/api/storage/upload`, { method: 'POST', body: form })
      if (!res.ok) return null
      const { key } = await res.json() as { key: string }
      return { name, storagePath: key, sizeBytes: blob.size }
    } catch {
      return null
    }
  }

  async function onCanvasDrop(e: React.DragEvent) {
    // A unit dragged out of a portal → copy it onto this canvas.
    const portalRaw = e.dataTransfer.getData(PORTAL_ITEM_MIME)
    // Capture directory entries synchronously before any await.
    const entries = collectEntries(e.dataTransfer)
    if (!portalRaw && !entries && !e.dataTransfer.files?.length) return
    e.preventDefault()
    dragCountRef.current = 0
    setFileDragOver(false)
    const currentDropTarget = dropTarget
    setDropTarget(null)
    const origin = screenToFlowPosition({ x: e.clientX, y: e.clientY })

    if (portalRaw) {
      try {
        const item = JSON.parse(portalRaw) as { kind: 'file'; name: string; content: string; storagePath?: string } | { kind: 'folder'; boardId: string; name: string }
        if (item.kind === 'file') {
          // Route portal file to drop target if one is active
          if (currentDropTarget?.type === 'claude') {
            claudeDropRegistry.inject(currentDropTarget.nodeId, { id: crypto.randomUUID(), name: item.name, content: item.content, kind: 'text' })
          } else {
            // R2-backed portal files: fetch content and upload as a new R2 object (true copy).
            const placeFile = async (elData: Record<string, unknown>) => {
              if (currentDropTarget?.type === 'subtab') {
                const targetBoardId = currentDropTarget.nodeId.replace('sub-', '')
                upsertElement(crypto.randomUUID(), targetBoardId, 'textfile', 20, 20, elData, null, null)
                  .catch(err => console.error('Failed to drop file into sub-tab:', err))
              } else {
                addElement('textfile', origin.x, origin.y, elData)
              }
            }
            if (item.storagePath && !item.content) {
              ;(async () => {
                try {
                  const r = await getPresignedReadUrl(item.storagePath!)
                  if (!r.ok || !r.url) { placeFile({ name: item.name, content: '' }); return }
                  const fetchRes = await fetch(r.url)
                  const text = fetchRes.ok ? await fetchRes.text() : ''
                  const blob = new Blob([text], { type: 'text/plain' })
                  const f = new File([blob], item.name, { type: 'text/plain' })
                  const form = new FormData()
                  form.append('file', f); form.append('app', 'hub')
                  form.append('subpath', `textfiles/${crypto.randomUUID()}-${item.name}`)
                  const res = await fetch(`${STORAGE_URL}/api/storage/upload`, { method: 'POST', body: form })
                  if (res.ok) {
                    const { key } = await res.json() as { key: string }
                    placeFile({ name: item.name, storagePath: key, sizeBytes: blob.size })
                  } else {
                    placeFile({ name: item.name, content: '' })
                  }
                } catch { placeFile({ name: item.name, content: '' }) }
              })()
            } else {
              placeFile({ name: item.name, content: item.content })
            }
          }
        } else if (item.kind === 'folder') {
          // Default: a live link to the original folder (decouple later to copy).
          addElement('folderlink', origin.x, origin.y, { targetBoardId: item.boardId, name: item.name }, undefined, undefined, {
            onNavigate: navigate,
            onDecouple: (nid: string) => decoupleFolderLink(nid),
          })
        }
      } catch (err) {
        console.error('Failed to copy portal item:', err)
      }
      return
    }

    const { trees, files, pdfs, skipped } = await readDroppedEntries(entries, e.dataTransfer.files)

    if (currentDropTarget?.type === 'claude') {
      // Inject all text files directly into the chat composer (append one after another)
      files.forEach(f => claudeDropRegistry.inject(currentDropTarget.nodeId, { id: crypto.randomUUID(), name: f.name, content: f.content, kind: 'text' }))
    } else if (currentDropTarget?.type === 'subtab') {
      const targetBoardId = currentDropTarget.nodeId.replace('sub-', '')
      for (let i = 0; i < files.length; i++) {
        const f = files[i]
        const elData = await uploadTextToR2(f.name, f.content) ?? { name: f.name, content: f.content }
        upsertElement(crypto.randomUUID(), targetBoardId, 'textfile', 20 + i * 24, 20 + i * 24, elData, null, null)
          .catch(err => console.error('Failed to drop file into sub-tab:', err))
      }
    } else {
      for (let i = 0; i < files.length; i++) {
        const f = files[i]
        const elData = await uploadTextToR2(f.name, f.content) ?? { name: f.name, content: f.content }
        addElement('textfile', origin.x + i * 24, origin.y + i * 24, elData)
      }
    }

    // PDFs: upload the binary to storage + extract text (so Claude can read it),
    // then route the same way as text files.
    for (let i = 0; i < pdfs.length; i++) {
      const pdf = pdfs[i]
      try {
        const [{ key: storagePath, sizeBytes }, { text, pageCount }] = await Promise.all([uploadPdf(pdf, board.id), extractPdfText(pdf)])
        const pdfData = { name: pdf.name, storagePath, sizeBytes, text, pageCount }
        if (currentDropTarget?.type === 'claude') {
          // Generate thumbnail for the attachment chip (best-effort — non-blocking)
          const thumbnail = await renderPdfThumbnail(pdf).catch(() => '')
          claudeDropRegistry.inject(currentDropTarget.nodeId, {
            id: crypto.randomUUID(), name: pdf.name,
            content: text || '(no extractable text in this PDF)',
            kind: 'pdf', thumbnail: thumbnail || undefined,
          })
        } else if (currentDropTarget?.type === 'subtab') {
          const targetBoardId = currentDropTarget.nodeId.replace('sub-', '')
          const id = crypto.randomUUID()
          upsertElement(id, targetBoardId, 'pdf', 20 + i * 24, 20 + i * 24, pdfData, null, null)
            .catch(err => console.error('Failed to drop PDF into sub-tab:', err))
        } else {
          addElement('pdf', origin.x + (files.length + i) * 24, origin.y + (files.length + i) * 24, pdfData)
        }
      } catch (err) {
        console.error('Failed to add PDF:', err)
        alert(`Could not add "${pdf.name}". ${err instanceof Error ? err.message : ''}`)
      }
    }

    // Each dropped folder becomes a sub-tab (folder board) node on the canvas,
    // regardless of drop target (folders are complex structures — always import here).
    for (let i = 0; i < trees.length; i++) {
      const x = origin.x + (files.length + i) * 28, y = origin.y + (files.length + i) * 28
      const top = await importFolderTree(board.id, trees[i], board.color)
      await updateBoardFreePosition(top.id, x, y)
      const newSub = { ...top, free_x: x, free_y: y } as Board
      setSubBoards(prev => [...prev, newSub])
      setNodes(prev => [...prev, {
        id: `sub-${top.id}`, type: 'subTabNode', position: { x, y },
        data: { boardId: top.id, name: top.name, color: top.color, mode: top.mode, onNavigate: navigate, onDelete: (id: string) => handleDeleteNode(id, 'subtab'), onRename: renameSubTab, onOpenPanel: openSubPanel, onHold: holdNode },
      }])
    }
    if (skipped.length && !files.length && !trees.length && !pdfs.length) {
      alert('Only text and PDF files are supported for now.')
    }
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
        n: ns.map(n => ({ id: n.id, p: { x: Math.round(n.position.x), y: Math.round(n.position.y) }, s: n.style, d: n.data, h: n.hidden })),
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
    const elTypeOf = (t?: string) => t === 'shapeNode' ? 'shape' : t === 'drawingNode' ? 'drawing' : t === 'textNode' ? 'text' : t === 'textFileNode' ? 'textfile' : t === 'pdfNode' ? 'pdf' : t === 'folderLinkNode' ? 'folderlink' : t === 'portalNode' ? 'portal' : t === 'claudeNode' ? 'claude' : 'image'
    const clean = (d: Record<string, unknown>) => Object.fromEntries(Object.entries(d).filter(([, v]) => typeof v !== 'function'))
    const targetEls = s.nodes.filter(n => n.id.startsWith('el-'))
    const targetIds = new Set(targetEls.map(n => n.id.replace('el-', '')))
    // upsert everything in the target snapshot
    for (const n of targetEls) {
      const id = n.id.replace('el-', '')
      const type = elTypeOf(n.type) as BoardElement['type']
      const sized = type === 'shape' || type === 'portal' || type === 'claude'
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
      const sized = type === 'shape' || type === 'portal' || type === 'claude'
      return {
        id, board_id: board.id, type, x: n.position.x, y: n.position.y,
        width: sized ? (Number(n.style?.width) || (n.data.width as number) || null) : (existing?.width ?? null),
        height: sized ? (Number(n.style?.height) || (n.data.height as number) || null) : (existing?.height ?? null),
        data: clean(n.data), created_at: existing?.created_at ?? new Date().toISOString(),
      } as BoardElement
    }))
    // restore positions + hidden state of lists / cards / sub-tabs
    for (const n of s.nodes) {
      if (n.id.startsWith('list-')) {
        const rawId = n.id.replace('list-', '')
        updateListPosition(rawId, n.position.x, n.position.y)
        setListHidden(rawId, !!(n.data.hidden), board.id).catch(() => {})
        setLists(prev => prev.map(l => l.id === rawId ? { ...l, hidden: !!(n.data.hidden) } : l))
      } else if (n.id.startsWith('card-')) {
        const rawId = n.id.replace('card-', '')
        updateCardPosition(rawId, n.position.x, n.position.y)
        setCardHidden(rawId, !!(n.data.hidden), board.id).catch(() => {})
        setCards(prev => prev.map(c => c.id === rawId ? { ...c, hidden: !!(n.data.hidden) } : c))
      } else if (n.id.startsWith('sub-')) {
        updateBoardFreePosition(n.id.replace('sub-', ''), n.position.x, n.position.y)
      }
    }
  }

  function applySnapshot(s: Snapshot) {
    restoringRef.current = true
    setNodes(s.nodes)
    setEdges(s.edges)
    lastSnapRef.current = s
    lastSigRef.current = sigOf(s.nodes, s.edges)
    reconcileDb(s)
    // Keep the grouping map in sync with the restored node state.
    setTimeout(() => { persistGroupMap(); restoringRef.current = false }, 0)
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
      if (!heldNodeRef.current) return
      e.preventDefault()
      e.stopPropagation()
      const factor = e.deltaY > 0 ? 0.9 : 1.1
      setNodesRef.current!(prev => {
        const held = prev.find(x => x.id === heldNodeRef.current)
        if (!held) return prev
        // Only boxes carry descendants; scale + reposition them around the box origin.
        const isBox = held.type === 'shapeNode' || held.type === 'portalNode'
        const descIds = isBox ? descendantsOf(held.id, prev) : new Set<string>()
        const ox = held.position.x, oy = held.position.y
        return prev.map(n => {
          if (n.id === heldNodeRef.current) {
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
          }
          if (descIds.has(n.id)) {
            const nx = ox + (n.position.x - ox) * factor
            const ny = oy + (n.position.y - oy) * factor
            if (n.type === 'shapeNode' || n.type === 'portalNode' || n.type === 'claudeNode') {
              const cw = Number(n.style?.width) || n.measured?.width || (n.data.width as number) || 120
              const chh = Number(n.style?.height) || n.measured?.height || (n.data.height as number) || 80
              const w = Math.max(20, cw * factor), h = Math.max(20, chh * factor)
              return { ...n, position: { x: nx, y: ny }, style: { ...n.style, width: w, height: h }, data: { ...n.data, width: w, height: h } }
            }
            const sc = (n.data.scale as number) ?? 1
            return { ...n, position: { x: nx, y: ny }, data: { ...n.data, scale: Math.max(0.1, Math.min(8, sc * factor)) } }
          }
          return n
        })
      })
    }
    el.addEventListener('wheel', handleWheel, { passive: false, capture: true })
    return () => el.removeEventListener('wheel', handleWheel, { capture: true } as EventListenerOptions)
  }, [])

  // ── Proximity-based handle reveal ─────────────────────────────────────────
  // Each mousemove samples the distance from the cursor to every handle's
  // centre and writes opacity directly as an inline style. The CSS baseline
  // (opacity:0 + transition:0.18s) provides the smooth fade-in and the
  // mouseleave fade-out; during connecting this entire path is skipped so
  // the CSS .rf-connecting rule can take over.
  useEffect(() => {
    const el = wrapperRef.current
    if (!el) return

    function onMouseMove(e: MouseEvent) {
      if (isConnectingRef.current) return // CSS handles visibility during active connection drag
      const handles = el!.querySelectorAll<HTMLElement>('.react-flow__handle')
      for (const h of handles) {
        const r = h.getBoundingClientRect()
        const dist = Math.hypot(e.clientX - (r.left + r.width / 2), e.clientY - (r.top + r.height / 2))
        // Full opacity within 22 px, invisible beyond 110 px — linear ramp between
        const opacity = Math.max(0, Math.min(1, 1 - (dist - 22) / 88))
        h.style.opacity = String(Math.round(opacity * 100) / 100)
      }
    }

    function onMouseLeave() {
      // Remove inline override → CSS baseline (opacity:0, transition) fades handles out
      el!.querySelectorAll<HTMLElement>('.react-flow__handle').forEach(h => { h.style.opacity = '' })
    }

    el.addEventListener('mousemove', onMouseMove)
    el.addEventListener('mouseleave', onMouseLeave)
    return () => {
      el.removeEventListener('mousemove', onMouseMove)
      el.removeEventListener('mouseleave', onMouseLeave)
    }
  }, []) // stable — uses refs only

  function handleWrapperMouseUp() {
    if (!heldNodeRef.current) return
    const heldId = heldNodeRef.current
    heldNodeRef.current = null
    const node = nodesRef.current.find(n => n.id === heldId)
    if (!node) return
    if (heldId.startsWith('el-')) {
      const rawId = heldId.replace('el-', '')
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
    // If a container was resized, persist every descendant that scaled with it.
    const descIds = descendantsOf(heldId, nodesRef.current)
    if (descIds.size > 0) {
      for (const id of descIds) {
        const dn = nodesRef.current.find(n => n.id === id)
        if (dn) persistNodeFull(dn)
      }
      scheduleRefresh()
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
    // Clear transient drag overlays.
    if (groupHoverRef.current !== null) { groupHoverRef.current = null; setGroupHoverId(null) }
    if (helperRef.current.v !== null || helperRef.current.h !== null) { helperRef.current = { v: null, h: null }; setHelperLines({ v: null, h: null }) }
    const g = groupDragRef.current
    groupDragRef.current = null

    // Drop a file block onto a folder/sub-tab node → move it into that board.
    if (node.type === 'textFileNode') {
      const target = getIntersectingNodes(node).find(n => n.id.startsWith('sub-'))
      if (target) {
        const elId = node.id.replace('el-', '')
        const targetBoardId = target.id.replace('sub-', '')
        setNodes(prev => prev.filter(n => n.id !== node.id))
        setElements(prev => prev.filter(e => e.id !== elId))
        moveElementToBoard(elId, targetBoardId, board.id).catch(err => console.error('Failed to move file:', err))
        return
      }
    }

    // ── Grouping: did the node land inside a shape container? ──
    const desc = g?.descIds ?? new Set<string>()
    let container: string | null = null
    let bestArea = Infinity
    for (const c of getIntersectingNodes(node)) {
      if (c.type !== 'shapeNode' || c.id === node.id || desc.has(c.id)) continue
      const [w, h] = getNodeWH(c)
      const area = w * h
      if (area < bestArea) { bestArea = area; container = c.id }
    }
    const curParent = (node.data as { parentId?: string }).parentId ?? null
    if (container !== curParent) {
      setNodes(prev => {
        const containerZ = container ? (prev.find(p => p.id === container)?.zIndex ?? 0) : 0
        return prev.map(n => n.id === node.id
          ? { ...n, data: { ...n.data, parentId: container ?? undefined }, zIndex: container ? Math.max(n.zIndex ?? 0, containerZ + 1) : n.zIndex }
          : n)
      })
      if (node.id.startsWith('el-')) {
        const raw = node.id.replace('el-', '')
        const el = elementsRef.current.find(e => e.id === raw)
        if (el) {
          const nd = { ...el.data, parentId: container ?? null }
          setElements(prev => prev.map(e => e.id === raw ? { ...e, data: nd } : e))
          updateElement(raw, { data: nd }).catch(() => {})
        }
      }
      setTimeout(persistGroupMap, 0)
    }

    // ── Persist positions: the dragged node + every descendant that moved. ──
    persistPos(node)
    for (const id of desc) {
      const dn = nodesRef.current.find(n => n.id === id)
      if (dn) persistPos(dn)
    }
    // Bust the router cache so the updated positions are visible on next visit.
    scheduleRefresh()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scheduleRefresh, getIntersectingNodes, persistPos, persistGroupMap])

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
        data: { title: card.title, done: card.done, hidden: false, listId, onDelete: (id: string) => handleDeleteNode(id, 'card'), onRename: renameCard, onToggleDone: toggleCardDone, onHide: (id: string) => hideUnit(id, true), onHold: holdNode },
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
        data: { title: card.title, done: card.done, hidden: false, listId, onDelete: (id: string) => handleDeleteNode(id, 'card'), onRename: renameCard, onToggleDone: toggleCardDone, onHide: (id: string) => hideUnit(id, true), onHold: holdNode },
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
        const form = new FormData()
        form.append('file', file)
        form.append('app', 'hub')
        form.append('subpath', `images/${crypto.randomUUID()}-${file.name}`)
        try {
          const res = await fetch(`${STORAGE_URL}/api/storage/upload`, { method: 'POST', body: form })
          if (!res.ok) { console.error('Image upload failed:', res.status); return }
          const { key, presignedUrl } = await res.json() as { key: string; presignedUrl: string }
          addElement('image', x, y, { url: presignedUrl, storagePath: key, sizeBytes: file.size, alt: file.name })
        } catch (err) {
          console.error('Image upload error:', err)
        }
      }
      input.click()
    }

    if (action === 'subtab') {
      // Show the mode picker at the drop position; actual creation happens when user picks.
      setSubtabPickPos({ x, y })
    }

    if (action === 'draw') setTool('draw')
    if (action === 'shape') setTool('shape')
  }

  function getEffectiveSel(): string[] {
    const panelIds = unitsStore.getPanelSel()
    const canvasIds = nodesRef.current.filter(n => n.selected).map(n => n.id)
    return [...new Set([...panelIds, ...canvasIds])]
  }

  function handleSelAction(action: 'hide' | 'show' | 'delete') {
    const ids = getEffectiveSel()
    if (action === 'hide') {
      ids.forEach(id => unitsStore.setHidden(id, true))
    } else if (action === 'show') {
      ids.forEach(id => unitsStore.setHidden(id, false))
    } else {
      for (const id of ids) {
        const kind = nodeKind(id)
        if (kind) handleDeleteNode(id, kind)
      }
    }
    unitsStore.setPanelSel(new Set())
    setSelContextMenu(null)
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
    if (!shapeAnchorRef.current) {
      shapeAnchorRef.current = pt
      setShapePreview({ x: pt.x, y: pt.y, w: 0, h: 0 })
      return
    }
    // Second click — commit
    const x = Math.min(shapeAnchorRef.current.x, pt.x)
    const y = Math.min(shapeAnchorRef.current.y, pt.y)
    const w = Math.abs(pt.x - shapeAnchorRef.current.x) || 120
    const h = Math.abs(pt.y - shapeAnchorRef.current.y) || 80
    shapeAnchorRef.current = null
    setShapePreview(null)
    const flowPos = overlayToFlow(x, y)
    addElement('shape', flowPos.x, flowPos.y, { shape: selectedShape, fill: shapeColorPicker, label: '', width: w, height: h, rotation: 0 }, w, h)
    // Stay in shape mode for further shapes; click Select to stop
  }

  // ── Portal: draw a rectangle (click, move, click) that views another tab ──
  function onPortalPointerDown(e: React.PointerEvent<SVGSVGElement>) {
    if (tool !== 'portal') return
    const pt = getOverlayPoint(e.clientX, e.clientY)
    if (!shapeAnchorRef.current) {
      shapeAnchorRef.current = pt
      setShapePreview({ x: pt.x, y: pt.y, w: 0, h: 0 })
      return
    }
    const x = Math.min(shapeAnchorRef.current.x, pt.x)
    const y = Math.min(shapeAnchorRef.current.y, pt.y)
    const w = Math.abs(pt.x - shapeAnchorRef.current.x) || 320
    const h = Math.abs(pt.y - shapeAnchorRef.current.y) || 220
    shapeAnchorRef.current = null
    setShapePreview(null)
    const flowPos = overlayToFlow(x, y)
    addElement('portal', flowPos.x, flowPos.y, { targetBoardId: null, home: board.id, vx: 20, vy: 20, zoom: 0.4, width: w, height: h }, w, h, { onOpenFully: navigate })
    setTool('select')
  }

  // ── Claude: draw a box (click, move, click) that becomes a live Claude chat ──
  function onClaudePointerDown(e: React.PointerEvent<SVGSVGElement>) {
    if (tool !== 'claude') return
    const pt = getOverlayPoint(e.clientX, e.clientY)
    if (!shapeAnchorRef.current) {
      shapeAnchorRef.current = pt
      setShapePreview({ x: pt.x, y: pt.y, w: 0, h: 0 })
      return
    }
    const x = Math.min(shapeAnchorRef.current.x, pt.x)
    const y = Math.min(shapeAnchorRef.current.y, pt.y)
    const w = Math.abs(pt.x - shapeAnchorRef.current.x) || 340
    const h = Math.abs(pt.y - shapeAnchorRef.current.y) || 420
    shapeAnchorRef.current = null
    setShapePreview(null)
    const flowPos = overlayToFlow(x, y)
    addElement('claude', flowPos.x, flowPos.y, { boardId: board.id, width: w, height: h }, w, h)
    setTool('select')
  }

  // ── Text: click to drop a text box where you want, then type ──
  function onTextPointerDown(e: React.PointerEvent<SVGSVGElement>) {
    if (tool !== 'text') return
    const op = getOverlayPoint(e.clientX, e.clientY)
    const flowPos = overlayToFlow(op.x, op.y)
    addElement('text', flowPos.x, flowPos.y, { text: '', color: '#1f2937', fontSize: 12 }, 180, 140, { autoEdit: true })
    setTool('select') // drop the overlay so you can immediately type
  }

  function onShapePointerMove(e: React.PointerEvent<SVGSVGElement>) {
    if ((tool !== 'shape' && tool !== 'portal' && tool !== 'claude') || !shapeAnchorRef.current) return
    const pt = getOverlayPoint(e.clientX, e.clientY)
    setShapePreview({
      x: Math.min(shapeAnchorRef.current.x, pt.x),
      y: Math.min(shapeAnchorRef.current.y, pt.y),
      w: Math.abs(pt.x - shapeAnchorRef.current.x),
      h: Math.abs(pt.y - shapeAnchorRef.current.y),
    })
  }

  // Reset any in-progress shape/stroke when leaving the relevant tool
  useEffect(() => {
    if (tool !== 'shape' && tool !== 'portal' && tool !== 'claude') { shapeAnchorRef.current = null; setShapePreview(null) }
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

  useEffect(() => {
    if (!selContextMenu) return
    const close = () => setSelContextMenu(null)
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
  }, [selContextMenu])

  // Double-click-hold-drag on canvas background → marquee selection.
  // Strategy: pre-stage allowMarqueeSelection=true on the FIRST click's release so
  // React re-renders (updating panOnDrag + selectionOnDrag props) before the second
  // pointerdown arrives. d3-zoom then sees the updated filter and won't start a pan.
  useEffect(() => {
    const el = wrapperRef.current
    if (!el) return

    let firstDownTime = 0
    let readyForSecond = false
    let resetTimeoutId: ReturnType<typeof setTimeout> | null = null

    function reset() {
      readyForSecond = false
      firstDownTime = 0
      setAllowMarqueeSelection(false)
      if (resetTimeoutId) { clearTimeout(resetTimeoutId); resetTimeoutId = null }
    }

    function onPointerDown(e: PointerEvent) {
      if (e.button !== 0) return
      if (tool !== 'select') return
      const target = e.target as HTMLElement
      if (target.closest('.react-flow__node')) return

      if (readyForSecond) {
        // Second click — allowMarqueeSelection is already true, React has already
        // re-rendered with panOnDrag=[1] so d3-zoom rejects button 0 and the Pane
        // starts the selection rectangle instead.
        readyForSecond = false
        if (resetTimeoutId) { clearTimeout(resetTimeoutId); resetTimeoutId = null }
        const onUp = () => {
          reset()
          window.removeEventListener('pointerup', onUp)
        }
        window.addEventListener('pointerup', onUp)
        return
      }

      firstDownTime = Date.now()
    }

    function onPointerUp(e: PointerEvent) {
      if (e.button !== 0) return
      if (tool !== 'select') return
      if (firstDownTime === 0) return

      const held = Date.now() - firstDownTime
      firstDownTime = 0

      // Only treat as first click if released quickly (not a pan/hold)
      if (held <= 300) {
        readyForSecond = true
        setAllowMarqueeSelection(true) // pre-stage before second press
        if (resetTimeoutId) clearTimeout(resetTimeoutId)
        // Reset if no second click arrives within the double-click window
        resetTimeoutId = setTimeout(reset, 400)
      }
    }

    el.addEventListener('pointerdown', onPointerDown)
    el.addEventListener('pointerup', onPointerUp)
    return () => {
      el.removeEventListener('pointerdown', onPointerDown)
      el.removeEventListener('pointerup', onPointerUp)
      if (resetTimeoutId) clearTimeout(resetTimeoutId)
    }
  }, [tool])

  // Keyboard shortcuts — all ignored while typing in a text field
  // Ctrl+Z = undo, Ctrl+X = redo
  // V = select/cursor, H = hand, P = pen/draw, R = shape, F = portal
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const el = e.target as HTMLElement | null
      const typing = !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)
      if (typing) return
      const mod = e.ctrlKey || e.metaKey
      if (mod && (e.key === 'z' || e.key === 'Z')) { e.preventDefault(); undo(); return }
      if (mod && (e.key === 'x' || e.key === 'X')) { e.preventDefault(); redo(); return }
      if (!mod && !e.altKey) {
        if (e.key === 'v' || e.key === 'V') { e.preventDefault(); setTool('select') }
        else if (e.key === 'h' || e.key === 'H') { e.preventDefault(); setTool(prev => prev === 'hand' ? 'select' : 'hand') }
        else if (e.key === 'p' || e.key === 'P') { e.preventDefault(); setTool('draw') }
        else if (e.key === 'r' || e.key === 'R') { e.preventDefault(); setTool('shape') }
        else if (e.key === 'f' || e.key === 'F') { e.preventDefault(); setTool('portal') }
        else if (e.key === 'c' || e.key === 'C') { e.preventDefault(); setTool('claude') }
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
    if (n.type === 'textFileNode') return 'file'
    if (n.type === 'pdfNode') return 'file'
    if (n.type === 'folderLinkNode') return 'subtab'
    if (n.type === 'imageNode') return 'image'
    if (n.type === 'portalNode') return 'portal'
    return 'unknown'
  }
  const unitLabel = (n: Node, kind: Unit['kind']): string => {
    const d = n.data as Record<string, unknown>
    if (kind === 'list' || kind === 'subtab') return (d.name as string) || kind
    if (kind === 'card') return (d.title as string) || 'Card'
    if (kind === 'shape') return (d.label as string) || `${(d.shape as string) || 'Shape'}`
    if (kind === 'text') return (d.name as string) || ((d.text as string) || '').slice(0, 40) || 'Text'
    if (kind === 'file') return (d.name as string) || 'File'
    if (kind === 'image') return (d.name as string) || 'Image'
    if (kind === 'drawing') return (d.name as string) || 'Drawing'
    if (kind === 'portal') {
      if (d.viewerKind) return 'Stock Viewer'
      if (d.targetBoardName) return d.targetBoardName as string
      const matched = subBoards.find(b => b.id === (d.targetBoardId as string))
      if (matched) return matched.name
      return 'Portal'
    }
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
        mode: (n.data as Record<string, unknown>).mode as string | undefined,
        label: unitLabel(n, kind),
        opacity: typeof n.style?.opacity === 'number' ? (n.style.opacity as number) : 1,
        selected: !!n.selected,
        hidden: !!n.hidden,
      }
    })
    unitsStore.publish(list)
  }, [nodes]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => () => unitsStore.clear(), [])

  // Restore z-ordering from localStorage so layer order survives tab switches.
  useEffect(() => {
    try {
      const stored = localStorage.getItem(`zmap-${board.id}`)
      if (!stored) return
      const zmap = JSON.parse(stored) as Record<string, number>
      setNodes(prev => prev.map(n => zmap[n.id] != null ? { ...n, zIndex: zmap[n.id] } : n))
    } catch {}
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [board.id])

  // Restore child→parent grouping from localStorage so containment survives reloads.
  useEffect(() => {
    try {
      const stored = localStorage.getItem(`groupmap-${board.id}`)
      if (!stored) return
      const map = JSON.parse(stored) as Record<string, string>
      if (!map || typeof map !== 'object') return
      setNodes(prev => prev.map(n => map[n.id] ? { ...n, data: { ...n.data, parentId: map[n.id] } } : n))
    } catch {}
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [board.id])

  // Restore hidden state from localStorage so visibility survives tab switches and reloads.
  useEffect(() => {
    try {
      const stored = localStorage.getItem(`hiddenmap-${board.id}`)
      if (!stored) return
      const map = JSON.parse(stored) as Record<string, boolean>
      if (!map || typeof map !== 'object') return
      setNodes(prev => prev.map(n => map[n.id] != null ? { ...n, hidden: map[n.id], data: { ...n.data, hidden: map[n.id] } } : n))
    } catch {}
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [board.id])

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
        // Persist z to DB for element nodes; persist full map to localStorage for all node types.
        for (const n of nodesRef.current) {
          const z = zById.get(n.id)
          if (z != null && n.id.startsWith('el-')) saveElement(n.id, { ...n.data, z }, n.data.width as number | undefined, n.data.height as number | undefined)
        }
        try { localStorage.setItem(`zmap-${board.id}`, JSON.stringify(Object.fromEntries(zById))) } catch {}
      },
      setOpacity: (id, opacity) => {
        setNodes(prev => prev.map(n => n.id === id ? { ...n, style: { ...n.style, opacity } } : n))
        const n = nodesRef.current.find(x => x.id === id)
        if (n && id.startsWith('el-')) saveElement(id, { ...n.data, opacity }, n.data.width as number | undefined, n.data.height as number | undefined)
      },
      setHidden: (id: string, hidden: boolean) => hideUnit(id, hidden),
      delete: (ids: string[]) => {
        for (const id of ids) {
          const kind = nodeKind(id)
          if (kind) handleDeleteNode(id, kind)
        }
      },
      rename: (id: string, label: string) => {
        // Route rename to the right underlying node type
        if (id.startsWith('list-')) {
          const rawId = id.replace('list-', '')
          setLists(prev => prev.map(l => l.id === rawId ? { ...l, name: label } : l))
          setNodes(prev => prev.map(n => n.id === id ? { ...n, data: { ...n.data, name: label } } : n))
          updateBoard(rawId, { name: label }).catch(() => {})
        } else if (id.startsWith('card-')) {
          const rawId = id.replace('card-', '')
          setCards(prev => prev.map(c => c.id === rawId ? { ...c, title: label } : c))
          setNodes(prev => prev.map(n => n.id === id ? { ...n, data: { ...n.data, title: label } } : n))
          updateCard(rawId, { title: label }, board.id).catch(() => {})
        } else if (id.startsWith('sub-')) {
          renameSubTab(id.replace('sub-', ''), label)
        } else if (id.startsWith('el-')) {
          const n = nodesRef.current.find(x => x.id === id)
          if (!n) return
          const key = n.type === 'shapeNode' ? 'label' : 'name'
          const newData = { ...n.data, [key]: label }
          setNodes(prev => prev.map(x => x.id === id ? { ...x, data: newData } : x))
          saveElement(id, newData, n.data.width as number | undefined, n.data.height as number | undefined)
        }
      },
    })
    return () => unitsStore.setHandlers(null)
  }, [setNodes, saveElement]) // eslint-disable-line react-hooks/exhaustive-deps

  // ── Corner drag handles for board resizing ────────────────────────────────
  const onCornerPointerDown = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    e.stopPropagation()
    e.currentTarget.setPointerCapture(e.pointerId)
    const corner = e.currentTarget.dataset.corner as 'tl' | 'tr' | 'bl' | 'br'
    cornerDragRef.current = { corner }
  }, [])

  const onCornerPointerMove = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    const drag = cornerDragRef.current
    if (!drag) return
    const outer = wrapperRef.current?.parentElement
    if (!outer) return
    const rect = outer.getBoundingClientRect()
    const MIN = 8
    const MIN_SIZE = 80
    const x = e.clientX - rect.left
    const y = e.clientY - rect.top
    setBoardInset(prev => {
      const next = { ...prev }
      if (drag.corner === 'tl' || drag.corner === 'bl') {
        next.left = Math.max(MIN, Math.min(rect.width - prev.right - MIN_SIZE, x))
      }
      if (drag.corner === 'tr' || drag.corner === 'br') {
        next.right = Math.max(MIN, Math.min(rect.width - prev.left - MIN_SIZE, rect.width - x))
      }
      if (drag.corner === 'tl' || drag.corner === 'tr') {
        next.top = Math.max(MIN, Math.min(rect.height - prev.bottom - MIN_SIZE, y))
      }
      if (drag.corner === 'bl' || drag.corner === 'br') {
        next.bottom = Math.max(MIN, Math.min(rect.height - prev.top - MIN_SIZE, rect.height - y))
      }
      return next
    })
  }, [])

  const onCornerPointerUp = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    cornerDragRef.current = null
    try { e.currentTarget.releasePointerCapture(e.pointerId) } catch {}
  }, [])

  // Title bar drag — translate the entire board window
  const titleBarDragRef = useRef<{ startX: number; startY: number; startInset: { top: number; right: number; bottom: number; left: number } } | null>(null)

  const onTitleBarPointerDown = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    e.stopPropagation()
    e.currentTarget.setPointerCapture(e.pointerId)
    titleBarDragRef.current = { startX: e.clientX, startY: e.clientY, startInset: { ...boardInsetRef.current } }
  }, [])

  const onTitleBarPointerMove = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    const drag = titleBarDragRef.current
    if (!drag) return
    const dx = e.clientX - drag.startX
    const dy = e.clientY - drag.startY
    setBoardInset({
      top: Math.max(0, drag.startInset.top + dy),
      bottom: Math.max(0, drag.startInset.bottom - dy),
      left: Math.max(0, drag.startInset.left + dx),
      right: Math.max(0, drag.startInset.right - dx),
    })
  }, [])

  const onTitleBarPointerUp = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    titleBarDragRef.current = null
    try { e.currentTarget.releasePointerCapture(e.pointerId) } catch {}
  }, [])

  // Overlay (draw/shape/text/portal) intercepts pointer input; hand & select do not
  const overlayActive = tool === 'draw' || tool === 'shape' || tool === 'text' || tool === 'portal' || tool === 'claude'

  // ── Navigation that works regardless of the active tool ──
  function onOverlayWheel(e: React.WheelEvent<SVGSVGElement>) {
    if (heldNodeRef.current) return
    e.preventDefault()
    const canvasFactor = e.deltaY > 0 ? 0.9 : 1.1
    const vp = getViewport()
    const newZoom = Math.max(0.05, Math.min(4, vp.zoom * canvasFactor))
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
    else if (tool === 'claude') onClaudePointerDown(e)
    else if (tool === 'text') onTextPointerDown(e)
  }

  function onOverlayPointerMove(e: React.PointerEvent<SVGSVGElement>) {
    if (panRef.current) {
      const { sx, sy, vx, vy } = panRef.current
      setViewport({ zoom: getViewport().zoom, x: vx + (e.clientX - sx), y: vy + (e.clientY - sy) })
      return
    }
    if (tool === 'draw') onDrawPointerMove(e)
    else if (tool === 'shape' || tool === 'portal' || tool === 'claude') onShapePointerMove(e)
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
      className="absolute overflow-hidden"
      style={{
        top: isFullscreen ? 0 : boardInset.top,
        right: isFullscreen ? 0 : boardInset.right,
        bottom: isFullscreen ? 0 : boardInset.bottom,
        left: isFullscreen ? 0 : boardInset.left,
        boxShadow: '0 8px 40px rgba(0,0,0,0.55), 0 2px 8px rgba(0,0,0,0.3)',
        backgroundColor: board.color,
      }}
      onMouseUp={handleWrapperMouseUp}
      onDragEnter={onCanvasDragEnter}
      onDragOver={onCanvasDragOver}
      onDragLeave={e => {
        dragCountRef.current = Math.max(0, dragCountRef.current - 1)
        if (dragCountRef.current === 0) { setFileDragOver(false); setDropTarget(null) }
      }}
      onDrop={onCanvasDrop}
    >
      <ReactFlow
        nodes={nodes}
        edges={edges}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onConnect={onConnect}
        onConnectStart={() => {
          isConnectingRef.current = true
          wrapperRef.current?.classList.add('rf-connecting')
          // Clear inline opacity so the CSS .rf-connecting rule takes full control
          wrapperRef.current?.querySelectorAll<HTMLElement>('.react-flow__handle')
            .forEach(h => { h.style.opacity = '' })
        }}
        onConnectEnd={() => {
          isConnectingRef.current = false
          wrapperRef.current?.classList.remove('rf-connecting')
        }}
        onEdgesDelete={onEdgesDelete}
        onNodesDelete={onNodesDelete}
        onNodeDragStart={onNodeDragStart}
        onNodeDrag={onNodeDrag}
        onNodeDragStop={onNodeDragStop}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        connectionMode={ConnectionMode.Loose}
        elevateNodesOnSelect={false}
        fitView
        minZoom={0.05}
        maxZoom={4}
        deleteKeyCode="Delete"
        nodesDraggable={tool === 'select' && !isLocked}
        nodesConnectable={!isLocked}
        elementsSelectable={!isLocked}
        selectionOnDrag={allowMarqueeSelection && tool === 'select' && !isLocked}
        panOnDrag={
          tool === 'hand' ? [0, 1, 2] :
          tool === 'select' && allowMarqueeSelection ? [1] :
          tool === 'select' ? [0, 1] :
          false
        }
        zoomOnDoubleClick={false}
        zoomOnScroll={true}
        zoomOnPinch={true}
        onPaneClick={e => {
          // Close context menu on any background left-click; no longer opens it
          if (contextMenu) setContextMenu(null)
        }}
        onPaneContextMenu={e => {
          if (tool !== 'select') return
          e.preventDefault()
          const ids = getEffectiveSel()
          if (ids.length > 0) {
            setSelContextMenu({ x: e.clientX, y: e.clientY, count: ids.length })
            return
          }
          const flowPos = screenToFlowPosition({ x: e.clientX, y: e.clientY })
          setContextMenu({ x: e.clientX, y: e.clientY, flowX: flowPos.x, flowY: flowPos.y })
        }}
        onNodeContextMenu={e => {
          if (tool !== 'select') return
          e.preventDefault()
          const ids = getEffectiveSel()
          if (ids.length > 0) {
            setSelContextMenu({ x: e.clientX, y: e.clientY, count: ids.length })
          }
        }}
        proOptions={{ hideAttribution: true }}
      >
        <Background variant={BackgroundVariant.Dots} color="rgba(255,255,255,0.2)" gap={24} size={1.5} />
      </ReactFlow>

      {fileDragOver && (() => {
        const vp = getViewport()
        const claudeRects = nodesRef.current
          .filter(n => n.type === 'claudeNode')
          .map(n => ({
            x: n.position.x * vp.zoom + vp.x,
            y: n.position.y * vp.zoom + vp.y,
            w: (n.measured?.width ?? 340) * vp.zoom,
            h: (n.measured?.height ?? 420) * vp.zoom,
          }))
        const holePath = claudeRects.map(r => `M${r.x},${r.y} H${r.x + r.w} V${r.y + r.h} H${r.x} Z`).join(' ')
        return (
          <>
            <svg className="absolute inset-0 pointer-events-none" style={{ zIndex: 20, width: '100%', height: '100%' }}>
              <path
                d={`M-1,-1 H10001 V10001 H-1 Z ${holePath}`}
                fillRule="evenodd"
                fill="rgba(99,102,241,0.1)"
              />
              {claudeRects.map((r, i) => (
                <rect key={i} x={r.x} y={r.y} width={r.w} height={r.h} fill="rgba(0,0,0,0.13)" rx={8} />
              ))}
            </svg>
            <div className="absolute inset-0 z-20 flex items-center justify-center border-4 border-dashed border-indigo-400 pointer-events-none">
              <p className="bg-white/90 text-indigo-600 text-sm font-medium px-4 py-2 rounded-lg shadow">Drop files or folders to add them to the canvas</p>
            </div>
          </>
        )
      })()}

      {/* Magnetic drop-target highlight — a pulsing ring drawn over the active target node */}
      {dropTarget && (() => {
        const n = nodesRef.current.find(x => x.id === dropTarget.nodeId)
        if (!n) return null
        const vp = getViewport()
        const w = (n.measured?.width ?? (dropTarget.type === 'claude' ? 340 : 150)) * vp.zoom
        const h = (n.measured?.height ?? (dropTarget.type === 'claude' ? 420 : 60)) * vp.zoom
        const sx = n.position.x * vp.zoom + vp.x
        const sy = n.position.y * vp.zoom + vp.y
        const ringColor = dropTarget.type === 'claude' ? '#D97757' : '#6366f1'
        const label = dropTarget.type === 'claude' ? 'Drop into Claude chat' : 'Drop into sub-tab'
        return (
          <div
            className="absolute pointer-events-none rounded-xl transition-all duration-150 flex items-end justify-center pb-1"
            style={{ left: sx - 4, top: sy - 4, width: w + 8, height: h + 8, zIndex: 18,
              outline: `2.5px solid ${ringColor}`,
              boxShadow: `0 0 0 4px ${ringColor}33, 0 0 16px ${ringColor}55`,
            }}
          >
            <span className="text-[11px] font-semibold px-2 py-0.5 rounded-full mb-1"
              style={{ background: ringColor, color: '#fff', opacity: 0.92 }}>
              {label}
            </span>
          </div>
        )
      })()}

      {/* Alignment guides — pink lines spanning the board while dragging */}
      {(helperLines.v != null || helperLines.h != null) && (() => {
        const vp = getViewport()
        return (
          <div className="absolute inset-0 pointer-events-none" style={{ zIndex: 15 }}>
            {helperLines.v != null && (
              <div style={{ position: 'absolute', top: 0, bottom: 0, left: helperLines.v * vp.zoom + vp.x, width: 1, background: '#ec4899' }} />
            )}
            {helperLines.h != null && (
              <div style={{ position: 'absolute', left: 0, right: 0, top: helperLines.h * vp.zoom + vp.y, height: 1, background: '#ec4899' }} />
            )}
          </div>
        )
      })()}

      {/* Grouping target — green ring around the shape the dragged node would drop into */}
      {groupHoverId && (() => {
        const n = nodesRef.current.find(x => x.id === groupHoverId)
        if (!n) return null
        const vp = getViewport()
        const [w, h] = getNodeWH(n)
        const sx = n.position.x * vp.zoom + vp.x
        const sy = n.position.y * vp.zoom + vp.y
        return (
          <div
            className="absolute pointer-events-none rounded-lg"
            style={{ left: sx - 3, top: sy - 3, width: w * vp.zoom + 6, height: h * vp.zoom + 6, zIndex: 16, outline: '2px dashed #22c55e', boxShadow: '0 0 0 3px rgba(34,197,94,0.18)' }}
          />
        )
      })()}

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
            (tool === 'portal' || tool === 'claude') ? (
              <rect
                x={shapePreview.x} y={shapePreview.y} width={shapePreview.w} height={shapePreview.h} rx={8}
                fill={tool === 'claude' ? '#D97757' : '#d946ef'} fillOpacity={0.15}
                stroke={tool === 'claude' ? '#D97757' : '#d946ef'} strokeWidth={2} strokeDasharray="6 4"
              />
            ) : selectedShape === 'circle' ? (
              <ellipse
                cx={shapePreview.x + shapePreview.w / 2} cy={shapePreview.y + shapePreview.h / 2}
                rx={shapePreview.w / 2} ry={shapePreview.h / 2}
                fill={shapeColorPicker} fillOpacity={0.5} stroke={shapeColorPicker} strokeWidth={2} strokeDasharray="4 3"
              />
            ) : selectedShape === 'arrow' ? (
              <path
                d={`M ${shapePreview.x} ${shapePreview.y + shapePreview.h * 0.32} L ${shapePreview.x + shapePreview.w * 0.62} ${shapePreview.y + shapePreview.h * 0.32} L ${shapePreview.x + shapePreview.w * 0.62} ${shapePreview.y + shapePreview.h * 0.08} L ${shapePreview.x + shapePreview.w} ${shapePreview.y + shapePreview.h * 0.5} L ${shapePreview.x + shapePreview.w * 0.62} ${shapePreview.y + shapePreview.h * 0.92} L ${shapePreview.x + shapePreview.w * 0.62} ${shapePreview.y + shapePreview.h * 0.68} L ${shapePreview.x} ${shapePreview.y + shapePreview.h * 0.68} Z`}
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
      <div className="absolute top-3 right-3 z-20 bg-white rounded-lg shadow-md p-1 flex flex-col gap-0.5 items-center">
        <div className="flex flex-col gap-0.5">
          {(['select', 'hand', 'draw', 'shape', 'text', 'portal', 'claude'] as Tool[]).map(t => {
            const Icon = TOOL_ICONS[t]
            return (
              <button
                key={t}
                onClick={() => setTool(t)}
                title={
                  t === 'select' ? 'Select (V)' :
                  t === 'hand'   ? 'Hand — pan (H)' :
                  t === 'draw'   ? 'Pen — draw (P)' :
                  t === 'shape'  ? 'Shape (R)' :
                  t === 'portal' ? 'Portal — frame (F)' :
                  t === 'claude' ? 'Claude — chat on canvas (C)' :
                  t.charAt(0).toUpperCase() + t.slice(1)
                }
                className={`w-7 h-7 flex items-center justify-center rounded transition-colors ${
                  tool === t
                    ? (t === 'claude' ? 'bg-[#D97757] text-white' : 'bg-blue-500 text-white')
                    : 'text-gray-500 hover:bg-gray-100'
                }`}
              >
                {t === 'claude' ? <ClaudeMark size={14} color={tool === t ? '#ffffff' : '#D97757'} animate={tool === t} /> : <Icon size={14} />}
              </button>
            )
          })}
        </div>
        {tool === 'text' && (
          <p className="text-[7px] text-gray-400 text-center leading-tight mt-0.5 pt-1 border-t border-gray-100 w-full">place text</p>
        )}
        {tool === 'select' && selectedColorable.length > 0 && (
          <div className="flex flex-col items-center gap-1 mt-0.5 pt-1 border-t border-gray-100 w-full">
            <p className="text-[7px] text-gray-400 text-center leading-tight">recolor</p>
            {SHAPE_COLORS.map(c => (
              <button key={c} onClick={() => recolorSelected(c)} className="w-4 h-4 rounded border-2 border-transparent hover:border-gray-800" style={{ backgroundColor: c }} />
            ))}
          </div>
        )}
        {tool === 'draw' && (
          <div className="flex flex-col items-center gap-1 mt-0.5 pt-1 border-t border-gray-100 w-full">
            {SHAPE_COLORS.map(c => (
              <button key={c} onClick={() => setDrawColor(c)} className={`w-4 h-4 rounded-full border-2 ${drawColor === c ? 'border-gray-800' : 'border-transparent'}`} style={{ backgroundColor: c }} />
            ))}
          </div>
        )}
        {tool === 'shape' && (
          <div className="flex flex-col gap-1 mt-0.5 pt-1 border-t border-gray-100 w-full items-center">
            {(['rect', 'circle', 'arrow'] as ShapeType[]).map(s => (
              <button key={s} onClick={() => setSelectedShape(s)} className={`text-[8px] px-1 py-0.5 rounded border w-full text-center ${selectedShape === s ? 'bg-blue-100 border-blue-400' : 'border-gray-200 text-gray-600'}`}>{s}</button>
            ))}
            <div className="flex flex-col items-center gap-1 mt-0.5">
              {SHAPE_COLORS.map(c => (
                <button key={c} onClick={() => setShapeColorPicker(c)} className={`w-4 h-4 rounded border-2 ${shapeColorPicker === c ? 'border-gray-800' : 'border-transparent'}`} style={{ backgroundColor: c }} />
              ))}
            </div>
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

      {selContextMenu && (
        <div
          className="fixed bg-white rounded-xl shadow-xl border border-gray-200 py-1.5 z-50 w-48"
          style={{ top: selContextMenu.y, left: selContextMenu.x }}
          onMouseLeave={() => setSelContextMenu(null)}
        >
          <div className="px-4 py-1 text-[10px] text-gray-400 font-medium border-b border-gray-100 mb-1">
            {selContextMenu.count} selected
          </div>
          <button
            onClick={() => handleSelAction('hide')}
            className="w-full text-left px-4 py-2 text-sm text-gray-700 hover:bg-gray-100 transition-colors flex items-center gap-2"
          >
            <EyeOff size={13} /> Hide
          </button>
          <button
            onClick={() => handleSelAction('show')}
            className="w-full text-left px-4 py-2 text-sm text-gray-700 hover:bg-gray-100 transition-colors flex items-center gap-2"
          >
            <Eye size={13} /> Show
          </button>
          <div className="border-t border-gray-100 my-1" />
          <button
            onClick={() => handleSelAction('delete')}
            className="w-full text-left px-4 py-2 text-sm text-red-500 hover:bg-red-50 transition-colors flex items-center gap-2"
          >
            <Trash2 size={13} /> Delete
          </button>
        </div>
      )}

      {/* Sub-tab mode picker — shown before creating so the user can choose the type */}
      {subtabPickPos && (
        <SubtabModePicker
          onPick={async (mode) => {
            const { x, y } = subtabPickPos
            setSubtabPickPos(null)
            const count = subBoards.length
            const sub = await createSubTab(board.id, `Tab ${count + 1}`, board.color, mode)
            await updateBoardFreePosition(sub.id, x, y)
            const newSub = { ...sub, free_x: x, free_y: y }
            setSubBoards(prev => [...prev, newSub as Board])
            setNodes(prev => [...prev, {
              id: `sub-${sub.id}`, type: 'subTabNode', position: { x, y },
              data: { boardId: sub.id, name: sub.name, color: sub.color, mode: sub.mode, onNavigate: navigate, onDelete: (id: string) => handleDeleteNode(id, 'subtab'), onRename: renameSubTab, onOpenPanel: openSubPanel, onHold: holdNode },
            }])
          }}
          onClose={() => setSubtabPickPos(null)}
        />
      )}

      {expiryPanel && (() => {
        const el = elements.find(e => `el-${e.id}` === expiryPanel)
        const currentDeadline = el?.deadline ? el.deadline.slice(0, 10) : ''
        return (
          <ExpiryPanel
            key={expiryPanel}
            initialValue={currentDeadline}
            onSave={async (iso) => {
              if (el) {
                await updateElement(el.id, { deadline: iso })
                setElements(prev => prev.map(e => e.id === el.id ? { ...e, deadline: iso } : e))
                setNodes(prev => prev.map(n => n.id === expiryPanel ? { ...n, data: { ...n.data, deadline: iso } } : n))
              }
              setExpiryPanel(null)
            }}
            onClose={() => setExpiryPanel(null)}
          />
        )
      })()}

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

      {/* Title bar — transparent drag handle; bg confined to name chip */}
      <div
        className="absolute left-0 right-0 flex items-center px-2 select-none"
        style={{
          top: 0,
          height: 26,
          zIndex: 180,
          cursor: isFullscreen ? 'default' : 'move',
          pointerEvents: isFullscreen ? 'none' : 'auto',
        }}
        onPointerDown={onTitleBarPointerDown}
        onPointerMove={onTitleBarPointerMove}
        onPointerUp={onTitleBarPointerUp}
      >
        <span
          className="flex items-center gap-1.5 px-2 py-0.5 rounded"
          style={{ background: 'rgba(0,0,0,0.28)', backdropFilter: 'blur(6px)' }}
        >
          <span className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: board.color }} />
          <span className="text-white/75 text-[11px] font-medium tracking-wide max-w-[220px] truncate">{board.name}</span>
          {onClose && (
            <button
              onPointerDown={e => e.stopPropagation()}
              onClick={onClose}
              className="text-white/40 hover:text-white/90 transition-colors shrink-0 leading-none ml-0.5"
              style={{ fontSize: 14, lineHeight: 1 }}
              title="Close window"
            >×</button>
          )}
        </span>
      </div>

      {/* Corner drag handles — appear on hover, drag to resize the board */}
      {(['tl', 'tr', 'bl', 'br'] as const).map(corner => (
        <div
          key={corner}
          data-corner={corner}
          onPointerDown={onCornerPointerDown}
          onPointerMove={onCornerPointerMove}
          onPointerUp={onCornerPointerUp}
          className="absolute w-10 h-10 group"
          style={{
            zIndex: 200,
            cursor: corner === 'tl' || corner === 'br' ? 'nwse-resize' : 'nesw-resize',
            ...(corner === 'tl' ? { top: 0, left: 0 } :
                corner === 'tr' ? { top: 0, right: 0 } :
                corner === 'bl' ? { bottom: 0, left: 0 } :
                                  { bottom: 0, right: 0 }),
          }}
        >
          <div
            className="absolute w-2.5 h-2.5 rounded-full bg-white shadow-md opacity-0 group-hover:opacity-90 transition-opacity duration-150"
            style={{
              pointerEvents: 'none',
              ...(corner === 'tl' ? { top: 5, left: 5 } :
                  corner === 'tr' ? { top: 5, right: 5 } :
                  corner === 'bl' ? { bottom: 5, left: 5 } :
                                    { bottom: 5, right: 5 }),
            }}
          />
        </div>
      ))}
      {/* Controls panel — hidden until hovered */}
      <div className="group absolute bottom-3 left-3 z-[50] select-none">
        <div className="opacity-0 group-hover:opacity-100 transition-opacity duration-150 bg-white rounded-lg shadow-md p-1 flex flex-col gap-0.5 items-center">
          <button
            onClick={() => zoomIn()}
            title="Zoom in"
            className="w-7 h-7 flex items-center justify-center rounded text-gray-500 hover:bg-gray-100 transition-colors"
          ><Plus size={13} /></button>
          <button
            onClick={() => zoomOut()}
            title="Zoom out"
            className="w-7 h-7 flex items-center justify-center rounded text-gray-500 hover:bg-gray-100 transition-colors"
          ><Minus size={13} /></button>
          <button
            onClick={() => fitView()}
            title="Fit view"
            className="w-7 h-7 flex items-center justify-center rounded text-gray-500 hover:bg-gray-100 transition-colors"
          ><Maximize size={13} /></button>
          <button
            onClick={() => setIsLocked(p => !p)}
            title={isLocked ? 'Unlock board' : 'Lock board'}
            className={`w-7 h-7 flex items-center justify-center rounded transition-colors ${isLocked ? 'bg-amber-50 text-amber-500' : 'text-gray-500 hover:bg-gray-100'}`}
          ><Lock size={13} /></button>
          <button
            onClick={() => setIsFullscreen(p => !p)}
            title={isFullscreen ? 'Exit fullscreen' : 'Fullscreen'}
            className={`w-7 h-7 flex items-center justify-center rounded transition-colors ${isFullscreen ? 'bg-blue-50 text-blue-500' : 'text-gray-500 hover:bg-gray-100'}`}
          ><Maximize2 size={13} /></button>
        </div>
        {/* Invisible hover target so there's always something to hover */}
        <div className="absolute inset-0 -m-2" />
      </div>
    </div>
  )
}

// ── Expiry panel (floating, centered) ────────────────────────────────────────

function ExpiryPanel({ initialValue, onSave, onClose }: {
  initialValue: string
  onSave: (iso: string | null) => Promise<void>
  onClose: () => void
}) {
  const [value, setValue] = useState(initialValue)
  const [saving, setSaving] = useState(false)

  async function handleSave() {
    setSaving(true)
    await onSave(value ? new Date(value).toISOString() : null)
    setSaving(false)
  }

  return (
    <div className="fixed inset-0 flex items-center justify-center z-[9999] bg-black/20" onClick={onClose}>
      <div className="bg-white rounded-xl shadow-2xl border border-gray-200 p-4 w-64" onClick={e => e.stopPropagation()}>
        <p className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-3 flex items-center gap-1.5">
          <Clock size={12} /> Set expiry
        </p>
        <p className="text-[10px] text-gray-400 mb-2">This unit will be automatically deleted when the date passes.</p>
        <input
          type="date"
          autoFocus
          value={value}
          onChange={e => setValue(e.target.value)}
          className="w-full border border-gray-300 rounded px-2 py-1.5 text-sm mb-3 focus:outline-none focus:border-blue-500"
        />
        <div className="flex gap-2">
          <button
            onClick={handleSave}
            disabled={saving}
            className="flex-1 bg-[#0079bf] hover:bg-[#026aa7] text-white text-sm py-1.5 rounded disabled:opacity-60"
          >
            {saving ? 'Saving…' : 'Set'}
          </button>
          {initialValue && (
            <button
              onClick={async () => { setSaving(true); await onSave(null); setSaving(false) }}
              disabled={saving}
              className="text-xs text-gray-500 border border-gray-200 px-2 py-1.5 rounded hover:bg-gray-50 disabled:opacity-60"
            >
              Clear
            </button>
          )}
          <button onClick={onClose} className="text-xs text-gray-400 hover:text-gray-600 px-2">Cancel</button>
        </div>
      </div>
    </div>
  )
}



// ── Sub-tab mode picker ───────────────────────────────────────────────────────

const SUBTAB_MODES = [
  { mode: 'classic' as const,     emoji: '🎨', label: 'Canvas',      desc: 'Free-form boards & nodes' },
  { mode: 'trello' as const,      emoji: '🗂',  label: 'Kanban',      desc: 'Lists & cards' },
  { mode: 'text' as const,        emoji: '📝', label: 'Document',    desc: 'Rich text editor' },
  { mode: 'folder' as const,      emoji: '📁', label: 'Folder',      desc: 'Files & sub-folders' },
]

function SubtabModePicker({ onPick, onClose }: {
  onPick: (mode: 'classic' | 'trello' | 'text' | 'folder') => void
  onClose: () => void
}) {
  return (
    <div className="fixed inset-0 flex items-center justify-center z-[9999] bg-black/30" onClick={onClose}>
      <div className="bg-white rounded-2xl shadow-2xl border border-gray-200 p-5 w-80" onClick={e => e.stopPropagation()}>
        <p className="text-sm font-semibold text-gray-700 mb-4">Choose sub-tab type</p>
        <div className="grid grid-cols-1 gap-2">
          {SUBTAB_MODES.map(({ mode, emoji, label, desc }) => (
            <button
              key={mode}
              onClick={() => onPick(mode)}
              className="flex items-center gap-3 px-3 py-2.5 rounded-xl border border-gray-200 hover:border-blue-400 hover:bg-blue-50 text-left transition-colors group"
            >
              <span className="text-2xl">{emoji}</span>
              <div>
                <p className="text-sm font-medium text-gray-800 group-hover:text-blue-700">{label}</p>
                <p className="text-[11px] text-gray-400">{desc}</p>
              </div>
            </button>
          ))}
        </div>
        <button onClick={onClose} className="mt-3 w-full text-xs text-gray-400 hover:text-gray-600 py-1.5 rounded-lg hover:bg-gray-50">Cancel</button>
      </div>
    </div>
  )
}

// ── FloatingWindow: a loaded board ready to render as an extra window ─────────

type FloatingWindow = {
  instanceId: string
  board: Board
  initialLists: List[]
  initialCards: Card[]
  initialEdges: BoardEdge[]
  initialElements: BoardElement[]
  initialSubBoards: Board[]
  initialInset: { top: number; right: number; bottom: number; left: number }
}

// ── FreeBoardDesktop: shared background + multiple board windows ──────────────

function FreeBoardDesktop(props: Props) {
  const outerRef = useRef<HTMLDivElement>(null)
  const [extraWindows, setExtraWindows] = useState<FloatingWindow[]>([])
  const [dropHint, setDropHint] = useState(false)

  function closeWindow(instanceId: string) {
    setExtraWindows(prev => prev.filter(w => w.instanceId !== instanceId))
  }

  async function handleDrop(e: React.DragEvent<HTMLDivElement>) {
    e.preventDefault()
    setDropHint(false)
    const boardId = e.dataTransfer.getData(FLOAT_BOARD_MIME)
    if (!boardId) return
    if (boardId === props.board.id) return
    if (extraWindows.find(w => w.board.id === boardId)) return

    const outer = outerRef.current
    if (!outer) return
    const rect = outer.getBoundingClientRect()
    // Default window size: ~45% wide, ~65% tall, centred on drop point
    const winW = rect.width * 0.45
    const winH = rect.height * 0.65
    const cx = e.clientX - rect.left
    const cy = e.clientY - rect.top
    const startInset = {
      top: Math.max(4, cy - winH / 2),
      bottom: Math.max(4, rect.height - cy - winH / 2),
      left: Math.max(4, cx - winW / 2),
      right: Math.max(4, rect.width - cx - winW / 2),
    }

    const data = await loadBoardForFloat(boardId)
    if (!data) return
    setExtraWindows(prev => [...prev, {
      instanceId: crypto.randomUUID(),
      board: data.board as Board,
      initialLists: data.lists as List[],
      initialCards: data.cards as Card[],
      initialEdges: data.edges as BoardEdge[],
      initialElements: data.elements as BoardElement[],
      initialSubBoards: data.subBoards as Board[],
      initialInset: startInset,
    }])
  }

  return (
    <div
      ref={outerRef}
      className="relative flex-1 h-full overflow-hidden"
      style={{
        backgroundImage: "url('/henning-witzel-ukvgqriuOgo-unsplash.jpg')",
        backgroundSize: 'cover',
        backgroundPosition: 'center',
        backgroundColor: '#0d1117',
      }}
      onDragOver={e => {
        if (e.dataTransfer.types.includes(FLOAT_BOARD_MIME)) {
          e.preventDefault()
          setDropHint(true)
        }
      }}
      onDragLeave={e => { if (!outerRef.current?.contains(e.relatedTarget as unknown as globalThis.Node)) setDropHint(false) }}
      onDrop={handleDrop}
    >
      {dropHint && (
        <div className="pointer-events-none absolute inset-0 z-[999] border-2 border-dashed border-white/30 rounded-none flex items-center justify-center">
          <span className="text-white/50 text-sm font-medium bg-black/30 px-4 py-2 rounded-xl backdrop-blur-sm">Drop to open as window</span>
        </div>
      )}

      {/* Primary board window */}
      <ReactFlowProvider>
        <FlowCanvas {...props} />
      </ReactFlowProvider>

      {/* Extra floating windows dragged in from the tab bar */}
      {extraWindows.map(w => (
        <ReactFlowProvider key={w.instanceId}>
          <FlowCanvas
            board={w.board}
            initialLists={w.initialLists}
            initialCards={w.initialCards}
            initialEdges={w.initialEdges}
            initialElements={w.initialElements}
            initialSubBoards={w.initialSubBoards}
            initialInset={w.initialInset}
            onClose={() => closeWindow(w.instanceId)}
          />
        </ReactFlowProvider>
      ))}
    </div>
  )
}

export default function FreeBoardView(props: Props) {
  return <FreeBoardDesktop {...props} />
}
