async function refreshSession(auth) {
  const { data, error } = await auth.refreshSession()
  if (error) {
    console.warn('[auth] Explicit token recovery failed.', { name: error.name, code: error.code })
    throw error
  }
  if (!data.session?.access_token) throw new Error('Reauthentication is required to continue.')
  return data.session
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
