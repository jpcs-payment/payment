export const pageToPath = (page) => {
  switch (page) {
    case 'Overview':
      return '/'
    case 'Check-in':
      return '/check-in'
    case 'Members':
      return '/members'
    case 'Payments':
      return '/payments'
    case 'Events':
      return '/events'
    case 'Reports':
      return '/reports'
    case 'Settings':
      return '/settings'
    case 'My payments':
      return '/my-payments'
    case 'My passes':
      return '/my-passes'
    default:
      if (page.startsWith('Verify pass')) {
        return window.location.pathname
      }
      return '/'
  }
}

export const pathToPage = (pathname, isAdmin) => {
  const clean = pathname.replace(/\/+$/, '') || '/'
  if (clean.startsWith('/verify/')) return 'Verify pass'
  if (clean === '/check-in') return isAdmin ? 'Check-in' : 'Overview'
  if (clean === '/members') return isAdmin ? 'Members' : 'Overview'
  if (clean === '/payments') return isAdmin ? 'Payments' : 'Overview'
  if (clean === '/events') return 'Events'
  if (clean === '/reports') return isAdmin ? 'Reports' : 'Overview'
  if (clean === '/settings') return 'Settings'
  if (clean === '/my-payments') return 'My payments'
  if (clean === '/my-passes') return 'My passes'
  return 'Overview'
}

export const navigateTo = (page, setPage) => {
  setPage(page)
  const path = pageToPath(page)
  if (window.location.pathname !== path) {
    window.history.pushState({ page }, '', path)
  }
}
