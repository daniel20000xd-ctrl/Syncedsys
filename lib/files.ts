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

// Trigger a browser download of text content as a file.
export function downloadTextFile(name: string, content: string) {
  const blob = new Blob([content], { type: 'text/plain;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = name || 'file.txt'
  document.body.appendChild(a)
  a.click()
  a.remove()
  URL.revokeObjectURL(url)
}

export function isTextFile(file: File): boolean {
  if (file.type.startsWith('text/')) return true
  if (file.type === 'application/json' || file.type === 'application/xml') return true
  const ext = file.name.split('.').pop()?.toLowerCase() ?? ''
  return TEXT_EXTENSIONS.includes(ext)
}

export type DroppedTextFile = { name: string; content: string }

// A folder tree read from a drop: a folder with its text files and sub-folders.
export type ImportNode = { name: string; files: DroppedTextFile[]; dirs: ImportNode[] }

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
): Promise<{ trees: ImportNode[]; files: DroppedTextFile[]; skipped: string[] }> {
  if (!entries) {
    const { accepted, skipped } = await readDroppedTextFiles(fallbackFiles ?? [])
    return { trees: [], files: accepted, skipped }
  }
  const trees: ImportNode[] = []
  const files: DroppedTextFile[] = []
  const skipped: string[] = []
  for (const entry of entries) {
    if (entry.isDirectory) {
      trees.push(await entryToTree(entry as FileSystemDirectoryEntry, skipped))
    } else if (entry.isFile) {
      const file = await getFile(entry as FileSystemFileEntry)
      if (isTextFile(file) && file.size <= MAX_BYTES) files.push({ name: file.name, content: await file.text() })
      else skipped.push(file.name)
    }
  }
  return { trees, files, skipped }
}

// Reads the text files out of a drop, skipping binaries and oversized files.
// Returns the successfully-read files plus the names that were skipped.
export async function readDroppedTextFiles(
  files: FileList | File[],
): Promise<{ accepted: DroppedTextFile[]; skipped: string[] }> {
  const accepted: DroppedTextFile[] = []
  const skipped: string[] = []
  for (const file of Array.from(files)) {
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
  return { accepted, skipped }
}
