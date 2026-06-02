'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { Plus } from 'lucide-react'
import type { Board } from '@/lib/types'
import { createBoard } from '@/app/actions'
import NewBoardModal from './NewBoardModal'

const MODE_EMOJI: Record<Board['mode'], string> = {
  classic: '🎨',
  trello: '🗂',
  text: '📝',
  folder: '📁',
  spreadsheet: '📊',
}

export default function BoardsHome({ boards }: { boards: Board[] }) {
  const [showModal, setShowModal] = useState(false)
  const [, startTransition] = useTransition()
  const router = useRouter()

  return (
    <div className="p-8 bg-gray-100 min-h-screen">
      <h1 className="text-xl font-bold text-gray-800 mb-6">Your boards</h1>
      <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-4">
        {boards.map(board => (
          <button
            key={board.id}
            onClick={() => router.push(`/board/${board.id}`)}
            className="relative h-24 rounded-lg text-white font-semibold text-sm text-left p-3 hover:brightness-90 transition-all shadow-sm flex flex-col justify-between"
            style={{ backgroundColor: board.color }}
          >
            <span className="text-xl leading-none">{MODE_EMOJI[board.mode] ?? '🎨'}</span>
            <span className="truncate">{board.name}</span>
          </button>
        ))}
        <button
          onClick={() => setShowModal(true)}
          className="h-24 rounded-lg bg-gray-200 hover:bg-gray-300 text-gray-600 font-medium text-sm flex items-center justify-center gap-1.5 transition-colors"
        >
          <Plus size={16} />
          Create new board
        </button>
      </div>

      {showModal && (
        <NewBoardModal
          onClose={() => setShowModal(false)}
          onCreate={(name, color, mode) => {
            startTransition(async () => {
              const board = await createBoard(name, color, mode)
              setShowModal(false)
              router.push(`/board/${board.id}`)
            })
          }}
        />
      )}
    </div>
  )
}
