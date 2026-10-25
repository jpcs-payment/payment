export function friendlyError(error) {
  if (!error) return ''
  const raw =
    typeof error === 'string'
      ? error
      : error?.message || error?.error || String(error)
  const lower = raw.toLowerCase()

  // Authentication & Session
  if (
    lower.includes('jwt') ||
    lower.includes('token') ||
    lower.includes('session') ||
    lower.includes('expired') ||
    lower.includes('unauthorized') ||
    lower.includes('auth') ||
    lower.includes('invalid claim')
  ) {
    return 'Your session has timed out. Please sign out and sign back in to continue.'
  }

  // Login credentials
  if (
    lower.includes('invalid login credentials') ||
    lower.includes('invalid_grant') ||
    lower.includes('user not found')
  ) {
    return 'Incorrect email address or password. Please verify your details and try again.'
  }

  // Email confirmation
  if (lower.includes('email not confirmed')) {
    return 'Your account email is pending confirmation. Please contact your JPCS officer.'
  }

  // Network / Connection
  if (
    lower.includes('failed to fetch') ||
    lower.includes('networkerror') ||
    lower.includes('network error') ||
    lower.includes('load failed') ||
    lower.includes('offline')
  ) {
    return 'Unable to reach the server. Please check your internet connection and try again.'
  }

  // Password requirements
  if (
    lower.includes('password') &&
    (lower.includes('12') || lower.includes('short') || lower.includes('character'))
  ) {
    return 'Please choose a password with at least 12 characters.'
  }
  if (lower.includes('passwords do not match')) {
    return 'The passwords you entered do not match. Please re-type them.'
  }

  // Receipt & Uploads
  if (lower.includes('receipt') && (lower.includes('5') || lower.includes('mb') || lower.includes('large'))) {
    return 'Receipt image is too large. Please upload an image under 5 MB.'
  }
  if (
    lower.includes('receipt') &&
    (lower.includes('type') || lower.includes('jpg') || lower.includes('png') || lower.includes('webp'))
  ) {
    return 'Please upload a valid image file (JPG, PNG, or WebP).'
  }
  if (lower.includes('upload') && lower.includes('receipt')) {
    return 'Please attach a payment receipt image before submitting.'
  }

  // Rejection reason
  if (lower.includes('rejection reason') || lower.includes('add a rejection')) {
    return 'Please provide a clear reason for rejecting this payment so the member knows what to correct.'
  }

  // Already reviewed / double submission
  if (lower.includes('already reviewed') || lower.includes('already used')) {
    return 'This payment has already been reviewed by another officer.'
  }

  // Balance exceeded
  if (lower.includes('exceeds remaining') || lower.includes('exceed')) {
    return 'The amount submitted exceeds the remaining balance for this event.'
  }

  // Database / Edge Function technical errors
  if (
    lower.includes('postgrest') ||
    lower.includes('postgres') ||
    lower.includes('edge function') ||
    lower.includes('row level security') ||
    lower.includes('rpc') ||
    lower.includes('plpgsql') ||
    lower.includes('violates') ||
    lower.includes('syntax error') ||
    lower.includes('relation') ||
    lower.includes('column') ||
    lower.includes('status 500') ||
    lower.includes('status 400') ||
    lower.includes('internal server error') ||
    lower.includes('profile setup failed')
  ) {
    return 'Something went wrong while processing your request. Please try again or reach out to an officer.'
  }

  // Clean raw message of technical prefixes
  return raw.replace(/^error:\s*/i, '')
}
