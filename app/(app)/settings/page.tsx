import { createClient } from '@/lib/supabase/server'

export default async function SettingsPage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  const isAdmin = user?.email === process.env.ADMIN_EMAIL

  return (
    <div className="p-8 bg-gray-100 min-h-screen">
      <h1 className="text-xl font-bold text-gray-800 mb-6">Settings</h1>
      <div className="space-y-4 max-w-lg">
        <section className="bg-white rounded-xl p-5 shadow-sm">
          <h2 className="font-semibold text-gray-800 mb-3">Account</h2>
          <p className="text-sm text-gray-600">{user?.email}</p>
          {isAdmin && (
            <span className="inline-block mt-2 text-xs bg-blue-100 text-blue-700 font-medium px-2.5 py-1 rounded-full">
              Admin account
            </span>
          )}
        </section>
      </div>
    </div>
  )
}
