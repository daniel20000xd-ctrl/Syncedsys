// Any subdomain of syncedsys.com (including the apex) is allowed.
// Pattern covers https://syncedsys.com and https://*.syncedsys.com.
// Adding a new satellite requires no change here.
const ALLOWED = /^https:\/\/([\w-]+\.)?syncedsys\.com$/

export function getCorsHeaders(origin: string | null): Record<string, string> {
  if (!origin || !ALLOWED.test(origin)) return {}
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Credentials': 'true',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  }
}
