'use client'

import { useState, useRef, useCallback } from 'react'
import { BookOpen, ChevronDown, ChevronUp, PenLine } from 'lucide-react'
import { createClient } from '@/lib/supabase/client'
import ReactMarkdown from 'react-markdown'

interface Props {
  boardId: string
  initialReadme: string | null
  /** When true, renders with white text for placement on dark/coloured backgrounds. */
  onDark?: boolean
  onSave?: (markdown: string) => void
}

const COLLAPSED_H = 38
const EXPANDED_H = 280

export default function BoardReadme({ boardId, initialReadme, onDark = false, onSave }: Props) {
  const [open, setOpen] = useState(false)
  const [value, setValue] = useState(initialReadme ?? '')
  const [tab, setTab] = useState<'edit' | 'preview'>('edit')
  const [saveStatus, setSaveStatus] = useState<'idle' | 'dirty' | 'saving' | 'saved' | 'error'>('idle')
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const hasContent = value.trim().length > 0
  const firstLine = value.split('\n')[0].replace(/^#+\s*/, '')
  const previewText = firstLine.length > 80 ? firstLine.slice(0, 80) + '…' : firstLine || 'README'

  const scheduleSave = useCallback((next: string) => {
    if (timerRef.current) clearTimeout(timerRef.current)
    timerRef.current = setTimeout(async () => {
      setSaveStatus('saving')
      const supabase = createClient()
      const { error } = await supabase
        .from('boards')
        .update({ readme_md: next })
        .eq('id', boardId)
      if (error) {
        setSaveStatus('error')
      } else {
        setSaveStatus('saved')
        onSave?.(next)
        setTimeout(() => setSaveStatus('idle'), 1500)
      }
    }, 800)
  }, [boardId, onSave])

  function handleChange(e: React.ChangeEvent<HTMLTextAreaElement>) {
    const v = e.target.value
    setValue(v)
    setSaveStatus('dirty')
    scheduleSave(v)
  }

  const stripBg = onDark ? 'rgba(0,0,0,0.15)' : 'rgba(0,0,0,0.04)'
  const stripBorder = onDark ? 'rgba(0,0,0,0.22)' : 'rgba(0,0,0,0.07)'
  const textColor = onDark ? 'rgba(255,255,255,0.65)' : 'rgba(0,0,0,0.5)'
  const iconColor = onDark ? 'rgba(255,255,255,0.4)' : 'rgba(0,0,0,0.3)'

  const saveLabel =
    saveStatus === 'saving' ? 'Saving…'
    : saveStatus === 'saved' ? 'Saved'
    : saveStatus === 'error' ? 'Error'
    : saveStatus === 'dirty' ? '●'
    : null

  return (
    <div
      className="shrink-0 overflow-hidden"
      style={{
        height: open ? EXPANDED_H : COLLAPSED_H,
        transition: 'height 200ms ease',
      }}
    >
      {!open ? (
        <div
          onClick={() => setOpen(true)}
          className="flex items-center gap-2 h-full px-4 cursor-pointer select-none"
          style={{ background: stripBg, borderBottom: `1px solid ${stripBorder}` }}
        >
          {hasContent ? (
            <>
              <BookOpen size={13} style={{ color: iconColor, flexShrink: 0 }} />
              <span className="text-xs truncate flex-1" style={{ color: textColor }}>{previewText}</span>
              <ChevronDown size={13} style={{ color: iconColor, flexShrink: 0 }} />
            </>
          ) : (
            <>
              <PenLine size={13} style={{ color: iconColor, flexShrink: 0 }} />
              <span className="text-xs italic" style={{ color: iconColor }}>
                Add a README — give this board context
              </span>
            </>
          )}
        </div>
      ) : (
        <div
          className="flex flex-col h-full"
          style={{ background: 'white', borderBottom: '1px solid rgba(0,0,0,0.1)' }}
        >
          {/* Tab bar */}
          <div
            className="flex items-center shrink-0 px-2 border-b"
            style={{ height: 34, borderColor: 'rgba(0,0,0,0.07)' }}
          >
            {(['edit', 'preview'] as const).map(t => (
              <button
                key={t}
                onClick={() => setTab(t)}
                className="px-3 capitalize"
                style={{
                  height: 34,
                  fontSize: 12,
                  fontWeight: 500,
                  color: tab === t ? 'rgba(0,0,0,0.85)' : 'rgba(0,0,0,0.38)',
                  borderBottom: tab === t ? '2px solid rgba(0,0,0,0.75)' : '2px solid transparent',
                }}
              >
                {t}
              </button>
            ))}
            <div className="ml-auto flex items-center gap-2 pr-1">
              {saveLabel && (
                <span
                  style={{
                    fontSize: 11,
                    color:
                      saveStatus === 'error' ? '#dc2626'
                      : saveStatus === 'dirty' ? 'rgba(0,0,0,0.25)'
                      : 'rgba(0,0,0,0.35)',
                  }}
                >
                  {saveLabel}
                </span>
              )}
              <button
                onClick={() => setOpen(false)}
                className="flex items-center justify-center rounded hover:bg-black/5"
                style={{ width: 24, height: 24, color: 'rgba(0,0,0,0.4)' }}
                title="Close"
              >
                <ChevronUp size={14} />
              </button>
            </div>
          </div>
          {/* Content area */}
          <div className="flex-1 min-h-0 overflow-hidden flex flex-col">
            {tab === 'edit' ? (
              <textarea
                value={value}
                onChange={handleChange}
                placeholder="Write markdown here — describe what this board is for, how it's structured, or give context for Claude…"
                className="flex-1 resize-none p-4 focus:outline-none"
                style={{
                  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
                  fontSize: 13,
                  lineHeight: 1.6,
                  color: 'rgba(0,0,0,0.8)',
                  background: 'white',
                }}
              />
            ) : (
              <div
                className="flex-1 overflow-y-auto px-4 py-3"
                style={{ fontSize: 13, lineHeight: 1.6, color: 'rgba(0,0,0,0.8)' }}
              >
                {value.trim() ? (
                  <ReactMarkdown>{value}</ReactMarkdown>
                ) : (
                  <span style={{ color: 'rgba(0,0,0,0.3)', fontStyle: 'italic', fontSize: 12 }}>
                    Nothing to preview yet.
                  </span>
                )}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
