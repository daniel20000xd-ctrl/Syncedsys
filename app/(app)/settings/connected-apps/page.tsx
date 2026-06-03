import { createClient } from '@/lib/supabase/server'
import { redirect } from 'next/navigation'
import StockViewerSettings from '@/components/StockViewerSettings'

export default async function ConnectedAppsPage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  const { data: secrets } = await supabase
    .from('user_secrets')
    .select('stocks_enabled')
    .eq('user_id', user.id)
    .maybeSingle()

  const stocksEnabled = !!(secrets as { stocks_enabled?: boolean } | null)?.stocks_enabled

  return (
    <div className="p-8 bg-gray-100 min-h-screen">
      <h1 className="text-xl font-bold text-gray-800 mb-6">Connected Apps</h1>
      <div className="space-y-4 max-w-lg">
        <StockViewerSettings initialEnabled={stocksEnabled} />
      </div>
    </div>
  )
}
