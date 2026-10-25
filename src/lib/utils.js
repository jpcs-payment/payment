export const money = (n) => `₱${Number(n || 0).toLocaleString('en-PH')}`

export const date = (v) =>
  v
    ? new Date(v).toLocaleDateString('en-PH', {
        year: 'numeric',
        month: 'short',
        day: 'numeric',
      })
    : 'Date to be announced'

export const localDate = (v) => {
  if (!v) return ''
  const d = new Date(v)
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16)
}

export const asArray = (value) => (Array.isArray(value) ? value : value ? [value] : [])

export const initials = (s = '') =>
  s
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((x) => x[0])
    .join('')
    .toUpperCase() || 'JP'

export const year = (n) => ['', 'First Year', 'Second Year', 'Third Year', 'Fourth Year'][n] || '—'

export const roleLabel = (p) => {
  if (!p) return ''
  if (p.role === 'member') return `${year(p.year_level)} · Member`
  if (p.role === 'admin') return 'Administrator'
  if (p.role === 'treasurer') return 'Treasurer · Officer'
  return 'Auditor · Officer'
}

export const greeting = (name = '') => `Welcome back, ${name.split(' ')[0] || 'member'}`

export const statusOf = (registration, price) => {
  if (!registration) {
    return Number(price) === 0 ? 'Not registered' : 'Unpaid'
  }
  const ps = registration?.payments || []
  const total = Number(registration?.price ?? price)
  if (total === 0) return 'Registered'
  const approved = ps.filter((p) => p.state === 'approved').reduce((a, p) => a + Number(p.amount), 0)
  if (approved >= total) return 'Fully paid'
  if (approved > 0) return 'Partially paid'
  if (ps.some((p) => p.state === 'pending')) return 'Pending verification'
  if (ps.some((p) => p.state === 'rejected')) return 'Rejected'
  return 'Unpaid'
}

export const paidPercent = (regs, events) => {
  const activeIds = new Set(events.map((e) => e.id))
  const total = events.reduce((s, e) => s + Number(regs.find((r) => r.event_id === e.id)?.price ?? e.price), 0)
  const paid = regs
    .filter((r) => activeIds.has(r.event_id))
    .flatMap((r) => r.payments || [])
    .filter((p) => p.state === 'approved')
    .reduce((s, p) => s + Number(p.amount), 0)
  return total ? Math.round((paid / total) * 100) : 0
}

export const downloadReport = (items) => {
  const lines = [
    ['Payment ID', 'Member', 'Event', 'Amount', 'Method', 'Status', 'Submitted'],
    ...items.map((p) => [
      p.id,
      p.registrations?.profiles?.full_name,
      p.registrations?.events?.name,
      p.amount,
      p.method,
      p.state,
      p.submitted_at,
    ]),
  ]
  const csv = lines.map((row) => row.map((v) => `"${String(v ?? '').replaceAll('"', '""')}"`).join(',')).join('\n')
  const a = document.createElement('a')
  a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }))
  a.download = 'jpcs-payment-report.csv'
  a.click()
  URL.revokeObjectURL(a.href)
}
