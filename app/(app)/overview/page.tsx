import { createClient } from '@/lib/supabase/server'
import Link from 'next/link'

export default async function OverviewPage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()

  const { data: links } = await supabase
    .from('account_links')
    .select('*')
    .eq('owner_id', user!.id)
    .eq('status', 'accepted')

  if (!links || links.length === 0) {
    return (
      <div className="p-8 bg-gray-100 min-h-screen flex flex-col items-center justify-center text-center">
        <p className="text-4xl mb-4">🔗</p>
        <h1 className="text-xl font-bold text-gray-800 mb-2">No linked accounts yet</h1>
        <p className="text-gray-500 text-sm mb-4 max-w-sm">
          Go to Settings to link your other accounts. Once accepted, their boards will appear here.
        </p>
        <Link href="/settings" className="text-[#0079bf] text-sm hover:underline">Open settings →</Link>
      </div>
    )
  }

  // Fetch boards for all linked member accounts
  // RLS policy "admin view linked boards" allows this SELECT
  const memberIds = links.map(l => l.member_id)
  const { data: boards } = await supabase
    .from('boards')
    .select('*')
    .in('user_id', memberIds)
    .order('created_at', { ascending: true })

  const grouped = links.map(link => ({
    link,
    boards: (boards ?? []).filter(b => b.user_id === link.member_id),
  }))

  return (
    <div className="p-8 bg-gray-100 min-h-screen">
      <h1 className="text-xl font-bold text-gray-800 mb-1">Overview</h1>
      <p className="text-sm text-gray-500 mb-8">Read-only view of your linked accounts' boards.</p>

      <div className="space-y-10">
        {grouped.map(({ link, boards }) => (
          <section key={link.id}>
            <div className="flex items-center gap-3 mb-4">
              <div className="w-2.5 h-2.5 rounded-full bg-green-400" />
              <h2 className="font-semibold text-gray-800">{link.label}</h2>
              <span className="text-xs text-gray-400 font-mono">{link.member_id.slice(0, 12)}…</span>
              <span className="text-xs text-gray-400 ml-auto">{boards.length} board{boards.length !== 1 ? 's' : ''}</span>
            </div>

            {boards.length === 0 ? (
              <p className="text-sm text-gray-400 italic pl-5">No boards yet</p>
            ) : (
              <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-4">
                {boards.map(board => (
                  <div
                    key={board.id}
                    className="h-24 rounded-xl text-white text-sm font-semibold p-3 relative shadow-sm cursor-default"
                    style={{ backgroundColor: board.color }}
                  >
                    {board.name}
                    <span className="absolute bottom-2 right-3 text-[10px] text-white/60 uppercase tracking-wider font-medium">
                      {board.mode ?? 'classic'}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </section>
        ))}
      </div>
    </div>
  )
}
