// Post-sign-in welcome animation flag (see components/WelcomeSplash.jsx).
// Tiny on purpose: Login and Layout import this; the splash itself is lazy.
export const WELCOME_FLAG = 'bb_welcome'

export function armWelcomeSplash() {
  try { sessionStorage.setItem(WELCOME_FLAG, '1') } catch { /* storage unavailable */ }
}

// ?welcome=1 on any app URL replays it (handy for showing it off without
// signing out and back in).
export function welcomePending() {
  try {
    if (new URLSearchParams(window.location.search).get('welcome') === '1') armWelcomeSplash()
    return sessionStorage.getItem(WELCOME_FLAG) === '1'
  } catch { return false }
}
