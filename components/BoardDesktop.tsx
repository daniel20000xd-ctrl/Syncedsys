import type { Board } from '@/lib/types'
import type { ReactNode } from 'react'

export default function BoardDesktop({ board, children }: { board: Board; children: ReactNode }) {
  return (
    <div
      className="relative flex-1 h-full overflow-hidden"
      style={{
        backgroundImage: "url('/henning-witzel-ukvgqriuOgo-unsplash.jpg')",
        backgroundSize: 'cover',
        backgroundPosition: 'center',
        backgroundColor: '#0d1117',
      }}
    >
      <div
        className="absolute overflow-hidden flex flex-col"
        style={{
          top: 48,
          right: 48,
          bottom: 48,
          left: 48,
          boxShadow: '0 8px 40px rgba(0,0,0,0.55), 0 2px 8px rgba(0,0,0,0.3)',
          backgroundColor: board.color,
        }}
      >
        {children}
      </div>
    </div>
  )
}
