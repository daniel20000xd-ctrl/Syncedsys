import { googleFetch } from '@/lib/google/client'

// Google Docs (read-only) for the shared ecosystem. The authorized scope is
// documents.readonly, so this module only reads and renders — no write helpers
// until the scope is expanded. Every call goes through googleFetch.

const DOCS_BASE = 'https://docs.googleapis.com/v1/documents'

// Google Docs uses a vertical-tab (U+000B) for a soft line break within a
// paragraph. Built via fromCharCode to keep a control char out of the source.
const SOFT_BREAK = new RegExp(String.fromCharCode(11), 'g')

// ── Minimal typed model of the Docs API JSON we consume ──────────────────────
type RgbColor = { red?: number; green?: number; blue?: number }
type DocsColor = { color?: { rgbColor?: RgbColor } }
type Dimension = { magnitude?: number; unit?: string }
type TextStyle = {
  bold?: boolean
  italic?: boolean
  underline?: boolean
  strikethrough?: boolean
  fontSize?: Dimension
  foregroundColor?: DocsColor
  link?: { url?: string }
}
type TextRun = { content?: string; textStyle?: TextStyle }
type Bullet = { listId?: string; nestingLevel?: number }
type ParagraphStyle = { namedStyleType?: string; alignment?: string }
type ParagraphElement = {
  textRun?: TextRun
  horizontalRule?: object
  pageBreak?: object
}
type Paragraph = { elements?: ParagraphElement[]; paragraphStyle?: ParagraphStyle; bullet?: Bullet }
type TableCell = { content?: StructuralElement[] }
type TableRow = { tableCells?: TableCell[] }
type Table = { tableRows?: TableRow[] }
type StructuralElement = {
  paragraph?: Paragraph
  table?: Table
  sectionBreak?: object
}
type NestingLevel = { glyphType?: string }
type DocsList = { listProperties?: { nestingLevels?: NestingLevel[] } }
export type DocsDocument = {
  documentId?: string
  title?: string
  body?: { content?: StructuralElement[] }
  lists?: Record<string, DocsList>
}

export async function getDocument(userId: string, documentId: string): Promise<DocsDocument> {
  const res = await googleFetch(userId, `${DOCS_BASE}/${encodeURIComponent(documentId)}`)
  if (!res.ok) {
    const detail = await res.text().catch(() => '')
    throw new Error(`Google Docs GET failed (${res.status}): ${detail}`)
  }
  return (await res.json()) as DocsDocument
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}
function escapeAttr(s: string): string {
  return escapeHtml(s).replace(/"/g, '&quot;')
}

function colorToHex(c?: DocsColor): string | null {
  const rgb = c?.color?.rgbColor
  if (!rgb) return null
  const ch = (v?: number) => Math.round((v ?? 0) * 255).toString(16).padStart(2, '0')
  return `#${ch(rgb.red)}${ch(rgb.green)}${ch(rgb.blue)}`
}

const HEADING_TAGS: Record<string, string> = {
  TITLE: 'h1', SUBTITLE: 'p',
  HEADING_1: 'h1', HEADING_2: 'h2', HEADING_3: 'h3',
  HEADING_4: 'h4', HEADING_5: 'h5', HEADING_6: 'h6',
}

function isOrdered(doc: DocsDocument, listId: string, level: number): boolean {
  const gt = doc.lists?.[listId]?.listProperties?.nestingLevels?.[level]?.glyphType
  return !!gt && ['DECIMAL', 'ZERO_DECIMAL', 'ALPHA', 'UPPER_ALPHA', 'ROMAN', 'UPPER_ROMAN'].includes(gt)
}

function alignStyle(p: Paragraph): string {
  const a = p.paragraphStyle?.alignment
  if (a === 'CENTER') return ' style="text-align:center"'
  if (a === 'END') return ' style="text-align:right"'
  if (a === 'JUSTIFIED') return ' style="text-align:justify"'
  return ''
}

// Render a paragraph's inline runs to HTML (no block wrapper).
function renderRuns(p: Paragraph): string {
  let html = ''
  for (const el of p.elements ?? []) {
    const tr = el.textRun
    if (!tr || tr.content == null) continue
    let text = escapeHtml(tr.content).replace(/\n/g, '').replace(SOFT_BREAK, '<br/>')
    if (!text) continue
    const ts = tr.textStyle ?? {}
    if (ts.link?.url) text = `<a href="${escapeAttr(ts.link.url)}" target="_blank" rel="noopener noreferrer">${text}</a>`
    if (ts.bold) text = `<strong>${text}</strong>`
    if (ts.italic) text = `<em>${text}</em>`
    if (ts.underline && !ts.link) text = `<u>${text}</u>`
    if (ts.strikethrough) text = `<s>${text}</s>`
    const styles: string[] = []
    const hex = colorToHex(ts.foregroundColor)
    if (hex && hex !== '#000000') styles.push(`color:${hex}`)
    if (ts.fontSize?.magnitude) styles.push(`font-size:${ts.fontSize.magnitude}pt`)
    if (styles.length) text = `<span style="${styles.join(';')}">${text}</span>`
    html += text
  }
  return html
}

function renderTable(t: Table): string {
  let html = '<table><tbody>'
  for (const row of t.tableRows ?? []) {
    html += '<tr>'
    for (const cell of row.tableCells ?? []) {
      const inner = (cell.content ?? [])
        .map(ce => (ce.paragraph ? renderRuns(ce.paragraph) : ''))
        .filter(Boolean)
        .join('<br/>')
      html += `<td>${inner}</td>`
    }
    html += '</tr>'
  }
  return html + '</tbody></table>'
}

// Convert the Docs API JSON tree into clean, self-contained HTML.
export function renderDocumentToHtml(document: DocsDocument): string {
  const out: string[] = []
  const stack: { listId: string; level: number; ordered: boolean }[] = []

  const closeLists = () => { while (stack.length) out.push(stack.pop()!.ordered ? '</ol>' : '</ul>') }
  function adjustLists(listId: string, level: number) {
    while (stack.length) {
      const top = stack[stack.length - 1]
      if (top.level > level || (top.level === level && top.listId !== listId)) out.push(stack.pop()!.ordered ? '</ol>' : '</ul>')
      else break
    }
    while (!stack.length || stack[stack.length - 1].level < level) {
      const lvl = stack.length ? stack[stack.length - 1].level + 1 : 0
      const ord = isOrdered(document, listId, lvl)
      out.push(ord ? '<ol>' : '<ul>')
      stack.push({ listId, level: lvl, ordered: ord })
    }
  }

  for (const el of document.body?.content ?? []) {
    if (el.table) { closeLists(); out.push(renderTable(el.table)); continue }
    if (!el.paragraph) continue // sectionBreak / other → ignored
    const p = el.paragraph

    const hasRule = (p.elements ?? []).some(e => e.horizontalRule)
    const hasPageBreak = (p.elements ?? []).some(e => e.pageBreak)
    if (hasPageBreak) { closeLists(); out.push('<hr class="page-break"/>') }
    if (hasRule) { closeLists(); out.push('<hr/>'); continue }

    const inner = renderRuns(p)

    if (p.bullet?.listId) {
      adjustLists(p.bullet.listId, p.bullet.nestingLevel ?? 0)
      out.push(`<li${alignStyle(p)}>${inner}</li>`)
      continue
    }

    closeLists()
    const named = p.paragraphStyle?.namedStyleType ?? 'NORMAL_TEXT'
    const tag = HEADING_TAGS[named] ?? 'p'
    const cls = named === 'SUBTITLE' ? ' class="subtitle"' : ''
    if (!inner.trim() && tag === 'p') { out.push('<p class="empty"><br/></p>'); continue }
    out.push(`<${tag}${cls}${alignStyle(p)}>${inner}</${tag}>`)
  }
  closeLists()
  return out.join('\n')
}

// Flat plain text of the whole document (used for word count and tools).
export function documentPlainText(document: DocsDocument): string {
  const parts: string[] = []
  const paraText = (p: Paragraph) =>
    (p.elements ?? []).map(e => e.textRun?.content ?? '').join('').replace(SOFT_BREAK, ' ').replace(/\n/g, '').trim()
  for (const el of document.body?.content ?? []) {
    if (el.paragraph) {
      const t = paraText(el.paragraph)
      if (t) parts.push(t)
    } else if (el.table) {
      for (const row of el.table.tableRows ?? []) {
        const cells = (row.tableCells ?? []).map(cell =>
          (cell.content ?? []).map(ce => (ce.paragraph ? paraText(ce.paragraph) : '')).filter(Boolean).join(' '),
        )
        if (cells.some(Boolean)) parts.push(cells.join(' | '))
      }
    }
  }
  return parts.join('\n')
}

function countWords(text: string): number {
  return text.split(/\s+/).filter(Boolean).length
}

export function documentWordCount(document: DocsDocument): number {
  return countWords(documentPlainText(document))
}

// Plain-text summary with structure preserved, formatted for Claude. Heading
// hierarchy as markdown #, list items, tables as readable rows, plus the title
// and total word count. Capped to stay within a sane token budget.
export async function formatDocsContext(userId: string, documentId: string): Promise<string> {
  const doc = await getDocument(userId, documentId)
  const lines: string[] = []
  const paraText = (p: Paragraph) =>
    (p.elements ?? []).map(e => e.textRun?.content ?? '').join('').replace(SOFT_BREAK, ' ').replace(/\n/g, '').trim()

  const HEAD_PREFIX: Record<string, string> = {
    TITLE: '# ', HEADING_1: '# ', HEADING_2: '## ', HEADING_3: '### ',
    HEADING_4: '#### ', HEADING_5: '##### ', HEADING_6: '###### ',
  }

  for (const el of doc.body?.content ?? []) {
    if (el.table) {
      for (const row of el.table.tableRows ?? []) {
        const cells = (row.tableCells ?? []).map(cell =>
          (cell.content ?? []).map(ce => (ce.paragraph ? paraText(ce.paragraph) : '')).filter(Boolean).join(' '),
        )
        lines.push(`| ${cells.join(' | ')} |`)
      }
      lines.push('')
      continue
    }
    if (!el.paragraph) continue
    const p = el.paragraph
    if ((p.elements ?? []).some(e => e.horizontalRule || e.pageBreak)) { lines.push('---'); continue }
    const t = paraText(p)
    if (!t) continue
    const named = p.paragraphStyle?.namedStyleType ?? 'NORMAL_TEXT'
    if (p.bullet?.listId) lines.push(`${'  '.repeat(p.bullet.nestingLevel ?? 0)}- ${t}`)
    else lines.push(`${HEAD_PREFIX[named] ?? ''}${t}`)
  }

  const wc = documentWordCount(doc)
  const header = [
    `Google Doc: "${doc.title ?? 'Untitled'}"`,
    `Word count: ${wc}`,
    '',
  ].join('\n')

  let body = lines.join('\n')
  if (body.length > 7000) body = body.slice(0, 7000) + '\n… (truncated)'
  return header + body
}
