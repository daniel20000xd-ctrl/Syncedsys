'use client'

import { useSyncExternalStore } from 'react'

// A "unit" is anything that can live on a free-mode board.
export type Unit = {
  id: string        // react-flow node id (e.g. "el-...", "list-...", "sub-...")
  kind: 'list' | 'card' | 'shape' | 'drawing' | 'text' | 'image' | 'subtab' | 'unknown'
  label: string
  opacity: number   // 0..1
  selected: boolean
}

type Handlers = {
  select: (id: string) => void
  reorder: (orderedIdsTopFirst: string[]) => void
  setOpacity: (id: string, opacity: number) => void
}

let units: Unit[] = []
let handlers: Handlers | null = null
const listeners = new Set<() => void>()
const emit = () => listeners.forEach(l => l())

export const unitsStore = {
  publish(u: Unit[]) {
    // avoid needless re-renders if nothing meaningful changed
    if (JSON.stringify(u) === JSON.stringify(units)) return
    units = u
    emit()
  },
  clear() { if (units.length) { units = []; emit() } },
  get: () => units,
  subscribe(l: () => void) { listeners.add(l); return () => { listeners.delete(l) } },
  setHandlers(h: Handlers | null) { handlers = h },
  select(id: string) { handlers?.select(id) },
  reorder(ids: string[]) { handlers?.reorder(ids) },
  setOpacity(id: string, o: number) { handlers?.setOpacity(id, o) },
}

export function useUnits(): Unit[] {
  return useSyncExternalStore(unitsStore.subscribe, unitsStore.get, () => units)
}
