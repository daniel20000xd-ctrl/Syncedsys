export type Board = {
  id: string
  name: string
  color: string
  user_id: string
  deadline: string | null
  mode: 'classic' | 'trello' | 'text'
  content: string | null
  parent_id: string | null
  tab_position: number
  free_x: number
  free_y: number
  created_at: string
}

export type List = {
  id: string
  board_id: string
  name: string
  position: number
  x: number
  y: number
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
  type: 'shape' | 'image' | 'drawing' | 'text' | 'portal'
  x: number
  y: number
  width: number | null
  height: number | null
  data: Record<string, unknown>
  created_at: string
}
