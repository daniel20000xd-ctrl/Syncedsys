import { createClient, type SupabaseClient } from '@supabase/supabase-js'

export function createAdminClient() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { autoRefreshToken: false, persistSession: false } }
  )
}

// admin.auth.admin.listUsers() returns only the first 50 users by default. Page
// through all of them so admin views (billing, the user grid) don't silently drop
// or mislabel accounts past the first page.
export async function listAllAuthUsers(admin: SupabaseClient): Promise<{ id: string; email?: string }[]> {
  const all: { id: string; email?: string }[] = []
  for (let page = 1; page <= 1000; page++) {
    const { data, error } = await admin.auth.admin.listUsers({ page, perPage: 1000 })
    if (error || !data?.users?.length) break
    all.push(...data.users)
    if (data.users.length < 1000) break
  }
  return all
}
