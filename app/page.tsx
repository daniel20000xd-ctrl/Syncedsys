import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { isAdminEmail } from '@/lib/admin'
import LogoutButton from '@/components/LogoutButton'
import TodoLists from '@/components/TodoLists'

export default async function Home() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()

  if (!user) redirect('/login')

  if (!isAdminEmail(user.email)) {
    return (
      <main className="min-h-screen flex flex-col items-center justify-center gap-4 text-center px-4">
        <h1 className="text-xl font-semibold text-gray-800">Syncedsys</h1>
        <p className="text-gray-500">You&apos;re logged in. Nothing here yet.</p>
        <LogoutButton />
      </main>
    )
  }

  return (
    <main className="min-h-screen bg-gray-50 px-4 py-10 sm:px-8">
      <div className="max-w-4xl mx-auto">
        <div className="flex items-center justify-between mb-6">
          <h1 className="text-xl font-semibold text-gray-800">To-do</h1>
          <LogoutButton />
        </div>
        <TodoLists />
      </div>
    </main>
  )
}
