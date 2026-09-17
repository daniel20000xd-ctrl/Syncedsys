import { getNotesVersions } from '@/app/daemonActions'
import { diffStats, lineDiff } from '@/lib/daemon/diff'
import { Badge, DiffView, Empty, ErrorPanel, fmtTime, Md, PageTitle, Panel } from '../_components/ui'

export default async function NotesPage({ searchParams }: { searchParams: Promise<{ full?: string }> }) {
  const { full } = await searchParams
  let data: Awaited<ReturnType<typeof getNotesVersions>>
  try {
    data = await getNotesVersions()
  } catch (e) {
    return <ErrorPanel error={e} />
  }
  const { versions, maxChars } = data

  return (
    <div>
      <PageTitle sub={`All versions newest-first, each diffed against the one before. Cap: ${maxChars} chars (DAEMON_NOTES_MAX_CHARS). Read-only.`}>
        Operating notes
      </PageTitle>
      {!versions.length && <Empty>No operating notes yet — the first nightly reflection writes version 1.</Empty>}
      <div className="space-y-4">
        {versions.map((v, i) => {
          const prev = versions[i + 1]
          const lines = lineDiff(prev?.content ?? '', v.content)
          const stats = diffStats(lines)
          const over = v.content.length > maxChars
          const showFull = full === String(v.version) || i === 0
          return (
            <Panel
              key={v.version}
              title={<span className="font-mono normal-case text-zinc-200">v{v.version}{i === 0 && ' · current'}</span>}
              right={
                <span className="flex items-center gap-2">
                  <span>{fmtTime(v.created_at)}</span>
                  <span className={`font-mono ${over ? 'text-red-400' : 'text-zinc-400'}`}>{v.content.length}/{maxChars}</span>
                  {over && <Badge tone="red">over cap</Badge>}
                  {prev && <span className="font-mono"><span className="text-emerald-400">+{stats.added}</span> <span className="text-red-400">−{stats.removed}</span></span>}
                </span>
              }
            >
              <div className={`grid gap-4 ${showFull ? 'xl:grid-cols-2' : ''}`}>
                <div className="min-w-0">
                  <div className="text-[10px] uppercase tracking-wider text-zinc-500 mb-1">{prev ? `diff vs v${prev.version}` : 'first version'}</div>
                  {prev ? <DiffView lines={lines} /> : <Md>{v.content}</Md>}
                </div>
                {showFull && prev && (
                  <div className="min-w-0">
                    <div className="text-[10px] uppercase tracking-wider text-zinc-500 mb-1">full text</div>
                    <Md>{v.content}</Md>
                  </div>
                )}
              </div>
              {!showFull && <a href={`/daemon/notes?full=${v.version}#v${v.version}`} id={`v${v.version}`} className="text-[11px] text-sky-500 mt-2 inline-block">show full text</a>}
            </Panel>
          )
        })}
      </div>
    </div>
  )
}
