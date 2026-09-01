'use client'

import { useEffect, useRef, useState } from 'react'

type TodoItem = { id: string; text: string; done: boolean }
type TodoList = { name: string; items: TodoItem[] }

const STORAGE_KEY = 'syncedsys-admin-todos'
const DEFAULT_LISTS: TodoList[] = [
  { name: 'List 1', items: [] },
  { name: 'List 2', items: [] },
  { name: 'List 3', items: [] },
]

function uid() {
  return Math.random().toString(36).slice(2, 10)
}

export default function TodoLists() {
  const [lists, setLists] = useState<TodoList[]>(DEFAULT_LISTS)
  const [loaded, setLoaded] = useState(false)
  const [drafts, setDrafts] = useState(['', '', ''])
  const hydrating = useRef(true)

  // Load once on mount. Never touches the backend — purely this browser's
  // localStorage, per design (this feature is intentionally not wired to Supabase).
  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(STORAGE_KEY)
      if (raw) {
        const parsed = JSON.parse(raw)
        if (Array.isArray(parsed) && parsed.length === 3) setLists(parsed)
      }
    } catch { /* corrupt or inaccessible storage — fall back to defaults */ }
    hydrating.current = false
    setLoaded(true)
  }, [])

  // Persist on every change, skipping the initial load so we don't immediately
  // overwrite storage with the pre-hydration default state.
  useEffect(() => {
    if (hydrating.current) return
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(lists))
    } catch { /* storage unavailable (private mode, quota) — state still works in-memory */ }
  }, [lists])

  function renameList(index: number, name: string) {
    setLists(prev => prev.map((l, i) => (i === index ? { ...l, name } : l)))
  }

  function addItem(index: number) {
    const text = drafts[index].trim()
    if (!text) return
    setLists(prev =>
      prev.map((l, i) => (i === index ? { ...l, items: [...l.items, { id: uid(), text, done: false }] } : l))
    )
    setDrafts(prev => prev.map((d, i) => (i === index ? '' : d)))
  }

  function toggleItem(listIndex: number, itemId: string) {
    setLists(prev =>
      prev.map((l, i) =>
        i === listIndex
          ? { ...l, items: l.items.map(it => (it.id === itemId ? { ...it, done: !it.done } : it)) }
          : l
      )
    )
  }

  function deleteItem(listIndex: number, itemId: string) {
    setLists(prev =>
      prev.map((l, i) => (i === listIndex ? { ...l, items: l.items.filter(it => it.id !== itemId) } : l))
    )
  }

  if (!loaded) return null

  return (
    <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
      {lists.map((list, index) => (
        <div key={index} className="bg-white rounded-lg border border-gray-200 shadow-sm p-4 flex flex-col">
          <input
            value={list.name}
            onChange={e => renameList(index, e.target.value)}
            className="font-semibold text-gray-800 mb-3 w-full border-none outline-none focus:ring-1 focus:ring-blue-300 rounded px-1 -mx-1"
          />

          <ul className="space-y-1 mb-3 flex-1">
            {list.items.map(item => (
              <li key={item.id} className="flex items-center gap-2 group">
                <input
                  type="checkbox"
                  checked={item.done}
                  onChange={() => toggleItem(index, item.id)}
                  className="shrink-0"
                />
                <span className={`text-sm flex-1 ${item.done ? 'line-through text-gray-400' : 'text-gray-700'}`}>
                  {item.text}
                </span>
                <button
                  onClick={() => deleteItem(index, item.id)}
                  className="text-gray-300 hover:text-red-500 opacity-0 group-hover:opacity-100 text-xs px-1"
                  aria-label="Delete"
                >
                  ✕
                </button>
              </li>
            ))}
            {list.items.length === 0 && (
              <li className="text-sm text-gray-300 italic">Nothing yet</li>
            )}
          </ul>

          <form
            onSubmit={e => {
              e.preventDefault()
              addItem(index)
            }}
            className="flex gap-2"
          >
            <input
              value={drafts[index]}
              onChange={e => setDrafts(prev => prev.map((d, i) => (i === index ? e.target.value : d)))}
              placeholder="Add a to-do…"
              className="flex-1 min-w-0 border border-gray-200 rounded px-2 py-1 text-sm focus:outline-none focus:border-blue-400"
            />
            <button
              type="submit"
              className="text-sm bg-gray-100 hover:bg-gray-200 text-gray-700 rounded px-3 py-1"
            >
              Add
            </button>
          </form>
        </div>
      ))}
    </div>
  )
}
