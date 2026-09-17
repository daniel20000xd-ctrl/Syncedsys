import Link from 'next/link'
import { notFound, redirect } from 'next/navigation'
import type { ReactNode } from 'react'
import { getAdminAccess } from '@/app/daemonActions'
import { NavLinks } from './_components/NavLinks'

export const dynamic = 'force-dynamic'
// Manual triggers and dry runs run a full model call inside a server action.
export const maxDuration = 60

export const metadata = { title: 'Daemon · Syncedsys' }

// The proxy already bounces signed-out users; this re-checks admin on the server. Each
// page's data action checks again, since layouts don't re-render on client navigation.
export default async function DaemonLayout({ children }: { children: ReactNode }) {
  const access = await getAdminAccess()
  if (!access.signedIn) redirect('/login')
  if (!access.admin) notFound()

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-300 text-sm [color-scheme:dark]">
      <header className="sticky top-0 z-20 border-b border-zinc-800 bg-zinc-950/95 backdrop-blur">
        <div className="flex items-center gap-4 px-4 h-10 overflow-x-auto">
          <Link href="/daemon" className="font-mono text-zinc-100 font-semibold shrink-0">daemon</Link>
          <NavLinks />
          <Link href="/" className="ml-auto text-xs text-zinc-500 hover:text-zinc-300 shrink-0">syncedsys ↗</Link>
        </div>
      </header>
      <main className="px-4 py-4 max-w-[1400px] mx-auto">{children}</main>
    </div>
  )
}
