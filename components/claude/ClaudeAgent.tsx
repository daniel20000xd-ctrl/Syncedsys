'use client'

import { useState, useRef, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { Sparkles, X, Send, Wrench, ArrowUpRight } from 'lucide-react'

type Msg = { role: 'user' | 'assistant'; content: string }

const TOOL_LABEL: Record<string, string> = {
  get_board: 'Reading board…',
  create_board: 'Creating tab…',
  create_list: 'Adding list…',
  create_card: 'Adding card…',
  create_text: 'Adding note…',
  create_shape: 'Drawing shape…',
  create_file: 'Creating file…',
  set_board_content: 'Writing content…',
  rename_board: 'Renaming…',
}

export default function ClaudeAgent({ boardId }: { boardId: string }) {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [messages, setMessages] = useState<Msg[]>([])
  const [input, setInput] = useState('')
  const [streaming, setStreaming] = useState(false)
  const [activity, setActivity] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const didWrite = useRef(false)
  const scrollRef = useRef<HTMLDivElement>(null)

  useEffect(() => { scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' }) }, [messages, activity])

  async function send() {
    const text = input.trim()
    if (!text || streaming) return
    setError(null)
    setInput('')
    const next: Msg[] = [...messages, { role: 'user', content: text }]
    setMessages(next)
    setMessages(m => [...m, { role: 'assistant', content: '' }]) // placeholder to stream into
    setStreaming(true)
    didWrite.current = false

    try {
      const res = await fetch('/api/claude', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ boardId, messages: next }),
      })
      if (!res.ok || !res.body) {
        const j = await res.json().catch(() => ({}))
        if (j.error === 'no_key') setError('Connect your Anthropic API key in Settings first.')
        else setError(j.error || 'Request failed.')
        setMessages(m => m.slice(0, -1)) // drop empty placeholder
        setStreaming(false)
        return
      }

      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      let buf = ''
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        buf += decoder.decode(value, { stream: true })
        const lines = buf.split('\n')
        buf = lines.pop() ?? ''
        for (const line of lines) {
          if (!line.trim()) continue
          let ev: { type: string; delta?: string; name?: string; message?: string; ok?: boolean }
          try { ev = JSON.parse(line) } catch { continue }
          if (ev.type === 'text' && ev.delta) {
            setActivity(null)
            setMessages(m => { const c = [...m]; c[c.length - 1] = { role: 'assistant', content: c[c.length - 1].content + ev.delta }; return c })
          } else if (ev.type === 'tool') {
            didWrite.current = didWrite.current || ev.name !== 'get_board'
            setActivity(TOOL_LABEL[ev.name ?? ''] ?? 'Working…')
          } else if (ev.type === 'tool_result') {
            setActivity(null)
          } else if (ev.type === 'error') {
            setError(ev.message ?? 'Something went wrong.')
          } else if (ev.type === 'done') {
            setActivity(null)
          }
        }
      }
    } catch {
      setError('Connection lost.')
    } finally {
      setStreaming(false)
      setActivity(null)
      // If Claude changed anything, refresh the board so it shows up.
      if (didWrite.current) router.refresh()
    }
  }

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
      {/* Portal-style top bar */}
      <div className="h-9 bg-black/40 flex items-center justify-between px-3 text-white/90 shrink-0">
        <span className="flex items-center gap-1.5 text-xs font-medium"><Sparkles size={13} className="text-fuchsia-400" /> Claude</span>
        <button onClick={() => setOpen(false)} className="p-1 rounded hover:bg-white/20"><X size={13} /></button>
      </div>

      {/* Messages */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto px-3 py-3 space-y-3 bg-white">
        {messages.length === 0 && (
          <p className="text-xs text-gray-400 text-center mt-8 px-4">
            Ask me about this tab, or tell me to create lists, cards, notes, files, or sub-tabs inside it.
          </p>
        )}
        {messages.map((m, i) => (
          <div key={i} className={`flex ${m.role === 'user' ? 'justify-end' : 'justify-start'}`}>
            <div className={`max-w-[85%] rounded-lg px-3 py-2 text-sm whitespace-pre-wrap ${m.role === 'user' ? 'bg-[#0079bf] text-white' : 'bg-gray-100 text-gray-800'}`}>
              {m.content || (streaming && i === messages.length - 1 ? <span className="text-gray-400">…</span> : '')}
            </div>
          </div>
        ))}
        {activity && (
          <div className="flex items-center gap-1.5 text-xs text-fuchsia-600"><Wrench size={12} className="animate-pulse" /> {activity}</div>
        )}
        {error && (
          <div className="text-xs text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2 flex items-start gap-1.5">
            {error}
            {error.includes('Settings') && <a href="/settings" className="underline shrink-0 inline-flex items-center">Settings <ArrowUpRight size={11} /></a>}
          </div>
        )}
      </div>

      {/* Composer */}
      <div className="border-t border-white/10 bg-[#161a1d] p-2 shrink-0">
        <div className="flex items-end gap-2">
          <textarea
            value={input}
            onChange={e => setInput(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send() } }}
            placeholder="Ask or instruct…"
            rows={1}
            className="flex-1 resize-none bg-[#22272b] text-white text-sm rounded-lg px-3 py-2 focus:outline-none placeholder:text-white/30 max-h-28"
          />
          <button
            onClick={send}
            disabled={streaming || !input.trim()}
            className="p-2 rounded-lg bg-fuchsia-500 hover:bg-fuchsia-600 text-white disabled:opacity-40 shrink-0"
          >
            <Send size={15} />
          </button>
        </div>
      </div>
    </div>
  )
}
