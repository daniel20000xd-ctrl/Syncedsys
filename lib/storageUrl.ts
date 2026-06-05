// Base URL for the storage satellite. Override in .env.local for local dev:
//   NEXT_PUBLIC_STORAGE_URL=http://localhost:3001
export const STORAGE_URL = process.env.NEXT_PUBLIC_STORAGE_URL ?? 'https://storage.syncedsys.com'
