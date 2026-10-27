export const corsHeaders = Object.freeze({
  'Access-Control-Allow-Headers': 'authorization, apikey, x-client-info, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Max-Age': '86400',
  Vary: 'Origin',
})

export const productionOrigin = 'https://jpcs-members.vercel.app'
const localOriginPattern = /^http:\/\/(?:localhost|127\.0\.0\.1)(?::\d+)?$/i

export function normalizeOrigin(value) {
  if (typeof value !== 'string' || !value.trim() || value.trim().toLowerCase() === 'null') return ''
  const input = value.trim()
  try {
    const url = new URL(input.includes('://') ? input : `https://${input}`)
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return ''
    return url.origin
  } catch {
    return ''
  }
}

export function resolveCorsOrigin(requestOrigin, appOrigin) {
  const configuredOrigin = normalizeOrigin(appOrigin)
  const requestOriginValue = typeof requestOrigin === 'string' && requestOrigin.length > 0
  if (!requestOriginValue) {
    return { allowed: true, origin: null, configuredOrigin }
  }

  const origin = normalizeOrigin(requestOrigin)
  const allowed = new Set([productionOrigin, configuredOrigin].filter(Boolean))
  if (!origin) return { allowed: false, origin: null, configuredOrigin }
  if (allowed.has(origin) || localOriginPattern.test(origin)) {
    return { allowed: true, origin, configuredOrigin }
  }
  return { allowed: false, origin: null, configuredOrigin }
}

export function corsHeadersFor(origin) {
  const headers = new Headers(corsHeaders)
  if (origin) headers.set('Access-Control-Allow-Origin', origin)
  return headers
}

export function corsResponse(body, status, origin) {
  const headers = corsHeadersFor(origin)
  for (const [name, value] of Object.entries({
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store',
    Pragma: 'no-cache',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
  })) headers.set(name, value)
  return new Response(JSON.stringify(body), { status, headers })
}
