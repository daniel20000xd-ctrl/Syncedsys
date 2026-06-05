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

type ChatMessage = { role: 'user' | 'assistant'; content: string }

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
  const messages = (body.messages ?? []).filter(m => m.role && typeof m.content === 'string')
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
  const gate = await claudeGate(supabase, user.id, keySource)
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
  const toolCtx: ToolCtx = { supabase, userId: user.id, allowedIds, accessToken }

  const system = [
    'You are an assistant embedded inside a visual workspace app, living inside one board ("tab").',
    'Boards have a mode: classic (freeform canvas), trello (kanban), text (document), or folder (file explorer).',
    'Boards can contain lists, cards, and elements (text notes, shapes, files, PDFs, portals).',
    'PDF elements include extracted text — an excerpt is shown inline; call get_board to read the full text of a PDF on a given board.',
    writesEnabled
      ? 'You can MAKE CHANGES using the provided write tools. Prefer doing what the user asks directly. When you create things, briefly say what you made.'
      : 'You are in READ-ONLY mode — you can read and explain but cannot make changes. If the user asks you to create or modify something, tell them to enable "Let Claude make changes" in Settings.',
    'You may only act on boards within your scope (listed below). Never reference or attempt to modify a parent or unrelated board.',
    'Keep responses concise.',
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
