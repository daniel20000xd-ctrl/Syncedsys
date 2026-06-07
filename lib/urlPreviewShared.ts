// Client-SAFE URL-preview helpers and the canonical data shape.
//
// This module has ZERO server-only dependencies (no open-graph-scraper, no
// @aws-sdk) so it can be imported from client components (the sticky-note paste
// detector and the self-healing fallback) without dragging server code into the
// browser bundle. All scraping / R2 re-hosting lives in lib/urlPreview.ts, which
// imports the helpers from here. Never add server-only imports to this file.

// The `data` blob persisted on a board_elements row of type 'url_preview'.
// `storagePath` (R2 key) is the durable source of truth for the header image;
// `imageUrl` is a short-lived presigned hint (or a remote og:image fallback when
// re-hosting failed) that the card re-mints from storagePath on each load, exactly
// like an image element. `sizeBytes` lets deleteElement free the R2 object + quota.
export type UrlPreviewStatus = 'pending' | 'ready' | 'error'

export type UrlPreviewData = {
  url: string
  status: UrlPreviewStatus
  title: string | null
  description: string | null
  siteName: string | null
  domain: string | null
  imageUrl: string | null
  storagePath: string | null
  sizeBytes: number | null
  faviconUrl: string | null
  fetchedAt: string | null
}

// Trim, prepend https:// when the input is a bare domain, parse, and accept only
// http/https. Returns the normalized href or null when it isn't a usable URL.
export function normalizeUrl(raw: string): string | null {
  const t = (raw ?? '').trim()
  if (!t) return null
  let candidate = t
  if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(candidate)) {
    // No protocol — only prepend if it looks like a domain (host + dotted TLD).
    if (!/^[^\s/]+\.[a-zA-Z]{2,}(?:[:/?#].*)?$/.test(candidate)) return null
    candidate = 'https://' + candidate
  }
  let u: URL
  try { u = new URL(candidate) } catch { return null }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null
  return u.href
}

// True only when the text is essentially JUST a single URL (one token, no
// surrounding prose) — so a URL embedded in a longer paste is ignored.
export function isSingleUrl(text: string): boolean {
  const t = (text ?? '').trim()
  if (!t || /\s/.test(t)) return false
  return normalizeUrl(t) != null
}

// Hostname without a leading www. — used as the card's domain label.
export function getDomain(url: string): string | null {
  try { return new URL(url).hostname.replace(/^www\./, '') } catch { return null }
}

// Check a single IP literal (v4 dotted-quad or v6, including IPv4-mapped) against
// loopback / private / link-local / reserved ranges. Used both for literal hosts
// and for every address a hostname resolves to (server-side, before fetching).
export function isPrivateIp(ip: string): boolean {
  const h = (ip ?? '').toLowerCase().trim().replace(/^\[|\]$/g, '')
  if (!h) return true
  if (h.includes(':')) {
    // IPv6 forms
    if (h === '::' || h === '::1' || h === '0:0:0:0:0:0:0:1') return true
    // IPv4 embedded as a dotted-quad tail (e.g. ::ffff:169.254.169.254)
    const v4tail = h.match(/(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/)
    if (v4tail) return isPrivateIp(v4tail[1])
    // IPv4-mapped as hex (WHATWG normalizes ::ffff:169.254.169.254 -> ::ffff:a9fe:a9fe)
    const mapped = h.match(/(?:^|:)ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/)
    if (mapped) {
      const hi = parseInt(mapped[1], 16), lo = parseInt(mapped[2], 16)
      return isPrivateIp(`${(hi >> 8) & 255}.${hi & 255}.${(lo >> 8) & 255}.${lo & 255}`)
    }
    // Link-local fe80::/10, unique-local fc00::/7
    if (h.startsWith('fe8') || h.startsWith('fe9') || h.startsWith('fea') || h.startsWith('feb')) return true
    if (h.startsWith('fc') || h.startsWith('fd')) return true
    return false
  }
  const m = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/)
  if (m) {
    const a = Number(m[1]), b = Number(m[2]), c = Number(m[3]), d = Number(m[4])
    if (a > 255 || b > 255 || c > 255 || d > 255) return true // malformed -> unsafe
    if (a === 0 || a === 127 || a === 10) return true
    if (a === 169 && b === 254) return true              // link-local
    if (a === 172 && b >= 16 && b <= 31) return true      // private
    if (a === 192 && b === 168) return true               // private
    if (a === 100 && b >= 64 && b <= 127) return true     // CGNAT 100.64/10
    if (a >= 224) return true                             // multicast / reserved
    return false
  }
  return false // not an IP literal
}

// SSRF guard for a hostname STRING (literal IP or name). Literal addresses are
// range-checked; names that aren't literals return false here and must additionally
// be DNS-resolved + IP-checked server-side before fetching (see lib/urlPreview.ts).
export function isPrivateHost(hostname: string): boolean {
  const h = (hostname ?? '').toLowerCase().trim().replace(/^\[|\]$/g, '')
  if (!h) return true
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local')) return true
  if (h.includes(':') || /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h)) return isPrivateIp(h)
  return false
}

// A freshly-created preview before enrichment: just the URL + a 'pending' status.
export function pendingPreviewData(url: string): UrlPreviewData {
  return {
    url,
    status: 'pending',
    title: null,
    description: null,
    siteName: null,
    domain: getDomain(url),
    imageUrl: null,
    storagePath: null,
    sizeBytes: null,
    faviconUrl: null,
    fetchedAt: null,
  }
}
