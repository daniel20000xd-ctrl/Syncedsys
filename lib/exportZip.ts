// Server-only: build a ZIP that mirrors a board's whole subtab/folder tree.
//
// Each board becomes a directory named after the board. Inside it:
//   - "soft" units (text notes, links, lists/cards, text-mode pages) are rolled
//     into one markdown file named "<board>.md";
//   - standalone file units (textfile / pdf / anything with an R2 storagePath)
//     are written as real files (text inline, binaries fetched from R2);
//   - each sub-board (subtab / folder) recurses into a nested directory.
//
// The tree is fetched user-scoped (RLS + explicit user_id) via batched
// level-order BFS (one query per level, not per board). R2 fetches are
// concurrency-limited and bounded by entry-count / per-object / aggregate-size
// caps so a huge tree can't OOM or hang the serverless function. Already-
// compressed blobs (PDFs/images) are stored, not deflated, to save CPU.

import type { SupabaseClient } from '@supabase/supabase-js'
import { GetObjectCommand } from '@aws-sdk/client-s3'
import { zipSync, strToU8, type Zippable } from 'fflate'
import { getR2Client, R2_BUCKET } from '@/lib/r2'
import {
  renderBoardSoftUnits, isFileUnit, safeSegment, boardExportFilename, uniqueInDir,
  type ExportBoardData, type ExportElement, type ExportList, type ExportCard,
} from '@/lib/exportBoard'

const MAX_DEPTH = 10                          // levels of subtab/folder nesting
const MAX_ENTRIES = 5000                      // total ZIP entries (files + dirs)
const MAX_TOTAL_BYTES = 150 * 1024 * 1024     // aggregate resolved content (memory headroom)
const MAX_OBJECT_BYTES = 50 * 1024 * 1024     // single R2 object ceiling
const R2_CONCURRENCY = 6
const PARENT_BATCH = 200                       // parent ids per children query

const BOARD_SELECT =
  'id, name, mode, content, parent_id, tab_position, board_elements(type, data), lists(name, position, cards(title, description, position, done, deadline))'

// ── DB: batched level-order tree fetch ─────────────────────────────────────────

/* eslint-disable @typescript-eslint/no-explicit-any */
function rowToNode(row: any): ExportBoardData {
  const elements: ExportElement[] = ((row.board_elements ?? []) as any[]).map((e: any) => ({
    type: String(e.type ?? ''),
    data: (e.data ?? {}) as Record<string, unknown>,
  }))
  const lists: ExportList[] = ((row.lists ?? []) as any[]).map((l: any) => ({
    name: String(l.name ?? ''),
    position: Number(l.position ?? 0),
    cards: ((l.cards ?? []) as any[]).map((c: any): ExportCard => ({
      title: String(c.title ?? ''),
      description: c.description ? String(c.description) : null,
      done: Boolean(c.done),
      deadline: c.deadline ? String(c.deadline) : null,
      position: Number(c.position ?? 0),
    })),
  }))
  return {
    id: row.id as string,
    name: String(row.name ?? ''),
    mode: (row.mode as ExportBoardData['mode']) ?? 'classic',
    content: row.content ? String(row.content) : null,
    elements,
    lists,
    children: [],
  }
}
/* eslint-enable @typescript-eslint/no-explicit-any */

async function fetchTree(
  supabase: SupabaseClient,
  rootBoardId: string,
  userId: string,
): Promise<ExportBoardData | null> {
  const { data: rootRow } = await supabase
    .from('boards').select(BOARD_SELECT).eq('id', rootBoardId).eq('user_id', userId).single()
  if (!rootRow) return null

  const root = rowToNode(rootRow)
  const byId = new Map<string, ExportBoardData>([[root.id, root]])
  let frontier: string[] = [root.id]

  for (let depth = 0; depth < MAX_DEPTH && frontier.length; depth++) {
    // One query per chunk of parent ids — children arrive tab_position-ordered.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const childRows: any[] = []
    for (let i = 0; i < frontier.length; i += PARENT_BATCH) {
      const batch = frontier.slice(i, i + PARENT_BATCH)
      const { data } = await supabase
        .from('boards').select(BOARD_SELECT)
        .in('parent_id', batch).eq('user_id', userId)
        .order('tab_position', { ascending: true })
      if (data?.length) childRows.push(...data)
    }
    const next: string[] = []
    for (const row of childRows) {
      if (byId.has(row.id)) continue // guard against cycles
      const node = rowToNode(row)
      byId.set(node.id, node)
      byId.get(row.parent_id as string)?.children.push(node)
      next.push(node.id)
    }
    frontier = next
  }
  return root
}

// ── Tree → planned entry list ──────────────────────────────────────────────────

type PlannedEntry = {
  path: string
  bytes?: Uint8Array       // resolved inline content (text / markdown / empty)
  storagePath?: string     // unresolved R2 key (fetched in resolveR2)
  binary?: boolean         // store (level 0) instead of deflating
}

function fileNameForUnit(el: ExportElement, index: number): string {
  const d = el.data as { name?: string; storagePath?: string }
  if (typeof d.name === 'string' && d.name.trim()) return d.name.trim()
  if (typeof d.storagePath === 'string') {
    const base = d.storagePath.split('/').pop() ?? ''
    if (base) return base
  }
  const ext = el.type === 'pdf' ? '.pdf' : '.txt'
  return `${el.type || 'file'}-${index + 1}${ext}`
}

// Walk the tree, appending entries. Returns how many real (file/markdown)
// entries the subtree produced, so an empty-folder marker is only emitted when
// the subtree contributed nothing. All push sites respect MAX_ENTRIES.
function walk(
  board: ExportBoardData,
  parentDir: string,
  siblingDirNames: Set<string>,
  entries: PlannedEntry[],
  skipped: string[],
): number {
  const segment = uniqueInDir(siblingDirNames, safeSegment(board.name))
  const dir = parentDir + segment + '/'
  const usedHere = new Set<string>()
  let produced = 0

  // Soft units → one markdown file.
  const soft = renderBoardSoftUnits(board)
  if (soft) {
    if (entries.length < MAX_ENTRIES) {
      const mdName = uniqueInDir(usedHere, boardExportFilename(board.name) + '.md')
      entries.push({ path: dir + mdName, bytes: strToU8(soft), binary: false })
      produced++
    } else {
      skipped.push(dir + ' notes (entry limit reached)')
    }
  }

  // Standalone file units.
  const fileUnits = board.elements.filter(isFileUnit)
  for (let i = 0; i < fileUnits.length; i++) {
    const el = fileUnits[i]
    const d = el.data as { content?: unknown; storagePath?: unknown }
    if (entries.length >= MAX_ENTRIES) {
      skipped.push(dir + fileNameForUnit(el, i) + ' (entry limit reached)')
      continue
    }
    const fname = uniqueInDir(usedHere, safeSegment(fileNameForUnit(el, i), 'file'))
    if (typeof d.content === 'string') {
      entries.push({ path: dir + fname, bytes: strToU8(d.content), binary: false })
      produced++
    } else if (typeof d.storagePath === 'string' && d.storagePath) {
      entries.push({ path: dir + fname, storagePath: d.storagePath, binary: true })
      produced++
    } else if (el.type === 'textfile') {
      // A text file the user created but left empty → emit a zero-byte file so
      // the folder still mirrors what they see, rather than silently skipping it.
      entries.push({ path: dir + fname, bytes: new Uint8Array(0), binary: false })
      produced++
    } else {
      skipped.push(dir + fname + ' (no content)')
    }
  }

  // Recurse children into nested directories (sharing this dir's namespace so a
  // sub-folder can't collide with a file/markdown written above).
  for (const child of board.children) {
    produced += walk(child, dir, usedHere, entries, skipped)
  }

  // Nothing anywhere in this subtree → emit an explicit empty-directory entry so
  // the folder still materializes when unzipped.
  if (produced === 0 && entries.length < MAX_ENTRIES) {
    entries.push({ path: dir, bytes: new Uint8Array(0), binary: false })
  }
  return produced
}

// ── R2 resolution with a small concurrency pool + size guards ───────────────────

function finalize(bytes: Uint8Array, binary: boolean): Zippable[string] {
  // Store binaries (PDFs/images are already compressed); deflate text.
  return binary ? [bytes, { level: 0 }] : bytes
}

async function resolveR2(
  entries: PlannedEntry[],
  userId: string,
  skipped: string[],
): Promise<Zippable> {
  const out: Zippable = {}
  let total = 0

  // Inline entries first (count their bytes toward the cap).
  const pending: PlannedEntry[] = []
  for (const e of entries) {
    if (e.bytes) {
      if (total + e.bytes.length > MAX_TOTAL_BYTES) { skipped.push(e.path + ' (size limit reached)'); continue }
      total += e.bytes.length
      out[e.path] = finalize(e.bytes, !!e.binary)
    } else {
      pending.push(e)
    }
  }

  const client = getR2Client()
  let cursor = 0
  async function worker() {
    while (cursor < pending.length) {
      const e = pending[cursor++]
      const key = e.storagePath!
      if (!key.startsWith(`${userId}/`)) { skipped.push(e.path + ' (access denied)'); continue }
      if (total >= MAX_TOTAL_BYTES) { skipped.push(e.path + ' (size limit reached)'); continue }
      try {
        const obj = await client.send(new GetObjectCommand({ Bucket: R2_BUCKET, Key: key }))
        // Reject / reserve by declared size BEFORE buffering the body into RAM.
        const declared = Number(obj.ContentLength ?? 0)
        if (declared > MAX_OBJECT_BYTES) { skipped.push(e.path + ' (file too large)'); continue }
        if (declared > 0 && total + declared > MAX_TOTAL_BYTES) { skipped.push(e.path + ' (size limit reached)'); continue }
        total += declared // reserve so concurrent workers don't collectively overshoot
        const body = obj.Body as { transformToByteArray?: () => Promise<Uint8Array> } | undefined
        if (!body?.transformToByteArray) { total -= declared; skipped.push(e.path + ' (unreadable)'); continue }
        const bytes = await body.transformToByteArray()
        total += bytes.length - declared // correct the reservation to the real size
        if (bytes.length > MAX_OBJECT_BYTES || total > MAX_TOTAL_BYTES) {
          total -= bytes.length
          skipped.push(e.path + ' (size limit reached)')
          continue
        }
        out[e.path] = finalize(bytes, true)
      } catch {
        skipped.push(e.path + ' (fetch failed)')
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(R2_CONCURRENCY, pending.length || 1) }, worker))
  return out
}

// ── Public entry point ─────────────────────────────────────────────────────────

export async function buildBoardZip(
  supabase: SupabaseClient,
  userId: string,
  rootBoardId: string,
): Promise<{ filename: string; bytes: Uint8Array<ArrayBuffer> } | null> {
  const tree = await fetchTree(supabase, rootBoardId, userId)
  if (!tree) return null

  const entries: PlannedEntry[] = []
  const skipped: string[] = []
  walk(tree, '', new Set<string>(), entries, skipped)

  const zipData = await resolveR2(entries, userId, skipped)

  if (skipped.length) {
    zipData['_SKIPPED.txt'] = strToU8(
      'These items could not be included in the export:\n\n' + skipped.join('\n') + '\n',
    )
  }

  // Deflate text at level 6; binaries are stored (level 0) per-entry above.
  const bytes = zipSync(zipData, { level: 6 })
  return { filename: boardExportFilename(tree.name) + '.zip', bytes }
}
