import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { supabase } from './lib/supabase'
import { Activity, AlertTriangle, ArrowRight, Banknote, CalendarDays, Check, CheckCircle2, ChevronRight, CircleHelp, Clock3, CreditCard, Download, ExternalLink, FileImage, Home, Landmark, LogOut, Menu, Moon, Pencil, Plus, QrCode, RefreshCw, ScanLine, Search, Settings, ShieldCheck, Sun, Ticket, Users, Wallet, X } from 'lucide-react'

const CheckInScanner = lazy(() => import('./components/CheckInScanner'))

const money = n => {
  const v = Number(n || 0)
  return `₱${v.toLocaleString('en-PH', { minimumFractionDigits: Number.isInteger(v) ? 0 : 2, maximumFractionDigits: 2 })}`
}
const date = v => (v ? new Date(v).toLocaleDateString('en-PH', { year: 'numeric', month: 'short', day: 'numeric' }) : 'Date to be announced')
const dateTime = v => (v ? new Date(v).toLocaleString('en-PH', { year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '—')
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
  if (offline || /failed to fetch|networkerror|network.*error|load failed|fetch failed|err_name_not_resolved|timeout/i.test(message)) {
    return 'Unable to connect right now. Please check your internet connection and try again.'
  }
  if (/invalid login credentials|invalid_grant|email not confirmed|invalid email or password/i.test(message)) {
    return "We couldn't sign you in. Check your email and password and try again."
  }
  if (/jwt|token has expired|refresh token|invalid session|session.*expired|not authenticated|auth session missing/i.test(message)) {
    return 'Your session has expired. Please sign in again.'
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
  if (/password.*12|at least 12|jpcs2026/i.test(message)) {
    return 'Choose a password with at least 12 characters.'
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
  if (import.meta.env.DEV) console.error('[JPCS]', context, message)
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
  else if (path === '/api/members/create') action = 'members.create'
  else if (path === '/api/payments') action = 'payments.submit'
  else if (/^\/api\/payments\/[^/]+\/review$/.test(path)) { action = 'payments.review'; params.paymentId = segments.at(-2) }
  else if (path.startsWith('/api/passes/') && path.endsWith('/check-in')) { action = 'passes.checkin'; params.token = decodeURIComponent(segments.at(-2)) }
  else if (path.startsWith('/api/receipts/')) { action = 'receipts.url'; params.paymentId = segments.at(-1) }
  else if (path.startsWith('/api/passes/') && path.endsWith('/qr')) { action = 'passes.qr'; params.passId = segments.at(-2) }
  else throw new Error('Something went wrong. Please try again later.')

  const { data: { session }, error: sessionError } = await supabase.auth.getSession()
  if (sessionError || !session?.access_token) throw new Error(friendlyError(sessionError || new Error('session missing'), 'auth'))
  const { data, error } = await supabase.functions.invoke('jpcs-api', { body: { action, params, input: requestBody, sessionAccessToken: session.access_token }, headers: { Authorization: `Bearer ${session.access_token}` } })
  if (error) {
    let message = error.message
    try { const detail = await error.context?.json(); message = detail?.error || message } catch {}
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

function AuthFrame({ dark, children }) {
  return <main className={`login-screen ${dark ? 'dark' : ''}`}><div className="login-card">{children}</div></main>
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
function Stat({ icon, label, value, color }) {
  return <div className="stat-card"><div className="stat-top"><div className={`stat-icon ${color}`}>{icon}</div></div><span className="stat-label">{label}</span><strong>{value}</strong></div>
}
function Modal({ children, onClose, className = '', labelledBy }) {
  useEffect(() => {
    const onKey = e => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', onKey)
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => { document.removeEventListener('keydown', onKey); document.body.style.overflow = prev }
  }, [onClose])
  return <div className="modal-backdrop" onMouseDown={e => { if (e.target === e.currentTarget) onClose() }}><div className={`modal ${className}`} role="dialog" aria-modal="true" aria-labelledby={labelledBy}>{children}</div></div>
}
function ModalClose({ onClick }) {
  return <button type="button" className="icon-button" onClick={onClick} aria-label="Close"><X size={18} /></button>
}

function EventCard({ event, registration, onPay, isAdmin, onEdit }) {
  const status = statusOf(registration, event.price)
  const paid = (registration?.payments || []).filter(p => p.state === 'approved').reduce((s, p) => s + Number(p.amount || 0), 0)
  const price = Number(registration?.price ?? event.price ?? 0)
  const pendingAmt = (registration?.payments || []).filter(p => p.state === 'pending').reduce((s, p) => s + Number(p.amount || 0), 0)
  const used = paid + pendingAmt
  const remaining = Math.max(0, price - used)
  const fullyPaid = status === 'Fully paid' || remaining <= 0
  const statusText = status === 'Fully paid' ? 'Fully paid' : status === 'Partially paid' ? `Partially paid · ${money(paid)} paid` : status === 'Pending verification' ? 'Pending verification' : status === 'Rejected' ? 'Rejected' : 'Unpaid'
  return <article className="event-card">
    <div className="event-art"><CalendarDays size={30} /><small>{event.venue || 'JPCS event'}</small></div>
    <div className="event-detail">
      <div className="event-date"><Clock3 size={14} />{date(event.event_date)}</div>
      <h3>{event.name}</h3>
      <p className="muted event-description">{event.description || 'Join us at this JPCS event.'}</p>
      <div className="event-bottom">
        <div className="event-price-box"><b>{money(price)}</b><small className="method">{statusText}</small></div>
        {isAdmin ? <button type="button" className="pay-button secondary" onClick={onEdit}><Pencil size={14} /> Edit</button> : <button type="button" className="pay-button" disabled={fullyPaid || status === 'Pending verification'} onClick={onPay}>{fullyPaid ? 'Paid' : status === 'Pending verification' ? 'Pending' : 'Pay'} <ArrowRight size={13} /></button>}
      </div>
    </div>
  </article>
}

function PaymentTable({ items, admin, onOpen }) {
  return <div className="table-wrap"><table><thead><tr><th>Event / Member</th><th>Date · Method</th><th>Amount</th><th>Status</th><th>Details</th></tr></thead><tbody>
    {items.map(p => {
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
  </tbody></table>{!items.length && <Empty text="No payment submissions yet." />}</div>
}

function PassCard({ pass }) {
  const [qr, setQr] = useState('')
  const [err, setErr] = useState('')
  useEffect(() => {
    let alive = true
    api(`/api/passes/${pass.id}/qr`, {}, 'receipt').then(d => { if (alive) setQr(d.dataUrl) }).catch(e => { if (alive) setErr(e.message) })
    return () => { alive = false }
  }, [pass.id])
  return <div className="pass-card"><div className="pass-top"><div className="pass-symbol"><Ticket size={19} /></div><span className="pass-label">VERIFIED PASS</span></div><div className="pass-event"><div><b>{pass.event?.name}</b><span>{date(pass.event?.event_date)}</span></div></div>{qr ? <img className="actual-qr" src={qr} alt="Event entrance QR code" /> : <span className="small-muted">{err || 'Loading secure pass…'}</span>}<small className="pass-token">Pass ID {(pass.token || '').slice(0, 8)}••••</small><p className="pass-hint">{pass.checked_in_at ? 'Checked in' : 'Present this QR code at the event entrance.'}</p></div>
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
      await api('/api/members/create', { method: 'POST', body: JSON.stringify({ fullName: fullName.trim(), email: email.trim(), password, yearLevel: Number(yearLevel) }) }, 'request')
      notify('Member account created.')
      onCreated()
      onClose()
    } catch (ex) { console.error('Add member failed:', ex); setErr(ex?.message || ex?.error || (typeof ex === 'string' ? ex : 'Something went wrong. Please try again later.')) } finally { setBusy(false) }
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
      <div className="modal-actions"><button type="button" className="outline-btn" onClick={onClose} disabled={busy}>Cancel</button><button type="submit" className="primary" disabled={busy}>{busy ? 'Creating…' : 'Create member'}</button></div>
    </form>
  </Modal>
}

function PaymentModal({ event, registration, onClose, onSubmitted, setError }) {
  const [method, setMethod] = useState('')
  const [amount, setAmount] = useState('')
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
  useEffect(() => { if (!amount && remaining > 0) setAmount(String(remaining)) }, [remaining, amount])
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
      if (!methods.length) throw new Error('No payment methods are configured for this event.')
      const value = Number(amount)
      if (!Number.isFinite(value) || value <= 0) throw new Error('Enter a valid amount.')
      if (value > remaining + 0.000001) throw new Error('That amount is more than the remaining balance for this event.')
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
    <div className="amount-due"><div><span>Price · {date(event.event_date)}</span>{event.venue && <span className="venue">Venue: {event.venue}</span>}</div><b>{money(price)}</b></div>
    <div className="due-row"><span>Amount due</span><b>{money(remaining)}</b></div>
    {event.description && <p className="muted">{event.description}</p>}
    {event.payment_instructions && <p className="muted">{event.payment_instructions}</p>}
    {remaining <= 0 && <ErrorBox text="This event is fully paid or already has a pending submission covering the balance." />}
    {(err || fileError) && <ErrorBox text={err || fileError} onClose={() => { setErr(''); setFileError('') }} />}
    <form onSubmit={submit} className="modal-form">
      <label className="form-label">Payment method</label>
      <div className="method-cards" role="radiogroup" aria-label="Payment method">
        {methods.map(m => {
          const mm = METHOD_META[m]
          const MIcon = mm.icon
          const selected = method === m
          return <button type="button" key={m} role="radio" aria-checked={selected} className={`method-card ${selected ? 'selected' : ''}`} onClick={() => setMethod(m)}>
            <div className="method-card-top"><MIcon size={18} /><span>{mm.label}</span>{selected && <CheckCircle2 size={16} className="check" />}</div>
            <p className="muted">{mm.description}</p>
          </button>
        })}
      </div>
      {methods.length === 0 && <ErrorBox text="No payment methods are configured for this event." />}
      {meta.qr && <div className="qr-payment"><div className="qr-frame"><img src={meta.qr} alt={`${meta.label} QR code`} /></div><p className="muted">Scan the QR code with your e-wallet, then upload a clear screenshot or photo of your receipt.</p></div>}
      {method === 'cash' && <div className="cash-note"><Banknote size={18} /><p>Pay in person to a JPCS officer. No receipt upload is needed.</p></div>}
      <div className="form-row">
        <div className="form-field"><label className="form-label" htmlFor="pay-amount">Amount to submit</label><input id="pay-amount" className="modal-input" name="amount" type="number" min="0.01" step="0.01" max={remaining} value={amount} onChange={e => setAmount(e.target.value)} required /></div>
      </div>
      {method !== 'cash' && <><label className="form-label" htmlFor="pay-ref">Transaction reference</label><input id="pay-ref" className="modal-input" name="reference" maxLength={120} value={reference} onChange={e => setReference(e.target.value)} placeholder="Enter your GCash/MariBank reference number" required /></>}
      {method !== 'cash' && <><label className="form-label">Receipt image (required)</label><input className="file-input" name="receipt" type="file" accept="image/jpeg,image/png,image/webp" onChange={handleFile} required /><small className="muted">JPG, PNG, or WebP · up to 5 MB</small></>}
      <div className="modal-actions"><button type="button" className="outline-btn" onClick={onClose} disabled={busy}>Cancel</button><button type="submit" className="primary" disabled={busy || remaining <= 0 || methods.length === 0}>{busy ? 'Submitting…' : 'Submit for verification'}</button></div>
    </form>
  </Modal>
}

function PaymentSuccessModal({ amount, eventName, onClose }) {
  return <Modal onClose={onClose}>
    <div className="success-state"><CheckCircle2 size={48} /><h2>Submitted for verification</h2><p>Your {money(amount)} payment for <b>{eventName}</b> is pending officer review. You'll see it in My payments.</p><button type="button" className="primary" onClick={onClose}>Done</button></div>
  </Modal>
}

function PaymentDetailModal({ payment, admin, profile, onClose, onReview }) {
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
  useEffect(() => {
    let alive = true
    if (!payment.receipt_path) { setReceipt({ loading: false, url: '', error: '' }); return }
    setImageFailed(false)
    api(`/api/receipts/${payment.id}`, {}, 'receipt').then(d => { if (alive) setReceipt({ loading: false, url: d.url, error: '' }) }).catch(ex => { if (alive) setReceipt({ loading: false, url: '', error: ex.message }) })
    return () => { alive = false }
  }, [payment.id, payment.receipt_path])
  const retry = () => { setReceipt({ loading: true, url: '', error: '' }); setImageFailed(false); api(`/api/receipts/${payment.id}`, {}, 'receipt').then(d => setReceipt({ loading: false, url: d.url, error: '' })).catch(ex => setReceipt({ loading: false, url: '', error: ex.message })) }
  const submit = async () => {
    if (decision === 'rejected' && remarks.trim().length < 3) { setErr('Add a short reason (at least 3 characters).'); return }
    setBusy(true); setErr('')
    try { await onReview(payment, decision, remarks.trim()); onClose() } catch (ex) { setErr(ex.message) } finally { setBusy(false) }
  }
  const pending = payment.state === 'pending'
  return <Modal onClose={onClose} className="review-modal">
    <div className="modal-heading"><div><p className="eyebrow">PAYMENT DETAILS</p><h2>{ev.name || 'Event'}</h2></div><ModalClose onClick={onClose} /></div>
    <div className="review-status-row"><span className={`status ${payment.state === 'approved' ? 'paid' : payment.state === 'rejected' ? 'rejected' : 'pending'}`}><i />{payment.state === 'approved' ? 'Approved' : payment.state === 'rejected' ? 'Rejected' : 'Pending verification'}</span></div>
    <div className="review-grid">
      <section className="review-card"><h3>Member</h3><div className="review-lines"><div><span>Name</span><b>{memberName}</b></div><div><span>Email</span><b>{memberEmail || '—'}</b></div>{member.student_number && <div><span>Student number</span><b>{member.student_number}</b></div>}{member.year_level && <div><span>Year level</span><b>{yearLabel(member.year_level)}</b></div>}</div></section>
      <section className="review-card"><h3>Payment</h3><div className="review-lines"><div><span>Amount</span><b>{money(payment.amount)}</b></div><div><span>Method</span><b>{payment.method}</b></div><div><span>Reference</span><b>{payment.transaction_reference || 'Not provided'}</b></div><div><span>Submitted</span><b>{dateTime(payment.submitted_at)}</b></div></div></section>
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
  </Modal>
}

function EventModal({ event, onClose, onSaved, notify, setError }) {
  const [name, setName] = useState(event?.name || '')
  const [description, setDescription] = useState(event?.description || '')
  const [price, setPrice] = useState(event?.price ?? '')
  const [eventDate, setEventDate] = useState(localDate(event?.event_date))
  const [venue, setVenue] = useState(event?.venue || '')
  const [deadline, setDeadline] = useState(localDate(event?.payment_deadline))
  const [instructions, setInstructions] = useState(event?.payment_instructions || '')
  const [active, setActive] = useState(event?.active ?? true)
  const [methods, setMethods] = useState(event?.methods || ['cash', 'gcash', 'maribank'])
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const toggle = m => { setMethods(prev => prev.includes(m) ? prev.filter(x => x !== m) : [...prev, m]) }
  const save = async e => {
    e.preventDefault()
    if (methods.length === 0) { setErr('Select at least one payment method.'); return }
    setBusy(true); setErr(''); setError('')
    try {
      const payload = { name, description, price: Number(price), event_date: eventDate || null, venue, payment_deadline: deadline || null, payment_instructions: instructions, active, methods }
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
      <label className="checkbox"><input type="checkbox" checked={active} onChange={e => setActive(e.target.checked)} />Event active</label>
      <div className="modal-actions"><button type="button" className="outline-btn" onClick={onClose} disabled={busy}>Cancel</button><button type="submit" className="primary" disabled={busy}>{busy ? 'Saving…' : 'Save event'}</button></div>
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
  const [passes, setPasses] = useState([])
  const [query, setQuery] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [toast, setToast] = useState('')
  const [modal, setModal] = useState(null)
  const [mobile, setMobile] = useState(false)
  const [refresh, setRefresh] = useState(0)
  const [checkin, setCheckin] = useState(null)
  const [filterState, setFilterState] = useState('all')
  const [filterMethod, setFilterMethod] = useState('all')
  const [filterEvent, setFilterEvent] = useState('all')
  const [dateFrom, setDateFrom] = useState('')
  const [dateTo, setDateTo] = useState('')
  const [filterYear, setFilterYear] = useState('all')
  const [viewMode, setViewMode] = useState(() => safeGet('jpcs-workspace') || 'admin')
  const [profileMenu, setProfileMenu] = useState(false)
  const [dataLoading, setDataLoading] = useState(false)
  const menuRef = useRef(null)
  const toastTimer = useRef(null)
  const notify = useCallback(msg => { setToast(msg); clearTimeout(toastTimer.current); toastTimer.current = setTimeout(() => setToast(''), 4000) }, [])
  useEffect(() => () => clearTimeout(toastTimer.current), [])
  const hasAdminRole = profile?.role && profile.role !== 'member'
  const isAdmin = hasAdminRole && viewMode === 'admin'
  const userId = session?.user?.id

  useEffect(() => {
    if (!supabase) { setAuthReady(true); return }
    supabase.auth.getSession().then(({ data, error }) => { if (error) setError(friendlyError(error, 'auth')); setSession(data.session ?? null); setAuthReady(true) })
    const { data: { subscription } } = supabase.auth.onAuthStateChange((event, next) => {
      if (event === 'SIGNED_OUT') { setSession(null); setProfile(null); setProfileState('idle'); setPage('Overview'); setModal(null) }
      else if (event === 'SIGNED_IN' || event === 'TOKEN_REFRESHED' || event === 'USER_UPDATED' || event === 'INITIAL_SESSION') setSession(next ?? null)
    })
    return () => subscription.unsubscribe()
  }, [])

  useEffect(() => {
    if (!authReady) return
    if (!userId) { setProfile(null); setProfileState('idle'); setProfileError(''); return }
    let alive = true
    setProfileState('loading'); setProfileError('')
    supabase.from('profiles').select('*').eq('id', userId).maybeSingle().then(({ data, error }) => {
      if (!alive) return
      if (error) { setProfileState('error'); setProfileError(friendlyError(error, 'profile')); return }
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
      const e = await supabase.from('events').select('*').order('event_date', { ascending: true, nullsFirst: false })
      if (e.error) throw e.error; setEvents(e.data || [])
      const r = await supabase.from('registrations').select('id,member_id,event_id,price,created_at,events(*),payments(*),passes(*)').order('created_at', { ascending: false })
      if (r.error) throw r.error; setRegistrations(r.data || [])
      if (profile.role !== 'member') {
        const [p, m] = await Promise.all([supabase.from('payments').select('*,registrations(id,member_id,event_id,profiles(full_name,email,student_number,year_level),events(name,price,event_date))').order('submitted_at', { ascending: false }), supabase.from('profiles').select('*').order('full_name')])
        if (p.error) throw p.error; if (m.error) throw m.error; setPayments(p.data || []); setMembers(m.data || [])
      } else {
        setPayments((r.data || []).flatMap(x => (x.payments || []).map(p => ({ ...p, registration: x, event: x.events }))))
        setMembers([])
      }
      setPasses((r.data || []).flatMap(x => asArray(x.passes).map(p => ({ ...p, registration: x, event: x.events }))))
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
  const signOut = async () => { setProfileMenu(false); setMobile(false); try { await supabase?.auth.signOut() } catch {} setSession(null); setProfile(null); setProfileState('idle'); setPage('Overview'); setModal(null); setError(''); setToast(''); sessionRemove('jpcs-page') }
  const changePassword = async e => {
    e.preventDefault(); const d = new FormData(e.currentTarget); const password = d.get('password')
    if (password !== d.get('confirm')) { setError('Passwords do not match.'); return }
    try { setBusy(true); await api('/api/profile/password', { method: 'POST', body: JSON.stringify({ password }) }, 'auth'); setProfile(p => ({ ...p, must_change_password: false })); setError(''); notify('Password updated successfully.') } catch (ex) { setError(ex.message) } finally { setBusy(false) }
  }
  const retryProfile = () => { setError(''); setProfileError(''); setProfileRetry(v => v + 1) }
  const openPayment = event => { setError(''); navigate('Events'); setModal({ type: 'payment', event }) }
  const onPaymentSubmitted = info => { setModal({ type: 'paymentSubmitted', ...info }); setRefresh(v => v + 1) }
  const handleReview = async (payment, decision, remarks) => { await api(`/api/payments/${payment.id}/review`, { method: 'POST', body: JSON.stringify({ decision, remarks }) }, 'review'); setRefresh(v => v + 1); const sent = decision === 'approved'; if (decision === 'approved') notify('Payment approved. Confirmation email status is noted in your workspace.'); else notify('Payment rejected. The member can see the reason provided.') }
  const openDetail = p => setModal({ type: 'paymentDetail', payment: p })
  const checkPass = async () => { try { setBusy(true); const token = location.pathname.split('/').pop(); const result = await api(`/api/passes/${encodeURIComponent(token)}/check-in`, { method: 'POST', body: JSON.stringify({}) }, 'checkin'); setCheckin(result) } catch (e) { setCheckin({ valid: false, error: e.message }) } finally { setBusy(false) } }
  const applyCheckin = data => { if (!data?.passId && !data?.token) return; setPasses(prev => prev.map(p => { const match = (data.passId && p.id === data.passId) || (data.token && p.token === data.token); return match ? { ...p, checked_in_at: data.checkedInAt || p.checked_in_at || new Date().toISOString() } : p })) }

  const memberRegs = useMemo(() => registrations.filter(r => r.member_id === userId), [registrations, userId])
  const myPayments = useMemo(() => hasAdminRole && viewMode === 'member' ? memberRegs.flatMap(r => (r.payments || []).map(p => ({ ...p, registration: r, event: r.events }))) : (isAdmin ? payments : memberRegs.flatMap(r => (r.payments || []).map(p => ({ ...p, registration: r, event: r.events })))), [hasAdminRole, viewMode, memberRegs, isAdmin, payments])
  const filteredEvents = useMemo(() => events.filter(e => e.name.toLowerCase().includes(query.toLowerCase()) || (e.venue || '').toLowerCase().includes(query.toLowerCase())), [events, query])
  const filteredPayments = useMemo(() => payments.filter(p => `${p.registrations?.events?.name || p.event?.name || ''} ${p.registrations?.profiles?.full_name || ''} ${p.registrations?.profiles?.email || ''} ${p.transaction_reference || ''}`.toLowerCase().includes(query.toLowerCase())), [payments, query])
  const reportItems = useMemo(() => payments.filter(p => (filterState === 'all' || p.state === filterState) && (filterMethod === 'all' || p.method === filterMethod) && (filterEvent === 'all' || p.registrations?.event_id === filterEvent) && (filterYear === 'all' || String(p.registrations?.profiles?.year_level) === filterYear) && (!query || `${p.registrations?.profiles?.full_name || ''} ${p.registrations?.profiles?.email || ''}`.toLowerCase().includes(query.toLowerCase())) && (!dateFrom || p.submitted_at >= dateFrom) && (!dateTo || p.submitted_at.slice(0, 10) <= dateTo)), [payments, filterState, filterMethod, filterEvent, filterYear, query, dateFrom, dateTo])
  const collected = payments.filter(p => p.state === 'approved').reduce((s, p) => s + Number(p.amount || 0), 0)
  const pendingList = payments.filter(p => p.state === 'pending')
  const memberPaid = memberRegs.flatMap(r => r.payments || []).filter(p => p.state === 'approved').reduce((s, p) => s + Number(p.amount || 0), 0)
  const memberPending = memberRegs.flatMap(r => r.payments || []).filter(p => p.state === 'pending').length
  const memberFullyPaid = memberRegs.filter(r => statusOf(r, r.events?.price) === 'Fully paid').length
  const memberPasses = passes.filter(p => p.registration?.member_id === userId).length
  const adminFullyPaid = registrations.filter(r => statusOf(r, r.events?.price) === 'Fully paid').length
  const adminPartially = registrations.filter(r => statusOf(r, r.events?.price) === 'Partially paid').length
  const nav = isAdmin ? [['Overview', Home], ['Check-in', ScanLine], ['Members', Users], ['Payments', CreditCard], ['Events', Ticket], ['Reports', Activity]] : [['Overview', Home], ['My payments', Wallet], ['Events', Ticket], ['My passes', ShieldCheck]]
  const mobileNav = isAdmin ? [['Overview', Home], ['Payments', CreditCard], ['Check-in', ScanLine], ['Members', Users], ['Events', Ticket]] : [['Overview', Home], ['My payments', Wallet], ['Events', Ticket], ['My passes', ShieldCheck]]
  const pendingBadge = isAdmin ? pendingList.length : memberPending

  if (!supabase) return <AuthFrame dark={dark}><img className="login-logo" src="/images/jpcs-logo.png" alt="JPCS logo" /><p className="eyebrow">CONFIGURATION NEEDED</p><h1>Connect Supabase</h1><p className="muted">Set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY, then restart the app.</p></AuthFrame>
  if (!authReady) return <div className={`loading-screen ${dark ? 'dark' : ''}`}><img src="/images/jpcs-logo.png" alt="JPCS" /><p>Preparing your workspace…</p></div>
  if (!session) {
    return <AuthFrame dark={dark}><img className="login-logo" src="/images/jpcs-logo.png" alt="JPCS logo" /><p className="eyebrow">JPCS · PAYMENT PORTAL</p><h1>Welcome back.</h1><p className="muted">Sign in with your pre-created member or officer account.</p>{error && <ErrorBox text={error} onClose={() => setError('')} />}<form onSubmit={async e => { e.preventDefault(); setBusy(true); setError(''); const d = new FormData(e.currentTarget); const { error: err } = await supabase.auth.signInWithPassword({ email: d.get('email'), password: d.get('password') }); if (err) setError(friendlyError(err, 'auth')); setBusy(false) }}><label htmlFor="si-email">Email address</label><input id="si-email" name="email" type="email" autoComplete="username" required /><label htmlFor="si-pass">Password</label><input id="si-pass" name="password" type="password" autoComplete="current-password" required /><button disabled={busy} className="primary full">{busy ? 'Signing in…' : 'Sign in'} <ArrowRight size={17} /></button></form></AuthFrame>
  }
  if (profileState === 'loading' || profileState === 'idle') return <div className={`loading-screen ${dark ? 'dark' : ''}`}><img src="/images/jpcs-logo.png" alt="JPCS" /><p>Loading your JPCS profile…</p></div>
  if (profileState === 'error' || profileState === 'missing') {
    return <AuthFrame dark={dark}><img className="login-logo" src="/images/jpcs-logo.png" alt="JPCS logo" /><p className="eyebrow">ACCOUNT STATUS</p><h1>Account unavailable</h1>{profileError && <ErrorBox text={profileError} />}<p className="muted">You can retry without signing out. If the issue persists, contact a JPCS officer to provision your account.</p><button className="primary full" onClick={retryProfile}>Retry</button><button className="logout-link" onClick={signOut}>Sign out</button></AuthFrame>
  }
  if (profile.must_change_password) {
    return <AuthFrame dark={dark}><img className="login-logo" src="/images/jpcs-logo.png" alt="JPCS logo" /><p className="eyebrow">FIRST SIGN-IN</p><h1>Set a new password</h1><p className="muted">Choose a secure password with at least 12 characters.</p>{error && <ErrorBox text={error} onClose={() => setError('')} />}<form onSubmit={changePassword}><label htmlFor="np-pass">New password</label><input id="np-pass" name="password" type="password" minLength="12" autoComplete="new-password" required /><label htmlFor="np-conf">Confirm password</label><input id="np-conf" name="confirm" type="password" minLength="12" autoComplete="new-password" required /><button className="primary full" disabled={busy}>{busy ? 'Updating…' : 'Change password'}</button></form><button className="logout-link" onClick={signOut}>Sign out</button></AuthFrame>
  }

  return <div className={`app-shell ${dark ? 'dark' : ''}`}><a className="skip-link" href="#main-content">Skip to main content</a>
    <aside className="sidebar"><div className="brand"><img src="/images/jpcs-logo.png" alt="JPCS logo" /><div><b>JPCS Pay</b><small>{isAdmin ? 'ADMIN WORKSPACE' : 'MEMBER WORKSPACE'}</small></div></div><div className="nav-caption">WORKSPACE</div><nav>{nav.map(([name, Icon]) => <button key={name} type="button" className={`nav-link ${page === name ? 'selected' : ''}`} onClick={() => navigate(name)}><Icon size={18} /><span>{name}</span>{name === 'Payments' && pendingBadge > 0 && <i className="nav-badge">{pendingBadge}</i>}</button>)}</nav><div className="sidebar-bottom"><button type="button" className="nav-link" onClick={() => navigate('Settings')}><Settings size={18} /> Settings</button><div className="profile"><div className="avatar">{initials(profile.full_name)}</div><div className="profile-info"><b>{profile.full_name}</b><span>{roleLabel(profile)}</span></div><button type="button" className="icon-button" onClick={signOut} title="Log out" aria-label="Log out"><LogOut size={16} /></button></div></div></aside>
    <main id="main-content" className="main-area"><header className="topbar"><div className="topbar-left"><div className="crumb"><b>{page}</b></div></div><div className="top-actions"><label className="search-box"><Search size={16} /><input placeholder="Search events, members, or payments" value={query} onChange={e => setQuery(e.target.value)} /></label><button type="button" className="icon-button" onClick={() => setDark(d => !d)} aria-label="Toggle theme">{dark ? <Sun /> : <Moon />}</button><button type="button" className="icon-button" onClick={() => setRefresh(v => v + 1)} title="Refresh" aria-label="Refresh"><RefreshCw size={16} className={dataLoading ? 'spin' : ''} /></button><span className="top-divider" /><div className="profile-menu-wrap" ref={menuRef}><button type="button" className="avatar small-avatar avatar-btn" onClick={() => setProfileMenu(s => !s)} aria-haspopup="menu" aria-expanded={profileMenu}>{initials(profile.full_name)}</button>{profileMenu && <div className="profile-menu" role="menu"><button type="button" role="menuitem" onClick={() => { setModal({ type: 'profileEdit' }); setProfileMenu(false) }}><Pencil size={16} /> Edit profile</button><button type="button" role="menuitem" onClick={() => navigate('Settings')}><Settings size={16} /> Settings</button><button type="button" role="menuitem" className="danger" onClick={signOut}><LogOut size={16} /> Log out</button></div>}</div></div></header>
      <div className="content">
        {page === 'Overview' && <><div className="welcome-row"><div><p className="eyebrow">{new Date().toLocaleDateString('en-PH', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' }).toUpperCase()}</p><h1>{greeting(profile.full_name)} <span>✦</span></h1><p className="muted">{isAdmin ? 'Payment activity across JPCS events.' : 'Your events and payment activity at a glance.'}</p></div>{isAdmin && <button type="button" className="outline-btn" onClick={() => setModal({ type: 'event' })}><Plus size={16} /> Create event</button>}</div>
          <section className="stats-grid">{isAdmin ? <><Stat icon={<Wallet />} label="Total collected" value={money(collected)} color="navy" /><Stat icon={<Clock3 />} label="Pending approval" value={pendingList.length} color="amber" /><Stat icon={<Ticket />} label="Fully paid events" value={adminFullyPaid} color="green" /><Stat icon={<Users />} label="Registered members" value={members.length} color="navy" /><Stat icon={<CreditCard />} label="Partially paid" value={adminPartially} color="amber" /></> : <><Stat icon={<Wallet />} label="Total paid" value={money(memberPaid)} color="navy" /><Stat icon={<Clock3 />} label="Pending approval" value={memberPending} color="amber" /><Stat icon={<Ticket />} label="Fully paid events" value={memberFullyPaid} color="green" /><Stat icon={<ShieldCheck />} label="Entrance passes" value={memberPasses} color="navy" /></>}</section>
          <section className="middle-grid"><div className="panel events-panel"><PanelTitle eyebrow="AVAILABLE TO YOU" title="Upcoming events" action={isAdmin ? null : <button type="button" className="text-button" onClick={() => navigate('Events')}>All events <ArrowRight size={15} /></button>} /><div className="event-grid">{filteredEvents.filter(e => e.active || isAdmin).slice(0, isAdmin ? 6 : 4).map(e => <EventCard key={e.id} event={e} registration={registrations.find(r => r.event_id === e.id && r.member_id === userId)} onPay={() => openPayment(e)} isAdmin={isAdmin} onEdit={() => setModal({ type: 'event', event: e })} />)}</div>{!filteredEvents.filter(e => e.active || isAdmin).length && <Empty text={dataLoading ? 'Loading events…' : 'No active events found.'} />}</div><div className="panel progress-panel"><PanelTitle eyebrow={isAdmin ? 'REVIEW QUEUE' : 'YOUR ACTIVITY'} title={isAdmin ? 'Needs review' : 'Payment overview'} />{isAdmin ? <><div className="admin-review-count">{pendingList.length}<span>payments waiting for review</span></div><button type="button" className="view-payments" onClick={() => navigate('Payments')}>Open verification queue <ArrowRight size={15} /></button></> : <><div className="progress-summary"><div className="progress-ring" style={{ '--paid': `${paidPercent(memberRegs, events.filter(e => e.active))}%` }}><div><b>{paidPercent(memberRegs, events.filter(e => e.active))}%</b><span>PAID</span></div></div><div><p className="muted">Across active events</p><h3>{money(memberPaid)}</h3></div></div><button type="button" className="view-payments" onClick={() => navigate('My payments')}>View payment history <ArrowRight size={15} /></button></>}</div></section>
          <section className="panel history-panel live-table"><PanelTitle eyebrow={isAdmin ? 'LATEST SUBMISSIONS' : 'YOUR RECENT ACTIVITY'} title={isAdmin ? 'Recent payment submissions' : 'Payment history'} action={<button type="button" className="text-button" onClick={() => navigate(isAdmin ? 'Payments' : 'My payments')}>View all <ArrowRight size={15} /></button>} /><PaymentTable items={(isAdmin ? payments : myPayments).slice(0, 6)} admin={isAdmin} onOpen={openDetail} /></section>
        </>}
        {page === 'Events' && <section className="panel live-panel"><PanelTitle eyebrow="JPCS ACTIVITIES" title="Events" action={isAdmin && <button type="button" className="primary small-primary" onClick={() => setModal({ type: 'event' })}><Plus size={15} /> Add event</button>} /><div className="event-grid expanded">{filteredEvents.filter(e => e.active || isAdmin).map(e => <EventCard key={e.id} event={e} registration={registrations.find(r => r.event_id === e.id && r.member_id === userId)} onPay={() => openPayment(e)} isAdmin={isAdmin} onEdit={() => setModal({ type: 'event', event: e })} />)}</div>{!filteredEvents.filter(e => e.active || isAdmin).length && <Empty text="No events found." />}</section>}
        {page === 'Check-in' && hasAdminRole && <section className="panel live-panel"><PanelTitle eyebrow="LIVE ENTRY DESK" title="Check-in scanner" /><Suspense fallback={<div className="inline-loading">Loading scanner…</div>}><CheckInScanner events={events} passes={passes} api={api} onCheckedIn={applyCheckin} /></Suspense></section>}
        {(page === 'My payments' || page === 'Payments') && <section className="panel live-panel"><PanelTitle eyebrow={isAdmin ? 'MANUAL VERIFICATION' : 'PAYMENT RECORDS'} title={isAdmin ? 'Payment submissions' : 'My payments'} /><PaymentTable items={isAdmin ? filteredPayments : myPayments} admin={isAdmin} onOpen={openDetail} /></section>}
        {page === 'My passes' && <section className="panel live-panel"><PanelTitle eyebrow="FULLY PAID EVENTS" title="My entrance passes" /><div className="pass-grid">{passes.filter(p => p.registration?.member_id === userId).map(p => <PassCard key={p.id} pass={p} />)}{passes.filter(p => p.registration?.member_id === userId).length === 0 && <Empty text="Entrance passes appear after all payments for an event are approved." />}</div></section>}
        {page === 'Members' && isAdmin && <section className="panel live-panel"><PanelTitle eyebrow="MEMBER DIRECTORY" title="Members" action={<button type="button" className="primary small-primary" onClick={() => setModal({ type: 'addMember' })}><Plus size={15} /> Add member</button>} /><div className="report-filters member-filters"><select value={filterYear} onChange={e => setFilterYear(e.target.value)}><option value="all">All year levels</option><option value="1">1st Year</option><option value="2">2nd Year</option><option value="3">3rd Year</option><option value="4">4th Year</option></select><span className="muted">Search by name, email, or student number.</span></div><div className="table-wrap"><table><thead><tr><th>Member</th><th>Student no.</th><th>Year level</th><th>Role</th><th>Email</th></tr></thead><tbody>{members.filter(m => `${m.full_name} ${m.email} ${m.student_number || ''}`.toLowerCase().includes(query.toLowerCase()) && (filterYear === 'all' || String(m.year_level) === filterYear)).map(m => <tr key={m.id}><td data-label="Member"><b>{m.full_name}</b><small className="method">{m.email}</small></td><td data-label="Student no.">{m.student_number || '—'}</td><td data-label="Year level">{m.year_level ? `${m.year_level}${m.year_level === 1 ? 'st' : m.year_level === 2 ? 'nd' : m.year_level === 3 ? 'rd' : 'th'} Year` : yearLabel(m.year_level)}</td><td data-label="Role">{roleLabel(m)}</td><td data-label="Email">{m.email}</td></tr>)}</tbody></table>{members.length === 0 && <Empty text="No member profiles found." />}</div></section>}
        {page === 'Reports' && isAdmin && <section className="panel live-panel"><PanelTitle eyebrow="ORGANIZATION FINANCES" title="Payment report" action={<button type="button" className="outline-btn" onClick={() => downloadReport(reportItems)}><Download size={15} /> Export CSV</button>} /><div className="stats-grid report-stats"><Stat icon={<Wallet />} label="Collected" value={money(collected)} color="navy" /><Stat icon={<Clock3 />} label="Pending" value={pendingList.length} color="amber" /><Stat icon={<Users />} label="Members" value={members.length} color="green" /></div><div className="report-filters"><select value={filterEvent} onChange={e => setFilterEvent(e.target.value)}><option value="all">All events</option>{events.map(e => <option key={e.id} value={e.id}>{e.name}</option>)}</select><select value={filterYear} onChange={e => setFilterYear(e.target.value)}><option value="all">All year levels</option><option value="1">First Year</option><option value="2">Second Year</option><option value="3">Third Year</option><option value="4">Fourth Year</option></select><select value={filterMethod} onChange={e => setFilterMethod(e.target.value)}><option value="all">All methods</option><option value="cash">Cash</option><option value="gcash">GCash</option><option value="maribank">MariBank</option></select><select value={filterState} onChange={e => setFilterState(e.target.value)}><option value="all">All statuses</option><option value="pending">Pending</option><option value="approved">Approved</option><option value="rejected">Rejected</option></select><label>From <input type="date" value={dateFrom} onChange={e => setDateFrom(e.target.value)} /></label><label>To <input type="date" value={dateTo} onChange={e => setDateTo(e.target.value)} /></label><button type="button" className="text-button" onClick={() => { setFilterState('all'); setFilterMethod('all'); setFilterEvent('all'); setFilterYear('all'); setDateFrom(''); setDateTo('') }}>Clear filters</button></div><PaymentTable items={reportItems} admin={isAdmin} onOpen={openDetail} /></section>}
        {page === 'Settings' && <section className="panel live-panel"><PanelTitle eyebrow="ACCOUNT PREFERENCES" title="Settings" /><div className="settings-card"><div><b>Account</b><span>{profile.full_name} · {profile.email}</span><small>Assigned role: {roleLabel(profile)}</small></div><ShieldCheck size={22} /></div><div className="settings-card"><div><b>Profile</b><span>Edit your display name, student number, or year level.</span></div><button type="button" className="outline-btn" onClick={() => setModal({ type: 'profileEdit' })}>Edit profile</button></div>{hasAdminRole && <div className="settings-card workspace-card"><div><b>Workspace</b><span>Switch between admin and member preview for this account.</span></div><button type="button" className="outline-btn" onClick={() => { const next = isAdmin ? 'member' : 'admin'; setViewMode(next); safeSet('jpcs-workspace', next); setPage('Overview'); notify(isAdmin ? 'Member workspace preview opened.' : 'Admin workspace opened.') }}>{isAdmin ? 'Switch to member view' : 'Switch to admin view'}</button></div>}<button type="button" className="logout-link settings-logout" onClick={signOut}>Sign out</button></section>}
        {page === 'Verify pass' && <section className="panel live-panel checkin-panel"><PanelTitle eyebrow="JPCS EVENT CHECK-IN" title="Entrance pass verification" />{!hasAdminRole ? <ErrorBox text="Only authorized event officers can validate entrance passes." /> : <><p className="muted">Pass token: <b>{location.pathname.split('/').pop()}</b></p><button type="button" className="primary" disabled={busy || checkin?.valid} onClick={checkPass}>{busy ? 'Checking…' : 'Verify and check in'}</button>{checkin && <div className={`checkin-result ${checkin.valid ? 'valid' : 'invalid'}`}>{checkin.valid ? `Valid pass · ${checkin.member} · ${checkin.event}` : checkin.checkedIn ? `Already checked in at ${dateTime(checkin.checkedInAt)}` : checkin.error || 'Pass is invalid.'}</div>}</>}</section>}
        {error && <ErrorBox text={error} onClose={() => setError('')} />}
        <footer><span>© {new Date().getFullYear()} JPCS · Payment Portal</span><span>Payments are manually verified by JPCS officers.</span></footer>
      </div>
    </main>
    <nav className="bottom-nav">{mobileNav.map(([name, Icon]) => <button key={name} type="button" className={`bottom-nav-btn ${page === name ? 'active' : ''}`} onClick={() => navigate(name)}><Icon size={20} /><span>{name === 'My payments' ? 'My Payments' : name === 'My passes' ? 'My Passes' : name === 'Payments' ? 'Payments' : name}</span>{name === 'Payments' && pendingBadge > 0 && <i className="bottom-badge">{pendingBadge}</i>}</button>)}</nav>
    {modal?.type === 'payment' && <PaymentModal event={modal.event} registration={registrations.find(r => r.event_id === modal.event.id && r.member_id === userId)} onClose={() => setModal(null)} onSubmitted={onPaymentSubmitted} setError={setError} />}
    {modal?.type === 'paymentSubmitted' && <PaymentSuccessModal amount={modal.amount} eventName={modal.eventName} onClose={() => setModal(null)} />}
    {modal?.type === 'paymentDetail' && <PaymentDetailModal payment={modal.payment} admin={isAdmin} profile={profile} onClose={() => setModal(null)} onReview={handleReview} />}
    {modal?.type === 'event' && <EventModal event={modal.event} onClose={() => setModal(null)} onSaved={() => setRefresh(v => v + 1)} notify={notify} setError={setError} />}
    {modal?.type === 'profileEdit' && <ProfileModal profile={profile} onClose={() => setModal(null)} onSaved={setProfile} notify={notify} setError={setError} />}
    {modal?.type === 'addMember' && <AddMemberModal onClose={() => setModal(null)} onCreated={() => setRefresh(v => v + 1)} notify={notify} />}
    {toast && <div className="toast"><Check size={17} />{toast}</div>}
  </div>
}
