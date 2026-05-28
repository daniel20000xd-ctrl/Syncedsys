'use client'

import { useEffect, useCallback } from 'react'
import Link from 'next/link'
import { usePathname, useRouter } from 'next/navigation'
import { Plus, X } from 'lucide-react'
import type { Board } from '@/lib/types'

export default function TabBar({ boards }: { boards: Board[] }) {
  const pathname = usePathname()
  const router = useRouter()

  const activeBoardIndex = boards.findIndex(b => pathname === `/board/${b.id}`)

  const goToTab = useCallback((index: number) => {
    if (boards.length === 0) return
    const clamped = (index + boards.length) % boards.length
    router.push(`/board/${boards[clamped].id}`)
  }, [boards, router])

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (!e.altKey) return
      if (e.key === 'q' || e.key === 'Q') {
        e.preventDefault()
        goToTab(activeBoardIndex - 1)
      }
      if (e.key === 'w' || e.key === 'W') {
        e.preventDefault()
        goToTab(activeBoardIndex + 1)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [activeBoardIndex, goToTab])

  return (
    <div className="flex items-end bg-[#1d2125] border-b border-white/10 overflow-x-auto shrink-0 px-1">
      {boards.map((board, i) => {
        const isActive = pathname === `/board/${board.id}`
        return (
          <Link
            key={board.id}
            href={`/board/${board.id}`}
            className={`relative flex items-center gap-2 px-4 py-2.5 text-sm whitespace-nowrap border-t-2 transition-colors select-none ${
              isActive
                ? 'bg-white/10 text-white border-[#579dff]'
                : 'text-white/50 border-transparent hover:text-white/80 hover:bg-white/5'
            }`}
          >
            <span
              className="w-2.5 h-2.5 rounded-full shrink-0"
              style={{ backgroundColor: board.color }}
            />
            {board.name}
          </Link>
        )
      })}

      <Link
        href="/boards"
        className="flex items-center gap-1.5 px-3 py-2.5 text-white/40 hover:text-white/70 text-sm whitespace-nowrap border-t-2 border-transparent"
        title="All boards"
      >
        <Plus size={14} />
      </Link>
    </div>
  )
}
