'use client'

import { useState, useRef, useCallback, useEffect } from 'react'
import type { Board } from '@/lib/types'
import { updateBoardContent } from '@/app/actions'
import { parseDocTabs, serializeDocTabs, newDocTab, type DocTabs } from '@/lib/doctabs'
import { docTabsStore } from '@/lib/docTabsStore'

export default function TextBoardView({ board }: { board: Board }) {
  const [dt, setDt] = useState<DocTabs>(() => parseDocTabs(board.content, 'Page 1'))
  const [saveStatus, setSaveStatus] = useState<'idle' | 'saving' | 'saved'>('idle')
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const activeTab = dt.tabs.find(t => t.id === dt.active) ?? dt.tabs[0]

  const scheduleSave = useCallback((next: DocTabs) => {
    if (timerRef.current) clearTimeout(timerRef.current)
    setSaveStatus('saving')
    timerRef.current = setTimeout(async () => {
      await updateBoardContent(board.id, serializeDocTabs(next))
      setSaveStatus('saved')
      setTimeout(() => setSaveStatus('idle'), 1500)
    }, 600)
  }, [board.id])

  const mutate = useCallback((fn: (prev: DocTabs) => DocTabs, persist = true) => {
    setDt(prev => { const next = fn(prev); if (persist) scheduleSave(next); return next })
  }, [scheduleSave])

  // Publish tabs + wire handlers for the sidebar panel
  useEffect(() => { docTabsStore.publish(dt.tabs.map(t => ({ id: t.id, name: t.name })), dt.active, 'text') }, [dt])
  useEffect(() => {
    docTabsStore.setHandlers({
      select: id => mutate(prev => ({ ...prev, active: id }), false),
      add: () => mutate(prev => { const t = newDocTab(`Page ${prev.tabs.length + 1}`); return { tabs: [...prev.tabs, t], active: t.id } }),
      rename: (id, name) => mutate(prev => ({ ...prev, tabs: prev.tabs.map(t => t.id === id ? { ...t, name } : t) })),
      remove: id => mutate(prev => {
        if (prev.tabs.length <= 1) return prev
        const tabs = prev.tabs.filter(t => t.id !== id)
        return { tabs, active: prev.active === id ? tabs[0].id : prev.active }
      }),
    })
  }, [mutate])
  useEffect(() => () => docTabsStore.clear(), [])

  function handleChange(e: React.ChangeEvent<HTMLTextAreaElement>) {
    const value = e.target.value
    mutate(prev => ({ ...prev, tabs: prev.tabs.map(t => t.id === prev.active ? { ...t, body: value } : t) }))
  }

  return (
    <div className="h-full flex flex-col bg-white overflow-hidden">
      <div className="flex items-center justify-between px-16 py-3 border-b border-gray-100 shrink-0">
        <span className="text-sm font-medium text-gray-500">{board.name}{dt.tabs.length > 1 && <span className="text-gray-300"> · {activeTab?.name}</span>}</span>
        <span className={`text-xs transition-opacity duration-300 ${saveStatus === 'idle' ? 'opacity-0' : 'opacity-100'} text-gray-400`}>
          {saveStatus === 'saving' ? 'Saving…' : 'Saved'}
        </span>
      </div>
      <textarea
        key={activeTab?.id}
        value={activeTab?.body ?? ''}
        onChange={handleChange}
        placeholder="Start writing…"
        spellCheck
        className="flex-1 w-full max-w-2xl mx-auto px-16 py-10 text-gray-800 text-base leading-7 resize-none focus:outline-none placeholder:text-gray-300"
        style={{ fontFamily: 'Georgia, "Times New Roman", serif' }}
      />
    </div>
  )
}
