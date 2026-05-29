import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import Sidebar from '@/components/Sidebar'
import TabBar from '@/components/TabBar'
import SubTabBar from '@/components/SubTabBar'

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()

  if (!user) redirect('/login')

  const { data: allBoards } = await supabase
    .from('boards')
    .select('*')
    .eq('user_id', user.id)
    .order('tab_position', { ascending: true })
    .order('created_at', { ascending: true })

  const { data: devices } = await supabase
    .from('device_links')
    .select('*')
    .eq('user_id', user.id)
    .order('created_at', { ascending: true })

  const isAdmin = user.email === process.env.ADMIN_EMAIL

  return (
    <div className="flex h-full min-h-screen">
      <Sidebar boards={allBoards ?? []} userId={user.id} isAdmin={isAdmin} devices={devices ?? []} />
      <div className="flex-1 flex flex-col overflow-hidden">
        <TabBar boards={allBoards ?? []} />
        <SubTabBar allBoards={allBoards ?? []} />
        <main className="flex-1 overflow-hidden">{children}</main>
      </div>
    </div>
  )
}
