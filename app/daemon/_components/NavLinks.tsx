'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'

const LINKS = [
  ['/daemon', 'overview'],
  ['/daemon/prompts', 'prompts'],
  ['/daemon/models', 'models'],
  ['/daemon/notes', 'notes'],
  ['/daemon/memory', 'memory'],
  ['/daemon/threads', 'threads'],
  ['/daemon/proposals', 'proposals'],
  ['/daemon/logs', 'logs'],
  ['/daemon/metrics', 'metrics'],
  ['/daemon/usage', 'usage'],
  ['/daemon/graph', 'graph'],
] as const

export function NavLinks() {
  const path = usePathname()
  return (
    <nav className="flex items-center gap-3 text-xs">
      {LINKS.map(([href, label]) => {
        const active = href === '/daemon' ? path === href : path.startsWith(href)
        return (
          <Link key={href} href={href} className={active ? 'text-zinc-100 underline underline-offset-4' : 'text-zinc-500 hover:text-zinc-300'}>
            {label}
          </Link>
        )
      })}
    </nav>
  )
}
