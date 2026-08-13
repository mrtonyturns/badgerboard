// netlify/functions/admin-offices.js
// ─── Admin-only office CRUD ──────────────────────────────────────────────────
//
// Migration 20260704000004 dropped the "Authenticated users can insert/update/
// delete offices" RLS policies, but the Offices page kept writing directly with
// the anon client: the Add Office modal's insert was rejected every time and the
// UI just closed the spinner without saying anything. All office writes now go
// through this service-role function, admin-gated, with a column whitelist.
//
// Actions (POST { action, params }, admin JWT required):
//   save_office   { id?, data }   insert (no id) or update (id)
//   delete_office { id }

const { cors, json, serviceClient, requireAdmin } = require('./_shared')

// Column whitelist — never pass a client object straight to the DB.
const OFFICE_FIELDS = [
  'name', 'level', 'office_type',
  'district_number', 'district_name',
  'county', 'city',
  'term_years', 'notes', 'current_officeholder',
]

const VALID_LEVELS = ['federal', 'state', 'county', 'municipal', 'school', 'judicial']
const VALID_TYPES  = ['legislative', 'executive', 'judicial', 'administrative', 'law_enforcement', 'education']

const isUuid = (v) => typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v)

const nullIfBlank = (v) => (v === '' || v === undefined ? null : v)

function pick(obj, fields) {
  const out = {}
  for (const f of fields) if (obj && obj[f] !== undefined) out[f] = obj[f]
  return out
}

// Normalizes the modal's string-typed inputs into the column types.
function normalize(row) {
  const out = { ...row }
  for (const k of ['district_name', 'county', 'city', 'notes', 'current_officeholder']) {
    if (k in out) out[k] = nullIfBlank(out[k])
  }
  if ('name' in out) out.name = String(out.name || '').trim().slice(0, 200)
  if ('district_number' in out) {
    const n = parseInt(out.district_number, 10)
    out.district_number = Number.isFinite(n) ? n : null
  }
  if ('term_years' in out) {
    const t = parseInt(out.term_years, 10)
    out.term_years = Number.isFinite(t) ? t : null
  }
  return out
}

exports.handler = async (event) => {
  const headers = cors()
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers, body: '' }
  if (event.httpMethod !== 'POST') return json(405, { error: 'POST only' }, headers)

  const auth = await requireAdmin(event)
  if (auth.errorResponse) return { ...auth.errorResponse, headers: { ...auth.errorResponse.headers, ...headers } }

  let body
  try { body = JSON.parse(event.body || '{}') } catch { return json(400, { error: 'Invalid JSON' }, headers) }

  const action = body.action
  const params = body.params || body
  const sb = serviceClient()

  try {
    switch (action) {
      case 'save_office': {
        const id  = params.id
        const row = normalize(pick(params.data || {}, OFFICE_FIELDS))

        if (!id && !row.name) return json(400, { error: 'Office name is required.' }, headers)
        if (row.level && !VALID_LEVELS.includes(row.level)) {
          return json(400, { error: `Invalid level "${row.level}".` }, headers)
        }
        if (row.office_type && !VALID_TYPES.includes(row.office_type)) {
          return json(400, { error: `Invalid office type "${row.office_type}".` }, headers)
        }
        if (Object.keys(row).length === 0) return json(400, { error: 'Nothing to save.' }, headers)

        if (id) {
          if (!isUuid(id)) return json(400, { error: 'Invalid office id.' }, headers)
          const { data, error } = await sb.from('offices').update(row).eq('id', id).select()
          if (error) return json(500, { error: error.message }, headers)
          if (!data?.length) return json(404, { error: 'Office not found — nothing was updated.' }, headers)
          return json(200, { data: data[0] }, headers)
        }

        const { data, error } = await sb.from('offices').insert(row).select()
        if (error) return json(500, { error: error.message }, headers)
        if (!data?.length) return json(500, { error: 'Office was not created.' }, headers)
        return json(200, { data: data[0] }, headers)
      }

      case 'delete_office': {
        const id = params.id
        if (!isUuid(id)) return json(400, { error: 'Invalid office id.' }, headers)
        const { data, error } = await sb.from('offices').delete().eq('id', id).select()
        if (error) return json(500, { error: error.message }, headers)
        if (!data?.length) return json(404, { error: 'Office not found — nothing was deleted.' }, headers)
        return json(200, { data: { deleted: true } }, headers)
      }

      default:
        return json(400, { error: `Unknown action "${action}".` }, headers)
    }
  } catch (e) {
    console.error('[admin-offices]', e)
    return json(500, { error: e.message || 'Server error' }, headers)
  }
}
