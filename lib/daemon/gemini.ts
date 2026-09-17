import { daemonEnv } from './env'
import { recordUsage, isOverBudget } from './usage'
import { SchemaInvalidError } from './schemas'
import { sendFailureAlert } from './alert'

export type CallType = 'input' | 'heartbeat' | 'reflection'
export type Turn = { role: 'user' | 'model'; text: string }

export class GeminiError extends Error {}
export class OverBudgetError extends Error {}

const ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/models'
const MAX_ATTEMPTS = 3
// Routes have maxDuration = 60; leave headroom for context assembly and DB writes.
const TOTAL_BUDGET_MS = 45_000

type GenerateArgs<T> = {
  callType: CallType
  userId: string
  system: string
  turns: Turn[]
  schema: object
  validate: (v: unknown) => T
}

type GeminiResponse = {
  candidates?: { content?: { parts?: { text?: string; thought?: boolean }[] }; finishReason?: string }[]
  usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number; thoughtsTokenCount?: number }
  promptFeedback?: { blockReason?: string }
  error?: { message?: string }
}

class Retryable extends Error {}

export async function generate<T>(args: GenerateArgs<T>): Promise<{ data: T; usageId: string | null }> {
  const apiKey = process.env.GEMINI_API_KEY
  const model = daemonEnv.model()
  if (!apiKey || !model) throw new GeminiError('GEMINI_API_KEY and DAEMON_GEMINI_MODEL must be set')
  // Last-line backstop; routes also check before calling.
  if (await isOverBudget()) throw new OverBudgetError('daily cost cap reached')

  const started = Date.now()
  let lastError = 'unknown error'

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const remaining = TOTAL_BUDGET_MS - (Date.now() - started)
    if (remaining < 3_000) break
    let inputTokens = 0
    let outputTokens = 0
    try {
      const res = await fetch(`${ENDPOINT}/${encodeURIComponent(model)}:generateContent`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-goog-api-key': apiKey },
        signal: AbortSignal.timeout(remaining),
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: args.system }] },
          contents: args.turns.map(t => ({ role: t.role, parts: [{ text: t.text }] })),
          generationConfig: {
            responseMimeType: 'application/json',
            responseJsonSchema: args.schema,
          },
        }),
      })
      const body = (await res.json().catch(() => ({}))) as GeminiResponse
      inputTokens = body.usageMetadata?.promptTokenCount ?? 0
      outputTokens = (body.usageMetadata?.candidatesTokenCount ?? 0) + (body.usageMetadata?.thoughtsTokenCount ?? 0)

      if (!res.ok) {
        const msg = `HTTP ${res.status}: ${body.error?.message ?? res.statusText}`
        if (res.status === 429 || res.status >= 500) throw new Retryable(msg)
        throw new GeminiError(msg)
      }
      const text = (body.candidates?.[0]?.content?.parts ?? [])
        .filter(p => !p.thought && typeof p.text === 'string')
        .map(p => p.text)
        .join('')
      if (!text) {
        throw new Retryable(`empty response (finish=${body.candidates?.[0]?.finishReason ?? body.promptFeedback?.blockReason ?? 'none'})`)
      }
      let parsed: unknown
      try {
        parsed = JSON.parse(text)
      } catch {
        throw new Retryable('response was not valid JSON')
      }
      const data = args.validate(parsed)
      const usageId = await recordUsage({ userId: args.userId, callType: args.callType, model, inputTokens, outputTokens, attempt })
      return { data, usageId }
    } catch (e) {
      const retryable = e instanceof Retryable || e instanceof SchemaInvalidError
        || (e instanceof Error && (e.name === 'TimeoutError' || e.name === 'AbortError' || e.name === 'TypeError'))
      lastError = e instanceof SchemaInvalidError ? `schema invalid: ${e.message}` : (e as Error).message
      await recordUsage({ userId: args.userId, callType: args.callType, model, inputTokens, outputTokens, attempt, error: lastError })
      if (!retryable) break
      if (attempt < MAX_ATTEMPTS) await new Promise(r => setTimeout(r, 1000 * 2 ** (attempt - 1)))
    }
  }

  await sendFailureAlert(`${args.callType} call failed`, lastError)
  throw new GeminiError(lastError)
}
