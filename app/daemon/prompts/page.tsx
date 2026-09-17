import Link from 'next/link'
import { getPromptVersions, type PromptTab } from '@/app/daemonActions'
import { debugAllowed } from '@/lib/daemon/dryrun'
import { PromptEditor } from '../_components/PromptEditor'
import { ErrorPanel, fmtTime, PageTitle } from '../_components/ui'

const TABS: { id: PromptTab; label: string; blurb: string }[] = [
  { id: 'system', label: 'system', blurb: 'Shared persona, loaded by every call type. Required: calls abort without it.' },
  { id: 'input', label: 'input', blurb: 'Appended after the system prompt when you send a message. Optional.' },
  { id: 'heartbeat', label: 'heartbeat', blurb: 'Appended for scheduled heartbeats. Optional.' },
  { id: 'reflection', label: 'reflection', blurb: 'Appended for the nightly reflection. Optional.' },
  { id: 'meta', label: 'meta', blurb: 'Appended for the weekly meta review. Optional.' },
  { id: 'self_description', label: 'self-description', blurb: 'What the daemon is told it is. Loaded only by the meta call; latest version is current.' },
]

export default async function PromptsPage({ searchParams }: { searchParams: Promise<{ kind?: string }> }) {
  const { kind } = await searchParams
  const tab = TABS.find(t => t.id === kind) ?? TABS[0]
  let versions: Awaited<ReturnType<typeof getPromptVersions>>
  try {
    versions = await getPromptVersions(tab.id)
  } catch (e) {
    return <ErrorPanel error={e} />
  }

  return (
    <div>
      <PageTitle sub="Append-only. Publishing inserts a new version; reverting publishes a copy. Nothing the daemon produces can write here.">Prompts</PageTitle>
      <div className="flex gap-1 border-b border-zinc-800 mb-3 overflow-x-auto">
        {TABS.map(t => (
          <Link
            key={t.id}
            href={`/daemon/prompts?kind=${t.id}`}
            className={`px-3 py-1.5 text-xs font-mono border-b-2 -mb-px ${t.id === tab.id ? 'border-zinc-200 text-zinc-100' : 'border-transparent text-zinc-500 hover:text-zinc-300'}`}
          >
            {t.label}
          </Link>
        ))}
      </div>
      <p className="text-xs text-zinc-500 mb-3">{tab.blurb}</p>
      <PromptEditor
        key={`${tab.id}:${versions[0]?.version ?? 0}`}
        tab={tab.id}
        versions={versions.map(v => ({ ...v, createdLabel: fmtTime(v.created_at) }))}
        debugAllowed={debugAllowed()}
      />
    </div>
  )
}
