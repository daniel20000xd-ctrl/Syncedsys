'use client'

import { useSyncExternalStore } from 'react'

// Bridges the active folder board view and the sidebar so a folder's contents
// (sub-folders + files) show up as units in the dashboard.
export type FolderUnit = { id: string; name: string; kind: 'folder' | 'file'; mode?: string }
type Handlers = { open: (id: string, kind: 'folder' | 'file') => void }

let units: FolderUnit[] = []
let handlers: Handlers | null = null
const listeners = new Set<() => void>()
const emit = () => listeners.forEach(l => l())

export const folderUnitsStore = {
  publish(u: FolderUnit[]) {
    if (JSON.stringify(u) === JSON.stringify(units)) return
    units = u
    emit()
  },
  clear() { if (units.length) { units = []; handlers = null; emit() } },
  get: () => units,
  subscribe(l: () => void) { listeners.add(l); return () => { listeners.delete(l) } },
  setHandlers(h: Handlers | null) { handlers = h },
  open(id: string, kind: 'folder' | 'file') { handlers?.open(id, kind) },
}

export function useFolderUnits(): FolderUnit[] {
  return useSyncExternalStore(folderUnitsStore.subscribe, folderUnitsStore.get, () => units)
}
