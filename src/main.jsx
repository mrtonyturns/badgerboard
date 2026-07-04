import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App.jsx'
import './index.css'
import { initNativeApp, isNativeApp } from './lib/native'

// Must run before any fetch calls so native builds route API traffic correctly
initNativeApp()

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
)

// ── Register Service Worker (offline support) ─────────────────────────────────
// Web only — native builds bundle assets locally and use the offlineCache layer
if (!isNativeApp && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker
      .register('/sw.js', { scope: '/' })
      .catch(() => {})  // non-fatal — app works fine without SW
  })
}
