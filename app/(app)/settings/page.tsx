import { headers } from 'next/headers'
import Link from 'next/link'
import { ArrowUpRight } from 'lucide-react'
import { createClient } from '@/lib/supabase/server'
import { isAdminEmail } from '@/lib/admin'
import { getAccountLimits } from '@/lib/limits'
import { getClaudeStatus, getClaudeUsage, getStorageUsage, syncStorageCounter, listMcpTokens } from '@/app/actions'
import { getPersonaId } from '@/lib/persona'
import ClaudeKeySettings from '@/components/ClaudeKeySettings'
import ClaudeUsageCard from '@/components/ClaudeUsageCard'
import McpConnectSettings from '@/components/McpConnectSettings'
import StorageMeter from '@/components/StorageMeter'
import PersonaSettings from '@/components/PersonaSettings'
import DevicePairingSettings from '@/components/DevicePairingSettings'

export default async function SettingsPage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  const isAdmin = isAdminEmail(user?.email)
  const limits = getAccountLimits(user)
  let claude = { hasKey: false, autoApply: false }
  try { claude = await getClaudeStatus() } catch {
    // Crypto or DB error — degrade gracefully; the key section will still render
  }
  const storage = await getStorageUsage()
  if (storage !== null) await syncStorageCounter(storage.totalBytes)
  const claudeUsage = await getClaudeUsage()

  const h = await headers()
  const host = h.get('host') ?? 'syncedsys.com'
  const proto = host.startsWith('localhost') || host.startsWith('127.') ? 'http' : 'https'
  const mcpUrl = `${proto}://${host}/api/mcp`
  const mcpTokens = await listMcpTokens()

  const { data: deviceLinks } = await supabase
    .from('device_links')
    .select('id, name, pairing_code, paired, last_seen, created_at')
    .eq('user_id', user?.id ?? '')
    .order('created_at', { ascending: false })

  // Personas (with the count of boards inside each, for the delete warning).
  // select('*') + JS filter so this never errors on the pre-migration schema.
  const { data: allBoards } = await supabase.from('boards').select('*').eq('user_id', user?.id ?? '')
  const boards = allBoards ?? []
  const personas = boards
    .filter(b => b.is_persona)
    .sort((a, b) => (a.tab_position - b.tab_position) || String(a.created_at).localeCompare(String(b.created_at)))
    .map(p => ({
      id: p.id as string,
      name: p.name as string,
      color: p.color as string,
      boardCount: boards.filter(b => !b.is_persona && getPersonaId(b.id, boards) === p.id).length,
    }))

  return (
    <div className="p-8 bg-gray-100 min-h-screen">
      <h1 className="text-xl font-bold text-gray-800 mb-6">Settings</h1>
      <div className="space-y-4 max-w-lg">
        <section className="bg-white rounded-xl p-5 shadow-sm">
          <h2 className="font-semibold text-gray-800 mb-3">Account</h2>
          <p className="text-sm text-gray-600">{user?.email}</p>
          {isAdmin && (
            <Link
              href="/admin"
              className="inline-flex items-center gap-1 mt-2 text-xs bg-blue-100 text-blue-700 hover:bg-blue-200 font-medium px-2.5 py-1 rounded-full transition-colors"
            >
              Admin Console <ArrowUpRight size={12} />
            </Link>
          )}
        </section>

        <StorageMeter usage={storage} limitBytes={limits.storageBytes} />

        <ClaudeUsageCard
          hasOwnKey={claudeUsage.hasOwnKey}
          usingPlatform={claudeUsage.usingPlatform}
          initialPayPerUse={claudeUsage.payPerUse}
          freeUsd={claudeUsage.freeUsd}
          spentUsd={claudeUsage.spentUsd}
          owedUsd={claudeUsage.owedUsd}
        />

        <ClaudeKeySettings initialHasKey={claude.hasKey} initialAutoApply={claude.autoApply} />

        <McpConnectSettings mcpUrl={mcpUrl} initialTokens={mcpTokens} />

        <DevicePairingSettings initialDevices={deviceLinks ?? []} />

        {personas.length > 0 && <PersonaSettings personas={personas} />}
      </div>
    </div>
  )
}
