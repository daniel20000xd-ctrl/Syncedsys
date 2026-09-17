import { daemonEnv } from './env'

function parts(d: Date, tz: string) {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz, hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  })
  const p = Object.fromEntries(fmt.formatToParts(d).map(x => [x.type, x.value]))
  return {
    date: `${p.year}-${p.month}-${p.day}`,
    hour: Number(p.hour), minute: Number(p.minute), second: Number(p.second),
  }
}

export function localDate(d: Date = new Date(), tz = daemonEnv.tz()): string {
  return parts(d, tz).date
}

export function localHour(d: Date = new Date(), tz = daemonEnv.tz()): number {
  return parts(d, tz).hour
}

export function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + days)
  return d.toISOString().slice(0, 10)
}

export function monthOf(date: string): string {
  return date.slice(0, 7)
}

// Approximate on DST-transition days (off by the shifted hour), which is fine for
// "today's spend" and "today's messages".
export function startOfLocalDay(d: Date = new Date(), tz = daemonEnv.tz()): Date {
  const p = parts(d, tz)
  return new Date(d.getTime() - (p.hour * 3600 + p.minute * 60 + p.second) * 1000 - d.getMilliseconds())
}

export function isWakingHours(d: Date = new Date()): boolean {
  const h = localHour(d)
  const wake = daemonEnv.wakeHour()
  const sleep = daemonEnv.sleepHour()
  return wake <= sleep ? h >= wake && h < sleep : h >= wake || h < sleep
}

// The nightly reflection runs in the small hours, so before wake time it is
// reflecting on the previous local day.
export function reflectionDay(d: Date = new Date()): string {
  const today = localDate(d)
  return localHour(d) < daemonEnv.wakeHour() ? addDays(today, -1) : today
}

export function describeNow(d: Date = new Date()): string {
  const tz = daemonEnv.tz()
  const human = new Intl.DateTimeFormat('en-GB', {
    timeZone: tz, weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).format(d)
  return `Current time: ${human} (${tz}); UTC ${d.toISOString()}`
}
