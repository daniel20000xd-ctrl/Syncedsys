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

export function isTextFile(file: File): boolean {
  if (file.type.startsWith('text/')) return true
  if (file.type === 'application/json' || file.type === 'application/xml') return true
  const ext = file.name.split('.').pop()?.toLowerCase() ?? ''
  return TEXT_EXTENSIONS.includes(ext)
}

export type DroppedTextFile = { name: string; content: string }

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
