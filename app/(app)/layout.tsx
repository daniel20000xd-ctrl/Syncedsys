import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import Sidebar from '@/components/Sidebar'
import TabBar from '@/components/TabBar'

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()

  if (!user) redirect('/login')

  const [{ data: boards }, { data: linkedAccounts }] = await Promise.all([
    supabase.from('boards').select('*').eq('user_id', user.id).order('created_at', { ascending: true }),
    supabase.from('account_links').select('id').eq('owner_id', user.id).eq('status', 'accepted'),
  ])

  const hasLinkedAccounts = (linkedAccounts?.length ?? 0) > 0

  return (
    <div className="flex h-full min-h-screen">
      <Sidebar boards={boards ?? []} userId={user.id} hasLinkedAccounts={hasLinkedAccounts} />
      <div className="flex-1 flex flex-col overflow-hidden">
        <TabBar boards={boards ?? []} />
        <main className="flex-1 overflow-hidden">{children}</main>
      </div>
    </div>
  )
}
