// PDF support: client-side text extraction (so Claude can read it) + upload of
// the raw binary to R2 (so a unit can open it in a new tab).
//
// pdfjs is imported dynamically so its ~1 MB bundle only loads when a PDF is
// actually handled. The worker is loaded from a CDN matching the installed
// version — this sidesteps all bundler worker-resolution quirks.

import { STORAGE_URL } from '@/lib/storageUrl'

export const MAX_PDF_BYTES = 25_000_000 // 25 MB — generous for lecture slides
// Cap stored extracted text so a huge PDF can't bloat a DB row / Claude context.
const MAX_TEXT_CHARS = 120_000

export function isPdfFile(file: File): boolean {
  return file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf')
}

// Pull readable text out of a PDF in the browser. Returns the (capped) text and
// the page count. Best-effort: a scanned/image-only PDF yields little/no text.
export async function extractPdfText(file: File): Promise<{ text: string; pageCount: number }> {
  const pdfjs = await import('pdfjs-dist')
  pdfjs.GlobalWorkerOptions.workerSrc = `https://cdnjs.cloudflare.com/ajax/libs/pdf.js/${pdfjs.version}/pdf.worker.min.mjs`

  const buf = await file.arrayBuffer()
  const doc = await pdfjs.getDocument({ data: buf }).promise
  let text = ''
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i)
    const content = await page.getTextContent()
    const pageText = content.items.map(it => ('str' in it ? it.str : '')).join(' ')
    text += pageText + '\n\n'
    if (text.length > MAX_TEXT_CHARS) break
  }
  return { text: text.slice(0, MAX_TEXT_CHARS).trim(), pageCount: doc.numPages }
}

// Render page 1 of a PDF to a small JPEG data-URL for use as an attachment
// thumbnail. Reuses the same pdfjs load so callers can share the ArrayBuffer.
export async function renderPdfThumbnail(file: File, maxWidth = 120): Promise<string> {
  const pdfjs = await import('pdfjs-dist')
  pdfjs.GlobalWorkerOptions.workerSrc = `https://cdnjs.cloudflare.com/ajax/libs/pdf.js/${pdfjs.version}/pdf.worker.min.mjs`

  const buf = await file.arrayBuffer()
  const doc = await pdfjs.getDocument({ data: buf }).promise
  const page = await doc.getPage(1)
  const baseViewport = page.getViewport({ scale: 1 })
  const scale = maxWidth / baseViewport.width
  const viewport = page.getViewport({ scale })
  const canvas = document.createElement('canvas')
  canvas.width = Math.round(viewport.width)
  canvas.height = Math.round(viewport.height)
  const ctx = canvas.getContext('2d')
  if (!ctx) return ''
  await page.render({ canvasContext: ctx, viewport }).promise
  return canvas.toDataURL('image/jpeg', 0.75)
}

// Upload the raw PDF to R2. Returns the R2 key and file size so callers can
// store both on the element (size is needed for accurate counter decrements on delete).
export async function uploadPdf(file: File, boardId: string): Promise<{ key: string; sizeBytes: number }> {
  const form = new FormData()
  form.append('file', file)
  form.append('app', 'hub')
  form.append('subpath', `pdfs/${boardId}/${crypto.randomUUID()}-${file.name}`)
  const res = await fetch(`${STORAGE_URL}/api/storage/upload`, { method: 'POST', body: form })
  if (!res.ok) throw new Error(`R2 upload failed: ${res.status}`)
  const { key } = await res.json() as { key: string }
  return { key, sizeBytes: file.size }
}
