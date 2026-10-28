import test from 'node:test'
import assert from 'node:assert/strict'
import { getValidSession, invokeWithSessionRefresh, refreshSession } from './session.js'

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

test('does not rotate refresh tokens when session storage lookup fails', async () => {
  let refreshes = 0
  const auth = {
    getSession: async () => ({ data: { session: null }, error: new Error('temporary storage failure') }),
    refreshSession: async () => { refreshes++; return { data: { session: validSession('fresh') }, error: null } },
  }

  await assert.rejects(getValidSession(auth), /temporary storage failure/)
  assert.equal(refreshes, 0)
})

test('lets Supabase return its current session without manually refreshing near expiry', async () => {
  const current = validSession('nearly-expired', Math.floor(Date.now() / 1000))
  let refreshes = 0
  const auth = {
    getSession: async () => ({ data: { session: current }, error: null }),
    refreshSession: async () => { refreshes++; return { data: { session: validSession('fresh-token') }, error: null } },
  }

  assert.equal(await getValidSession(auth), current)
  assert.equal(refreshes, 0)
})

test('refreshes and retries a read-only Edge Function request once after a 401', async () => {
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
  }, { retryUnauthorized: true })

  assert.equal(refreshes, 1)
  assert.deepEqual(tokens, ['access-token', 'fresh-token'])
  assert.deepEqual(result.data, { ok: true })
})

test('does not retry a state-changing request after a 401', async () => {
  let refreshes = 0
  let calls = 0
  const auth = {
    getSession: async () => ({ data: { session: validSession() }, error: null }),
    refreshSession: async () => { refreshes++; return { data: { session: validSession('fresh') }, error: null } },
  }
  const result = await invokeWithSessionRefresh(auth, async () => {
    calls++
    return { data: null, error: { context: { status: 401 } } }
  })

  assert.equal(calls, 1)
  assert.equal(refreshes, 0)
  assert.equal(result.error.context.status, 401)
})

test('does not refresh or retry after a transient request failure', async () => {
  let refreshes = 0
  let calls = 0
  const auth = {
    getSession: async () => ({ data: { session: validSession() }, error: null }),
    refreshSession: async () => { refreshes++; return { data: { session: validSession('fresh') }, error: null } },
  }

  await assert.rejects(invokeWithSessionRefresh(auth, async () => {
    calls++
    throw new TypeError('Failed to fetch')
  }), /Failed to fetch/)
  assert.equal(calls, 1)
  assert.equal(refreshes, 0)
})

test('does not loop when a revoked refresh token cannot recover a read-only request', async () => {
  let refreshes = 0
  let calls = 0
  const auth = {
    getSession: async () => ({ data: { session: validSession() }, error: null }),
    refreshSession: async () => {
      refreshes++
      return { data: { session: null }, error: Object.assign(new Error('Refresh token revoked'), { code: 'invalid_refresh_token' }) }
    },
  }
  const originalWarn = console.warn
  console.warn = () => {}
  try {
    const result = await invokeWithSessionRefresh(auth, async () => {
      calls++
      return { data: null, error: { context: { status: 401 } } }
    }, { retryUnauthorized: true })

    assert.equal(result.error.context.status, 401)
    assert.equal(calls, 1)
    assert.equal(refreshes, 1)
  } finally {
    console.warn = originalWarn
  }
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

test('shares one refresh request across concurrent callers', async () => {
  let refreshes = 0
  let resolveRefresh
  const refreshed = validSession('fresh-token')
  const auth = {
    getSession: async () => ({ data: { session: validSession() }, error: null }),
    refreshSession: async () => {
      refreshes++
      return new Promise(resolve => { resolveRefresh = resolve })
    },
  }

  const first = refreshSession(auth)
  const second = refreshSession(auth)
  await new Promise(resolve => setImmediate(resolve))
  resolveRefresh({ data: { session: refreshed }, error: null })

  assert.equal(await first, refreshed)
  assert.equal(await second, refreshed)
  assert.equal(refreshes, 1)
})

test('does not repeatedly submit a refresh token Supabase has rejected', async () => {
  let refreshes = 0
  const authError = Object.assign(new Error('Invalid Refresh Token: Refresh Token Not Found'), { code: 'refresh_token_not_found' })
  const auth = {
    getSession: async () => ({ data: { session: validSession() }, error: null }),
    refreshSession: async () => { refreshes++; return { data: { session: null }, error: authError } },
  }
  const originalWarn = console.warn
  console.warn = () => {}
  try {
    await assert.rejects(refreshSession(auth), /Refresh Token Not Found/)
    await assert.rejects(refreshSession(auth), /Refresh Token Not Found/)
    assert.equal(refreshes, 1)
  } finally {
    console.warn = originalWarn
  }
})
