'use client'

import { useState } from 'react'
import { Sparkles, X } from 'lucide-react'
import ClaudeChat from './ClaudeChat'

export default function ClaudeAgent({ boardId }: { boardId: string }) {
  const [open, setOpen] = useState(false)

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        className="fixed bottom-4 right-4 z-40 flex items-center gap-2 bg-[#1d2125] hover:bg-[#2a2f35] text-white rounded-full shadow-lg ring-1 ring-fuchsia-400/50 px-4 py-2.5 text-sm font-medium"
        title="Ask Claude"
      >
        <Sparkles size={16} className="text-fuchsia-400" /> Claude
      </button>
    )
  }

  return (
    <div className="fixed bottom-4 right-4 z-40 w-[360px] h-[480px] flex flex-col rounded-xl overflow-hidden shadow-2xl ring-1 ring-fuchsia-400/40 bg-[#1d2125]">
      <div className="h-9 bg-black/40 flex items-center justify-between px-3 text-white/90 shrink-0">
        <span className="flex items-center gap-1.5 text-xs font-medium"><Sparkles size={13} className="text-fuchsia-400" /> Claude</span>
        <button onClick={() => setOpen(false)} className="p-1 rounded hover:bg-white/20"><X size={13} /></button>
      </div>
      <ClaudeChat boardId={boardId} />
    </div>
  )
}
