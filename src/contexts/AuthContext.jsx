import React, { createContext, useContext, useEffect, useState, useCallback, useRef } from 'react'
import { supabase } from '../lib/supabase'
import { ADMIN_EMAILS, setGlobalBetaEnabled } from '../lib/tiers'
import { isNativeApp, API_ORIGIN } from '../lib/native'
import { cacheClearAll } from '../lib/offlineCache'

const AuthContext = createContext({})

export const useAuth = () => useContext(AuthContext)

export const AuthProvider = ({ children }) => {
  const [user, setUser]       = useState(null)
  const [loading, setLoading] = useState(true)
  const [session, setSession] = useState(null)
  // Track the highest expires_at we've ever committed so onAuthStateChange
  // can't overwrite a fresh session with a stale cached one.
  const latestExpiresAt = useRef(0)

  useEffect(() => {
    // getSession() is the single authoritative source for the initial loading gate.
    // onAuthStateChange can fire INITIAL_SESSION with a transient null before the real
    // session is confirmed (e.g. during token refresh), which would briefly set
    // user=null while loading=false and trigger ProtectedRoute redirect loops.
    // By only calling setLoading(false) inside getSession we guarantee the spinner
    // stays up until we have a definitive session state.
    //
    // After establishing the session we immediately force a token refresh so that
    // any server-side metadata changes (plan, bracket, payment_status) made by an
    // admin are reflected in the user's JWT without requiring a logout/login cycle.
    //
    // getSession() can also never settle at all — a wedged storage adapter, a
    // captive-portal network, or a hung refresh leaves the promise pending and
    // the app stuck on the full-screen spinner with no way out. Race it against
    // a 10s timeout and fall through to signed-out, which at least renders the
    // login screen.
    //
    // The race is over the LOADING GATE ONLY. It used to be over the session as
    // well (`if (settled) return` at the top of every arm), so a getSession()
    // that took 10.1s had its perfectly good session thrown away: the user sat
    // there looking signed out, with a valid token in storage, until they
    // reloaded the page. `settled` now guards nothing but setLoading(false) —
    // whenever the real session lands, early or late, it is applied.
    //
    // App.jsx's PUBLIC_PATHS behaviour is untouched by this: the gate still
    // opens at 10s no matter what, so public routes keep rendering without
    // waiting on auth.
    let settled  = false   // loading gate resolved (by either arm)
    let disposed = false   // effect cleaned up — stop touching React state

    // Single writer for session state during init. Honours the same
    // expires_at watermark onAuthStateChange uses, so a late arm can never
    // install an OLDER session over a newer one that landed in the meantime.
    const applySession = (incoming) => {
      if (disposed) return
      const exp = incoming?.expires_at ?? 0
      if (incoming && exp < latestExpiresAt.current) return  // stale — discard
      latestExpiresAt.current = incoming ? Math.max(latestExpiresAt.current, exp) : 0
      setSession(incoming ?? null)
      setUser(incoming?.user ?? null)
    }

    const initTimer = setTimeout(() => {
      if (settled) return
      settled = true
      console.warn('[Auth] getSession() did not settle within 10s — opening the loading gate as signed out (a late session will still be applied)')
      // Only assert "signed out" if nothing has committed a session yet.
      // onAuthStateChange can deliver a real SIGNED_IN inside the 10s window,
      // and blanking it here would sign a live user out of their own tab.
      if (latestExpiresAt.current === 0) applySession(null)
      setLoading(false)
    }, 10000)

    supabase.auth.getSession().then(async ({ data: { session } }) => {
      if (disposed) return
      applySession(session)

      if (session) {
        // Skip auto-refresh when the user landed via a password-recovery link.
        // The recovery session token is one-time-use; calling refreshSession()
        // here would consume it before ResetPassword.jsx can call updateUser().
        const isRecoveryLanding = window.location.hash.includes('type=recovery')
          || window.location.hash.includes('access_token')

        if (!isRecoveryLanding) {
          // refreshSession() hits Supabase's /token endpoint and returns a new JWT
          // that includes the latest user_metadata from the server.  This is a silent
          // background call — if it fails we still have the cached session as fallback.
          try {
            const { data: refreshed } = await supabase.auth.refreshSession()
            if (refreshed?.session) applySession(refreshed.session)
          } catch {
            // silently ignore — cached session is still valid for auth purposes
          }
        }
      }

    }).catch((err) => {
      // Network/storage failure during auth init — treat as signed-out rather than
      // hanging on the loading spinner forever. Same rule as the timeout arm:
      // only assert signed-out when no session has been committed by anyone.
      console.error('[Auth] getSession failed during init:', err)
      if (latestExpiresAt.current === 0) applySession(null)
    }).finally(() => {
      clearTimeout(initTimer)
      if (disposed) return  // unmounted mid-flight
      if (settled) return   // the 10s arm already opened the gate
      settled = true
      setLoading(false)
    })

    const { data: { subscription } } = supabase.auth.onAuthStateChange((event, incomingSession) => {
      // Guard against stale-session overwrites: if we already have a session whose token
      // is newer than the incoming event's token (e.g. a cached SIGNED_IN firing after an
      // explicit refreshSession() call), discard the incoming event to avoid reverting
      // the user back to stale metadata.
      const incomingExp = incomingSession?.expires_at ?? 0
      if (incomingSession && incomingExp < latestExpiresAt.current) return  // stale — discard
      // On sign-out, reset the watermark so the next sign-in isn't blocked
      latestExpiresAt.current = incomingSession ? Math.max(latestExpiresAt.current, incomingExp) : 0
      setSession(incomingSession ?? null)
      setUser(incomingSession?.user ?? null)
      // Do NOT call setLoading(false) here — getSession() controls the loading gate.
      // PASSWORD_RECOVERY event fires when user arrives via reset-email link;
      // ResetPassword.jsx handles the UI — nothing extra needed here.
    })

    return () => {
      disposed = true
      clearTimeout(initTimer)
      subscription.unsubscribe()
    }
  }, [])

  // ── Global beta switch (v1.18) ─────────────────────────────────────────────
  // Fetch app_settings.beta_mode_enabled once per session and push it into the
  // tiers resolver. While ON, users with app_metadata.beta_mode get full access;
  // flipping it OFF drops every beta user straight back to trial/paid/Scout.
  // Fail CLOSED: an unreadable app_settings row (RLS change, dropped table,
  // network blip) used to resolve to `true`, which silently handed every
  // beta-flagged account the top plan on every feature gate. A switch we cannot
  // read is treated as OFF; a missing row still means ON, because that is the
  // documented "migration not yet run" state and the query succeeds with data
  // === null.
  // v1.36.1: retry before failing closed. A single transient read failure
  // (network blip, cold Supabase connection) used to instantly drop every
  // beta-flagged account to Scout — which made Prospecting AND Recruit flip
  // to an upgrade wall simultaneously. Three attempts with backoff means only
  // a *persistently* unreadable switch downgrades anyone; the security posture
  // (fail closed, never fail open) is unchanged.
  const [globalBetaEnabled, setGlobalBetaState] = useState(true)
  useEffect(() => {
    if (!user) return
    let cancelled = false
    const RETRY_DELAYS = [2000, 5000]   // attempt 1 immediate, then 2s, then 5s

    const readSwitch = async () => {
      for (let attempt = 0; ; attempt++) {
        const { data, error } = await supabase
          .from('app_settings')
          .select('value')
          .eq('key', 'beta_mode_enabled')
          .maybeSingle()
        if (cancelled) return
        if (!error) {
          // Missing row (data === null) still means ON — documented
          // "migration not yet run" state.
          const enabled = data?.value !== 'off'
          setGlobalBetaEnabled(enabled)   // tiers.js module-level flag (drives resolver)
          setGlobalBetaState(enabled)     // context state (drives admin UI)
          return
        }
        if (attempt >= RETRY_DELAYS.length) {
          console.warn('[Auth] beta switch unreadable after retries — defaulting beta OFF:', error.message)
          setGlobalBetaEnabled(false)
          setGlobalBetaState(false)
          return
        }
        console.warn(`[Auth] beta switch read failed (attempt ${attempt + 1}) — retrying:`, error.message)
        await new Promise(r => setTimeout(r, RETRY_DELAYS[attempt]))
        if (cancelled) return
      }
    }
    readSwitch()
    return () => { cancelled = true }
  }, [user])

  // Force-refresh the session to pick up metadata changes (plan, bracket, payment_status, etc.)
  // Can be awaited by callers that want to know if the refresh succeeded.
  const refreshSession = useCallback(async () => {
    try {
      const { data, error } = await supabase.auth.refreshSession()
      if (!error && data?.session) {
        const exp = data.session.expires_at ?? 0
        latestExpiresAt.current = Math.max(latestExpiresAt.current, exp)
        setSession(data.session)
        setUser(data.session.user)
        return { success: true, user: data.session.user }
      }
      return { success: false, error }
    } catch (err) {
      return { success: false, error: err }
    }
  }, [])

  // Poll for payment status resolution every 5 min while locked
  useEffect(() => {
    const isLocked = user && !ADMIN_EMAILS.includes(user.email?.toLowerCase())
      && user.app_metadata?.payment_status === 'past_due'

    if (!isLocked) return
    const id = setInterval(refreshSession, 5 * 60 * 1000)
    return () => clearInterval(id)
  }, [user, refreshSession])

  const isAdmin = Boolean(user && ADMIN_EMAILS.includes(user.email?.toLowerCase()))

  const isPaymentLocked = Boolean(
    user &&
    !ADMIN_EMAILS.includes(user.email?.toLowerCase()) &&
    user.app_metadata?.payment_status === 'past_due'
  )

  // Downgrade lock: subscription was cancelled/expired (not a payment failure).
  // Set when customer.subscription.deleted fires in the webhook.
  // Cleared when the user re-subscribes (checkout.session.completed).
  const isDowngradeLocked = Boolean(
    user &&
    !ADMIN_EMAILS.includes(user.email?.toLowerCase()) &&
    user.app_metadata?.payment_status === 'inactive' &&
    user.app_metadata?.downgraded_at
  )

  // Timestamp (ms) of when the subscription was cancelled — used for deletion countdown
  const downgradedAt = isDowngradeLocked ? Number(user.app_metadata.downgraded_at) : null

  const signIn = async (email, password) => {
    const { data, error } = await supabase.auth.signInWithPassword({ email, password })
    return { data, error }
  }

  const signUp = async (email, password, profileData = {}) => {
    // Without emailRedirectTo, Supabase sends the confirmation link to the
    // project's Site URL — which is not necessarily this deploy (preview builds
    // land on production) and, inside the native shell, would be an origin no
    // mail client can open. Same rule as resetPassword above.
    const origin = isNativeApp ? API_ORIGIN : window.location.origin
    const { data, error } = await supabase.auth.signUp({
      email,
      password,
      options: {
        emailRedirectTo: `${origin}/login`,
        data: {
          first_name:   profileData.first_name   || '',
          last_name:    profileData.last_name    || '',
          display_name: profileData.display_name || '',
          business:     profileData.business     || '',
          phone:        profileData.phone        || '',
          position:     profileData.position     || '',
        },
      },
    })
    return { data, error }
  }

  const signOut = async () => {
    // v1.25.1: session-scoped UI memory (e.g. Polling's last/recent districts)
    // is cleared on explicit logout — a fresh login starts clean.
    // v1.30: so is every on-device copy of the account's DATA. Signing out used
    // to leave the offline read cache, the cached turf blocks/assignments and
    // the queued offline writes sitting in storage, readable by whoever signs
    // in next on a shared laptop or tablet.
    try {
      Object.keys(localStorage)
        .filter(k => k.startsWith('bb_polling_') || k.startsWith('turf_'))
        .forEach(k => localStorage.removeItem(k))
    } catch (_) {}
    try { cacheClearAll() } catch (_) {}
    // offlineQueue.js's IndexedDB store (pending door-knock writes). Flush it
    // first — we still hold a valid session here, and dropping unsynced knocks
    // on the floor would lose real canvassing work.
    try {
      const q = await import('../lib/offlineQueue')
      if ((await q.pendingCount()) > 0) {
        try { await q.flushQueue(supabase, user?.id) } catch (_) { /* offline — best effort */ }
      }
      // Only drop the store once it is empty. If the device is offline the
      // knocks stay queued and sync on the next sign-in — deleting them here
      // would destroy canvassing work that was never saved anywhere else.
      if ((await q.pendingCount()) === 0 && typeof indexedDB !== 'undefined') {
        indexedDB.deleteDatabase('badgerboard-offline')
      }
    } catch (_) {}
    const { error } = await supabase.auth.signOut()
    return { error }
  }

  const resetPassword = async (email) => {
    // Inside the native shell window.location.origin is capacitor://localhost
    // (or http://localhost), which produces a reset link no email client can
    // open. Native users get the production web origin instead.
    const origin = isNativeApp ? API_ORIGIN : window.location.origin
    const { data, error } = await supabase.auth.resetPasswordForEmail(email, {
      redirectTo: `${origin}/reset-password`,
    })
    return { data, error }
  }

  const updatePassword = async (newPassword) => {
    const { data, error } = await supabase.auth.updateUser({ password: newPassword })
    return { data, error }
  }

  const value = {
    user,
    session,
    loading,
    isAdmin,
    globalBetaEnabled,
    isPaymentLocked,
    isDowngradeLocked,
    downgradedAt,
    refreshSession,
    signIn,
    signUp,
    signOut,
    resetPassword,
    updatePassword,
  }

  return (
    <AuthContext.Provider value={value}>
      {children}
    </AuthContext.Provider>
  )
}
