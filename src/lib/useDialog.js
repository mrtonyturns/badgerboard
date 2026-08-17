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
// Deliberately NOT a full focus trap: trapping Tab correctly (sentinels,
// shadow DOM, portals) is a component-library problem; Escape + scroll-lock +
// initial focus fixes what the audit actually flagged without new risk.

import { useEffect } from 'react'

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

export function useDialog(onClose, { locked = true, initialFocusRef = null } = {}) {
  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'Escape' && typeof onClose === 'function') {
        e.stopPropagation()
        onClose()
      }
    }
    document.addEventListener('keydown', onKey)
    if (locked) lockBody()
    if (initialFocusRef?.current?.focus) {
      // rAF so the element exists post-paint (portals mount late).
      requestAnimationFrame(() => initialFocusRef.current?.focus?.())
    }
    return () => {
      document.removeEventListener('keydown', onKey)
      if (locked) unlockBody()
    }
    // onClose is intentionally captured per-mount; dialogs remount per open.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
}

export default useDialog
