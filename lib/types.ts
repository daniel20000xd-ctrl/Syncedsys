export type Board = {
  id: string
  name: string
  color: string
  user_id: string
  deadline: string | null
  mode: 'classic' | 'trello' | 'text' | 'folder' | 'database'
  content: string | null
  parent_id: string | null
  tab_position: number
  group_id: string | null
  is_group: boolean
  is_persona: boolean
  free_x: number
  free_y: number
  synced: boolean
  meta: string | null
  readme_md: string | null
  created_at: string
}

export type DeviceLink = {
  id: string
  user_id: string
  name: string
  pairing_code: string | null
  token: string
  paired: boolean
  last_seen: string | null
  created_at: string
}

export type List = {
  id: string
  board_id: string
  name: string
  position: number
  x: number
  y: number
  is_widget: boolean
  widget_position: number
  deadline: string | null
  hidden: boolean
  created_at: string
}

export type Card = {
  id: string
  list_id: string
  title: string
  description: string | null
  position: number
  x: number
  y: number
  done: boolean
  done_at: string | null
  deadline: string | null
  recur_interval_minutes: number | null
  hidden: boolean
  created_at: string
}

export type BoardEdge = {
  id: string
  board_id: string
  source: string
  target: string
  source_handle: string | null
  target_handle: string | null
  data: Record<string, unknown>
  created_at: string
}

export type BoardElement = {
  id: string
  board_id: string
  type: 'shape' | 'image' | 'drawing' | 'text' | 'portal' | 'textfile' | 'folderlink' | 'claude' | 'pdf' | 'url_preview' | 'file'
  x: number
  y: number
  width: number | null
  height: number | null
  data: Record<string, unknown>
  deadline: string | null
  created_at: string
}

export type WorkspacePhoto = {
  id: string
  user_id: string
  filename: string
  r2_key: string
  mime_type: string
  size_bytes: number
  created_at: string
  expires_at: string | null
  is_saved: boolean
  project_tag: string | null
  description: string | null
  width: number | null
  height: number | null
}

export type WorkspacePhotoWithUrl = WorkspacePhoto & { signed_url: string; number: number }

export type PhotoLibrarySettings = {
  pause_deletion: boolean
}
