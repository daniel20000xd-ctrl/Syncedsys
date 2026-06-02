'use client'

import { useSyncExternalStore } from 'react'

// Bridges the active text/spreadsheet board view and the sidebar doc-tabs panel.
export type DocTabMeta = { id: string; name: string }
type Handlers = {
  select: (id: string) => void
  add: () => void
  rename: (id: string, name: string) => void
  remove: (id: string) => void
}
type State = { tabs: DocTabMeta[]; active: string | null; kind: 'text' | 'spreadsheet' | null }

let state: State = { tabs: [], active: null, kind: null }
let handlers: Handlers | null = null
const listeners = new Set<() => void>()
const emit = () => listeners.forEach(l => l())

export const docTabsStore = {
  publish(tabs: DocTabMeta[], active: string | null, kind: State['kind']) {
    const next = { tabs, active, kind }
    if (JSON.stringify(next) === JSON.stringify(state)) return
    state = next
    emit()
  },
  clear() { if (state.tabs.length || state.kind) { state = { tabs: [], active: null, kind: null }; handlers = null; emit() } },
  get: () => state,
  subscribe(l: () => void) { listeners.add(l); return () => { listeners.delete(l) } },
  setHandlers(h: Handlers | null) { handlers = h },
  select(id: string) { handlers?.select(id) },
  add() { handlers?.add() },
  rename(id: string, name: string) { handlers?.rename(id, name) },
  remove(id: string) { handlers?.remove(id) },
}

export function useDocTabs(): State {
  return useSyncExternalStore(docTabsStore.subscribe, docTabsStore.get, () => state)
}
