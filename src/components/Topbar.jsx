import React from 'react'
import { Bell, Menu, Moon, Search, Sun } from 'lucide-react'
import { initials, roleLabel } from '../lib/utils'

export default function Topbar({
  page,
  setMobile,
  query,
  setQuery,
  dark,
  toggleDark,
  onRefresh,
  profile,
}) {
  return (
    <header className="topbar">
      <div className="topbar-left">
        <button
          className="icon-button hamburger"
          onClick={() => setMobile(true)}
          aria-label="Open navigation menu"
        >
          <Menu />
        </button>
        <div className="crumb">
          <b>{page}</b>
        </div>
      </div>
      <div className="top-actions">
        <label className="search-box">
          <Search size={16} />
          <input
            placeholder="Search events or members…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </label>
        <button
          className="icon-button"
          onClick={toggleDark}
          aria-label="Toggle dark mode"
        >
          {dark ? <Sun /> : <Moon />}
        </button>
        <button
          className="icon-button"
          onClick={onRefresh}
          title="Refresh data"
          aria-label="Refresh data"
        >
          <Bell />
        </button>
        <span className="top-divider" />
        <span className="role-switch">{roleLabel(profile)}</span>
        <div className="avatar small-avatar">{initials(profile.full_name)}</div>
      </div>
    </header>
  )
}
