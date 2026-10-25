import { supabase } from './supabase'
import { friendlyError } from './friendlyError'

export const api = async (path, options = {}) => {
  const requestBody = options.body ? JSON.parse(options.body) : {}
  let action
  let params = {}

  if (path === '/api/profile') {
    action = 'profile.get'
  } else if (path === '/api/profile/update') {
    action = 'profile.update'
  } else if (path === '/api/profile/password') {
    action = 'profile.password'
  } else if (path === '/api/payments') {
    action = 'payments.submit'
  } else if (path === '/api/members/create') {
    action = 'members.create'
  } else if (path === '/api/events/register-free') {
    action = 'events.register_free'
  } else if (path.startsWith('/api/payments/') && path.endsWith('/review')) {
    action = 'payments.review'
    params.paymentId = path.split('/').at(-2)
  } else if (path.startsWith('/api/passes/') && path.endsWith('/check-in')) {
    action = 'passes.checkin'
    params.token = decodeURIComponent(path.split('/').at(-2))
  } else if (path.startsWith('/api/receipts/')) {
    action = 'receipts.url'
    params.paymentId = path.split('/').at(-1)
  } else if (path.startsWith('/api/passes/') && path.endsWith('/qr')) {
    action = 'passes.qr'
    params.passId = path.split('/').at(-2)
  } else {
    throw new Error('Action could not be recognized.')
  }

  const {
    data: { session },
    error: sessionError,
  } = await supabase.auth.getSession()

  if (sessionError || !session?.access_token) {
    throw new Error('Your sign-in session expired. Please sign in again.')
  }

  const { data, error } = await supabase.functions.invoke('jpcs-api', {
    body: {
      action,
      params,
      input: requestBody,
      sessionAccessToken: session.access_token,
    },
    headers: {
      Authorization: `Bearer ${session.access_token}`,
    },
  })

  if (error) {
    let message = error.message
    let detail = null
    try {
      detail = await error.context?.json()
      message = detail?.error || message
    } catch {}
    if (path === '/api/members/create') {
      console.error('Add member invoke error:', error, detail)
      throw new Error(message || 'Add member request failed.')
    }
    throw new Error(friendlyError(message))
  }

  if (data?.error) {
    if (path === '/api/members/create') {
      console.error('Add member data error:', data)
      throw new Error(data.error || 'Add member request failed.')
    }
    throw new Error(friendlyError(data.error))
  }

  return data
}

export const getReceipt = async (payment) => {
  try {
    const { url } = await api(`/api/receipts/${payment.id}`)
    window.open(url, '_blank', 'noopener,noreferrer')
  } catch (e) {
    window.alert(friendlyError(e.message))
  }
}
