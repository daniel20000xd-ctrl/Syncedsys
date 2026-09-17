import Link from 'next/link'
import { getGraph } from '@/app/daemonActions'
import { GraphView } from '../_components/GraphView'
import { ErrorPanel, PageTitle } from '../_components/ui'

const STEP = 150

export default async function GraphPage({ searchParams }: { searchParams: Promise<{ limit?: string }> }) {
  const { limit } = await searchParams
  const requested = Number.parseInt(limit ?? '', 10) || STEP
  let data: Awaited<ReturnType<typeof getGraph>>
  try {
    data = await getGraph(requested)
  } catch (e) {
    return <ErrorPanel error={e} />
  }
  const more = data.total > data.nodes.length

  return (
    <div>
      <PageTitle sub="Nodes: active (solid green) and archived (dashed). Edges: daemon_links — hover for the model's reason, click a node for its detail. Read-only.">
        Link graph
      </PageTitle>
      <div className="flex items-center gap-3 text-xs text-zinc-500 mb-2">
        <span>showing {data.nodes.length} of {data.total} items (most recent first) · {data.edges.length} links between them</span>
        {more && <Link href={`/daemon/graph?limit=${data.limit + STEP}`} className="text-sky-500">load {STEP} more</Link>}
      </div>
      <GraphView nodes={data.nodes} edges={data.edges} />
    </div>
  )
}
