'use client'

import { useState } from 'react'
import { X } from 'lucide-react'
import ClaudeChat from './ClaudeChat'
import { ClaudeMark } from './ClaudeMark'

export default function ClaudeAgent({ boardId }: { boardId: string }) {
  const [open, setOpen] = useState(false)

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        className="fixed bottom-4 right-4 z-40 flex items-center gap-2.5 bg-[#30302E] hover:bg-[#3d3d3a] text-[#F0EEE6] shadow-xl ring-2 ring-[#D97757]/60 px-5 py-3 text-sm font-semibold transition-colors"
        title="Ask Claude"
      >
        <ClaudeMark size={20} animate /> Claude
      </button>
    )
  }

  return (
    <div className="fixed bottom-4 right-4 z-40 w-[380px] h-[520px] flex flex-col rounded-xl overflow-hidden shadow-2xl ring-1 ring-[#D97757]/40 bg-[#30302E]">
      <div className="h-9 bg-[#262624] flex items-center justify-between px-3 text-[#F0EEE6] shrink-0">
        <span className="flex items-center gap-1.5 text-sm font-medium"><ClaudeMark size={15} animate /> Claude</span>
        <button onClick={() => setOpen(false)} className="p-1 rounded hover:bg-white/15"><X size={14} /></button>
      </div>
      <ClaudeChat boardId={boardId} />
    </div>
  )
}
