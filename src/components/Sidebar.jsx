import React from 'react'
import {
  Activity,
  CreditCard,
  Edit3,
  Home,
  LogOut,
  ScanLine,
  Settings,
  ShieldCheck,
  Ticket,
  Users,
  Wallet,
  X,
} from 'lucide-react'
import { initials, roleLabel } from '../lib/utils'

export default function Sidebar({
  isAdmin,
  mobile,
  setMobile,
  page,
  onNavigate,
  pendingCount,
  profile,
  onEditProfile,
  signOut,
}) {
  const nav = isAdmin
    ? [
        ['Overview', Home],
        ['Check-in', ScanLine],
        ['Members', Users],
        ['Payments', CreditCard],
        ['Events', Ticket],
        ['Reports', Activity],
        ['Settings', Settings],
      ]
    : [
        ['Overview', Home],
        ['My payments', Wallet],
        ['Events', Ticket],
        ['My passes', ShieldCheck],
        ['Settings', Settings],
      ]

  return (
    <>
      <aside className={`sidebar ${mobile ? 'open' : ''}`}>
        <div className="brand">
          <img src="/images/jpcs-logo.png" alt="JPCS" />
          <div>
            <b>JPCS Pay</b>
            <small>{isAdmin ? 'ADMIN WORKSPACE' : 'MEMBER WORKSPACE'}</small>
          </div>
          <button
            className="close-menu icon-button"
            onClick={() => setMobile(false)}
            aria-label="Close menu"
          >
            <X />
          </button>
        </div>

        <div className="nav-caption">WORKSPACE</div>
        <nav>
          {nav.map(([name, Icon]) => (
            <button
              key={name}
              className={`nav-link ${page === name ? 'selected' : ''}`}
              onClick={() => {
                onNavigate(name)
                setMobile(false)
              }}
            >
              <Icon size={18} />
              <span>{name}</span>
              {name === 'Payments' && pendingCount > 0 && (
                <i className="nav-badge">{pendingCount}</i>
              )}
            </button>
          ))}
        </nav>

        <div className="sidebar-bottom">
          <div className="profile">
            <div
              className="avatar"
              style={{ cursor: 'pointer' }}
              onClick={onEditProfile}
              title="Click to edit profile"
            >
              {initials(profile.full_name)}
            </div>
            <div
              className="profile-info"
              style={{ cursor: 'pointer' }}
              onClick={onEditProfile}
              title="Click to edit profile"
            >
              <b>{profile.full_name}</b>
              <span>{roleLabel(profile)}</span>
            </div>
            <button
              className="icon-button"
              onClick={onEditProfile}
              title="Edit Profile"
              aria-label="Edit Profile"
            >
              <Edit3 size={15} />
            </button>
            <button
              className="icon-button"
              onClick={signOut}
              title="Sign out"
              aria-label="Sign out"
            >
              <LogOut size={16} />
            </button>
          </div>
        </div>
      </aside>
      {mobile && (
        <button
          className="mobile-scrim"
          onClick={() => setMobile(false)}
          aria-label="Close backdrop"
        />
      )}
    </>
  )
}
