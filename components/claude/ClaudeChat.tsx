'use client'

import { useState, useRef, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { Send, ArrowUpRight } from 'lucide-react'
import { ClaudeMark } from './ClaudeMark'
import { claudeDropRegistry } from '@/lib/claudeDropRegistry'

export type Msg = { role: 'user' | 'assistant'; content: string }

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

// The shared chat core. Fills its parent (h-full flex column). Used by both the
// floating ClaudeAgent panel and the on-canvas ClaudeNode. Interactive areas are
// marked nodrag/nowheel so it behaves correctly when embedded in a React Flow node.
export default function ClaudeChat({ boardId, nodeId }: { boardId: string; nodeId?: string }) {
  const router = useRouter()
  const [messages, setMessages] = useState<Msg[]>([])
  const [input, setInput] = useState('')
  const [streaming, setStreaming] = useState(false)
  const [activity, setActivity] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const didWrite = useRef(false)
  const scrollRef = useRef<HTMLDivElement>(null)

  // Register this chat instance so FreeBoardView can inject dropped-file text.
  useEffect(() => {
    if (!nodeId) return
    claudeDropRegistry.register(nodeId, (text, filename) => {
      setInput(prev => {
        const block = `[File: ${filename}]\n${text}`
        return prev.trim() ? `${prev.trim()}\n\n${block}` : block
      })
    })
    return () => { claudeDropRegistry.unregister(nodeId) }
  }, [nodeId])

  useEffect(() => { scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' }) }, [messages, activity])

  async function send() {
    const text = input.trim()
    if (!text || streaming) return
    setError(null)
    setInput('')
    const next: Msg[] = [...messages, { role: 'user', content: text }]
    setMessages(next)
    setMessages(m => [...m, { role: 'assistant', content: '' }])
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
        setMessages(m => m.slice(0, -1))
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
      if (didWrite.current) router.refresh()
    }
  }

  return (
    <div className="flex flex-col h-full min-h-0">
      {/* Messages — warm Claude cream background, dark readable text */}
      <div ref={scrollRef} className="nodrag nowheel flex-1 overflow-y-auto px-3.5 py-4 space-y-3.5 bg-[#1e1d1b]">
        {messages.length === 0 && (
          <div className="flex flex-col items-center text-center mt-8 px-4 gap-3">
            <ClaudeMark size={40} animate />
            <p className="text-[15px] text-[#a09a91] leading-relaxed">
              Ask me about this tab, or tell me to create lists, cards, notes, files, or sub-tabs inside it.
            </p>
          </div>
        )}
        {messages.map((m, i) => (
          <div key={i} className={`flex ${m.role === 'user' ? 'justify-end' : 'justify-start'} gap-2`}>
            {m.role === 'assistant' && <ClaudeMark size={20} animate={streaming && i === messages.length - 1} />}
            <div className={`max-w-[85%] rounded-2xl px-3.5 py-2.5 text-[15px] leading-relaxed whitespace-pre-wrap ${m.role === 'user' ? 'bg-[#D97757] text-white' : 'bg-[#2d2c29] text-[#e8e3db] shadow-sm'}`}>
              {m.content || (streaming && i === messages.length - 1 ? <span className="text-[#b8b2a6]">…</span> : '')}
            </div>
          </div>
        ))}
        {activity && (
          <div className="flex items-center gap-2 text-[13px] font-medium text-[#D97757]">
            <ClaudeMark size={15} animate /> {activity}
          </div>
        )}
        {error && (
          <div className="text-[13px] text-red-300 bg-red-950/60 border border-red-800/50 rounded-xl px-3 py-2 flex items-start gap-1.5">
            {error}
            {error.includes('Settings') && <a href="/settings" className="underline shrink-0 inline-flex items-center">Settings <ArrowUpRight size={12} /></a>}
          </div>
        )}
      </div>

      {/* Composer */}
      <div className="border-t border-black/10 bg-[#30302E] p-2.5 shrink-0">
        <div className="flex items-end gap-2">
          <textarea
            value={input}
            onChange={e => setInput(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send() } }}
            onPointerDown={e => e.stopPropagation()}
            placeholder="Ask or instruct…"
            rows={1}
            className="nodrag flex-1 resize-none bg-[#3d3d3a] text-[#F0EEE6] text-[15px] rounded-xl px-3.5 py-2.5 focus:outline-none focus:ring-1 focus:ring-[#D97757]/60 placeholder:text-[#F0EEE6]/35 max-h-28"
          />
          <button
            onClick={send}
            disabled={streaming || !input.trim()}
            className="nodrag p-2.5 rounded-xl bg-[#D97757] hover:bg-[#c56647] text-white disabled:opacity-40 shrink-0 transition-colors"
          >
            <Send size={16} />
          </button>
        </div>
      </div>
    </div>
  )
}
