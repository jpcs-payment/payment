import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { supabase } from './lib/supabase'
import { invokeWithSessionRefresh, isInvalidRefreshTokenError, refreshSession } from './lib/session'
import { Activity, AlertTriangle, ArrowRight, Banknote, CalendarDays, Check, CheckCircle2, ChevronRight, CircleHelp, Clock3, CreditCard, Download, ExternalLink, FileImage, FileText, Home, KeyRound, Landmark, LogOut, Maximize2, Menu, Minimize2, Moon, MoreHorizontal, Pencil, Plus, QrCode, RefreshCw, ScanLine, Search, Settings, ShieldCheck, Sun, Ticket, Trash2, Upload, Users, Wallet, X } from 'lucide-react'
import { extractStudentDirectoryPdf, fingerprintFile, MAX_DIRECTORY_PDF_BYTES } from './lib/studentDirectoryPdf'

const CheckInScanner = lazy(() => import('./components/CheckInScanner'))

const money = n => {
  const v = Number(n || 0)
  return `₱${v.toLocaleString('en-PH', { minimumFractionDigits: Number.isInteger(v) ? 0 : 2, maximumFractionDigits: 2 })}`
}
const date = v => (v ? new Date(v).toLocaleDateString('en-PH', { year: 'numeric', month: 'short', day: 'numeric' }) : 'Date to be announced')
const dateTime = v => (v ? new Date(v).toLocaleString('en-PH', { year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '—')
const eventIsCompleted = event => !!event?.completed || (!!event?.event_date && new Date(event.event_date).getTime() <= Date.now())
const asArray = value => (Array.isArray(value) ? value : value ? [value] : [])
const statusOf = (registration, price) => {
  const ps = registration?.payments || []
  const total = Number(registration?.price ?? price ?? 0)
  const approved = ps.filter(p => p.state === 'approved').reduce((a, p) => a + Number(p.amount || 0), 0)
  if (total <= 0) return 'Fully paid'
  if (approved >= total - 0.000001) return 'Fully paid'
  if (approved > 0) return 'Partially paid'
  if (ps.some(p => p.state === 'pending')) return 'Pending verification'
  if (ps.some(p => p.state === 'rejected')) return 'Rejected'
  return 'Unpaid'
}
const initials = s => (s || '').split(/\s+/).filter(Boolean).slice(0, 2).map(x => x[0]).join('').toUpperCase() || 'JP'
const yearLabel = n => (['', 'First Year', 'Second Year', 'Third Year', 'Fourth Year'][n] || '—')
const roleLabel = p => {
  if (!p) return ''
  if (p.role === 'member') return `${yearLabel(p.year_level)} · Member`
  if (p.role === 'admin') return 'Administrator'
  if (p.role === 'treasurer') return 'Treasurer · Officer'
  if (p.role === 'auditor') return 'Auditor · Officer'
  return p.role
}
const greeting = name => `Welcome back, ${(name || 'member').split(' ')[0]}`
const paidPercent = (regs, events) => {
  const active = events.filter(e => e.active)
  const activeIds = new Set(active.map(e => e.id))
  const total = active.reduce((s, e) => s + Number((regs.find(r => r.event_id === e.id)?.price ?? e.price) || 0), 0)
  const paid = regs.filter(r => activeIds.has(r.event_id)).flatMap(r => r.payments || []).filter(p => p.state === 'approved').reduce((s, p) => s + Number(p.amount || 0), 0)
  return total > 0 ? Math.round((paid / total) * 100) : 0
}
const localDate = v => {
  if (!v) return ''
  const d = new Date(v)
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16)
}
const localDateTimeToIso = value => value ? new Date(value).toISOString() : null
const safeGet = (k, fallback) => {
  try { return localStorage.getItem(k) ?? fallback } catch { return fallback }
}
const safeSet = (k, v) => { try { localStorage.setItem(k, v) } catch {} }
const sessionGet = k => { try { return sessionStorage.getItem(k) } catch { return null } }
const sessionSet = (k, v) => { try { sessionStorage.setItem(k, v) } catch {} }
const sessionRemove = k => { try { sessionStorage.removeItem(k) } catch {} }
const METHOD_META = {
  gcash: { label: 'GCash', description: 'Scan the official GCash QR and upload your receipt.', icon: Wallet, qr: '/images/gcash-qr.png' },
  maribank: { label: 'MariBank', description: 'Scan the official MariBank QR and upload your receipt.', icon: Landmark, qr: '/images/maribank.png' },
  cash: { label: 'Cash', description: 'Pay in person to a JPCS officer and submit the amount here.', icon: Banknote, qr: null }
}

const friendlyError = (error, context = 'request') => {
  const raw = typeof error === 'string' ? error : (error?.message || '')
  const message = String(raw)
  const offline = typeof navigator !== 'undefined' && navigator.onLine === false
  const networkFailure = offline || /failed to fetch|networkerror|network.*error|load failed|fetch failed|err_name_not_resolved|timeout/i.test(message)
  if (networkFailure && ['payment', 'review', 'checkin', 'event', 'profileSave'].includes(context)) {
    return 'The connection was interrupted, so we could not confirm whether this action completed. Refresh or check its current status before trying again.'
  }
  if (networkFailure) {
    return 'Unable to connect right now. Please check your internet connection and try again.'
  }
  if (/invalid login credentials|invalid_grant|email not confirmed|invalid email or password/i.test(message)) {
    return "We couldn't sign you in. Check your email and password and try again."
  }
  if (/jwt|token has expired|refresh token|invalid session|session.*(?:expired|no longer available|missing)|not authenticated|auth session missing|reauthentication is required/i.test(message)) {
    return 'Your sign-in needs to be renewed. Please sign in again if prompted.'
  }
  if (/row-level security|permission denied|not authorized|officer access required|403|insufficient privilege/i.test(message)) {
    return "You don't have permission to perform this action."
  }
  if (/already reviewed|duplicate key|conflict/i.test(message)) {
    return 'This payment was already reviewed. Refresh to see the latest status.'
  }
  if (/payment exceeds remaining|exceeds remaining/i.test(message)) {
    return 'That amount is more than the remaining balance for this event. Refresh the page and try again.'
  }
  if (/event or payment method unavailable|payment method.*unavailable/i.test(message)) {
    return "That payment method isn't available for this event anymore. Refresh and try again."
  }
  if (/receipt required|upload a receipt/i.test(message)) {
    return 'Upload your payment receipt before submitting.'
  }
  if (/cash payment.*receipt|does not accept receipt/i.test(message)) {
    return "Cash payments don't need a receipt. Remove the file and try again."
  }
  if (/could not save profile|profile.*save/i.test(message)) {
    return "We couldn't save your profile changes. Please try again."
  }
  if (/could not save event|event.*save|invalid input/i.test(message)) {
    return "We couldn't save this event. Please try again."
  }
  if (/storage|bucket|mime|file.*too large|payload too large|upload.*fail/i.test(message)) {
    return "We couldn't upload your receipt. Please check the file and try again."
  }
  if (/password.*6|at least 6|jpcs2026/i.test(message)) {
    return 'Choose a password with at least 6 characters.'
  }
  if (/no jpcs profile|profile is not provisioned|profile could not be loaded/i.test(message)) {
    return "We couldn't find a JPCS profile for this account. Contact a JPCS officer to provision it, then retry."
  }
  if (/email.*invalid|brevo|smtp|email delivery/i.test(message)) {
    return 'The confirmation email could not be sent. It will be retried automatically.'
  }
  if (/receipt not found|no receipt/i.test(message)) {
    return "This receipt isn't available right now."
  }
  if (/pass not found|pass.*invalid/i.test(message)) {
    return 'That entrance pass could not be found.'
  }
  if (/already exists|email already|account.*exists/i.test(message)) {
    return 'An account with this email already exists.'
  }
  if (/administrator access required|admin.*required/i.test(message)) {
    return 'Administrator permissions are required to perform this action.'
  }
  if (message && !/postgres|supabase|sql|exception|error:|internal|stack|deno|runtime/i.test(message) && message.length < 150) {
    return message
  }
  const fallback = {
    load: "We couldn't load the latest JPCS data. Please try again.",
    payment: "Your payment submission could not be completed. Please try again.",
    review: "We couldn't update the payment status. Please refresh and try again.",
    profile: "We couldn't load your account information. Please try again.",
    profileSave: "We couldn't save your profile changes. Please try again.",
    event: "We couldn't save this event. Please try again.",
    receipt: "We couldn't open that receipt. Please try again.",
    checkin: "We couldn't check in this pass. Please try again.",
    auth: "We couldn't sign you in. Please try again.",
    upload: "We couldn't upload your receipt. Please try again."
  }
  return fallback[context] || 'Something went wrong. Please try again later.'
}

const READ_ONLY_ACTIONS = new Set(['profile.get', 'payments.reviewer', 'receipts.url', 'passes.qr'])
const UNCERTAIN_WRITE_MESSAGE = 'The connection was interrupted, so we could not confirm whether this action completed. Refresh or check its current status before trying again.'
const isTransportFailure = error => error?.name === 'FunctionsFetchError' || error?.context?.name === 'TypeError' || /failed to fetch|network|timeout|load failed|failed to send a request/i.test(String(error?.message || ''))

const api = async (path, options = {}, context = 'request') => {
  if (!supabase) throw new Error('Supabase is not configured.')
  let requestBody = {}
  if (options.body) {
    try { requestBody = JSON.parse(options.body) } catch { requestBody = options.body }
  }
  const segments = path.split('/').filter(Boolean)
  let action, params = {}
  if (path === '/api/profile') action = options.method === 'PATCH' ? 'profile.update' : 'profile.get'
  else if (path === '/api/profile/password') action = 'profile.password'
  else if (path === '/api/profile/password/change') action = 'profile.password.change'
  else if (path === '/api/members/create') action = 'members.create'
  else if (path === '/api/members/import') action = 'members.import'
  else if (path === '/api/members/role') action = 'members.role'
  else if (path === '/api/members/update') action = 'members.update'
  else if (path === '/api/members/reset-password') action = 'members.resetPassword'
  else if (path === '/api/members/delete') action = 'members.delete'
  else if (path === '/api/events/delete') action = 'events.delete'
  else if (path === '/api/pay-later') action = 'payments.pay_later'
  else if (path === '/api/payments/delete') action = 'payments.delete'
  else if (path === '/api/pay-later/delete') action = 'payments.pay_later.delete'
  else if (path === '/api/payments') action = 'payments.submit'
  else if (path === '/api/payments/reviewer') action = 'payments.reviewer'
  else if (/^\/api\/payments\/[^/]+\/review$/.test(path)) { action = 'payments.review'; params.paymentId = segments.at(-2) }
  else if (path.startsWith('/api/passes/') && path.endsWith('/check-in')) { action = 'passes.checkin'; params.token = decodeURIComponent(segments.at(-2)) }
  else if (path.startsWith('/api/receipts/')) { action = 'receipts.url'; params.paymentId = segments.at(-1) }
  else if (path.startsWith('/api/passes/') && path.endsWith('/qr')) { action = 'passes.qr'; params.passId = segments.at(-2) }
  else throw new Error('Something went wrong. Please try again later.')

  let response
  try {
    response = await invokeWithSessionRefresh(supabase.auth, session => supabase.functions.invoke('jpcs-api', { body: { action, params, input: requestBody }, headers: { Authorization: `Bearer ${session.access_token}` } }), { retryUnauthorized: READ_ONLY_ACTIONS.has(action) })
  } catch (error) {
    if (!READ_ONLY_ACTIONS.has(action) && isTransportFailure(error)) throw new Error(UNCERTAIN_WRITE_MESSAGE)
    throw new Error(friendlyError(error, context))
  }
  const { data, error } = response
  if (error) {
    const status = error.status || error.context?.status
    if (!READ_ONLY_ACTIONS.has(action) && status >= 500) throw new Error(UNCERTAIN_WRITE_MESSAGE)
    let message = error.message
    try { const detail = await error.context?.json(); message = detail?.error || message } catch {}
    if (!READ_ONLY_ACTIONS.has(action) && isTransportFailure(error)) throw new Error(UNCERTAIN_WRITE_MESSAGE)
    throw new Error(friendlyError(message, context))
  }
  if (data?.error) throw new Error(friendlyError(data.error, context))
  return data
}

const downloadReport = items => {
  const lines = [['Payment ID', 'Member', 'Email', 'Event', 'Amount', 'Method', 'Status', 'Submitted'], ...items.map(p => [p.id, p.registrations?.profiles?.full_name || '', p.registrations?.profiles?.email || '', p.registrations?.events?.name || p.event?.name || '', p.amount, p.method, p.state, p.submitted_at]) ]
  const csv = '\uFEFF' + lines.map(row => row.map(v => `"${String(v ?? '').replaceAll('"', '""')}"`).join(',')).join('\n')
  const a = document.createElement('a')
  a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }))
  a.download = 'jpcs-payment-report.csv'
  a.click()
  URL.revokeObjectURL(a.href)
}

const downloadPaymentReportPdf = async (items, summary) => {
  const [{ jsPDF }, { default: autoTable }] = await Promise.all([import('jspdf'), import('jspdf-autotable')])
  const pdfMoney = amount => `PHP ${Number(amount || 0).toLocaleString('en-PH', { minimumFractionDigits: Number.isInteger(Number(amount || 0)) ? 0 : 2, maximumFractionDigits: 2 })}`
  const pdf = new jsPDF({ orientation: 'landscape', unit: 'pt', format: 'a4' })
  const pageWidth = pdf.internal.pageSize.getWidth()
  const margin = 38
  pdf.setTextColor(23, 43, 73)
  pdf.setFont('helvetica', 'bold')
  pdf.setFontSize(20)
  pdf.text('JPCS Payment Report', margin, 42)
  pdf.setFont('helvetica', 'normal')
  pdf.setFontSize(9)
  pdf.setTextColor(104, 119, 137)
  pdf.text('Filtered payment activity', margin, 58)
  pdf.text(`Generated ${new Date().toLocaleString('en-PH')}`, pageWidth - margin, 42, { align: 'right' })

  const metrics = [
    ['COLLECTED', pdfMoney(summary.collected)],
    ['PENDING', String(summary.pending)],
    ['REJECTED', String(summary.rejected)],
    ['APPROVED', String(summary.approved)]
  ]
  const gap = 10
  const cardWidth = (pageWidth - margin * 2 - gap * 3) / 4
  metrics.forEach(([label, value], index) => {
    const x = margin + index * (cardWidth + gap)
    pdf.setFillColor(248, 247, 243)
    pdf.setDrawColor(225, 226, 222)
    pdf.roundedRect(x, 72, cardWidth, 42, 5, 5, 'FD')
    pdf.setFont('helvetica', 'bold')
    pdf.setFontSize(8)
    pdf.setTextColor(112, 123, 133)
    pdf.text(label, x + 10, 87)
    pdf.setFontSize(13)
    pdf.setTextColor(48, 58, 67)
    pdf.text(value, x + 10, 104)
  })

  const rows = items.map((payment, index) => {
    const registration = payment.registrations || payment.registration || {}
    const member = registration.profiles || payment.profiles || {}
    const event = registration.events || payment.event || {}
    const status = String(payment.state || 'pending')
    return [String(index + 1), event.name || 'Event', member.full_name || payment.member_name || 'JPCS member', member.email || payment.member_email || '', dateTime(payment.submitted_at), payment.method || '', pdfMoney(payment.amount), status.charAt(0).toUpperCase() + status.slice(1)]
  })

  autoTable(pdf, {
    startY: 128,
    margin: { left: margin, right: margin, bottom: 34 },
    head: [['#', 'Event', 'Member', 'Email', 'Submitted', 'Method', 'Amount', 'Status']],
    body: rows.length ? rows : [['', 'No payment records match the selected filters.', '', '', '', '', '', '']],
    theme: 'grid',
    styles: { font: 'helvetica', fontSize: 8, cellPadding: 6, textColor: [38, 52, 71], lineColor: [229, 232, 231], lineWidth: 0.5, overflow: 'linebreak' },
    headStyles: { fillColor: [23, 52, 91], textColor: [255, 255, 255], fontStyle: 'bold', fontSize: 8 },
    alternateRowStyles: { fillColor: [250, 250, 248] },
    columnStyles: { 0: { halign: 'center', cellWidth: 26 }, 6: { halign: 'right' }, 7: { fontStyle: 'bold', halign: 'center' } },
    didParseCell: data => {
      if (data.section !== 'body' || data.column.index !== 7 || !rows.length) return
      const status = String(data.cell.raw).toLowerCase()
      if (status === 'approved') data.cell.styles.textColor = [22, 128, 67]
      else if (status === 'pending') data.cell.styles.textColor = [180, 120, 0]
      else if (status === 'rejected') data.cell.styles.textColor = [185, 40, 40]
    },
    didDrawPage: () => {
      const pageCount = pdf.internal.getNumberOfPages()
      pdf.setFont('helvetica', 'normal')
      pdf.setFontSize(8)
      pdf.setTextColor(112, 123, 133)
      pdf.text(`${items.length} payment record${items.length === 1 ? '' : 's'} included`, margin, pdf.internal.pageSize.getHeight() - 16)
      pdf.text(`Page ${pageCount}`, pageWidth - margin, pdf.internal.pageSize.getHeight() - 16, { align: 'right' })
    }
  })
  return pdf.output('blob')
}

function AuthFrame({ dark, children }) {
  return <main className={`login-screen ${dark ? 'dark' : ''}`}><section className="login-story"><div className="login-story-brand"><img src="/images/jpcs-logo.png" alt="" /><span>JPCS <small>PAYMENT PORTAL</small></span></div><div className="login-story-copy"><h2>Make every<br />event <span>count.</span></h2><div className="login-story-visual" aria-hidden="true"><i /><i /><i /><i /><i /></div><p>One place to follow JPCS events, manage registrations, and keep your payments on track.</p><div className="login-story-caption">Your JPCS activities, all in sync.</div></div><div className="login-story-footer">Web Developer • Carl Andrei Lucido<br />QA Tester • Aerol Justine • Ms. Joyce</div></section><section className="login-panel"><div className="login-card">{children}</div></section></main>
}
function ErrorBox({ text, onClose }) {
  if (!text) return null
  return <div className="error-box"><span>{text}</span>{onClose && <button type="button" onClick={onClose} aria-label="Close"><X size={15} /></button>}</div>
}
function Empty({ text }) {
  return <div className="empty-state">{text}</div>
}
function PanelTitle({ eyebrow, title, action }) {
  return <div className="panel-head"><div><p className="eyebrow">{eyebrow}</p><h2>{title}</h2></div>{action}</div>
}
function Stat({ icon, label, value, color, category }) {
  return <div className="stat-card"><div className="stat-top"><div className={`stat-icon ${color}`}>{icon}</div><span className="stat-category">{category}</span></div><span className="stat-label">{label}</span><strong>{value}</strong></div>
}
let activeModalCount = 0
let bodyOverflowBeforeModal = ''
function Modal({ children, onClose, onEscape, className = '', labelledBy, contentHidden = false }) {
  useEffect(() => {
    const onKey = e => { if (e.key === 'Escape') (onEscape || onClose)() }
    document.addEventListener('keydown', onKey)
    if (activeModalCount === 0) bodyOverflowBeforeModal = document.body.style.overflow
    activeModalCount += 1
    document.body.style.overflow = 'hidden'
    return () => {
      document.removeEventListener('keydown', onKey)
      activeModalCount = Math.max(0, activeModalCount - 1)
      if (activeModalCount === 0) document.body.style.overflow = bodyOverflowBeforeModal
    }
  }, [onClose, onEscape])
  return <div className="modal-backdrop" onMouseDown={e => { if (e.target === e.currentTarget) onClose() }}><div className={`modal ${className}`} role="dialog" aria-modal="true" aria-labelledby={labelledBy} aria-hidden={contentHidden || undefined}>{children}</div></div>
}
function ModalClose({ onClick }) {
  return <button type="button" className="icon-button" onClick={onClick} aria-label="Close"><X size={18} /></button>
}

function PaymentReportPdfPreview({ blob, onClose }) {
  const [url, setUrl] = useState('')
  useEffect(() => {
    const objectUrl = URL.createObjectURL(blob)
    setUrl(objectUrl)
    return () => URL.revokeObjectURL(objectUrl)
  }, [blob])
  const download = () => {
    const link = document.createElement('a')
    link.href = url
    link.download = 'jpcs-payment-report.pdf'
    link.click()
  }
  return <Modal onClose={onClose} className="pdf-preview-modal">
    <div className="modal-heading"><div><p className="eyebrow">REPORT PREVIEW</p><h2>Payment report PDF</h2></div><ModalClose onClick={onClose} /></div>
    <iframe className="pdf-preview-frame" src={url || undefined} title="Payment report PDF preview" />
    <div className="modal-actions"><button type="button" className="outline-btn" onClick={onClose}>Close</button><button type="button" className="primary" onClick={download} disabled={!url}><Download size={15} /> Download PDF</button></div>
  </Modal>
}

function ConfirmModal({ title = 'Please confirm', message, confirmText = 'Confirm', destructive = false, onConfirm, onClose }) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const close = () => { if (!busy) onClose() }
  const confirm = async () => {
    setBusy(true); setError('')
    try { await onConfirm(); onClose() } catch (ex) { setError(ex.message || 'The action could not be completed.') } finally { setBusy(false) }
  }
  return <Modal onClose={close} className="confirm-modal">
    <div className="modal-heading"><div><p className="eyebrow">CONFIRM ACTION</p><h2>{title}</h2></div><ModalClose onClick={close} /></div>
    <p className="confirm-modal-message">{message}</p>
    {error && <ErrorBox text={error} />}
    <div className="modal-actions"><button type="button" className="outline-btn" onClick={close} disabled={busy}>Cancel</button><button type="button" className={destructive ? 'reject-btn solid' : 'primary'} onClick={confirm} disabled={busy}>{busy ? 'Please wait…' : confirmText}</button></div>
  </Modal>
}

function PasswordModal({ onClose, onChanged }) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const submit = async event => {
    event.preventDefault()
    const form = new FormData(event.currentTarget)
    const password = form.get('password')
    if (password !== form.get('confirm')) { setError('The new passwords do not match.'); return }
    try {
      setBusy(true)
      setError('')
      await api('/api/profile/password/change', {
        method: 'POST',
        body: JSON.stringify({ currentPassword: form.get('currentPassword'), password })
      }, 'auth')
      onChanged()
      onClose()
    } catch (ex) { setError(ex.message || 'Could not update your password.') }
    finally { setBusy(false) }
  }
  const close = () => { if (!busy) onClose() }
  return <Modal onClose={close} className="profile-modal password-modal">
    <div className="modal-heading"><div><p className="eyebrow">ACCOUNT SECURITY</p><h2>Change password</h2></div><ModalClose onClick={close} /></div>
     <p className="muted">Use at least 6 characters. Avoid reusing a password from another account.</p>
    <form onSubmit={submit}>
      <label htmlFor="current-password">Current password</label><input id="current-password" name="currentPassword" className="modal-input" type="password" autoComplete="current-password" required />
       <label htmlFor="new-password">New password</label><input id="new-password" name="password" className="modal-input" type="password" minLength="6" maxLength="128" autoComplete="new-password" required />
       <label htmlFor="confirm-password">Confirm new password</label><input id="confirm-password" name="confirm" className="modal-input" type="password" minLength="6" maxLength="128" autoComplete="new-password" required />
      {error && <ErrorBox text={error} />}
      <div className="modal-actions"><button type="button" className="outline-btn" onClick={close} disabled={busy}>Cancel</button><button type="submit" className="primary" disabled={busy}>{busy ? 'Saving…' : 'Update password'}</button></div>
    </form>
  </Modal>
}

function WorkspaceSkeleton({ dark }) {
  return <div className={`workspace-skeleton-screen ${dark ? 'dark' : ''}`} aria-busy="true" aria-label="Loading workspace">
    <aside className="workspace-skeleton-sidebar"><div className="skeleton-block skeleton-brand" /><div className="skeleton-block skeleton-nav-line" /><div className="skeleton-block skeleton-nav-line" /><div className="skeleton-block skeleton-nav-line" /><div className="skeleton-block skeleton-nav-line" /><div className="skeleton-profile"><i className="skeleton-block" /><span className="skeleton-block" /></div></aside>
    <main className="workspace-skeleton-main"><header className="workspace-skeleton-header"><div className="skeleton-block skeleton-crumb" /><div className="skeleton-header-actions"><i className="skeleton-block" /><i className="skeleton-block" /><i className="skeleton-block" /></div></header>
      <section className="workspace-skeleton-content"><div className="skeleton-welcome"><div className="skeleton-block skeleton-kicker" /><div className="skeleton-block skeleton-title" /><div className="skeleton-block skeleton-subtitle" /></div>
        <div className="skeleton-stat-grid">{Array.from({ length: 4 }, (_, index) => <div className="skeleton-stat-card" key={index}><i className="skeleton-block" /><span className="skeleton-block" /><b className="skeleton-block" /></div>)}</div>
        <div className="skeleton-content-grid"><div className="skeleton-panel"><div className="skeleton-block skeleton-panel-title" /><div className="skeleton-event-grid">{Array.from({ length: 3 }, (_, index) => <div className="skeleton-event-card" key={index}><i className="skeleton-block" /><span className="skeleton-block" /><b className="skeleton-block" /></div>)}</div></div><div className="skeleton-panel skeleton-side-panel"><div className="skeleton-block skeleton-panel-title" /><div className="skeleton-block skeleton-side-shape" /><div className="skeleton-block skeleton-side-line" /><div className="skeleton-block skeleton-side-line short" /></div></div>
      </section>
    </main>
  </div>
}

function EventCard({ event, registration, onPay, isAdmin, onEdit }) {
  const [showInfo, setShowInfo] = useState(false)
  const status = statusOf(registration, event.price)
  const paid = (registration?.payments || []).filter(p => p.state === 'approved').reduce((s, p) => s + Number(p.amount || 0), 0)
  const price = Number(registration?.price ?? event.price ?? 0)
  const pendingAmt = (registration?.payments || []).filter(p => p.state === 'pending').reduce((s, p) => s + Number(p.amount || 0), 0)
  const used = paid + pendingAmt
  const remaining = Math.max(0, price - used)
  const fullyPaid = status === 'Fully paid' || remaining <= 0
  const completed = eventIsCompleted(event)
  const payLaterActive = !!registration?.pay_later_started_at && !fullyPaid
  const paymentProgress = price > 0 ? Math.min(100, Math.round(paid / price * 100)) : 100
  const statusText = payLaterActive ? `Pay Later · due ${date(registration.pay_later_due_at)}` : status === 'Fully paid' ? 'Fully paid' : status === 'Partially paid' ? `Partially paid · ${money(paid)} paid` : status === 'Pending verification' ? 'Pending verification' : status === 'Rejected' ? 'Rejected' : 'Unpaid'
  const eventDate = event.event_date ? new Date(event.event_date) : null
  const dateParts = eventDate && !Number.isNaN(eventDate.getTime()) ? {
    day: eventDate.toLocaleDateString('en-PH', { month: 'short', day: 'numeric' }).toUpperCase(),
    yearTime: `${eventDate.getFullYear()} · ${eventDate.toLocaleTimeString('en-PH', { hour: 'numeric', minute: '2-digit' })}`
  } : null
  const isMerch = /\b(jacket|merch(?:andise)?|shirt|hoodie|apparel|uniform)\b/i.test(`${event.name || ''} ${event.description || ''}`)
  const semester = /\b(film\s*showing|boot\s*camp|bootcamp)\b/i.test(event.name || '') ? 'First Semester' : /\b(jacket|field\s*trip|fieldtrip)\b/i.test(event.name || '') ? 'Second Semester' : ''
  return <article className={`event-card ${isAdmin ? 'admin-event-card' : 'member-event-card'}`}>
    <div className="event-art"><Ticket size={28} strokeWidth={1.7} /><span className="event-date-label">EVENT DATE</span><b>{dateParts?.day || 'TBA'}</b><span className="event-date-time">{dateParts?.yearTime || 'Date to be announced'}</span><small>{event.venue || 'JPCS · EVENTS'}</small></div>
    <div className="event-detail">
      <div className="event-card-topline"><span className="event-type-badge">{isMerch ? 'JPCS Merch' : 'JPCS Event'}{semester && ` · ${semester}`}</span>{event.payment_deadline && <span className="event-deadline"><Clock3 size={14} />Due {new Date(event.payment_deadline).toLocaleDateString('en-PH', { month: 'short', day: 'numeric' })}</span>}</div>
      <h3>{event.name}</h3>
      <p className="muted event-description">{event.description || 'Join us at this JPCS event.'}</p>
      {!isAdmin && <div className="event-payment-progress"><div><span>Payment progress</span><b>{paymentProgress}%</b></div><progress max="100" value={paymentProgress} aria-label={`Payment progress for ${event.name}`} />{event.partial_payments_enabled !== false && price > 0 && !fullyPaid && <small className="partial-payments-label">Partial payments accepted</small>}</div>}
        <div className="event-bottom">
        <div className="event-price-box">{!isAdmin && <small className="event-due-label"><Clock3 size={14} />Due {event.payment_deadline ? date(event.payment_deadline) : 'anytime'}</small>}<b>{money(isAdmin ? price : remaining)}</b>{!isAdmin && <small className="method">{statusText}</small>}</div>
          <div className="event-card-actions">{isAdmin ? <button type="button" className="pay-button secondary" onClick={onEdit}><Pencil size={14} /> Edit</button> : <button type="button" className="pay-button" disabled={completed || fullyPaid || status === 'Pending verification'} onClick={onPay}>{completed ? 'Ended' : fullyPaid ? 'Paid' : status === 'Pending verification' ? 'Pending' : `Pay ${money(remaining)} Now`} {!completed && <ArrowRight size={15} />}</button>}{!isAdmin && <button type="button" className="event-info-button" aria-label={`${showInfo ? 'Hide' : 'View'} details for ${event.name}`} aria-expanded={showInfo} onClick={() => setShowInfo(value => !value)}><CircleHelp size={17} /></button>}</div>
      </div>
      {showInfo && <div className="event-info-details"><b>Event details</b>{event.venue && <p><strong>Venue:</strong> {event.venue}</p>}{event.payment_instructions && <p>{event.payment_instructions}</p>}{!event.venue && !event.payment_instructions && <p>More information will be shared by JPCS.</p>}</div>}
    </div>
  </article>
}

function PaymentTable({ items, admin, onOpen, showPagination = true, className = '', showCount = false }) {
  const [page, setPage] = useState(1)
  const pageSize = 5
  const pageCount = Math.max(1, Math.ceil(items.length / pageSize))
  const currentPage = Math.min(page, pageCount)
  const pageItems = items.slice((currentPage - 1) * pageSize, currentPage * pageSize)
  useEffect(() => { setPage(1) }, [items])
  return <div className={`table-wrap payment-table-wrap ${className}`}>{showCount && <div className="payment-table-count"><span aria-label={`${items.length} payment submissions`}>{items.length}</span></div>}<table><thead><tr><th>Event / Member</th><th>Date · Method</th><th>Amount</th><th>Status</th><th>Details</th></tr></thead><tbody>
    {pageItems.map(p => {
      const reg = p.registrations || p.registration || {}
      const member = reg.profiles || p.profiles || {}
      const ev = reg.events || p.event || {}
      const name = ev.name || 'Event'
      const memberName = member.full_name || p.member_name || 'JPCS member'
      const memberEmail = member.email || p.member_email || ''
      return <tr key={p.id} className={admin ? 'clickable-row' : undefined} tabIndex={admin ? 0 : undefined} role={admin ? 'button' : undefined} onClick={admin ? () => onOpen(p) : undefined} onKeyDown={admin ? e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onOpen(p) } } : undefined}>
        <td data-label="Event / Member"><b>{name}</b><small className="method">{admin ? `${memberName} · ${memberEmail}` : p.transaction_reference || 'Payment submission'}</small></td>
        <td data-label="Date · Method">{dateTime(p.submitted_at)}<small className="method">via {p.method}</small></td>
        <td data-label="Amount" className="amount-cell">{money(p.amount)}</td>
        <td data-label="Status"><span className={`status ${p.state === 'approved' ? 'paid' : p.state === 'rejected' ? 'rejected' : 'pending'}`}><i />{p.state === 'approved' ? 'Approved' : p.state === 'rejected' ? 'Rejected' : 'Pending'}</span>{p.remarks && <small className="method">Reason: {p.remarks}</small>}</td>
        <td data-label="Details">{admin ? <button type="button" className="text-button" onClick={e => { e.stopPropagation(); onOpen(p) }}>View / Review</button> : <button type="button" className="text-button" onClick={e => { e.stopPropagation(); onOpen(p) }}>View details</button>}</td>
      </tr>
    })}
  </tbody></table>{!items.length && <Empty text="No payment submissions yet." />}{showPagination && <PaginationControls total={items.length} page={currentPage} pageSize={pageSize} onPageChange={setPage} />}</div>
}

function PayLaterTable({ registrations, onDelete, canDelete }) {
  const obligations = registrations.filter(reg => reg.pay_later_started_at && Number(reg.price) > (reg.payments || []).filter(p => p.state === 'approved').reduce((sum, p) => sum + Number(p.amount || 0), 0))
  return <section className="pay-later-admin-section">
    <div className="pay-later-admin-heading"><div><p className="eyebrow">UNPAID OBLIGATIONS</p><h2>Pay Later</h2></div><span>{obligations.length}</span></div>
    <div className="table-wrap"><table><thead><tr><th>Event / Member</th><th>Selected</th><th>Due date</th><th>Outstanding</th><th>Status</th>{canDelete && <th>Action</th>}</tr></thead><tbody>
      {obligations.map(reg => {
        const payments = reg.payments || []
        const approved = payments.filter(p => p.state === 'approved').reduce((sum, p) => sum + Number(p.amount || 0), 0)
        const pending = payments.filter(p => p.state === 'pending').length > 0
        const member = reg.profiles || {}
        const remaining = Math.max(0, Number(reg.price || 0) - approved)
        const overdue = new Date(reg.pay_later_due_at) < new Date()
        return <tr key={reg.id}><td data-label="Event / Member"><b>{reg.events?.name || 'Event'}</b><small className="method">{member.full_name || 'Member'} · {member.email || ''}</small></td><td data-label="Selected">{dateTime(reg.pay_later_started_at)}</td><td data-label="Due date">{dateTime(reg.pay_later_due_at)}</td><td data-label="Outstanding" className="amount-cell">{money(remaining)}</td><td data-label="Status"><span className={`status ${overdue ? 'rejected' : 'pending'}`}><i />{pending ? 'Payment pending approval' : overdue ? 'Overdue · unpaid' : 'Unpaid'}</span></td>{canDelete && <td data-label="Action"><button type="button" className="outline-btn small member-delete-btn" onClick={() => onDelete(reg)}><Trash2 size={14} />Delete</button></td>}</tr>
      })}
    </tbody></table>{!obligations.length && <Empty text="No unpaid Pay Later obligations." />}</div>
  </section>
}

function MyPayLaterTable({ registrations }) {
  const obligations = registrations.filter(reg => reg.pay_later_started_at && Number(reg.price) > (reg.payments || []).filter(p => p.state === 'approved').reduce((sum, p) => sum + Number(p.amount || 0), 0))
  if (!obligations.length) return null
  return <section className="pay-later-admin-section my-pay-later-section">
    <div className="pay-later-admin-heading"><div><p className="eyebrow">PAY LATER</p><h2>Unpaid event balances</h2></div><span>{obligations.length}</span></div>
    <div className="table-wrap"><table><thead><tr><th>Event</th><th>Selected</th><th>Due date</th><th>Balance</th><th>Status</th></tr></thead><tbody>
      {obligations.map(reg => {
        const payments = reg.payments || []
        const approved = payments.filter(p => p.state === 'approved').reduce((sum, p) => sum + Number(p.amount || 0), 0)
        const pending = payments.some(p => p.state === 'pending')
        const overdue = new Date(reg.pay_later_due_at) < new Date()
        return <tr key={reg.id}><td data-label="Event"><b>{reg.events?.name || 'Event'}</b></td><td data-label="Selected">{dateTime(reg.pay_later_started_at)}</td><td data-label="Due date">{dateTime(reg.pay_later_due_at)}</td><td data-label="Balance" className="amount-cell">{money(Math.max(0, Number(reg.price || 0) - approved))}</td><td data-label="Status"><span className={`status ${pending ? 'pending' : overdue ? 'rejected' : 'pending'}`}><i />{pending ? 'Payment pending approval' : overdue ? 'Overdue · unpaid' : 'Unpaid'}</span></td></tr>
      })}
    </tbody></table></div>
  </section>
}

function PaginationControls({ total, page, pageSize = 5, onPageChange }) {
  const pageCount = Math.max(1, Math.ceil(total / pageSize))
  const first = total ? (page - 1) * pageSize + 1 : 0
  const last = Math.min(page * pageSize, total)
  return <div className="pagination-controls"><span className="pagination-summary">Showing {first}–{last} of {total}</span><div><button type="button" disabled={page <= 1} onClick={() => onPageChange(page - 1)}>Previous</button><span>Page {page} of {pageCount}</span><button type="button" disabled={page >= pageCount} onClick={() => onPageChange(page + 1)}>Next</button></div></div>
}

function PassCard({ pass }) {
  const [qr, setQr] = useState('')
  const [err, setErr] = useState('')
  useEffect(() => {
    let alive = true
    api(`/api/passes/${pass.id}/qr`, {}, 'receipt').then(d => { if (alive) setQr(d.dataUrl) }).catch(e => { if (alive) setErr(e.message) })
    return () => { alive = false }
  }, [pass.id])
  return <div className="pass-card"><div className="pass-top"><div className="pass-symbol"><Ticket size={19} /></div><span className="pass-label">VERIFIED PASS</span></div><div className="pass-event"><div><b>{pass.event?.name}</b><span>{date(pass.event?.event_date)}</span></div></div>{qr ? <img className="actual-qr" src={qr} alt="Event entrance QR code" /> : <span className="small-muted">{err || 'Loading secure pass?'}</span>}<small className="pass-token">Pass ID {(pass.token || '').slice(0, 8)}••••</small><p className="pass-hint">{pass.checked_in_at ? 'Checked in' : 'Present this QR code at the event entrance.'}</p></div>
}

function ProfileModal({ profile, onClose, onSaved, notify, setError }) {
  const [fullName, setFullName] = useState(profile.full_name || '')
  const [studentNumber, setStudentNumber] = useState(profile.student_number || '')
  const [yearLevel, setYearLevel] = useState(profile.year_level || '')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const save = async e => {
    e.preventDefault()
    setBusy(true); setErr('')
    try {
      const result = await api('/api/profile', { method: 'PATCH', body: JSON.stringify({ fullName, studentNumber: studentNumber || null, yearLevel: yearLevel || null }) }, 'profileSave')
      onSaved(result.profile)
      notify('Profile updated.')
      onClose()
    } catch (ex) { setErr(ex.message) } finally { setBusy(false) }
  }
  return <Modal onClose={onClose} className="profile-modal">
    <div className="modal-heading"><div><p className="eyebrow">ACCOUNT</p><h2>Edit profile</h2></div><ModalClose onClick={onClose} /></div>
    <p className="muted">Update your display details. Email, role, and permissions cannot be changed here.</p>
    {err && <ErrorBox text={err} onClose={() => setErr('')} />}
    <form onSubmit={save} className="modal-form">
      <label className="form-label" htmlFor="pf-name">Full name</label>
      <input id="pf-name" className="modal-input" value={fullName} onChange={e => setFullName(e.target.value)} required minLength={2} maxLength={80} />
      <label className="form-label">Email (read-only)</label>
      <input className="modal-input" value={profile.email || ''} disabled />
      <label className="form-label">Student number (optional)</label>
      <input className="modal-input" value={studentNumber} onChange={e => setStudentNumber(e.target.value)} maxLength={40} pattern="[A-Za-z0-9-]*" />
      <label className="form-label">Year level (optional)</label>
      <select className="modal-input" value={yearLevel} onChange={e => setYearLevel(e.target.value)}>
        <option value="">Not specified</option>
        <option value="1">1st Year</option>
        <option value="2">2nd Year</option>
        <option value="3">3rd Year</option>
        <option value="4">4th Year</option>
      </select>
      <label className="form-label">Role</label>
      <input className="modal-input" value={roleLabel(profile)} disabled />
      <div className="modal-actions"><button type="button" className="outline-btn" onClick={onClose} disabled={busy}>Cancel</button><button type="submit" className="primary" disabled={busy}>{busy ? 'Saving…' : 'Save changes'}</button></div>
    </form>
  </Modal>
}

function AddMemberModal({ onClose, onCreated, notify }) {
  const [fullName, setFullName] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('JPCS2026')
  const [yearLevel, setYearLevel] = useState('')
const [role, setRole] = useState('member')
  const [show, setShow] = useState(false)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const save = async e => {
    e.preventDefault()
    setErr('')
    if (!fullName.trim() || fullName.trim().length < 2) { setErr('Enter a valid full name.'); return }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) { setErr('Enter a valid email address.'); return }
    if (!yearLevel) { setErr('Select a year level.'); return }
    if (yearLevel < '1' || yearLevel > '4') { setErr('Select a valid year level.'); return }
    setBusy(true)
    try {
      await api('/api/members/create', { method: 'POST', body: JSON.stringify({ fullName: fullName.trim(), email: email.trim(), password, yearLevel: Number(yearLevel), role }) }, 'request')
      notify('Member account created.')
      onCreated()
      onClose()
    } catch (ex) { setErr(ex?.message || ex?.error || (typeof ex === 'string' ? ex : 'Something went wrong. Please try again later.')) } finally { setBusy(false) }
  }
  return <Modal onClose={onClose} className="profile-modal add-member-modal">
    <div className="modal-heading"><div><p className="eyebrow">ADMIN</p><h2>Add member</h2></div><ModalClose onClick={onClose} /></div>
    <p className="muted">Create a member account. They will be asked to change their password on first login.</p>
    {err && <ErrorBox text={err} onClose={() => setErr('')} />}
    <form onSubmit={save} className="modal-form">
      <label className="form-label" htmlFor="am-name">Full name</label>
      <input id="am-name" className="modal-input" value={fullName} onChange={e => setFullName(e.target.value)} required />
      <label className="form-label" htmlFor="am-email">Email address</label>
      <input id="am-email" className="modal-input" type="email" value={email} onChange={e => setEmail(e.target.value)} required />
      <label className="form-label" htmlFor="am-pass">Default password</label>
      <div className="password-row"><input id="am-pass" className="modal-input" type={show ? 'text' : 'password'} value={password} onChange={e => setPassword(e.target.value)} required minLength={6} /><button type="button" className="text-button" onClick={() => setShow(s => !s)}>{show ? 'Hide' : 'Show'}</button></div>
      <label className="form-label" htmlFor="am-year">Year level</label>
      <select id="am-year" className="modal-input" value={yearLevel} onChange={e => setYearLevel(e.target.value)} required>
        <option value="">Select year level</option>
        <option value="1">1st Year</option>
        <option value="2">2nd Year</option>
        <option value="3">3rd Year</option>
        <option value="4">4th Year</option>
      </select>
      <label className="form-label" htmlFor="am-role">Role</label>
      <select id="am-role" className="modal-input" value={role} onChange={e => setRole(e.target.value)}>
        <option value="member">Member</option>
        <option value="treasurer">Treasurer · Officer</option>
        <option value="auditor">Auditor · Officer</option>
        <option value="admin">Administrator</option>
      </select>
      <div className="modal-actions"><button type="button" className="outline-btn" onClick={onClose} disabled={busy}>Cancel</button><button type="submit" className="primary" disabled={busy}>{busy ? 'Creating…' : 'Create member'}</button></div>
    </form>
  </Modal>
}

function MemberEditModal({ member, onClose, onSaved }) {
  const [fullName, setFullName] = useState(member.full_name || '')
  const [studentNumber, setStudentNumber] = useState(member.student_number || '')
  const [yearLevel, setYearLevel] = useState(member.year_level ? String(member.year_level) : '')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const save = async event => {
    event.preventDefault()
    setError('')
    setBusy(true)
    try {
      await api('/api/members/update', { method: 'PATCH', body: JSON.stringify({
        userId: member.id,
        fullName: fullName.trim(),
        studentNumber: studentNumber.trim() || null,
        yearLevel: yearLevel ? Number(yearLevel) : null
      }) }, 'request')
      onSaved()
      onClose()
    } catch (ex) { setError(ex.message || 'Could not update this member.') } finally { setBusy(false) }
  }
  return <Modal onClose={onClose} className="profile-modal">
    <div className="modal-heading"><div><p className="eyebrow">MEMBER DIRECTORY</p><h2>Edit member</h2></div><ModalClose onClick={onClose} /></div>
    {error && <ErrorBox text={error} />}
    <form onSubmit={save} className="modal-form">
      <label className="form-label" htmlFor="member-edit-name">Full name</label>
      <input id="member-edit-name" className="modal-input" value={fullName} onChange={event => setFullName(event.target.value)} required minLength={2} maxLength={80} />
      <label className="form-label" htmlFor="member-edit-email">Email</label>
      <input id="member-edit-email" className="modal-input" value={member.email || ''} disabled />
      <label className="form-label" htmlFor="member-edit-number">Student number</label>
      <input id="member-edit-number" className="modal-input" value={studentNumber} onChange={event => setStudentNumber(event.target.value)} maxLength={40} pattern="[A-Za-z0-9-]*" />
      <label className="form-label" htmlFor="member-edit-year">Year level</label>
      <select id="member-edit-year" className="modal-input" value={yearLevel} onChange={event => setYearLevel(event.target.value)}>
        <option value="">Not specified</option><option value="1">1st Year</option><option value="2">2nd Year</option><option value="3">3rd Year</option><option value="4">4th Year</option>
      </select>
      <div className="modal-actions"><button type="button" className="outline-btn" onClick={onClose} disabled={busy}>Cancel</button><button type="submit" className="primary" disabled={busy}>{busy ? 'Saving…' : 'Save changes'}</button></div>
    </form>
  </Modal>
}

const validEmail = value => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value || '').trim())

function MemberImportModal({ onClose, onImported, members }) {
  const [file, setFile] = useState(null)
  const [fingerprint, setFingerprint] = useState('')
  const [records, setRecords] = useState([])
  const [reviewFilter, setReviewFilter] = useState('all')
  const [warnings, setWarnings] = useState([])
  const [extractedText, setExtractedText] = useState('')
  const [expectedCountHint, setExpectedCountHint] = useState(null)
  const [progress, setProgress] = useState(null)
  const [importProgress, setImportProgress] = useState({ completed: 0, total: 0 })
  const [processing, setProcessing] = useState(false)
  const [importing, setImporting] = useState(false)
  const [error, setError] = useState('')
  const [summary, setSummary] = useState(null)
  const [expanded, setExpanded] = useState(false)
  const collapsePreviewRef = useRef(null)
  const expandPreviewRef = useRef(null)
  const hadExpandedView = useRef(false)
  const previewTableRef = useRef(null)
  const previewScrollPosition = useRef({ top: 0, left: 0 })
  const busy = processing || importing

  useEffect(() => {
    if (expanded) {
      collapsePreviewRef.current?.focus()
      hadExpandedView.current = true
    } else if (hadExpandedView.current) {
      expandPreviewRef.current?.focus()
      hadExpandedView.current = false
    }
    if (previewTableRef.current) {
      previewTableRef.current.scrollTop = previewScrollPosition.current.top
      previewTableRef.current.scrollLeft = previewScrollPosition.current.left
    }
  }, [expanded])

  const reviewed = useMemo(() => {
    const seenEmail = new Set(), seenStudent = new Set(), seenRow = new Set(), existingEmail = new Set(), existingStudent = new Set()
    for (const member of members || []) {
      if (member.email) existingEmail.add(member.email.trim().toLowerCase())
      if (member.student_number) existingStudent.add(member.student_number.trim().toLowerCase())
    }
    return records.map(record => {
      const emailKey = record.email.trim().toLowerCase()
      const studentKey = record.studentNumber.trim().toLowerCase()
      const rowNumber = record.directoryRow === null || record.directoryRow === '' ? null : Number(record.directoryRow)
      const repeatedDirectoryRow = Number.isSafeInteger(rowNumber) && seenRow.has(rowNumber)
      const emailDuplicate = emailKey && (existingEmail.has(emailKey) || seenEmail.has(emailKey))
      const studentDuplicate = studentKey && (seenStudent.has(studentKey) || existingStudent.has(studentKey))
      if (Number.isSafeInteger(rowNumber)) seenRow.add(rowNumber)
      if (emailKey) seenEmail.add(emailKey)
      if (studentKey) seenStudent.add(studentKey)
      const requiredIssues = []
      if (!record.firstName.trim() || !record.lastName.trim()) requiredIssues.push('First and last name are required.')
      if (!validEmail(record.email)) requiredIssues.push(record.email.trim() ? 'Email address is invalid.' : 'Email address is missing.')
      if (!/^[1-5]$/.test(String(record.yearLevel || ''))) requiredIssues.push('Year level 1–5 is required.')
      const optionalIssues = ['studentNumber', 'middleInitial', 'program', 'sex', 'contactNumber', 'address'].filter(key => !String(record[key] || '').trim()).map(key => `${key} is blank.`)
      const duplicate = Boolean(emailDuplicate || studentDuplicate || repeatedDirectoryRow)
      const status = record.excluded ? 'excluded' : duplicate ? 'duplicate' : requiredIssues.length ? 'incomplete' : 'valid'
      return { ...record, status, requiredIssues, optionalIssues, duplicate }
    })
  }, [records, members])

  const counts = useMemo(() => reviewed.reduce((result, row) => { result[row.status] += 1; return result }, { valid: 0, incomplete: 0, duplicate: 0, excluded: 0 }), [reviewed])
  const rowNumbers = reviewed.map(row => row.directoryRow === null || row.directoryRow === '' ? null : Number(row.directoryRow)).filter(Number.isSafeInteger)
  const repeatedRows = [...new Set(rowNumbers.filter((row, index) => rowNumbers.indexOf(row) !== index))]
  const distinctNumbers = [...new Set(rowNumbers)].sort((a, b) => a - b)
  const currentGaps = distinctNumbers.slice(1).flatMap((number, index) => {
    const previous = distinctNumbers[index]
    return number - previous > 1 ? [{ from: previous + 1, to: number - 1, count: number - previous - 1 }] : []
  })
  const importReady = counts.valid > 0

  const chooseFile = async selected => {
    if (!selected) return
    setError(''); setSummary(null); setRecords([]); setWarnings([]); setExtractedText(''); setExpectedCountHint(null); setFingerprint(''); setFile(null)
    if (selected.type !== 'application/pdf' && !selected.name.toLowerCase().endsWith('.pdf')) { setError('Choose a PDF file.'); return }
    if (selected.size > MAX_DIRECTORY_PDF_BYTES) { setError('The PDF must be 100 MB or smaller.'); return }
    setFile(selected); setProcessing(true); setProgress({ phase: 'reading' })
    try {
      const [parsed, hash] = await Promise.all([extractStudentDirectoryPdf(selected, setProgress), fingerprintFile(selected)])
      setRecords(parsed.records); setWarnings(parsed.warnings); setExtractedText(parsed.rawText || ''); setExpectedCountHint(parsed.expectedCountHint); setFingerprint(hash)
      setProgress({ phase: 'complete', pages: parsed.pageCount, records: parsed.records.length })
    } catch (ex) { setError(ex.message || 'Could not process this PDF.'); setProgress(null) } finally { setProcessing(false) }
  }

  const updateRecord = (index, key, value) => setRecords(previous => previous.map((record, row) => row === index ? { ...record, [key]: value } : record))
  const importRecords = async () => {
    if (!file || !fingerprint || !importReady) return
    setImporting(true); setError(''); setSummary(null)
    const results = []
    const batchCount = Math.ceil(reviewed.length / 10)
    setImportProgress({ completed: 0, total: batchCount })
    try {
      for (let start = 0; start < reviewed.length; start += 10) {
        const batch = reviewed.slice(start, start + 10).map(({ status, requiredIssues, optionalIssues, duplicate, ...record }, batchIndex) => ({
          ...record,
          recordIndex: start + batchIndex + 1,
          directoryRow: record.directoryRow === '' || record.directoryRow == null ? null : Number(record.directoryRow),
          yearLevel: record.yearLevel ? Number(record.yearLevel) : null,
          excluded: status === 'excluded',
          duplicateInFile: duplicate,
          notes: [...requiredIssues, ...optionalIssues]
        }))
        try {
          const response = await api('/api/members/import', { method: 'POST', body: JSON.stringify({ fingerprint, sourceFilename: file.name, expectedRecords: expectedCountHint, detectedRecords: reviewed.length, records: batch }) }, 'request')
          results.push(...(response.results || []))
        } catch (ex) {
          results.push(...batch.map(record => ({ recordIndex: record.recordIndex, directoryRow: record.directoryRow, status: 'failed', reason: ex.message || 'Request failed; retry this file safely.' })))
          setError(ex.message || 'A batch could not be imported. You can safely retry this file.')
        } finally { setImportProgress(previous => ({ ...previous, completed: Math.min(previous.completed + 1, previous.total) })) }
      }
      const totals = results.reduce((value, row) => { value[row.status] = (value[row.status] || 0) + 1; return value }, {})
      setSummary({ detected: reviewed.length, imported: totals.imported || 0, accountsCreated: results.filter(row => row.accountCreated).length, duplicate: totals.duplicate || 0, incomplete: totals.incomplete || 0, excluded: totals.excluded || 0, failed: totals.failed || 0, failedAccounts: results.filter(row => row.status === 'failed' && row.failureType === 'account').length, results })
      if ((totals.imported || 0) > 0) onImported()
    } catch (ex) { setError(ex.message || 'The import failed. No success has been assumed.') } finally { setImporting(false) }
  }

  const close = useCallback(() => { if (!busy) onClose() }, [busy, onClose])
  const handleEscape = useCallback(() => { if (expanded) setExpanded(false); else close() }, [expanded, close])
  const fields = [
    ['directoryRow', 'Directory row'], ['studentNumber', 'Student No.'], ['lastName', 'Last Name'], ['firstName', 'First Name'],
    ['middleInitial', 'Middle Initial'], ['program', 'Program'], ['yearLevel', 'Year Level'], ['sex', 'Sex'],
    ['email', 'Email'], ['contactNumber', 'Contact Number'], ['address', 'Address']
  ]
  const visibleReviewed = reviewed.map((record,index)=>({...record,recordIndex:index})).filter(record=>reviewFilter==='all'||record.status===reviewFilter)
  const previewTable = <><div className="member-import-filter"><label>Filter records <select value={reviewFilter} onChange={event=>setReviewFilter(event.target.value)}><option value="all">All statuses</option><option value="valid">Valid</option><option value="incomplete">Incomplete</option><option value="duplicate">Duplicate</option></select></label></div><div ref={previewTableRef} className="member-import-table-wrap" role="region" aria-label="Member preview table" tabIndex={0} onScroll={event => { previewScrollPosition.current = { top: event.currentTarget.scrollTop, left: event.currentTarget.scrollLeft } }}><table className="member-import-table"><thead><tr><th>Include</th>{fields.map(([, label]) => <th key={label}>{label}</th>)}<th>Review</th></tr></thead><tbody>{visibleReviewed.map(({recordIndex:index,...record}) => <tr key={`${record.directoryRow}-${index}`} className={`import-row-${record.status}`}>
    <td data-label="Include"><input type="checkbox" checked={!record.excluded} aria-label={`Include directory record ${record.directoryRow ?? index + 1}`} onChange={event => updateRecord(index, 'excluded', !event.target.checked)} /></td>
    {fields.map(([key, label]) => <td key={key} data-label={label}><input aria-label={`${label}, directory row ${record.directoryRow ?? index + 1}`} value={record[key] ?? ''} onChange={event => updateRecord(index, key, event.target.value)} disabled={busy || record.excluded} /></td>)}
    <td data-label="Review"><span className={`import-status ${record.status}`}>{record.status}</span>{record.requiredIssues.map(issue => <small key={issue}>{issue}</small>)}{record.duplicate && <small>Matches another directory row or existing member.</small>}{record.optionalIssues.map(issue => <small className="optional-import-warning" key={issue}>{issue}</small>)}</td>
  </tr>)}</tbody></table></div></>

  return <><Modal onClose={close} onEscape={handleEscape} contentHidden={expanded} className="member-import-modal" labelledBy="member-import-title">
    <div className="modal-heading"><div><p className="eyebrow">ADMIN · MEMBER DIRECTORY</p><h2 id="member-import-title">Import Members</h2></div><div className="member-import-heading-actions"><button ref={expandPreviewRef} type="button" className="member-import-expand" aria-label="Expand member preview table" disabled={!reviewed.length || Boolean(summary)} onClick={() => setExpanded(true)}><Maximize2 size={16} />Expand Table</button><ModalClose onClick={close} /></div></div>
    <div className="member-import-body" tabIndex={0} aria-label="Member import content">
    <p className="muted">Upload a student directory PDF. Searchable text is extracted directly, and scanned pages are read with OCR. Review and correct detected records before saving any member accounts or directory data.</p>
    {!summary && <>
      <label className={`member-import-dropzone ${processing ? 'processing' : ''} ${file ? 'has-file' : ''}`} onDragOver={event => event.preventDefault()} onDrop={event => { event.preventDefault(); chooseFile(event.dataTransfer.files?.[0]) }}>
        <input type="file" accept="application/pdf,.pdf" disabled={busy} onChange={event => { chooseFile(event.target.files?.[0]); event.target.value = '' }} />
        <Upload size={25} /><b>{file ? file.name : 'Drop the student directory PDF here'}</b><span>{file ? `${(file.size / 1024 / 1024).toFixed(1)} MB` : 'or click to browse · PDF only · up to 100 MB'}</span>
      </label>
      {processing && <div className="member-import-progress"><span>{progress?.phase === 'ocr' ? `Running OCR on scanned page ${progress.page} of ${progress.pages}…` : progress?.phase === 'extracting' ? `Reading page ${progress.page} of ${progress.pages}…` : 'Opening and reading PDF…'}</span><progress max={progress?.pages || 1} value={progress?.page || 0} /></div>}
      {importing && <div className="member-import-progress"><span>Saving batch {importProgress.completed + 1} of {importProgress.total}…</span><progress max={importProgress.total || 1} value={importProgress.completed} /></div>}
      {error && <ErrorBox text={error} />}
      {file && !processing && records.length === 0 && warnings.length > 0 && <>
        <div className="member-import-warnings">{warnings.map((warning, index) => <p key={index}><AlertTriangle size={14} />{warning}</p>)}</div>
      </>}
      {file && !processing && extractedText && <details className="member-import-text-diagnostic"><summary>Inspect raw extracted PDF text</summary><pre>{extractedText}</pre></details>}
      {file && !processing && records.length > 0 && <>
        <div className="member-import-counts"><div><b>{reviewed.length}</b><span>Detected</span></div><div><b>{counts.valid}</b><span>Valid</span></div><div><b>{counts.incomplete}</b><span>Incomplete</span></div><div><b>{counts.duplicate}</b><span>Duplicates</span></div><div><b>{counts.excluded}</b><span>Excluded</span></div></div>
        <div className={`member-import-row-check ${currentGaps.length || repeatedRows.length ? 'warning' : 'complete'}`}>
          {currentGaps.length || repeatedRows.length ? <AlertTriangle size={17} /> : <CheckCircle2 size={17} />}
          <span>
            {rowNumbers.length === 0
              ? `${reviewed.length} records detected; the PDF does not provide clear row numbers.`
              : `Detected ${reviewed.length} records, numbered ${distinctNumbers[0]}–${distinctNumbers.at(-1)}${currentGaps.length ? `; gaps: ${currentGaps.map(gap => gap.from === gap.to ? gap.from : `${gap.from}–${gap.to}`).join(', ')}` : '; no gaps within the detected range'}${repeatedRows.length ? `; repeated: ${repeatedRows.join(', ')}` : ''}.`}
            {expectedCountHint != null && ` Document total hint: ${expectedCountHint}.`}
          </span>
          {(currentGaps.length || repeatedRows.length) > 0 && <span>Review numbering; rows are not fabricated.</span>}
        </div>
        {warnings.length > 0 && <div className="member-import-warnings">{warnings.map((warning, index) => <p key={index}><AlertTriangle size={14} />{warning}</p>)}</div>}
        {!importReady && <div className="member-import-warnings"><p><AlertTriangle size={14} />Correct at least one record so it has a valid name, email, and year level before confirming the import. Other incomplete records will remain available for review when you import.</p></div>}
        {!expanded && previewTable}
        <div className="member-import-password-notice"><ShieldCheck size={18} /><span><b>Initial password: JPCS2026</b><small>New accounts use this initial password and must change it immediately after their first login. No emails are sent during import; communicate the password through an appropriate channel outside the app.</small></span></div>
        <p className="muted member-import-note">Incomplete, duplicate, and excluded rows are retained in the import directory for review. Only eligible, non-duplicate rows with valid email addresses receive member profiles and login accounts.</p>
      </>}
    </>}
    {summary && <>
      <div className="member-import-result"><h3>Import results</h3><p>{summary.detected} directory records were submitted for processing.</p><div className="member-import-counts"><div><b>{summary.imported}</b><span>Members imported</span></div><div><b>{summary.accountsCreated}</b><span>Auth accounts created</span></div><div><b>{summary.duplicate}</b><span>Existing skipped</span></div><div><b>{summary.incomplete}</b><span>Needs correction</span></div><div><b>{summary.excluded}</b><span>Excluded</span></div><div><b>{summary.failedAccounts}</b><span>Failed account creation</span></div><div><b>{summary.failed}</b><span>Total failed</span></div></div></div>
      <div className="member-import-password-notice"><ShieldCheck size={18} /><span><b>Initial password: JPCS2026</b><small>New accounts must change it at first login. No emails were sent during this import.</small></span></div>
      {error && <ErrorBox text={error} />}
      {summary.results.some(row => row.status === 'failed') && <div className="member-import-warnings">{summary.results.filter(row => row.status === 'failed').map((row, index) => <p key={`${row.directoryRow}-${index}`}><AlertTriangle size={14} />Row {row.directoryRow}: {row.reason || 'Could not import this record.'}</p>)}</div>}
    </>}
    </div>
    <div className="modal-actions member-import-footer">
      {summary
        ? <><button type="button" className="outline-btn" onClick={() => setSummary(null)}>Back to preview</button><button type="button" className="primary" onClick={close}>Done</button></>
        : <><button type="button" className="outline-btn" onClick={close} disabled={busy}>Cancel</button><button type="button" className="primary" disabled={busy || !importReady || !fingerprint} onClick={importRecords}>{importing ? 'Importing…' : 'Import Members'}</button></>}
    </div>
  </Modal>{expanded && createPortal(<div className="member-import-fullscreen" role="dialog" aria-modal="true" aria-label="Expanded member preview">
    <div className="member-import-fullscreen-toolbar"><strong>Member Preview <span>{reviewed.length} records</span></strong><button ref={collapsePreviewRef} type="button" className="member-import-expand" aria-label="Collapse member preview table" onClick={() => setExpanded(false)}><Minimize2 size={16} />Collapse Table</button></div>
    {previewTable}
  </div>, document.body)}</>
}

function PaymentModal({ event, registration, onClose, onSubmitted, setError }) {
  const completed = eventIsCompleted(event)
  const [method, setMethod] = useState('')
  const [payLater, setPayLater] = useState(false)
  const [amount, setAmount] = useState('')
  const amountEdited = useRef(false)
  const [reference, setReference] = useState('')
  const [file, setFile] = useState(null)
  const [fileError, setFileError] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const methods = Array.isArray(event.methods) ? event.methods.filter(m => METHOD_META[m]) : ['cash', 'gcash', 'maribank']
  useEffect(() => { if (!method && methods.length) setMethod(methods[0]) }, [methods, method])
  const payments = registration?.payments || []
  const price = Number(registration?.price ?? event.price ?? 0)
  const approved = payments.filter(p => p.state === 'approved').reduce((a, p) => a + Number(p.amount || 0), 0)
  const pendingAmt = payments.filter(p => p.state === 'pending').reduce((a, p) => a + Number(p.amount || 0), 0)
  const used = approved + pendingAmt
  const remaining = Math.max(0, price - used)
  useEffect(() => { if (!amountEdited.current && !amount && remaining > 0) setAmount(String(remaining)) }, [remaining, amount])
  const meta = METHOD_META[method] || { label: method, description: '', icon: Wallet, qr: null }
  const Icon = meta.icon
  const handleFile = e => {
    const f = e.target.files?.[0]
    setFileError('')
    if (!f) { setFile(null); return }
    if (f.size > 5 * 1024 * 1024) { setFileError('Receipt must be 5 MB or less.'); setFile(null); e.target.value = ''; return }
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(f.type)) { setFileError('Receipt must be JPG, PNG, or WebP.'); setFile(null); e.target.value = ''; return }
    setFile(f)
  }
  const submit = async e => {
    e.preventDefault()
    setBusy(true); setErr(''); setError('')
    try {
      if (payLater) {
        const result = await api('/api/pay-later', { method: 'POST', body: JSON.stringify({ eventId: event.id }) }, 'payment')
        onSubmitted({ payLater: true, dueAt: result.registration?.pay_later_due_at, eventName: event.name, emailDelivery: result.email })
        return
      }
      if (!methods.length) throw new Error('No payment methods are configured for this event.')
      const value = Number(amount)
      if (!Number.isFinite(value) || value <= 0) throw new Error('Enter a valid amount.')
      if (value > remaining + 0.000001) throw new Error('That amount is more than the remaining balance for this event.')
      if (event.partial_payments_enabled === false && Math.abs(value - remaining) > 0.000001) throw new Error('This event requires payment of the full remaining balance.')
      if (method !== 'cash' && reference.trim().length < 4) throw new Error('Enter your transaction reference.')
      if (method !== 'cash' && !file) throw new Error('Upload your payment receipt before submitting.')
      let receiptPath = null
      if (method !== 'cash' && file) {
        const { data: sessionData } = await supabase.auth.getSession()
        const userId = sessionData.session?.user?.id
        if (!userId) throw new Error(friendlyError(new Error('session missing'), 'auth'))
        receiptPath = `${userId}/${crypto.randomUUID()}-${file.name.replace(/[^\w.-]/g, '_')}`
        const { error: upErr } = await supabase.storage.from('payment-receipts').upload(receiptPath, file, { contentType: file.type, upsert: false })
        if (upErr) throw new Error(friendlyError(upErr, 'upload'))
      }
      await api('/api/payments', { method: 'POST', body: JSON.stringify({ eventId: event.id, amount: value, method, transactionReference: reference.trim(), receiptPath }) }, 'payment')
      onSubmitted({ amount: value, eventName: event.name, method })
    } catch (ex) { setErr(ex.message) } finally { setBusy(false) }
  }
  return <Modal onClose={onClose} className="payment-modal">
    <div className="modal-heading"><div><p className="eyebrow">EVENT PAYMENT</p><h2>{event.name}</h2></div><ModalClose onClick={onClose} /></div>
    {completed ? <div className="success-state"><Clock3 size={42} /><h2>Payments are closed</h2><p>This event is completed, so new payments and Pay Later submissions are no longer accepted. Existing payment records and event history are unchanged.</p><button type="button" className="primary" onClick={onClose}>Close</button></div> : <>
    <div className="amount-due"><div><span>Price · {date(event.event_date)}</span>{event.venue && <span className="venue">Venue: {event.venue}</span>}</div><b>{money(price)}</b></div>
    <div className="due-row"><span>Amount due</span><b>{money(remaining)}</b></div>
    {event.description && <p className="muted">{event.description}</p>}
    {event.payment_instructions && <p className="muted">{event.payment_instructions}</p>}
    {remaining <= 0 && <ErrorBox text="This event is fully paid or already has a pending submission covering the balance." />}
    {(err || fileError) && <ErrorBox text={err || fileError} onClose={() => { setErr(''); setFileError('') }} />}
    <form onSubmit={submit} className="modal-form">
      {event.pay_later_enabled && price > 0 && !registration?.pay_later_started_at && <label className="checkbox pay-later-user-toggle"><input type="checkbox" checked={payLater} disabled={busy} onChange={e => setPayLater(e.target.checked)} />Enable Pay Later for this payment <small>Due within 3 days. Leave unchecked to submit a Cash, GCash, or MariBank payment normally.</small></label>}
      {registration?.pay_later_started_at && <div className="cash-note pay-later-note"><Clock3 size={18} /><p>Pay Later is already active for this event, due {dateTime(registration.pay_later_due_at)}. To pay now, select Cash, GCash, or MariBank below. This will not create another Pay Later obligation.</p></div>}
      {!payLater && <label className="form-label">Payment method</label>}
      {!payLater && <div className="method-cards" role="radiogroup" aria-label="Payment method">
        {methods.map(m => {
          const mm = METHOD_META[m]
          const MIcon = mm.icon
          const selected = method === m
          return <button type="button" key={m} role="radio" aria-checked={selected && !payLater} className={`method-card ${selected && !payLater ? 'selected' : ''}`} onClick={() => { setMethod(m); setPayLater(false) }}>
            <div className="method-card-top"><MIcon size={18} /><span>{mm.label}</span>{selected && <CheckCircle2 size={16} className="check" />}</div>
            <p className="muted">{mm.description}</p>
          </button>
        })}
      </div>}
      {!payLater && methods.length === 0 && <ErrorBox text="No payment methods are configured for this event." />}
      {payLater && <div className="cash-note pay-later-note"><Clock3 size={18} /><p>Your unpaid balance will be due 3 days after you choose Pay Later. We’ll email you the due date. You can submit an actual payment using Cash, GCash, or MariBank before then.</p></div>}
      {!payLater && meta.qr && <div className="qr-payment"><div className="qr-frame"><img src={meta.qr} alt={`${meta.label} QR code`} /></div><p className="muted">Scan the QR code with your e-wallet, then upload a clear screenshot or photo of your receipt.</p></div>}
      {!payLater && method === 'cash' && <div className="cash-note"><Banknote size={18} /><p>Pay in person to a JPCS officer. No receipt upload is needed.</p></div>}
      {!payLater && <div className="form-row">
         <div className="form-field"><label className="form-label" htmlFor="pay-amount">Amount to submit</label><input id="pay-amount" className="modal-input" name="amount" type="number" min={event.partial_payments_enabled === false ? remaining : '0.01'} step="0.01" max={remaining} value={amount} onChange={e => { amountEdited.current = true; setAmount(e.target.value) }} required />{event.partial_payments_enabled === false && <small className="muted">Pay the full remaining balance; partial payments are disabled for this event.</small>}</div>
      </div>}
      {!payLater && method !== 'cash' && <><label className="form-label" htmlFor="pay-ref">Transaction reference</label><input id="pay-ref" className="modal-input" name="reference" maxLength={120} value={reference} onChange={e => setReference(e.target.value)} placeholder="Enter your GCash/MariBank reference number" required /></>}
      {!payLater && method !== 'cash' && <><label className="form-label">Receipt image (required)</label><input className="file-input" name="receipt" type="file" accept="image/jpeg,image/png,image/webp" onChange={handleFile} required /><small className="muted">JPG, PNG, or WebP · up to 5 MB</small></>}
      <div className="modal-actions"><button type="button" className="outline-btn" onClick={onClose} disabled={busy}>Cancel</button><button type="submit" className="primary" disabled={busy || remaining <= 0 || (!payLater && (methods.length === 0 || !method))}>{busy ? 'Submitting…' : payLater ? 'Submit Pay Later' : 'Submit for verification'}</button></div>
    </form>
    </>}
  </Modal>
}

function PaymentSuccessModal({ amount, eventName, payLater, dueAt, emailDelivery, onClose }) {
  return <Modal onClose={onClose}>
    <div className="success-state"><CheckCircle2 size={48} /><h2>{payLater ? 'Pay Later selected' : 'Submitted for verification'}</h2><p>{payLater ? <>Your payment for <b>{eventName}</b> is <b>not paid yet</b>. Please pay within 3 days, by <b>{dateTime(dueAt)}</b>. You’ll see this obligation in My payments.</> : <>Your {money(amount)} payment for <b>{eventName}</b> is pending officer review. You'll see it in My payments.</>}</p>{payLater && emailDelivery?.sentAt && <p className="muted">Pay Later email sent to your registered email address.</p>}{payLater && emailDelivery?.configured === false && <p className="muted">The Pay Later email is queued, but email delivery is not configured. Please contact an administrator.</p>}{payLater && emailDelivery?.configured && !emailDelivery.sentAt && emailDelivery.sent === 0 && <p className="muted">The email could not be sent yet{emailDelivery.failures?.[0]?.error ? `: ${emailDelivery.failures[0].error}` : '.'} It remains in the outbox for retry.</p>}<button type="button" className="primary" onClick={onClose}>Done</button></div>
  </Modal>
}

function PaymentDetailModal({ payment, admin, profile, onClose, onReview, onDelete, requestConfirm }) {
  const reg = payment.registrations || payment.registration || {}
  const member = reg.profiles || payment.profiles || {}
  const ev = reg.events || payment.event || {}
  const memberName = member.full_name || (profile && !admin ? profile.full_name : payment.member_name) || 'Member'
  const memberEmail = member.email || (profile && !admin ? profile.email : '') || ''
  const [receipt, setReceipt] = useState({ loading: !!payment.receipt_path, url: '', error: '' })
  const [imageFailed, setImageFailed] = useState(false)
  const [decision, setDecision] = useState('')
  const [remarks, setRemarks] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const [reviewerName, setReviewerName] = useState('')
  const [reviewerLoading, setReviewerLoading] = useState(false)
  useEffect(() => {
    let alive = true
    if (!payment.receipt_path) { setReceipt({ loading: false, url: '', error: '' }); return }
    setImageFailed(false)
    api(`/api/receipts/${payment.id}`, {}, 'receipt').then(d => { if (alive) setReceipt({ loading: false, url: d.url, error: '' }) }).catch(ex => { if (alive) setReceipt({ loading: false, url: '', error: ex.message }) })
    return () => { alive = false }
  }, [payment.id, payment.receipt_path])
  useEffect(() => {
    let alive = true
    if (!payment.reviewed_by) { setReviewerName(''); setReviewerLoading(false); return }
    setReviewerLoading(true)
    api('/api/payments/reviewer', { method: 'POST', body: JSON.stringify({ paymentId: payment.id }) }, 'request')
      .then(result => { if (alive) setReviewerName(result.reviewerName || '') })
      .catch(() => { if (alive) setReviewerName('') })
      .finally(() => { if (alive) setReviewerLoading(false) })
    return () => { alive = false }
  }, [payment.id, payment.reviewed_by])
  const retry = () => { setReceipt({ loading: true, url: '', error: '' }); setImageFailed(false); api(`/api/receipts/${payment.id}`, {}, 'receipt').then(d => setReceipt({ loading: false, url: d.url, error: '' })).catch(ex => setReceipt({ loading: false, url: '', error: ex.message })) }
  const submit = async () => {
    if (decision === 'rejected' && remarks.trim().length < 3) { setErr('Add a short reason (at least 3 characters).'); return }
    setBusy(true); setErr('')
    try { await onReview(payment, decision, remarks.trim()); onClose() } catch (ex) { setErr(ex.message) } finally { setBusy(false) }
  }
  const remove = () => requestConfirm({
    title: 'Delete payment?',
    message: `Delete this ${money(payment.amount)} ${payment.method} payment? This action will be recorded in the audit log.`,
    confirmText: 'Delete payment',
    destructive: true,
    onConfirm: async () => { await onDelete(payment); onClose() }
  })
  const pending = payment.state === 'pending'
  return <Modal onClose={onClose} className="review-modal">
    <div className="modal-heading"><div><p className="eyebrow">PAYMENT DETAILS</p><h2>{ev.name || 'Event'}</h2></div><ModalClose onClick={onClose} /></div>
    <div className="review-status-row"><span className={`status ${payment.state === 'approved' ? 'paid' : payment.state === 'rejected' ? 'rejected' : 'pending'}`}><i />{payment.state === 'approved' ? 'Approved' : payment.state === 'rejected' ? 'Rejected' : 'Pending verification'}</span></div>
    <div className="review-grid">
      <section className="review-card"><h3>Member</h3><div className="review-lines"><div><span>Name</span><b>{memberName}</b></div><div><span>Email</span><b>{memberEmail || '—'}</b></div>{member.student_number && <div><span>Student number</span><b>{member.student_number}</b></div>}{member.year_level && <div><span>Year level</span><b>{yearLabel(member.year_level)}</b></div>}</div></section>
       <section className="review-card"><h3>Payment</h3><div className="review-lines"><div><span>Amount</span><b>{money(payment.amount)}</b></div><div><span>Method</span><b>{payment.method}</b></div><div><span>Reference</span><b>{payment.transaction_reference || 'Not provided'}</b></div><div><span>Submitted</span><b>{dateTime(payment.submitted_at)}</b></div>{payment.reviewed_by && <><div><span>Reviewed by</span><b>{reviewerLoading ? 'Loading…' : reviewerName || 'Officer'}</b></div>{payment.reviewed_at && <div><span>Reviewed at</span><b>{dateTime(payment.reviewed_at)}</b></div>}</>}</div></section>
    </div>
    <section className="review-card"><h3>Receipt</h3>
      {receipt.loading && <div className="receipt-state"><RefreshCw size={16} className="spin" />Loading receipt…</div>}
      {!receipt.loading && !payment.receipt_path && <div className="receipt-state"><FileImage size={18} />No receipt attached. {payment.method === 'cash' ? 'Cash payments are verified in person.' : 'No receipt was uploaded.'}</div>}
      {!receipt.loading && payment.receipt_path && receipt.error && <div className="receipt-state"><AlertTriangle size={18} />{receipt.error}<button type="button" className="text-button" onClick={retry}>Retry</button></div>}
      {!receipt.loading && receipt.url && !imageFailed && <div className="receipt-preview-wrap"><a href={receipt.url} target="_blank" rel="noopener noreferrer"><img src={receipt.url} alt="Payment receipt" className="receipt-preview" onError={() => setImageFailed(true)} /></a><a href={receipt.url} target="_blank" rel="noopener noreferrer" className="open-receipt">Open larger in new tab <ExternalLink size={14} /></a></div>}
      {!receipt.loading && receipt.url && imageFailed && <div className="receipt-state"><AlertTriangle size={18} />The receipt preview could not be shown.<a href={receipt.url} target="_blank" rel="noopener noreferrer" className="open-receipt">Open in new tab <ExternalLink size={14} /></a></div>}
    </section>
    {payment.remarks && <section className="review-card"><h3>Officer remarks</h3><p className="muted">{payment.remarks}</p></section>}
    {admin && pending && <section className="review-actions-card">
      {!decision && <div className="review-decision"><button type="button" className="approve-btn" onClick={() => setDecision('approved')}><Check size={16} /> Approve</button><button type="button" className="reject-btn" onClick={() => setDecision('rejected')}><X size={16} /> Reject</button></div>}
      {decision === 'approved' && <div className="review-confirm"><p>Approve this {money(payment.amount)} payment from {memberName}?</p><div className="modal-actions"><button type="button" className="outline-btn" onClick={() => setDecision('')} disabled={busy}>Back</button><button type="button" className="primary" onClick={submit} disabled={busy}>{busy ? 'Approving…' : 'Confirm approval'}</button></div></div>}
      {decision === 'rejected' && <div className="review-confirm"><label className="form-label">Reason for rejection</label><textarea className="modal-input" value={remarks} onChange={e => setRemarks(e.target.value)} rows={4} placeholder="Explain what needs to be corrected." required /><div className="modal-actions"><button type="button" className="outline-btn" onClick={() => setDecision('')} disabled={busy}>Back</button><button type="button" className="reject-btn solid" onClick={submit} disabled={busy || remarks.trim().length < 3}>{busy ? 'Rejecting…' : 'Confirm rejection'}</button></div></div>}
      {err && <ErrorBox text={err} />}
    </section>}
    {admin && !pending && <section className="review-actions-card"><p className="muted">This payment has already been reviewed.</p></section>}
    {admin && profile?.role === 'admin' && <section className="review-actions-card payment-delete-actions"><p className="muted">Remove this payment submission from the records.</p><button type="button" className="reject-btn solid" onClick={remove} disabled={busy}><Trash2 size={15} />{busy ? 'Deleting…' : 'Delete payment'}</button>{err && <ErrorBox text={err} />}</section>}
  </Modal>
}

function EventModal({ event, onClose, onSaved, notify, setError, requestConfirm }) {
  const [name, setName] = useState(event?.name || '')
  const [description, setDescription] = useState(event?.description || '')
  const [price, setPrice] = useState(event?.price ?? '')
  const [eventDate, setEventDate] = useState(localDate(event?.event_date))
  const [venue, setVenue] = useState(event?.venue || '')
  const [deadline, setDeadline] = useState(localDate(event?.payment_deadline))
  const [instructions, setInstructions] = useState(event?.payment_instructions || '')
  const [active, setActive] = useState(event?.active ?? true)
  const [completed, setCompleted] = useState(event?.completed ?? false)
  const [payLaterEnabled, setPayLaterEnabled] = useState(event?.pay_later_enabled ?? true)
  const [partialPaymentsEnabled, setPartialPaymentsEnabled] = useState(event?.partial_payments_enabled ?? true)
  const [methods, setMethods] = useState(event?.methods || ['cash', 'gcash', 'maribank'])
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const toggle = m => { setMethods(prev => prev.includes(m) ? prev.filter(x => x !== m) : [...prev, m]) }
  const save = async e => {
    e.preventDefault()
    if (methods.length === 0) { setErr('Select at least one payment method.'); return }
    setBusy(true); setErr(''); setError('')
    try {
      const payload = { name, description, price: Number(price), event_date: localDateTimeToIso(eventDate), venue, payment_deadline: localDateTimeToIso(deadline), payment_instructions: instructions, active, completed, methods, pay_later_enabled: payLaterEnabled, partial_payments_enabled: partialPaymentsEnabled }
      if (!payload.name) throw new Error('Enter an event name.')
      if (!Number.isFinite(payload.price) || payload.price < 0) throw new Error('Enter a valid price.')
      let query
      if (event?.id) query = supabase.from('events').update(payload).eq('id', event.id)
      else query = supabase.from('events').insert(payload)
      const { error } = await query
      if (error) throw error
      onSaved()
      notify('Event saved.')
      onClose()
    } catch (ex) { setErr(friendlyError(ex, 'event')) } finally { setBusy(false) }
  }
  const remove = () => {
    if (!event?.id) return
    requestConfirm({
      title: 'Delete event?',
      message: `Delete “${event.name}”? Events with registration records cannot be deleted. Deleting a payment does not remove its registration.`,
      confirmText: 'Delete event',
      destructive: true,
      onConfirm: async () => {
        setBusy(true); setErr('')
        try {
          await api('/api/events/delete', { method: 'POST', body: JSON.stringify({ eventId: event.id }) }, 'event')
          onSaved(); notify('Event deleted.'); onClose()
        } catch (ex) { setErr(friendlyError(ex, 'event')); throw ex } finally { setBusy(false) }
      }
    })
  }
  return <Modal onClose={onClose} className="event-modal">
    <div className="modal-heading"><div><p className="eyebrow">EVENT MANAGEMENT</p><h2>{event?.id ? 'Edit event' : 'Create event'}</h2></div><ModalClose onClick={onClose} /></div>
    {err && <ErrorBox text={err} onClose={() => setErr('')} />}
    <form onSubmit={save} className="modal-form">
      <label className="form-label">Event name</label>
      <input className="modal-input" value={name} onChange={e => setName(e.target.value)} required />
      <label className="form-label">Description</label>
      <textarea className="modal-input" rows={3} value={description} onChange={e => setDescription(e.target.value)} />
      <div className="form-row two">
        <div className="form-field"><label className="form-label">Price (PHP)</label><input className="modal-input" type="number" min="0" step="0.01" value={price} onChange={e => setPrice(e.target.value)} required /></div>
        <div className="form-field"><label className="form-label">Event date</label><input className="modal-input" type="datetime-local" value={eventDate} onChange={e => setEventDate(e.target.value)} /></div>
      </div>
      <div className="form-row two">
        <div className="form-field"><label className="form-label">Venue</label><input className="modal-input" value={venue} onChange={e => setVenue(e.target.value)} /></div>
        <div className="form-field"><label className="form-label">Payment deadline</label><input className="modal-input" type="datetime-local" value={deadline} onChange={e => setDeadline(e.target.value)} /></div>
      </div>
      <label className="form-label">Payment instructions</label>
      <textarea className="modal-input" rows={2} value={instructions} onChange={e => setInstructions(e.target.value)} placeholder="e.g. Pay to the designated officer after mass." />
      <label className="form-label">Payment methods</label>
      <div className="checkbox-row">
        {['cash', 'gcash', 'maribank'].map(m => <label key={m} className="checkbox"><input type="checkbox" checked={methods.includes(m)} onChange={() => toggle(m)} />{METHOD_META[m].label}</label>)}
      </div>
      <label className="checkbox pay-later-toggle"><input type="checkbox" checked={payLaterEnabled} onChange={e => setPayLaterEnabled(e.target.checked)} />Enable Pay Later for this event <small>Members have 3 days to pay; actual payments still require approval.</small></label>
      <label className="checkbox pay-later-toggle"><input type="checkbox" checked={partialPaymentsEnabled} onChange={e => setPartialPaymentsEnabled(e.target.checked)} />Allow partial payments <small>Members may submit less than the full remaining balance.</small></label>
      <label className="checkbox"><input type="checkbox" checked={active} onChange={e => setActive(e.target.checked)} />Event active</label>
      <label className="checkbox"><input type="checkbox" checked={completed} onChange={e => setCompleted(e.target.checked)} />Event completed <small>Stops new registrations, payments, and Pay Later submissions. Existing records remain available.</small></label>
      <div className="modal-actions">{event?.id && <><button type="button" className="outline-btn event-delete-button" onClick={remove} disabled={busy}><Trash2 size={15} />Delete</button><span className="modal-actions-spacer" /></>}<button type="button" className="outline-btn" onClick={onClose} disabled={busy}>Cancel</button><button type="submit" className="primary" disabled={busy}>{busy ? 'Saving…' : 'Save event'}</button></div>
    </form>
  </Modal>
}

export default function App() {
  const [session, setSession] = useState(null)
  const [authReady, setAuthReady] = useState(false)
  const [profile, setProfile] = useState(null)
  const [profileState, setProfileState] = useState('idle')
  const [profileError, setProfileError] = useState('')
  const [profileRetry, setProfileRetry] = useState(0)
  const [dark, setDark] = useState(() => safeGet('jpcs-dark') === 'true')
  const [page, setPage] = useState(() => (location.pathname.startsWith('/verify/') ? 'Verify pass' : sessionGet('jpcs-page') || 'Overview'))
  const [events, setEvents] = useState([])
  const [registrations, setRegistrations] = useState([])
  const [payments, setPayments] = useState([])
  const [members, setMembers] = useState([])
  const [membersPage, setMembersPage] = useState(1)
  const [passes, setPasses] = useState([])
  const [query, setQuery] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [sessionExpiredNotice, setSessionExpiredNotice] = useState('')
  const [reauthRequired, setReauthRequired] = useState(false)
  const [showReauthForm, setShowReauthForm] = useState(false)
  const [toast, setToast] = useState('')
  const [modal, setModal] = useState(null)
  const [confirmDialog, setConfirmDialog] = useState(null)
  const [mobile, setMobile] = useState(false)
  const [mobileSearchOpen, setMobileSearchOpen] = useState(false)
  const [refresh, setRefresh] = useState(0)
  const [checkin, setCheckin] = useState(null)
  const [filterState, setFilterState] = useState('all')
  const [paymentStatusFilter, setPaymentStatusFilter] = useState('all')
  const [paymentMethodFilter, setPaymentMethodFilter] = useState('all')
  const [filterMethod, setFilterMethod] = useState('all')
  const [filterEvent, setFilterEvent] = useState('all')
  const [dateFrom, setDateFrom] = useState('')
  const [dateTo, setDateTo] = useState('')
  const [filterYear, setFilterYear] = useState('all')
  const [viewMode, setViewMode] = useState(() => safeGet('jpcs-workspace') || 'admin')
  const [profileMenu, setProfileMenu] = useState(false)
  const [moreOpen, setMoreOpen] = useState(false)
  const [dataLoading, setDataLoading] = useState(false)
  const menuRef = useRef(null)
  const toastTimer = useRef(null)
  const sessionRef = useRef(null)
  const intentionalSignOutRef = useRef(false)
  const notify = useCallback(msg => { setToast(msg); clearTimeout(toastTimer.current); toastTimer.current = setTimeout(() => setToast(''), 4000) }, [])
  const requestConfirm = useCallback(options => setConfirmDialog(options), [])
  useEffect(() => () => clearTimeout(toastTimer.current), [])
  const hasAdminRole = profile?.role === 'admin'
  const isAdmin = hasAdminRole && viewMode === 'admin'
  const userId = session?.user?.id

  useEffect(() => {
    if (!supabase) { setAuthReady(true); return }
    const { data: { subscription } } = supabase.auth.onAuthStateChange((event, next) => {
      // Keep this callback synchronous and state-only; Supabase owns refresh and storage synchronization.
      console.info('[auth] State changed.', { event })
      if (event === 'SIGNED_OUT') {
        const hadSession = Boolean(sessionRef.current)
        if (hadSession && !intentionalSignOutRef.current) {
          setSessionExpiredNotice('Your session could not be renewed. Try reconnecting, or sign in again if the problem continues.')
          setReauthRequired(true)
          setProfileError('We could not reconnect to your account. Your current page will stay open while you retry.')
          setProfileState('error')
          setAuthReady(true)
          return
        }
        sessionRef.current = null
        setSession(null); setProfile(null); setProfileState('idle'); setPage('Overview'); setModal(null)
      }
      else {
        sessionRef.current = next ?? null
        setSession(next ?? null)
        if (event === 'SIGNED_IN' || event === 'TOKEN_REFRESHED') {
          setSessionExpiredNotice('')
          setReauthRequired(false)
          setShowReauthForm(false)
          setProfileError('')
          setProfileRetry(value => value + 1)
        }
      }
      setAuthReady(true)
    })
    return () => subscription.unsubscribe()
  }, [])

  useEffect(() => {
    if (!authReady) return
    if (!userId) { setProfile(null); setProfileState('idle'); setProfileError(''); return }
    let alive = true
    setProfileState('loading'); setProfileError('')
    supabase.from('profiles').select('id,full_name,email,student_number,year_level,role,must_change_password,created_at').eq('id', userId).maybeSingle().then(({ data, error }) => {
      if (!alive) return
      if (error) {
        if (error.status === 401 || error.code === 'PGRST301' || /jwt|token.*expired|invalid.*token|refresh token/i.test(error.message || '')) {
          setSessionExpiredNotice('Your session may have expired. Retry to reconnect, or sign in again if it cannot be renewed.')
        }
        setProfileState('error'); setProfileError(friendlyError(error, 'profile')); return
      }
      if (!data) { setProfileState('missing'); setProfileError("We couldn't find a JPCS profile for this account. Contact a JPCS officer to provision it, then retry."); return }
      setProfile(data); setProfileState('ready')
      if (data.role !== 'member' && !safeGet('jpcs-workspace')) { setViewMode('admin'); safeSet('jpcs-workspace', 'admin') }
    }).catch(err => { if (alive) { setProfileState('error'); setProfileError(friendlyError(err, 'profile')) } })
    return () => { alive = false }
  }, [authReady, userId, profileRetry])

  const load = useCallback(async () => {
    if (!profile || profile.must_change_password) return
    setDataLoading(true); setError('')
    try {
      const eventFields = 'id,name,description,price,event_date,venue,payment_deadline,active,methods,instructions,payment_instructions,pay_later_enabled,partial_payments_enabled,completed,created_at'
      const paymentFields = 'id,registration_id,amount,method,transaction_reference,receipt_path,state,submitted_at,reviewed_by,reviewed_at,remarks'
      const passFields = 'id,registration_id,token,issued_at,checked_in_at,checked_in_by,pay_later'
      const profileFields = 'id,full_name,email,student_number,year_level,role'
      const eventRequest = supabase.from('events').select(eventFields).order('event_date', { ascending: true, nullsFirst: false })
      const isMember = !isAdmin
      const registrationFields = 'id,member_id,event_id,price,created_at,pay_later_started_at,pay_later_due_at'
      const registrationRelations = isMember
        ? `events(${eventFields}),payments(${paymentFields}),passes(${passFields})`
        : `events(${eventFields}),profiles(${profileFields}),passes(${passFields})`
      let registrationRequest = supabase.from('registrations').select(`${registrationFields},${registrationRelations}`).order('created_at', { ascending: false })
      if (isMember) registrationRequest = registrationRequest.eq('member_id', profile.id)
      const adminRequests = isAdmin ? Promise.all([
        supabase.from('payments').select(`id,registration_id,amount,method,transaction_reference,receipt_path,state,submitted_at,reviewed_by,reviewed_at,remarks,registrations(id,member_id,event_id,profiles(full_name,email,student_number,year_level),events(id,name,price,event_date))`).order('submitted_at', { ascending: false }),
        supabase.from('profiles').select(profileFields).order('full_name')
      ]) : Promise.resolve(null)
      const [e, r, adminData] = await Promise.all([eventRequest, registrationRequest, adminRequests])
      if (e.error) throw e.error
      if (r.error) throw r.error
      if (adminData && (adminData[0].error || adminData[1].error)) throw adminData[0].error || adminData[1].error
      const registrationPayments = new Map()
      if (adminData) for (const payment of adminData[0].data || []) {
        const registrationId = payment.registrations?.id
        if (!registrationId) continue
        if (!registrationPayments.has(registrationId)) registrationPayments.set(registrationId, [])
        registrationPayments.get(registrationId).push(payment)
      }
      const registrationRows = (r.data || []).map(registration => ({
        ...registration,
        payments: adminData ? registrationPayments.get(registration.id) || [] : registration.payments || [],
      }))
      setEvents(e.data || [])
      setRegistrations(registrationRows)
      if (adminData) {
        setPayments(adminData[0].data || [])
        setMembers(adminData[1].data || [])
      } else {
        setPayments(registrationRows.flatMap(x => (x.payments || []).map(p => ({ ...p, registration: x, event: x.events }))))
        setMembers([])
      }
      setPasses(registrationRows.flatMap(x => asArray(x.passes).map(p => ({ ...p, registration: x, event: x.events }))))
    } catch (ex) { setError(friendlyError(ex, 'load')) } finally { setDataLoading(false) }
  }, [profile, refresh])
  useEffect(() => { load() }, [load])

  useEffect(() => { if (!profile) return; const adminOnly = ['Check-in', 'Members', 'Payments', 'Reports']; if (!isAdmin && adminOnly.includes(page)) setPage('Overview') }, [profile, isAdmin, page])
  useEffect(() => { sessionSet('jpcs-page', page) }, [page])
  useEffect(() => { safeSet('jpcs-dark', dark ? 'true' : 'false') }, [dark])
  useEffect(() => {
    const onDown = e => { if (menuRef.current && !menuRef.current.contains(e.target)) setProfileMenu(false) }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [])

  const navigate = useCallback(name => { setPage(name); setMobile(false); setProfileMenu(false); window.scrollTo({ top: 0, behavior: 'auto' }) }, [])
  const signOut = async () => { setProfileMenu(false); setMobile(false); intentionalSignOutRef.current = true; try { await supabase?.auth.signOut() } catch {} intentionalSignOutRef.current = false; sessionRef.current = null; setSession(null); setProfile(null); setProfileState('idle'); setPage('Overview'); setModal(null); setError(''); setSessionExpiredNotice(''); setReauthRequired(false); setShowReauthForm(false); setToast(''); sessionRemove('jpcs-page') }
  const handleSignIn = async e => {
    e.preventDefault()
    setBusy(true); setError('')
    const d = new FormData(e.currentTarget)
    try {
      const { error: authError } = await supabase.auth.signInWithPassword({ email: d.get('email'), password: d.get('password') })
      if (authError) setError(friendlyError(authError, 'auth'))
    } catch (authError) {
      setError(friendlyError(authError, 'auth'))
    } finally {
      setBusy(false)
    }
  }
  const changePassword = async e => {
    e.preventDefault(); const d = new FormData(e.currentTarget); const password = d.get('password')
    if (password !== d.get('confirm')) { setError('Passwords do not match.'); return }
    try { setBusy(true); await api('/api/profile/password', { method: 'POST', body: JSON.stringify({ password }) }, 'auth'); setProfile(p => ({ ...p, must_change_password: false })); setError(''); notify('Password updated successfully.') } catch (ex) { setError(ex.message) } finally { setBusy(false) }
  }
  const retryProfile = async () => {
    setError(''); setProfileError('')
    if (sessionExpiredNotice) {
      setBusy(true)
      try {
        const renewedSession = await refreshSession(supabase.auth)
        sessionRef.current = renewedSession
        setSession(renewedSession)
        setSessionExpiredNotice('')
        setReauthRequired(false)
        setProfileRetry(value => value + 1)
      } catch (refreshError) {
        if (isInvalidRefreshTokenError(refreshError)) {
          setReauthRequired(true)
          setProfileError('This saved sign-in can no longer be renewed. Sign in again to keep using your account.')
        } else {
          setProfileError('We still can’t reconnect. Please check your internet connection and retry.')
        }
      } finally { setBusy(false) }
      return
    }
    setProfileRetry(value => value + 1)
  }
  const openPayment = event => { setError(''); navigate('Events'); setModal({ type: 'payment', event }) }
  const onPaymentSubmitted = info => { setModal({ type: 'paymentSubmitted', ...info }); setRefresh(v => v + 1) }
  const handleReview = async (payment, decision, remarks) => { await api(`/api/payments/${payment.id}/review`, { method: 'POST', body: JSON.stringify({ decision, remarks }) }, 'review'); setRefresh(v => v + 1); const sent = decision === 'approved'; if (decision === 'approved') notify('Payment approved. Confirmation email status is noted in your workspace.'); else notify('Payment rejected. The member can see the reason provided.') }
  const handleDeletePayment = async payment => { const result = await api('/api/payments/delete', { method: 'POST', body: JSON.stringify({ paymentId: payment.id }) }, 'request'); setRefresh(v => v + 1); notify(result.registrationDeleted ? 'Payment and its last-payment registration deleted. The action was added to the audit log.' : 'Payment deleted. Other payments or an active Pay Later obligation remain; the action was added to the audit log.') }
  const handleDeletePayLater = async registration => {
    requestConfirm({
      title: 'Delete Pay Later obligation?',
      message: `Delete the Pay Later obligation for ${registration.profiles?.full_name || 'this member'} — ${registration.events?.name || 'this event'}? Actual payment history will be kept.`,
      confirmText: 'Delete obligation',
      destructive: true,
      onConfirm: async () => {
        const result = await api('/api/pay-later/delete', { method: 'POST', body: JSON.stringify({ registrationId: registration.id }) }, 'request')
        setRefresh(v => v + 1); notify(result.registrationDeleted ? 'Pay Later obligation and its unpaid registration deleted. The action was added to the audit log.' : 'Pay Later obligation deleted. The registration and payment history were kept; the action was added to the audit log.')
      }
    })
  }
  const handleDeleteMember = async member => {
    if (member.role === 'admin' || member.id === userId) return
    requestConfirm({
      title: 'Delete member?',
      message: `Delete ${member.full_name}'s account? This cannot be undone.`,
      confirmText: 'Delete member',
      destructive: true,
      onConfirm: async () => {
        await api('/api/members/delete', { method: 'POST', body: JSON.stringify({ userId: member.id }) }, 'request')
        setRefresh(value => value + 1); notify('Member deleted.')
      }
    })
  }
  const openDetail = p => setModal({ type: 'paymentDetail', payment: p })
  const checkPass = async () => { try { setBusy(true); const token = location.pathname.split('/').pop(); const result = await api(`/api/passes/${encodeURIComponent(token)}/check-in`, { method: 'POST', body: JSON.stringify({}) }, 'checkin'); setCheckin(result) } catch (e) { setCheckin({ valid: false, error: e.message }) } finally { setBusy(false) } }
  const applyCheckin = data => { if (!data?.passId && !data?.token) return; setPasses(prev => prev.map(p => { const match = (data.passId && p.id === data.passId) || (data.token && p.token === data.token); return match ? { ...p, checked_in_at: data.checkedInAt || p.checked_in_at || new Date().toISOString() } : p })) }

  const memberRegs = useMemo(() => registrations.filter(r => r.member_id === userId), [registrations, userId])
  const myPayments = useMemo(() => hasAdminRole && viewMode === 'member' ? memberRegs.flatMap(r => (r.payments || []).map(p => ({ ...p, registration: r, event: r.events }))) : (isAdmin ? payments : memberRegs.flatMap(r => (r.payments || []).map(p => ({ ...p, registration: r, event: r.events })))), [hasAdminRole, viewMode, memberRegs, isAdmin, payments])
  const filteredEvents = useMemo(() => events.filter(e => e.name.toLowerCase().includes(query.toLowerCase()) || (e.venue || '').toLowerCase().includes(query.toLowerCase())), [events, query])
  const filteredPayments = useMemo(() => payments.filter(p => `${p.registrations?.events?.name || p.event?.name || ''} ${p.registrations?.profiles?.full_name || ''} ${p.registrations?.profiles?.email || ''} ${p.transaction_reference || ''}`.toLowerCase().includes(query.toLowerCase())), [payments, query])
  const visiblePayments = useMemo(() => {
    const source = isAdmin ? filteredPayments : myPayments.filter(p => `${p.event?.name || p.registration?.events?.name || ''} ${p.transaction_reference || ''}`.toLowerCase().includes(query.toLowerCase()))
    return source.filter(payment => (paymentStatusFilter === 'all' || payment.state === paymentStatusFilter) && (paymentMethodFilter === 'all' || payment.method === paymentMethodFilter))
  }, [isAdmin, filteredPayments, myPayments, query, paymentStatusFilter, paymentMethodFilter])
  const filteredMembers = useMemo(() => members.filter(m => `${m.full_name} ${m.email} ${m.student_number || ''}`.toLowerCase().includes(query.toLowerCase()) && (filterYear === 'all' || String(m.year_level) === filterYear)), [members, query, filterYear])
  useEffect(() => { setMembersPage(1) }, [query, filterYear])
  const membersPageCount = Math.max(1, Math.ceil(filteredMembers.length / 5))
  const currentMembersPage = Math.min(membersPage, membersPageCount)
  const pagedMembers = filteredMembers.slice((currentMembersPage - 1) * 5, currentMembersPage * 5)
  const reportItems = useMemo(() => payments.filter(p => (filterState === 'all' || p.state === filterState) && (filterMethod === 'all' || p.method === filterMethod) && (filterEvent === 'all' || p.registrations?.event_id === filterEvent) && (filterYear === 'all' || String(p.registrations?.profiles?.year_level) === filterYear) && (!query || `${p.registrations?.profiles?.full_name || ''} ${p.registrations?.profiles?.email || ''}`.toLowerCase().includes(query.toLowerCase())) && (!dateFrom || p.submitted_at >= dateFrom) && (!dateTo || p.submitted_at.slice(0, 10) <= dateTo)), [payments, filterState, filterMethod, filterEvent, filterYear, query, dateFrom, dateTo])
  const reportCollected = reportItems.filter(p => p.state === 'approved').reduce((sum, payment) => sum + Number(payment.amount || 0), 0)
  const reportPending = reportItems.filter(p => p.state === 'pending').length
  const reportRejected = reportItems.filter(p => p.state === 'rejected').length
  const reportApproved = reportItems.filter(p => p.state === 'approved').length
  const collected = payments.filter(p => p.state === 'approved').reduce((s, p) => s + Number(p.amount || 0), 0)
  const pendingList = payments.filter(p => p.state === 'pending')
  const rejectedCount = payments.filter(p => p.state === 'rejected').length
  const approvedCount = payments.filter(p => p.state === 'approved').length
  const memberPaid = memberRegs.flatMap(r => r.payments || []).filter(p => p.state === 'approved').reduce((s, p) => s + Number(p.amount || 0), 0)
  const memberPending = memberRegs.flatMap(r => r.payments || []).filter(p => p.state === 'pending').length
  const memberFullyPaid = memberRegs.filter(r => statusOf(r, r.events?.price) === 'Fully paid').length
  const memberPasses = passes.filter(p => p.registration?.member_id === userId && !p.pay_later).length
  const adminFullyPaid = registrations.filter(r => statusOf(r, r.events?.price) === 'Fully paid').length
  const adminPartially = registrations.filter(r => statusOf(r, r.events?.price) === 'Partially paid').length
  const nav = isAdmin ? [['Overview', Home], ['Check-in', ScanLine], ['Members', Users], ['Payments', CreditCard], ['Events', Ticket], ['Reports', Activity]] : [['Overview', Home], ['My payments', Wallet], ['Events', Ticket], ['My passes', ShieldCheck]]
  const mobileNav = isAdmin ? [['Overview', Home], ['Payments', CreditCard], ['Check-in', ScanLine], ['Events', Ticket], ['More', MoreHorizontal]] : [['Overview', Home], ['My payments', Wallet], ['Events', Ticket], ['My passes', ShieldCheck]]
  const pendingBadge = isAdmin ? pendingList.length : memberPending

  if (!supabase) return <AuthFrame dark={dark}><img className="login-logo" src="/images/jpcs-logo.png" alt="JPCS logo" /><p className="eyebrow">CONFIGURATION NEEDED</p><h1>Connect Supabase</h1><p className="muted">Set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY, then restart the app.</p></AuthFrame>
  if (!authReady) return <WorkspaceSkeleton dark={dark} />
  if (!session) {
    return <AuthFrame dark={dark}><img className="login-logo" src="/images/jpcs-logo.png" alt="JPCS logo" /><p className="eyebrow">WELCOME BACK</p><h1>Pick up where you left off.</h1><p className="muted">Sign in to access your JPCS events and payment activity.</p><div className="login-instructions"><b>Login instructions</b><ol><li><strong>Registered Email:</strong> Use the email address you submitted to JPCS.</li><li><strong>Default Password:</strong> JPCS2026</li></ol></div>{(sessionExpiredNotice || error) && <ErrorBox text={sessionExpiredNotice || error} onClose={() => { setError(''); setSessionExpiredNotice('') }} />}<form onSubmit={handleSignIn}><label htmlFor="si-email">Email address</label><input id="si-email" name="email" type="email" autoComplete="username" required /><label htmlFor="si-pass">Password</label><input id="si-pass" name="password" type="password" autoComplete="current-password" required /><button disabled={busy} className="primary full">{busy ? 'Signing in…' : 'Sign in'} <ArrowRight size={17} /></button></form><p className="login-card-footnote"><span className="login-footnote-desktop">Secure access for JPCS members and officers.</span><span className="login-footnote-mobile">Web Developer • Carl Andrei Lucido<br />QA Tester • Aerol Justine • Ms. Joyce</span></p></AuthFrame>
  }
  if ((profileState === 'loading' || profileState === 'idle') && !profile) return <WorkspaceSkeleton dark={dark} />
  if (profileState === 'missing' || (profileState === 'error' && (!profile || !sessionExpiredNotice))) {
    return <AuthFrame dark={dark}><img className="login-logo" src="/images/jpcs-logo.png" alt="JPCS logo" /><p className="eyebrow">ACCOUNT STATUS</p><h1>{sessionExpiredNotice ? 'Let’s reconnect' : profileState === 'missing' ? 'Account setup needed' : 'We can’t load your account'}</h1>{profileError && <ErrorBox text={profileError} />}{error && <ErrorBox text={error} onClose={() => setError('')} />}<p className="muted">{sessionExpiredNotice ? 'Your current page remains open. Retry a temporary connection issue, or sign in again if this saved session can no longer be renewed.' : profileState === 'missing' ? 'We couldn’t find a JPCS profile linked to this sign-in. Contact a JPCS officer to set up your account, then retry.' : 'This may be a temporary connection issue. Your sign-in is still saved; retry in a moment.'}</p>{sessionExpiredNotice && !reauthRequired && <button className="primary full" onClick={retryProfile} disabled={busy}>{busy ? 'Reconnecting…' : 'Retry connection'}</button>}{sessionExpiredNotice && reauthRequired && <button className="primary full" onClick={() => setShowReauthForm(true)}>Sign in again</button>}{showReauthForm && <form onSubmit={handleSignIn} className="reconnect-signin-form"><label htmlFor="reconnect-email">Email address</label><input id="reconnect-email" name="email" type="email" autoComplete="username" defaultValue={session?.user?.email || ''} required /><label htmlFor="reconnect-password">Password</label><input id="reconnect-password" name="password" type="password" autoComplete="current-password" required /><button className="primary full" disabled={busy}>{busy ? 'Signing in…' : 'Continue'}</button></form>}{!sessionExpiredNotice && <button className="logout-link" onClick={signOut}>Sign out</button>}</AuthFrame>
  }
  if (profile.must_change_password) {
    return <AuthFrame dark={dark}><img className="login-logo" src="/images/jpcs-logo.png" alt="JPCS logo" /><p className="eyebrow">FIRST SIGN-IN</p><h1>Set a new password</h1><p className="muted">Choose a secure password with at least 6 characters.</p>{error && <ErrorBox text={error} onClose={() => setError('')} />}<form onSubmit={changePassword}><label htmlFor="np-pass">New password</label><input id="np-pass" name="password" type="password" minLength="6" autoComplete="new-password" required /><label htmlFor="np-conf">Confirm password</label><input id="np-conf" name="confirm" type="password" minLength="6" autoComplete="new-password" required /><button className="primary full" disabled={busy}>{busy ? 'Updating…' : 'Change password'}</button></form><button className="logout-link" onClick={signOut}>Sign out</button></AuthFrame>
  }

  return <div className={`app-shell ${dark ? 'dark' : ''}`}><a className="skip-link" href="#main-content">Skip to main content</a>
    <aside className="sidebar"><div className="brand"><img src="/images/jpcs-logo.png" alt="JPCS logo" /><div><b>JPCS Pay</b><small>{isAdmin ? 'ADMIN WORKSPACE' : 'MEMBER WORKSPACE'}</small></div></div><div className="nav-caption">WORKSPACE</div><nav>{nav.map(([name, Icon]) => <button key={name} type="button" className={`nav-link ${page === name ? 'selected' : ''}`} onClick={() => navigate(name)}><Icon size={18} /><span>{name === 'Overview' ? 'Dashboard' : name}</span>{name === 'Payments' && pendingBadge > 0 && <i className="nav-badge">{pendingBadge}</i>}</button>)}</nav><div className="sidebar-bottom"><button type="button" className="nav-link" onClick={() => navigate('Settings')}><Settings size={18} /> Settings</button><div className="profile"><div className="avatar">{initials(profile.full_name)}</div><div className="profile-info"><b>{profile.full_name}</b><span>{roleLabel(profile)}</span></div><button type="button" className="icon-button" onClick={signOut} title="Log out" aria-label="Log out"><LogOut size={16} /></button></div></div></aside>
     <main id="main-content" className="main-area"><header className="topbar"><div className="topbar-left"><div className="crumb"><b>{page === 'Overview' ? 'Dashboard' : page}</b></div></div><div className="top-actions"><label className="search-box"><Search size={16} /><input placeholder="Search events, members, or payments" value={query} onChange={e => setQuery(e.target.value)} /></label><button type="button" className="icon-button mobile-search-toggle" onClick={() => setMobileSearchOpen(open => !open)} aria-label={mobileSearchOpen ? 'Close search' : 'Open search'} aria-expanded={mobileSearchOpen}><Search size={17} /></button><button type="button" className="icon-button" onClick={() => setDark(d => !d)} aria-label="Toggle theme">{dark ? <Sun /> : <Moon />}</button><button type="button" className="icon-button" onClick={() => setRefresh(v => v + 1)} title="Refresh" aria-label="Refresh"><RefreshCw size={16} className={dataLoading ? 'spin' : ''} /></button><span className="top-divider" /><div className="profile-menu-wrap" ref={menuRef}><button type="button" className="avatar small-avatar avatar-btn" onClick={() => setProfileMenu(s => !s)} aria-haspopup="menu" aria-expanded={profileMenu}>{initials(profile.full_name)}</button>{profileMenu && <div className="profile-menu" role="menu"><button type="button" role="menuitem" onClick={() => { setModal({ type: 'profileEdit' }); setProfileMenu(false) }}><Pencil size={16} /> Edit profile</button><button type="button" role="menuitem" onClick={() => navigate('Settings')}><Settings size={16} /> Settings</button><button type="button" role="menuitem" className="danger" onClick={signOut}><LogOut size={16} /> Log out</button></div>}</div></div>{mobileSearchOpen && <label className="mobile-search"><Search size={17} /><input autoFocus placeholder="Search events, members, or payments" value={query} onChange={e => setQuery(e.target.value)} /></label>}</header>
      <div className="content">
        {sessionExpiredNotice && <section className="session-recovery-banner" role="status"><div><b>{reauthRequired ? 'Please sign in to continue' : 'Reconnecting your account'}</b><span>{reauthRequired ? 'Your saved session can’t be renewed. Your current page is still open; sign in again to restore account access.' : 'Your current page is still open while we try to restore your sign-in.'}</span></div>{reauthRequired ? <form className="session-recovery-form" onSubmit={handleSignIn}><input aria-label="Email address" name="email" type="email" autoComplete="username" defaultValue={session?.user?.email || ''} required /><input aria-label="Password" name="password" type="password" autoComplete="current-password" placeholder="Password" required /><button type="submit" className="primary" disabled={busy}>{busy ? 'Signing in…' : 'Sign in'}</button></form> : <button type="button" className="outline-btn" onClick={retryProfile} disabled={busy}>{busy ? 'Retrying…' : 'Retry'}</button>}</section>}
          {page === 'Overview' && <><div className="welcome-row dashboard-banner"><div><p className="eyebrow"><CalendarDays size={12} aria-hidden="true" />{new Date().toLocaleDateString('en-PH', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' }).toUpperCase()}</p><h1>{greeting(profile.full_name)}</h1><p className="muted">{isAdmin ? 'Payment activity across JPCS events.' : 'Your events and payment activity at a glance.'}</p></div><div className="dashboard-banner-actions">{isAdmin ? <button type="button" className="outline-btn dashboard-passes-btn" onClick={() => setModal({ type: 'event' })}><Plus size={16} /><span>Create event</span></button> : <button type="button" className="outline-btn dashboard-passes-btn" onClick={() => navigate('My passes')}><ShieldCheck size={16} /><span>View my passes</span></button>}</div></div>
          <section className={`stats-grid ${isAdmin ? 'admin-dashboard-stats' : 'member-dashboard-stats'}`}>{isAdmin ? <><Stat icon={<Wallet />} category="COLLECTED" label="Total collected" value={money(collected)} color="navy" /><Stat icon={<Clock3 />} category="REVIEW" label="Pending approval" value={pendingList.length} color="amber" /><Stat icon={<Ticket />} category="EVENTS" label="Fully paid events" value={adminFullyPaid} color="green" /><Stat icon={<Users />} category="MEMBERS" label="Registered members" value={members.length} color="navy" /><Stat icon={<CreditCard />} category="BALANCE" label="Partially paid" value={adminPartially} color="amber" /></> : <><Stat icon={<Wallet />} category="PAID" label="Total paid" value={money(memberPaid)} color="navy" /><Stat icon={<Clock3 />} category="STATUS" label="Pending approval" value={memberPending} color="amber" /><Stat icon={<Ticket />} category="EVENTS" label="Fully paid events" value={memberFullyPaid} color="green" /><Stat icon={<ShieldCheck />} category="ACCESS" label="Entrance passes" value={memberPasses} color="navy" /></>}</section>
          <section className="middle-grid"><div className="panel events-panel"><PanelTitle eyebrow="AVAILABLE TO YOU" title="Upcoming events" action={isAdmin ? null : <button type="button" className="text-button" onClick={() => navigate('Events')}>All events <ArrowRight size={15} /></button>} /><div className="event-grid">{filteredEvents.filter(e => e.active || isAdmin).slice(0, 2).map(e => <EventCard key={e.id} event={e} registration={registrations.find(r => r.event_id === e.id && r.member_id === userId)} onPay={() => openPayment(e)} isAdmin={isAdmin} onEdit={() => setModal({ type: 'event', event: e })} />)}</div>{!filteredEvents.filter(e => e.active || isAdmin).length && <Empty text={dataLoading ? 'Loading events…' : 'No active events found.'} />}</div><div className="panel progress-panel"><PanelTitle eyebrow={isAdmin ? 'REVIEW QUEUE' : 'YOUR ACTIVITY'} title={isAdmin ? 'Needs review' : 'Payment overview'} />{isAdmin ? <><div className="admin-review-count">{pendingList.length}<span>payments waiting for review</span></div><button type="button" className="view-payments" onClick={() => navigate('Payments')}>Open verification queue <ArrowRight size={15} /></button></> : <><div className="progress-summary"><div className="progress-ring" style={{ '--paid': `${paidPercent(memberRegs, events.filter(e => e.active))}%` }}><div><b>{paidPercent(memberRegs, events.filter(e => e.active))}%</b><span>PAID</span></div></div><div><p className="muted">Across active events</p><h3>{money(memberPaid)}</h3></div></div><button type="button" className="view-payments" onClick={() => navigate('My payments')}>View payment history <ArrowRight size={15} /></button></>}</div></section>
          <section className="panel history-panel live-table"><PanelTitle eyebrow={isAdmin ? 'LATEST SUBMISSIONS' : 'YOUR RECENT ACTIVITY'} title={isAdmin ? 'Recent payment submissions' : 'Payment history'} action={<button type="button" className="text-button" onClick={() => navigate(isAdmin ? 'Payments' : 'My payments')}>View all <ArrowRight size={15} /></button>} /><PaymentTable items={(isAdmin ? payments : myPayments).slice(0, 3)} admin={isAdmin} onOpen={openDetail} showPagination={false} /></section>
        </>}
        {page === 'Events' && <section className="panel live-panel"><PanelTitle eyebrow="JPCS ACTIVITIES" title="Events" action={isAdmin && <button type="button" className="primary small-primary" onClick={() => setModal({ type: 'event' })}><Plus size={15} /> Add event</button>} /><div className="event-grid expanded">{filteredEvents.filter(e => e.active || isAdmin).map(e => <EventCard key={e.id} event={e} registration={registrations.find(r => r.event_id === e.id && r.member_id === userId)} onPay={() => openPayment(e)} isAdmin={isAdmin} onEdit={() => setModal({ type: 'event', event: e })} />)}</div>{!filteredEvents.filter(e => e.active || isAdmin).length && <Empty text="No events found." />}</section>}
        {page === 'Check-in' && hasAdminRole && <section className="panel live-panel"><PanelTitle eyebrow="LIVE ENTRY DESK" title="Check-in scanner" /><Suspense fallback={<div className="inline-loading">Loading scanner…</div>}><CheckInScanner events={events} passes={passes} api={api} onCheckedIn={applyCheckin} /></Suspense></section>}
         {(page === 'My payments' || page === 'Payments') && <section className="panel live-panel"><PanelTitle eyebrow={isAdmin ? 'MANUAL VERIFICATION' : 'PAYMENT RECORDS'} title={isAdmin ? 'Payment submissions' : 'My payments'} /><div className="report-filters payment-filters">{isAdmin && <label className="payment-filter-field" htmlFor="payment-method-filter"><span>Payment method</span><select id="payment-method-filter" value={paymentMethodFilter} onChange={e => setPaymentMethodFilter(e.target.value)}><option value="all">All methods</option><option value="cash">Cash</option><option value="gcash">GCash</option><option value="maribank">MariBank</option></select></label>}<label className="payment-filter-field" htmlFor="payment-status-filter"><span>Status</span><select id="payment-status-filter" value={paymentStatusFilter} onChange={e => setPaymentStatusFilter(e.target.value)}><option value="all">All statuses</option><option value="pending">Pending</option><option value="approved">Approved</option><option value="rejected">Rejected</option></select></label></div>{isAdmin ? <PayLaterTable registrations={registrations.filter(reg => !query || `${reg.events?.name || ''} ${reg.profiles?.full_name || ''} ${reg.profiles?.email || ''}`.toLowerCase().includes(query.toLowerCase()))} onDelete={handleDeletePayLater} canDelete={profile.role === 'admin'} /> : <MyPayLaterTable registrations={memberRegs} />}<PaymentTable items={visiblePayments} admin={isAdmin} onOpen={openDetail} showCount={isAdmin && page === 'Payments'} /></section>}
        {page === 'My passes' && <section className="panel live-panel"><PanelTitle eyebrow="FULLY PAID EVENTS" title="My entrance passes" /><div className="pass-grid">{passes.filter(p => p.registration?.member_id === userId && !p.pay_later).map(p => <PassCard key={p.id} pass={p} />)}{passes.filter(p => p.registration?.member_id === userId && !p.pay_later).length === 0 && <Empty text="Entrance passes appear after all payments for an event are approved." />}</div></section>}
        {page === 'Members' && isAdmin && <section className="panel live-panel"><PanelTitle eyebrow="MEMBER DIRECTORY" title={<span className="members-title">Members <span className="member-count-badge" aria-label={`${filteredMembers.length} members`}>{filteredMembers.length.toLocaleString()}</span></span>} action={<div className="member-action-buttons">{profile.role === 'admin' && <button type="button" className="outline-btn small-primary" onClick={() => setModal({ type: 'memberImport' })}><Upload size={15} /> Import Members</button>}<button type="button" className="primary small-primary" onClick={() => setModal({ type: 'addMember' })}><Plus size={15} /> Add member</button></div>} /><div className="report-filters member-filters"><select value={filterYear} onChange={e => setFilterYear(e.target.value)}><option value="all">All year levels</option><option value="1">1st Year</option><option value="2">2nd Year</option><option value="3">3rd Year</option><option value="4">4th Year</option></select><span className="muted">Search by name, email, or student number.</span></div><div className="table-wrap"><table><thead><tr><th>Member</th><th>Year level</th><th>Role</th><th>Email</th><th>Action</th></tr></thead><tbody>{pagedMembers.map(m => <tr key={m.id}><td data-label="Member"><b>{m.full_name}</b><small className="method">{m.email}</small></td><td data-label="Year level">{m.year_level ? `${m.year_level}${m.year_level === 1 ? 'st' : m.year_level === 2 ? 'nd' : m.year_level === 3 ? 'rd' : 'th'} Year` : yearLabel(m.year_level)}</td><td data-label="Role">{m.role === 'admin' ? 'Member/Admin' : 'Member'}</td><td data-label="Email">{m.email}</td><td data-label="Action"><div className="member-row-actions"><button type="button" className="outline-btn small" onClick={() => setModal({ type: 'memberEdit', member: m })}>Edit</button>{profile.role === 'admin' && <button type="button" className="outline-btn small" onClick={() => requestConfirm({ title: 'Reset this member’s password?', message: `${m.full_name} will be signed in with the default password JPCS2026 and must choose a new password at next sign-in.`, confirmText: 'Reset password', onConfirm: async () => { await api('/api/members/reset-password', { method: 'POST', body: JSON.stringify({ userId: m.id }) }, 'request'); notify(`Password reset for ${m.full_name}.`) } })}>Reset password</button>}<button type="button" className="outline-btn small member-delete-btn" disabled={m.role === 'admin' || m.id === userId} title={m.role === 'admin' || m.id === userId ? 'Administrators and your own account cannot be deleted here.' : 'Delete member'} onClick={() => handleDeleteMember(m)}>Delete</button></div></td></tr>)}</tbody></table>{!filteredMembers.length && <Empty text="No member profiles found." />}<PaginationControls total={filteredMembers.length} page={currentMembersPage} onPageChange={setMembersPage} /></div></section>}
        {page === 'Reports' && isAdmin && <div className="report-page-content"><PanelTitle eyebrow="ORGANIZATION FINANCES" title="Payment report" action={<div className="report-export-actions"><button type="button" className="outline-btn" onClick={() => downloadReport(reportItems)}><Download size={15} /> Export CSV</button><button type="button" className="outline-btn" onClick={async () => { try { const blob = await downloadPaymentReportPdf(reportItems, { collected: reportCollected, pending: reportPending, rejected: reportRejected, approved: reportApproved }); setModal({ type: 'reportPdf', blob }) } catch { notify('Could not generate the PDF report. Please try again.') } }}><FileText size={15} /> Export PDF</button></div>} /><div className="stats-grid report-stats"><Stat icon={<Wallet />} category="COLLECTED" label="Collected" value={money(reportCollected)} color="navy" /><Stat icon={<Clock3 />} category="PENDING" label="Pending" value={reportPending} color="amber" /><Stat icon={<AlertTriangle />} category="REJECTED" label="Rejected" value={reportRejected} color="amber" /><Stat icon={<CheckCircle2 />} category="APPROVED" label="Approved" value={reportApproved} color="green" /></div><div className="report-filters report-page-filters" role="group" aria-label="Payment report filters">
          <label><span>Event</span><select value={filterEvent} onChange={e => setFilterEvent(e.target.value)}><option value="all">All events</option>{events.map(e => <option key={e.id} value={e.id}>{e.name}</option>)}</select></label>
          <label><span>Year level</span><select value={filterYear} onChange={e => setFilterYear(e.target.value)}><option value="all">All year levels</option><option value="1">First Year</option><option value="2">Second Year</option><option value="3">Third Year</option><option value="4">Fourth Year</option></select></label>
          <label><span>Payment method</span><select value={filterMethod} onChange={e => setFilterMethod(e.target.value)}><option value="all">All methods</option><option value="cash">Cash</option><option value="gcash">GCash</option><option value="maribank">MariBank</option></select></label>
          <label><span>Payment status</span><select value={filterState} onChange={e => setFilterState(e.target.value)}><option value="all">All statuses</option><option value="pending">Pending</option><option value="approved">Approved</option><option value="rejected">Rejected</option></select></label>
          <label><span>From date</span><input type="date" value={dateFrom} onChange={e => setDateFrom(e.target.value)} /></label>
          <label><span>To date</span><input type="date" value={dateTo} onChange={e => setDateTo(e.target.value)} /></label>
          <button type="button" className="text-button report-clear-filters" onClick={() => { setFilterState('all'); setFilterMethod('all'); setFilterEvent('all'); setFilterYear('all'); setDateFrom(''); setDateTo('') }}>Clear filters</button>
         </div><PaymentTable items={reportItems} admin={isAdmin} onOpen={openDetail} className="report-table-container" /></div>}
        {page === 'Settings' && <section className="panel live-panel"><PanelTitle eyebrow="ACCOUNT PREFERENCES" title="Settings" /><div className="settings-card"><div><b>Account</b><span>{profile.full_name} · {profile.email}</span></div><ShieldCheck size={22} /></div><div className="settings-card"><div><b>Profile</b><span>Edit your display name, student number, or year level.</span></div><button type="button" className="outline-btn" onClick={() => setModal({ type: 'profileEdit' })}>Edit profile</button></div><div className="settings-card"><div><b>Password</b><span>Update your password using your current password.</span></div><div className="settings-actions"><button type="button" className="outline-btn" onClick={() => setModal({ type: 'passwordChange' })}><KeyRound size={15} />Change password</button></div></div>{hasAdminRole && <div className="settings-card workspace-card"><div><b>Workspace</b><span>Switch between admin and member preview for this account.</span></div><button type="button" className="outline-btn" onClick={() => { const next = isAdmin ? 'member' : 'admin'; setViewMode(next); safeSet('jpcs-workspace', next); setPage('Overview'); notify(isAdmin ? 'Member workspace preview opened.' : 'Admin workspace opened.') }}>{isAdmin ? 'Switch to member view' : 'Switch to admin view'}</button></div>}<button type="button" className="logout-link settings-logout" onClick={signOut}>Sign out</button></section>}
        {page === 'Verify pass' && <section className="panel live-panel checkin-panel"><PanelTitle eyebrow="JPCS EVENT CHECK-IN" title="Entrance pass verification" />{!hasAdminRole ? <ErrorBox text="Only authorized event officers can validate entrance passes." /> : <><p className="muted">Pass token: <b>{location.pathname.split('/').pop()}</b></p><button type="button" className="primary" disabled={busy || checkin?.valid || checkin?.payLater} onClick={checkPass}>{busy ? 'Checking…' : 'Verify and check in'}</button>{checkin && <div className={`checkin-result ${checkin.valid ? 'valid' : 'invalid'}`}>{checkin.valid ? `Valid pass · ${checkin.member} · ${checkin.event}` : checkin.payLater ? `Pay Later · ${checkin.member} · ${checkin.event} · Not paid yet; due ${dateTime(checkin.dueAt)}. This is not an entrance pass yet.` : checkin.checkedIn ? `Already checked in at ${dateTime(checkin.checkedInAt)}` : checkin.error || 'Pass is invalid.'}</div>}</>}</section>}
        {error && <ErrorBox text={error} onClose={() => setError('')} />}
      </div>
    </main>
    <nav className={`bottom-nav ${isAdmin ? 'admin-bottom-nav' : 'member-bottom-nav'}`}>{mobileNav.map(([name, Icon]) => <button key={name} type="button" className={`bottom-nav-btn ${page === name ? 'active' : ''}`} onClick={() => { if (name === 'More') { setMoreOpen(o => !o); return } navigate(name); setMoreOpen(false) }}><Icon size={20} /><span>{name === 'Overview' ? 'Dashboard' : name === 'My payments' ? 'My Payments' : name === 'My passes' ? 'My Passes' : name === 'Payments' ? 'Payments' : name}</span>{name === 'Payments' && pendingBadge > 0 && <i className="bottom-badge">{pendingBadge}</i>}</button>)}{moreOpen && isAdmin && <div className="more-menu"><button type="button" onClick={() => { navigate('Members'); setMoreOpen(false) }}><Users size={16} /> Members</button><button type="button" onClick={() => { navigate('Reports'); setMoreOpen(false) }}><Activity size={16} /> Reports</button><button type="button" onClick={() => { navigate('Settings'); setMoreOpen(false) }}><Settings size={16} /> Settings</button></div>}</nav>
    {modal?.type === 'payment' && <PaymentModal event={modal.event} registration={registrations.find(r => r.event_id === modal.event.id && r.member_id === userId)} onClose={() => setModal(null)} onSubmitted={onPaymentSubmitted} setError={setError} />}
    {modal?.type === 'reportPdf' && <PaymentReportPdfPreview blob={modal.blob} onClose={() => setModal(null)} />}
        {modal?.type === 'paymentSubmitted' && <PaymentSuccessModal amount={modal.amount} eventName={modal.eventName} payLater={modal.payLater} dueAt={modal.dueAt} emailDelivery={modal.emailDelivery} onClose={() => setModal(null)} />}
    {modal?.type === 'paymentDetail' && <PaymentDetailModal payment={modal.payment} admin={isAdmin} profile={profile} onClose={() => setModal(null)} onReview={handleReview} onDelete={handleDeletePayment} requestConfirm={requestConfirm} />}
    {modal?.type === 'event' && <EventModal event={modal.event} onClose={() => setModal(null)} onSaved={() => setRefresh(v => v + 1)} notify={notify} setError={setError} requestConfirm={requestConfirm} />}
    {modal?.type === 'profileEdit' && <ProfileModal profile={profile} onClose={() => setModal(null)} onSaved={setProfile} notify={notify} setError={setError} />}
    {modal?.type === 'passwordChange' && <PasswordModal onClose={() => setModal(null)} onChanged={() => { setProfile(current => ({ ...current, must_change_password: false })); notify('Password updated successfully.') }} />}
    {modal?.type === 'addMember' && <AddMemberModal onClose={() => setModal(null)} onCreated={() => setRefresh(v => v + 1)} notify={notify} />}
    {modal?.type === 'memberEdit' && <MemberEditModal member={modal.member} onClose={() => setModal(null)} onSaved={() => setRefresh(v => v + 1)} />}
    {modal?.type === 'memberImport' && profile.role === 'admin' && <MemberImportModal onClose={() => setModal(null)} onImported={() => setRefresh(v => v + 1)} members={members} />}
    {confirmDialog && <ConfirmModal {...confirmDialog} onClose={() => setConfirmDialog(null)} />}
    {toast && <div className="toast"><Check size={17} />{toast}</div>}
  </div>
}
