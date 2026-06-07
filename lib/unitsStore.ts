'use client'

import { useSyncExternalStore } from 'react'

// A "unit" is anything that can live on a free-mode board.
export type Unit = {
  id: string        // react-flow node id (e.g. "el-...", "list-...", "sub-...")
  kind: 'list' | 'card' | 'shape' | 'drawing' | 'text' | 'image' | 'subtab' | 'portal' | 'file' | 'link' | 'unknown'
  mode?: string     // board mode for subtab nodes (classic/text/folder/spreadsheet/trello)
  label: string
  opacity: number   // 0..1
  selected: boolean
  hidden: boolean
}

type Handlers = {
  select: (id: string) => void
  reorder: (orderedIdsTopFirst: string[]) => void
  setOpacity: (id: string, opacity: number) => void
  setHidden: (id: string, hidden: boolean) => void
  rename: (id: string, label: string) => void
  delete: (ids: string[]) => void
}

let units: Unit[] = []
let handlers: Handlers | null = null
const listeners = new Set<() => void>()
const emit = () => listeners.forEach(l => l())

// Panel selection — shared between UnitsPanel and FreeBoardView
let panelSel: Set<string> = new Set()
const selListeners = new Set<() => void>()
const emitSel = () => selListeners.forEach(l => l())

export const unitsStore = {
  publish(u: Unit[]) {
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
  setHidden(id: string, hidden: boolean) { handlers?.setHidden(id, hidden) },
  rename(id: string, label: string) { handlers?.rename(id, label) },
  delete(ids: string[]) { handlers?.delete(ids) },

  getPanelSel: () => panelSel,
  setPanelSel(next: Set<string>) { panelSel = next; emitSel() },
  subscribePanelSel(l: () => void) { selListeners.add(l); return () => { selListeners.delete(l) } },
}

export function useUnits(): Unit[] {
  return useSyncExternalStore(unitsStore.subscribe, unitsStore.get, () => units)
}

export function usePanelSel(): Set<string> {
  return useSyncExternalStore(unitsStore.subscribePanelSel, unitsStore.getPanelSel, () => panelSel)
}
