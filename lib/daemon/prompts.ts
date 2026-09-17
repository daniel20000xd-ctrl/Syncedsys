import { createAdminClient } from '@/lib/supabase/admin'
import { sendFailureAlert } from './alert'
import type { CallType } from './gemini'

// Read-only access to the active prompts. Prompts are written only by the admin console
// (app/daemonActions.ts); nothing in the daemon runtime writes them.

export type PromptKind = 'system' | CallType
export type ActivePrompt = { kind: PromptKind; version: number; content: string }

export type ResolvedPrompt = {
  text: string
  systemVersion: number | null
  callVersion: number | null
}

// A draft used only by a dry run: it replaces one kind's content for that call and is
// never stored.
export type PromptOverride = { kind: PromptKind; content: string }

export class PromptMissingError extends Error {}

export async function getActivePrompt(kind: PromptKind): Promise<ActivePrompt | null> {
  const { data, error } = await createAdminClient()
    .from('daemon_prompts')
    .select('kind, version, content')
    .eq('kind', kind)
    .eq('is_active', true)
    .maybeSingle()
  if (error) throw new Error(`prompt read failed (${kind}): ${error.message}`)
  return data && data.content.trim() ? (data as ActivePrompt) : null
}

// The shared system prompt followed by the per-call block. The system prompt is
// required: without it the call aborts before reaching the model. The per-call block
// is optional (none are seeded).
export async function resolvePrompt(callType: CallType, override?: PromptOverride): Promise<ResolvedPrompt> {
  const [system, call] = await Promise.all([getActivePrompt('system'), getActivePrompt(callType)])
  const systemText = override?.kind === 'system' ? override.content : system?.content
  const callText = override?.kind === callType ? override.content : call?.content

  if (!systemText?.trim()) {
    const message = `no active system prompt; ${callType} call aborted before reaching the model`
    await sendFailureAlert('daemon prompt missing', message)
    throw new PromptMissingError(message)
  }

  return {
    text: callText?.trim() ? `${systemText}\n\n${callText}` : systemText,
    systemVersion: override?.kind === 'system' ? null : system?.version ?? null,
    callVersion: override?.kind === callType ? null : call?.version ?? null,
  }
}
