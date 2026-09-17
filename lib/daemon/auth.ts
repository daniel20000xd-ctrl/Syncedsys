import { timingSafeEqual, createHash } from 'crypto'
import type { NextRequest } from 'next/server'

function bearer(req: NextRequest): string {
  return (req.headers.get('authorization') ?? '').replace(/^Bearer\s+/i, '').trim()
}

// Hashing first makes the comparison constant-time regardless of length.
function safeEqual(a: string, b: string): boolean {
  return timingSafeEqual(createHash('sha256').update(a).digest(), createHash('sha256').update(b).digest())
}

export function isCronAuthorized(req: NextRequest): boolean {
  const secret = process.env.CRON_SECRET
  return !!secret && safeEqual(bearer(req), secret)
}

export function isDeviceAuthorized(req: NextRequest): boolean {
  const secret = process.env.DAEMON_DEVICE_SECRET
  return !!secret && safeEqual(bearer(req), secret)
}
