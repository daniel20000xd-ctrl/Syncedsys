import { createClient } from '@/lib/supabase/server'
import SettingsClient from './SettingsClient'

export default async function SettingsPage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()

  // Accounts this user is watching (owner)
  const { data: outgoing } = await supabase
    .from('account_links')
    .select('*')
    .eq('owner_id', user!.id)
    .order('created_at', { ascending: true })

  // Accounts watching this user (pending requests where I'm the member)
  const { data: incoming } = await supabase
    .from('account_links')
    .select('*')
    .eq('member_id', user!.id)
    .order('created_at', { ascending: true })

  return (
    <SettingsClient
      userId={user!.id}
      userEmail={user!.email ?? ''}
      outgoing={outgoing ?? []}
      incoming={incoming ?? []}
    />
  )
}
