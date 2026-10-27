import test from 'node:test'
import assert from 'node:assert/strict'
import { getValidSession, invokeWithSessionRefresh } from './session.js'

const validSession = (token = 'access-token', expiresAt = Math.floor(Date.now() / 1000) + 3600) => ({
  access_token: token,
  refresh_token: 'refresh-token',
  expires_at: expiresAt,
})

test('uses a valid persisted session without refreshing it', async () => {
  const session = validSession()
  let refreshes = 0
  const auth = {
    getSession: async () => ({ data: { session }, error: null }),
    refreshSession: async () => { refreshes++; return { data: { session: validSession('refreshed') }, error: null } },
  }

  assert.equal(await getValidSession(auth), session)
  assert.equal(refreshes, 0)
})

test('refreshes a session before its access token expires', async () => {
  const refreshed = validSession('fresh-token')
  const auth = {
    getSession: async () => ({ data: { session: validSession('nearly-expired', Math.floor(Date.now() / 1000)) }, error: null }),
    refreshSession: async () => ({ data: { session: refreshed }, error: null }),
  }

  assert.equal(await getValidSession(auth), refreshed)
})

test('refreshes and retries an Edge Function request once after a 401', async () => {
  const refreshed = validSession('fresh-token')
  let refreshes = 0
  const tokens = []
  const auth = {
    getSession: async () => ({ data: { session: validSession() }, error: null }),
    refreshSession: async () => { refreshes++; return { data: { session: refreshed }, error: null } },
  }
  const result = await invokeWithSessionRefresh(auth, async session => {
    tokens.push(session.access_token)
    return tokens.length === 1
      ? { data: null, error: { context: { status: 401 } } }
      : { data: { ok: true }, error: null }
  })

  assert.equal(refreshes, 1)
  assert.deepEqual(tokens, ['access-token', 'fresh-token'])
  assert.deepEqual(result.data, { ok: true })
})

test('does not refresh or retry authorization failures', async () => {
  let refreshes = 0
  let calls = 0
  const auth = {
    getSession: async () => ({ data: { session: validSession() }, error: null }),
    refreshSession: async () => { refreshes++; return { data: { session: validSession('fresh') }, error: null } },
  }
  const result = await invokeWithSessionRefresh(auth, async () => {
    calls++
    return { data: null, error: { context: { status: 403 } } }
  })

  assert.equal(calls, 1)
  assert.equal(refreshes, 0)
  assert.equal(result.error.context.status, 403)
})
