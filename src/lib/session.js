const SESSION_REFRESH_BUFFER_MS = 60_000

async function refreshSession(auth) {
  const { data, error } = await auth.refreshSession()
  if (error) throw error
  if (!data.session?.access_token) throw new Error('Your sign-in session is no longer available. Please sign in again.')
  return data.session
}

export async function getValidSession(auth, now = Date.now()) {
  const { data, error } = await auth.getSession()
  if (error) return refreshSession(auth)
  const session = data.session
  if (!session?.access_token) throw new Error('Your sign-in session is missing. Please sign in to continue.')

  const expiresAt = Number(session.expires_at) * 1000
  if (Number.isFinite(expiresAt) && expiresAt > 0 && expiresAt <= now + SESSION_REFRESH_BUFFER_MS) {
    return refreshSession(auth)
  }
  return session
}

export async function invokeWithSessionRefresh(auth, invoke) {
  let session = await getValidSession(auth)
  let result = await invoke(session)
  const status = result.error?.context?.status || result.error?.status
  if (status === 401) {
    try {
      session = await refreshSession(auth)
      result = await invoke(session)
    } catch (error) {
      if (!result.error) throw error
    }
  }
  return result
}
