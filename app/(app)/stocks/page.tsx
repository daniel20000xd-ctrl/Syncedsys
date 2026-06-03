import { createClient } from '@/lib/supabase/server'
import { redirect } from 'next/navigation'
import dynamic from 'next/dynamic'

// Loaded client-side only — lightweight-charts uses DOM APIs
const StockViewer = dynamic(() => import('./StockViewer'), { ssr: false })

export default async function StocksPage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  const { data: secrets } = await supabase
    .from('user_secrets')
    .select('stocks_enabled')
    .eq('user_id', user.id)
    .maybeSingle()

  // If the feature has not been enabled, send to the toggle page
  if (!(secrets as { stocks_enabled?: boolean } | null)?.stocks_enabled) {
    redirect('/settings/connected-apps')
  }

  return <StockViewer />
}
