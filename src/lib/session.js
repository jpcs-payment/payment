const refreshInFlightByAuth = new WeakMap()
const rejectedRefreshByAuth = new WeakMap()

export const isInvalidRefreshTokenError = error =>
  error?.code === 'refresh_token_not_found' ||
  error?.code === 'invalid_refresh_token' ||
  /refresh token (?:not found|is invalid|has been revoked|already used)/i.test(String(error?.message || ''))

export async function refreshSession(auth) {
  const initialSession = await getValidSession(auth)
  const refreshToken = initialSession.refresh_token

  // A rejected token remains unusable until Supabase provides a different one
  // (for example, after the member signs in again). Avoid retrying it on every
  // protected request while the app is waiting for reauthentication.
  const rejected = rejectedRefreshByAuth.get(auth)
  if (refreshToken && refreshToken === rejected?.token) throw rejected.error
  const existingRefresh = refreshInFlightByAuth.get(auth)
  if (existingRefresh) return existingRefresh

  const pendingRefresh = (async () => {
    // Another caller may have refreshed while this caller was waiting.
    const latestSession = await getValidSession(auth)
    if (refreshToken && latestSession.refresh_token !== refreshToken) return latestSession

    const { data, error } = await auth.refreshSession()
    if (error) {
      console.warn('[auth] Explicit token recovery failed.', { name: error.name, code: error.code })
      if (refreshToken && isInvalidRefreshTokenError(error)) {
        rejectedRefreshByAuth.set(auth, { token: refreshToken, error })
      }
      throw error
    }
    if (!data.session?.access_token) throw new Error('Reauthentication is required to continue.')
    rejectedRefreshByAuth.delete(auth)
    return data.session
  })()

  refreshInFlightByAuth.set(auth, pendingRefresh)
  try {
    return await pendingRefresh
  } finally {
    if (refreshInFlightByAuth.get(auth) === pendingRefresh) refreshInFlightByAuth.delete(auth)
  }
}

export async function getValidSession(auth) {
  const { data, error } = await auth.getSession()
  if (error) throw error
  const session = data.session
  if (!session?.access_token) throw new Error('Sign in to continue.')
  return session
}

export async function invokeWithSessionRefresh(auth, invoke, { retryUnauthorized = false } = {}) {
  let session = await getValidSession(auth)
  let result = await invoke(session)
  const status = result.error?.context?.status || result.error?.status
  if (retryUnauthorized && status === 401) {
    try {
      session = await refreshSession(auth)
      result = await invoke(session)
    } catch (error) {
      console.warn('[auth] Read-only request could not recover after unauthorized response.', { name: error.name, code: error.code })
    }
  }
  return result
}
