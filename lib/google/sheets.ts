import { googleFetch } from '@/lib/google/client'

// Google Sheets operations for the shared ecosystem. Every call goes through
// googleFetch, which injects a valid access token and refreshes on 401.

const SHEETS_BASE = 'https://sheets.googleapis.com/v4/spreadsheets'

export type SheetTab = {
  sheetId: number
  title: string
  index: number
  rowCount: number
  columnCount: number
  frozenRowCount: number
  frozenColumnCount: number
}

export type SpreadsheetMeta = {
  title: string
  sheets: SheetTab[]
}

async function sheetsJson(
  userId: string,
  path: string,
  init?: RequestInit,
): Promise<Record<string, unknown> | null> {
  const res = await googleFetch(userId, `${SHEETS_BASE}${path}`, init)
  if (!res.ok) {
    const detail = await res.text().catch(() => '')
    throw new Error(`Google Sheets ${init?.method ?? 'GET'} ${path} failed (${res.status}): ${detail}`)
  }
  if (res.status === 204) return null
  const text = await res.text()
  return text ? (JSON.parse(text) as Record<string, unknown>) : null
}

function toTab(s: Record<string, unknown>): SheetTab {
  const p = (s.properties ?? {}) as Record<string, unknown>
  const g = (p.gridProperties ?? {}) as Record<string, unknown>
  return {
    sheetId: Number(p.sheetId ?? 0),
    title: String(p.title ?? 'Sheet'),
    index: Number(p.index ?? 0),
    rowCount: Number(g.rowCount ?? 0),
    columnCount: Number(g.columnCount ?? 0),
    frozenRowCount: Number(g.frozenRowCount ?? 0),
    frozenColumnCount: Number(g.frozenColumnCount ?? 0),
  }
}

export async function listSheets(userId: string, spreadsheetId: string): Promise<SheetTab[]> {
  const data = await sheetsJson(userId, `/${spreadsheetId}?fields=sheets.properties`)
  const sheets = (data?.sheets ?? []) as Array<Record<string, unknown>>
  return sheets.map(toTab).sort((a, b) => a.index - b.index)
}

export async function readSpreadsheetMetadata(userId: string, spreadsheetId: string): Promise<SpreadsheetMeta> {
  const data = await sheetsJson(userId, `/${spreadsheetId}?fields=properties.title,sheets.properties`)
  const props = (data?.properties ?? {}) as Record<string, unknown>
  const sheets = (data?.sheets ?? []) as Array<Record<string, unknown>>
  return {
    title: String(props.title ?? 'Untitled spreadsheet'),
    sheets: sheets.map(toTab).sort((a, b) => a.index - b.index),
  }
}

export async function readRange(userId: string, spreadsheetId: string, range: string): Promise<string[][]> {
  const data = await sheetsJson(userId, `/${spreadsheetId}/values/${encodeURIComponent(range)}`)
  return (data?.values ?? []) as string[][]
}

export async function writeRange(
  userId: string,
  spreadsheetId: string,
  range: string,
  values: (string | number)[][],
): Promise<Record<string, unknown> | null> {
  return sheetsJson(
    userId,
    `/${spreadsheetId}/values/${encodeURIComponent(range)}?valueInputOption=USER_ENTERED`,
    { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ values }) },
  )
}

// Append a single row to the end of a sheet's data (used by the sheets_add_row tool).
export async function appendRow(
  userId: string,
  spreadsheetId: string,
  sheetName: string,
  values: (string | number)[],
): Promise<Record<string, unknown> | null> {
  return sheetsJson(
    userId,
    `/${spreadsheetId}/values/${encodeURIComponent(sheetName)}:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`,
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ values: [values] }) },
  )
}

// Clear the values in a range (keeps formatting).
export async function clearRange(
  userId: string,
  spreadsheetId: string,
  range: string,
): Promise<Record<string, unknown> | null> {
  return sheetsJson(userId, `/${spreadsheetId}/values/${encodeURIComponent(range)}:clear`, { method: 'POST' })
}

// Reads cell formatting (bold, italic, colors, borders, alignment) for a range,
// returning the API's rowData array (one entry per row, each with a values array).
export async function readFormatting(
  userId: string,
  spreadsheetId: string,
  range: string,
): Promise<Array<Record<string, unknown>>> {
  const fields = 'sheets(data(rowData(values(effectiveFormat,userEnteredFormat))))'
  const data = await sheetsJson(
    userId,
    `/${spreadsheetId}?includeGridData=true&ranges=${encodeURIComponent(range)}&fields=${encodeURIComponent(fields)}`,
  )
  const sheets = (data?.sheets ?? []) as Array<Record<string, unknown>>
  const grid = (sheets[0]?.data ?? []) as Array<Record<string, unknown>>
  return (grid[0]?.rowData ?? []) as Array<Record<string, unknown>>
}

// Structural / formatting changes via the Sheets batchUpdate endpoint.
export async function batchUpdate(
  userId: string,
  spreadsheetId: string,
  requests: unknown[],
): Promise<Record<string, unknown> | null> {
  return sheetsJson(userId, `/${spreadsheetId}:batchUpdate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ requests }),
  })
}

function colName(i: number): string {
  let s = ''
  let n = i
  do {
    s = String.fromCharCode(65 + (n % 26)) + s
    n = Math.floor(n / 26) - 1
  } while (n >= 0)
  return s
}

// Plain-text summary of a spreadsheet's active sheet, capped to stay well under
// any token budget when fed into Claude's board context.
export async function formatSheetsContext(
  userId: string,
  spreadsheetId: string,
  activeSheet?: string,
): Promise<string> {
  const meta = await readSpreadsheetMetadata(userId, spreadsheetId)
  const sheet = (activeSheet && meta.sheets.find(s => s.title === activeSheet)) || meta.sheets[0]
  if (!sheet) return `Google Sheet "${meta.title}" has no sheets.`

  // Cap the read to a sane window so a huge sheet can't blow the context.
  const MAX_ROWS = 50
  const MAX_COLS = 20
  const lastCol = colName(Math.min(MAX_COLS, Math.max(1, sheet.columnCount || MAX_COLS)) - 1)
  const range = `'${sheet.title.replace(/'/g, "''")}'!A1:${lastCol}${MAX_ROWS}`

  let values: string[][] = []
  try {
    values = await readRange(userId, spreadsheetId, range)
  } catch {
    values = []
  }

  const lines: string[] = []
  lines.push(`Google Sheet: "${meta.title}"`)
  lines.push(`Sheets: ${meta.sheets.map(s => s.title).join(', ')}`)
  lines.push(`Active sheet: "${sheet.title}" (${sheet.rowCount}×${sheet.columnCount}${sheet.frozenRowCount ? `, ${sheet.frozenRowCount} frozen row(s)` : ''}).`)
  lines.push('')
  if (values.length === 0) {
    lines.push('(active sheet is empty in the first cells)')
  } else {
    lines.push(`First ${values.length} rows (cells tab-separated, blank = empty):`)
    values.forEach((row, r) => {
      const cells = row.map(c => String(c ?? '')).join('\t')
      lines.push(`R${r + 1}: ${cells}`)
    })
    if (values.length >= MAX_ROWS) lines.push(`… (truncated at ${MAX_ROWS} rows)`)
  }

  let out = lines.join('\n')
  if (out.length > 6000) out = out.slice(0, 6000) + '\n… (truncated)'
  return out
}
