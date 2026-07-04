// Official government records — direct API ground truth for dossiers.
// All fetchers fail soft (return null) so a missing key or API outage never
// blocks dossier generation.
//
// Sources:
//   FEC (api.open.fec.gov)          — federal campaign finance. FEC_API_KEY env
//                                     (falls back to DEMO_KEY, rate-limited).
//   CourtListener (v4 REST)         — federal court opinions/dockets. Anonymous.
//   LegiScan (api.legiscan.com)     — WI bills & sponsorships. LEGISCAN_API_KEY env
//                                     (skipped when absent).

const FEC_API_KEY = process.env.FEC_API_KEY || 'DEMO_KEY'
const LEGISCAN_API_KEY = process.env.LEGISCAN_API_KEY || null

async function fetchJson(url, ms = 15000) {
  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), ms)
  try {
    const res = await fetch(url, { signal: ctrl.signal, headers: { 'User-Agent': 'BadgerBoard/1.0 (political research)' } })
    if (!res.ok) { console.error(`[official-records] ${res.status} ${url.split('?')[0]}`); return null }
    return await res.json()
  } catch (e) {
    console.error(`[official-records] ${e.message} ${url.split('?')[0]}`)
    return null
  } finally { clearTimeout(t) }
}

function isFederalOffice(officeLine = '') {
  return /congress|u\.?\s?s\.?\s(house|senate)|united states (house|senate|representative|senator)/i.test(officeLine)
}

// ─── FEC: candidate financial totals (federal offices only) ──────────────────
async function fetchFecRecords(name, officeLine) {
  if (!isFederalOffice(officeLine)) return null
  const q = encodeURIComponent(name)
  const search = await fetchJson(`https://api.open.fec.gov/v1/candidates/search/?q=${q}&state=WI&sort=-first_file_date&per_page=3&api_key=${FEC_API_KEY}`)
  const cand = search?.results?.[0]
  if (!cand?.candidate_id) return null

  const totals = await fetchJson(`https://api.open.fec.gov/v1/candidate/${cand.candidate_id}/totals/?sort=-cycle&per_page=2&api_key=${FEC_API_KEY}`)
  const rows = (totals?.results || []).map(t =>
    `| ${t.cycle} | $${Math.round(t.receipts || 0).toLocaleString()} | $${Math.round(t.disbursements || 0).toLocaleString()} | $${Math.round(t.last_cash_on_hand_end_period || 0).toLocaleString()} | ${t.last_report_type_full || '—'} (${t.coverage_end_date?.slice(0, 10) || '—'}) |`
  ).join('\n')

  return `FEC OFFICIAL FILING — ${cand.name} (${cand.candidate_id}, ${cand.party_full || cand.party || 'party unlisted'}, ${cand.office_full || ''} ${cand.district || ''})
Source: api.open.fec.gov (official Federal Election Commission data — treat as [KNOWN])
${rows ? `| Cycle | Raised | Spent | Cash on Hand | Last Report |\n|---|---|---|---|---|\n${rows}` : 'Registered with FEC; no financial totals filed yet.'}`
}

// ─── CourtListener: federal court records (name-match) ───────────────────────
async function fetchCourtRecords(name) {
  const q = encodeURIComponent(`"${name}"`)
  const data = await fetchJson(`https://www.courtlistener.com/api/rest/v4/search/?q=${q}&type=o&order_by=dateFiled%20desc`)
  const results = (data?.results || []).slice(0, 5)
  if (!results.length) return null
  const rows = results.map(r =>
    `| ${r.caseName || '—'} | ${r.court || '—'} | ${(r.dateFiled || '').slice(0, 10) || '—'} | https://www.courtlistener.com${r.absolute_url || ''} |`
  ).join('\n')
  return `COURTLISTENER FEDERAL COURT SEARCH — exact-phrase name match for "${name}" (${data.count} total matches)
⚠️ NAME-MATCH ONLY — a person sharing the name may appear. Cross-check against IDENTITY LOCK before attributing; if identity cannot be confirmed, mark [RESEARCH REQUIRED] or omit.
| Case | Court | Filed | Link |
|---|---|---|---|
${rows}`
}

// ─── LegiScan: Wisconsin bills naming/sponsored by the person ────────────────
async function fetchLegiScanRecords(name) {
  if (!LEGISCAN_API_KEY) return null
  const q = encodeURIComponent(`"${name}"`)
  const data = await fetchJson(`https://api.legiscan.com/?key=${LEGISCAN_API_KEY}&op=getSearch&state=WI&query=${q}`)
  if (data?.status !== 'OK') return null
  const sr = data.searchresult || {}
  const bills = Object.keys(sr).filter(k => k !== 'summary').map(k => sr[k]).slice(0, 10)
  if (!bills.length) return null
  const rows = bills.map(b =>
    `| ${b.bill_number || '—'} | ${(b.title || '').slice(0, 90)} | ${b.last_action_date || '—'} | ${(b.last_action || '').slice(0, 60)} | ${b.url || ''} |`
  ).join('\n')
  return `LEGISCAN WISCONSIN LEGISLATIVE SEARCH for "${name}" (official legislative data — treat matched sponsorships as [KNOWN])
| Bill | Title | Last Action Date | Last Action | Link |
|---|---|---|---|---|
${rows}`
}

// ─── Aggregate ────────────────────────────────────────────────────────────────
async function fetchOfficialRecords(name, officeLine) {
  const [fec, courts, legiscan] = await Promise.all([
    fetchFecRecords(name, officeLine).catch(() => null),
    fetchCourtRecords(name).catch(() => null),
    fetchLegiScanRecords(name).catch(() => null),
  ])
  const blocks = [fec, courts, legiscan].filter(Boolean)
  if (!blocks.length) return null
  return blocks.join('\n\n')
}

module.exports = { fetchOfficialRecords, fetchFecRecords, fetchCourtRecords, fetchLegiScanRecords, isFederalOffice }
