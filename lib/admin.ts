// Whether an email is the configured admin. Case-insensitive and trimmed: Supabase
// lowercases auth emails, but ADMIN_EMAIL may be stored with different casing or
// stray whitespace, so normalize both sides rather than comparing raw with ===.
export function isAdminEmail(email?: string | null): boolean {
  const admin = process.env.ADMIN_EMAIL?.trim().toLowerCase()
  return !!admin && !!email && email.trim().toLowerCase() === admin
}
