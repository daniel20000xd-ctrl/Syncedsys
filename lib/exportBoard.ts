// Client-safe board-export helpers: types, the "soft units" markdown renderer,
// and filename/path sanitizers. NO server-only imports (so it can be imported
// from both client components and the server-side ZIP builder in lib/exportZip.ts).
//
// "Soft units" = everything on a board that isn't a standalone file: text notes,
// link previews, lists/cards, and text-mode pages. These are rolled into a single
// markdown file per board. Standalone file units (textfile/pdf/anything with an
// R2 storagePath) are emitted as real files by the ZIP builder, not here.

import { parseDocTabs } from './doctabs'

export type ExportCard = {
  title: string
  description: string | null
  done: boolean
  deadline: string | null
  position: number
}

export type ExportList = {
  name: string
  position: number
  cards: ExportCard[]
}

export type ExportElement = {
  type: string
  data: Record<string, unknown>
}

export type ExportBoardData = {
  id: string
  name: string
  mode: 'classic' | 'trello' | 'text' | 'folder'
  content: string | null
  elements: ExportElement[]
  lists: ExportList[]
  children: ExportBoardData[]
}

// An element is a standalone FILE (emitted as its own file in the ZIP) when it is
// a textfile/pdf, or when it carries an R2 storagePath (images, future blobs).
// Everything else is "soft" content that goes into the board's markdown file.
export function isFileUnit(el: ExportElement): boolean {
  if (el.type === 'textfile' || el.type === 'pdf') return true
  return typeof el.data?.storagePath === 'string' && (el.data.storagePath as string).length > 0
}

function h(level: number, text: string) {
  return '#'.repeat(level) + ' ' + text
}

function renderTrelloLists(lists: ExportList[], headingLevel: number): string[] {
  const lines: string[] = []
  const sorted = [...lists].sort((a, b) => a.position - b.position)
  for (const list of sorted) {
    lines.push(h(headingLevel, list.name || 'Untitled list'), '')
    const cards = [...list.cards].sort((a, b) => a.position - b.position)
    for (const card of cards) {
      lines.push(`- ${card.done ? '[x]' : '[ ]'} ${card.title || '(untitled)'}`)
      if (card.description?.trim()) {
        lines.push('  ' + card.description.trim().replace(/\n/g, '\n  '))
      }
      if (card.deadline) lines.push(`  _Due: ${card.deadline.slice(0, 10)}_`)
    }
    if (!cards.length) lines.push('_(no cards)_')
    lines.push('')
  }
  return lines
}

// Render a single board's SOFT units as markdown. Returns '' when the board has
// no soft content (e.g. a pure folder of files), so the caller can skip writing
// an empty markdown file. Folder files (textfile/pdf) are intentionally excluded.
export function renderBoardSoftUnits(board: ExportBoardData): string {
  const lines: string[] = [h(1, board.name || 'Untitled'), '']
  const start = lines.length

  if (board.mode === 'text') {
    const dt = parseDocTabs(board.content)
    for (let i = 0; i < dt.tabs.length; i++) {
      const tab = dt.tabs[i]
      if (dt.tabs.length > 1) lines.push(h(2, tab.name || `Page ${i + 1}`), '')
      if (tab.body.trim()) lines.push(tab.body.trim(), '')
      if (i < dt.tabs.length - 1) lines.push('---', '')
    }
  }

  // Lists/cards exist on trello boards (and may linger on classic boards switched
  // from trello). Always render them when present.
  if (board.lists.length) {
    lines.push(...renderTrelloLists(board.lists, 2))
  }

  // Text notes (classic canvas).
  const notes = board.elements.filter(e => e.type === 'text')
  const noteBodies = notes
    .map(e => String((e.data as { content?: string }).content ?? '').trim())
    .filter(Boolean)
  if (noteBodies.length) {
    lines.push(h(2, 'Notes'), '')
    lines.push(noteBodies.join('\n\n---\n\n'), '')
  }

  // Link previews.
  const links = board.elements.filter(e => e.type === 'url_preview')
  const linkLines = links
    .map(e => e.data as { url?: string; title?: string; domain?: string })
    .filter(d => !!d.url)
    .map(d => `- [${d.title?.trim() || d.domain || d.url}](${d.url})`)
  if (linkLines.length) {
    lines.push(h(2, 'Links'), '', ...linkLines, '')
  }

  // Canvas items that can't be represented as text/files (shapes, drawings,
  // connections, …) are omitted — surface the count so the export is honest.
  const otherCount = board.elements.filter(
    e => e.type !== 'text' && e.type !== 'url_preview' && !isFileUnit(e),
  ).length
  if (otherCount) {
    lines.push(`_(${otherCount} canvas item${otherCount === 1 ? '' : 's'} — shapes, drawings, or other non-text units — are not included in this export.)_`, '')
  }

  // Nothing beyond the H1 heading → treat as empty.
  if (lines.length === start) return ''
  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n'
}

// Windows reserved device names — illegal as a file/dir basename on extraction.
const WIN_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i

// Sanitize a string into one safe path SEGMENT (a single file/folder name).
// Handles path separators, traversal, control chars, dot/space edges, length,
// surrogate-pair splitting, and Windows reserved device names — so the entry
// name in the ZIP matches what the OS will actually create on extraction.
export function safeSegment(name: string, fallback = 'untitled'): string {
  let s = (name ?? '').replace(/[/\\]+/g, '-').replace(/[\x00-\x1f<>:"|?*]+/g, '').trim()
  s = s.replace(/^\.+/, '') // no leading dots
  // Truncate on a code-POINT boundary (Array.from splits by code point) so a
  // surrogate pair (emoji / astral char) is never cut in half.
  const cps = Array.from(s)
  if (cps.length > 120) s = cps.slice(0, 120).join('')
  // Re-strip trailing dots/spaces AFTER truncation (truncation can re-expose one).
  s = s.replace(/[. ]+$/, '')
  if (!s || s === '.' || s === '..') return fallback
  // Neutralize reserved device names (basename before the first dot).
  if (WIN_RESERVED.test(s.split('.')[0])) s = '_' + s
  return s
}

// Sanitize a board name into a ZIP download filename (no extension).
export function boardExportFilename(name: string): string {
  return safeSegment(name, 'board')
}

// Pick a unique name within a directory, appending " (2)", " (3)", … on collision.
// Comparison is case-insensitive to be safe on case-insensitive filesystems.
export function uniqueInDir(used: Set<string>, desired: string): string {
  const dot = desired.lastIndexOf('.')
  const base = dot > 0 ? desired.slice(0, dot) : desired
  const ext = dot > 0 ? desired.slice(dot) : ''
  let candidate = desired
  let n = 2
  while (used.has(candidate.toLowerCase())) {
    candidate = `${base} (${n})${ext}`
    n++
  }
  used.add(candidate.toLowerCase())
  return candidate
}
