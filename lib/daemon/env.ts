function int(name: string, fallback: number): number {
  const n = Number.parseInt(process.env[name] ?? '', 10)
  return Number.isFinite(n) ? n : fallback
}

export const daemonEnv = {
  tz: () => process.env.DAEMON_TZ || 'Europe/Stockholm',
  wakeHour: () => int('DAEMON_WAKE_HOUR', 8),
  sleepHour: () => int('DAEMON_SLEEP_HOUR', 23),
  maxGapMinutes: () => int('DAEMON_MAX_GAP_MINUTES', 90),
  lockTimeoutSeconds: () => int('DAEMON_LOCK_TIMEOUT_SECONDS', 120),
  threadStaleDays: () => int('DAEMON_THREAD_STALE_DAYS', 3),
  notesMaxChars: () => int('DAEMON_NOTES_MAX_CHARS', 6000),
  model: () => process.env.DAEMON_GEMINI_MODEL?.trim() || '',
  // Unset or unparseable → null; usage.ts treats that as over budget (fail closed).
  dailyCostCapUsd: (): number | null => {
    const n = Number.parseFloat(process.env.DAEMON_DAILY_COST_CAP_USD ?? '')
    return Number.isFinite(n) && n >= 0 ? n : null
  },
}
