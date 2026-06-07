// Helpers for accepting text files dropped from the OS. Binary files are
// ignored for now (no blob storage yet) — only text content is read, which
// lives happily in a Postgres column.

const TEXT_EXTENSIONS = [
  'txt', 'md', 'markdown', 'rtf', 'log', 'csv', 'tsv', 'json', 'jsonc', 'xml',
  'yml', 'yaml', 'toml', 'ini', 'conf', 'env', 'html', 'htm', 'css', 'scss',
  'js', 'jsx', 'ts', 'tsx', 'py', 'rb', 'go', 'rs', 'c', 'h', 'cpp', 'java',
  'kt', 'swift', 'sh', 'bash', 'zsh', 'sql', 'php', 'vue', 'svelte', 'tex',
]

const MAX_BYTES = 1_000_000 // 1 MB — generous for text, keeps the DB row sane

// Drag payload used when dragging a unit out of a portal onto the canvas.
export const PORTAL_ITEM_MIME = 'application/x-syncedsys-portalitem'
// Drag payload used when dragging a board tab to become a sub-tab of another.
export const BOARD_TAB_MIME = 'application/x-syncedsys-boardtab'
// Drag payload used when dragging a tab onto the canvas to float it as a window.
export const FLOAT_BOARD_MIME = 'application/x-syncedsys-floatboard'

// Trigger a browser download of an already-built Blob under the given filename.
export function downloadBlob(name: string, blob: Blob) {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = name || 'download'
  document.body.appendChild(a)
  a.click()
  a.remove()
  URL.revokeObjectURL(url)
}

// Trigger a browser download of text content as a file.
export function downloadTextFile(name: string, content: string) {
  downloadBlob(name || 'file.txt', new Blob([content], { type: 'text/plain;charset=utf-8' }))
}

export function isTextFile(file: File): boolean {
  if (file.type.startsWith('text/')) return true
  if (file.type === 'application/json' || file.type === 'application/xml') return true
  const ext = file.name.split('.').pop()?.toLowerCase() ?? ''
  return TEXT_EXTENSIONS.includes(ext)
}

export type DroppedTextFile = { name: string; content: string }

function isPdf(file: File): boolean {
  return file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf')
}
const MAX_PDF_BYTES = 25_000_000

// Largest single non-text/non-PDF file we'll store as an opaque blob in R2.
export const MAX_UPLOAD_BYTES = 100_000_000 // 100 MB

// A PDF already uploaded to R2 + its extracted text, ready to be persisted as a
// 'pdf' element by importFolderTree (the binary lives in R2, not in this object).
export type ImportPdfRef = { name: string; storagePath: string; sizeBytes: number; text: string; pageCount: number }

// Any other file already uploaded to R2, persisted as an opaque 'file' element
// (no preview/edit — just stored and downloadable).
export type ImportFileRef = { name: string; storagePath: string; sizeBytes: number }

// A folder tree ready for the server: a folder with its text files, (optionally)
// already-uploaded PDFs and other binaries, and sub-folders. Shared with
// app/actions.ts via a type-only import so the pipeline has one canonical shape.
export type ImportNode = { name: string; files: DroppedTextFile[]; pdfs?: ImportPdfRef[]; binaries?: ImportFileRef[]; dirs: ImportNode[] }

// A folder tree read from an <input webkitdirectory> picker. PDFs and other
// binaries are kept as raw File objects here because they must be uploaded to
// R2 client-side (see lib/pdf.ts) before importFolderTree can persist them.
export type PickedFolder = { name: string; textFiles: DroppedTextFile[]; pdfFiles: File[]; otherFiles: File[]; dirs: PickedFolder[] }

// Synchronously pull FileSystemEntry objects from a drop. MUST be called inside
// the drop handler before any `await` — the DataTransferItemList is only valid
// during the event. Returns null when the entries API isn't available.
export function collectEntries(dt: DataTransfer): FileSystemEntry[] | null {
  if (!dt.items || dt.items.length === 0) return null
  const out: FileSystemEntry[] = []
  for (let i = 0; i < dt.items.length; i++) {
    const entry = dt.items[i].webkitGetAsEntry?.()
    if (entry) out.push(entry)
  }
  return out.length ? out : null
}

function getFile(entry: FileSystemFileEntry): Promise<File> {
  return new Promise((resolve, reject) => entry.file(resolve, reject))
}

// readEntries returns at most ~100 entries per call, so loop until drained.
function readAllDirEntries(dir: FileSystemDirectoryEntry): Promise<FileSystemEntry[]> {
  const reader = dir.createReader()
  const all: FileSystemEntry[] = []
  return new Promise((resolve, reject) => {
    const next = () => reader.readEntries(batch => {
      if (batch.length === 0) resolve(all)
      else { all.push(...batch); next() }
    }, reject)
    next()
  })
}

async function entryToTree(dir: FileSystemDirectoryEntry, skipped: string[]): Promise<ImportNode> {
  const node: ImportNode = { name: dir.name, files: [], dirs: [] }
  for (const entry of await readAllDirEntries(dir)) {
    if (entry.isFile) {
      const file = await getFile(entry as FileSystemFileEntry)
      if (isTextFile(file) && file.size <= MAX_BYTES) node.files.push({ name: file.name, content: await file.text() })
      else skipped.push(file.name)
    } else if (entry.isDirectory) {
      node.dirs.push(await entryToTree(entry as FileSystemDirectoryEntry, skipped))
    }
  }
  return node
}

// Resolve a drop into loose text files + folder trees. Falls back to the flat
// FileList when the directory-entries API isn't available.
export async function readDroppedEntries(
  entries: FileSystemEntry[] | null,
  fallbackFiles: FileList | File[] | null,
): Promise<{ trees: ImportNode[]; files: DroppedTextFile[]; pdfs: File[]; skipped: string[] }> {
  if (!entries) {
    const { accepted, pdfs, skipped } = await readDroppedTextFiles(fallbackFiles ?? [])
    return { trees: [], files: accepted, pdfs, skipped }
  }
  const trees: ImportNode[] = []
  const files: DroppedTextFile[] = []
  const pdfs: File[] = []
  const skipped: string[] = []
  for (const entry of entries) {
    if (entry.isDirectory) {
      trees.push(await entryToTree(entry as FileSystemDirectoryEntry, skipped))
    } else if (entry.isFile) {
      const file = await getFile(entry as FileSystemFileEntry)
      if (isPdf(file) && file.size <= MAX_PDF_BYTES) pdfs.push(file)
      else if (isTextFile(file) && file.size <= MAX_BYTES) files.push({ name: file.name, content: await file.text() })
      else skipped.push(file.name)
    }
  }
  return { trees, files, pdfs, skipped }
}

// Reads the text files out of a drop, skipping binaries and oversized files.
// Returns the successfully-read files plus the names that were skipped.
export async function readDroppedTextFiles(
  files: FileList | File[],
): Promise<{ accepted: DroppedTextFile[]; pdfs: File[]; skipped: string[] }> {
  const accepted: DroppedTextFile[] = []
  const pdfs: File[] = []
  const skipped: string[] = []
  for (const file of Array.from(files)) {
    if (isPdf(file) && file.size <= MAX_PDF_BYTES) {
      pdfs.push(file)
      continue
    }
    if (!isTextFile(file) || file.size > MAX_BYTES) {
      skipped.push(file.name)
      continue
    }
    try {
      accepted.push({ name: file.name, content: await file.text() })
    } catch {
      skipped.push(file.name)
    }
  }
  return { accepted, pdfs, skipped }
}

// Reconstruct a folder forest from an <input type="file" webkitdirectory> pick.
// Such an input yields a FLAT FileList where each file's `webkitRelativePath`
// encodes its path ("root/sub/dir/name.ext"). We rebuild the nested tree from
// those paths, reading text files inline and keeping PDFs as raw File objects
// (uploaded to R2 by the caller). Returns one root per distinct top segment.
export async function readPickedFolder(
  list: FileList | File[],
): Promise<{ roots: PickedFolder[]; skipped: string[] }> {
  const files = Array.from(list)
  const skipped: string[] = []
  const roots: PickedFolder[] = []
  const rootByName = new Map<string, PickedFolder>()

  const getRoot = (name: string): PickedFolder => {
    let r = rootByName.get(name)
    if (!r) { r = { name, textFiles: [], pdfFiles: [], otherFiles: [], dirs: [] }; rootByName.set(name, r); roots.push(r) }
    return r
  }
  const descend = (root: PickedFolder, segs: string[]): PickedFolder => {
    let node = root
    for (const seg of segs) {
      let child = node.dirs.find(d => d.name === seg)
      if (!child) { child = { name: seg, textFiles: [], pdfFiles: [], otherFiles: [], dirs: [] }; node.dirs.push(child) }
      node = child
    }
    return node
  }

  for (const f of files) {
    const rel = f.webkitRelativePath || f.name
    const parts = rel.split('/').filter(Boolean)
    const fileName = parts[parts.length - 1] ?? ''
    if (!fileName || fileName.startsWith('.')) continue // skip dotfiles (.DS_Store, .git, …)
    const rootName = parts.length > 1 ? parts[0] : 'Uploaded folder'
    const dir = descend(getRoot(rootName), parts.slice(1, -1))

    if (isPdf(f) && f.size <= MAX_PDF_BYTES) {
      dir.pdfFiles.push(f)
    } else if (isTextFile(f) && f.size <= MAX_BYTES) {
      try { dir.textFiles.push({ name: f.name, content: await f.text() }) }
      catch { skipped.push(rel) }
    } else if (f.size <= MAX_UPLOAD_BYTES) {
      // Anything else (incl. oversized text/PDF, images, binaries) is stored as
      // an opaque blob — not previewable/editable, but kept and downloadable.
      dir.otherFiles.push(f)
    } else {
      skipped.push(`${rel} (too large)`)
    }
  }
  return { roots, skipped }
}
