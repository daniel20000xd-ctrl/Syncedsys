// PDF support: client-side text extraction (so Claude can read it) + upload of
// the raw binary to Supabase Storage (so a unit can open it in a new tab).
//
// pdfjs is imported dynamically so its ~1 MB bundle only loads when a PDF is
// actually handled. The worker is loaded from a CDN matching the installed
// version — this sidesteps all bundler worker-resolution quirks.

import { createClient } from '@/lib/supabase/client'

export const MAX_PDF_BYTES = 25_000_000 // 25 MB — generous for lecture slides
export const PDF_BUCKET = 'pdfs'
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

// Upload the raw PDF to the user's folder in the storage bucket. Returns the
// storage path (e.g. "<userId>/<uuid>.pdf") to persist on the element.
export async function uploadPdf(file: File): Promise<string> {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) throw new Error('Not authenticated')
  const path = `${user.id}/${crypto.randomUUID()}.pdf`
  const { error } = await supabase.storage.from(PDF_BUCKET).upload(path, file, {
    contentType: 'application/pdf',
    upsert: false,
  })
  if (error) throw error
  return path
}
