import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import Sidebar from '@/components/Sidebar'
import TabBar from '@/components/TabBar'

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()

  if (!user) redirect('/login')

  const { data: boards } = await supabase
    .from('boards').select('*').eq('user_id', user.id).order('created_at', { ascending: true })

  const isAdmin = user.email === process.env.ADMIN_EMAIL

  return (
    <div className="flex h-full min-h-screen">
      <Sidebar boards={boards ?? []} userId={user.id} isAdmin={isAdmin} />
      <div className="flex-1 flex flex-col overflow-hidden">
        <TabBar boards={boards ?? []} />
        <main className="flex-1 overflow-hidden">{children}</main>
      </div>
    </div>
  )
}
