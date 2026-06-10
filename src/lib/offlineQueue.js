// ─── Badger Board Offline Queue ───────────────────────────────────────────────
// IndexedDB-backed queue for door_knock records created while offline.
// When the volunteer's signal returns, call flushQueue() to sync to Supabase.

const DB_NAME    = 'badgerboard-offline'
const DB_VERSION = 1
const STORE_NAME = 'pending-knocks'

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION)
    req.onupgradeneeded = (e) => {
      const db = e.target.result
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: 'localId', autoIncrement: true })
      }
    }
    req.onsuccess  = (e) => resolve(e.target.result)
    req.onerror    = (e) => reject(e.target.error)
  })
}

/** Queue a knock for later sync. Returns localId assigned by IDB.
 *  Dedup guard: if an identical address+status knock was queued within the last
 *  60 seconds, skip the insert and return the existing localId to prevent
 *  double-taps from creating duplicate records. */
export async function queueKnock(data) {
  const db    = await openDB()

  // Dedup check: read existing pending knocks first
  const existing = await new Promise((resolve, reject) => {
    const tx    = db.transaction(STORE_NAME, 'readonly')
    const store = tx.objectStore(STORE_NAME)
    const req   = store.getAll()
    req.onsuccess = () => resolve(req.result)
    req.onerror   = () => reject(req.error)
  })
  const now = Date.now()
  const dup = existing.find(k =>
    k.address === data.address &&
    k.status  === data.status  &&
    (now - new Date(k._queued_at).getTime()) < 60000   // within 60 s
  )
  if (dup) return dup.localId

  const tx    = db.transaction(STORE_NAME, 'readwrite')
  const store = tx.objectStore(STORE_NAME)
  return new Promise((resolve, reject) => {
    const req = store.add({ ...data, _queued_at: new Date().toISOString() })
    req.onsuccess = () => resolve(req.result)  // localId
    req.onerror   = () => reject(req.error)
  })
}

/** Get all pending knocks. */
export async function getPendingKnocks() {
  const db    = await openDB()
  const tx    = db.transaction(STORE_NAME, 'readonly')
  const store = tx.objectStore(STORE_NAME)
  return new Promise((resolve, reject) => {
    const req = store.getAll()
    req.onsuccess = () => resolve(req.result)
    req.onerror   = () => reject(req.error)
  })
}

/** Remove a synced knock by its IDB localId. */
export async function removeKnock(localId) {
  const db    = await openDB()
  const tx    = db.transaction(STORE_NAME, 'readwrite')
  const store = tx.objectStore(STORE_NAME)
  return new Promise((resolve, reject) => {
    const req = store.delete(localId)
    req.onsuccess = () => resolve()
    req.onerror   = () => reject(req.error)
  })
}

/** Count pending knocks. */
export async function pendingCount() {
  const pending = await getPendingKnocks()
  return pending.length
}

/**
 * Flush all pending knocks to Supabase.
 * Pass the supabase client + userId so this module stays pure.
 * Returns { synced, failed } counts.
 */
export async function flushQueue(supabaseClient, userId) {
  const pending = await getPendingKnocks()
  if (pending.length === 0) return { synced: 0, failed: 0 }

  let synced = 0, failed = 0
  for (const knock of pending) {
    const { localId, _queued_at, ...data } = knock  // strip IDB-only fields
    const { error } = await supabaseClient
      .from('door_knocks')
      .insert({ ...data, knocked_by: userId })
    if (error) {
      failed++
    } else {
      await removeKnock(localId)
      synced++
    }
  }
  return { synced, failed }
}
