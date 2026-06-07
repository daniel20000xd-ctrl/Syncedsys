// SERVER-ONLY. The single source of truth for turning a URL into an enriched
// url_preview unit. Every trigger (the human paste popup's self-heal, the MCP
// tool, and the in-app Claude tool) funnels through enrichUrl / createUrlPreviewUnit
// here — scraping and R2 re-hosting are NEVER duplicated in a route or component.
//
// Imports open-graph-scraper and @aws-sdk, so this file must never be imported by
// a client component. Client code imports lib/urlPreviewShared.ts instead.
import ogs from 'open-graph-scraper'
import { PutObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'
import { randomUUID } from 'crypto'
import { lookup as dnsLookup } from 'dns/promises'
import type { SupabaseClient } from '@supabase/supabase-js'
import { getR2Client, R2_BUCKET } from '@/lib/r2'
import { normalizeUrl, isPrivateHost, isPrivateIp, getDomain, pendingPreviewData, type UrlPreviewData } from '@/lib/urlPreviewShared'

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
const FETCH_TIMEOUT_MS = 8000
const MAX_IMAGE_BYTES = 5 * 1024 * 1024
const MAX_HTML_BYTES = 3 * 1024 * 1024
const MAX_REDIRECTS = 5

export class UrlPreviewError extends Error {}

// Validate + SSRF-guard a raw URL. Throws UrlPreviewError on anything unusable.
export function validatePreviewUrl(raw: string): string {
  const normalized = normalizeUrl(raw)
  if (!normalized) throw new UrlPreviewError('That is not a valid http(s) URL.')
  let host: string
  try { host = new URL(normalized).hostname } catch { throw new UrlPreviewError('That is not a valid URL.') }
  if (isPrivateHost(host)) throw new UrlPreviewError('Refusing to fetch a private or internal address.')
  return normalized
}

function toAbsolute(maybeRelative: string | undefined, base: string): string | null {
  if (!maybeRelative) return null
  try { return new URL(maybeRelative, base).href } catch { return null }
}

// SSRF gate for a single hop: reject literal private hosts AND any address the
// hostname resolves to (defeats public-name -> private-IP DNS tricks). Throws.
async function assertPublicHost(hostname: string): Promise<void> {
  if (isPrivateHost(hostname)) throw new UrlPreviewError('Refusing to fetch a private or internal address.')
  // A literal IP is its own resolution; isPrivateHost already covered it.
  if (hostname.includes(':') || /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(hostname)) return
  let addrs: { address: string }[]
  try { addrs = await dnsLookup(hostname, { all: true }) } catch { throw new UrlPreviewError('Could not resolve host.') }
  if (!addrs.length) throw new UrlPreviewError('Could not resolve host.')
  for (const a of addrs) if (isPrivateIp(a.address)) throw new UrlPreviewError('Refusing to fetch a private or internal address.')
}

// Read a response body, aborting as soon as it exceeds `max` so an oversized (or
// unbounded chunked) body can never be buffered fully into memory.
async function readCapped(res: Response, max: number): Promise<Buffer | null> {
  const reader = res.body?.getReader()
  if (!reader) return null
  const chunks: Uint8Array[] = []
  let total = 0
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    if (value) {
      total += value.length
      if (total > max) { try { await reader.cancel() } catch {} return null }
      chunks.push(value)
    }
  }
  return Buffer.concat(chunks)
}

// Fetch with SSRF safety: validates EVERY redirect hop's host (resolved IPs),
// follows redirects manually, and reads the body under a single timeout with a
// hard byte cap. Returns null on any failure; throws UrlPreviewError if a hop
// targets a private/internal address.
async function safeFetchCapped(
  rawUrl: string,
  opts: { timeoutMs: number; maxBytes: number; accept?: string },
): Promise<{ contentType: string; buffer: Buffer; finalUrl: string } | null> {
  let current = rawUrl
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    let u: URL
    try { u = new URL(current) } catch { return null }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null
    await assertPublicHost(u.hostname)

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), opts.timeoutMs)
    try {
      const res = await fetch(current, {
        signal: controller.signal,
        redirect: 'manual',
        headers: { 'User-Agent': UA, ...(opts.accept ? { Accept: opts.accept } : {}) },
      })
      if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
        try { await res.body?.cancel() } catch {}
        current = new URL(res.headers.get('location')!, current).href
        continue
      }
      if (!res.ok) { try { await res.body?.cancel() } catch {} return null }
      const contentType = (res.headers.get('content-type') || '').split(';')[0].trim().toLowerCase()
      const declared = Number(res.headers.get('content-length') || 0)
      if (declared && declared > opts.maxBytes) { try { await res.body?.cancel() } catch {} return null }
      const buffer = await readCapped(res, opts.maxBytes)
      if (!buffer) return null
      return { contentType, buffer, finalUrl: current }
    } finally {
      clearTimeout(timer)
    }
  }
  return null // too many redirects
}

// Download an og:image (SSRF-safe, timeout + 5 MB streaming cap + image content-type
// check) and store it in R2 under the user's namespace. Returns the stable key +
// size, or null so the caller falls back to the remote og:image URL.
async function rehostImage(imageUrl: string, userId: string): Promise<{ storagePath: string; sizeBytes: number } | null> {
  try {
    const fetched = await safeFetchCapped(imageUrl, { timeoutMs: FETCH_TIMEOUT_MS, maxBytes: MAX_IMAGE_BYTES })
    if (!fetched) return null
    const ct = fetched.contentType
    if (!ct.startsWith('image/')) return null
    const buf = fetched.buffer
    if (buf.byteLength === 0) return null
    const ext = ct.includes('png') ? 'png' : ct.includes('webp') ? 'webp' : ct.includes('gif') ? 'gif'
      : ct.includes('svg') ? 'svg' : ct.includes('avif') ? 'avif' : 'jpg'
    const key = `${userId}/hub/url-previews/${randomUUID()}.${ext}`
    await getR2Client().send(new PutObjectCommand({ Bucket: R2_BUCKET, Key: key, Body: buf, ContentType: ct }))
    return { storagePath: key, sizeBytes: buf.byteLength }
  } catch {
    return null
  }
}

async function presign(key: string): Promise<string | null> {
  try {
    return await getSignedUrl(getR2Client(), new GetObjectCommand({ Bucket: R2_BUCKET, Key: key }), { expiresIn: 3600 })
  } catch {
    return null
  }
}

// Scrape metadata for a URL and (best-effort) re-host its og:image to R2.
// Always returns a renderable UrlPreviewData: 'ready' with whatever was found, or
// 'error' (still carrying the domain) so the card degrades to a plain link.
// Validation/SSRF errors are thrown to the caller (so the API returns 400).
export async function enrichUrl(userId: string, rawUrl: string): Promise<UrlPreviewData> {
  const url = validatePreviewUrl(rawUrl)
  const domain = getDomain(url)
  const origin = new URL(url).origin

  try {
    // Fetch the HTML ourselves (SSRF-safe, redirect-revalidated, size-capped) and
    // hand the string to ogs — never let ogs/undici fetch + follow redirects, which
    // would bypass the per-hop host validation.
    const fetched = await safeFetchCapped(url, { timeoutMs: FETCH_TIMEOUT_MS, maxBytes: MAX_HTML_BYTES, accept: 'text/html,application/xhtml+xml' })
    if (!fetched) throw new UrlPreviewError('Could not fetch the page.')
    const { result } = await ogs({ html: fetched.buffer.toString('utf8'), onlyGetOpenGraphInfo: false })

    const title = result.ogTitle || result.twitterTitle || result.dcTitle || domain
    const description = result.ogDescription || result.twitterDescription || null
    const siteName = result.ogSiteName || null
    const ogImg = Array.isArray(result.ogImage) && result.ogImage.length ? result.ogImage[0]?.url : undefined
    const absImg = toAbsolute(ogImg, url)

    let storagePath: string | null = null
    let sizeBytes: number | null = null
    let imageUrl: string | null = null
    if (absImg) {
      const hosted = await rehostImage(absImg, userId)
      if (hosted) {
        storagePath = hosted.storagePath
        sizeBytes = hosted.sizeBytes
        imageUrl = await presign(hosted.storagePath)
      } else {
        imageUrl = absImg // re-host failed → reference the remote og:image directly
      }
    }

    const faviconUrl = toAbsolute(result.favicon, url) || `${origin}/favicon.ico`

    return {
      url,
      status: 'ready',
      title: title || domain,
      description,
      siteName,
      domain,
      imageUrl,
      storagePath,
      sizeBytes,
      faviconUrl,
      fetchedAt: new Date().toISOString(),
    }
  } catch {
    // Scrape failed (timeout, blocked, non-HTML, etc.) — still return a usable
    // minimal card so the URL renders as a clickable link.
    return {
      url,
      status: 'error',
      title: domain,
      description: null,
      siteName: null,
      domain,
      imageUrl: null,
      storagePath: null,
      sizeBytes: null,
      faviconUrl: `${origin}/favicon.ico`,
      fetchedAt: new Date().toISOString(),
    }
  }
}

// THE canonical action: create a url_preview board element and enrich it.
// Used by POST /api/units/url-preview (MCP / programmatic) and by the in-app
// Claude tool executor (Part F) — both call this directly, never over HTTP.
// Caller supplies an RLS-scoped supabase client + the owning userId.
export async function createUrlPreviewUnit(opts: {
  supabase: SupabaseClient
  userId: string
  boardId: string
  url: string
  x?: number
  y?: number
}): Promise<{ id: string; data: UrlPreviewData }> {
  const { supabase, userId, boardId, url, x = 0, y = 0 } = opts
  // Validate/SSRF up front so a bad URL never creates a row (throws -> 400).
  const normalized = validatePreviewUrl(url)

  // Insert a pending row first so a card exists immediately and survives even if
  // enrichment is slow or a caller times out waiting for it.
  const { data: row, error } = await supabase
    .from('board_elements')
    .insert({ board_id: boardId, type: 'url_preview', x, y, data: pendingPreviewData(normalized), width: 280, height: null })
    .select('id')
    .single()
  if (error) throw new Error(error.message)
  const id = row.id as string

  // Enrich, then patch the row to ready (or error).
  const data = await enrichUrl(userId, normalized)
  await supabase.from('board_elements').update({ data }).eq('id', id)
  return { id, data }
}
