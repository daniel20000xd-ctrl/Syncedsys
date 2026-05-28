import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'

export default async function OverviewPage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()

  if (user?.email !== process.env.ADMIN_EMAIL) {
    redirect('/')
  }

  const admin = createAdminClient()

  // Get all users + all boards in parallel
  const [{ data: { users } }, { data: boards }] = await Promise.all([
    admin.auth.admin.listUsers(),
    admin.from('boards').select('*').order('created_at', { ascending: true }),
  ])

  // Group boards by user, skip users with no boards
  const grouped = users
    .map(u => ({
      user: u,
      boards: (boards ?? []).filter(b => b.user_id === u.id),
    }))
    .filter(g => g.boards.length > 0 && g.user.id !== user!.id) // exclude own boards

  const totalBoards = (boards ?? []).length
  const totalUsers = grouped.length

  return (
    <div className="p-8 bg-gray-100 min-h-screen">
      <div className="flex items-start justify-between mb-8">
        <div>
          <h1 className="text-xl font-bold text-gray-800">Admin Overview</h1>
          <p className="text-sm text-gray-500 mt-0.5">
            {totalUsers} account{totalUsers !== 1 ? 's' : ''} · {totalBoards} board{totalBoards !== 1 ? 's' : ''} total
          </p>
        </div>
        <span className="text-xs bg-blue-100 text-blue-700 font-medium px-2.5 py-1 rounded-full">Admin</span>
      </div>

      {grouped.length === 0 ? (
        <div className="text-center py-20">
          <p className="text-4xl mb-3">👀</p>
          <p className="text-gray-500 text-sm">No other accounts have boards yet.</p>
        </div>
      ) : (
        <div className="space-y-10">
          {grouped.map(({ user: u, boards: userBoards }) => (
            <section key={u.id}>
              <div className="flex items-center gap-3 mb-4">
                <div className="w-7 h-7 rounded-full bg-gray-300 flex items-center justify-center text-xs font-bold text-gray-600 uppercase">
                  {(u.email?.[0] ?? '?')}
                </div>
                <div>
                  <p className="text-sm font-semibold text-gray-800">{u.email}</p>
                  <p className="text-xs text-gray-400">{userBoards.length} board{userBoards.length !== 1 ? 's' : ''}</p>
                </div>
              </div>

              <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-4">
                {userBoards.map(board => (
                  <div
                    key={board.id}
                    className="h-24 rounded-xl text-white text-sm font-semibold p-3 shadow-sm relative"
                    style={{ backgroundColor: board.color }}
                  >
                    {board.name}
                    <span className="absolute bottom-2 right-3 text-[10px] text-white/60 uppercase tracking-wider">
                      {board.mode ?? 'classic'}
                    </span>
                  </div>
                ))}
              </div>
            </section>
          ))}
        </div>
      )}
    </div>
  )
}
