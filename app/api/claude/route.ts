import { NextRequest } from 'next/server'
import Anthropic from '@anthropic-ai/sdk'
import { createClient } from '@/lib/supabase/server'
import { buildClaudeContext } from '@/lib/claude/context'
import { READ_TOOLS, WRITE_TOOLS, executeTool, ScopeError, type ToolCtx } from '@/lib/claude/tools'
import { resolveAnthropicKey, NoClaudeKeyError, KeyDecryptError, type KeySource } from '@/lib/claude/key'
import { recordClaudeUsage } from '@/lib/claude/usage'
import { claudeGate } from '@/lib/claude/gate'

// The model used for the in-app assistant. Change here to upgrade.
const MODEL = 'claude-sonnet-4-5-20250929'
const MAX_TURNS = 8 // safety bound on the agentic tool loop

type ChatMessage = { role: 'user' | 'assistant'; content: string | Anthropic.ContentBlockParam[] }

function sse(obj: unknown) {
  return new TextEncoder().encode(JSON.stringify(obj) + '\n')
}

export async function POST(req: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return new Response(JSON.stringify({ error: 'Not authenticated' }), { status: 401 })

  let body: { boardId?: string; messages?: ChatMessage[] }
  try { body = await req.json() } catch { return new Response(JSON.stringify({ error: 'Bad request' }), { status: 400 }) }
  const boardId = body.boardId
  const messages = (body.messages ?? []).filter(m => m.role && (typeof m.content === 'string' || Array.isArray(m.content)))
  if (!boardId || messages.length === 0) return new Response(JSON.stringify({ error: 'boardId and messages required' }), { status: 400 })

  // Resolve which key this request runs on: the user's own key if they've saved
  // one, otherwise the platform key (billed to them at markup). See lib/claude/key.
  let apiKey: string, keySource: KeySource, writesEnabled: boolean
  try {
    ({ apiKey, keySource, writesEnabled } = await resolveAnthropicKey(supabase, user.id))
  } catch (e) {
    if (e instanceof NoClaudeKeyError) return new Response(JSON.stringify({ error: 'no_key' }), { status: 400 })
    if (e instanceof KeyDecryptError) return new Response(JSON.stringify({ error: 'Could not read your stored key. Please re-enter it in Settings.' }), { status: 500 })
    throw e
  }

  // Kill switch + free-tier / pay-per-use gate (platform-key requests only).
  const gate = await claudeGate(supabase, user.id, keySource, user)
  if (!gate.ok) {
    const status = gate.error === 'claude_disabled' ? 503 : 402
    return new Response(JSON.stringify({ error: gate.error, spentUsd: gate.spentUsd, freeUsd: gate.freeUsd }), {
      status, headers: { 'content-type': 'application/json' },
    })
  }

  // Verify the root board is owned by the user before building context.
  const { data: rootBoard } = await supabase.from('boards').select('id').eq('id', boardId).single()
  if (!rootBoard) return new Response(JSON.stringify({ error: 'Board not found' }), { status: 404 })

  const { data: { session } } = await supabase.auth.getSession()
  const accessToken = session?.access_token

  const { allowedIds, systemContext } = await buildClaudeContext(supabase, boardId, accessToken)

  const anthropic = new Anthropic({ apiKey })
  const tools = writesEnabled ? [...READ_TOOLS, ...WRITE_TOOLS] : READ_TOOLS
  const toolCtx: ToolCtx = { supabase, userId: user.id, allowedIds, accessToken, rootBoardId: boardId }

  // Mode is binary: when the user hasn't enabled "Let Claude make changes",
  // the write tools aren't in `tools` at all (above), so there is nothing to
  // confirm — the prompt just has to stop the model from pretending it wrote.
  const modeGuidance = writesEnabled
    ? [
        'WRITE MODE — you have write tools and may change things directly.',
        'When the user asks you to add, create, make, fill, or rename something, just do it with the tools; do not ask for permission first.',
        'After acting, state in one short line what you changed and on which board.',
      ]
    : [
        'READ-ONLY MODE — you have no write tools and cannot change anything.',
        'If the user asks you to create or modify something, do not pretend to. Tell them to turn on "Let Claude make changes" in Settings.',
      ]

  const system = [
    'You are Claude, the assistant built into Syncedsys — a visual workspace where everything lives on boards (also called "tabs").',
    'You are attached to ONE board (the tab the user is currently viewing) and can see and act on that board plus every board reachable downward from it: its sub-boards, and any board its portals or folder-links point to. You can never see or touch a parent or unrelated board.',
    '',
    'BOARD MODES — every board is one of:',
    '- classic: a freeform canvas of positioned elements (text notes, shapes, files, PDFs, portals).',
    '- trello: a kanban board of lists (columns) that hold cards.',
    '- text: a single document (one text body).',
    '- spreadsheet: a grid, also stored as one text body.',
    '- folder: a file explorer of text files.',
    'Match what you create to the mode: lists/cards on trello, set_board_content on text/spreadsheet, text/shape notes on classic, files on folder.',
    '',
    'READING THE CONTEXT BELOW:',
    '- The board marked CURRENT is the one the user is looking at. Default to acting there unless they point you to another board by name.',
    '- Each board shows its name, mode, and id; cards show ✓ (done) or · (todo).',
    '- PDF elements show only an excerpt — call get_board on that board to read a PDF\'s full text.',
    '- Anything between BEGIN/END VIEWER DATA or BEGIN/END SLIDES DATA markers is live embedded data (e.g. stock prices, a spreadsheet, a slide deck). Read it directly; never ask the user what it contains.',
    '',
    'TOOLS:',
    '- get_board(boardId): pull a board\'s full, current contents. Use it before acting when the context excerpt looks truncated or stale.',
    '- Write tools (create_board, create_list, create_card, create_shape, create_file, set_board_content, rename_board) act on Syncedsys boards. Every write is re-validated against your scope server-side, so only ever pass an id that appears in the context. Coordinates (x/y) are optional — on a canvas, place new elements so they don\'t overlap.',
    '- create_url_preview(url, x?, y?): place a rich link-preview card on the user\'s current board. Use it whenever the user shares or asks you to put a URL, product page, listing, or website on the board — it surfaces the link visually (image, title, domain) instead of as plain text. It always targets the current board; do not pass a board id.',
    '- Slides tools (create_presentation, add_slide, add_text_element, …) act on the separate Slides app; use them only when the user is working with a presentation.',
    '',
    ...modeGuidance,
    '',
    'STYLE: the chat panel is small and replies are length-capped — be concise and do the work rather than narrating it. When you reference existing content, name the board/card/element it came from. Never invent ids, names, or data that aren\'t in the context.',
    '',
    systemContext,
  ].join('\n')

  // Anthropic message history (text-only turns from the client).
  const apiMessages: Anthropic.MessageParam[] = messages.map(m => ({ role: m.role, content: m.content }))

  const stream = new ReadableStream({
    async start(controller) {
      // Accumulate token usage across every turn of the agent loop — each
      // messages.stream call is a separate billable API request.
      const agg = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
      let turnsUsed = 0
      let errored = false
      try {
        for (let turn = 0; turn < MAX_TURNS; turn++) {
          const msgStream = anthropic.messages.stream({ model: MODEL, max_tokens: 2048, system, tools, messages: apiMessages })

          msgStream.on('text', (delta: string) => controller.enqueue(sse({ type: 'text', delta })))

          const final = await msgStream.finalMessage()
          turnsUsed++
          const u = final.usage
          agg.input_tokens += u.input_tokens ?? 0
          agg.output_tokens += u.output_tokens ?? 0
          agg.cache_read_input_tokens += u.cache_read_input_tokens ?? 0
          agg.cache_creation_input_tokens += u.cache_creation_input_tokens ?? 0

          // Collect any tool_use blocks the model emitted.
          const toolUses = final.content.filter((b): b is Anthropic.ToolUseBlock => b.type === 'tool_use')
          // Persist this assistant turn (with its tool_use blocks) into history.
          apiMessages.push({ role: 'assistant', content: final.content })

          if (toolUses.length === 0) break // model is done talking

          // Execute each tool, stream activity, and build tool_result blocks.
          const results: Anthropic.ToolResultBlockParam[] = []
          for (const tu of toolUses) {
            controller.enqueue(sse({ type: 'tool', name: tu.name }))
            try {
              const out = await executeTool(tu.name, tu.input as Record<string, unknown>, toolCtx)
              controller.enqueue(sse({ type: 'tool_result', name: tu.name, ok: true }))
              results.push({ type: 'tool_result', tool_use_id: tu.id, content: out })
            } catch (err) {
              const msg = err instanceof ScopeError ? `Blocked: ${err.message}` : (err instanceof Error ? err.message : 'Tool failed')
              controller.enqueue(sse({ type: 'tool_result', name: tu.name, ok: false }))
              results.push({ type: 'tool_result', tool_use_id: tu.id, content: msg, is_error: true })
            }
          }
          apiMessages.push({ role: 'user', content: results })
          // loop again so the model can respond to tool results
        }
        controller.enqueue(sse({ type: 'done' }))
      } catch (err) {
        errored = true
        const message = err instanceof Anthropic.APIError
          ? `Anthropic error: ${err.message}`
          : (err instanceof Error ? err.message : 'Unknown error')
        controller.enqueue(sse({ type: 'error', message }))
      } finally {
        // Record usage on both the success and error paths so partial spend from a
        // mid-loop failure is still billed. Awaited so the insert lands before the
        // serverless function freezes. recordClaudeUsage swallows its own errors.
        await recordClaudeUsage({
          userId: user.id, model: MODEL, keySource, usage: agg, turns: turnsUsed, boardId, errored,
        })
        controller.close()
      }
    },
  })

  return new Response(stream, {
    headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-cache' },
  })
}
