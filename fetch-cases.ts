#!/usr/bin/env tsx
/**
 * fetch-cases.ts — fetch Domstolsverket case law into ~/library_staging/
 *
 * Usage:
 *   npx tsx fetch-cases.ts --topic arvsratt [--court HDO] [--limit 50] [--dry-run]
 *   npx tsx fetch-cases.ts --court HDO [--from-date 2020-01-01] [--limit 50] [--dry-run]
 *
 * Court codes: HDO (Högsta domstolen), PMOD (Patent- & marknadsöverdomstolen), MIOD (Migrationsöverdomstolen)
 *
 * Reads .env.local in the current directory for NEXT_PUBLIC_SUPABASE_URL
 * and SUPABASE_SERVICE_ROLE_KEY (used only for cursor fallback in unfiltered mode).
 */

import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import { createClient } from '@supabase/supabase-js'

// ── Constants ─────────────────────────────────────────────────────────────────

const BASE_URL   = 'https://rattspraxis.etjanst.domstol.se'
const STAGING    = path.join(os.homedir(), 'library_staging')
const CURSOR_F   = path.join(STAGING, '.cursor')
const ENV_FILE   = path.join(process.cwd(), '.env.local')
const PAGE_SIZE  = 50
const DELAY_MS   = 200
const RETRY_WAIT = 5_000
const MAX_RETRY  = 3

// ── Topic keyword sets ────────────────────────────────────────────────────────
// These map to the nyckelordLista tags used by the API. The search endpoint
// returns any case tagged with AT LEAST ONE of these keywords (OR logic).

const TOPICS: Record<string, string[]> = {
  arvsratt: [
    'Arv',
    'Arvsrätt',
    'Testamente',
    'Dödsbo',
    'Laglott',
    'Arvskifte',
    'Arvinge',
    'Arvlåtare',
    'Bouppteckning',
    'Boutredning',
    'Boutredningsman',
    'Efterarvinge',
    'Särkullbarn',
    'Testamentsvittne',
    'Testamentsexekutor',
    'Förskott på arv',
    'Dödsbodelägare',
    'Uskiftat bo',
    'Arvsskatt',
    'Arvsfonden',
  ],
}

// ── OpenAPI types ─────────────────────────────────────────────────────────────

interface DomstolDTO {
  domstolKod: string
  domstolNamn: string
}

interface PubliceringBilagaDTO {
  fillagringId: string
  filnamn: string
}

interface PubliceringDTO {
  id: string
  gruppKorrelationsnummer: string
  domstol: DomstolDTO
  ecliNummer?: string
  typ: string
  malNummerLista?: string[]
  avgorandedatum: string
  sammanfattning?: string
  innehall?: string
  benamning?: string
  publiceringsform?: string
  referatNummerLista: string[]
  lagrumLista: { sfsNummer?: string; referens?: string }[]
  litteraturLista: { titel?: string; forfattare?: string }[]
  forarbeteLista: string[]
  nyckelordLista: string[]
  hanvisadePubliceringarLista: { gruppKorrelationsnummer?: string; fritext?: string }[]
  rattsomradeLista: string[]
  europarattsligaAvgorandenLista: string[]
  bilagaLista: PubliceringBilagaDTO[]
  publiceringstid: string
}

// ── Args ──────────────────────────────────────────────────────────────────────

function parseArgs() {
  const argv = process.argv.slice(2)
  const result: {
    topic?: string
    court?: string
    fromDate?: string
    limit: number
    dryRun: boolean
  } = { limit: Infinity, dryRun: false }

  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
      case '--topic':      result.topic    = argv[++i]; break
      case '--court':      result.court    = argv[++i]; break
      case '--from-date':  result.fromDate = argv[++i]; break
      case '--limit':      result.limit    = parseInt(argv[++i], 10); break
      case '--dry-run':    result.dryRun   = true; break
    }
  }
  return result
}

// ── .env.local ────────────────────────────────────────────────────────────────

function loadEnv(): Record<string, string> {
  const env: Record<string, string> = {}
  if (!fs.existsSync(ENV_FILE)) return env
  for (const line of fs.readFileSync(ENV_FILE, 'utf-8').split('\n')) {
    const t = line.trim()
    if (!t || t.startsWith('#')) continue
    const eq = t.indexOf('=')
    if (eq < 0) continue
    env[t.slice(0, eq).trim()] = t.slice(eq + 1).trim().replace(/^["']|["']$/g, '')
  }
  return env
}

// ── Helpers ───────────────────────────────────────────────────────────────────

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms))

function sanitize(s: string): string {
  return s
    .replace(/[/\\:*?"<>|]/g, '-')
    .replace(/\s+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-|-$/g, '')
}

function stripHtml(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(?:p|div|h[1-6]|li|tr)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

function stableFilename(pub: PubliceringDTO): string {
  const ref = pub.referatNummerLista?.[0] ?? pub.benamning ?? pub.id
  return sanitize(ref) + '.txt'
}

async function fetchRetry(url: string, init?: RequestInit): Promise<Response> {
  let lastErr: unknown
  for (let attempt = 1; attempt <= MAX_RETRY; attempt++) {
    try {
      const res = await fetch(url, init)
      if (res.status === 429 || res.status === 503) {
        console.error(`  [${res.status}] rate-limited — waiting ${RETRY_WAIT / 1000}s (attempt ${attempt}/${MAX_RETRY})`)
        await sleep(RETRY_WAIT)
        continue
      }
      return res
    } catch (err) {
      lastErr = err
      if (attempt < MAX_RETRY) await sleep(RETRY_WAIT)
    }
  }
  throw lastErr ?? new Error(`Max retries exceeded: ${url}`)
}

// ── Supabase cursor fallback (unfiltered mode only) ───────────────────────────

async function supabaseCursor(url: string, key: string): Promise<string | null> {
  try {
    const sb = createClient(url, key)
    const { data } = await sb
      .from('library_items')
      .select('updated_at')
      .eq('type', 'legal_case')
      .order('updated_at', { ascending: false })
      .limit(1)
      .single()
    return data?.updated_at ? (data.updated_at as string).slice(0, 10) : null
  } catch {
    return null
  }
}

// ── Fetch full text for one publication ───────────────────────────────────────

async function fetchText(pub: PubliceringDTO): Promise<string | null> {
  let record = pub
  if (!pub.innehall && !pub.sammanfattning) {
    await sleep(DELAY_MS)
    const res = await fetchRetry(`${BASE_URL}/api/v1/publiceringar/${pub.id}`)
    if (!res.ok) {
      console.error(`  Failed to fetch full record ${pub.id}: HTTP ${res.status}`)
      return null
    }
    record = await res.json() as PubliceringDTO
  }

  const parts: string[] = []
  if (record.sammanfattning) parts.push(stripHtml(record.sammanfattning))
  if (record.innehall)       parts.push(stripHtml(record.innehall))
  if (parts.length > 0)     return parts.join('\n\n---\n\n')

  // No inline text — try PDF attachments.
  for (const bilaga of (record.bilagaLista ?? [])) {
    if (!bilaga.fillagringId) continue
    const label = bilaga.filnamn ?? bilaga.fillagringId
    console.log(`  Fetching PDF attachment: ${label}`)
    await sleep(DELAY_MS)
    const pdfRes = await fetchRetry(`${BASE_URL}/api/v1/bilagor/${bilaga.fillagringId}`)
    if (!pdfRes.ok) { console.error(`  PDF fetch failed: HTTP ${pdfRes.status}`); continue }
    const buf = Buffer.from(await pdfRes.arrayBuffer())
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const pdfParse = await import('pdf-parse' as any)
      const parsed = await pdfParse.default(buf)
      if (parsed.text?.trim()) return parsed.text.trim()
    } catch (err) {
      console.error(`  pdf-parse failed for ${label}: ${err}`)
    }
  }

  const label = pub.referatNummerLista?.[0] ?? pub.benamning ?? pub.id
  console.warn(`  Warning: no text retrieved for ${label}`)
  return null
}

// ── Fetch one page via the search endpoint (POST /api/v1/sok) ─────────────────

async function fetchSearchPage(keywords: string[], courtCodes: string[], pageIndex: number): Promise<{ total: number; publications: PubliceringDTO[] }> {
  const body = {
    filter: {
      sokordLista: keywords,
      ...(courtCodes.length > 0 ? { domstolKodLista: courtCodes } : {}),
    },
    sidIndex: pageIndex,
    antalPerSida: PAGE_SIZE,
    sortorder: 'publiceringstid',
    asc: true,
  }
  const res = await fetchRetry(`${BASE_URL}/api/v1/sok`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!res.ok) throw new Error(`Search endpoint: HTTP ${res.status}`)
  const data = await res.json() as { total: number; publiceringLista: PubliceringDTO[] }
  return { total: data.total, publications: data.publiceringLista ?? [] }
}

// ── Fetch one page via the list endpoint (GET /api/v1/publiceringar) ──────────

async function fetchListPage(fromDate: string, court: string | undefined, page: number): Promise<PubliceringDTO[]> {
  const qs = new URLSearchParams({
    publicerad_fran_och_med: fromDate,
    sortorder: 'publiceringstid',
    asc: 'true',
    page: String(page),
    pagesize: String(PAGE_SIZE),
  })
  if (court) qs.set('domstolkod', court)
  const res = await fetchRetry(`${BASE_URL}/api/v1/publiceringar?${qs}`)
  if (!res.ok) throw new Error(`List endpoint page ${page}: HTTP ${res.status}`)
  return await res.json() as PubliceringDTO[]
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const args = parseArgs()
  const env  = loadEnv()

  // Resolve topic keywords.
  let keywords: string[] | null = null
  if (args.topic) {
    keywords = TOPICS[args.topic]
    if (!keywords) {
      console.error(`Unknown topic "${args.topic}". Available: ${Object.keys(TOPICS).join(', ')}`)
      process.exit(1)
    }
  }

  if (!args.dryRun) fs.mkdirSync(STAGING, { recursive: true })

  // ── Cursor (only used in unfiltered/list mode) ────────────────────────────
  let fromDate = '1981-01-01'
  if (!keywords) {
    if (fs.existsSync(CURSOR_F)) {
      fromDate = fs.readFileSync(CURSOR_F, 'utf-8').trim().slice(0, 10)
      console.log(`Cursor: ${fromDate} (from .cursor file)`)
    } else {
      const sbUrl = env['NEXT_PUBLIC_SUPABASE_URL']
      const sbKey = env['SUPABASE_SERVICE_ROLE_KEY']
      const sbDate = sbUrl && sbKey ? await supabaseCursor(sbUrl, sbKey) : null
      if (sbDate) {
        fromDate = sbDate
        console.log(`Cursor: ${fromDate} (from Supabase library_items)`)
      } else if (args.fromDate) {
        fromDate = args.fromDate
        console.log(`Cursor: ${fromDate} (from --from-date)`)
      } else {
        console.warn('No cursor found — defaulting to 1981-01-01. Use --from-date to override.')
      }
    }
  }

  // ── Log run config ────────────────────────────────────────────────────────
  console.log(`\nTarget: ${BASE_URL}`)
  if (keywords) console.log(`Topic:  ${args.topic} (${keywords.length} keywords)`)
  if (args.court) console.log(`Court:  ${args.court}`)
  if (args.dryRun) console.log('Mode:   DRY RUN (no files written)')
  console.log('')

  // ── Announce total before fetching (topic mode only) ─────────────────────
  if (keywords) {
    const courts = args.court ? [args.court] : []
    const { total } = await fetchSearchPage(keywords, courts, 0)
    console.log(`Found ${total} matching cases in the API.\n`)
  }

  // ── Fetch loop ────────────────────────────────────────────────────────────
  let fetched = 0, skipped = 0, failed = 0
  let latestTimestamp: string | null = null
  let pageIndex = 0
  let done = false

  while (!done) {
    let publications: PubliceringDTO[]

    if (keywords) {
      const courts = args.court ? [args.court] : []
      const result = await fetchSearchPage(keywords, courts, pageIndex)
      publications = result.publications
    } else {
      publications = await fetchListPage(fromDate, args.court, pageIndex)
    }

    if (publications.length === 0) break

    for (const pub of publications) {
      if (fetched + skipped >= args.limit) { done = true; break }

      if (pub.publiceringstid && (!latestTimestamp || pub.publiceringstid > latestTimestamp)) {
        latestTimestamp = pub.publiceringstid
      }

      const filename = stableFilename(pub)
      const filePath = path.join(STAGING, filename)
      const label    = pub.referatNummerLista?.[0] ?? pub.benamning ?? pub.id

      if (args.dryRun) {
        const tags = pub.nyckelordLista?.slice(0, 4).join(', ')
        console.log(`[DRY RUN] ${label} (${pub.avgorandedatum}) [${tags}]`)
        fetched++
        continue
      }

      if (fs.existsSync(filePath)) {
        skipped++
        continue
      }

      await sleep(DELAY_MS)
      const text = await fetchText(pub)
      if (!text) { failed++; continue }

      fs.writeFileSync(filePath, text, 'utf-8')
      console.log(`  Saved: ${filename}`)
      fetched++
    }

    pageIndex++
    if (!done && publications.length === PAGE_SIZE) {
      await sleep(DELAY_MS)
    } else {
      done = true
    }
  }

  // ── Update cursor (list mode only) ────────────────────────────────────────
  if (!keywords && !args.dryRun && latestTimestamp) {
    fs.writeFileSync(CURSOR_F, latestTimestamp, 'utf-8')
    console.log(`Cursor updated to: ${latestTimestamp}`)
  }

  // ── Summary ───────────────────────────────────────────────────────────────
  console.log('\n' + '─'.repeat(40))
  console.log(`Fetched:  ${fetched} new cases`)
  console.log(`Skipped:  ${skipped} already in staging`)
  console.log(`Failed:   ${failed}`)
  console.log('─'.repeat(40))
}

main().catch(err => {
  console.error('Fatal:', err)
  process.exit(1)
})
