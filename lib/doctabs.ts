// Multiple named "pages" inside one board, stored in boards.content.
// Backward compatible: legacy raw content becomes the body of a single default tab.

export type DocTab = { id: string; name: string; body: string }
export type DocTabs = { tabs: DocTab[]; active: string }

function uid() { return Math.random().toString(36).slice(2, 10) }

export function parseDocTabs(content: string | null | undefined, defaultName = 'Page 1'): DocTabs {
  if (content) {
    try {
      const o = JSON.parse(content)
      if (o && o.__doctabs && Array.isArray(o.tabs) && o.tabs.length) {
        const tabs: DocTab[] = o.tabs.map((t: { id?: unknown; name?: unknown; body?: unknown }) => ({
          id: String(t.id ?? uid()),
          name: String(t.name ?? 'Untitled'),
          body: typeof t.body === 'string' ? t.body : '',
        }))
        const active = tabs.some(t => t.id === o.active) ? String(o.active) : tabs[0].id
        return { tabs, active }
      }
    } catch { /* legacy raw content */ }
  }
  const id = uid()
  return { tabs: [{ id, name: defaultName, body: content ?? '' }], active: id }
}

export function serializeDocTabs(dt: DocTabs): string {
  return JSON.stringify({ __doctabs: true, tabs: dt.tabs, active: dt.active })
}

export function activeDocBody(content: string | null | undefined): string {
  const dt = parseDocTabs(content)
  return dt.tabs.find(t => t.id === dt.active)?.body ?? dt.tabs[0]?.body ?? ''
}

// Replace the active tab's body, returning serialized content (for editing a
// doc-tabbed board from outside, e.g. a portal).
export function withActiveBody(content: string | null | undefined, body: string): string {
  const dt = parseDocTabs(content)
  return serializeDocTabs({ ...dt, tabs: dt.tabs.map(t => t.id === dt.active ? { ...t, body } : t) })
}

export function newDocTab(name: string, body = ''): DocTab { return { id: uid(), name, body } }
