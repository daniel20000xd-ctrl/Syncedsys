// Client-safe board-export helpers. No server-only imports, no React.
// Converts the structured data returned by exportBoardData() into a
// human-readable markdown document for download.

import { parseDocTabs } from './doctabs'

export type ExportCard = {
  title: string
  description: string | null
  done: boolean
  deadline: string | null
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

// ── Markdown renderer ─────────────────────────────────────────────────────────

function h(level: number, text: string) {
  return '#'.repeat(level) + ' ' + text
}

function renderFolderTree(board: ExportBoardData, level: number, pathPrefix: string): string[] {
  const lines: string[] = []
  const files = board.elements.filter(e => e.type === 'textfile')

  for (const el of files) {
    const d = el.data as { name?: string; content?: string }
    const name = d.name ?? 'Untitled'
    const fullPath = pathPrefix ? `${pathPrefix}/${name}` : name
    lines.push(h(level, fullPath), '')
    const body = d.content?.trim() ?? ''
    if (body) {
      lines.push('```', body, '```', '')
    } else {
      lines.push('*(empty)*', '')
    }
  }

  for (const child of board.children) {
    const childPath = pathPrefix ? `${pathPrefix}/${child.name}` : child.name
    lines.push(...renderFolderTree(child, level, childPath))
  }

  return lines
}

export function exportBoardAsMarkdown(board: ExportBoardData): string {
  const lines: string[] = [h(1, board.name), '']

  if (board.mode === 'text') {
    const dt = parseDocTabs(board.content)
    for (let i = 0; i < dt.tabs.length; i++) {
      const tab = dt.tabs[i]
      if (dt.tabs.length > 1) lines.push(h(2, tab.name), '')
      if (tab.body.trim()) lines.push(tab.body.trim(), '')
      if (i < dt.tabs.length - 1) lines.push('---', '')
    }
  } else if (board.mode === 'trello') {
    const sorted = [...board.lists].sort((a, b) => a.position - b.position)
    for (const list of sorted) {
      lines.push(h(2, list.name), '')
      const cards = [...list.cards].sort((a: ExportCard & { position?: number }, b: ExportCard & { position?: number }) => (a.position ?? 0) - (b.position ?? 0))
      for (const card of cards) {
        const check = card.done ? '[x]' : '[ ]'
        lines.push(`- ${check} **${card.title}**`)
        if (card.description?.trim()) {
          lines.push(`  ${card.description.trim().replace(/\n/g, '\n  ')}`)
        }
        if (card.deadline) lines.push(`  *Due: ${card.deadline.slice(0, 10)}*`)
      }
      lines.push('')
    }
  } else if (board.mode === 'folder') {
    const treeLines = renderFolderTree(board, 2, '')
    lines.push(...treeLines)
  } else {
    // classic — extract readable content
    const textNotes = board.elements.filter(e => e.type === 'text')
    const links = board.elements.filter(e => e.type === 'url_preview')
    const textFiles = board.elements.filter(e => e.type === 'textfile')
    const listsOnCanvas = board.lists

    if (textNotes.length) {
      lines.push(h(2, 'Notes'), '')
      for (const el of textNotes) {
        const body = ((el.data as { content?: string }).content ?? '').trim()
        if (body) lines.push(body, '', '---', '')
      }
      // trim trailing ---
      while (lines[lines.length - 1] === '---' || lines[lines.length - 1] === '') lines.pop()
      lines.push('')
    }

    if (links.length) {
      lines.push(h(2, 'Links'), '')
      for (const el of links) {
        const d = el.data as { url?: string; title?: string; domain?: string }
        const label = d.title?.trim() || d.domain || d.url || 'Link'
        if (d.url) lines.push(`- [${label}](${d.url})`)
      }
      lines.push('')
    }

    if (listsOnCanvas.length) {
      lines.push(h(2, 'Lists'), '')
      const sorted = [...listsOnCanvas].sort((a, b) => a.position - b.position)
      for (const list of sorted) {
        lines.push(h(3, list.name), '')
        const cards = [...list.cards].sort((a: ExportCard & { position?: number }, b: ExportCard & { position?: number }) => (a.position ?? 0) - (b.position ?? 0))
        for (const card of cards) {
          lines.push(`- ${card.done ? '[x]' : '[ ]'} ${card.title}`)
        }
        lines.push('')
      }
    }

    if (textFiles.length) {
      lines.push(h(2, 'Files'), '')
      for (const el of textFiles) {
        const d = el.data as { name?: string; content?: string }
        if (d.name) lines.push(h(3, d.name), '')
        const body = d.content?.trim() ?? ''
        if (body) lines.push('```', body, '```', '')
      }
    }

    if (!textNotes.length && !links.length && !listsOnCanvas.length && !textFiles.length) {
      lines.push('*(no text content on this canvas)*', '')
    }
  }

  return lines.join('\n')
}

export function boardExportFilename(name: string): string {
  return name.trim().replace(/[<>:"/\\|?*\n\r]+/g, '-').replace(/\s+/g, '_') || 'board'
}
