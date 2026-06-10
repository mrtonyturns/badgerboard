import { createClient } from '@supabase/supabase-js'

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY

if (!supabaseUrl || !supabaseAnonKey) {
  console.error('Missing Supabase environment variables. Please check your .env file.')
}

export const supabase = createClient(supabaseUrl, supabaseAnonKey, {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
  },
})

// ── Helper: get current user ID ────────────────────────────────
// Used by create functions to stamp ownership.  Cached per call.
async function currentUserId() {
  const { data: { user } } = await supabase.auth.getUser()
  return user?.id || null
}

// ── Offices (shared reference data — no user scoping) ──────────
// Fetch ALL offices, paginating through Supabase's 1000-row max_rows limit.
// The offices table has 3,200+ rows so a single request would be truncated.
export const getOffices = async (filters = {}) => {
  const PAGE = 1000
  let all = []
  let offset = 0
  while (true) {
    let query = supabase
      .from('offices')
      .select('*')
      .order('level')
      .order('name')
      .range(offset, offset + PAGE - 1)
    if (filters.level)       query = query.eq('level', filters.level)
    if (filters.office_type) query = query.eq('office_type', filters.office_type)
    if (filters.county)      query = query.eq('county', filters.county)
    if (filters.search)      query = query.ilike('name', `%${filters.search}%`)
    const { data, error } = await query
    if (error) return { data: all, error }
    if (!data || data.length === 0) break
    all = all.concat(data)
    if (data.length < PAGE) break   // last page
    offset += PAGE
  }
  return { data: all, error: null }
}

export const getOffice = async (id) =>
  supabase.from('offices').select('*').eq('id', id).single()

export const createOffice = async (data) =>
  supabase.from('offices').insert(data).select().single()

export const updateOffice = async (id, data) =>
  supabase.from('offices').update(data).eq('id', id).select().single()

export const deleteOffice = async (id) =>
  supabase.from('offices').delete().eq('id', id)

// ── Elections (shared reference data — no user scoping) ────────
export const getElections = async () =>
  supabase.from('elections').select('*').order('election_date')

export const createElection = async (data) =>
  supabase.from('elections').insert(data).select().single()

export const updateElection = async (id, data) =>
  supabase.from('elections').update(data).eq('id', id).select().single()

export const deleteElection = async (id) =>
  supabase.from('elections').delete().eq('id', id)

// ── Candidates (USER-SCOPED) ───────────────────────────────────
// RLS enforces user isolation at the DB level.  App-layer filter on
// created_by is belt-and-suspenders so no cross-user data is ever returned.
export const getCandidates = async (filters = {}) => {
  const uid = await currentUserId()
  let query = supabase
    .from('candidates')
    .select(`
      *,
      office:offices(id, name, level, office_type, district_number, district_name, county),
      election:elections(id, name, election_date, type, year)
    `)
    .order('name')

  // Always scope to the current user — never expose other users' candidates
  if (!uid) return { data: [], error: null }
  query = query.eq('created_by', uid)

  if (filters.office_id) query = query.eq('office_id', filters.office_id)
  if (filters.election_id) query = query.eq('election_id', filters.election_id)
  if (filters.party) query = query.eq('party', filters.party)
  if (filters.status) query = query.eq('status', filters.status)
  if (filters.search) query = query.ilike('name', `%${filters.search}%`)
  return query
}

export const getCandidate = async (id) => {
  const uid = await currentUserId()
  let q = supabase
    .from('candidates')
    .select(`
      *,
      office:offices(*),
      election:elections(*)
    `)
    .eq('id', id)
  if (uid) q = q.eq('created_by', uid)
  return q.single()
}

export const createCandidate = async (data) => {
  const uid = await currentUserId()
  return supabase.from('candidates').insert({ ...data, created_by: uid }).select().single()
}

export const updateCandidate = async (id, data) => {
  const uid = await currentUserId()
  return supabase.from('candidates').update(data).eq('id', id).eq('created_by', uid).select().single()
}

export const deleteCandidate = async (id) => {
  const uid = await currentUserId()
  if (!uid) return { error: new Error('Not authenticated'), data: null }
  return supabase.from('candidates').delete().eq('id', id).eq('created_by', uid)
}

// ── Dossiers (USER-SCOPED via candidate ownership + generated_by) ─
export const getDossiers = async (candidateId = null) => {
  const uid = await currentUserId()
  let query = supabase
    .from('dossiers')
    .select(`*, candidate:candidates(id, name, party, office:offices(name, district_name))`)
    .order('generated_at', { ascending: false })
  if (candidateId) query = query.eq('candidate_id', candidateId)
  if (uid) query = query.eq('generated_by', uid)
  return query
}

export const getDossier = async (id) => {
  const uid = await currentUserId()
  let q = supabase
    .from('dossiers')
    .select(`*, candidate:candidates(*, office:offices(*), election:elections(*))`)
    .eq('id', id)
  if (uid) q = q.eq('generated_by', uid)
  return q.single()
}

export const createDossier = async (data) => {
  const uid = await currentUserId()
  return supabase.from('dossiers').insert({ ...data, generated_by: uid }).select().single()
}

export const deleteDossier = async (id) => {
  const uid = await currentUserId()
  let q = supabase.from('dossiers').delete().eq('id', id)
  if (uid) q = q.eq('generated_by', uid)
  return q
}

// ── Prospecting Lists (USER-SCOPED) ───────────────────────────
export const getProspectingLists = async () => {
  const uid = await currentUserId()
  let q = supabase.from('prospecting_lists').select('*').order('created_at', { ascending: false })
  if (uid) q = q.eq('created_by', uid)
  return q
}

export const getProspectingList = async (id) => {
  const uid = await currentUserId()
  let q = supabase.from('prospecting_lists').select('*').eq('id', id)
  if (uid) q = q.eq('created_by', uid)
  return q.single()
}

export const createProspectingList = async (data) => {
  const uid = await currentUserId()
  return supabase.from('prospecting_lists').insert({ ...data, created_by: uid }).select().single()
}

export const updateProspectingList = async (id, data) => {
  const uid = await currentUserId()
  let q = supabase.from('prospecting_lists').update(data).eq('id', id)
  if (uid) q = q.eq('created_by', uid)
  return q.select().single()
}

export const deleteProspectingList = async (id) => {
  const uid = await currentUserId()
  let q = supabase.from('prospecting_lists').delete().eq('id', id)
  if (uid) q = q.eq('created_by', uid)
  return q
}

// ── Activity Log (USER-SCOPED) ────────────────────────────────
export const logActivity = async (action, entityType, entityId, details = {}) => {
  const uid = await currentUserId()
  return supabase.from('activity_log').insert({
    user_id: uid,
    action,
    entity_type: entityType,
    entity_id: entityId,
    details,
  })
}

export const getRecentActivity = async (limit = 20) => {
  const uid = await currentUserId()
  let q = supabase.from('activity_log').select('*').order('created_at', { ascending: false }).limit(limit)
  if (uid) q = q.eq('user_id', uid)
  return q
}

// ── Incumbent Records (USER-SCOPED via candidate) ──────────────
export const getIncumbentRecords = async (candidateId) =>
  supabase
    .from('incumbent_records')
    .select('*')
    .eq('candidate_id', candidateId)
    .order('date', { ascending: false })

export const createIncumbentRecord = async (data) => {
  const uid = await currentUserId()
  return supabase.from('incumbent_records').insert({ ...data, created_by: uid }).select().single()
}

export const updateIncumbentRecord = async (id, data) =>
  supabase.from('incumbent_records').update(data).eq('id', id).select().single()

export const deleteIncumbentRecord = async (id) =>
  supabase.from('incumbent_records').delete().eq('id', id)

// ── Voter Lists (USER-SCOPED) ─────────────────────────────────
export const getVoterLists = async () => {
  const uid = await currentUserId()
  let q = supabase.from('voter_lists').select('*').order('created_at', { ascending: false })
  if (uid) q = q.eq('created_by', uid)
  return q
}

export const getVoterList = async (id) => {
  const uid = await currentUserId()
  let q = supabase.from('voter_lists').select('*').eq('id', id)
  if (uid) q = q.eq('created_by', uid)
  return q.single()
}

export const createVoterList = async (data) => {
  const uid = await currentUserId()
  return supabase.from('voter_lists').insert({ ...data, created_by: uid }).select().single()
}

export const updateVoterList = async (id, data) => {
  const uid = await currentUserId()
  let q = supabase.from('voter_lists').update(data).eq('id', id)
  if (uid) q = q.eq('created_by', uid)
  return q.select().single()
}

export const deleteVoterList = async (id) => {
  const uid = await currentUserId()
  let q = supabase.from('voter_lists').delete().eq('id', id)
  if (uid) q = q.eq('created_by', uid)
  return q
}

// ── Voters ──────────────────────────────────────────────────────
export const getVoters = async (voterListId, limit = 1000) =>
  supabase.from('voters').select('*').eq('voter_list_id', voterListId).order('last_name').limit(limit)

// No .select() — avoids returning the full inserted payload for large batches
export const createVoters = async (rows) =>
  supabase.from('voters').insert(rows)

export const updateVoter = async (id, data) =>
  supabase.from('voters').update(data).eq('id', id).select().single()

export const deleteVoter = async (id) =>
  supabase.from('voters').delete().eq('id', id)

export const deleteVotersByList = async (voterListId) =>
  supabase.from('voters').delete().eq('voter_list_id', voterListId)

// ── Voter Saved Lists (USER-SCOPED) ───────────────────────────
export const getVoterSavedLists = async () => {
  const uid = await currentUserId()
  let q = supabase.from('voter_saved_lists').select('*').order('created_at', { ascending: false })
  if (uid) q = q.eq('created_by', uid)
  return q
}

export const createVoterSavedList = async (data) => {
  const uid = await currentUserId()
  return supabase.from('voter_saved_lists').insert({ ...data, created_by: uid }).select().single()
}

export const updateVoterSavedList = async (id, data) => {
  const uid = await currentUserId()
  let q = supabase.from('voter_saved_lists').update(data).eq('id', id)
  if (uid) q = q.eq('created_by', uid)
  return q.select().single()
}

export const deleteVoterSavedList = async (id) => {
  const uid = await currentUserId()
  let q = supabase.from('voter_saved_lists').delete().eq('id', id)
  if (uid) q = q.eq('created_by', uid)
  return q
}

// ── Door Knocking: candidate config ──────────────────────────
// Fetches only the CURRENT USER's candidates so DoorKnocking.jsx
// can derive geojson file + feature matcher without hardcoding.
// Belt-and-suspenders: explicit created_by filter in addition to RLS.
export const getDoorKnockCandidates = async () => {
  const uid = await currentUserId()
  if (!uid) return { data: [], error: new Error('Not authenticated') }
  return supabase
    .from('candidates')
    .select(`
      id, name, map_color, survey_questions,
      office:offices(id, name, level, office_type, district_number, district_name, county)
    `)
    .eq('created_by', uid)
    .in('status', ['declared', 'primary_winner', 'general'])
    .order('name')
}

export const saveCandidateSurveyQuestions = async (candidateId, questions) => {
  return supabase
    .from('candidates')
    .update({ survey_questions: questions })
    .eq('id', candidateId)
    .select('id, survey_questions')
    .single()
}

// ── Door Knock Lists (USER-SCOPED) ────────────────────────────
// Belt-and-suspenders: explicit created_by filter in addition to RLS.
export const getDoorKnockLists = async () => {
  const uid = await currentUserId()
  if (!uid) return { data: [], error: new Error('Not authenticated') }
  return supabase
    .from('door_knock_lists')
    .select('*, candidate:candidates(id, name), election:elections(id, name, election_date)')
    .eq('created_by', uid)
    .order('created_at', { ascending: false })
}

export const getDoorKnockList = async (id) => {
  const uid = await currentUserId()
  let q = supabase
    .from('door_knock_lists')
    .select('*, candidate:candidates(id, name), election:elections(id, name, election_date)')
    .eq('id', id)
  if (uid) q = q.eq('created_by', uid)
  return q.single()
}

export const createDoorKnockList = async (data) => {
  const uid = await currentUserId()
  return supabase.from('door_knock_lists').insert({ ...data, created_by: uid }).select().single()
}

export const updateDoorKnockList = async (id, data) => {
  const uid = await currentUserId()
  let q = supabase.from('door_knock_lists').update(data).eq('id', id)
  if (uid) q = q.eq('created_by', uid)
  return q.select().single()
}

export const deleteDoorKnockList = async (id) => {
  const uid = await currentUserId()
  let q = supabase.from('door_knock_lists').delete().eq('id', id)
  if (uid) q = q.eq('created_by', uid)
  return q
}

// ── Door Knocks ─────────────────────────────────────────────────
export const getDoorKnocks = async (listId) =>
  supabase
    .from('door_knocks')
    .select('*')
    .eq('list_id', listId)
    .order('knocked_at', { ascending: false })

export const createDoorKnock = async (data) => {
  const uid = await currentUserId()
  return supabase.from('door_knocks').insert({ ...data, knocked_by: uid }).select().single()
}

export const updateDoorKnock = async (id, data) =>
  supabase.from('door_knocks').update(data).eq('id', id).select().single()

export const deleteDoorKnock = async (id) =>
  supabase.from('door_knocks').delete().eq('id', id)

// ── Door Knock Contact History (by address) ──────────────────────
// Returns all prior knocks at a given address string across all lists.
export const getKnockHistoryByAddress = async (address) =>
  supabase
    .from('door_knocks')
    .select('*, list:door_knock_lists(id, name)')
    .ilike('address', `%${address.trim()}%`)
    .order('knocked_at', { ascending: false })
    .limit(20)

// ── Door Knock Shifts ──────────────────────────────────────────────
export const getShifts = async (listId) =>
  supabase
    .from('door_knock_shifts')
    .select('*')
    .eq('list_id', listId)
    .order('shift_date')
    .order('start_time')

export const createShift = async (data) => {
  const uid = await currentUserId()
  return supabase.from('door_knock_shifts').insert({ ...data, created_by: uid }).select().single()
}

export const updateShift = async (id, data) =>
  supabase.from('door_knock_shifts').update(data).eq('id', id).select().single()

export const deleteShift = async (id) =>
  supabase.from('door_knock_shifts').delete().eq('id', id)

// ── Canvass Messages (coordinator broadcast) ───────────────────────
export const getMessages = async (listId) =>
  supabase
    .from('canvass_messages')
    .select('*')
    .eq('list_id', listId)
    .order('sent_at', { ascending: false })
    .limit(50)

export const sendMessage = async (data) => {
  const uid = await currentUserId()
  return supabase.from('canvass_messages').insert({ ...data, sent_by: uid }).select().single()
}

// ── Game Plan Milestones (USER-SCOPED) ────────────────────────────
export const getMilestones = async (filters = {}) => {
  const uid = await currentUserId()
  if (!uid) return { data: [], error: new Error('Not authenticated') }
  let query = supabase
    .from('game_plan_milestones')
    .select(`
      *,
      candidate:candidates(id, name, party),
      election:elections(id, name, election_date)
    `)
    .eq('created_by', uid)
    .order('due_date', { ascending: true, nullsFirst: false })
  if (filters.candidate_id) query = query.eq('candidate_id', filters.candidate_id)
  if (filters.election_id)  query = query.eq('election_id', filters.election_id)
  if (filters.phase)        query = query.eq('phase', filters.phase)
  if (filters.status)       query = query.eq('status', filters.status)
  return query
}

export const createMilestone = async (data) => {
  const uid = await currentUserId()
  return supabase.from('game_plan_milestones').insert({ ...data, created_by: uid }).select().single()
}

export const createMilestoneBatch = async (rows) => {
  const uid = await currentUserId()
  const stamped = rows.map(r => ({ ...r, created_by: uid }))
  return supabase.from('game_plan_milestones').insert(stamped).select()
}

export const updateMilestone = async (id, data) =>
  supabase.from('game_plan_milestones').update(data).eq('id', id).select().single()

export const deleteMilestone = async (id) =>
  supabase.from('game_plan_milestones').delete().eq('id', id)

export const deleteMilestonesByCandidate = async (candidateId) =>
  supabase.from('game_plan_milestones').delete().eq('candidate_id', candidateId)

// Removes all template-generated milestones for the current user (undo generate)
export const deleteTemplateMilestones = async (candidateId = null) => {
  const uid = await currentUserId()
  if (!uid) return { error: new Error('Not authenticated') }
  let q = supabase.from('game_plan_milestones').delete().eq('created_by', uid).eq('is_template', true)
  if (candidateId) q = q.eq('candidate_id', candidateId)
  return q
}

// ─── Turf blocks — localStorage-backed (no DDL required) ─────────────────────
// Stored as: localStorage['turf_blocks_{listId}'] = JSON array of block objects
function _turfKey(listId) { return `turf_blocks_${listId}` }
function _turfAssignKey(listId) { return `turf_assign_${listId}` }

export async function getTurfBlocks(listId) {
  try {
    const raw = localStorage.getItem(_turfKey(listId))
    const data = raw ? JSON.parse(raw) : []
    return { data, error: null }
  } catch { return { data: [], error: null } }
}
export async function saveTurfBlock(block) {
  try {
    const key = _turfKey(block.list_id)
    const raw = localStorage.getItem(key)
    const blocks = raw ? JSON.parse(raw) : []
    const idx = blocks.findIndex(b => b.id === block.id)
    let saved
    if (idx >= 0) {
      blocks[idx] = block
      saved = block
    } else {
      saved = { ...block, id: block.id || crypto.randomUUID(), created_at: new Date().toISOString() }
      blocks.push(saved)
    }
    localStorage.setItem(key, JSON.stringify(blocks))
    return { data: saved, error: null }
  } catch (e) { return { data: null, error: e } }
}
export async function deleteTurfBlock(blockId, listId) {
  try {
    const key = _turfKey(listId)
    const raw = localStorage.getItem(key)
    const blocks = raw ? JSON.parse(raw) : []
    localStorage.setItem(key, JSON.stringify(blocks.filter(b => b.id !== blockId)))
    return { error: null }
  } catch (e) { return { error: e } }
}

// ─── Turf assignments — also localStorage-backed ─────────────────────────────
export async function getTurfAssignments(listId) {
  try {
    const raw = localStorage.getItem(_turfAssignKey(listId))
    const data = raw ? JSON.parse(raw) : []
    return { data, error: null }
  } catch { return { data: [], error: null } }
}
export async function saveTurfAssignment(assignment) {
  try {
    const key = _turfAssignKey(assignment.list_id)
    const raw = localStorage.getItem(key)
    const assigns = raw ? JSON.parse(raw) : []
    const idx = assigns.findIndex(a => a.id === assignment.id)
    const record = { ...assignment, id: assignment.id || crypto.randomUUID(), assigned_at: new Date().toISOString() }
    if (idx >= 0) assigns[idx] = record
    else assigns.push(record)
    localStorage.setItem(key, JSON.stringify(assigns))
    return { data: record, error: null }
  } catch (e) { return { data: null, error: e } }
}
export async function updateTurfAssignment(id, listId, patch) {
  try {
    const key = _turfAssignKey(listId)
    const raw = localStorage.getItem(key)
    const assigns = raw ? JSON.parse(raw) : []
    const idx = assigns.findIndex(a => a.id === id)
    if (idx >= 0) assigns[idx] = { ...assigns[idx], ...patch }
    localStorage.setItem(key, JSON.stringify(assigns))
    return { error: null }
  } catch (e) { return { error: e } }
}

// ─── Volunteers — use existing volunteers table (created_by, magic_token) ─────
// Existing schema: id, created_by, list_id, name, email, phone, role, status,
//                  avatar_color, notes, magic_token, created_at, updated_at
export async function getVolunteers(listId) {
  return supabase
    .from('volunteers')
    .select('id, created_by, list_id, name, email, phone, role, status, magic_token, created_at')
    .eq('list_id', listId)
    .order('created_at')
}
export async function createVolunteer(vol) {
  // Map coordinator_id → created_by, invite_token → magic_token
  const { coordinator_id, invite_token, invite_sent_at, ...rest } = vol
  const record = {
    ...rest,
    created_by: coordinator_id || rest.created_by,
    magic_token: invite_token || rest.magic_token || null,
  }
  return supabase.from('volunteers').insert(record).select().single()
}
export async function updateVolunteer(id, patch) {
  return supabase.from('volunteers').update(patch).eq('id', id)
}

// ─── Voter file — stub (requires DB migration; graceful no-op for now) ────────
export async function getVoterFileEntries(listId, limit = 500) {
  return { data: [], error: null }
}
export async function upsertVoterFileEntries(entries) {
  return { data: null, error: null }
}
export async function getVoterFileCount(listId) {
  return { count: 0, error: null }
}

// ─── Door knock stats (for Live Dashboard) — uses existing door_knocks table ──
export async function getDoorKnockStats(listId) {
  const { data, error } = await supabase
    .from('door_knocks')
    .select('status')
    .eq('list_id', listId)
  if (error) return { data: null, error }
  const total = data.length
  const byStatus = {}
  for (const row of data) {
    byStatus[row.status] = (byStatus[row.status] || 0) + 1
  }
  return { data: { total, byStatus }, error: null }
}
export async function getDoorKnockFeed(listId, limit = 20) {
  return supabase
    .from('door_knocks')
    .select('id, address, status, notes, created_at, knocked_by')
    .eq('list_id', listId)
    .order('created_at', { ascending: false })
    .limit(limit)
}

// ── Door Knocks export query (range + list) ───────────────────────
export const getDoorKnocksForExport = async (listId, fromDate, toDate) => {
  let query = supabase
    .from('door_knocks')
    .select('*')
    .order('knocked_at', { ascending: true })
  if (listId) query = query.eq('list_id', listId)
  if (fromDate) query = query.gte('knocked_at', fromDate)
  if (toDate) query = query.lte('knocked_at', toDate)
  return query
}
