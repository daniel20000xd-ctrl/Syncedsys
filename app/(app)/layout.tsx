import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { isAdminEmail } from '@/lib/admin'
import Sidebar from '@/components/Sidebar'
import TabBar from '@/components/TabBar'
import SubTabBar from '@/components/SubTabBar'

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const supabase = await createClient()

  // Middleware already validated/refreshed the session for this request, so read
  // identity from the JWT locally (no extra auth-server round trip) and run the
  // two board queries in parallel.
  const { data: claimsData } = await supabase.auth.getClaims()
  const claims = claimsData?.claims as { sub?: string; email?: string } | undefined
  if (!claims?.sub) redirect('/login')
  const userId = claims.sub

  const [{ data: allBoards }, { data: devices }] = await Promise.all([
    supabase
      .from('boards')
      .select('*')
      .eq('user_id', userId)
      .order('tab_position', { ascending: true })
      .order('created_at', { ascending: true }),
    supabase
      .from('device_links')
      .select('*')
      .eq('user_id', userId)
      .order('created_at', { ascending: true }),
  ])

  // claims.email is normally present in the Supabase JWT; fall back to getUser only
  // if it isn't, so the admin gate never silently fails on a missing claim.
  let email = claims.email
  if (!email) {
    const { data: { user } } = await supabase.auth.getUser()
    email = user?.email
  }
  const isAdmin = isAdminEmail(email)

  return (
    <div className="flex h-full min-h-screen">
      <Sidebar boards={allBoards ?? []} userId={userId} isAdmin={isAdmin} devices={devices ?? []} />
      <div className="flex-1 flex flex-col overflow-hidden">
        <TabBar boards={allBoards ?? []} />
        <SubTabBar allBoards={allBoards ?? []} />
        <main className="flex-1 overflow-hidden">{children}</main>
      </div>
    </div>
  )
}
