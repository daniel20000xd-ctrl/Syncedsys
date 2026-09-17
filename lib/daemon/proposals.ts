import { createAdminClient } from '@/lib/supabase/admin'
import { daemonEnv } from './env'
import { recordWarning } from './usage'
import { UUID } from './threads'

// Proposals are inert data. This module only stores them, records the user's verdicts,
// and sweeps stale ones. Nothing here (or anywhere) applies a proposal to anything.

export type ProposalRow = {
  id: string
  cycle_at: string
  category: string
  direction: string
  title: string
  body: string
  evidence: Record<string, unknown>
  verdict: string
  verdict_reason: string | null
  verdict_at: string | null
  supersedes: string | null
  created_at: string
}

export type NewProposal = {
  category: string
  direction: string
  title: string
  body: string
  evidence_paths: string[]
  supersedes: string | null
}

export type VerdictAction = {
  proposal_id: string
  verdict: 'accepted' | 'rejected' | 'implemented'
  reason: string
  user_quote: string
}

export async function listProposals(userId: string, opts: { verdicts?: string[] } = {}): Promise<ProposalRow[]> {
  let q = createAdminClient().from('daemon_proposals').select('*').eq('user_id', userId)
  if (opts.verdicts) q = q.in('verdict', opts.verdicts)
  const { data, error } = await q.order('created_at', { ascending: true })
  if (error) throw new Error(`proposals read failed: ${error.message}`)
  return (data ?? []) as ProposalRow[]
}

// Evidence is resolved by code from the metrics object, so a proposal records what was
// actually true at the time rather than what the model says was true.
export function resolveEvidence(metrics: unknown, paths: string[]): Record<string, unknown> {
  const evidence: Record<string, unknown> = {}
  const unresolved: string[] = []
  for (const path of paths) {
    let cur: unknown = metrics
    for (const part of path.split('.')) {
      cur = cur !== null && typeof cur === 'object' && part in (cur as object) ? (cur as Record<string, unknown>)[part] : undefined
    }
    if (cur === undefined) unresolved.push(path)
    else evidence[path] = cur
  }
  if (unresolved.length) evidence._unresolved_paths = unresolved
  return evidence
}

export async function writeProposals(
  userId: string, cycleAt: string, proposals: NewProposal[], metrics: unknown,
): Promise<string[]> {
  if (!proposals.length) return []
  const admin = createAdminClient()
  const known = new Set((await listProposals(userId)).map(p => p.id))
  const rows = proposals.map(p => ({
    user_id: userId,
    cycle_at: cycleAt,
    category: p.category,
    direction: p.direction,
    title: p.title,
    body: p.body,
    evidence: resolveEvidence(metrics, p.evidence_paths),
    supersedes: p.supersedes && UUID.test(p.supersedes) && known.has(p.supersedes) ? p.supersedes : null,
  }))
  const { data, error } = await admin.from('daemon_proposals').insert(rows).select('id')
  if (error) throw new Error(`proposals write failed: ${error.message}`)

  const max = daemonEnv.maxProposalsPerCycle()
  if (proposals.length > max) {
    await recordWarning(userId, 'meta', `meta cycle ${cycleAt} produced ${proposals.length} proposals (cap ${max}); all stored`)
  }
  return (data ?? []).map(r => r.id as string)
}

// Code-side sweep, run by the meta job: open proposals with no verdict for too long.
export async function supersedeStaleProposals(userId: string): Promise<number> {
  const cutoff = new Date(Date.now() - daemonEnv.proposalStaleDays() * 86_400_000).toISOString()
  const { data, error } = await createAdminClient().from('daemon_proposals')
    .update({
      verdict: 'superseded',
      verdict_reason: `no verdict after ${daemonEnv.proposalStaleDays()} days`,
      verdict_at: new Date().toISOString(),
    })
    .eq('user_id', userId).eq('verdict', 'open').lt('created_at', cutoff)
    .select('id')
  if (error) throw new Error(`proposal sweep failed: ${error.message}`)
  return data?.length ?? 0
}

const VERDICT_WORDS: Record<VerdictAction['verdict'], RegExp> = {
  accepted: /\b(accept|accepted|approve|approved|yes|yep|agree|agreed|go ahead|do it|sounds good|ok|okay|sure)\b/i,
  rejected: /\b(reject|rejected|no|nope|decline|declined|don'?t|do not|veto|drop it|not doing)\b/i,
  implemented: /\b(implement|implemented|done|shipped|built|deployed|added|changed|made the change)\b/i,
}

const normalize = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').trim()

// A verdict only counts if the user gave it in this call's own messages: the model must
// quote the user's words verbatim, and the quote must read as that verdict. Anything
// else is dropped and logged.
export async function applyVerdict(userId: string, action: VerdictAction, userMessages: string[]): Promise<boolean> {
  const drop = async (why: string) => {
    await recordWarning(userId, 'input', `dropped verdict op (${why}): ${JSON.stringify(action)}`)
    return false
  }
  if (!UUID.test(action.proposal_id)) return drop('invalid proposal id')
  const quote = normalize(action.user_quote)
  if (quote.length < 2) return drop('no user quote')
  if (!userMessages.some(m => normalize(m).includes(quote))) return drop('quote not found in the user message')
  if (!VERDICT_WORDS[action.verdict].test(quote)) return drop('quote does not express this verdict')

  const { data, error } = await createAdminClient().from('daemon_proposals')
    .update({ verdict: action.verdict, verdict_reason: action.reason, verdict_at: new Date().toISOString() })
    .eq('user_id', userId).eq('id', action.proposal_id)
    .select('id')
  if (error) return drop(`update failed: ${error.message}`)
  if (!data?.length) return drop('unknown proposal')
  return true
}
