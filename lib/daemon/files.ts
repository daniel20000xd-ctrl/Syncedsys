import {
  DeleteObjectCommand, GetObjectCommand, ListObjectsV2Command, PutObjectCommand, NoSuchKey,
} from '@aws-sdk/client-s3'
import { getR2Client, R2_BUCKET } from '@/lib/r2'
import { monthOf } from './time'

// Markdown families in R2 (calendar, daylog, reflections), each a sequence of dated blocks:
//
//   ## 2026-09-17
//   <markdown>
//
// current.md holds the current month; archive/YYYY-MM.md holds earlier months of the
// current year; archive/YYYY/YYYY-MM.md holds closed years. Content is never
// summarised or truncated — rotation only moves blocks between files verbatim.

export type Family = 'calendar' | 'daylog' | 'reflections'
export type Block = { date: string; body: string }

const HEADING = /^## (\d{4}-\d{2}-\d{2})[ \t]*$/m

const base = (userId: string, family: Family) => `${userId}/daemon/${family}`
const currentKey = (userId: string, family: Family) => `${base(userId, family)}/current.md`

function archiveKey(userId: string, family: Family, month: string, currentYear: string): string {
  const year = month.slice(0, 4)
  return year < currentYear
    ? `${base(userId, family)}/archive/${year}/${month}.md`
    : `${base(userId, family)}/archive/${month}.md`
}

async function getText(key: string): Promise<string | null> {
  try {
    const res = await getR2Client().send(new GetObjectCommand({ Bucket: R2_BUCKET, Key: key }))
    return (await res.Body?.transformToString('utf-8')) ?? ''
  } catch (e) {
    if (e instanceof NoSuchKey || (e as { name?: string }).name === 'NoSuchKey') return null
    throw e
  }
}

async function putText(key: string, text: string): Promise<void> {
  await getR2Client().send(new PutObjectCommand({
    Bucket: R2_BUCKET, Key: key, Body: text, ContentType: 'text/markdown; charset=utf-8',
  }))
}

async function deleteKey(key: string): Promise<void> {
  await getR2Client().send(new DeleteObjectCommand({ Bucket: R2_BUCKET, Key: key }))
}

// Anything before the first heading is kept as a preamble so hand edits are never lost.
export function parseBlocks(text: string): { preamble: string; blocks: Block[] } {
  const pieces = text.split(HEADING)
  const blocks: Block[] = []
  for (let i = 1; i < pieces.length; i += 2) {
    blocks.push({ date: pieces[i], body: pieces[i + 1].replace(/^\s*\n/, '').replace(/\s+$/, '') })
  }
  return { preamble: pieces[0].replace(/\s+$/, ''), blocks }
}

export function renderBlocks(preamble: string, blocks: Block[]): string {
  const out = blocks.map(b => `## ${b.date}\n\n${b.body}\n`)
  return [preamble ? `${preamble}\n` : '', ...out].filter(Boolean).join('\n')
}

export function renderForContext(blocks: Block[]): string {
  return blocks.length ? renderBlocks('', blocks) : '(empty)'
}

// Reads blocks dated within [from, to] (inclusive). Only touches archive files for
// months the range actually reaches back into.
export async function readRange(userId: string, family: Family, from: string, to: string, today: string): Promise<Block[]> {
  const texts: string[] = []
  const currentMonth = monthOf(today)
  const currentYear = today.slice(0, 4)
  let m = monthOf(from)
  while (m < currentMonth && m <= monthOf(to)) {
    const t = await getText(archiveKey(userId, family, m, currentYear))
    if (t) texts.push(t)
    const [y, mm] = m.split('-').map(Number)
    m = mm === 12 ? `${y + 1}-01` : `${y}-${String(mm + 1).padStart(2, '0')}`
  }
  const cur = await getText(currentKey(userId, family))
  if (cur) texts.push(cur)
  return texts
    .flatMap(t => parseBlocks(t).blocks)
    .filter(b => b.date >= from && b.date <= to)
    .sort((a, b) => a.date.localeCompare(b.date))
}

export async function readLatest(userId: string, family: Family): Promise<Block | null> {
  const cur = await getText(currentKey(userId, family))
  const blocks = cur ? parseBlocks(cur).blocks : []
  return blocks.sort((a, b) => a.date.localeCompare(b.date)).at(-1) ?? null
}

export async function readCurrent(userId: string, family: Family): Promise<string> {
  return (await getText(currentKey(userId, family))) ?? ''
}

// Calendar semantics: the day's block is replaced.
export async function writeDayBlock(userId: string, family: Family, date: string, body: string): Promise<void> {
  const key = currentKey(userId, family)
  const { preamble, blocks } = parseBlocks((await getText(key)) ?? '')
  const next = blocks.filter(b => b.date !== date)
  next.push({ date, body: body.trim() })
  next.sort((a, b) => a.date.localeCompare(b.date))
  await putText(key, renderBlocks(preamble, next))
}

// Reflection-log semantics: a re-run for the same day appends rather than overwrites.
export async function appendDayBlock(userId: string, family: Family, date: string, body: string): Promise<void> {
  const key = currentKey(userId, family)
  const { preamble, blocks } = parseBlocks((await getText(key)) ?? '')
  const existing = blocks.find(b => b.date === date)
  if (existing) existing.body = `${existing.body}\n\n${body.trim()}`
  else blocks.push({ date, body: body.trim() })
  blocks.sort((a, b) => a.date.localeCompare(b.date))
  await putText(key, renderBlocks(preamble, blocks))
}

async function listKeys(prefix: string, delimiter?: string): Promise<string[]> {
  const r2 = getR2Client()
  const keys: string[] = []
  let token: string | undefined
  do {
    const res = await r2.send(new ListObjectsV2Command({ Bucket: R2_BUCKET, Prefix: prefix, Delimiter: delimiter, ContinuationToken: token }))
    for (const o of res.Contents ?? []) if (o.Key) keys.push(o.Key)
    token = res.IsTruncated ? res.NextContinuationToken : undefined
  } while (token)
  return keys
}

async function appendBlocksTo(key: string, blocks: Block[]): Promise<void> {
  const existing = await getText(key)
  const parsed = parseBlocks(existing ?? '')
  // Skipping exact duplicates keeps a rotation or migration re-run after a crash idempotent.
  const seen = new Set(parsed.blocks.map(b => `${b.date}|${b.body}`))
  const fresh = blocks.filter(b => !seen.has(`${b.date}|${b.body}`))
  const merged = [...parsed.blocks, ...fresh].sort((a, b) => a.date.localeCompare(b.date))
  await putText(key, renderBlocks(parsed.preamble, merged))
}

// Plain-code rotation, run before the nightly model call. Idempotent.
// 1. Blocks dated before `today`'s month move from current.md to their month's archive file.
// 2. Month files of closed years move into archive/YYYY/.
// Destinations are written before sources are rewritten/deleted, so a crash mid-way
// can duplicate a block but never lose one.
export async function rotate(userId: string, family: Family, today: string): Promise<{ movedBlocks: number; movedFiles: number }> {
  const currentMonth = monthOf(today)
  const currentYear = today.slice(0, 4)
  const key = currentKey(userId, family)
  let movedBlocks = 0
  let movedFiles = 0

  const cur = await getText(key)
  if (cur) {
    const { preamble, blocks } = parseBlocks(cur)
    const old = blocks.filter(b => monthOf(b.date) < currentMonth)
    if (old.length) {
      const byMonth = new Map<string, Block[]>()
      for (const b of old) byMonth.set(monthOf(b.date), [...(byMonth.get(monthOf(b.date)) ?? []), b])
      for (const [month, group] of byMonth) await appendBlocksTo(archiveKey(userId, family, month, currentYear), group)
      await putText(key, renderBlocks(preamble, blocks.filter(b => monthOf(b.date) >= currentMonth)))
      movedBlocks = old.length
    }
  }

  const prefix = `${base(userId, family)}/archive/`
  const flat = await listKeys(prefix, '/')

  for (const k of flat) {
    const match = k.slice(prefix.length).match(/^(\d{4})-(\d{2})\.md$/)
    if (!match || match[1] >= currentYear) continue
    await moveFile(k, `${prefix}${match[1]}/${match[1]}-${match[2]}.md`)
    movedFiles++
  }

  return { movedBlocks, movedFiles }
}

// Copy (merging block-wise into an existing destination), then delete the source.
async function moveFile(from: string, to: string): Promise<void> {
  const text = (await getText(from)) ?? ''
  const destText = await getText(to)
  if (destText === null) {
    await putText(to, text)
  } else {
    const src = parseBlocks(text)
    await appendBlocksTo(to, src.blocks)
    if (src.preamble && !destText.includes(src.preamble)) {
      const merged = parseBlocks((await getText(to)) ?? '')
      await putText(to, renderBlocks([merged.preamble, src.preamble].filter(Boolean).join('\n\n'), merged.blocks))
    }
  }
  await deleteKey(from)
}

// v1 wrote the day log under daemon/reflection/; v2 renames that family to daylog/
// (reflections/ is the new introspection archive).
export async function migrateLegacyDaylog(userId: string): Promise<number> {
  const legacy = `${userId}/daemon/reflection/`
  const keys = await listKeys(legacy)
  for (const key of keys) await moveFile(key, `${base(userId, 'daylog')}/${key.slice(legacy.length)}`)
  return keys.length
}

// ── read-only helpers for the admin console ─────────────────────────────────────

export type FamilyFile = { key: string; relative: string; size: number; lastModified: string | null }

export async function listFamilyFiles(userId: string, family: Family): Promise<FamilyFile[]> {
  const prefix = `${base(userId, family)}/`
  const r2 = getR2Client()
  const files: FamilyFile[] = []
  let token: string | undefined
  do {
    const res = await r2.send(new ListObjectsV2Command({ Bucket: R2_BUCKET, Prefix: prefix, ContinuationToken: token }))
    for (const o of res.Contents ?? []) {
      if (!o.Key) continue
      files.push({ key: o.Key, relative: o.Key.slice(prefix.length), size: o.Size ?? 0, lastModified: o.LastModified?.toISOString() ?? null })
    }
    token = res.IsTruncated ? res.NextContinuationToken : undefined
  } while (token)
  return files.sort((a, b) => a.relative.localeCompare(b.relative))
}

// Everything stored for one month, wherever rotation should have put it: current.md
// (blocks of that month), archive/YYYY-MM.md, and archive/YYYY/YYYY-MM.md. Reporting
// every location separately makes a misplaced or duplicated block visible.
export async function readMonth(userId: string, family: Family, month: string): Promise<{ key: string; blocks: Block[]; preamble: string }[]> {
  const year = month.slice(0, 4)
  const keys = [
    currentKey(userId, family),
    `${base(userId, family)}/archive/${month}.md`,
    `${base(userId, family)}/archive/${year}/${month}.md`,
  ]
  const out: { key: string; blocks: Block[]; preamble: string }[] = []
  for (const key of keys) {
    const text = await getText(key)
    if (text === null) continue
    const parsed = parseBlocks(text)
    const blocks = parsed.blocks.filter(b => monthOf(b.date) === month)
    if (blocks.length || (parsed.preamble && key !== currentKey(userId, family))) out.push({ key, blocks, preamble: parsed.preamble })
  }
  return out
}

// Parsed contents of one stored file (by full key), for one-off tooling.
export async function readFamilyFile(key: string): Promise<{ preamble: string; blocks: Block[] } | null> {
  const text = await getText(key)
  return text === null ? null : parseBlocks(text)
}
