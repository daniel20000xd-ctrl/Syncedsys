import type { SupabaseClient } from '@supabase/supabase-js'
import type Anthropic from '@anthropic-ai/sdk'

// Tools exposed to the board-scoped Claude. READ tools are always available;
// WRITE tools are only included when the user has enabled "Let Claude make
// changes". Every write validates its target board against the allowed set
// (the down-only closure) before touching the database — the model's chosen
// id is never trusted.

export const READ_TOOLS: Anthropic.Tool[] = [
  {
    name: 'get_board',
    description: 'Fetch the full current contents (lists, cards, elements) of a board by id. Use to refresh your view before acting.',
    input_schema: {
      type: 'object',
      properties: { boardId: { type: 'string', description: 'The id of the board to read.' } },
      required: ['boardId'],
    },
  },
]

export const WRITE_TOOLS: Anthropic.Tool[] = [
  {
    name: 'create_board',
    description: 'Create a new sub-tab (board) under an existing in-scope board.',
    input_schema: {
      type: 'object',
      properties: {
        parentId: { type: 'string', description: 'Parent board id (must be in scope).' },
        name: { type: 'string' },
        mode: { type: 'string', enum: ['classic', 'trello', 'text', 'folder', 'spreadsheet'], description: 'Board type. Default classic (freeform canvas).' },
        color: { type: 'string', description: 'Hex colour, e.g. #0079bf. Optional.' },
      },
      required: ['parentId', 'name'],
    },
  },
  {
    name: 'create_list',
    description: 'Create a list (column) on a board.',
    input_schema: {
      type: 'object',
      properties: {
        boardId: { type: 'string' },
        name: { type: 'string' },
      },
      required: ['boardId', 'name'],
    },
  },
  {
    name: 'create_card',
    description: 'Create a card inside a list. The list must belong to an in-scope board.',
    input_schema: {
      type: 'object',
      properties: {
        listId: { type: 'string' },
        title: { type: 'string' },
      },
      required: ['listId', 'title'],
    },
  },
  {
    name: 'create_text',
    description: 'Place a free-floating text note on a board (canvas/classic boards).',
    input_schema: {
      type: 'object',
      properties: {
        boardId: { type: 'string' },
        text: { type: 'string' },
        x: { type: 'number' }, y: { type: 'number' },
      },
      required: ['boardId', 'text'],
    },
  },
  {
    name: 'create_shape',
    description: 'Place a shape (rect/circle/diamond) with an optional label on a canvas board.',
    input_schema: {
      type: 'object',
      properties: {
        boardId: { type: 'string' },
        shape: { type: 'string', enum: ['rect', 'circle', 'diamond'] },
        label: { type: 'string' },
        x: { type: 'number' }, y: { type: 'number' },
        width: { type: 'number' }, height: { type: 'number' },
      },
      required: ['boardId', 'shape'],
    },
  },
  {
    name: 'create_file',
    description: 'Create a text file. On a folder board it appears in the file explorer; on a canvas it appears as a file block.',
    input_schema: {
      type: 'object',
      properties: {
        boardId: { type: 'string' },
        name: { type: 'string' },
        content: { type: 'string' },
      },
      required: ['boardId', 'name', 'content'],
    },
  },
  {
    name: 'set_board_content',
    description: 'Replace the full text content of a text-mode or spreadsheet-mode board.',
    input_schema: {
      type: 'object',
      properties: {
        boardId: { type: 'string' },
        content: { type: 'string' },
      },
      required: ['boardId', 'content'],
    },
  },
  {
    name: 'rename_board',
    description: 'Rename an in-scope board.',
    input_schema: {
      type: 'object',
      properties: {
        boardId: { type: 'string' },
        name: { type: 'string' },
      },
      required: ['boardId', 'name'],
    },
  },
  // ── Slides satellite tools ────────────────────────────────────────────────
  {
    name: 'create_presentation',
    description: 'Create a new slides presentation in the Slides satellite.',
    input_schema: {
      type: 'object' as const,
      properties: {
        title: { type: 'string', description: 'Presentation title.' },
        theme: { type: 'string', description: 'Theme name: minimal, dark, bold, warm, corporate.' },
      },
      required: ['title'],
    },
  },
  {
    name: 'add_slide',
    description: 'Add a new slide to a presentation.',
    input_schema: {
      type: 'object' as const,
      properties: {
        presentation_id: { type: 'string' },
        position: { type: 'number', description: 'Position in the slide order (0-based).' },
        background_color: { type: 'string', description: 'Background hex color.' },
      },
      required: ['presentation_id'],
    },
  },
  {
    name: 'add_text_element',
    description: 'Add a text element to a slide.',
    input_schema: {
      type: 'object' as const,
      properties: {
        slide_id: { type: 'string' },
        text: { type: 'string' },
        x: { type: 'number' }, y: { type: 'number' },
        width: { type: 'number' }, height: { type: 'number' },
        font_size: { type: 'number' },
        font_family: { type: 'string' },
        color: { type: 'string' },
        bold: { type: 'boolean' },
        italic: { type: 'boolean' },
        align: { type: 'string', enum: ['left', 'center', 'right'] },
      },
      required: ['slide_id', 'text'],
    },
  },
  {
    name: 'add_shape_element',
    description: 'Add a shape (rect, ellipse, triangle) to a slide.',
    input_schema: {
      type: 'object' as const,
      properties: {
        slide_id: { type: 'string' },
        shape_type: { type: 'string', enum: ['rect', 'rounded-rect', 'ellipse', 'triangle', 'diamond'] },
        x: { type: 'number' }, y: { type: 'number' },
        width: { type: 'number' }, height: { type: 'number' },
        fill: { type: 'string' },
        stroke: { type: 'string' },
        stroke_width: { type: 'number' },
      },
      required: ['slide_id', 'shape_type'],
    },
  },
  {
    name: 'update_slide_element',
    description: 'Update properties of an existing slide element.',
    input_schema: {
      type: 'object' as const,
      properties: {
        element_id: { type: 'string' },
        text: { type: 'string' },
        color: { type: 'string' },
        font_size: { type: 'number' },
        font_family: { type: 'string' },
        bold: { type: 'boolean' },
        x: { type: 'number' }, y: { type: 'number' },
        width: { type: 'number' }, height: { type: 'number' },
      },
      required: ['element_id'],
    },
  },
  {
    name: 'delete_element',
    description: 'Delete a slide element.',
    input_schema: {
      type: 'object' as const,
      properties: { element_id: { type: 'string' } },
      required: ['element_id'],
    },
  },
  {
    name: 'set_speaker_notes',
    description: 'Set speaker notes for a slide.',
    input_schema: {
      type: 'object' as const,
      properties: {
        slide_id: { type: 'string' },
        notes: { type: 'string' },
      },
      required: ['slide_id', 'notes'],
    },
  },
  {
    name: 'update_presentation_theme',
    description: 'Apply a built-in theme to a presentation (reskins all slides).',
    input_schema: {
      type: 'object' as const,
      properties: {
        presentation_id: { type: 'string' },
        theme: { type: 'string', enum: ['minimal', 'dark', 'bold', 'warm', 'corporate'] },
      },
      required: ['presentation_id', 'theme'],
    },
  },
  {
    name: 'reorder_slides',
    description: 'Reorder slides in a presentation.',
    input_schema: {
      type: 'object' as const,
      properties: {
        presentation_id: { type: 'string' },
        slide_ids: { type: 'array', items: { type: 'string' }, description: 'Slide IDs in the new order.' },
      },
      required: ['presentation_id', 'slide_ids'],
    },
  },
]

export const SLIDES_READ_TOOLS: Anthropic.Tool[] = [
  {
    name: 'get_presentation',
    description: 'Fetch a presentation and all its slides and elements from the Slides satellite.',
    input_schema: {
      type: 'object' as const,
      properties: { presentation_id: { type: 'string' } },
      required: ['presentation_id'],
    },
  },
  {
    name: 'list_presentations',
    description: 'List all presentations the user owns in the Slides satellite.',
    input_schema: {
      type: 'object' as const,
      properties: {},
      required: [],
    },
  },
]

export const SLIDES_WRITE_TOOLS: Anthropic.Tool[] = WRITE_TOOLS.filter(t =>
  ['create_presentation', 'add_slide', 'add_text_element', 'add_shape_element',
   'update_slide_element', 'delete_element', 'set_speaker_notes',
   'update_presentation_theme', 'reorder_slides'].includes(t.name)
)

export type ToolCtx = {
  supabase: SupabaseClient
  userId: string
  allowedIds: Set<string>
  accessToken?: string
}

class ScopeError extends Error {}

const SLIDES_API = 'https://slides.syncedsys.com/api/slides'
function slidesCall(path: string, method: string, body: unknown, ctx: ToolCtx) {
  return fetch(`${SLIDES_API}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(ctx.accessToken ? { Authorization: `Bearer ${ctx.accessToken}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  }).then(r => r.json())
}

function ensureBoard(ctx: ToolCtx, boardId: string) {
  if (!boardId || !ctx.allowedIds.has(boardId)) {
    throw new ScopeError(`Board ${boardId} is outside your allowed scope. You may only act on boards listed in the context.`)
  }
}

async function nextTabPosition(ctx: ToolCtx, parentId: string): Promise<number> {
  const { data } = await ctx.supabase.from('boards').select('tab_position').eq('parent_id', parentId).order('tab_position', { ascending: false }).limit(1)
  return data && data.length ? data[0].tab_position + 1 : 0
}

// Executes a tool call. Returns a short human-readable result string fed back to
// the model. Throws ScopeError (caught by caller) for out-of-scope attempts.
export async function executeTool(name: string, input: Record<string, unknown>, ctx: ToolCtx): Promise<string> {
  const s = ctx.supabase
  switch (name) {
    case 'get_board': {
      const boardId = String(input.boardId)
      ensureBoard(ctx, boardId)
      const { data: board } = await s.from('boards').select('id,name,mode,content').eq('id', boardId).single()
      const { data: lists } = await s.from('lists').select('id,name').eq('board_id', boardId)
      const listIds = (lists ?? []).map(l => l.id)
      const cards = listIds.length ? (await s.from('cards').select('id,list_id,title,done').in('list_id', listIds)).data ?? [] : []
      const { data: els } = await s.from('board_elements').select('id,type,data').eq('board_id', boardId)
      return JSON.stringify({ board, lists, cards, elements: els })
    }

    case 'create_board': {
      const parentId = String(input.parentId)
      ensureBoard(ctx, parentId)
      const mode = (input.mode as string) ?? 'classic'
      const tab_position = await nextTabPosition(ctx, parentId)
      const { data, error } = await s.from('boards').insert({
        name: String(input.name), color: (input.color as string) ?? '#0079bf', user_id: ctx.userId,
        parent_id: parentId, tab_position, mode,
      }).select('id,name').single()
      if (error) throw new Error(error.message)
      // Newly created board is now in scope for the rest of this conversation.
      ctx.allowedIds.add(data.id)
      return `Created board "${data.name}" (id ${data.id}).`
    }

    case 'create_list': {
      const boardId = String(input.boardId)
      ensureBoard(ctx, boardId)
      const { data: existing } = await s.from('lists').select('position').eq('board_id', boardId).order('position', { ascending: false }).limit(1)
      const position = existing && existing.length ? existing[0].position + 1 : 0
      const { data, error } = await s.from('lists').insert({ board_id: boardId, name: String(input.name), position }).select('id,name').single()
      if (error) throw new Error(error.message)
      return `Created list "${data.name}" (id ${data.id}).`
    }

    case 'create_card': {
      const listId = String(input.listId)
      const { data: list } = await s.from('lists').select('id,board_id').eq('id', listId).single()
      if (!list) throw new Error('List not found.')
      ensureBoard(ctx, list.board_id)
      const { data: existing } = await s.from('cards').select('position').eq('list_id', listId).order('position', { ascending: false }).limit(1)
      const position = existing && existing.length ? existing[0].position + 1 : 0
      const { data, error } = await s.from('cards').insert({ list_id: listId, title: String(input.title), position }).select('id,title').single()
      if (error) throw new Error(error.message)
      return `Created card "${data.title}" (id ${data.id}).`
    }

    case 'create_text': {
      const boardId = String(input.boardId)
      ensureBoard(ctx, boardId)
      const { data, error } = await s.from('board_elements').insert({
        board_id: boardId, type: 'text', x: (input.x as number) ?? 80, y: (input.y as number) ?? 80,
        data: { text: String(input.text), color: '#1f2937', fontSize: 18 },
      }).select('id').single()
      if (error) throw new Error(error.message)
      return `Added a text note (id ${data.id}).`
    }

    case 'create_shape': {
      const boardId = String(input.boardId)
      ensureBoard(ctx, boardId)
      const w = (input.width as number) ?? 140, h = (input.height as number) ?? 90
      const { data, error } = await s.from('board_elements').insert({
        board_id: boardId, type: 'shape', x: (input.x as number) ?? 80, y: (input.y as number) ?? 80, width: w, height: h,
        data: { shape: (input.shape as string) ?? 'rect', fill: '#93c5fd', label: (input.label as string) ?? '', width: w, height: h },
      }).select('id').single()
      if (error) throw new Error(error.message)
      return `Added a ${input.shape} shape (id ${data.id}).`
    }

    case 'create_file': {
      const boardId = String(input.boardId)
      ensureBoard(ctx, boardId)
      const { data, error } = await s.from('board_elements').insert({
        board_id: boardId, type: 'textfile', x: 0, y: 0,
        data: { name: String(input.name), content: String(input.content) },
      }).select('id').single()
      if (error) throw new Error(error.message)
      return `Created file "${input.name}" (id ${data.id}).`
    }

    case 'set_board_content': {
      const boardId = String(input.boardId)
      ensureBoard(ctx, boardId)
      const { error } = await s.from('boards').update({ content: String(input.content) }).eq('id', boardId)
      if (error) throw new Error(error.message)
      return `Updated content of board ${boardId}.`
    }

    case 'rename_board': {
      const boardId = String(input.boardId)
      ensureBoard(ctx, boardId)
      const { error } = await s.from('boards').update({ name: String(input.name) }).eq('id', boardId)
      if (error) throw new Error(error.message)
      return `Renamed board ${boardId} to "${input.name}".`
    }

    // ── Slides satellite tools ───────────────────────────────────────────────
    case 'get_presentation': {
      const data = await slidesCall(`/presentations/${String(input.presentation_id)}`, 'GET', null, ctx)
      return JSON.stringify(data)
    }

    case 'list_presentations': {
      const data = await slidesCall('/presentations', 'GET', null, ctx)
      return JSON.stringify(data)
    }

    case 'create_presentation': {
      const data = await slidesCall('/presentations', 'POST', { title: input.title, theme: input.theme }, ctx)
      return JSON.stringify(data)
    }

    case 'add_slide': {
      const data = await slidesCall(`/presentations/${String(input.presentation_id)}/slides`, 'POST', {
        position: input.position,
        background_color: input.background_color,
      }, ctx)
      return JSON.stringify(data)
    }

    case 'add_text_element': {
      const data = await slidesCall(`/slides/${String(input.slide_id)}/elements`, 'POST', {
        type: 'text',
        text: input.text,
        x: input.x, y: input.y,
        width: input.width, height: input.height,
        font_size: input.font_size,
        font_family: input.font_family,
        color: input.color,
        bold: input.bold,
        italic: input.italic,
        align: input.align,
      }, ctx)
      return JSON.stringify(data)
    }

    case 'add_shape_element': {
      const data = await slidesCall(`/slides/${String(input.slide_id)}/elements`, 'POST', {
        type: 'shape',
        shape_type: input.shape_type,
        x: input.x, y: input.y,
        width: input.width, height: input.height,
        fill: input.fill,
        stroke: input.stroke,
        stroke_width: input.stroke_width,
      }, ctx)
      return JSON.stringify(data)
    }

    case 'update_slide_element': {
      const data = await slidesCall(`/elements/${String(input.element_id)}`, 'PATCH', {
        text: input.text,
        color: input.color,
        font_size: input.font_size,
        font_family: input.font_family,
        bold: input.bold,
        x: input.x, y: input.y,
        width: input.width, height: input.height,
      }, ctx)
      return JSON.stringify(data)
    }

    case 'delete_element': {
      const data = await slidesCall(`/elements/${String(input.element_id)}`, 'DELETE', null, ctx)
      return JSON.stringify(data)
    }

    case 'set_speaker_notes': {
      const data = await slidesCall(`/slides/${String(input.slide_id)}`, 'PATCH', { notes: input.notes }, ctx)
      return JSON.stringify(data)
    }

    case 'update_presentation_theme': {
      const data = await slidesCall(`/presentations/${String(input.presentation_id)}`, 'PATCH', { theme: input.theme }, ctx)
      return JSON.stringify(data)
    }

    case 'reorder_slides': {
      const data = await slidesCall(`/presentations/${String(input.presentation_id)}/reorder`, 'PUT', { slide_ids: input.slide_ids }, ctx)
      return JSON.stringify(data)
    }

    default:
      throw new Error(`Unknown tool: ${name}`)
  }
}

export { ScopeError }
