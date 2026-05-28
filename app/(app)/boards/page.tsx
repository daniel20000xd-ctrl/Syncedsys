import { createClient } from '@/lib/supabase/server'
import BoardsHome from '@/components/BoardsHome'

export default async function BoardsPage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()

  const { data: boards } = await supabase
    .from('boards')
    .select('*')
    .eq('user_id', user!.id)
    .order('created_at', { ascending: true })

  return <BoardsHome boards={boards ?? []} />
}
