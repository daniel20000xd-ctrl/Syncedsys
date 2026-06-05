import { createClient } from '@/lib/supabase/server'
import { redirect } from 'next/navigation'
import StockViewerSettings from '@/components/StockViewerSettings'
import GoogleAccountSettings from '@/components/GoogleAccountSettings'
import { getGoogleConnectionStatus } from '@/app/actions'

export default async function ConnectedAppsPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>
}) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  const stocksEnabled = !!(user.user_metadata?.stocks_enabled as boolean | undefined)
  const { connected, scopes } = await getGoogleConnectionStatus()
  const { error } = await searchParams

  return (
    <div className="p-8 bg-gray-100 min-h-screen">
      <h1 className="text-xl font-bold text-gray-800 mb-6">Connected Apps</h1>
      <div className="space-y-4 max-w-lg">
        {error === 'google_auth_failed' && (
          <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
            Google sign-in didn’t complete. Please try connecting again.
          </div>
        )}
        <GoogleAccountSettings initialConnected={connected} initialScopes={scopes} />
        <StockViewerSettings initialEnabled={stocksEnabled} />
      </div>
    </div>
  )
}
