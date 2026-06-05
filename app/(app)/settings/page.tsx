import { headers } from 'next/headers'
import Link from 'next/link'
import { ArrowUpRight } from 'lucide-react'
import { createClient } from '@/lib/supabase/server'
import { isAdminEmail } from '@/lib/admin'
import { getClaudeStatus, getClaudeUsage, getStorageUsage, syncStorageCounter, listMcpTokens } from '@/app/actions'
import ClaudeKeySettings from '@/components/ClaudeKeySettings'
import ClaudeUsageCard from '@/components/ClaudeUsageCard'
import McpConnectSettings from '@/components/McpConnectSettings'
import StorageMeter from '@/components/StorageMeter'

export default async function SettingsPage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  const isAdmin = isAdminEmail(user?.email)
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

        <StorageMeter usage={storage} />

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
      </div>
    </div>
  )
}
