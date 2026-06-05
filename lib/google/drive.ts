import { googleFetch } from '@/lib/google/client'

// Lightweight Drive file listing, used to power "pick a file" UIs (Docs/Sheets
// portals) so users browse and select instead of pasting URLs. Read-only —
// relies on the drive.readonly scope already requested at consent.

const DRIVE_FILES_ENDPOINT = 'https://www.googleapis.com/drive/v3/files'

export const DRIVE_MIME = {
  document: 'application/vnd.google-apps.document',
  spreadsheet: 'application/vnd.google-apps.spreadsheet',
  presentation: 'application/vnd.google-apps.presentation',
} as const

export type DriveKind = keyof typeof DRIVE_MIME

export interface DriveFile {
  id: string
  name: string
  modifiedTime: string
  iconLink?: string
}

// Drive query strings use single quotes around values, so any quote inside a
// user's search term has to be backslash-escaped or the query 400s.
function escapeQueryValue(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")
}

export async function listDriveFiles(
  userId: string,
  opts: { mimeType?: string; search?: string; pageSize?: number } = {},
): Promise<DriveFile[]> {
  const clauses = ['trashed = false']
  if (opts.mimeType) clauses.push(`mimeType = '${opts.mimeType}'`)
  const search = opts.search?.trim()
  if (search) clauses.push(`name contains '${escapeQueryValue(search)}'`)

  const params = new URLSearchParams({
    q: clauses.join(' and '),
    orderBy: 'modifiedTime desc',
    pageSize: String(opts.pageSize ?? 50),
    fields: 'files(id,name,modifiedTime,iconLink)',
    supportsAllDrives: 'true',
    includeItemsFromAllDrives: 'true',
  })

  const res = await googleFetch(userId, `${DRIVE_FILES_ENDPOINT}?${params.toString()}`)
  if (!res.ok) {
    const detail = await res.text().catch(() => '')
    throw new Error(`Drive list failed (${res.status}): ${detail}`)
  }
  const data = (await res.json()) as { files?: DriveFile[] }
  return data.files ?? []
}
