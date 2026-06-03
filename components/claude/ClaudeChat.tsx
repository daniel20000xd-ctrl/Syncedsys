'use client'

import { useState, useRef, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { Send, ArrowUpRight, FileText, FileType, X } from 'lucide-react'
import { ClaudeMark } from './ClaudeMark'
import { claudeDropRegistry, type ChatAttachment } from '@/lib/claudeDropRegistry'

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

// ── Attachment chip ────────────────────────────────────────────────────────────
function AttachmentChip({ a, onRemove }: { a: ChatAttachment; onRemove: () => void }) {
  return (
    <div className="nodrag relative flex items-center gap-2 bg-[#2a2926] border border-[#3d3a36] rounded-xl overflow-hidden pr-2 shrink-0 max-w-[180px] group/chip">
      {/* Thumbnail or icon */}
      {a.thumbnail ? (
        <img src={a.thumbnail} alt="" className="h-12 w-10 object-cover shrink-0 rounded-l-xl" />
      ) : (
        <div className="h-12 w-10 flex items-center justify-center bg-[#3d3a36] shrink-0 rounded-l-xl">
          {a.kind === 'pdf'
            ? <FileType size={18} className="text-[#D97757]" />
            : <FileText size={18} className="text-indigo-400" />}
        </div>
      )}
      {/* Name + type label */}
      <div className="flex flex-col min-w-0 py-1">
        <span className="text-[12px] font-medium text-[#e8e3db] truncate leading-tight">{a.name}</span>
        <span className="text-[10px] text-[#7a7570] uppercase tracking-wide leading-tight">
          {a.kind === 'pdf' ? 'PDF' : 'Text file'}
        </span>
      </div>
      {/* Remove button */}
      <button
        onClick={onRemove}
        className="nodrag absolute top-1 right-1 opacity-0 group-hover/chip:opacity-100 p-0.5 rounded-full bg-[#1e1d1b]/80 text-[#a09a91] hover:text-white transition-opacity"
      >
        <X size={10} />
      </button>
    </div>
  )
}

// ── Chat core ──────────────────────────────────────────────────────────────────
// Fills its parent (h-full flex column). Used by both the floating ClaudeAgent
// panel and the on-canvas ClaudeNode. Interactive areas are marked nodrag/nowheel
// so it behaves correctly when embedded in a React Flow node.
export default function ClaudeChat({ boardId, nodeId }: { boardId: string; nodeId?: string }) {
  const router = useRouter()
  const [messages, setMessages] = useState<Msg[]>([])
  const [input, setInput] = useState('')
  const [attachments, setAttachments] = useState<ChatAttachment[]>([])
  const [streaming, setStreaming] = useState(false)
  const [activity, setActivity] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const didWrite = useRef(false)
  const scrollRef = useRef<HTMLDivElement>(null)

  // Register so FreeBoardView can inject file attachments into this chat instance.
  useEffect(() => {
    if (!nodeId) return
    claudeDropRegistry.register(nodeId, (attachment) => {
      setAttachments(prev => {
        // Avoid duplicates by id (same file dropped twice)
        if (prev.some(a => a.id === attachment.id)) return prev
        return [...prev, attachment]
      })
    })
    return () => { claudeDropRegistry.unregister(nodeId) }
  }, [nodeId])

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' })
  }, [messages, activity])

  function removeAttachment(id: string) {
    setAttachments(prev => prev.filter(a => a.id !== id))
  }

  async function send() {
    const text = input.trim()
    if ((!text && attachments.length === 0) || streaming) return
    setError(null)
    setInput('')

    // Build the full message content: attachment blocks first, then user text.
    const attachmentBlocks = attachments.map(a =>
      `[Attached file: ${a.name}]\n${a.content || '(no extractable text)'}`
    ).join('\n\n---\n\n')
    const fullContent = attachmentBlocks
      ? (text ? `${attachmentBlocks}\n\n---\n\n${text}` : attachmentBlocks)
      : text
    setAttachments([])

    // The bubble shown to the user only shows the typed text (+ chip count for attachments).
    const userBubbleText = attachments.length > 0
      ? (text
          ? `📎 ${attachments.length} file${attachments.length > 1 ? 's' : ''} attached\n\n${text}`
          : `📎 ${attachments.length} file${attachments.length > 1 ? 's' : ''} attached`)
      : text

    const next: Msg[] = [...messages, { role: 'user', content: fullContent }]
    // Show friendly version in the UI but send full content to the API
    setMessages(prev => [...prev, { role: 'user', content: userBubbleText }])
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
            setMessages(m => {
              const c = [...m]
              c[c.length - 1] = { role: 'assistant', content: c[c.length - 1].content + ev.delta }
              return c
            })
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

  const canSend = (input.trim().length > 0 || attachments.length > 0) && !streaming

  return (
    <div className="flex flex-col h-full min-h-0">
      {/* Messages */}
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
            <div className={`max-w-[85%] rounded-2xl px-3.5 py-2.5 text-[15px] leading-relaxed whitespace-pre-wrap ${
              m.role === 'user' ? 'bg-[#D97757] text-white' : 'bg-[#2d2c29] text-[#e8e3db] shadow-sm'
            }`}>
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
            {error.includes('Settings') && (
              <a href="/settings" className="underline shrink-0 inline-flex items-center">
                Settings <ArrowUpRight size={12} />
              </a>
            )}
          </div>
        )}
      </div>

      {/* Composer */}
      <div className="border-t border-black/10 bg-[#30302E] px-2.5 pt-2 pb-2.5 shrink-0 flex flex-col gap-2">
        {/* Attachment chips — shown above the text input */}
        {attachments.length > 0 && (
          <div className="nodrag nowheel flex gap-2 overflow-x-auto pb-0.5">
            {attachments.map(a => (
              <AttachmentChip key={a.id} a={a} onRemove={() => removeAttachment(a.id)} />
            ))}
          </div>
        )}
        <div className="flex items-end gap-2">
          <textarea
            value={input}
            onChange={e => setInput(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send() } }}
            onPointerDown={e => e.stopPropagation()}
            placeholder={attachments.length > 0 ? 'Add a message, or just send…' : 'Ask or instruct…'}
            rows={1}
            className="nodrag flex-1 resize-none bg-[#3d3d3a] text-[#F0EEE6] text-[15px] rounded-xl px-3.5 py-2.5 focus:outline-none focus:ring-1 focus:ring-[#D97757]/60 placeholder:text-[#F0EEE6]/35 max-h-28"
          />
          <button
            onClick={send}
            disabled={!canSend}
            className="nodrag p-2.5 rounded-xl bg-[#D97757] hover:bg-[#c56647] text-white disabled:opacity-40 shrink-0 transition-colors"
          >
            <Send size={16} />
          </button>
        </div>
      </div>
    </div>
  )
}
