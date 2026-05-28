export type Board = {
  id: string
  name: string
  color: string
  user_id: string
  created_at: string
}

export type List = {
  id: string
  board_id: string
  name: string
  position: number
  created_at: string
}

export type Card = {
  id: string
  list_id: string
  title: string
  description: string | null
  position: number
  created_at: string
}
