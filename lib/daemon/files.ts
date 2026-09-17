import {
  DeleteObjectCommand, GetObjectCommand, ListObjectsV2Command, PutObjectCommand, NoSuchKey,
} from '@aws-sdk/client-s3'
import { getR2Client, R2_BUCKET } from '@/lib/r2'
import { monthOf } from './time'

// Two markdown families in R2, each a sequence of dated blocks:
//
//   ## 2026-09-17
//   <markdown>
//
// current.md holds the current month; archive/YYYY-MM.md holds earlier months of the
// current year; archive/YYYY/YYYY-MM.md holds closed years. Content is never
// summarised or truncated — rotation only moves blocks between files verbatim.

export type Family = 'calendar' | 'reflection'
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

async function appendBlocksTo(key: string, blocks: Block[]): Promise<void> {
  const existing = await getText(key)
  const parsed = parseBlocks(existing ?? '')
  const merged = [...parsed.blocks, ...blocks].sort((a, b) => a.date.localeCompare(b.date))
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
  const r2 = getR2Client()
  let token: string | undefined
  const flat: string[] = []
  do {
    const res = await r2.send(new ListObjectsV2Command({ Bucket: R2_BUCKET, Prefix: prefix, Delimiter: '/', ContinuationToken: token }))
    for (const o of res.Contents ?? []) if (o.Key) flat.push(o.Key)
    token = res.IsTruncated ? res.NextContinuationToken : undefined
  } while (token)

  for (const k of flat) {
    const match = k.slice(prefix.length).match(/^(\d{4})-(\d{2})\.md$/)
    if (!match || match[1] >= currentYear) continue
    const text = (await getText(k)) ?? ''
    const dest = `${prefix}${match[1]}/${match[1]}-${match[2]}.md`
    const destText = await getText(dest)
    if (destText === null) {
      await putText(dest, text)
    } else {
      const src = parseBlocks(text)
      await appendBlocksTo(dest, src.blocks)
      if (src.preamble) {
        const merged = parseBlocks((await getText(dest)) ?? '')
        await putText(dest, renderBlocks([merged.preamble, src.preamble].filter(Boolean).join('\n\n'), merged.blocks))
      }
    }
    await deleteKey(k)
    movedFiles++
  }

  return { movedBlocks, movedFiles }
}
