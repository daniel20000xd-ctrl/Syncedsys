import { createClient } from '@/lib/supabase/server'
import { redirect } from 'next/navigation'
import StockViewerWrapper from './StockViewerWrapper'

export default async function StocksPage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  if (!user.user_metadata?.stocks_enabled) {
    redirect('/settings/connected-apps')
  }

  return <StockViewerWrapper />
}
