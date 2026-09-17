import { buildHeartbeatTurns, buildInputTurns, buildMetaTurns, buildReflectionTurns } from './context'
import { generate, type CallType, type Turn } from './gemini'
import { computeMetrics } from './metrics'
import { resolvePrompt, type PromptOverride } from './prompts'
import {
  HEARTBEAT_SCHEMA, INPUT_SCHEMA, META_SCHEMA, REFLECTION_SCHEMA,
  validateHeartbeat, validateInput, validateMeta, validateReflection,
} from './schemas'
import { getDaemonUserId, getState } from './state'
import { getModelFor } from './models'

// Manual triggers and dry runs are dev-only unless explicitly enabled in production.
export function debugAllowed(): boolean {
  return process.env.NODE_ENV !== 'production' || process.env.DAEMON_DEBUG_ENABLED === 'true'
}

export const DRY_RUN_TYPES = ['input', 'heartbeat', 'reflection', 'meta'] as const

// Builds the real context for a call and returns what the model would answer, with an
// optional draft prompt substituted. Nothing is applied: no memory writes, no state,
// no threads, no messages, no pushes, and the override is never stored. The model call
// itself is recorded in the usage ledger (flagged dry_run) so it counts toward the cap.
export async function dryRun(opts: {
  callType: CallType
  override?: PromptOverride
  message?: string
}): Promise<{
  prompt: { system_version: number | null; call_version: number | null; overridden: string | null }
  model: string
  response: unknown
}> {
  if (!(await getState()).enabled) throw new Error('daemon is disabled; dry runs are blocked by the kill switch')
  const userId = await getDaemonUserId()

  let turns: Turn[]
  let schema: object
  let validate: (v: unknown) => unknown
  switch (opts.callType) {
    case 'input':
      if (!opts.message?.trim()) throw new Error('an input dry run needs a sample message')
      turns = await buildInputTurns(userId, null, [opts.message.trim()])
      schema = INPUT_SCHEMA
      validate = validateInput
      break
    case 'heartbeat':
      turns = await buildHeartbeatTurns(userId)
      schema = HEARTBEAT_SCHEMA
      validate = validateHeartbeat
      break
    case 'reflection':
      turns = await buildReflectionTurns(userId)
      schema = REFLECTION_SCHEMA
      validate = validateReflection
      break
    case 'meta':
      turns = await buildMetaTurns(userId, await computeMetrics(userId, 7))
      schema = META_SCHEMA
      validate = validateMeta
      break
  }

  const [prompt, modelCfg] = await Promise.all([resolvePrompt(opts.callType, opts.override), getModelFor(opts.callType, userId)])
  const { data } = await generate({
    callType: opts.callType, userId, prompt, turns, schema, validate, dryRun: true,
    model: modelCfg.model, maxOutputTokens: modelCfg.maxOutputTokens,
  })
  return {
    prompt: { system_version: prompt.systemVersion, call_version: prompt.callVersion, overridden: opts.override?.kind ?? null },
    model: modelCfg.model,
    response: data,
  }
}
