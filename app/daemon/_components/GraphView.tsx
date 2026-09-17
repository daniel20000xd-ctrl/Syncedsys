'use client'

import { useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import { Background, Controls, MarkerType, ReactFlow, type Edge, type Node } from '@xyflow/react'
import '@xyflow/react/dist/style.css'

type GNode = { id: string; kind: 'active' | 'archive'; title: string; detail: string }
type GEdge = { id: string; from_id: string; to_id: string; why: string }

// Deterministic layout: linked nodes on an inner ring per kind, unlinked ones in a grid
// below. Good enough to read connections; no layout dependency.
function layout(nodes: GNode[], edges: GEdge[]) {
  const linked = new Set(edges.flatMap(e => [e.from_id, e.to_id]))
  const positions = new Map<string, { x: number; y: number }>()
  const ring = (items: GNode[], radius: number, cx: number, cy: number) =>
    items.forEach((n, i) => {
      const a = (i / Math.max(items.length, 1)) * Math.PI * 2
      positions.set(n.id, { x: cx + radius * Math.cos(a), y: cy + radius * Math.sin(a) })
    })
  const linkedActive = nodes.filter(n => linked.has(n.id) && n.kind === 'active')
  const linkedArchive = nodes.filter(n => linked.has(n.id) && n.kind === 'archive')
  ring(linkedActive, Math.max(160, linkedActive.length * 32), 0, 0)
  ring(linkedArchive, Math.max(360, linkedActive.length * 32 + 200, linkedArchive.length * 26), 0, 0)
  const loose = nodes.filter(n => !linked.has(n.id))
  const top = (positions.size ? Math.max(...[...positions.values()].map(p => p.y)) : 0) + 220
  loose.forEach((n, i) => positions.set(n.id, { x: -900 + (i % 10) * 190, y: top + Math.floor(i / 10) * 70 }))
  return positions
}

export function GraphView({ nodes, edges }: { nodes: GNode[]; edges: GEdge[] }) {
  const router = useRouter()
  const [hovered, setHovered] = useState<GEdge | null>(null)

  const { rfNodes, rfEdges } = useMemo(() => {
    const pos = layout(nodes, edges)
    const rfNodes: Node[] = nodes.map(n => ({
      id: n.id,
      position: pos.get(n.id) ?? { x: 0, y: 0 },
      data: { label: n.title },
      style: n.kind === 'active'
        ? { background: '#052e2b', color: '#a7f3d0', border: '1px solid #047857', borderRadius: 6, fontSize: 11, width: 170, padding: 6 }
        : { background: '#18181b', color: '#a1a1aa', border: '1px dashed #52525b', borderRadius: 6, fontSize: 11, width: 170, padding: 6 },
    }))
    const rfEdges: Edge[] = edges.map(e => ({
      id: e.id,
      source: e.from_id,
      target: e.to_id,
      style: { stroke: '#71717a', strokeWidth: 1.2 },
      markerEnd: { type: MarkerType.ArrowClosed, color: '#71717a' },
      interactionWidth: 14,
    }))
    return { rfNodes, rfEdges }
  }, [nodes, edges])

  const byId = useMemo(() => new Map(nodes.map(n => [n.id, n])), [nodes])

  return (
    <div className="relative h-[75vh] border border-zinc-800 rounded bg-zinc-950">
      <ReactFlow
        nodes={rfNodes}
        edges={rfEdges}
        colorMode="dark"
        fitView
        minZoom={0.05}
        nodesConnectable={false}
        nodesDraggable
        elementsSelectable
        onNodeClick={(_, n) => router.push(`/daemon/memory?item=${n.id}`)}
        onEdgeMouseEnter={(_, e) => setHovered(edges.find(x => x.id === e.id) ?? null)}
        onEdgeMouseLeave={() => setHovered(null)}
        proOptions={{ hideAttribution: true }}
      >
        <Background color="#27272a" gap={24} />
        <Controls showInteractive={false} />
      </ReactFlow>
      {hovered && (
        <div className="absolute top-2 left-2 right-2 md:right-auto md:max-w-lg z-10 rounded border border-zinc-700 bg-zinc-900/95 p-2 text-[12px] pointer-events-none">
          <div className="text-zinc-400">
            <span className="text-zinc-200">{byId.get(hovered.from_id)?.title}</span> ↔ <span className="text-zinc-200">{byId.get(hovered.to_id)?.title}</span>
          </div>
          <div className="text-zinc-300 mt-0.5">why: {hovered.why || '(no reason given)'}</div>
        </div>
      )}
    </div>
  )
}
