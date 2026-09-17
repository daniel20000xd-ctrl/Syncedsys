import { createAdminClient } from '@/lib/supabase/admin'
import { appendDayBlock, migrateLegacyDaylog } from './files'
import { getState, updateState } from './state'
import { localDate } from './time'
import { daemonEnv } from './env'

// The day log accumulates in daemon_day_entries during the day and is flushed to the
// R2 daylog/ family at reflection. Rows are kept as ground truth.

export type DayEntry = {
  id: string
  entry_date: string
  call_type: 'input' | 'heartbeat' | 'reflection'
  thread_id: string | null
  content: string
  created_at: string
}

export async function appendDayEntry(
  userId: string, callType: DayEntry['call_type'], content: string, threadId: string | null,
): Promise<void> {
  const text = content.trim()
  if (!text) return
  const { error } = await createAdminClient().from('daemon_day_entries').insert({
    user_id: userId, entry_date: localDate(), call_type: callType, thread_id: threadId, content: text,
  })
  if (error) console.error('[daemon/daylog] append failed:', error.message)
}

export async function loadDayEntries(userId: string, date: string): Promise<DayEntry[]> {
  const { data, error } = await createAdminClient()
    .from('daemon_day_entries')
    .select('*')
    .eq('user_id', userId)
    .eq('entry_date', date)
    .order('created_at', { ascending: true })
  if (error) throw new Error(`day entries read failed: ${error.message}`)
  return (data ?? []) as DayEntry[]
}

function hhmm(iso: string): string {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: daemonEnv.tz(), hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).format(new Date(iso))
}

export function renderDayEntries(entries: DayEntry[]): string {
  return entries
    .map(e => `- ${hhmm(e.created_at)} [${e.call_type}${e.thread_id ? ` thread:${e.thread_id}` : ''}] ${e.content}`)
    .join('\n')
}

export async function assembleDayLog(userId: string, date: string): Promise<string> {
  return renderDayEntries(await loadDayEntries(userId, date))
}

// The model's assembled account of the day, followed by the raw entries verbatim.
export async function flushDayLog(userId: string, date: string, dayLogClose: string): Promise<void> {
  const entries = await assembleDayLog(userId, date)
  const body = entries ? `${dayLogClose.trim()}\n\n### Entries\n\n${entries}` : dayLogClose.trim()
  await appendDayBlock(userId, 'daylog', date, body)
}

// One-time move of v1 day-log files from daemon/reflection/ to daemon/daylog/.
export async function ensureDaylogMigrated(userId: string): Promise<void> {
  const state = await getState()
  if (state.daylog_migrated_at) return
  const moved = await migrateLegacyDaylog(userId)
  if (moved) console.log(`[daemon/daylog] migrated ${moved} legacy file(s) to daylog/`)
  await updateState({ daylog_migrated_at: new Date().toISOString() })
}
