import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient, listAllAuthUsers } from '@/lib/supabase/admin'
import { getAdminClaudeBilling, getClaudeApiEnabled } from '@/app/actions'
import { isAdminEmail } from '@/lib/admin'
import ClaudeApiSwitch from '@/components/ClaudeApiSwitch'

function fmtUsd(n: number): string {
  if (n <= 0) return '$0.00'
  return n < 1 ? `$${n.toFixed(4)}` : `$${n.toFixed(2)}`
}

export default async function AdminConsolePage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()

  if (!isAdminEmail(user?.email)) {
    redirect('/')
  }

  const admin = createAdminClient()

  // All users + all boards + Claude billing + kill-switch state in parallel.
  const [users, { data: boards }, billing, claudeEnabled] = await Promise.all([
    listAllAuthUsers(admin),
    admin.from('boards').select('*').order('created_at', { ascending: true }),
    getAdminClaudeBilling(),
    getClaudeApiEnabled(),
  ])

  const totalOwed = billing.reduce((s, b) => s + b.owedUsd, 0)

  // Group boards by user, skip users with no boards (and the admin's own).
  const grouped = users
    .map(u => ({
      user: u,
      boards: (boards ?? []).filter(b => b.user_id === u.id),
    }))
    .filter(g => g.boards.length > 0 && g.user.id !== user!.id)

  const totalBoards = (boards ?? []).length
  const totalUsers = grouped.length

  const sectionLabel = 'text-xs font-semibold text-gray-400 uppercase tracking-wider mb-3'

  return (
    <div className="p-8 bg-gray-100 h-full overflow-y-auto">
      <div className="max-w-5xl">
        {/* Header */}
        <div className="flex items-start justify-between mb-8">
          <div>
            <h1 className="text-xl font-bold text-gray-800">Admin Console</h1>
            <p className="text-sm text-gray-500 mt-0.5">
              {totalUsers} account{totalUsers !== 1 ? 's' : ''} · {totalBoards} board{totalBoards !== 1 ? 's' : ''} · {fmtUsd(totalOwed)} owed this month
            </p>
          </div>
          <span className="text-xs bg-blue-100 text-blue-700 font-medium px-2.5 py-1 rounded-full">Admin</span>
        </div>

        {/* ── Claude API ─────────────────────────────────────────────────── */}
        <h2 className={sectionLabel}>Claude API</h2>

        <ClaudeApiSwitch initialEnabled={claudeEnabled} />

        <section className="bg-white rounded-xl shadow-sm mb-12 overflow-hidden">
          <div className="flex items-center justify-between px-5 py-4 border-b border-gray-100">
            <h3 className="font-semibold text-gray-800">Platform credits — this month</h3>
            <span className="text-sm text-gray-500">{fmtUsd(totalOwed)} owed total</span>
          </div>
          {billing.length === 0 ? (
            <p className="text-sm text-gray-400 px-5 py-6">No platform-credit usage this month.</p>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs text-gray-400 border-b border-gray-100">
                  <th className="font-medium px-5 py-2">Account</th>
                  <th className="font-medium px-3 py-2">Plan</th>
                  <th className="font-medium px-3 py-2 text-right">Requests</th>
                  <th className="font-medium px-3 py-2 text-right">Tokens (in / out)</th>
                  <th className="font-medium px-3 py-2 text-right">Raw cost</th>
                  <th className="font-medium px-5 py-2 text-right">Owed</th>
                </tr>
              </thead>
              <tbody>
                {billing.map(b => (
                  <tr key={b.userId} className="border-b border-gray-50 last:border-0">
                    <td className="px-5 py-2 text-gray-700">{b.email}</td>
                    <td className="px-3 py-2">
                      <span className={`text-xs px-2 py-0.5 rounded-full ${b.payPerUse ? 'bg-fuchsia-100 text-fuchsia-700' : 'bg-gray-100 text-gray-500'}`}>
                        {b.payPerUse ? 'pay-per-use' : 'free only'}
                      </span>
                    </td>
                    <td className="px-3 py-2 text-right text-gray-500">{b.requests}</td>
                    <td className="px-3 py-2 text-right text-gray-500">
                      {b.inputTokens.toLocaleString()} / {b.outputTokens.toLocaleString()}
                    </td>
                    <td className="px-3 py-2 text-right text-gray-400">{fmtUsd(b.spentRawUsd)}</td>
                    <td className="px-5 py-2 text-right font-semibold text-gray-800">{fmtUsd(b.owedUsd)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>

        {/* ── Accounts & boards ──────────────────────────────────────────── */}
        <h2 className={sectionLabel}>Accounts &amp; boards</h2>

        {grouped.length === 0 ? (
          <div className="bg-white rounded-xl shadow-sm text-center py-16">
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
    </div>
  )
}
