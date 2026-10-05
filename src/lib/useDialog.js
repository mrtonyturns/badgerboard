// src/lib/useDialog.js — one behavior contract for every dialog in the app.
//
// The Aug-16 UI audit found zero dialogs scroll-lock the page behind them and
// only 3 of ~30 handle Escape. Rather than 30 hand-rolled fixes, every modal
// mounts this hook (v1.36.0, UI repair round 2).
//
//   useDialog(onClose)                    — Escape closes, body scroll locked
//   useDialog(onClose, { locked: false }) — Escape only (non-blocking panels)
//   useDialog(onClose, { initialFocusRef }) — also focuses an element on open
//
// Scroll-lock is reference-counted so stacked dialogs (modal → confirm) don't
// unlock the page when the inner one closes. overflow is restored to whatever
// it was before the FIRST dialog opened.
//
// Escape is handled by the TOPMOST open dialog only. Every dialog listens on
// `document`, where stopPropagation() cannot stop the other listeners on the
// same node — so one Escape used to close every stacked dialog at once (the
// modal AND its confirm). A module-level stack records open order instead.
//
// Deliberately NOT a full focus trap: trapping Tab correctly (sentinels,
// shadow DOM, portals) is a component-library problem; Escape + scroll-lock +
// initial focus fixes what the audit actually flagged without new risk.

import { useEffect, useRef } from 'react'

let lockCount = 0
let prevOverflow = ''

function lockBody() {
  if (lockCount === 0) {
    prevOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
  }
  lockCount += 1
}

function unlockBody() {
  lockCount = Math.max(0, lockCount - 1)
  if (lockCount === 0) document.body.style.overflow = prevOverflow
}

// Open dialogs, oldest first. Tokens are per-mount objects.
const openDialogs = []
export const dialogStack = {
  push(token) { openDialogs.push(token) },
  remove(token) {
    const i = openDialogs.lastIndexOf(token)
    if (i !== -1) openDialogs.splice(i, 1)
  },
  isTop(token) { return openDialogs.length > 0 && openDialogs[openDialogs.length - 1] === token },
}

/** The keydown handler for one dialog: Escape closes it only when it is on top. */
export function escapeHandler(token, getClose) {
  return (e) => {
    const close = getClose()
    if (e.key === 'Escape' && typeof close === 'function' && dialogStack.isTop(token)) {
      e.stopPropagation()
      close()
    }
  }
}

export function useDialog(onClose, { locked = true, initialFocusRef = null } = {}) {
  // Latest-value refs: the keydown listener is attached once per mount (and
  // re-attached only if `locked` flips), but always calls the CURRENT onClose
  // and reads the CURRENT initialFocusRef — so callers may pass inline arrows
  // without re-binding the listener or re-toggling the scroll lock.
  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose
  const initialFocusRefRef = useRef(initialFocusRef)
  initialFocusRefRef.current = initialFocusRef

  // Stack membership is tied to the mount alone (not `locked`), so flipping
  // `locked` can't move a dialog above ones opened after it.
  const tokenRef = useRef(null)
  if (!tokenRef.current) tokenRef.current = {}
  useEffect(() => {
    const token = tokenRef.current
    dialogStack.push(token)
    return () => dialogStack.remove(token)
  }, [])

  useEffect(() => {
    const onKey = escapeHandler(tokenRef.current, () => onCloseRef.current)
    document.addEventListener('keydown', onKey)
    if (locked) lockBody()
    const focusRef = initialFocusRefRef.current
    if (focusRef?.current?.focus) {
      // rAF so the element exists post-paint (portals mount late).
      requestAnimationFrame(() => focusRef.current?.focus?.())
    }
    return () => {
      document.removeEventListener('keydown', onKey)
      if (locked) unlockBody()
    }
  }, [locked])
}

export default useDialog
