import type { SupabaseClient } from '@supabase/supabase-js'

export type RecurCard = {
  id: string
  done: boolean
  done_at: string | null
  recur_interval_minutes: number | null
}

// Flips `done` back to false for recurring cards whose interval has elapsed
// since they were last completed. Mutates the passed `cards` array in place so
// the caller can render the reconciled state immediately, and persists the
// change to the database. Safe to call with any supabase client (RLS or admin).
export async function resetDueRecurringCards<T extends RecurCard>(
  supabase: SupabaseClient,
  cards: T[],
): Promise<void> {
  const now = Date.now()
  const due = cards.filter(
    c =>
      c.recur_interval_minutes != null &&
      c.done &&
      c.done_at != null &&
      new Date(c.done_at).getTime() + c.recur_interval_minutes * 60_000 <= now,
  )
  if (due.length === 0) return

  await Promise.all(
    due.map(c =>
      supabase.from('cards').update({ done: false, done_at: null }).eq('id', c.id),
    ),
  )

  for (const c of due) {
    c.done = false
    c.done_at = null
  }
}

// Human label for an interval in minutes. e.g. 60 -> "Hourly", 1440 -> "Daily".
export function recurLabel(min: number): string {
  if (min % 1440 === 0) {
    const d = min / 1440
    return d === 1 ? 'Daily' : `Every ${d} days`
  }
  if (min % 60 === 0) {
    const h = min / 60
    return h === 1 ? 'Hourly' : `Every ${h} hours`
  }
  return min === 1 ? 'Every minute' : `Every ${min} min`
}
