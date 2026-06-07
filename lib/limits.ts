import { isAdminEmail } from '@/lib/admin'
import { freeAllowanceUsd } from '@/lib/claude/pricing'
import { STORAGE_LIMIT_BYTES } from '@/lib/r2'

export type AccountLimits = {
  apiCreditUsd: number | null  // null = unlimited
  storageBytes: number | null  // null = unlimited
  // Rate limits are intentionally NOT here — they apply equally to everyone,
  // including admin.
}

const ADMIN_LIMITS: AccountLimits = {
  apiCreditUsd: null,
  storageBytes: null,
}

export function isAdmin(user: { email?: string | null } | null | undefined): boolean {
  return isAdminEmail(user?.email)
}

export function getAccountLimits(
  user: { email?: string | null } | null | undefined,
): AccountLimits {
  if (isAdmin(user)) return ADMIN_LIMITS
  return {
    apiCreditUsd: freeAllowanceUsd(),
    storageBytes: STORAGE_LIMIT_BYTES,
  }
}
