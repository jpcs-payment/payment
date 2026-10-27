import test from 'node:test'
import assert from 'node:assert/strict'
import { corsHeadersFor, corsResponse, resolveCorsOrigin } from './cors.js'

const origin = 'https://jpcs-members.vercel.app'

test('allows preflight from the current Vercel production origin', () => {
  const policy = resolveCorsOrigin(origin, 'https://jpcs-members.vercel.app')
  const response = new Response(null, {
    status: 204,
    headers: corsHeadersFor(policy.origin),
  })

  assert.equal(policy.allowed, true)
  assert.equal(response.status, 204)
  assert.equal(response.headers.get('access-control-allow-origin'), origin)
  assert.match(response.headers.get('access-control-allow-methods'), /OPTIONS/)
  for (const header of ['authorization', 'apikey', 'x-client-info', 'content-type']) {
    assert.ok(response.headers.get('access-control-allow-headers').includes(header))
  }
})

test('rejects an unauthorized origin without reflecting it or returning the string null', () => {
  const policy = resolveCorsOrigin('https://untrusted.example', origin)
  const response = corsResponse({ error: 'Origin not allowed.' }, 403, policy.origin)

  assert.equal(policy.allowed, false)
  assert.equal(response.status, 403)
  assert.equal(response.headers.get('access-control-allow-origin'), null)
  assert.notEqual(response.headers.get('access-control-allow-origin'), 'null')
})

test('normal payment responses from the allowed origin carry CORS headers', async () => {
  const policy = resolveCorsOrigin(origin, 'jpcs-members.vercel.app')
  const response = corsResponse({ ok: true, registration: { id: 'registration-id' } }, 201, policy.origin)

  assert.equal(policy.allowed, true)
  assert.equal(response.status, 201)
  assert.equal(response.headers.get('access-control-allow-origin'), origin)
  assert.deepEqual(await response.json(), { ok: true, registration: { id: 'registration-id' } })
})

test('allowed-origin error responses preserve CORS headers', async () => {
  const policy = resolveCorsOrigin(origin, origin)
  const response = corsResponse({ error: 'Invalid session.' }, 401, policy.origin)

  assert.equal(response.status, 401)
  assert.equal(response.headers.get('access-control-allow-origin'), origin)
  assert.deepEqual(await response.json(), { error: 'Invalid session.' })
})

test('malformed APP_ORIGIN does not cause an allowed origin to become null', () => {
  const policy = resolveCorsOrigin(origin, 'jpcs-members.vercel.app')
  assert.equal(policy.allowed, true)
  assert.equal(policy.origin, origin)
})
