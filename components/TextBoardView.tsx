'use client'

import { useState, useRef, useCallback } from 'react'
import type { Board } from '@/lib/types'
import { updateBoardContent } from '@/app/actions'

export default function TextBoardView({ board }: { board: Board }) {
  const [content, setContent] = useState(board.content ?? '')
  const [saveStatus, setSaveStatus] = useState<'idle' | 'saving' | 'saved'>('idle')
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const save = useCallback(async (value: string) => {
    setSaveStatus('saving')
    await updateBoardContent(board.id, value)
    setSaveStatus('saved')
    setTimeout(() => setSaveStatus('idle'), 2000)
  }, [board.id])

  function handleChange(e: React.ChangeEvent<HTMLTextAreaElement>) {
    const value = e.target.value
    setContent(value)
    if (timerRef.current) clearTimeout(timerRef.current)
    timerRef.current = setTimeout(() => save(value), 600)
  }

  return (
    <div className="h-full flex flex-col bg-white overflow-hidden">
      <div className="flex items-center justify-between px-16 py-3 border-b border-gray-100 shrink-0">
        <span className="text-sm font-medium text-gray-500">{board.name}</span>
        <span className={`text-xs transition-opacity duration-300 ${saveStatus === 'idle' ? 'opacity-0' : 'opacity-100'} text-gray-400`}>
          {saveStatus === 'saving' ? 'Saving…' : 'Saved'}
        </span>
      </div>
      <textarea
        value={content}
        onChange={handleChange}
        placeholder="Start writing…"
        spellCheck
        className="flex-1 w-full max-w-2xl mx-auto px-16 py-10 text-gray-800 text-base leading-7 resize-none focus:outline-none placeholder:text-gray-300"
        style={{ fontFamily: 'Georgia, "Times New Roman", serif' }}
      />
    </div>
  )
}
