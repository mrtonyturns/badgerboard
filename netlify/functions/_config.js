// netlify/functions/_config.js
// ─── Shared configuration for all Netlify functions ──────────────────────────
// Prefixed with _ so Netlify does NOT treat this as a deployable function.
//
// Import (ESM):   import { ADMIN_EMAILS } from './_config.js'
// Require (CJS):  const { ADMIN_EMAILS } = require('./_config')

/**
 * Email addresses with admin-level access to the Badger Board platform.
 * Add new admin emails here — this is the single source of truth.
 */
const ADMIN_EMAILS = ['tony@bluejackgroup.com', 'tony@thebluejackgroup.com', 'tom@thebluejackgroup.com']

// Support both ESM (import) and CJS (require)
module.exports = { ADMIN_EMAILS }
